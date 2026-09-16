import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  formatEcosystemStatus,
  inspectEcosystemStatus,
  main,
  parseEcosystemConfig,
} from "../scripts/audit-ecosystem-status.js";

/** @type {string[]} */
const fixtures = [];

/** @param {string} prefix */
function temporaryDirectory(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

/** @param {string} root @param {string} name */
function writeCommit(root, name) {
  fs.writeFileSync(path.join(root, `${name}.txt`), `${name}\n`);
  git(root, ["add", `${name}.txt`]);
  git(root, ["commit", "-m", name]);
  return git(root, ["rev-parse", "HEAD"]);
}

/** @param {string} root @param {{ restrictedFetch?: boolean }} [options] */
function initializeGit(root, options = {}) {
  const remote = temporaryDirectory("ecosystem-status-remote-");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Toolkit Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  const initial = git(root, ["rev-parse", "HEAD"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["update-ref", "refs/remotes/origin/main", initial]);
  git(root, ["branch", "--set-upstream-to=origin/main", "main"]);
  git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

  if (options.restrictedFetch) {
    git(root, ["config", "--unset-all", "remote.origin.fetch"]);
    git(root, ["config", "--add", "remote.origin.fetch", "+refs/heads/dev/*:refs/remotes/origin/dev/*"]);
  }
  return initial;
}

/** @param {{ complete?: boolean, restrictedFetch?: boolean, git?: boolean }} [options] */
function createWebapp(options = {}) {
  const root = temporaryDirectory("ecosystem-status-webapp-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "ecosystem-status-webapp",
    packageManager: "bun@1.3.14",
    scripts: {
      lint: "eslint .",
      typecheck: "tsc --noEmit",
      test: "node --test",
      check: "bun run typecheck && bun run test && bun run lint",
      build: "vite build",
    },
  }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), [
    "steps:",
    "  - run: bun run typecheck",
    "  - run: bun run test",
    "  - run: bun run lint:changed",
    "  - run: bun run build",
  ].join("\n"));
  if (options.complete !== false) {
    fs.mkdirSync(path.join(root, "scripts"));
    fs.writeFileSync(path.join(root, "scripts", "lint-changed.js"), "// fixture\n");
  }
  return { root, initial: options.git === false ? null : initializeGit(root, options) };
}

function createPythonService() {
  const root = temporaryDirectory("ecosystem-status-python-");
  fs.writeFileSync(path.join(root, "service.py"), "print('ok')\n");
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(path.join(root, "tests", "test_service.py"), "import unittest\n");
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), [
    "steps:",
    "  - uses: actions/setup-python@v7",
    '    with: { python-version: "3.12" }',
    "  - run: python -m py_compile *.py",
    "  - run: python -m unittest discover -s tests -v",
  ].join("\n"));
  return { root, initial: initializeGit(root) };
}

function createUnknownRepository() {
  const root = temporaryDirectory("ecosystem-status-unknown-");
  fs.writeFileSync(path.join(root, "README.md"), "# Unsupported\n");
  initializeGit(root);
  return root;
}

/** @param {unknown} config */
function configFile(config) {
  const file = path.join(temporaryDirectory("ecosystem-status-config-"), "ecosystem-status.json");
  fs.writeFileSync(file, typeof config === "string" ? config : JSON.stringify(config));
  return file;
}

/** @param {...string} args */
function runCli(...args) {
  return spawnSync("node", [path.resolve("scripts/audit-ecosystem-status.js"), ...args], { encoding: "utf8" });
}

/** @param {Array<{ name?: string, path: string, expectedRef?: string, expectedCommit?: string, compareRef?: string, deployedCommit?: string, evidenceFile?: string }>} repositories */
function config(repositories) {
  return configFile({ version: 1, repositories });
}

/** @param {string} commit @param {{ authenticated?: boolean, environment?: string | null }} [options] */
function runtimeEvidence(commit, options = {}) {
  return {
    version: 1,
    runtime: {
      name: "runtime-a",
      ...(options.environment === null ? {} : { environment: options.environment ?? "example-production" }),
    },
    deployment: { commit },
    evidence: {
      source: "manual",
      authenticated: options.authenticated ?? false,
      collectedAt: "2026-09-16T00:00:00Z",
    },
  };
}

