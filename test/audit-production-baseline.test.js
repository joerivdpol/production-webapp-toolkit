import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  formatProductionBaseline,
  inspectProductionBaseline,
} from "../scripts/audit-production-baseline.js";

/** @param {string} root @param {string[]} args */
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
  }).trim();
}

/** @param {string} root @param {string} name */
function writeCommit(root, name) {
  const filename = `${name}.txt`;
  fs.writeFileSync(path.join(root, filename), `${name}\n`);
  git(root, ["add", filename]);
  git(root, ["commit", "-m", name]);
  return git(root, ["rev-parse", "HEAD"]);
}

/** @param {{ origin?: boolean }} options */
function createRepository(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "production-baseline-"));
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Toolkit Test"]);
  const initial = writeCommit(root, "initial");

  if (options.origin) {
    const remote = fs.mkdtempSync(
      path.join(os.tmpdir(), "production-baseline-remote-"),
    );
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    git(root, ["remote", "add", "origin", remote]);
  }

  return { root, initial };
}

/** @param {ReturnType<typeof inspectProductionBaseline>} report @param {string} id */
function check(report, id) {
  const result = report.checks.find(
    /** @param {{ id: string }} item */ (item) => item.id === id,
  );
  assert.ok(result, `expected ${id} check`);
  return result;
}

test("resolves an explicitly supplied expected ref without inferring production truth", () => {
  const { root, initial } = createRepository();
  git(root, ["branch", "baseline/jepara-karimunjawa", initial]);

  const report = inspectProductionBaseline(root, {
    expectedRef: "baseline/jepara-karimunjawa",
  });

  assert.equal(report.expectedRefResolvedCommit, initial);
  assert.equal(report.expectedResolvedCommit, initial);
  assert.equal(report.baselineStatus, "MATCH");
  assert.equal(report.overallStatus, "PASS");
});

test("resolves a locally available explicit commit object", () => {
  const { root, initial } = createRepository();

  const report = inspectProductionBaseline(root, {
    expectedCommit: initial.slice(0, 12),
  });

  assert.equal(report.expectedCommitResolvedCommit, initial);
  assert.equal(report.expectedResolvedCommit, initial);
  assert.equal(report.baselineStatus, "MATCH");
});

test("reports MATCH when expected ref and expected commit resolve identically", () => {
  const { root, initial } = createRepository();

  const report = inspectProductionBaseline(root, {
    expectedRef: "main",
    expectedCommit: initial,
  });

  assert.equal(report.baselineStatus, "MATCH");
  assert.equal(check(report, "expected-ref-commit-contract").severity, "PASS");
  assert.equal(report.overallStatus, "PASS");
});

test("reports MISMATCH, not a technical failure, for different expected ref and commit", () => {
  const { root, initial } = createRepository();
  const next = writeCommit(root, "next");

  const report = inspectProductionBaseline(root, {
    expectedRef: "main",
    expectedCommit: initial,
  });

  assert.equal(report.expectedResolvedCommit, next);
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.baselineStatus, "MISMATCH");
  assert.equal(report.overallStatus, "WARN");
  assert.equal(check(report, "expected-ref-commit-contract").severity, "WARN");
});

test("reports an exact comparison match", () => {
  const { root, initial } = createRepository();

  const report = inspectProductionBaseline(root, {
    expectedRef: "main",
    compareRef: "HEAD",
  });

  assert.equal(report.expectedResolvedCommit, initial);
  assert.equal(report.comparisonResolvedCommit, initial);
  assert.equal(report.exactMatch, true);
  assert.equal(report.relationship, "same");
  assert.equal(report.ahead, 0);
  assert.equal(report.behind, 0);
});

test("accepts HEAD, ordinary branch refs, and remote-tracking refs", () => {
  const { root, initial } = createRepository();
  git(root, ["update-ref", "refs/remotes/origin/production/example", initial]);

  const headComparison = inspectProductionBaseline(root, {
    expectedRef: "main",
    compareRef: "HEAD",
  });
  const remoteComparison = inspectProductionBaseline(root, {
    expectedRef: "refs/heads/main",
    compareRef: "origin/production/example",
  });

  assert.equal(headComparison.comparisonResolvedCommit, initial);
  assert.equal(remoteComparison.expectedResolvedCommit, initial);
  assert.equal(remoteComparison.comparisonResolvedCommit, initial);
});

