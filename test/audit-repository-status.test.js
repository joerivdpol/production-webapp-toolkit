import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  formatRepositoryStatus,
  inspectRepositoryStatus,
  main,
} from "../scripts/audit-repository-status.js";

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

/** @param {string} root @param {{ restrictedFetch?: boolean, remoteHead?: boolean, upstream?: boolean }} options */
function initializeGit(root, options = {}) {
  const remote = temporaryDirectory("repository-status-remote-");
  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Toolkit Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);

  const initial = git(root, ["rev-parse", "HEAD"]);
  git(root, ["remote", "add", "origin", remote]);
  git(root, ["update-ref", "refs/remotes/origin/main", initial]);

  if (options.upstream !== false) {
    git(root, ["branch", "--set-upstream-to=origin/main", "main"]);
  }

  if (options.restrictedFetch) {
    git(root, ["config", "--unset-all", "remote.origin.fetch"]);
    git(root, ["config", "--add", "remote.origin.fetch", "+refs/heads/dev/*:refs/remotes/origin/dev/*"]);
  }

  if (options.remoteHead !== false) {
    git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
  }

  return initial;
}

/** @param {{ complete?: boolean, git?: boolean, restrictedFetch?: boolean, remoteHead?: boolean }} options */
function createWebapp(options = {}) {
  const root = temporaryDirectory("repository-status-webapp-");
  const complete = options.complete !== false;

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "repository-status-fixture",
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

  if (complete) {
    fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
    fs.writeFileSync(path.join(root, "scripts", "lint-changed.js"), "// fixture\n");
  }

  return {
    root,
    initial: options.git === false ? null : initializeGit(root, options),
  };
}

function createPythonService() {
  const root = temporaryDirectory("repository-status-python-");
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
  const root = temporaryDirectory("repository-status-unknown-");
  fs.writeFileSync(path.join(root, "README.md"), "# Unknown\n");
  initializeGit(root);
  return root;
}

/** @param {...string} args */
function runCli(...args) {
  const script = path.resolve("scripts/audit-repository-status.js");
  return spawnSync("node", [script, ...args], { encoding: "utf8" });
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
      collectedAt: "2026-09-03T00:00:00Z",
    },
  };
}

/** @param {unknown} evidence */
function writeEvidenceFile(evidence) {
  const directory = temporaryDirectory("repository-status-evidence-");
  const file = path.join(directory, "runtime-evidence.json");
  fs.writeFileSync(file, JSON.stringify(evidence));
  return file;
}

afterEach(() => {
  for (const root of fixtures.splice(0).reverse()) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matching baseline without deployment remains a readiness warning", () => {
  const { root } = createWebapp();
  const report = inspectRepositoryStatus(root, {
    expectedRef: "main",
    compareRef: "HEAD",
  });

  assert.equal(report.dimensions.quality.status, "PASS");
  assert.equal(report.dimensions.governance.status, "PASS");
  assert.equal(report.dimensions.baseline.configured, true);
  assert.equal(report.dimensions.baseline.status, "PASS");
  assert.equal(report.dimensions.baseline.baselineStatus, "MATCH");
  assert.equal(report.dimensions.baseline.exactMatch, true);
  assert.equal(report.deploymentConfigured, false);
  assert.equal(report.dimensions.deployment.status, "NOT_CONFIGURED");
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "WARN");
  assert.equal(main([root, "--expected-ref", "main", "--compare-ref", "HEAD"]), 0);
});

test("makes a quality gate failure blocking without calling it a technical failure", () => {
  const { root } = createWebapp({ complete: false });
  const report = inspectRepositoryStatus(root, { expectedRef: "main" });

  assert.equal(report.dimensions.quality.status, "FAIL");
  assert.equal(report.dimensions.governance.status, "PASS");
  assert.equal(report.dimensions.baseline.technicalStatus, "PASS");
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(main([root, "--expected-ref", "main"]), 1);
});

test("propagates governance warnings without turning them into technical failures", () => {
  const { root } = createWebapp({ restrictedFetch: true });
  const report = inspectRepositoryStatus(root, { expectedRef: "main" });

  assert.equal(report.dimensions.quality.status, "PASS");
  assert.equal(report.dimensions.governance.status, "WARN");
  assert.equal(report.dimensions.baseline.status, "PASS");
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "WARN");
  assert.equal(main([root, "--expected-ref", "main"]), 0);
});

test("fails overall when the governance audit cannot read Git metadata", () => {
  const { root } = createWebapp({ git: false });
  const report = inspectRepositoryStatus(root);

  assert.equal(report.dimensions.quality.status, "PASS");
  assert.equal(report.dimensions.governance.status, "FAIL");
  assert.equal(report.dimensions.governance.technicalStatus, "FAIL");
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(main([root]), 1);
});