/** @param {unknown} value */
function evidenceFile(value) {
  const directory = temporaryDirectory("ecosystem-status-evidence-");
  const file = path.join(directory, "runtime-evidence.json");
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

afterEach(() => {
  for (const root of fixtures.splice(0).reverse()) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matching baselines without deployment remain ecosystem WARN", () => {
  const webapp = createWebapp();
  const python = createPythonService();
  const result = runCli("--config", config([
    { name: "app-a", path: webapp.root, expectedRef: "main", compareRef: "HEAD" },
    { name: "worker-b", path: python.root, expectedRef: "main", compareRef: "HEAD" },
  ]), "--json");
  /** @type {{ inputMode: string, configVersion: number, overallStatus: string, repositories: Array<{ profile: string, dimensions: { deployment: { status: string } } }> }} */
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(report.inputMode, "config");
  assert.equal(report.configVersion, 1);
  assert.equal(report.overallStatus, "WARN");
  assert.deepEqual(report.repositories.map((repository) => repository.profile), ["webapp", "python-service"]);
  assert.deepEqual(report.repositories.map((repository) => repository.dimensions.deployment.status), ["NOT_CONFIGURED", "NOT_CONFIGURED"]);
});

test("quality failure is blocking while governance warning is a non-blocking WARN", () => {
  const failed = createWebapp({ complete: false });
  const warned = createWebapp({ restrictedFetch: true });
  const failedReport = inspectEcosystemStatus([{ target: failed.root, expectedRef: "main" }], { inputMode: "config", configVersion: 1 });
  const warnedReport = inspectEcosystemStatus([{ target: warned.root, expectedRef: "main" }], { inputMode: "config", configVersion: 1 });

  assert.equal(failedReport.repositories[0]?.dimensions.quality.status, "FAIL");
  assert.equal(failedReport.technicalStatus, "PASS");
  assert.equal(failedReport.overallStatus, "FAIL");
  assert.equal(warnedReport.repositories[0]?.dimensions.governance.status, "WARN");
  assert.equal(warnedReport.technicalStatus, "PASS");
  assert.equal(warnedReport.overallStatus, "WARN");
  assert.equal(main([failed.root]), 1);
  assert.equal(main([warned.root]), 0);
});

test("baseline mismatch and unverified results remain WARN with exit 0", () => {
  const mismatch = createWebapp();
  writeCommit(mismatch.root, "next");
  assert.ok(mismatch.initial);
  const unverified = createWebapp();
  const result = runCli("--config", config([
    { path: mismatch.root, expectedRef: "main", expectedCommit: mismatch.initial },
    { path: unverified.root, expectedRef: "origin/not-locally-available" },
  ]), "--json");
  /** @type {{ overallStatus: string, repositories: Array<{ dimensions: { baseline: { baselineStatus: string } } }> }} */
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.deepEqual(report.repositories.map((repository) => repository.dimensions.baseline.baselineStatus), ["MISMATCH", "UNVERIFIED"]);
  assert.equal(report.overallStatus, "WARN");
});

test("positional input has no baseline inference, including production-like governance candidates", () => {
  const { root } = createWebapp();
  git(root, ["branch", "production/api"]);
  const result = runCli(root, "--json");
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(report.inputMode, "positional");
  assert.equal(report.repositories[0]?.baselineConfigured, false);
  assert.equal(report.repositories[0]?.dimensions.baseline.status, "NOT_CONFIGURED");
  assert.equal(report.repositories[0]?.dimensions.baseline.expectedRef, null);
  assert.equal(report.overallStatus, "WARN");
});

test("technical and missing repository failures are isolated while later repositories run", () => {
  const broken = createWebapp({ git: false });
  const good = createWebapp();
  const missing = path.join(temporaryDirectory("ecosystem-status-missing-parent-"), "missing");
  const report = inspectEcosystemStatus([
    { name: "broken", target: broken.root, expectedRef: "main" },
    { name: "missing", target: missing },
    { name: "good", target: good.root, expectedRef: "main" },
  ], { inputMode: "config", configVersion: 1 });

  assert.deepEqual(report.repositories.map((repository) => repository.name), ["broken", "missing", "good"]);
  assert.equal(report.repositories[0]?.technicalStatus, "FAIL");
  assert.equal(report.repositories[1]?.overallStatus, "FAIL");
  assert.equal(report.repositories[2]?.overallStatus, "WARN");
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.overallStatus, "FAIL");
});

test("unsupported profiles fail quality and config entries retain independent selectors", () => {
  const unknown = createUnknownRepository();
  const webapp = createWebapp();
  const result = runCli("--config", config([
    { name: "unknown", path: unknown, expectedCommit: git(unknown, ["rev-parse", "HEAD"]) },
    { name: "webapp", path: webapp.root, expectedRef: "main", compareRef: "HEAD" },
  ]), "--json");
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 1);
  assert.equal(report.repositories[0]?.profile, "unknown");
  assert.equal(report.repositories[0]?.dimensions.quality.status, "FAIL");
  assert.equal(report.repositories[0]?.dimensions.baseline.expectedCommit !== null, true);
  assert.equal(report.repositories[1]?.dimensions.baseline.expectedRef, "main");
});

