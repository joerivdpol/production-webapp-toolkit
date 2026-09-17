#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import { globToRegExp } from "./analyze-changed-surface.js";
import { validateAgentTask } from "./agent-task.js";
import { validateAgentRolePolicy, inspectAgentTaskRolePolicy } from "./agent-role-policy.js";
import { openAgentTaskRegistry, getAgentTask } from "./agent-task-registry.js";
import { expireAgentWorkerLeases, getAgentWorkerLease } from "./agent-worker-lease.js";
import { readAgentModelConfigFile, validateAgentModelRequest, invokeAgentLocalModel } from "./agent-local-model.js";
import { validateAgentDiagnosisInput, validateAgentDiagnosisResult } from "./agent-diagnosis.js";
import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py"]);
const OUTCOMES = new Set(["PASS", "FAIL", "ERROR"]);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] @param {boolean} [singleLine] */
function text(value, max = 2048, singleLine = true) { if (typeof value !== "string") return null; const v = value.trim(); if (v.length === 0 || v.length > max || v.includes("\u0000")) return null; if (singleLine && /[\r\n]/.test(v)) return null; return v; }
/** @param {unknown} value */
function id(value) { const v = text(value, 128); return v && ID.test(v) ? v : null; }
/** @param {unknown} value */
function safePath(value) { const v = text(value, 512); if (!v || path.isAbsolute(v) || v.includes("\\")) return null; const normalized = path.posix.normalize(v); return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && normalized === v ? v : null; }
/** @param {unknown} value */
function safePattern(value) { const v = text(value, 512); if (!v || path.isAbsolute(v) || v.includes("\\") || v.split("/").includes("..")) return null; return v; }
/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null; }
/** @param {string} value */
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
/** @param {string} file @param {string[]} patterns */
function matches(file, patterns) { return patterns.some((pattern) => globToRegExp(pattern).test(file)); }
/** @param {unknown} value */
export function validateAgentReproductionPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "reproduction policy must be an object" }] };
  unknown(value, ["version", "repository", "testPathPatterns", "allowedExtensions", "maxTestBytes"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "reproduction policy version must be exactly 1" });
  const repository = id(value.repository); if (!repository) errors.push({ id: "repository-invalid", detail: "repository must be a portable identifier" });
  const patterns = [];
  if (!Array.isArray(value.testPathPatterns) || value.testPathPatterns.length === 0 || value.testPathPatterns.length > 64) errors.push({ id: "patterns-invalid", detail: "testPathPatterns must be a non-empty bounded array" });
  else {
    const seen = new Set();
    for (const raw of value.testPathPatterns) { const pattern = safePattern(raw); if (!pattern || seen.has(pattern)) errors.push({ id: "pattern-invalid", detail: "testPathPatterns contains unsafe or duplicate values" }); else { seen.add(pattern); patterns.push(pattern); } }
  }
  const extensions = [];
  if (!Array.isArray(value.allowedExtensions) || value.allowedExtensions.length === 0 || value.allowedExtensions.length > EXTENSIONS.size) errors.push({ id: "extensions-invalid", detail: "allowedExtensions must be a non-empty bounded array" });
  else {
    const seen = new Set();
    for (const raw of value.allowedExtensions) { const extension = text(raw, 8); if (!extension || !EXTENSIONS.has(extension) || seen.has(extension)) errors.push({ id: "extension-invalid", detail: "allowedExtensions contains unsupported or duplicate values" }); else { seen.add(extension); extensions.push(extension); } }
  }
  const maxTestBytes = integer(value.maxTestBytes, 128, 256 * 1024); if (!maxTestBytes) errors.push({ id: "max-test-bytes-invalid", detail: "maxTestBytes must be a bounded positive integer" });
  if (errors.length > 0 || !repository || !maxTestBytes) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, repository, testPathPatterns: patterns.sort(), allowedExtensions: extensions.sort(), maxTestBytes }, errors: [] };
}
/** @param {unknown} value */
export function validateAgentReproductionRunEvidence(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, evidence: null, errors: [{ id: "run-evidence-invalid", detail: "reproduction run evidence must be an object" }] };
  unknown(value, ["version", "taskId", "repository", "testPath", "testSha256", "collectedAt", "runner", "outcome", "exitCode", "trust"], "run-evidence", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "run evidence version must be exactly 1" });
  const taskId = id(value.taskId), testPath = safePath(value.testPath), testSha256 = text(value.testSha256, 64)?.toLowerCase() ?? null;
  if (!taskId || !testPath || !testSha256 || !HASH.test(testSha256)) errors.push({ id: "run-binding-invalid", detail: "run evidence task, path, or SHA256 is invalid" });
  let repository = null;
  if (!object(value.repository)) errors.push({ id: "repository-invalid", detail: "run evidence repository must be an object" });
  else {
    unknown(value.repository, ["id", "commit"], "repository", errors);
    const repositoryId = id(value.repository.id), commit = text(value.repository.commit, 128)?.toLowerCase() ?? null;
    if (!repositoryId || !commit || !isFullObjectId(commit)) errors.push({ id: "repository-fields-invalid", detail: "run evidence repository binding is invalid" }); else repository = { id: repositoryId, commit };
  }
  const collectedAt = text(value.collectedAt, 128); if (!collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) errors.push({ id: "collected-at-invalid", detail: "collectedAt must be an absolute ISO timestamp" });
  const runner = id(value.runner); if (!runner) errors.push({ id: "runner-invalid", detail: "runner must be a portable symbolic id" });
  const outcome = text(value.outcome, 32); if (!outcome || !OUTCOMES.has(outcome)) errors.push({ id: "outcome-invalid", detail: "outcome must be PASS, FAIL, or ERROR" });
  const exitCode = integer(value.exitCode, 0, 255); if (exitCode === null) errors.push({ id: "exit-code-invalid", detail: "exitCode must be an integer from 0 to 255" });
  if (outcome === "PASS" && exitCode !== 0) errors.push({ id: "outcome-exit-inconsistent", detail: "PASS requires exitCode 0" });
  if ((outcome === "FAIL" || outcome === "ERROR") && exitCode === 0) errors.push({ id: "outcome-exit-inconsistent", detail: "FAIL and ERROR require non-zero exitCode" });
  let trust = null;
  if (!object(value.trust)) errors.push({ id: "trust-invalid", detail: "trust must be an object" });
  else {
    unknown(value.trust, ["source", "authenticated"], "trust", errors);
    const source = id(value.trust.source), authenticated = value.trust.authenticated;
    if (!source || typeof authenticated !== "boolean") errors.push({ id: "trust-fields-invalid", detail: "trust requires source and boolean authenticated" });
    else trust = { source, authenticated };
  }
  if (errors.length > 0 || !taskId || !repository || !testPath || !testSha256 || !collectedAt || !runner || !outcome || exitCode === null || !trust) return { valid: false, evidence: null, errors };
  return { valid: true, evidence: { version: 1, taskId, repository, testPath, testSha256, collectedAt, runner, outcome, exitCode, trust }, errors: [] };
}

