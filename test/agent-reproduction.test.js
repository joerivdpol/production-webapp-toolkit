import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { validateAgentTask } from "../scripts/agent-task.js";
import { validateAgentRolePolicy } from "../scripts/agent-role-policy.js";
import { validateAgentDiagnosisInput, validateAgentDiagnosisResult } from "../scripts/agent-diagnosis.js";
import { openAgentTaskRegistry, registerAgentTask, transitionAgentTask } from "../scripts/agent-task-registry.js";
import { acquireAgentWorkerLease } from "../scripts/agent-worker-lease.js";
import {
  validateAgentReproductionPolicy,
  validateAgentReproductionRunEvidence,
  validateAgentReproductionCandidate,
  inspectAgentReproductionWorktree,
  runAgentReproduction,
  verifyAgentReproductionRun,
  main as reproductionMain,
} from "../scripts/agent-reproduction.js";

const T0 = "2026-09-17T12:00:00Z";
const T1 = "2026-09-17T12:01:00Z";
const T2 = "2026-09-17T12:02:00Z";
/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error("fixture git failed");
  return result.stdout.trim();
}

/** @param {boolean} [existingTest] */
function repoFixture(existingTest = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-reproduction-"));
  const repo = path.join(root, "repo"), worktree = path.join(root, "worktree");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "test@example.invalid"]); git(repo, ["config", "user.name", "Test User"]);
  fs.mkdirSync(path.join(repo, "test")); fs.writeFileSync(path.join(repo, "test", ".keep"), "keep\n");
  if (existingTest) fs.writeFileSync(path.join(repo, "test", "regression.test.js"), "existing\n");
  fs.writeFileSync(path.join(repo, "package.json"), "{\"name\":\"fixture\",\"private\":true}\n");
  git(repo, ["add", "."]); git(repo, ["commit", "-qm", "initial"]);
  const commit = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "-q", "-b", "reproduction-test", worktree, commit]);
  return { root, repo, worktree, commit };
}

/** @param {string} commit */
function rawTask(commit) {
  return { version: 1, id: "task:reproduce", role: "reproduce", repository: { id: "demo-repo", baseCommit: commit }, createdAt: T0, risk: "MEDIUM", objective: "Create a regression test for the selected diagnosis hypothesis", authority: { filesystem: "WORKTREE_WRITE", shell: "NONE", network: "NONE", merge: false, deploy: false, productionMutation: false }, scope: { allowedPaths: ["test/*.test.js"], deniedPaths: ["src/**"], requiredChecks: ["test"] }, dependsOn: ["task:diagnose"] };
}
function rawRolePolicy() {
  return { version: 1, roles: [{ id: "reproduce", maxRisk: "MEDIUM", authority: { filesystem: "WORKTREE_WRITE", shell: "NONE", network: "NONE" }, writeMode: "LEASED_WORKTREE" }] };
}

function rawPolicy() {
  return { version: 1, repository: "demo-repo", testPathPatterns: ["test/*.test.js"], allowedExtensions: [".js"], maxTestBytes: 65536 };
}

/** @param {string} commit */
function rawDiagnosisInput(commit) {
  return { version: 1, taskId: "task:diagnose", repository: { id: "demo-repo", commit }, evidence: [{ id: "failure-one", source: "ci", status: "FAIL", summary: "The current implementation returns the wrong value", path: "src/value.js" }], changedFiles: ["src/value.js"], unknowns: [] };
}

function rawDiagnosisResult() {
  return { version: 1, taskId: "task:diagnose", hypotheses: [{ id: "hypothesis-one", statement: "The value branch returns the wrong result", evidenceIds: ["failure-one"], verification: [{ kind: "TEST", instruction: "Add a regression test for the observed value" }] }], unknowns: [], recommendedNextStep: { kind: "TEST", instruction: "Create an isolated regression test" } };
}