test("configured direct deployments can make the ecosystem fully PASS", () => {
  const webapp = createWebapp();
  const python = createPythonService();
  assert.ok(webapp.initial);
  assert.ok(python.initial);
  const result = runCli("--config", config([
    { name: "app-a", path: webapp.root, expectedRef: "main", deployedCommit: webapp.initial },
    { name: "worker-b", path: python.root, expectedRef: "main", deployedCommit: python.initial },
  ]), "--json");
  /** @type {{ overallStatus: string, repositories: Array<{ dimensions: { deployment: { deploymentStatus: string } } }>, summary: { deployment: Record<string, number> } }} */
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.repositories.map((repository) => repository.dimensions.deployment.deploymentStatus), ["MATCH", "MATCH"]);
  assert.deepEqual(report.summary.deployment, { pass: 2, warn: 0, fail: 0, notConfigured: 0 });
});

test("runtime evidence paths are config-relative and retain canonical trust metadata", () => {
  const webapp = createWebapp();
  assert.ok(webapp.initial);
  const directory = temporaryDirectory("ecosystem-status-relative-evidence-");
  const evidencePath = path.join(directory, "runtime-evidence.json");
  const configPath = path.join(directory, "ecosystem-status.json");
  fs.writeFileSync(evidencePath, JSON.stringify(runtimeEvidence(webapp.initial, { authenticated: true })));
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    repositories: [{
      name: "app-a",
      path: webapp.root,
      expectedRef: "main",
      evidenceFile: "./runtime-evidence.json",
      maxEvidenceAgeSeconds: 3600,
      evaluatedAt: "2026-09-16T01:00:00Z",
    }],
  }));
  const before = fs.readFileSync(evidencePath, "utf8");
  const result = runCli("--config", configPath, "--json");
  const report = JSON.parse(result.stdout);
  const evidence = report.repositories[0]?.dimensions.deployment.evidence;

  assert.equal(result.status, 0);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.repositories[0]?.dimensions.deployment.deploymentStatus, "MATCH");
  assert.equal(report.repositories[0]?.dimensions.deployment.freshness?.status, "FRESH");
  assert.equal(evidence?.type, "runtime-evidence");
  assert.equal(evidence?.authenticated, true);
  assert.equal(evidence?.source, "manual");
  assert.equal(evidence?.runtime?.name, "runtime-a");
  assert.equal(fs.readFileSync(evidencePath, "utf8"), before);
  const parsed = parseEcosystemConfig(JSON.parse(fs.readFileSync(configPath, "utf8")), directory);
  assert.equal("error" in parsed, false);
  if (!("error" in parsed)) {
    assert.equal(parsed.repositories[0]?.evidenceFile, evidencePath);
    assert.equal(parsed.repositories[0]?.maxEvidenceAgeSeconds, 3600);
    assert.equal(parsed.repositories[0]?.evaluatedAt, "2026-09-16T01:00:00Z");
  }
});
test("deployment mismatch and unavailable baselines remain aggregated warnings", () => {
  const mismatch = createWebapp();
  assert.ok(mismatch.initial);
  writeCommit(mismatch.root, "next");
  const unverified = createWebapp();
  assert.ok(unverified.initial);

  const report = inspectEcosystemStatus([
    {
      name: "mismatch",
      target: mismatch.root,
      expectedRef: "main",
      deployedCommit: mismatch.initial,
    },
    {
      name: "unverified",
      target: unverified.root,
      expectedRef: "origin/not-locally-available",
      deployedCommit: unverified.initial,
    },
  ], { inputMode: "config", configVersion: 1 });

  assert.deepEqual(report.repositories.map((repository) => repository.dimensions.deployment.deploymentStatus), ["MISMATCH", "UNVERIFIED"]);
  assert.deepEqual(report.summary.deployment, { pass: 0, warn: 2, fail: 0, notConfigured: 0 });
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "WARN");
});
test("invalid runtime evidence is isolated to its repository while later repositories still run", () => {
  const invalid = createWebapp();
  const good = createWebapp();
  assert.ok(invalid.initial);
  assert.ok(good.initial);
  const invalidEvidence = evidenceFile(runtimeEvidence("HEAD"));

  const report = inspectEcosystemStatus([
    {
      name: "invalid-evidence",
      target: invalid.root,
      expectedRef: "main",
      evidenceFile: invalidEvidence,
    },
    {
      name: "good",
      target: good.root,
      expectedRef: "main",
      deployedCommit: good.initial,
    },
  ], { inputMode: "config", configVersion: 1 });

  assert.equal(report.repositories[0]?.overallStatus, "FAIL");
  assert.equal(report.repositories[0]?.dimensions.deployment.status, "FAIL");
  assert.equal(report.repositories[1]?.overallStatus, "PASS");
  assert.equal(report.repositories[1]?.dimensions.deployment.deploymentStatus, "MATCH");
  assert.deepEqual(report.summary.deployment, { pass: 1, warn: 0, fail: 1, notConfigured: 0 });
  assert.equal(report.overallStatus, "FAIL");
});

