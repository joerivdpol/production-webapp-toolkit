import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  formatReleaseReadiness,
  inspectReleaseReadiness,
  V2_REQUIRED_CAPABILITIES,
  V2_REQUIRED_SCRIPTS,
} from "../scripts/audit-release-readiness.js";

const REQUIRED_CAPABILITIES = [
  "audit-profiled-repository.js",
  "audit-profiled-ecosystem.js",
  "audit-dependency-drift.js",
  "audit-public-repo-safety.js",
  "audit-architecture-compliance.js",
  "audit-git-governance.js",
  "audit-production-baseline.js",
  "audit-deployment-verification.js",
  "runtime-evidence.js",
  "audit-repository-status.js",
  "audit-ecosystem-status.js",
];

const REQUIRED_SCRIPTS = [
  "typecheck", "test", "lint", "build", "check", "lint:changed",
  "audit:safety", "audit:git-governance", "audit:production-baseline",
  "audit:deployment", "audit:repository-status", "audit:ecosystem-status",
  "audit:release", "runtime:evidence", "release:verify",
];
/** @param {{ version?: string, nodeVersion?: string, nodeEngine?: string, packageManager?: string, ciBunVersion?: string, readme?: string, roadmap?: string, omitCapability?: string, omitScript?: string, includeSafetyCi?: boolean, v2Surface?: boolean }} [options] */
function createToolkitFixture(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-readiness-"));
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "releases"), { recursive: true });
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });

  const scriptNames = options.v2Surface ? [...REQUIRED_SCRIPTS, ...V2_REQUIRED_SCRIPTS] : REQUIRED_SCRIPTS;
  const scripts = Object.fromEntries(scriptNames.map((name) => [name, `echo ${name}`]));
  if (options.omitScript) delete scripts[options.omitScript];
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "fixture-toolkit",
    version: options.version ?? "1.0.1",
    license: "MIT",
    packageManager: options.packageManager ?? "bun@1.3.14",
    engines: { node: options.nodeEngine ?? ">=24 <25" },
    scripts,
  }, null, 2));
  fs.writeFileSync(path.join(root, ".node-version"), `${options.nodeVersion ?? "24.21.0"}\n`);
  fs.writeFileSync(path.join(root, "bun.lock"), "{\n  \"lockfileVersion\": 1\n}\n");

  const capabilityFiles = options.v2Surface ? [...REQUIRED_CAPABILITIES, ...V2_REQUIRED_CAPABILITIES] : REQUIRED_CAPABILITIES;
  for (const file of capabilityFiles) {
    if (file !== options.omitCapability) fs.writeFileSync(path.join(root, "scripts", file), "// fixture\n");
  }

  const readmeLines = [
    "# Fixture", "Node.js 24.21.0", "Bun 1.3.14", "Offline Git governance audit", "Offline production baseline audit",
    "Deployment verification", "Evidence freshness", "Runtime identity",
    "Runtime evidence contract", "Repository status", "Ecosystem status", "DEPLOYMENT",
  ];
  if (options.v2Surface) readmeLines.push("## v2.0 capability surface", "deployment:gate", "release:evidence:bundle");
  fs.writeFileSync(path.join(root, "README.md"), options.readme ?? readmeLines.join("\n"));
  fs.writeFileSync(path.join(root, "docs", "roadmap.md"), options.roadmap ?? "## v1.1\n## v2.0 Controlled automation\n\n* v2.0 controlled-automation roadmap capabilities are complete in the current source tree.\n");
  const version = options.version ?? "1.0.1";
  /** @param {string} releaseVersion */
  const releaseNotes = (releaseVersion) => `# Production Webapp Toolkit v${releaseVersion}\n\n## Status semantics\n\n## Trust boundaries\n${releaseVersion.startsWith("2.") ? "\n## Upgrade notes\n" : ""}`;
  fs.writeFileSync(path.join(root, "docs", "releases", `v${version}.md`), releaseNotes(version));
  fs.writeFileSync(path.join(root, "docs", "releases", "v1.1.0.md"), releaseNotes("1.1.0"));
  if (options.v2Surface || version.startsWith("2.")) fs.writeFileSync(path.join(root, "docs", "releases", "v2.0.0.md"), releaseNotes("2.0.0"));
  const safetyLine = options.includeSafetyCi === false ? "" : "- run: node scripts/audit-public-repo-safety.js .";
  fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), [
    "steps:",
    "- uses: actions/checkout@v4",
    "  with:",
    "    fetch-depth: 0",
    "- uses: actions/setup-node@v4",
    "  with:",
    "    node-version-file: .node-version",
    "- uses: oven-sh/setup-bun@v2",
    "  with:",
    `    bun-version: ${options.ciBunVersion ?? "1.3.14"}`,
    "- run: bun install --frozen-lockfile",
    safetyLine,
    "- run: bun run typecheck",
    "- run: bun run test",
    "- run: bun run lint",
    "- run: bun run build",
  ].filter(Boolean).join("\n"));

  return root;
}