test("does not configure a baseline from production candidates", () => {
  const { root } = createWebapp();
  const head = git(root, ["rev-parse", "HEAD"]);
  git(root, ["branch", "production/api", head]);
  git(root, ["update-ref", "refs/remotes/origin/prod/blue", head]);
  const report = inspectRepositoryStatus(root);

  assert.equal(report.baselineConfigured, false);
  assert.equal(report.dimensions.baseline.configured, false);
  assert.equal(report.dimensions.baseline.status, "NOT_CONFIGURED");
  assert.equal(report.dimensions.baseline.expectedRef, null);
  assert.equal(report.dimensions.governance.productionCandidates.length, 2);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(main([root]), 0);
});

test("keeps baseline mismatch and unverified states as non-technical warnings", () => {
  const { root, initial } = createWebapp();
  writeCommit(root, "next");
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

  const mismatch = inspectRepositoryStatus(root, {
    expectedRef: "main",
    expectedCommit: initial,
  });
  const unverified = inspectRepositoryStatus(root, {
    expectedRef: "origin/production/not-locally-fetched",
  });

  assert.equal(mismatch.dimensions.baseline.baselineStatus, "MISMATCH");
  assert.equal(mismatch.dimensions.baseline.status, "WARN");
  assert.equal(mismatch.technicalStatus, "PASS");
  assert.equal(mismatch.overallStatus, "WARN");
  assert.equal(unverified.dimensions.baseline.baselineStatus, "UNVERIFIED");
  assert.equal(unverified.overallStatus, "WARN");
  assert.equal(main([root, "--expected-ref", "origin/production/not-locally-fetched"]), 0);
});

test("propagates a configured baseline technical failure", () => {
  const { root } = createWebapp({ git: false });
  const report = inspectRepositoryStatus(root, { expectedRef: "main" });

  assert.equal(report.dimensions.baseline.configured, true);
  assert.equal(report.dimensions.baseline.technicalStatus, "FAIL");
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(main([root, "--expected-ref", "main"]), 1);
});

test("composes Python-service profiles and preserves detached-HEAD governance warnings", () => {
  const { root } = createPythonService();
  git(root, ["checkout", "--detach"]);
  const report = inspectRepositoryStatus(root, { expectedRef: "main", compareRef: "HEAD" });

  assert.equal(report.profile, "python-service");
  assert.equal(report.dimensions.quality.status, "PASS");
  assert.equal(report.dimensions.governance.detached, true);
  assert.equal(report.dimensions.governance.status, "WARN");
  assert.equal(report.dimensions.baseline.baselineStatus, "MATCH");
  assert.equal(report.overallStatus, "WARN");
});

test("fails unsupported repository profiles while keeping the status report available", () => {
  const root = createUnknownRepository();
  const report = inspectRepositoryStatus(root, { expectedRef: "main" });

  assert.equal(report.profile, "unknown");
  assert.equal(report.dimensions.quality.status, "FAIL");
  assert.equal(report.dimensions.governance.status, "PASS");
  assert.equal(report.overallStatus, "FAIL");
});