test("ecosystem freshness keeps fresh MATCH passing and stale MATCH warning", () => {
  const freshRepo = createWebapp();
  const staleRepo = createWebapp();
  assert.ok(freshRepo.initial);
  assert.ok(staleRepo.initial);
  const freshEvidence = evidenceFile(runtimeEvidence(freshRepo.initial));
  const staleEvidence = evidenceFile(runtimeEvidence(staleRepo.initial));

  const report = inspectEcosystemStatus([
    {
      name: "fresh",
      target: freshRepo.root,
      expectedRef: "main",
      evidenceFile: freshEvidence,
      maxEvidenceAgeSeconds: 3600,
      evaluatedAt: "2026-09-16T01:00:00Z",
    },
    {
      name: "stale",
      target: staleRepo.root,
      expectedRef: "main",
      evidenceFile: staleEvidence,
      maxEvidenceAgeSeconds: 3600,
      evaluatedAt: "2026-09-16T02:00:00Z",
    },
  ], { inputMode: "config", configVersion: 1 });

  assert.deepEqual(report.repositories.map((repository) => repository.dimensions.deployment.deploymentStatus), ["MATCH", "MATCH"]);
  assert.deepEqual(report.repositories.map((repository) => repository.dimensions.deployment.freshness?.status), ["FRESH", "STALE"]);
  assert.deepEqual(report.repositories.map((repository) => repository.overallStatus), ["PASS", "WARN"]);
  assert.deepEqual(report.summary.deployment, { pass: 1, warn: 1, fail: 0, notConfigured: 0 });
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "WARN");
  const rendered = formatEcosystemStatus(report);
  assert.match(rendered, /fresh.*MATCH\/FRESH.*PASS/);
  assert.match(rendered, /stale.*MATCH\/STALE.*WARN/);
});

test("future runtime evidence remains a non-technical ecosystem warning", () => {
  const repository = createWebapp();
  assert.ok(repository.initial);
  const report = inspectEcosystemStatus([{
    name: "future",
    target: repository.root,
    expectedRef: "main",
    evidenceFile: evidenceFile(runtimeEvidence(repository.initial)),
    maxEvidenceAgeSeconds: 3600,
    evaluatedAt: "2026-09-15T23:00:00Z",
  }], { inputMode: "config", configVersion: 1 });

  assert.equal(report.repositories[0]?.dimensions.deployment.deploymentStatus, "MATCH");
  assert.equal(report.repositories[0]?.dimensions.deployment.freshness?.status, "FUTURE");
  assert.equal(report.repositories[0]?.technicalStatus, "PASS");
  assert.equal(report.repositories[0]?.overallStatus, "WARN");
  assert.equal(report.overallStatus, "WARN");
});
test("config entry without a selector is NOT_CONFIGURED", () => {
  const webapp = createWebapp();
  const result = runCli("--config", config([{ path: webapp.root }]), "--json");
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(report.repositories[0]?.baselineConfigured, false);
  assert.equal(report.repositories[0]?.dimensions.baseline.status, "NOT_CONFIGURED");
});

