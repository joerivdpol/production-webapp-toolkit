import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateAgentTask } from "../scripts/agent-task.js";
import { validateAgentRolePolicy } from "../scripts/agent-role-policy.js";
import { validateAgentModelConfig } from "../scripts/agent-local-model.js";
import {
  incidentEvidenceIds,
  main,
  runAgentIncidentAnalysis,
  validateAgentIncidentInput,
  validateAgentIncidentResult,
} from "../scripts/agent-incident-analysis.js";

const COMMIT = "a".repeat(40);
const T0 = "2026-09-18T06:00:00Z";
const DEPLOYED = "2026-09-18T06:05:00Z";
const COLLECTED = "2026-09-18T06:10:00Z";
const EVALUATED = "2026-09-18T06:15:00Z";

/** @returns {any} */
function rawTask() {
  return {
    version: 1, id: "task:incident:fixture", role: "incident",
    repository: { id: "example-webapp", baseCommit: COMMIT },
    createdAt: T0, risk: "HIGH", objective: "Investigate the bounded production incident evidence",
    authority: { filesystem: "READ_ONLY", shell: "BOUNDED", network: "NONE", merge: false, deploy: false, productionMutation: false },
    scope: { allowedPaths: ["src/**", "test/**"], deniedPaths: [".env"], requiredChecks: ["runtime-health"] },
    dependsOn: [],
  };
}
/** @returns {any} */
function rawRolePolicy() {
  return JSON.parse(fs.readFileSync(new URL("../templates/agent-role-policy.v1.json", import.meta.url), "utf8"));
}
/** @returns {any} */
function rawModelConfig() {
  return { version: 1, backends: [{ id: "worker-local", type: "OLLAMA", baseUrl: "http://127.0.0.1:18080", models: [{ id: "small-local", providerModel: "synthetic-private-model", thinking: "DISABLED" }] }] };
}
/** @returns {any} */
function runtimeEvidence() {
  return {
    version: 1,
    runtime: { name: "web", environment: "production" },
    deployment: { commit: COMMIT },
    evidence: { source: "runtime-collector", authenticated: false, collectedAt: COLLECTED },
  };
}
/** @returns {any} */
function healthEvidence() {
  return {
    version: 1,
    runtime: { name: "web", environment: "production" },
    evidence: { source: "health-collector", authenticated: false, collectedAt: COLLECTED },
    checks: [
      { id: "database", category: "database", status: "DEGRADED", latencyMs: 420 },
      { id: "http", category: "http", status: "HEALTHY", latencyMs: 55 },
    ],
  };
}
/** @returns {any} */
function rawInput() {
  return {
    version: 1,
    taskId: "task:incident:fixture",
    repository: { id: "example-webapp", commit: COMMIT },
    evaluatedAt: EVALUATED,
    release: { id: "release:2026-09-18", commit: COMMIT, deployedAt: DEPLOYED, artifactSha256: "b".repeat(64) },
    runtimeEvidence: runtimeEvidence(),
    runtimeHealthEvidence: healthEvidence(),
    errors: [
      { id: "database-timeout", source: "runtime-errors", observedAt: COLLECTED, count: 12, summary: "Database requests exceeded the configured timeout", path: "src/database.js" },
    ],
    metrics: [
      { id: "db-latency", source: "runtime-metrics", observedAt: COLLECTED, name: "database_latency_ms", value: 420, unit: "ms", status: "WARN" },
    ],
    unknowns: ["Whether the latency increase began before the release"],
  };
}
/** @returns {any} */
function rawResult() {
  return {
    version: 1,
    taskId: "task:incident:fixture",
    hypotheses: [{
      id: "hypothesis-database-latency",
      statement: "The incident may involve elevated database latency after the evaluated release.",
      evidenceIds: ["error:database-timeout", "health:database", "metric:db-latency", "release"],
      verification: [
        { kind: "INSPECT", instruction: "Inspect the release diff affecting database access at the evaluated commit." },
        { kind: "QUERY", instruction: "Query the bounded database latency evidence around the incident window." },
      ],
    }],
    unknowns: ["The available evidence does not establish whether an upstream dependency caused the latency."],
    recommendedNextStep: { kind: "INSPECT", instruction: "Inspect release-scoped database changes before proposing any operational action." },
  };
}
function task(raw = rawTask()) { const r = validateAgentTask(raw); assert.equal(r.valid, true, JSON.stringify(r.errors)); if (!r.valid || !r.task) throw new Error("task fixture invalid"); return r.task; }
function input(raw = rawInput()) { const r = validateAgentIncidentInput(raw); assert.equal(r.valid, true, JSON.stringify(r.errors)); if (!r.valid || !r.input) throw new Error("input fixture invalid"); return r.input; }
function rolePolicy(raw = rawRolePolicy()) { const r = validateAgentRolePolicy(raw); assert.equal(r.valid, true, JSON.stringify(r.errors)); if (!r.valid || !r.policy) throw new Error("role policy fixture invalid"); return r.policy; }
function modelConfig(raw = rawModelConfig()) { const r = validateAgentModelConfig(raw); assert.equal(r.valid, true, JSON.stringify(r.errors)); if (!r.valid || !r.config) throw new Error("model config fixture invalid"); return r.config; }
/** @param {any} request @param {string} content */
function modelResponse(request, content) {
  return { version: 1, backend: request.backend, model: request.model, content, finishReason: "stop", usage: { inputTokens: 10, outputTokens: 5 }, semantics: "synthetic local model" };
}
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; }
test("incident input composes canonical runtime and health evidence", () => {
  const result = validateAgentIncidentInput(rawInput());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.input?.runtimeEvidence.deployment.commit, COMMIT);
  assert.equal(result.input?.runtimeHealthEvidence.runtime.name, "web");
  assert.deepEqual([...incidentEvidenceIds(result.input)].sort(), ["error:database-timeout", "health:database", "health:http", "metric:db-latency", "release", "runtime-deployment"]);
});