/** @param {string} filename */
function readJsonFile(filename) {
  const resolved = path.resolve(filename); let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error("reproduction input file is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_INPUT_BYTES) throw new Error("reproduction input must be a bounded regular non-symlink file");
  try { return JSON.parse(fs.readFileSync(resolved, "utf8")); } catch { throw new Error("reproduction input cannot be parsed"); }
}

/** @param {string} root @param {string[]} args */
function git(root, args) { const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 10000, env: { PATH: process.env.PATH ?? "" } }); if (result.status !== 0) throw new Error("read-only Git worktree inspection failed"); return result.stdout; }
/** @param {string} root @param {string} expectedCommit @param {boolean} [requireClean] */
export function inspectAgentReproductionWorktree(root, expectedCommit, requireClean = true) {
  const resolved = path.resolve(root); let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error("reproduction worktree is unavailable"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("reproduction worktree must be a regular non-symlink directory");
  if (fs.realpathSync(resolved) !== resolved) throw new Error("reproduction worktree path must not traverse symlinks");
  const dotGit = path.join(resolved, ".git"); let gitStat;
  try { gitStat = fs.lstatSync(dotGit); } catch { throw new Error("reproduction root is not a linked Git worktree"); }
  if (!gitStat.isFile() || gitStat.isSymbolicLink()) throw new Error("reproduction root must be a linked Git worktree, not the primary checkout");
  const top = git(resolved, ["rev-parse", "--show-toplevel"]).trim();
  if (path.resolve(top) !== resolved) throw new Error("reproduction worktree top-level does not match supplied root");
  const head = git(resolved, ["rev-parse", "HEAD"]).trim().toLowerCase();
  if (!isFullObjectId(head) || head !== expectedCommit) throw new Error("reproduction worktree HEAD does not match task baseCommit");
  const status = git(resolved, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (requireClean && status !== "") throw new Error("reproduction worktree must be clean before creating a test");
  return { root: resolved, head, clean: status === "", linkedWorktree: true };
}

/** @param {any} expression @returns {string|null} */
function calleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) { const parent = calleeName(expression.expression); return parent ? `${parent}.${expression.name.text}` : null; }
  return null;
}
/** @param {string} filename @param {string} source */
function inspectJavaScriptTestContent(filename, source) {
  const extension = path.posix.extname(filename).toLowerCase();
  const kind = extension === ".tsx" ? ts.ScriptKind.TSX : extension === ".jsx" ? ts.ScriptKind.JSX : extension === ".js" || extension === ".mjs" || extension === ".cjs" ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, kind);
  const parseDiagnostics = /** @type {any} */ (file).parseDiagnostics;
  if (Array.isArray(parseDiagnostics) && parseDiagnostics.length > 0) throw new Error("generated JavaScript/TypeScript test is syntactically invalid");
  let testCall = false, assertionCall = false;
  const forbiddenSuffixes = [".skip", ".only", ".todo", ".fixme", ".fail"];
  /** @param {ts.Node} node */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name) {
        if (["skip", "todo", "xfail"].includes(name) || forbiddenSuffixes.some((suffix) => name.endsWith(suffix))) throw new Error("generated test contains a disabled, focused, or expected-failure test construct");
        if (["test", "it"].includes(name) || name.endsWith(".test") || name.endsWith(".it")) testCall = true;
        if (name === "expect" || name === "assert" || name.startsWith("assert.") || name.includes(".assert")) assertionCall = true;
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  if (!testCall) throw new Error("generated test must contain an explicit test or it call");
  if (!assertionCall) throw new Error("generated test must contain an explicit assertion call");
}