test("config validation rejects invalid contracts and duplicate resolved targets", () => {
  const target = temporaryDirectory("ecosystem-status-validation-");
  const invalidConfigs = [
    "{",
    { version: 2, repositories: [{ path: target }] },
    { version: 1, repositories: [] },
    { version: 1, repositories: [{ path: target, compareRef: "HEAD" }] },
    { version: 1, repositories: [{ path: target, deployedCommit: "0123456789abcdef0123456789abcdef01234567" }] },
    { version: 1, repositories: [{ path: target, expectedRef: "main", deployedCommit: "HEAD" }] },
    { version: 1, repositories: [{ path: target, expectedRef: "main", deployedCommit: "0123456789abcdef0123456789abcdef01234567", evidenceFile: "runtime-evidence.json" }] },
    { version: 1, repositories: [{ path: target, expectedRef: "main", evidenceFile: "" }] },
    { version: 1, repositories: [{ path: target, expectedRef: "main", evidenceFile: "runtime-evidence.json", maxEvidenceAgeSeconds: 3600 }] },
    { version: 1, repositories: [{ path: target, expectedRef: "main", evidenceFile: "runtime-evidence.json", evaluatedAt: "2026-09-16T01:00:00Z" }] },
    { version: 1, repositories: [{ path: target, expectedRef: "main", deployedCommit: "0123456789abcdef0123456789abcdef01234567", maxEvidenceAgeSeconds: 3600, evaluatedAt: "2026-09-16T01:00:00Z" }] },
    { version: 1, repositories: [{ path: target, expectedRef: "main", evidenceFile: "runtime-evidence.json", maxEvidenceAgeSeconds: 0, evaluatedAt: "2026-09-16T01:00:00Z" }] },
    { version: 1, repositories: [{ path: target, expectedRef: "main", evidenceFile: "runtime-evidence.json", maxEvidenceAgeSeconds: 3600, evaluatedAt: "2026-09-16T01:00:00" }] },
    { version: 1, repositories: [{ path: target }, { path: target }] },
  ];

  for (const invalid of invalidConfigs) {
    const result = runCli("--config", configFile(invalid));
    assert.equal(result.status, 1);
  }
  assert.deepEqual(parseEcosystemConfig({ version: 1, repositories: [{ path: "relative" }] }, "/tmp"), {
    repositories: [{ target: "/tmp/relative", expectedRef: null, expectedCommit: null, compareRef: null, deployedCommit: null, evidenceFile: null, maxEvidenceAgeSeconds: null, evaluatedAt: null }],
  });
});

test("CLI rejects missing input, missing configs, unknown options, and mixed modes", () => {
  const target = temporaryDirectory("ecosystem-status-cli-validation-");
  const validConfig = config([{ path: target, expectedRef: "main" }]);
  for (const args of [
    [],
    ["--config", path.join(os.tmpdir(), "ecosystem-status-no-such-config.json")],
    ["--unknown"],
    [target, "--config", validConfig],
    [target, target],
  ]) {
    assert.equal(runCli(...args).status, 1);
  }
});

test("revision-expression restrictions are forwarded intact through config mode", () => {
  const webapp = createWebapp();
  const result = runCli("--config", config([{ path: webapp.root, expectedRef: "HEAD~1" }]), "--json");
  const report = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(report.repositories[0]?.dimensions.baseline.baselineStatus, "UNVERIFIED");
  assert.equal(report.repositories[0]?.dimensions.baseline.expectedRef, "HEAD~1");
});

test("JSON output, aggregate summary, order, and human scorecard are stable", () => {
  const passing = createWebapp();
  const warned = createWebapp();
  const failed = createWebapp({ complete: false });
  const input = [
    { name: "first", target: passing.root, expectedRef: "main", compareRef: "HEAD" },
    { name: "second", target: warned.root },
    { name: "third", target: failed.root, expectedRef: "main" },
  ];
  const report = inspectEcosystemStatus(input, { inputMode: "config", configVersion: 1 });
  const rendered = formatEcosystemStatus(report);

  assert.deepEqual(report.repositories.map((repository) => repository.name), ["first", "second", "third"]);
  assert.deepEqual(report.summary, {
    repositories: { total: 3 },
    overall: { pass: 0, warn: 2, fail: 1 },
    technical: { pass: 3, fail: 0 },
    quality: { pass: 2, fail: 1 },
    governance: { pass: 3, warn: 0, fail: 0 },
    baseline: { pass: 2, warn: 0, fail: 0, notConfigured: 1 },
    deployment: { pass: 0, warn: 0, fail: 0, notConfigured: 3 },
    profiles: { webapp: 3, "python-service": 0, unknown: 0 },
  });
  assert.match(rendered, /REPOSITORY.*QUALITY.*GOVERNANCE.*BASELINE.*DEPLOYMENT.*OVERALL/);
  assert.match(rendered, /first/);
  assert.match(rendered, /Result: FAIL/);
  assert.equal(main([passing.root]), 0);
});

test("the aggregator delegates canonical status rules and has no local Git command surface", () => {
  const source = fs.readFileSync(path.resolve("scripts/audit-ecosystem-status.js"), "utf8");
  assert.match(source, /inspectRepositoryStatus/);
  assert.match(source, /isFullObjectId/);
  assert.match(source, /validateEvidenceFreshnessPolicy/);
  assert.doesNotMatch(source, /validateRuntimeEvidence/);
  assert.doesNotMatch(source, /[0-9a-fA-F]\{40\}/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|Date\.now|\["git"/);
});