test("rejects revision expressions as expected refs without resolving commits", () => {
  const { root, initial } = createRepository();
  writeCommit(root, "next");
  writeCommit(root, "latest");
  git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const expressions = ["HEAD~1", "HEAD^", "main~2", "main^2", "main@{1}", "origin/main~1"];

  for (const expectedRef of expressions) {
    const report = inspectProductionBaseline(root, { expectedRef });
    assert.equal(report.expectedRefResolvedCommit, null, expectedRef);
    assert.notEqual(report.expectedRefResolvedCommit, initial, expectedRef);
    assert.equal(report.baselineStatus, "UNVERIFIED", expectedRef);
    assert.equal(report.overallStatus, "WARN", expectedRef);
    assert.equal(check(report, "expected-ref").severity, "WARN", expectedRef);
  }
});

test("rejects revision expressions as comparison refs without resolving commits", () => {
  const { root, initial } = createRepository();
  writeCommit(root, "next");
  const report = inspectProductionBaseline(root, {
    expectedRef: "main",
    compareRef: "HEAD~1",
  });

  assert.equal(report.comparisonResolvedCommit, null);
  assert.notEqual(report.comparisonResolvedCommit, initial);
  assert.equal(report.baselineStatus, "MATCH");
  assert.equal(report.overallStatus, "WARN");
  assert.equal(check(report, "compare-ref").severity, "WARN");
});

test("reports when expected is an ancestor of comparison with explicit distance direction", () => {
  const { root, initial } = createRepository();
  git(root, ["branch", "baseline", initial]);
  writeCommit(root, "comparison-next");

  const report = inspectProductionBaseline(root, {
    expectedRef: "baseline",
    compareRef: "main",
  });

  assert.equal(report.relationship, "expected-ancestor-of-comparison");
  assert.equal(report.ahead, 1);
  assert.equal(report.behind, 0);
  assert.match(report.distanceDirection, /comparison.*expected/);
});

test("reports when comparison is an ancestor of expected", () => {
  const { root, initial } = createRepository();
  git(root, ["branch", "comparison", initial]);
  writeCommit(root, "expected-next");

  const report = inspectProductionBaseline(root, {
    expectedRef: "main",
    compareRef: "comparison",
  });

  assert.equal(report.relationship, "comparison-ancestor-of-expected");
  assert.equal(report.ahead, 0);
  assert.equal(report.behind, 1);
});

test("reports divergent refs using only local commit graph metadata", () => {
  const { root, initial } = createRepository();
  git(root, ["checkout", "-b", "expected", initial]);
  writeCommit(root, "expected-change");
  git(root, ["checkout", "main"]);
  writeCommit(root, "comparison-change");

  const report = inspectProductionBaseline(root, {
    expectedRef: "expected",
    compareRef: "main",
  });

  assert.equal(report.exactMatch, false);
  assert.equal(report.relationship, "diverged");
  assert.equal(report.ahead, 1);
  assert.equal(report.behind, 1);
  assert.equal(check(report, "comparison").severity, "WARN");
});

test("treats a missing local expected ref as UNVERIFIED warning", () => {
  const { root } = createRepository();

  const report = inspectProductionBaseline(root, {
    expectedRef: "origin/production/not-locally-fetched",
  });

  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.baselineStatus, "UNVERIFIED");
  assert.equal(report.overallStatus, "WARN");
  assert.equal(check(report, "expected-ref").severity, "WARN");
  assert.match(check(report, "expected-ref").detail, /not locally resolvable/);
});

test("treats a missing local comparison ref as a warning", () => {
  const { root } = createRepository();

  const report = inspectProductionBaseline(root, {
    expectedRef: "main",
    compareRef: "origin/production/not-locally-fetched",
  });

  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.baselineStatus, "MATCH");
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.comparisonResolvedCommit, null);
  assert.equal(check(report, "compare-ref").severity, "WARN");
});

test("does not treat a restricted fetch refspec or absent tracking ref as remote absence", () => {
  const { root } = createRepository({ origin: true });
  git(root, ["config", "remote.origin.fetch", "+refs/heads/dev/*:refs/remotes/origin/dev/*"]);

  const report = inspectProductionBaseline(root, {
    expectedRef: "origin/production/example",
  });

  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.baselineStatus, "UNVERIFIED");
  assert.match(check(report, "expected-ref").detail, /does not establish whether a remote ref exists/);
});

test("supports detached HEAD targets and repositories without origin", () => {
  const { root, initial } = createRepository();
  git(root, ["checkout", "--detach"]);

  const report = inspectProductionBaseline(root, {
    expectedCommit: initial,
    compareRef: "HEAD",
  });

  assert.equal(report.head, initial);
  assert.equal(report.baselineStatus, "MATCH");
  assert.equal(report.exactMatch, true);
  assert.equal(report.overallStatus, "PASS");
});

