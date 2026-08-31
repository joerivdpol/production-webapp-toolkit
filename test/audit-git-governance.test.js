import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  formatGitGovernance,
  inspectGitGovernance,
} from "../scripts/audit-git-governance.js";

const FULL_ORIGIN_FETCH = "+refs/heads/*:refs/remotes/origin/*";
const RESTRICTED_ORIGIN_FETCH = [
  "+refs/heads/dev/*:refs/remotes/origin/dev/*",
  "+refs/heads/production/*:refs/remotes/origin/production/*",
];

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

/** @param {string} root @param {string} parent */
function remoteCommit(root, parent) {
  return git(root, [
    "commit-tree",
    "HEAD^{tree}",
    "-p",
    parent,
    "-m",
    "remote commit",
  ]);
}

/**
 * @param {{
 *   fetchRefspecs?: string[],
 *   upstream?: boolean,
 *   remoteHead?: boolean
 * }} options
 */
function createRepository(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "git-governance-"));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "git-governance-remote-"));

  execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
  execFileSync("git", ["init", "-b", "main", root], { stdio: "ignore" });
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Toolkit Test"]);
  writeCommit(root, "initial");

  git(root, ["remote", "add", "origin", remote]);
  const initial = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", "refs/remotes/origin/main", initial]);

  if (options.upstream !== false) {
    git(root, ["branch", "--set-upstream-to=origin/main", "main"]);
  }

  // Establish the upstream while origin's default full fetch refspec still
  // maps origin/main. A restricted refspec intentionally does not map main,
  // but the resulting repository still models an existing local tracking ref.
  git(root, ["config", "--unset-all", "remote.origin.fetch"]);
  for (const refspec of options.fetchRefspecs ?? [FULL_ORIGIN_FETCH]) {
    git(root, ["config", "--add", "remote.origin.fetch", refspec]);
  }

  if (options.remoteHead !== false) {
    git(root, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);
  }

  return root;
}

/** @param {ReturnType<typeof inspectGitGovernance>} report @param {string} id */
function check(report, id) {
  const result = report.checks.find(
    /** @param {any} item */ (item) => item.id === id,
  );
  assert.ok(result, `expected ${id} check`);
  return result;
}

test("reports a normal complete origin fetch and a locally resolvable origin HEAD", () => {
  const root = createRepository();

  const report = inspectGitGovernance(root);

  assert.equal(report.summary.status, "PASS");
  assert.equal(report.root, root);
  assert.equal(report.currentBranch, "main");
  assert.equal(report.detached, false);
  assert.equal(report.upstream, "origin/main");
  assert.equal(report.ahead, 0);
  assert.equal(report.behind, 0);
  assert.deepEqual(report.fetchRefspecs.origin, [FULL_ORIGIN_FETCH]);
  assert.equal(report.remoteHead.origin.available, true);
  assert.equal(report.remoteHead.origin.ref, "origin/main");
  assert.deepEqual(report.localBranches, ["main"]);
  assert.deepEqual(report.remoteTrackingBranches, ["origin/main"]);
  assert.equal(report.remoteTrackingBranches.includes("origin"), false);
  assert.equal(check(report, "origin-fetch-refspec").severity, "PASS");
  assert.equal(check(report, "remote-head-origin").severity, "PASS");
  assert.equal(check(report, "branch-divergence").severity, "PASS");
});

test("excludes a symbolic remote HEAD alias from remote-tracking branches", () => {
  const root = createRepository();

  const report = inspectGitGovernance(root);

  assert.deepEqual(report.remoteTrackingBranches, ["origin/main"]);
  assert.equal(report.remoteTrackingBranches.includes("origin"), false);
});

test("treats restricted origin fetch refspecs as governance warnings", () => {
  const root = createRepository({ fetchRefspecs: RESTRICTED_ORIGIN_FETCH });

  const report = inspectGitGovernance(root);

  assert.deepEqual(report.fetchRefspecs.origin, RESTRICTED_ORIGIN_FETCH);
  assert.equal(check(report, "origin-fetch-refspec").severity, "WARN");
  assert.equal(report.summary.status, "WARN");
});

test("reports an ahead branch without treating divergence as a hard failure", () => {
  const root = createRepository();
  writeCommit(root, "ahead");

  const report = inspectGitGovernance(root);

  assert.equal(report.ahead, 1);
  assert.equal(report.behind, 0);
  assert.equal(check(report, "branch-divergence").severity, "WARN");
  assert.equal(report.summary.technicallySucceeded, true);
});