/** @param {ReturnType<typeof inspectReleaseReadiness>} report @param {string} id */
function check(report, id) {
  return report.checks.find((item) => item.id === id);
}

test("reports a complete v1.1 capability surface as ready", () => {
  const root = createToolkitFixture();
  const report = inspectReleaseReadiness(root);
  assert.equal(report.ready, true);
  assert.equal(report.version, "1.0.1");
  assert.equal(report.nodeVersion, "24.21.0");
  assert.equal(report.bunVersion, "1.3.14");
  assert.equal(report.checks.every((item) => item.passed), true);
  assert.match(formatReleaseReadiness(report), /v1\.0\.1 release readiness/);
});
test("supports an exact release-version gate without requiring an early version bump", () => {
  const preparing = inspectReleaseReadiness(createToolkitFixture(), { expectedVersion: "1.1.0" });
  assert.equal(preparing.ready, false);
  assert.equal(check(preparing, "expected-version")?.passed, false);

  const release = inspectReleaseReadiness(createToolkitFixture({ version: "1.1.0" }), { expectedVersion: "1.1.0" });
  assert.equal(release.ready, true);
  assert.match(formatReleaseReadiness(release), /READY FOR v1\.1\.0/);
});

test("reports a complete v2.0 capability surface as ready", () => {
  const root = createToolkitFixture({ version: "2.0.0", v2Surface: true });
  const report = inspectReleaseReadiness(root, { expectedVersion: "2.0.0" });
  assert.equal(report.ready, true, JSON.stringify(report.checks.filter((item) => !item.passed)));
  assert.equal(report.targetVersion, "2.0.0");
  assert.equal(report.targetMajor, 2);
  assert.equal(check(report, "standard-scripts")?.passed, true);
  assert.equal(check(report, "capabilities-present")?.passed, true);
  assert.equal(check(report, "readme-current-release")?.passed, true);
  assert.match(formatReleaseReadiness(report), /READY FOR v2\.0\.0/);
});

test("v2.0 release readiness requires the full current script and capability surface", () => {
  const missingScript = inspectReleaseReadiness(createToolkitFixture({ version: "2.0.0", v2Surface: true, omitScript: "deployment:gate" }), { expectedVersion: "2.0.0" });
  assert.equal(missingScript.ready, false);
  assert.equal(check(missingScript, "standard-scripts")?.passed, false);

  const missingCapability = inspectReleaseReadiness(createToolkitFixture({ version: "2.0.0", v2Surface: true, omitCapability: "deployment-gate.js" }), { expectedVersion: "2.0.0" });
  assert.equal(missingCapability.ready, false);
  assert.equal(check(missingCapability, "capabilities-present")?.passed, false);
});

test("v2.0 release readiness requires v2 roadmap, README surface, and upgrade notes", () => {
  const badRoadmap = inspectReleaseReadiness(createToolkitFixture({ version: "2.0.0", v2Surface: true, roadmap: "## v1.1\n## v2.0 Controlled automation\n" }), { expectedVersion: "2.0.0" });
  assert.equal(check(badRoadmap, "roadmap-present")?.passed, false);

  const badReadme = inspectReleaseReadiness(createToolkitFixture({ version: "2.0.0", v2Surface: true, readme: "Node.js 24.21.0\nBun 1.3.14\nOffline Git governance audit\nOffline production baseline audit\nDeployment verification\nEvidence freshness\nRuntime identity\nRuntime evidence contract\nRepository status\nEcosystem status\nDEPLOYMENT\n" }), { expectedVersion: "2.0.0" });
  assert.equal(check(badReadme, "readme-current-release")?.passed, false);
});