/** @param {string} source */
function inspectPythonTestContent(source) {
  if (!/(^|\n)\s*(?:async\s+)?def\s+test_[A-Za-z0-9_]+\s*\(/.test(source)) throw new Error("generated Python test must declare a test_ function");
  if (!/(^|\n)\s*assert\s+/.test(source)) throw new Error("generated Python test must contain an explicit assert statement");
  if (/pytest\.mark\.(?:skip|xfail)|pytest\.skip\s*\(|unittest\.skip|skipTest\s*\(|@\s*(?:pytest\.)?mark\.(?:skip|xfail)/i.test(source)) throw new Error("generated Python test contains a skipped or expected-failure construct");
}
/** @param {string} filename @param {string} source */
function inspectGeneratedTestContent(filename, source) {
  if (/eslint-disable|@ts-ignore|@ts-nocheck|istanbul\s+ignore|c8\s+ignore|pragma:\s*no\s+cover/i.test(source)) throw new Error("generated test contains a coverage, lint, or type-check bypass");
  const extension = path.posix.extname(filename).toLowerCase();
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(extension)) inspectJavaScriptTestContent(filename, source);
  else if (extension === ".py") inspectPythonTestContent(source);
  else throw new Error("generated test extension is unsupported");
}

/** @param {unknown} value @param {any} task @param {any} policy @param {string} hypothesisId */
export function validateAgentReproductionCandidate(value, task, policy, hypothesisId) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, candidate: null, errors: [{ id: "candidate-invalid", detail: "reproduction candidate must be an object" }] };
  unknown(value, ["version", "taskId", "hypothesisId", "testPath", "testContent"], "candidate", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "reproduction candidate version must be exactly 1" });
  if (value.taskId !== task.id) errors.push({ id: "task-binding-invalid", detail: "candidate taskId must equal the reproduction task" });
  if (value.hypothesisId !== hypothesisId) errors.push({ id: "hypothesis-binding-invalid", detail: "candidate hypothesisId must equal the selected diagnosis hypothesis" });
  const testPath = safePath(value.testPath); if (!testPath) errors.push({ id: "test-path-invalid", detail: "testPath must be a safe repository-relative path" });
  const testContent = typeof value.testContent === "string" ? value.testContent : null;
  if (!testContent || testContent.includes("\u0000") || Buffer.byteLength(testContent, "utf8") > policy.maxTestBytes) errors.push({ id: "test-content-invalid", detail: "testContent must be non-empty and within the configured byte bound" });
  if (testPath) {
    const extension = path.posix.extname(testPath).toLowerCase();
    if (!policy.allowedExtensions.includes(extension)) errors.push({ id: "test-extension-denied", detail: "testPath extension is not allowed by reproduction policy" });
    if (!matches(testPath, policy.testPathPatterns)) errors.push({ id: "test-policy-path-denied", detail: "testPath is outside reproduction policy test patterns" });
    if (!matches(testPath, task.scope.allowedPaths) || matches(testPath, task.scope.deniedPaths)) errors.push({ id: "test-task-scope-denied", detail: "testPath is outside Agent Task path scope" });
  }
  if (testPath && testContent) {
    try { inspectGeneratedTestContent(testPath, testContent); }
    catch (error) { errors.push({ id: "test-content-safety-invalid", detail: error instanceof Error ? error.message : "generated test content is unsafe" }); }
  }
  if (errors.length > 0 || !testPath || !testContent) return { valid: false, candidate: null, errors };
  return { valid: true, candidate: { version: 1, taskId: task.id, hypothesisId, testPath, testContent }, errors: [] };
}

