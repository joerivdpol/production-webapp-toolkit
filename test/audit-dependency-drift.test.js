import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  inspectDependencyDrift,
  formatDependencyDrift,
} from "../scripts/audit-dependency-drift.js";

/**
 * @param {string} name
 * @param {{
 *   packageManager?: string,
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
