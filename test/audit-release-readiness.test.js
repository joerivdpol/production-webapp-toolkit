import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  inspectReleaseReadiness,
  formatReleaseReadiness,
} from "../scripts/audit-release-readiness.js";

/**
 * @param {{
 *   version?: string,
 *   readme?: string,
 *   includeSafetyCi?: boolean
 * }} options
 */
function createToolkitFixture(options = {}) {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "release-readiness-"),
  );

  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(
    path.join(root, ".github", "workflows"),
    { recursive: true },
  );

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "fixture-toolkit",
        version: options.version ?? "1.0.0",
        license: "MIT",
        packageManager: "bun@1.3.14",
        engines: {
          node: ">=20",
        },
        scripts: {
          typecheck: "tsc --noEmit",
          test: "node --test",
          lint: "eslint .",
          build: "tsc --noEmit",
          check: "bun run typecheck && bun run test && bun run lint",
          "lint:changed": "node scripts/lint-changed.js",
        },
      },
      null,
      2,
    ),
  );

  const capabilities = [
    "audit-profiled-repository.js",
    "audit-profiled-ecosystem.js",
    "audit-dependency-drift.js",
    "audit-public-repo-safety.js",
    "audit-architecture-compliance.js",
  ];

  for (const file of capabilities) {
    fs.writeFileSync(
      path.join(root, "scripts", file),
      "// fixture\n",
    );
  }

  fs.writeFileSync(
    path.join(root, "README.md"),
    options.readme ??
      [
        "# Fixture",
        "",
        "repository profiles and profiled auditing",
        "dependency drift",
        "public repository safety",
        "architecture compliance",
        "",
      ].join("\n"),
  );

  fs.writeFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    options.includeSafetyCi === false
      ? "name: CI\n"
      : "run: node scripts/audit-public-repo-safety.js .\n",
  );

  return root;
}

test("reports a complete v1 toolkit as ready", () => {
  const root = createToolkitFixture();

  const report = inspectReleaseReadiness(root);

  assert.equal(report.ready, true);
  assert.equal(report.version, "1.0.0");
  assert.equal(
    report.checks.every((check) => check.passed),
    true,
  );

  assert.match(
    formatReleaseReadiness(report),
    /READY FOR v1\.0\.0/,
  );
});

test("rejects a pre-v1 package version", () => {
  const root = createToolkitFixture({
    version: "0.9.0",
  });

  const report = inspectReleaseReadiness(root);

  assert.equal(report.ready, false);

  const version = report.checks.find(
    (check) => check.id === "version",
  );

  assert.equal(version?.passed, false);
});

test("requires the public safety gate in CI", () => {
  const root = createToolkitFixture({
    includeSafetyCi: false,
  });

  const report = inspectReleaseReadiness(root);

  const safety = report.checks.find(
    (check) => check.id === "public-safety-ci",
  );

  assert.equal(report.ready, false);
  assert.equal(safety?.passed, false);
});

test("requires documentation for the v1 capability surface", () => {
  const root = createToolkitFixture({
    readme: "# Incomplete documentation\n",
  });

  const report = inspectReleaseReadiness(root);

  assert.equal(report.ready, false);

  for (const id of [
    "readme-profiled-audit",
    "readme-dependency-drift",
    "readme-public-safety",
    "readme-architecture-compliance",
  ]) {
    assert.equal(
      report.checks.find((check) => check.id === id)?.passed,
      false,
    );
  }
});

test("CLI emits machine-readable JSON and fails when not ready", () => {
  const root = createToolkitFixture({
    version: "0.1.0",
  });

  const script = path.resolve(
    "scripts/audit-release-readiness.js",
  );

  let stdout = "";

  try {
    execFileSync(
      "node",
      [script, root, "--json"],
      { encoding: "utf8" },
    );

    assert.fail("expected release-readiness CLI to fail");
  } catch (error) {
    assert.ok(
      error &&
      typeof error === "object" &&
      "stdout" in error,
    );

    stdout = String(error.stdout);
  }

  const parsed = JSON.parse(stdout);

  assert.equal(parsed.ready, false);
  assert.equal(parsed.version, "0.1.0");
});