test("returns technical failures for missing and non-Git targets", () => {
  const missing = path.join(os.tmpdir(), "production-baseline-no-such-target");
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "production-baseline-non-git-"));

  const missingReport = inspectProductionBaseline(missing, { expectedRef: "main" });
  const nonGitReport = inspectProductionBaseline(nonGit, { expectedRef: "main" });

  assert.equal(missingReport.technicalStatus, "FAIL");
  assert.equal(missingReport.overallStatus, "FAIL");
  assert.equal(check(missingReport, "target-exists").severity, "FAIL");
  assert.equal(nonGitReport.technicalStatus, "FAIL");
  assert.equal(check(nonGitReport, "git-repository").severity, "FAIL");
});

test("CLI validates that a baseline selector is required", () => {
  const { root } = createRepository();
  const script = path.resolve("scripts/audit-production-baseline.js");
  const result = spawnSync("node", [script, root, "--json"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /expected-ref/);
});

test("CLI JSON is stable and match, mismatch, and unverified all exit zero", () => {
  const { root, initial } = createRepository();
  const script = path.resolve("scripts/audit-production-baseline.js");
  const matching = spawnSync(
    "node",
    [script, root, "--expected-ref", "main", "--compare-ref", "HEAD", "--json"],
    { encoding: "utf8" },
  );
  writeCommit(root, "mismatch-next");
  const mismatch = spawnSync(
    "node",
    [script, root, "--expected-ref", "main", "--expected-commit", initial.slice(0, 12), "--json"],
    { encoding: "utf8" },
  );
  const unverified = spawnSync(
    "node",
    [script, root, "--expected-ref", "origin/production/missing", "--json"],
    { encoding: "utf8" },
  );
  const rejectedExpectedRef = spawnSync(
    "node",
    [script, root, "--expected-ref", "HEAD~1", "--json"],
    { encoding: "utf8" },
  );
  const rejectedCompareRef = spawnSync(
    "node",
    [script, root, "--expected-ref", "main", "--compare-ref", "main^", "--json"],
    { encoding: "utf8" },
  );

  for (const result of [matching, mismatch, unverified, rejectedExpectedRef, rejectedCompareRef]) {
    assert.equal(result.status, 0);
    const parsed = JSON.parse(result.stdout);
    for (const field of [
      "root",
      "head",
      "expectedRef",
      "expectedCommit",
      "expectedResolvedCommit",
      "compareRef",
      "comparisonResolvedCommit",
      "exactMatch",
      "relationship",
      "ahead",
      "behind",
      "checks",
      "technicalStatus",
      "baselineStatus",
      "overallStatus",
    ]) {
      assert.ok(field in parsed, `expected ${field} JSON field`);
    }
  }

  assert.equal(JSON.parse(matching.stdout).overallStatus, "PASS");
  assert.equal(JSON.parse(mismatch.stdout).baselineStatus, "MISMATCH");
  assert.equal(JSON.parse(unverified.stdout).baselineStatus, "UNVERIFIED");
  assert.equal(JSON.parse(rejectedExpectedRef.stdout).baselineStatus, "UNVERIFIED");
  assert.equal(JSON.parse(rejectedExpectedRef.stdout).overallStatus, "WARN");
  assert.equal(JSON.parse(rejectedCompareRef.stdout).comparisonResolvedCommit, null);
  assert.equal(JSON.parse(rejectedCompareRef.stdout).overallStatus, "WARN");
});

test("CLI returns one for a technical failure and human output exposes the status model", () => {
  const script = path.resolve("scripts/audit-production-baseline.js");
  const missing = path.join(os.tmpdir(), "production-baseline-cli-no-such-target");
  const result = spawnSync(
    "node",
    [script, missing, "--expected-ref", "main"],
    { encoding: "utf8" },
  );

  assert.equal(result.status, 1);
  assert.match(result.stdout, /Technical status: FAIL/);

  const { root } = createRepository();
  assert.match(
    formatProductionBaseline(inspectProductionBaseline(root, { expectedRef: "main" })),
    /Baseline status: MATCH/,
  );
});

test("auditor command surface is constrained to its read-only local Git allowlist", () => {
  const source = fs.readFileSync(
    path.resolve("scripts/audit-production-baseline.js"),
    "utf8",
  );

  assert.match(source, /READ_ONLY_GIT_COMMANDS/);
  for (const command of [
    "fetch",
    "pull",
    "push",
    "checkout",
    "switch",
    "reset",
    "merge",
    "rebase",
    "cherry-pick",
    "worktree",
  ]) {
    assert.equal(source.includes(`"${command}"`), false, `forbidden ${command} command`);
  }
});
