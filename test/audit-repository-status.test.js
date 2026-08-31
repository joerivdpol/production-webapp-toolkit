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

afterEach(() => {
  for (const root of fixtures.splice(0).reverse()) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("composes passing quality, governance, and an explicit matching baseline", () => {
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
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "PASS");
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
    "dimensions",
    "technicalStatus",
    "overallStatus",
    "summary",
  ]) {
    assert.ok(field in parsed, `expected JSON field ${field}`);
  }
  for (const field of ["quality", "governance", "baseline"]) {
    assert.ok(field in parsed.dimensions, `expected ${field} dimension`);
  }
  assert.equal(parsed.dimensions.baseline.comparisonResolvedCommit, git(root, ["rev-parse", "HEAD"]));
  assert.equal(human.status, 0);
  assert.match(human.stdout, /QUALITY\s+PASS/);
  assert.match(human.stdout, /GOVERNANCE\s+PASS/);
  assert.match(human.stdout, /BASELINE\s+PASS \(MATCH\)/);
  assert.match(formatRepositoryStatus(parsed), /Overall: PASS/);
  assert.equal(missingBaseline.status, 1);
  assert.match(missingBaseline.stderr, /compare-ref/);
  assert.equal(revisionExpression.status, 0);
  assert.equal(JSON.parse(revisionExpression.stdout).dimensions.baseline.baselineStatus, "UNVERIFIED");
});
