import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  inspectDependencyDrift,
  formatDependencyDrift,
  validateDependencyDriftPolicy,
} from "../scripts/audit-dependency-drift.js";

/**
 * @param {string} name
 * @param {{
 *   packageManager?: string,
 *   nodeVersion?: string,
 *   engines?: Record<string, string>,
 *   dependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string>
 * }} overrides
 */
function createWebapp(name, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));

  const dependencies = {
    react: "^19.2.0",
    "react-dom": "^19.2.0",
    "@tanstack/react-query": "^5.83.0",
    "@tanstack/react-router": "^1.168.25",
    "@tanstack/react-start": "^1.167.50",
    "@supabase/supabase-js": "^2.108.2",
    ...(overrides.dependencies ?? {}),
  };

  const devDependencies = {
    typescript: "^5.8.3",
    eslint: "^9.32.0",
    "@playwright/test": "1.61.1",
    ...(overrides.devDependencies ?? {}),
  };

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name,
        ...(overrides.packageManager
          ? { packageManager: overrides.packageManager }
          : {}),
        ...(overrides.engines
          ? { engines: overrides.engines }
          : {}),
        dependencies,
        devDependencies,
      },
      null,
      2,
    ),
  );

  if (typeof overrides.nodeVersion === "string") {
    fs.writeFileSync(path.join(root, ".node-version"), `${overrides.nodeVersion}\n`);
  }

  return root;
}

test("reports no drift when tracked dependency versions match", () => {
  const first = createWebapp("drift-match-a", {
    packageManager: "bun@1.3.14",
    engines: { node: ">=20" },
  });

  const second = createWebapp("drift-match-b", {
    packageManager: "bun@1.3.14",
    engines: { node: ">=20" },
  });

  const report = inspectDependencyDrift([first, second]);

  assert.equal(report.summary.repositories, 2);
  assert.equal(report.summary.driftedDependencies, 0);
  assert.equal(report.summary.missingPackageManager, 0);
  assert.equal(report.summary.missingEngines, 0);
  assert.deepEqual(report.drift, []);

  assert.match(
    formatDependencyDrift(report),
    /No tracked dependency drift detected/,
  );
});

test("reports multiple version variants for a tracked dependency", () => {
  const first = createWebapp("drift-router-a", {
    dependencies: {
      "@tanstack/react-router": "^1.170.18",
    },
  });

  const second = createWebapp("drift-router-b", {
    dependencies: {
      "@tanstack/react-router": "^1.168.25",
    },
  });

  const report = inspectDependencyDrift([first, second]);

  const routerDrift = report.drift.find(
    (item) => item.dependency === "@tanstack/react-router",
  );

  assert.ok(routerDrift);
  assert.equal(routerDrift.variants.length, 2);
  assert.equal(report.summary.driftedDependencies, 1);
});

test("reports reproducibility gaps for packageManager and engines", () => {
  const first = createWebapp("drift-repro-a");
  const second = createWebapp("drift-repro-b");

  const report = inspectDependencyDrift([first, second]);

  assert.equal(report.summary.missingPackageManager, 2);
  assert.equal(report.summary.missingEngines, 2);

  assert.equal(report.reproducibility.missingPackageManager.length, 2);
  assert.equal(report.reproducibility.missingEngines.length, 2);
});

test("CLI produces machine-readable JSON output", () => {
  const first = createWebapp("drift-json-a", {
    packageManager: "bun@1.3.14",
    engines: { node: ">=20" },
  });

  const second = createWebapp("drift-json-b", {
    packageManager: "bun@1.3.14",
    engines: { node: ">=20" },
    dependencies: {
      "@supabase/supabase-js": "^2.108.1",
    },
  });

  const output = execFileSync(
    "node",
    [
      path.resolve("scripts/audit-dependency-drift.js"),
      first,
      second,
      "--json",
    ],
    { encoding: "utf8" },
  );

  const parsed = JSON.parse(output);

  assert.equal(parsed.summary.repositories, 2);
  assert.equal(parsed.summary.driftedDependencies, 1);

  assert.equal(
    parsed.drift[0]?.dependency,
    "@supabase/supabase-js",
  );
});

test("detects Node, package-manager, and Node-engine drift across the ecosystem", () => {
  const first = createWebapp("runtime-drift-a", {
    packageManager: "bun@1.3.14",
    nodeVersion: "24.11.1",
    engines: { node: ">=24 <25" },
  });
  const second = createWebapp("runtime-drift-b", {
    packageManager: "bun@1.2.23",
    nodeVersion: "22.20.0",
    engines: { node: ">=22 <23" },
  });

  const report = inspectDependencyDrift([first, second]);
  assert.equal(report.summary.runtimeDriftDimensions, 3);
  assert.deepEqual(
    report.runtimeDrift.map((item) => item.dimension).sort(),
    ["node-engine", "node-version", "package-manager"],
  );
  assert.equal(report.overallStatus, "WARN");
});

test("distinguishes exact dependency drift from major-version conflicts", () => {
  const first = createWebapp("major-drift-a", {
    nodeVersion: "24.11.1",
    packageManager: "bun@1.3.14",
    engines: { node: ">=24 <25" },
    dependencies: { react: "^18.3.1" },
  });
  const second = createWebapp("major-drift-b", {
    nodeVersion: "24.11.1",
    packageManager: "bun@1.3.14",
    engines: { node: ">=24 <25" },
    dependencies: { react: "^19.2.0" },
  });
  const report = inspectDependencyDrift([first, second]);
  assert.equal(report.drift.some((item) => item.dependency === "react"), true);
  const conflict = report.majorVersionConflicts.find((item) => item.dependency === "react");
  assert.ok(conflict);
  assert.deepEqual(conflict.majors.map((item) => item.major), [18, 19]);

  const sameMajor = createWebapp("major-drift-c", {
    nodeVersion: "24.11.1",
    packageManager: "bun@1.3.14",
    engines: { node: ">=24 <25" },
    dependencies: { react: "^19.1.0" },
  });
  const sameReport = inspectDependencyDrift([second, sameMajor]);
  assert.equal(sameReport.drift.some((item) => item.dependency === "react"), true);
  assert.equal(sameReport.majorVersionConflicts.some((item) => item.dependency === "react"), false);
});