function rawCandidate() {
  return { version: 1, taskId: "task:reproduce", hypothesisId: "hypothesis-one", testPath: "test/regression.test.js", testContent: "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('reproduces wrong value', () => { assert.equal(1, 2); });\n" };
}
/** @param {string} commit */
function taskValue(commit) { const result = validateAgentTask(rawTask(commit)); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.task) throw new Error("invalid task fixture"); return result.task; }
function rolePolicyValue() { const result = validateAgentRolePolicy(rawRolePolicy()); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("invalid role fixture"); return result.policy; }
function policyValue() { const result = validateAgentReproductionPolicy(rawPolicy()); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("invalid policy fixture"); return result.policy; }
/** @param {string} commit */
function diagnosisInputValue(commit) { const result = validateAgentDiagnosisInput(rawDiagnosisInput(commit)); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.input) throw new Error("invalid diagnosis input fixture"); return result.input; }
/** @param {string} commit */
function diagnosisResultValue(commit) { const input = diagnosisInputValue(commit); const result = validateAgentDiagnosisResult(rawDiagnosisResult(), new Set(input.evidence.map((item) => item.id)), input.taskId); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.result) throw new Error("invalid diagnosis result fixture"); return result.result; }

/** @param {string} dbFile @param {any} task */
function runningLease(dbFile, task) {
  const db = openAgentTaskRegistry(dbFile);
  registerAgentTask(db, task, T0);
  transitionAgentTask(db, { taskId: task.id, fromState: "QUEUED", toState: "ROUTED", expectedRevision: 0, at: "2026-09-17T12:00:10Z" });
  const acquired = acquireAgentWorkerLease(db, { taskId: task.id, workerId: "worker-test", at: "2026-09-17T12:00:20Z", ttlSeconds: 600 });
  transitionAgentTask(db, { taskId: task.id, fromState: "ROUTED", toState: "RUNNING", expectedRevision: 1, at: "2026-09-17T12:00:30Z" });
  return { db, leaseId: acquired.lease.leaseId };
}

/** @param {any} request @param {string} content */
function modelResponse(request, content) { return { version: 1, backend: request.backend, model: request.model, content, finishReason: "stop", usage: { inputTokens: 100, outputTokens: 100 }, semantics: "synthetic normalized local model response" }; }
test("reproduction policy validates explicit repository test paths extensions and byte bound", () => {
  const result = validateAgentReproductionPolicy(rawPolicy());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  const unsafe = rawPolicy(); unsafe.testPathPatterns = ["../test/**"];
  assert.equal(validateAgentReproductionPolicy(unsafe).valid, false);
  const unsupported = rawPolicy(); unsupported.allowedExtensions = [".sh"];
  assert.equal(validateAgentReproductionPolicy(unsupported).valid, false);
});

test("run evidence is exact commit path hash outcome and trust metadata", () => {
  const evidence = { version: 1, taskId: "task:reproduce", repository: { id: "demo-repo", commit: "a".repeat(40) }, testPath: "test/regression.test.js", testSha256: "b".repeat(64), collectedAt: T2, runner: "sandbox-runner", outcome: "FAIL", exitCode: 1, trust: { source: "sandbox", authenticated: false } };
  assert.equal(validateAgentReproductionRunEvidence(evidence).valid, true);
  const inconsistent = structuredClone(evidence); inconsistent.exitCode = 0;
  assert.equal(validateAgentReproductionRunEvidence(inconsistent).valid, false);
  const unknown = { ...evidence, log: "raw output" };
  assert.equal(validateAgentReproductionRunEvidence(unknown).valid, false);
});

test("candidate requires task and policy path scope plus explicit non-skipped assertion", () => {
  const task = taskValue("a".repeat(40)), policy = policyValue();
  assert.equal(validateAgentReproductionCandidate(rawCandidate(), task, policy, "hypothesis-one").valid, true);
  const outside = rawCandidate(); outside.testPath = "src/regression.test.js";
  assert.equal(validateAgentReproductionCandidate(outside, task, policy, "hypothesis-one").valid, false);
});
test("candidate rejects skipped focused todo expected-failure and bypass constructs", () => {
  const task = taskValue("a".repeat(40)), policy = policyValue();
  for (const content of [
    "import test from 'node:test'; import assert from 'node:assert/strict'; test.skip('x',()=>assert.equal(1,2));",
    "import test from 'node:test'; import assert from 'node:assert/strict'; test.only('x',()=>assert.equal(1,2));",
    "import test from 'node:test'; import assert from 'node:assert/strict'; test.todo('x'); assert.equal(1,2);",
    "// @ts-nocheck\nimport test from 'node:test'; import assert from 'node:assert/strict'; test('x',()=>assert.equal(1,2));",
  ]) {
    const candidate = rawCandidate(); candidate.testContent = content;
    assert.equal(validateAgentReproductionCandidate(candidate, task, policy, "hypothesis-one").valid, false);
  }
});