test("reports a behind branch without treating divergence as a hard failure", () => {
  const root = createRepository();
  const initial = git(root, ["rev-parse", "HEAD"]);
  git(root, ["update-ref", "refs/remotes/origin/main", remoteCommit(root, initial)]);

  const report = inspectGitGovernance(root);

  assert.equal(report.ahead, 0);
  assert.equal(report.behind, 1);
  assert.equal(check(report, "branch-divergence").severity, "WARN");
});

test("reports a divergent branch without claiming either side is incorrect", () => {
  const root = createRepository();
  const initial = git(root, ["rev-parse", "HEAD"]);
  writeCommit(root, "local");
  git(root, ["update-ref", "refs/remotes/origin/main", remoteCommit(root, initial)]);

  const report = inspectGitGovernance(root);

  assert.equal(report.ahead, 1);
  assert.equal(report.behind, 1);
  assert.equal(check(report, "branch-divergence").severity, "WARN");
  assert.match(formatGitGovernance(report), /1 ahead and 1 behind/);
});

test("warns when the current branch has no upstream", () => {
  const root = createRepository({ upstream: false });

  const report = inspectGitGovernance(root);

  assert.equal(report.upstream, null);
  assert.equal(report.ahead, null);
  assert.equal(report.behind, null);
  assert.equal(check(report, "upstream").severity, "WARN");
});

test("warns when local origin HEAD is absent", () => {
  const root = createRepository({ remoteHead: false });

  const report = inspectGitGovernance(root);

  assert.equal(report.remoteHead.origin.available, false);
  assert.equal(report.remoteHead.origin.ref, null);
  assert.equal(check(report, "remote-head-origin").severity, "WARN");
});

test("does not expose credentials from a configured remote URL", () => {
  const root = createRepository();
  const username = "fixture-user";
  const password = "fixture-secret";
  git(root, [
    "remote",
    "set-url",
    "origin",
    `https://${username}:${password}@example.invalid/repository.git`,
  ]);

  const output = JSON.stringify(inspectGitGovernance(root));

  assert.equal(output.includes(username), false);
  assert.equal(output.includes(password), false);
});

test("discovers production-like local and remote-tracking candidates without choosing one", () => {
  const root = createRepository();
  const head = git(root, ["rev-parse", "HEAD"]);
  git(root, ["branch", "production/api"]);
  git(root, ["update-ref", "refs/remotes/origin/prod/blue", head]);

  const report = inspectGitGovernance(root);

  assert.deepEqual(report.productionCandidates, [
    {
      branch: "production/api",
      ref: "refs/heads/production/api",
      source: "local",
    },
    {
      branch: "prod/blue",
      ref: "refs/remotes/origin/prod/blue",
      source: "remote-tracking",
      remote: "origin",
    },
  ]);
  assert.equal(check(report, "production-candidates").severity, "PASS");
});

test("reports detached HEAD and does not invent an upstream", () => {
  const root = createRepository();
  git(root, ["checkout", "--detach"]);

  const report = inspectGitGovernance(root);

  assert.equal(report.currentBranch, null);
  assert.equal(report.detached, true);
  assert.equal(report.upstream, null);
  assert.equal(check(report, "upstream").severity, "WARN");
});

test("returns FAIL reports for nonexistent and non-Git targets", () => {
  const nonexistent = path.join(os.tmpdir(), "git-governance-no-such-target");
  const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), "git-governance-non-git-"));

  const missingReport = inspectGitGovernance(nonexistent);
  const nonGitReport = inspectGitGovernance(nonGit);

  assert.equal(missingReport.summary.status, "FAIL");
  assert.equal(check(missingReport, "target-exists").severity, "FAIL");
  assert.equal(nonGitReport.summary.status, "FAIL");
  assert.equal(check(nonGitReport, "git-repository").severity, "FAIL");
});

test("CLI emits valid JSON and returns zero when governance warnings exist", () => {
  const root = createRepository({ fetchRefspecs: RESTRICTED_ORIGIN_FETCH });
  const script = path.resolve("scripts/audit-git-governance.js");
  const result = spawnSync("node", [script, root, "--json"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.summary.status, "WARN");

  for (const field of [
    "root",
    "head",
    "currentBranch",
    "detached",
    "remotes",
    "upstream",
    "ahead",
    "behind",
    "fetchRefspecs",
    "remoteHead",
    "productionCandidates",
    "checks",
    "summary",
  ]) {
    assert.ok(field in parsed, `expected JSON field ${field}`);
  }
});

test("CLI returns one only for a real audit failure", () => {
  const script = path.resolve("scripts/audit-git-governance.js");
  const target = path.join(os.tmpdir(), "git-governance-cli-no-such-target");
  const result = spawnSync("node", [script, target, "--json"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).summary.status, "FAIL");
});