test("rejects floating or inconsistent Bun versions", () => {
  const floating = inspectReleaseReadiness(createToolkitFixture({ ciBunVersion: "latest" }));
  assert.equal(floating.ready, false);
  assert.equal(check(floating, "ci-bun-pinned")?.passed, false);

  const mismatch = inspectReleaseReadiness(createToolkitFixture({ ciBunVersion: "1.3.13" }));
  assert.equal(mismatch.ready, false);
  assert.equal(check(mismatch, "ci-bun-pinned")?.passed, false);

  const unpinnedPackage = inspectReleaseReadiness(createToolkitFixture({ packageManager: "bun" }));
  assert.equal(unpinnedPackage.ready, false);
  assert.equal(check(unpinnedPackage, "bun-version-pinned")?.passed, false);
});

test("requires an exact reference Node version consistent with the supported major", () => {
  const missingPin = inspectReleaseReadiness(createToolkitFixture({ nodeVersion: "24" }));
  assert.equal(missingPin.ready, false);
  assert.equal(check(missingPin, "node-version-pinned")?.passed, false);

  const wrongEngine = inspectReleaseReadiness(createToolkitFixture({ nodeEngine: ">=20" }));
  assert.equal(wrongEngine.ready, false);
  assert.equal(check(wrongEngine, "node-engine-consistent")?.passed, false);
});
test("requires the complete v1.1 script and capability surface", () => {
  const missingCapability = inspectReleaseReadiness(createToolkitFixture({ omitCapability: "audit-deployment-verification.js" }));
  assert.equal(missingCapability.ready, false);
  assert.equal(check(missingCapability, "capabilities-present")?.passed, false);

  const missingScript = inspectReleaseReadiness(createToolkitFixture({ omitScript: "audit:ecosystem-status" }));
  assert.equal(missingScript.ready, false);
  assert.equal(check(missingScript, "standard-scripts")?.passed, false);
});

test("requires blocking CI quality gates and public safety", () => {
  const noSafety = inspectReleaseReadiness(createToolkitFixture({ includeSafetyCi: false }));
  assert.equal(noSafety.ready, false);
  assert.equal(check(noSafety, "public-safety-ci")?.passed, false);
});
test("requires all blocking CI quality commands", () => {
  const root = createToolkitFixture();
  const ciPath = path.join(root, ".github", "workflows", "ci.yml");
  const ci = fs.readFileSync(ciPath, "utf8");
  fs.writeFileSync(ciPath, ci.replace("- run: bun run build", ""));
  const report = inspectReleaseReadiness(root);
  assert.equal(report.ready, false);
  assert.equal(check(report, "ci-quality-gates")?.passed, false);
});

test("requires v1.1 documentation and roadmap coverage", () => {
  const missingDocs = inspectReleaseReadiness(createToolkitFixture({ readme: "# Incomplete\n" }));
  assert.equal(missingDocs.ready, false);
  const ids = [
    "readme-toolchain",
    "readme-governance",
    "readme-baseline",
    "readme-deployment",
    "readme-runtime-evidence",
    "readme-status-layers",
  ];
  for (const id of ids) assert.equal(check(missingDocs, id)?.passed, false);

  const missingRoadmap = inspectReleaseReadiness(createToolkitFixture({ roadmap: "# no release plan\n" }));
  assert.equal(missingRoadmap.ready, false);
  assert.equal(check(missingRoadmap, "roadmap-present")?.passed, false);
});
test("CLI supports exact-version JSON gating and rejects invalid arguments", () => {
  const root = createToolkitFixture({ version: "1.1.0" });
  const script = path.resolve("scripts/audit-release-readiness.js");
  const valid = spawnSync("node", [script, root, "--expected-version", "1.1.0", "--json"], { encoding: "utf8" });
  assert.equal(valid.status, 0);
  const report = JSON.parse(valid.stdout);
  assert.equal(report.ready, true);
  assert.equal(report.expectedVersion, "1.1.0");

  const mismatch = spawnSync("node", [script, root, "--expected-version", "1.1.1", "--json"], { encoding: "utf8" });
  assert.equal(mismatch.status, 1);
  assert.equal(JSON.parse(mismatch.stdout).ready, false);

  const v2Root = createToolkitFixture({ version: "2.0.0", v2Surface: true });
  const v2 = spawnSync("node", [script, v2Root, "--expected-version", "2.0.0", "--json"], { encoding: "utf8" });
  assert.equal(v2.status, 0, v2.stderr || v2.stdout);
  assert.equal(JSON.parse(v2.stdout).ready, true);

  for (const args of [[root, "--expected-version"], [root, "--expected-version", "0.0.0"], [root, "--expected-version", "2.0"], [root, "--unknown"]]) {
    assert.equal(spawnSync("node", [script, ...args], { encoding: "utf8" }).status, 1);
  }
});