test("Python candidates require test function assertion and reject skip or xfail", () => {
  const task = taskValue("a".repeat(40)); task.scope.allowedPaths = ["test/*.py"];
  const policy = { ...policyValue(), testPathPatterns: ["test/*.py"], allowedExtensions: [".py"] };
  const candidate = { version: 1, taskId: task.id, hypothesisId: "hypothesis-one", testPath: "test/test_regression.py", testContent: "def test_regression():\n    assert 1 == 2\n" };
  assert.equal(validateAgentReproductionCandidate(candidate, task, policy, "hypothesis-one").valid, true);
  const skipped = { ...candidate, testContent: "import pytest\n@pytest.mark.xfail\ndef test_regression():\n    assert 1 == 2\n" };
  assert.equal(validateAgentReproductionCandidate(skipped, task, policy, "hypothesis-one").valid, false);
});
test("worktree inspection requires clean linked worktree at exact task commit", () => {
  const fixture = repoFixture();
  try {
    const state = inspectAgentReproductionWorktree(fixture.worktree, fixture.commit);
    assert.equal(state.linkedWorktree, true); assert.equal(state.clean, true);
    assert.throws(() => inspectAgentReproductionWorktree(fixture.repo, fixture.commit), /linked Git worktree/);
    assert.throws(() => inspectAgentReproductionWorktree(fixture.worktree, "b".repeat(40)), /HEAD does not match/);
    fs.writeFileSync(path.join(fixture.worktree, "test", "dirty.txt"), "dirty\n");
    assert.throws(() => inspectAgentReproductionWorktree(fixture.worktree, fixture.commit), /must be clean/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("reproduction agent writes exactly one new test under active WRITE lease", async () => {
  const fixture = repoFixture(), dbFile = path.join(fixture.root, "control.sqlite"), task = taskValue(fixture.commit);
  const state = runningLease(dbFile, task);
  const invoke = async (/** @type {any} */ _config, /** @type {any} */ request) => modelResponse(request, JSON.stringify(rawCandidate()));
  try {
    const result = await runAgentReproduction(task, rolePolicyValue(), policyValue(), diagnosisInputValue(fixture.commit), diagnosisResultValue(fixture.commit), "hypothesis-one", state.db, state.leaseId, "worker-test", T1, fixture.worktree, {}, "local", "small", { invoke });
    assert.equal(result.status, "PENDING_VERIFICATION");
    assert.equal(result.failureObserved, false); assert.equal(result.executionAuthorized, false); assert.equal(result.mergeAuthorized, false);
    assert.equal(fs.readFileSync(path.join(fixture.worktree, "test", "regression.test.js"), "utf8"), rawCandidate().testContent);
    assert.equal(git(fixture.worktree, ["status", "--porcelain=v1", "--untracked-files=all"]), "?? test/regression.test.js");
  } finally { state.db.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
test("reproduction agent refuses wrong lease owner before invoking model", async () => {
  const fixture = repoFixture(), dbFile = path.join(fixture.root, "control.sqlite"), task = taskValue(fixture.commit);
  const state = runningLease(dbFile, task); let invoked = false;
  const invoke = async () => { invoked = true; throw new Error("unexpected model call"); };
  try {
    await assert.rejects(() => runAgentReproduction(task, rolePolicyValue(), policyValue(), diagnosisInputValue(fixture.commit), diagnosisResultValue(fixture.commit), "hypothesis-one", state.db, state.leaseId, "other-worker", T1, fixture.worktree, {}, "local", "small", { invoke }), /WRITE lease/);
    assert.equal(invoked, false);
  } finally { state.db.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("reproduction agent never overwrites an existing test target", async () => {
  const fixture = repoFixture(true), dbFile = path.join(fixture.root, "control.sqlite"), task = taskValue(fixture.commit);
  const state = runningLease(dbFile, task);
  const invoke = async (/** @type {any} */ _config, /** @type {any} */ request) => modelResponse(request, JSON.stringify(rawCandidate()));
  try {
    await assert.rejects(() => runAgentReproduction(task, rolePolicyValue(), policyValue(), diagnosisInputValue(fixture.commit), diagnosisResultValue(fixture.commit), "hypothesis-one", state.db, state.leaseId, "worker-test", T1, fixture.worktree, {}, "local", "small", { invoke }), /target already exists/);
    assert.equal(fs.readFileSync(path.join(fixture.worktree, "test", "regression.test.js"), "utf8"), "existing\n");
  } finally { state.db.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
test("run evidence reports only exact generated test hash and keeps causality unproven", async () => {
  const fixture = repoFixture(), dbFile = path.join(fixture.root, "control.sqlite"), task = taskValue(fixture.commit);
  const state = runningLease(dbFile, task);
  const invoke = async (/** @type {any} */ _config, /** @type {any} */ request) => modelResponse(request, JSON.stringify(rawCandidate()));
  try {
    const generated = await runAgentReproduction(task, rolePolicyValue(), policyValue(), diagnosisInputValue(fixture.commit), diagnosisResultValue(fixture.commit), "hypothesis-one", state.db, state.leaseId, "worker-test", T1, fixture.worktree, {}, "local", "small", { invoke });
    const evidence = { version: 1, taskId: task.id, repository: { id: task.repository.id, commit: task.repository.baseCommit }, testPath: generated.testPath, testSha256: generated.testSha256, collectedAt: T2, runner: "sandbox-runner", outcome: "FAIL", exitCode: 1, trust: { source: "sandbox", authenticated: false } };
    const report = verifyAgentReproductionRun(task, policyValue(), fixture.worktree, evidence);
    assert.equal(report.status, "FAILING_TEST_REPORTED"); assert.equal(report.failureReported, true); assert.equal(report.failureObserved, false); assert.equal(report.defectCauseEstablished, false);
    const passing = { ...evidence, outcome: "PASS", exitCode: 0 };
    assert.equal(verifyAgentReproductionRun(task, policyValue(), fixture.worktree, passing).status, "NOT_REPRODUCED");
    const wrongHash = { ...evidence, testSha256: "0".repeat(64) };
    assert.throws(() => verifyAgentReproductionRun(task, policyValue(), fixture.worktree, wrongHash), /exact task, commit, path, and test hash/);
  } finally { state.db.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
test("reproduction v1 rejects unnecessary shell or network authority", async () => {
  const fixture = repoFixture(), dbFile = path.join(fixture.root, "control.sqlite"), task = taskValue(fixture.commit);
  task.authority.shell = "BOUNDED";
  const state = runningLease(dbFile, task); let invoked = false;
  const invoke = async () => { invoked = true; throw new Error("unexpected model call"); };
  try {
    await assert.rejects(() => runAgentReproduction(task, rolePolicyValue(), policyValue(), diagnosisInputValue(fixture.commit), diagnosisResultValue(fixture.commit), "hypothesis-one", state.db, state.leaseId, "worker-test", T1, fixture.worktree, {}, "local", "small", { invoke }), /shell NONE and network NONE/);
    assert.equal(invoked, false);
  } finally { state.db.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("expired write lease blocks generation before model invocation", async () => {
  const fixture = repoFixture(), dbFile = path.join(fixture.root, "control.sqlite"), task = taskValue(fixture.commit);
  const state = runningLease(dbFile, task); let invoked = false;
  const invoke = async () => { invoked = true; throw new Error("unexpected model call"); };
  try {
    await assert.rejects(() => runAgentReproduction(task, rolePolicyValue(), policyValue(), diagnosisInputValue(fixture.commit), diagnosisResultValue(fixture.commit), "hypothesis-one", state.db, state.leaseId, "worker-test", "2026-09-17T12:20:00Z", fixture.worktree, {}, "local", "small", { invoke }), /WRITE lease/);
    assert.equal(invoked, false);
  } finally { state.db.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
test("verification re-applies task and reproduction path policy", async () => {
  const fixture = repoFixture(), dbFile = path.join(fixture.root, "control.sqlite"), task = taskValue(fixture.commit);
  const state = runningLease(dbFile, task);
  const invoke = async (/** @type {any} */ _config, /** @type {any} */ request) => modelResponse(request, JSON.stringify(rawCandidate()));
  try {
    const generated = await runAgentReproduction(task, rolePolicyValue(), policyValue(), diagnosisInputValue(fixture.commit), diagnosisResultValue(fixture.commit), "hypothesis-one", state.db, state.leaseId, "worker-test", T1, fixture.worktree, {}, "local", "small", { invoke });
    const outside = { version: 1, taskId: task.id, repository: { id: task.repository.id, commit: task.repository.baseCommit }, testPath: "src/not-allowed.test.js", testSha256: generated.testSha256, collectedAt: T2, runner: "sandbox-runner", outcome: "FAIL", exitCode: 1, trust: { source: "sandbox", authenticated: true } };
    assert.throws(() => verifyAgentReproductionRun(task, policyValue(), fixture.worktree, outside), /outside policy or task scope/);
  } finally { state.db.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("verify CLI accepts exact failing-test evidence and emits no raw test contents", async () => {
  const fixture = repoFixture(), dbFile = path.join(fixture.root, "control.sqlite"), task = taskValue(fixture.commit);
  const state = runningLease(dbFile, task);
  const invoke = async (/** @type {any} */ _config, /** @type {any} */ request) => modelResponse(request, JSON.stringify(rawCandidate()));
  try {
    const generated = await runAgentReproduction(task, rolePolicyValue(), policyValue(), diagnosisInputValue(fixture.commit), diagnosisResultValue(fixture.commit), "hypothesis-one", state.db, state.leaseId, "worker-test", T1, fixture.worktree, {}, "local", "small", { invoke });
    const evidence = { version: 1, taskId: task.id, repository: { id: task.repository.id, commit: task.repository.baseCommit }, testPath: generated.testPath, testSha256: generated.testSha256, collectedAt: T2, runner: "sandbox-runner", outcome: "FAIL", exitCode: 1, trust: { source: "sandbox", authenticated: false } };
    const taskFile = path.join(fixture.root, "task.json"), policyFile = path.join(fixture.root, "policy.json"), evidenceFile = path.join(fixture.root, "run.json");
    fs.writeFileSync(taskFile, JSON.stringify(rawTask(fixture.commit))); fs.writeFileSync(policyFile, JSON.stringify(rawPolicy())); fs.writeFileSync(evidenceFile, JSON.stringify(evidence));
    const originalLog = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
    try { assert.equal(await reproductionMain(["verify", "--task", taskFile, "--policy", policyFile, "--worktree", fixture.worktree, "--run-evidence", evidenceFile, "--json"]), 0); } finally { console.log = originalLog; }
    assert.equal(JSON.parse(stdout).status, "FAILING_TEST_REPORTED"); assert.doesNotMatch(stdout, /reproduces wrong value/);
  } finally { state.db.close(); fs.rmSync(fixture.root, { recursive: true, force: true }); }
});
test("reproduction source limits mutation to one new test and uses read-only Git inspection only", () => {
  const source = fs.readFileSync(new URL("../scripts/agent-reproduction.js", import.meta.url), "utf8");
  assert.match(source, /spawnSync\("git"/);
  assert.match(source, /writeFileSync\(target/);
  assert.match(source, /unlinkSync\(target/);
  assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\/|\bssh\b|\bdocker\b|\bkubectl\b|\bgh\b|shell\s*:\s*true|execFile|execSync|rmSync|renameSync|copyFileSync|appendFileSync/);
  assert.doesNotMatch(source, /process\.env\.(?!PATH\b)/);
});

test("reproduction CLI fails closed on incomplete or unknown modes", async () => {
  assert.equal(await reproductionMain(["generate"]), 1);
  assert.equal(await reproductionMain(["unknown"]), 1);
  assert.equal(await reproductionMain(["verify", "--unknown", "x"]), 1);
});