test("incident input requires exact repository release and runtime commit binding", () => {
  const release = rawInput(); release.release.commit = "c".repeat(40);
  assert.equal(validateAgentIncidentInput(release).valid, false);
  const runtime = rawInput(); runtime.runtimeEvidence.deployment.commit = "d".repeat(40);
  assert.equal(validateAgentIncidentInput(runtime).valid, false);
});

test("runtime health identity must equal runtime deployment identity", () => {
  const raw = rawInput(); raw.runtimeHealthEvidence.runtime.name = "worker";
  const result = validateAgentIncidentInput(raw);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((item) => item.id === "runtime-identity-invalid"), true);
});

test("future runtime errors metrics and evidence fail closed", () => {
  const error = rawInput(); error.errors[0].observedAt = "2026-09-18T06:20:00Z";
  assert.equal(validateAgentIncidentInput(error).valid, false);
  const metric = rawInput(); metric.metrics[0].observedAt = "2026-09-18T06:20:00Z";
  assert.equal(validateAgentIncidentInput(metric).valid, false);
  const runtime = rawInput(); runtime.runtimeEvidence.evidence.collectedAt = "2026-09-18T06:20:00Z";
  assert.equal(validateAgentIncidentInput(runtime).valid, false);
});
test("incident input rejects secret-like summaries and unsafe paths", () => {
  const secret = rawInput(); secret.errors[0].summary = "Bearer abcdefghijklmnopqrstuvwxyz012345";
  assert.equal(validateAgentIncidentInput(secret).valid, false);
  const traversal = rawInput(); traversal.errors[0].path = "../private.env";
  assert.equal(validateAgentIncidentInput(traversal).valid, false);
});

test("result hypotheses must cite only supplied incident evidence ids", () => {
  const allowed = incidentEvidenceIds(input());
  assert.equal(validateAgentIncidentResult(rawResult(), allowed, rawTask().id).valid, true);
  const invented = rawResult(); invented.hypotheses[0].evidenceIds.push("metric:invented");
  const result = validateAgentIncidentResult(invented, allowed, rawTask().id);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((item) => item.id === "hypothesis-evidence-reference-invalid"), true);
});

test("incident result exposes no operational recovery authority", () => {
  const result = validateAgentIncidentResult(rawResult(), incidentEvidenceIds(input()), rawTask().id);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.result?.incidentResolved, false);
  assert.equal(result.result?.rootCauseEstablished, false);
  assert.equal(result.result?.restartAuthorized, false);
  assert.equal(result.result?.rollbackAuthorized, false);
  assert.equal(result.result?.deployAuthorized, false);
  assert.equal(result.result?.providerMutationAuthorized, false);
  assert.equal(result.result?.sourceMutationAuthorized, false);
});

test("incident result only permits INSPECT TEST and QUERY proposals", () => {
  const bad = rawResult(); bad.hypotheses[0].verification[0].kind = "ROLLBACK";
  assert.equal(validateAgentIncidentResult(bad, incidentEvidenceIds(input()), rawTask().id).valid, false);
  const badNext = rawResult(); badNext.recommendedNextStep.kind = "RESTART";
  assert.equal(validateAgentIncidentResult(badNext, incidentEvidenceIds(input()), rawTask().id).valid, false);
});
test("incident agent returns evidence-bound hypotheses from one local model call", async () => {
  /** @type {any[]} */ const calls = [];
  const invoke = async (/** @type {any} */ config, /** @type {any} */ request) => {
    calls.push({ config, request });
    return modelResponse(request, JSON.stringify(rawResult()));
  };
  const result = await runAgentIncidentAnalysis(task(), rolePolicy(), input(), modelConfig(), "worker-local", "small-local", { invoke });
  assert.equal(calls.length, 1);
  assert.equal(result.hypotheses[0]?.evidenceIds.includes("health:database"), true);
  assert.equal(result.rootCauseEstablished, false);
  assert.deepEqual(result.model, { backend: "worker-local", model: "small-local" });
  const prompt = calls[0].request.messages.map((/** @type {any} */ item) => item.content).join("\n");
  assert.match(prompt, /error:database-timeout/);
  assert.match(prompt, /Never propose restart, rollback/);
});