test("runtime policy blocks unsupported Node and package-manager majors", () => {
  const supported = createWebapp("runtime-policy-supported", {
    nodeVersion: "24.11.1",
    packageManager: "bun@1.3.14",
    engines: { node: ">=24 <25" },
  });
  const unsupported = createWebapp("runtime-policy-unsupported", {
    nodeVersion: "22.20.0",
    packageManager: "bun@2.0.0",
    engines: { node: ">=22 <23" },
  });
  const policy = {
    version: 1,
    supportedNodeMajors: [24],
    packageManagers: [{ name: "bun", supportedMajors: [1] }],
    requireNodeVersionFile: true,
    requirePackageManagerPin: true,
    requireNodeEngine: true,
  };
  const pass = inspectDependencyDrift([supported], { policy });
  assert.equal(pass.runtimePolicy.status, "PASS");
  assert.equal(pass.overallStatus, "PASS");

  const fail = inspectDependencyDrift([unsupported], { policy });
  assert.equal(fail.runtimePolicy.status, "FAIL");
  assert.equal(fail.overallStatus, "FAIL");
  assert.equal(fail.runtimePolicy.checks.some((item) => item.id === "node-runtime-support" && item.status === "FAIL"), true);
  assert.equal(fail.runtimePolicy.checks.some((item) => item.id === "package-manager-support" && item.status === "FAIL"), true);
});

test("runtime support remains unverified rather than invented without exact evidence", () => {
  const repository = createWebapp("runtime-policy-unverified", {
    packageManager: "bun@1.3.14",
    engines: { node: ">=24 <25" },
  });
  const report = inspectDependencyDrift([repository], {
    policy: {
      version: 1,
      supportedNodeMajors: [24],
      packageManagers: [{ name: "bun", supportedMajors: [1] }],
    },
  });
  assert.equal(report.runtimePolicy.status, "WARN");
  assert.equal(report.runtimePolicy.checks.some((item) => item.id === "node-runtime-support" && item.status === "WARN"), true);
});

test("runtime policy validation rejects empty, duplicate, and unknown policy claims", () => {
  assert.equal(validateDependencyDriftPolicy({ version: 1 }).ok, false);
  assert.equal(validateDependencyDriftPolicy({ version: 1, supportedNodeMajors: [24, 24] }).ok, false);
  assert.equal(validateDependencyDriftPolicy({
    version: 1,
    packageManagers: [
      { name: "bun", supportedMajors: [1] },
      { name: "bun", supportedMajors: [1] },
    ],
  }).ok, false);
  assert.equal(validateDependencyDriftPolicy({ version: 1, supportedNodeMajors: [24], magic: true }).ok, false);
});

test("reports unpinned package managers and missing exact Node references separately", () => {
  const repository = createWebapp("runtime-repro-gaps", {
    packageManager: "bun@latest",
    engines: { node: ">=24 <25" },
  });
  const report = inspectDependencyDrift([repository]);
  assert.deepEqual(report.reproducibility.unpinnedPackageManager, [path.basename(repository)]);
  assert.deepEqual(report.reproducibility.missingNodeVersion, [path.basename(repository)]);
  assert.equal(report.overallStatus, "WARN");
});

test("ecosystem formatter exposes the high-value version matrix", () => {
  const first = createWebapp("matrix-a", {
    packageManager: "bun@1.3.14",
    nodeVersion: "24.11.1",
    engines: { node: ">=24 <25" },
  });
  const second = createWebapp("matrix-b", {
    packageManager: "bun@1.3.14",
    nodeVersion: "24.11.1",
    engines: { node: ">=24 <25" },
    dependencies: { "@supabase/supabase-js": "^2.109.0" },
  });
  const output = formatDependencyDrift(inspectDependencyDrift([first, second]));
  assert.match(output, /Ecosystem versions/);
  for (const label of ["REPOSITORY", "NODE", "PACKAGE_MANAGER", "REACT", "TYPESCRIPT", "SUPABASE", "PLAYWRIGHT"]) {
    assert.match(output, new RegExp(label));
  }
  assert.match(output, /\^2\.109\.0/);
});

test("CLI runtime policy returns blocking exit only for explicit unsupported runtime policy", () => {
  const repository = createWebapp("runtime-cli", {
    packageManager: "bun@2.0.0",
    nodeVersion: "22.20.0",
    engines: { node: ">=22 <23" },
  });
  const policyFile = path.join(os.tmpdir(), `dependency-policy-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(policyFile, JSON.stringify({
    version: 1,
    supportedNodeMajors: [24],
    packageManagers: [{ name: "bun", supportedMajors: [1] }],
  }));
  const result = spawnSync("node", [path.resolve("scripts/audit-dependency-drift.js"), repository, "--policy", policyFile, "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).overallStatus, "FAIL");
  fs.rmSync(policyFile, { force: true });
});

test("malformed package metadata fails closed without leaking parser details", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "drift-invalid-package-"));
  fs.writeFileSync(path.join(root, "package.json"), "{");
  const result = spawnSync("node", [path.resolve("scripts/audit-dependency-drift.js"), root], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /input is invalid or unreadable/);
  assert.doesNotMatch(result.stderr, /SyntaxError|JSON|position/i);
});