/** @param {string} root @param {string} relativePath */
function resolveNewTestPath(root, relativePath) {
  const target = path.resolve(root, ...relativePath.split("/"));
  if (target !== path.join(root, relativePath) || !target.startsWith(`${root}${path.sep}`)) throw new Error("generated test path escapes reproduction worktree");
  const parent = path.dirname(target); let parentStat;
  try { parentStat = fs.lstatSync(parent); } catch { throw new Error("generated test parent directory must already exist"); }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || fs.realpathSync(parent) !== parent) throw new Error("generated test parent must be a regular non-symlink directory");
  try {
    fs.lstatSync(target);
    throw new Error("generated test target already exists");
  } catch (error) {
    if (error instanceof Error && error.message === "generated test target already exists") throw error;
    if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw new Error("generated test target cannot be safely inspected");
  }
  return target;
}

/** @param {any} task @param {any} rolePolicy @param {import("node:sqlite").DatabaseSync} db @param {string} leaseId @param {string} workerId @param {string} evaluatedAt */
function requireActiveWriteLease(task, rolePolicy, db, leaseId, workerId, evaluatedAt) {
  const roleAudit = inspectAgentTaskRolePolicy(task, rolePolicy);
  if (roleAudit.overallStatus !== "PASS" || !roleAudit.leaseRequired) throw new Error("reproduction task is not authorized for leased worktree writes");
  expireAgentWorkerLeases(db, evaluatedAt);
  const lease = getAgentWorkerLease(db, leaseId), registered = getAgentTask(db, task.id);
  if (!lease || !registered) throw new Error("reproduction task or lease is not registered");
  if (JSON.stringify(registered.task) !== JSON.stringify(task) || registered.state !== "RUNNING") throw new Error("registered reproduction task must match input exactly and be RUNNING");
  if (lease.releasedAt !== null || lease.mode !== "WRITE" || lease.taskId !== task.id || lease.workerId !== workerId || lease.repositoryId !== task.repository.id) throw new Error("active WRITE lease does not match reproduction task, worker, and repository");
  if (Date.parse(lease.expiresAt) <= Date.parse(evaluatedAt)) throw new Error("reproduction WRITE lease is expired");
  return { roleAudit, lease };
}
/** @param {any} task @param {any} policy @param {any} diagnosisInput @param {any} hypothesis */
function buildPrompt(task, policy, diagnosisInput, hypothesis) {
  const evidenceById = new Map(diagnosisInput.evidence.map((/** @type {any} */ item) => [item.id, item]));
  const evidence = hypothesis.evidenceIds.map((/** @type {string} */ evidenceId) => evidenceById.get(evidenceId)).filter(Boolean);
  const payload = { task: { id: task.id, objective: task.objective, repository: task.repository }, hypothesis, evidence, testPolicy: { testPathPatterns: policy.testPathPatterns, allowedExtensions: policy.allowedExtensions, maxTestBytes: policy.maxTestBytes } };
  const system = [
    "You are a software reproduction-test author operating only inside a leased linked Git worktree.",
    "Return one JSON object only and create exactly one new regression test candidate.",
    "Do not modify, delete, rename, weaken, skip, focus, xfail, todo, or disable any existing or generated test.",
    "Do not include lint/type/coverage bypasses. Do not propose production, network, credential, deployment, migration, payment, or booking actions.",
    "The test must exercise the selected diagnosis hypothesis and include an explicit assertion.",
    "Schema: {version:1,taskId:string,hypothesisId:string,testPath:string,testContent:string}",
  ].join(" ");
  return { system, user: JSON.stringify(payload) };
}

