import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  collectGitCheckoutRuntimeEvidence,
  formatGitCheckoutRuntimeEvidence,
  main,
} from "../scripts/collect-git-checkout-runtime-evidence.js";
import { validateRuntimeEvidence } from "../scripts/runtime-evidence.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** @param {{ inside?: any, head?: any, status?: any }} [values] */
function fakeGit(values = {}) {
  /** @type {Array<{repository:string,args:string[]}>} */
  const calls = [];
  /** @param {string} repository @param {string[]} args */
  const runner = (repository, args) => {
    calls.push({ repository, args });
    const command = args.join(" ");
    if (command === "rev-parse --is-inside-work-tree") return values.inside ?? { ok: true, stdout: "true\n" };
    if (command === "rev-parse --verify HEAD") return values.head ?? { ok: true, stdout: `${COMMIT}\n` };
    if (command === "status --porcelain=v1 --untracked-files=all --ignore-submodules=none") return values.status ?? { ok: true, stdout: "" };
    throw new Error(`unexpected git call ${command}`);
  };
  return { runner, calls };
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function tempRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-checkout-evidence-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Synthetic Test"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "baseline\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-q", "-m", "initial"]);
  return root;
}

test("clean checkout emits canonical Runtime Evidence v1 with checkout-only identity", () => {
  const mocked = fakeGit();
  const result = collectGitCheckoutRuntimeEvidence(
    { repository: "/synthetic/repo", runtimeName: "example-checkout", environment: "production" },
    { runGit: mocked.runner, now: () => "2026-09-16T18:30:00Z" },
  );
  assert.equal(result.ok, true);
  assert.equal(validateRuntimeEvidence(result.evidence).valid, true);
  assert.equal(result.evidence?.deployment.commit, COMMIT);
  assert.equal(result.evidence?.evidence.source, "local-git-checkout");
  assert.equal(result.evidence?.evidence.authenticated, false);
  assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.kind, "checkout");
  assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.identityScope, "checkout");
  assert.notEqual((/** @type {any} */ (result.evidence?.metadata?.collector))?.identityScope, "process");
  assert.deepEqual(mocked.calls.map((item) => item.args.join(" ")), [
    "rev-parse --is-inside-work-tree",
    "rev-parse --verify HEAD",
    "status --porcelain=v1 --untracked-files=all --ignore-submodules=none",
  ]);
});