test("has stable parseable JSON, a compact scorecard, and strict CLI validation", () => {
  const { root } = createWebapp();
  const json = runCli(root, "--expected-ref", "main", "--compare-ref", "HEAD", "--json");
  const human = runCli(root, "--expected-ref", "main");
  const missingBaseline = runCli(root, "--compare-ref", "HEAD", "--json");
  const revisionExpression = runCli(root, "--expected-ref", "HEAD~1", "--json");

  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  for (const field of [
    "root",
    "profile",
    "baselineConfigured",
    "deploymentConfigured",
    "dimensions",
    "technicalStatus",
    "overallStatus",
    "summary",
  ]) {
    assert.ok(field in parsed, `expected JSON field ${field}`);
  }
  for (const field of ["quality", "governance", "baseline", "deployment"]) {
    assert.ok(field in parsed.dimensions, `expected ${field} dimension`);
  }
  assert.equal(parsed.dimensions.baseline.comparisonResolvedCommit, git(root, ["rev-parse", "HEAD"]));
  assert.equal(human.status, 0);
  assert.match(human.stdout, /QUALITY\s+PASS/);
  assert.match(human.stdout, /GOVERNANCE\s+PASS/);
  assert.match(human.stdout, /BASELINE\s+PASS \(MATCH\)/);
  assert.match(human.stdout, /DEPLOYMENT\s+NOT_CONFIGURED/);
  assert.match(formatRepositoryStatus(parsed), /Overall: WARN/);
  assert.equal(missingBaseline.status, 1);
  assert.match(missingBaseline.stderr, /compare-ref/);
  assert.equal(revisionExpression.status, 0);
  assert.equal(JSON.parse(revisionExpression.stdout).dimensions.baseline.baselineStatus, "UNVERIFIED");
});
test("direct deployment commits produce MATCH, MISMATCH, and UNVERIFIED status without inference", () => {
  const matching = createWebapp();
  assert.ok(matching.initial);
  const match = inspectRepositoryStatus(matching.root, {
    expectedRef: "main",
    deployedCommit: matching.initial,
  });
  assert.equal(match.deploymentConfigured, true);
  assert.equal(match.dimensions.deployment.deploymentStatus, "MATCH");
  assert.equal(match.dimensions.deployment.status, "PASS");
  assert.equal(match.overallStatus, "PASS");

  const mismatchFixture = createWebapp();
  assert.ok(mismatchFixture.initial);
  writeCommit(mismatchFixture.root, "next");
  const mismatch = inspectRepositoryStatus(mismatchFixture.root, {
    expectedRef: "main",
    deployedCommit: mismatchFixture.initial,
  });
  assert.equal(mismatch.dimensions.deployment.deploymentStatus, "MISMATCH");
  assert.equal(mismatch.dimensions.deployment.status, "WARN");
  assert.equal(mismatch.technicalStatus, "PASS");
  assert.equal(mismatch.overallStatus, "WARN");
  const unverifiedFixture = createWebapp();
  assert.ok(unverifiedFixture.initial);
  const unverified = inspectRepositoryStatus(unverifiedFixture.root, {
    expectedRef: "origin/production/not-locally-fetched",
    deployedCommit: unverifiedFixture.initial,
  });
  assert.equal(unverified.dimensions.baseline.baselineStatus, "UNVERIFIED");
  assert.equal(unverified.dimensions.deployment.deploymentStatus, "UNVERIFIED");
  assert.equal(unverified.dimensions.deployment.status, "WARN");
  assert.equal(unverified.technicalStatus, "PASS");
  assert.equal(unverified.overallStatus, "WARN");
});

test("runtime evidence files retain trust metadata and optional environment without changing status rules", () => {
  const { root, initial } = createWebapp();
  assert.ok(initial);
  const authenticatedFile = writeEvidenceFile(runtimeEvidence(initial, { authenticated: true }));
  const authenticated = inspectRepositoryStatus(root, {
    expectedRef: "main",
    evidenceFile: authenticatedFile,
  });
  assert.equal(authenticated.dimensions.deployment.deploymentStatus, "MATCH");
  assert.equal(authenticated.dimensions.deployment.status, "PASS");
  const authenticatedEvidence = authenticated.dimensions.deployment.evidence;
  assert.ok(authenticatedEvidence);
  assert.equal(authenticatedEvidence.type, "runtime-evidence");
  if (authenticatedEvidence.type !== "runtime-evidence") throw new Error("expected runtime evidence");
  assert.equal(authenticatedEvidence.authenticated, true);
  assert.equal(authenticatedEvidence.source, "manual");
  assert.equal(authenticatedEvidence.collectedAt, "2026-09-03T00:00:00Z");
  assert.equal(authenticatedEvidence.runtime.name, "runtime-a");
  assert.equal(authenticatedEvidence.runtime.environment, "example-production");
  assert.equal(authenticated.overallStatus, "PASS");

  const noEnvironmentFile = writeEvidenceFile(runtimeEvidence(initial, { environment: null }));
  const noEnvironment = inspectRepositoryStatus(root, {
    expectedRef: "main",
    evidenceFile: noEnvironmentFile,
  });
  assert.equal(noEnvironment.dimensions.deployment.deploymentStatus, "MATCH");
  const noEnvironmentEvidence = noEnvironment.dimensions.deployment.evidence;
  assert.ok(noEnvironmentEvidence);
  if (noEnvironmentEvidence.type !== "runtime-evidence") throw new Error("expected runtime evidence");
  assert.equal("environment" in noEnvironmentEvidence.runtime, false);
});