/** @param {any|null} runEvidence @param {any} task @param {any} candidate @param {string} testSha256 */
function evaluateRunEvidence(runEvidence, task, candidate, testSha256) {
  if (!runEvidence) return { status: "PENDING_VERIFICATION", runEvidence: null, failureReported: false, failureObserved: false };
  if (runEvidence.taskId !== task.id || runEvidence.repository.id !== task.repository.id || runEvidence.repository.commit !== task.repository.baseCommit || runEvidence.testPath !== candidate.testPath || runEvidence.testSha256 !== testSha256) throw new Error("reproduction run evidence is not bound to the exact task, commit, path, and test hash");
  if (runEvidence.outcome === "FAIL") return { status: "FAILING_TEST_REPORTED", runEvidence, failureReported: true, failureObserved: false };
  if (runEvidence.outcome === "PASS") return { status: "NOT_REPRODUCED", runEvidence, failureReported: false, failureObserved: false };
  return { status: "UNVERIFIED", runEvidence, failureReported: false, failureObserved: false };
}

/** @param {string} root @param {string} testPath */
function requireOnlyNewTestChange(root, testPath) {
  const status = git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const records = status.split("\0").filter(Boolean);
  if (records.length !== 1 || records[0] !== `?? ${testPath}`) throw new Error("reproduction worktree changed outside the single generated test file");
}
/** @param {any} task @param {any} rolePolicy @param {any} policy @param {any} diagnosisInput @param {any} diagnosisResult @param {string} hypothesisId @param {import("node:sqlite").DatabaseSync} db @param {string} leaseId @param {string} workerId @param {string} evaluatedAt @param {string} worktree @param {any} modelConfig @param {string} backend @param {string} model @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function runAgentReproduction(task, rolePolicy, policy, diagnosisInput, diagnosisResult, hypothesisId, db, leaseId, workerId, evaluatedAt, worktree, modelConfig, backend, model, deps = {}) {
  if (task.role !== "reproduce") throw new Error("Agent Reproduction v1 requires task role reproduce");
  if (task.authority.filesystem !== "WORKTREE_WRITE" || task.authority.shell !== "NONE" || task.authority.network !== "NONE") throw new Error("Agent Reproduction v1 requires WORKTREE_WRITE with shell NONE and network NONE");
  if (!isAbsoluteIsoTimestamp(evaluatedAt)) throw new Error("reproduction evaluatedAt must be an absolute ISO timestamp");
  if (policy.repository !== task.repository.id) throw new Error("reproduction policy repository does not match task repository");
  if (task.repository.id !== diagnosisInput.repository.id || task.repository.baseCommit !== diagnosisInput.repository.commit) throw new Error("diagnosis input does not match reproduction task repository identity");
  if (diagnosisResult.taskId !== diagnosisInput.taskId) throw new Error("diagnosis result is not bound to the supplied diagnosis input");
  if (!task.dependsOn.includes(diagnosisResult.taskId)) throw new Error("reproduction task must explicitly depend on the diagnosis task");
  const hypothesis = diagnosisResult.hypotheses.find((/** @type {any} */ item) => item.id === hypothesisId);
  if (!hypothesis) throw new Error("selected diagnosis hypothesis does not exist");
  const diagnosisEvidenceIds = new Set(diagnosisInput.evidence.map((/** @type {any} */ item) => item.id));
  if (hypothesis.evidenceIds.some((/** @type {string} */ evidenceId) => !diagnosisEvidenceIds.has(evidenceId))) throw new Error("selected diagnosis hypothesis references evidence outside the supplied diagnosis input");
  const authorization = requireActiveWriteLease(task, rolePolicy, db, leaseId, workerId, evaluatedAt);
  const worktreeState = inspectAgentReproductionWorktree(worktree, task.repository.baseCommit);
  const prompt = buildPrompt(task, policy, diagnosisInput, hypothesis);
  const rawRequest = { version: 1, backend, model, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], temperature: 0, maxOutputTokens: 4096, timeoutMs: 60000 };
  const request = validateAgentModelRequest(rawRequest); if (!request.valid || !request.request) throw new Error("reproduction model request is invalid");
  const invoke = deps.invoke ?? invokeAgentLocalModel;
  const response = await invoke(modelConfig, request.request);
  let rawCandidate; try { rawCandidate = JSON.parse(response.content); } catch { throw new Error("reproduction model returned non-JSON output"); }
  const candidateResult = validateAgentReproductionCandidate(rawCandidate, task, policy, hypothesisId);
  if (!candidateResult.valid || !candidateResult.candidate) throw new Error("reproduction model output failed Reproduction Candidate v1 validation");
  const candidate = candidateResult.candidate;
  const target = resolveNewTestPath(worktreeState.root, candidate.testPath);
  let written = false;
  try {
    fs.writeFileSync(target, candidate.testContent, { encoding: "utf8", flag: "wx", mode: 0o600 }); written = true;
    requireOnlyNewTestChange(worktreeState.root, candidate.testPath);
  } catch (error) { if (written) { try { fs.unlinkSync(target); } catch { /* preserve original error */ } } throw error; }
  const testSha256 = sha256(candidate.testContent);
  return {
    version: 1,
    taskId: task.id,
    diagnosisTaskId: diagnosisResult.taskId,
    hypothesisId,
    repository: task.repository,
    testPath: candidate.testPath,
    testSha256,
    status: "PENDING_VERIFICATION",
    failureObserved: false,
    executionAuthorized: false,
    mergeAuthorized: false,
    deployAuthorized: false,
    productionMutationAuthorized: false,
    lease: { leaseId: authorization.lease.leaseId, workerId: authorization.lease.workerId, mode: authorization.lease.mode, expiresAt: authorization.lease.expiresAt },
    model: { backend: response.backend, model: response.model },
    semantics: "one new regression-test file was generated in a clean linked worktree; no test execution occurred and failure is not established until separate run evidence is verified",
  };
}