test("incident agent rejects wrong role write authority network and repository mismatch before model", async () => {
  const invoke = async () => { throw new Error("model should not be called"); };
  const wrongRole = rawTask(); wrongRole.role = "diagnose";
  await assert.rejects(() => runAgentIncidentAnalysis(task(wrongRole), rolePolicy(), input(), modelConfig(), "worker-local", "small-local", { invoke }), /role incident/);
  const write = rawTask(); write.authority.filesystem = "WORKTREE_WRITE";
  await assert.rejects(() => runAgentIncidentAnalysis(task(write), rolePolicy(), input(), modelConfig(), "worker-local", "small-local", { invoke }), /read-only/);
  const network = rawTask(); network.authority.network = "READ_ONLY";
  await assert.rejects(() => runAgentIncidentAnalysis(task(network), rolePolicy(), input(), modelConfig(), "worker-local", "small-local", { invoke }), /read-only/);
  const mismatch = rawInput(); mismatch.repository.commit = "d".repeat(40); mismatch.release.commit = "d".repeat(40); mismatch.runtimeEvidence.deployment.commit = "d".repeat(40);
  await assert.rejects(() => runAgentIncidentAnalysis(task(), rolePolicy(), input(mismatch), modelConfig(), "worker-local", "small-local", { invoke }), /exact Agent Task repository identity/);
});
test("model output with invented evidence or operational fields fails closed", async () => {
  const invented = rawResult(); invented.hypotheses[0].evidenceIds = ["error:not-real"];
  const badEvidence = async (/** @type {any} */ _config, /** @type {any} */ request) => modelResponse(request, JSON.stringify(invented));
  await assert.rejects(() => runAgentIncidentAnalysis(task(), rolePolicy(), input(), modelConfig(), "worker-local", "small-local", { invoke: badEvidence }), /failed Incident Result/);
  const mutation = { ...rawResult(), restartAuthorized: true };
  const badField = async (/** @type {any} */ _config, /** @type {any} */ request) => modelResponse(request, JSON.stringify(mutation));
  await assert.rejects(() => runAgentIncidentAnalysis(task(), rolePolicy(), input(), modelConfig(), "worker-local", "small-local", { invoke: badField }), /failed Incident Result/);
});

test("CLI composes explicit sanitized files with injected local model", async () => {
  const files = [tempJson("incident-task", rawTask()), tempJson("incident-role", rawRolePolicy()), tempJson("incident-input", rawInput()), tempJson("incident-model", rawModelConfig())];
  const originalLog = console.log, originalError = console.error; let stdout = "", stderr = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; }; console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    const invoke = async (/** @type {any} */ _config, /** @type {any} */ request) => modelResponse(request, JSON.stringify(rawResult()));
    const [taskFile, roleFile, inputFile, modelFile] = files;
    if (!taskFile || !roleFile || !inputFile || !modelFile) throw new Error("test fixture missing");
    const code = await main(["--task", taskFile, "--role-policy", roleFile, "--input", inputFile, "--model-config", modelFile, "--backend", "worker-local", "--model", "small-local", "--json"], { invoke });
    assert.equal(code, 0); assert.equal(stderr, "");
    const result = JSON.parse(stdout); assert.equal(result.restartAuthorized, false); assert.equal(result.rootCauseEstablished, false);
  } finally { console.log = originalLog; console.error = originalError; for (const file of files) fs.rmSync(file, { force: true }); }
});
test("incident source has no provider mutation subprocess deployment or implicit network surface", () => {
  const source = fs.readFileSync(new URL("../scripts/agent-incident-analysis.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execSync/);
  assert.doesNotMatch(source, /fetch\(|https?:\/\//);
  assert.doesNotMatch(source, /restartService\(|rollbackDeployment\(|deployProduction\(|mutateProvider\(/);
  assert.match(source, /restartAuthorized: false/);
  assert.match(source, /rollbackAuthorized: false/);
  assert.match(source, /providerMutationAuthorized: false/);
});

test("incident CLI fails closed on incomplete and unknown arguments", async () => {
  const originalError = console.error; console.error = () => {};
  try {
    assert.equal(await main([]), 1);
    assert.equal(await main(["--unknown", "x"]), 1);
  } finally { console.error = originalError; }
});