test("runtime evidence mismatch and inconsistent baseline remain non-technical warnings", () => {
  const mismatchFixture = createWebapp();
  assert.ok(mismatchFixture.initial);
  const oldEvidence = writeEvidenceFile(runtimeEvidence(mismatchFixture.initial));
  writeCommit(mismatchFixture.root, "next");
  const mismatch = inspectRepositoryStatus(mismatchFixture.root, {
    expectedRef: "main",
    evidenceFile: oldEvidence,
  });
  assert.equal(mismatch.dimensions.deployment.deploymentStatus, "MISMATCH");
  assert.equal(mismatch.overallStatus, "WARN");
  assert.equal(mismatch.technicalStatus, "PASS");
  const inconsistentFixture = createWebapp();
  assert.ok(inconsistentFixture.initial);
  writeCommit(inconsistentFixture.root, "next");
  const evidence = writeEvidenceFile(runtimeEvidence(git(inconsistentFixture.root, ["rev-parse", "HEAD"])));
  const inconsistent = inspectRepositoryStatus(inconsistentFixture.root, {
    expectedRef: "main",
    expectedCommit: inconsistentFixture.initial,
    evidenceFile: evidence,
  });
  assert.equal(inconsistent.dimensions.baseline.baselineStatus, "MISMATCH");
  assert.equal(inconsistent.dimensions.deployment.deploymentStatus, "UNVERIFIED");
  assert.equal(inconsistent.technicalStatus, "PASS");
  assert.equal(inconsistent.overallStatus, "WARN");
});

test("repository status CLI rejects invalid deployment configuration and invalid evidence files", () => {
  const { root, initial } = createWebapp();
  assert.ok(initial);
  const validFile = writeEvidenceFile(runtimeEvidence(initial));
  const invalidSchema = writeEvidenceFile(runtimeEvidence("HEAD"));
  const forbiddenMetadata = {
    ...runtimeEvidence(initial),
    metadata: { apiToken: "placeholder" },
  };
  const forbiddenFile = writeEvidenceFile(forbiddenMetadata);
  const malformedDirectory = temporaryDirectory("repository-status-malformed-");
  const malformedFile = path.join(malformedDirectory, "runtime-evidence.json");
  fs.writeFileSync(malformedFile, "{");
  for (const args of [
    [root, "--deployed-commit", initial],
    [root, "--expected-ref", "main", "--deployed-commit", "HEAD"],
    [root, "--expected-ref", "main", "--deployed-commit", initial, "--evidence-file", validFile],
    [root, "--expected-ref", "main", "--evidence-file", `${malformedDirectory}/missing.json`],
    [root, "--expected-ref", "main", "--evidence-file", malformedFile],
    [root, "--expected-ref", "main", "--evidence-file", invalidSchema],
    [root, "--expected-ref", "main", "--evidence-file", forbiddenFile],
    [root, "--evidence-file", validFile],
  ]) {
    const result = runCli(...args);
    assert.equal(result.status, 1, `expected CLI failure for ${args.join(" ")}`);
  }
});

test("evidence file input is read only and direct callers cannot forge runtime provenance", () => {
  const { root, initial } = createWebapp();
  assert.ok(initial);
  const file = writeEvidenceFile(runtimeEvidence(initial));
  const before = fs.readFileSync(file, "utf8");
  const result = runCli(root, "--expected-ref", "main", "--evidence-file", file, "--json");
  assert.equal(result.status, 0);
  assert.equal(fs.readFileSync(file, "utf8"), before);

  const forgedOptions = /** @type {any} */ ({
    expectedRef: "main",
    deployedCommit: initial,
    evidence: { type: "runtime-evidence", authenticated: true },
  });
  const forged = inspectRepositoryStatus(root, forgedOptions);
  const forgedEvidence = forged.dimensions.deployment.evidence;
  assert.ok(forgedEvidence);
  assert.equal(forgedEvidence.type, "explicit-commit");
  assert.equal(forgedEvidence.authenticated, false);
});

test("configured deployment technical failure propagates to repository technical failure", () => {
  const { root } = createWebapp({ git: false });
  const fullCommit = "0123456789abcdef0123456789abcdef01234567";
  const report = inspectRepositoryStatus(root, {
    expectedRef: "main",
    deployedCommit: fullCommit,
  });
  assert.equal(report.dimensions.baseline.technicalStatus, "FAIL");
  assert.equal(report.dimensions.deployment.technicalStatus, "FAIL");
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.overallStatus, "FAIL");
});

test("repository status delegates deployment validation and comparison to canonical deployment verification", () => {
  const source = fs.readFileSync(path.resolve("scripts/audit-repository-status.js"), "utf8");
  assert.match(source, /inspectDeploymentVerification/);
  assert.match(source, /inspectDeploymentVerificationFromEvidenceFile/);
  assert.match(source, /isFullObjectId/);
  assert.doesNotMatch(source, /validateRuntimeEvidence/);
  assert.doesNotMatch(source, /[0-9a-fA-F]\{40\}/);
  assert.doesNotMatch(source, /spawnSync|execFileSync|fetch\(|https?:|ssh|systemctl|docker|process\.env|writeFile/);
});