/** @param {any} task @param {any} policy @param {string} worktree @param {unknown} rawEvidence */
export function verifyAgentReproductionRun(task, policy, worktree, rawEvidence) {
  if (task.role !== "reproduce" || task.authority.filesystem !== "WORKTREE_WRITE") throw new Error("run verification requires a reproduce WORKTREE_WRITE task");
  const validated = validateAgentReproductionRunEvidence(rawEvidence);
  if (!validated.valid || !validated.evidence) throw new Error("reproduction run evidence is invalid");
  const evidence = validated.evidence;
  if (policy.repository !== task.repository.id) throw new Error("reproduction policy repository does not match task repository");
  const extension = path.posix.extname(evidence.testPath).toLowerCase();
  if (!policy.allowedExtensions.includes(extension) || !matches(evidence.testPath, policy.testPathPatterns) || !matches(evidence.testPath, task.scope.allowedPaths) || matches(evidence.testPath, task.scope.deniedPaths)) throw new Error("reproduction run evidence test path is outside policy or task scope");
  const state = inspectAgentReproductionWorktree(worktree, task.repository.baseCommit, false);
  requireOnlyNewTestChange(state.root, evidence.testPath);
  const target = path.join(state.root, evidence.testPath); let stat;
  try { stat = fs.lstatSync(target); } catch { throw new Error("generated reproduction test is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > policy.maxTestBytes) throw new Error("generated reproduction test is not a bounded regular file");
  const content = fs.readFileSync(target, "utf8");
  inspectGeneratedTestContent(evidence.testPath, content);
  const currentHash = sha256(content);
  const result = evaluateRunEvidence(evidence, task, { testPath: evidence.testPath }, currentHash);
  return { version: 1, taskId: task.id, repository: task.repository, testPath: evidence.testPath, testSha256: currentHash, ...result, executionAuthorized: false, mergeAuthorized: false, deployAuthorized: false, productionMutationAuthorized: false, defectCauseEstablished: false, semantics: "caller-supplied run evidence reports the outcome of the exact generated test on the bound commit; this verifier does not independently execute the test or prove the diagnosed hypothesis is the root cause" };
}

/** @param {string[]} argv */
function parse(argv) {
  const command = argv[0];
  if (!command || !["generate", "verify"].includes(command)) return null;
  const values = new Map(), flags = new Set();
  const allowed = new Set(["--task", "--role-policy", "--policy", "--registry", "--lease-id", "--worker-id", "--evaluated-at", "--worktree", "--diagnosis-input", "--diagnosis-result", "--hypothesis-id", "--model-config", "--backend", "--model", "--run-evidence"]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { if (flags.has(argument)) return null; flags.add(argument); continue; }
    if (!allowed.has(argument ?? "") || values.has(argument)) return null;
    const next = argv[index + 1];
    if (typeof next !== "string" || next.startsWith("--")) return null;
    values.set(argument, next); index += 1;
  }
  const requiredGenerate = ["--task", "--role-policy", "--policy", "--registry", "--lease-id", "--worker-id", "--evaluated-at", "--worktree", "--diagnosis-input", "--diagnosis-result", "--hypothesis-id", "--model-config", "--backend", "--model"];
  const requiredVerify = ["--task", "--policy", "--worktree", "--run-evidence"];
  const required = command === "generate" ? requiredGenerate : requiredVerify;
  if (required.some((key) => !values.has(key))) return null;
  if (command === "verify" && [...values.keys()].some((key) => !requiredVerify.includes(key))) return null;
  return { command, values, json: flags.has("--json") };
}
/** @param {string[]} argv @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parse(argv);
  if (!options) {
    console.error("Usage: node scripts/agent-reproduction.js generate --task <task.json> --role-policy <roles.json> --policy <reproduction-policy.json> --registry <registry.sqlite> --lease-id <id> --worker-id <id> --evaluated-at <ISO> --worktree <path> --diagnosis-input <input.json> --diagnosis-result <result.json> --hypothesis-id <id> --model-config <models.json> --backend <id> --model <id> [--json] | verify --task <task.json> --policy <reproduction-policy.json> --worktree <path> --run-evidence <evidence.json> [--json]");
    return 1;
  }
  try {
    const taskRaw = readJsonFile(options.values.get("--task"));
    const taskResult = validateAgentTask(taskRaw);
    if (!taskResult.valid || !taskResult.task) throw new Error("reproduction Agent Task v1 input is invalid");
    const task = taskResult.task;
    if (options.command === "verify") {
      const rawEvidence = readJsonFile(options.values.get("--run-evidence"));
      const policyRaw = readJsonFile(options.values.get("--policy"));
      const policyResult = validateAgentReproductionPolicy(policyRaw);
      if (!policyResult.valid || !policyResult.policy) throw new Error("reproduction policy input is invalid");
      const report = verifyAgentReproductionRun(task, policyResult.policy, options.values.get("--worktree"), rawEvidence);
      console.log(options.json ? JSON.stringify(report) : JSON.stringify(report, null, 2));
      return report.status === "FAILING_TEST_REPORTED" ? 0 : 1;
    }
    const roleRaw = readJsonFile(options.values.get("--role-policy"));
    const policyRaw = readJsonFile(options.values.get("--policy"));
    const diagnosisInputRaw = readJsonFile(options.values.get("--diagnosis-input"));
    const diagnosisResultRaw = readJsonFile(options.values.get("--diagnosis-result"));
    const roleResult = validateAgentRolePolicy(roleRaw), policyResult = validateAgentReproductionPolicy(policyRaw), diagnosisInputResult = validateAgentDiagnosisInput(diagnosisInputRaw);
    if (!roleResult.valid || !roleResult.policy || !policyResult.valid || !policyResult.policy || !diagnosisInputResult.valid || !diagnosisInputResult.input) throw new Error("reproduction role, policy, or diagnosis input is invalid");
    const evidenceIds = new Set(diagnosisInputResult.input.evidence.map((/** @type {any} */ item) => item.id));
    const diagnosisResult = validateAgentDiagnosisResult(diagnosisResultRaw, evidenceIds, diagnosisInputResult.input.taskId);
    if (!diagnosisResult.valid || !diagnosisResult.result) throw new Error("diagnosis result input is invalid");
    const modelConfig = readAgentModelConfigFile(options.values.get("--model-config"));
    const db = openAgentTaskRegistry(options.values.get("--registry"));
    try {
      const result = await runAgentReproduction(task, roleResult.policy, policyResult.policy, diagnosisInputResult.input, diagnosisResult.result, options.values.get("--hypothesis-id"), db, options.values.get("--lease-id"), options.values.get("--worker-id"), options.values.get("--evaluated-at"), options.values.get("--worktree"), modelConfig, options.values.get("--backend"), options.values.get("--model"), deps);
      console.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
      return 0;
    } finally { db.close(); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "agent reproduction failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = await main();