test("collector trims explicit labels and preserves optional environment", () => {
  const mocked = fakeGit({ head: { ok: true, stdout: `${COMMIT.toUpperCase()}\n` } });
  const result = collectGitCheckoutRuntimeEvidence(
    { repository: " /synthetic/repo ", runtimeName: " checkout-a ", environment: " staging " },
    { runGit: mocked.runner, now: () => "2026-09-16T18:30:00+00:00" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.evidence?.runtime.name, "checkout-a");
  assert.equal(result.evidence?.runtime.environment, "staging");
  assert.equal(result.evidence?.deployment.commit, COMMIT);
  assert.equal(mocked.calls[0]?.repository, "/synthetic/repo");
});

test("dirty checkout fails closed because HEAD no longer describes checkout contents", () => {
  let clockCalls = 0;
  const mocked = fakeGit({ status: { ok: true, stdout: " M src/private-name.js\n?? local-only.txt\n" } });
  const result = collectGitCheckoutRuntimeEvidence(
    { repository: "/synthetic/repo", runtimeName: "checkout-a" },
    { runGit: mocked.runner, now: () => { clockCalls += 1; return "2026-09-16T18:30:00Z"; } },
  );
  assert.equal(result.ok, false);
  assert.match(result.error ?? "", /dirty/);
  assert.doesNotMatch(result.error ?? "", /private-name|local-only/);
  assert.equal(clockCalls, 0);
});

test("collector fails closed for non-worktrees invalid HEAD status failure and invalid clock", () => {
  const outside = fakeGit({ inside: { ok: true, stdout: "false\n" } });
  assert.equal(collectGitCheckoutRuntimeEvidence({ repository: "/tmp/a", runtimeName: "x" }, { runGit: outside.runner }).ok, false);

  const head = fakeGit({ head: { ok: true, stdout: "HEAD\n" } });
  assert.equal(collectGitCheckoutRuntimeEvidence({ repository: "/tmp/a", runtimeName: "x" }, { runGit: head.runner }).ok, false);

  const status = fakeGit({ status: { ok: false, stdout: "" } });
  assert.equal(collectGitCheckoutRuntimeEvidence({ repository: "/tmp/a", runtimeName: "x" }, { runGit: status.runner }).ok, false);

  const clock = fakeGit();
  assert.equal(collectGitCheckoutRuntimeEvidence(
    { repository: "/tmp/a", runtimeName: "x" },
    { runGit: clock.runner, now: () => "today" },
  ).ok, false);
});

test("collector rejects incomplete explicit inputs before touching Git", () => {
  const mocked = fakeGit();
  assert.equal(collectGitCheckoutRuntimeEvidence({ repository: "", runtimeName: "x" }, { runGit: mocked.runner }).ok, false);
  assert.equal(collectGitCheckoutRuntimeEvidence({ repository: "/tmp/a", runtimeName: " " }, { runGit: mocked.runner }).ok, false);
  assert.equal(collectGitCheckoutRuntimeEvidence({ repository: "/tmp/a", runtimeName: "x", environment: " " }, { runGit: mocked.runner }).ok, false);
  assert.equal(mocked.calls.length, 0);
});

test("real clean local Git checkout collection reports exact HEAD and never process identity", () => {
  const root = tempRepository();
  try {
    const expected = git(root, ["rev-parse", "HEAD"]);
    const result = collectGitCheckoutRuntimeEvidence(
      { repository: root, runtimeName: "temp-checkout" },
      { now: () => "2026-09-16T18:30:00Z" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.evidence?.deployment.commit, expected);
    assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.identityScope, "checkout");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("real tracked and untracked checkout changes are refused", () => {
  const root = tempRepository();
  try {
    fs.appendFileSync(path.join(root, "tracked.txt"), "dirty\n");
    let result = collectGitCheckoutRuntimeEvidence({ repository: root, runtimeName: "temp-checkout" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /dirty/);

    git(root, ["checkout", "--", "tracked.txt"]);
    fs.writeFileSync(path.join(root, "untracked.txt"), "local\n");
    result = collectGitCheckoutRuntimeEvidence({ repository: root, runtimeName: "temp-checkout" });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /dirty/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("human output states clean checkout and checkout identity scope", () => {
  const mocked = fakeGit();
  const result = collectGitCheckoutRuntimeEvidence(
    { repository: "/synthetic/repo", runtimeName: "checkout-a" },
    { runGit: mocked.runner, now: () => "2026-09-16T18:30:00Z" },
  );
  const output = formatGitCheckoutRuntimeEvidence(result);
  assert.match(output, /Identity scope: checkout/);
  assert.match(output, /Checkout cleanliness: CLEAN/);
  assert.match(output, /Authenticated: false/);
  assert.doesNotMatch(output, /process identity/i);
});

test("CLI emits canonical JSON for a real clean checkout", () => {
  const root = tempRepository();
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["--repository", root, "--runtime-name", "cli-checkout", "--environment", "test", "--json"]), 0);
  } finally {
    console.log = originalLog;
    fs.rmSync(root, { recursive: true, force: true });
  }
  const evidence = JSON.parse(stdout);
  assert.equal(validateRuntimeEvidence(evidence).valid, true);
  assert.equal(evidence.metadata.collector.identityScope, "checkout");
  assert.equal(evidence.evidence.authenticated, false);
});

test("CLI rejects dirty checkout missing arguments and unknown options", () => {
  const root = tempRepository();
  const originalError = console.error;
  console.error = () => {};
  try {
    fs.appendFileSync(path.join(root, "tracked.txt"), "dirty\n");
    assert.equal(main(["--repository", root, "--runtime-name", "cli-checkout"]), 1);
    assert.equal(main(["--repository", root]), 1);
    assert.equal(main(["--unknown"]), 1);
  } finally {
    console.error = originalError;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("collector operational surface is local read-only Git only", () => {
  const source = fs.readFileSync(new URL("../scripts/collect-git-checkout-runtime-evidence.js", import.meta.url), "utf8");
  assert.match(source, /spawnSync/);
  assert.match(source, /--no-optional-locks/);
  assert.match(source, /core\.fsmonitor=false/);
  assert.match(source, /adaptRuntimeCollectorObservation/);
  assert.match(source, /validateRuntimeEvidence/);
  assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\/|process\.env|shell\s*:\s*true|\bgit\s+(?:fetch|pull|push|checkout|reset|clean|commit)\b/);
  assert.doesNotMatch(source, /writeFile|appendFile|rmSync|unlinkSync|renameSync|mkdirSync/);
});
