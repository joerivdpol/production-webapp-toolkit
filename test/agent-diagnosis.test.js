import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateAgentTask } from "../scripts/agent-task.js";
import { validateAgentRolePolicy } from "../scripts/agent-role-policy.js";
import { validateAgentModelConfig } from "../scripts/agent-local-model.js";
import {
  validateAgentDiagnosisInput,
  validateAgentDiagnosisResult,
  runAgentDiagnosis,
  main,
} from "../scripts/agent-diagnosis.js";

const COMMIT = "a".repeat(40);

/** @returns {any} */
function rawTask(role = "diagnose", filesystem = "READ_ONLY") {
  return {
    version: 1,
    id: "task:diagnose:fixture",
    role,
    repository: { id: "example-webapp", baseCommit: COMMIT },
    createdAt: "2026-09-17T12:00:00Z",
    risk: "LOW",
    objective: "identify evidence-backed hypotheses for the failing build",
    authority: { filesystem, shell: "BOUNDED", network: "NONE", merge: false, deploy: false, productionMutation: false },
    scope: { allowedPaths: ["src/**", "test/**"], deniedPaths: [".env"], requiredChecks: ["test", "typecheck"] },
    dependsOn: [],
  };
}

/** @returns {any} */
function rawInput() {
  return {
    version: 1,
    taskId: "task:diagnose:fixture",
    repository: { id: "example-webapp", commit: COMMIT },
    evidence: [
      { id: "build-error", source: "ci", status: "FAIL", summary: "TypeScript reports an unresolved import in src/example.ts", path: "src/example.ts" },
      { id: "change-one", source: "change-surface", status: "INFO", summary: "The imported module path changed in the evaluated commit", path: "src/example.ts" },
    ],
    changedFiles: ["src/example.ts"],
    unknowns: ["Whether another consumer still imports the previous module path"],
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
function rawDiagnosisResult() {
  return {
    version: 1,
    taskId: "task:diagnose:fixture",
    hypotheses: [
      {
        id: "hypothesis-import-path",
        statement: "The failing import may still reference the previous module path.",
        evidenceIds: ["build-error", "change-one"],
        verification: [
          { kind: "INSPECT", instruction: "Inspect the import and the renamed module path at the evaluated commit." },
          { kind: "TEST", instruction: "Run the existing TypeScript check without modifying source." },
        ],
      },
    ],
    unknowns: ["Whether another consumer has the same stale import."],
    recommendedNextStep: { kind: "INSPECT", instruction: "Inspect all exact references to the previous module path." },
  };
}

function task(raw = rawTask()) { const result = validateAgentTask(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.task) throw new Error("task fixture invalid"); return result.task; }
function input(raw = rawInput()) { const result = validateAgentDiagnosisInput(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.input) throw new Error("input fixture invalid"); return result.input; }
function rolePolicy(raw = rawRolePolicy()) { const result = validateAgentRolePolicy(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("role policy fixture invalid"); return result.policy; }
function modelConfig(raw = rawModelConfig()) { const result = validateAgentModelConfig(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.config) throw new Error("model config fixture invalid"); return result.config; }

/** @param {any} request @param {string} content */
function modelResponse(request, content) {
  return { version: 1, backend: request.backend, model: request.model, content, finishReason: "stop", usage: { inputTokens: 1, outputTokens: 1 }, semantics: "synthetic local model" };
}
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; }

test("diagnosis input binds explicit evidence to one repository commit", () => {
  const result = validateAgentDiagnosisInput(rawInput());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.input?.evidence.map((/** @type {any} */ item) => item.id), ["build-error", "change-one"]);
});

test("diagnosis input rejects duplicate evidence unsafe paths unknown fields and malformed commits", () => {
  const duplicate = rawInput(); duplicate.evidence.push({ ...duplicate.evidence[0] });
  assert.equal(validateAgentDiagnosisInput(duplicate).valid, false);
  const pathTraversal = rawInput(); pathTraversal.changedFiles = ["../secret"];
  assert.equal(validateAgentDiagnosisInput(pathTraversal).valid, false);
  const unknown = rawInput(); unknown.productionUrl = "https://example.invalid";
  assert.equal(validateAgentDiagnosisInput(unknown).valid, false);
  const commit = rawInput(); commit.repository.commit = "main";
  assert.equal(validateAgentDiagnosisInput(commit).valid, false);
});

test("diagnosis result requires hypotheses to cite only supplied evidence ids", () => {
  const allowed = new Set(rawInput().evidence.map((/** @type {any} */ item) => item.id));
  assert.equal(validateAgentDiagnosisResult(rawDiagnosisResult(), allowed, rawTask().id).valid, true);
  const invented = rawDiagnosisResult(); invented.hypotheses[0].evidenceIds.push("invented-proof");
  const result = validateAgentDiagnosisResult(invented, allowed, rawTask().id);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((item) => item.id === "hypothesis-evidence-reference-invalid"), true);
});

test("diagnosis result exposes no root-cause or execution authority", () => {
  const result = validateAgentDiagnosisResult(rawDiagnosisResult(), new Set(["build-error", "change-one"]), rawTask().id);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.result?.rootCauseEstablished, false);
  assert.equal(result.result?.executionAuthorized, false);
  assert.equal(result.result?.sourceMutationAuthorized, false);
  assert.match(result.result?.semantics ?? "", /verification is required/);
});

test("diagnosis result only accepts read-only verification action classes", () => {
  const allowed = new Set(["build-error", "change-one"]);
  const mutation = rawDiagnosisResult(); mutation.hypotheses[0].verification[0].kind = "PATCH";
  assert.equal(validateAgentDiagnosisResult(mutation, allowed, rawTask().id).valid, false);
  const next = rawDiagnosisResult(); next.recommendedNextStep.kind = "DEPLOY";
  assert.equal(validateAgentDiagnosisResult(next, allowed, rawTask().id).valid, false);
});

test("diagnosis agent returns validated evidence-bound model hypotheses", async () => {
  /** @type {any[]} */ const requests = [];
  const invoke = async (/** @type {any} */ config, /** @type {any} */ request) => {
    requests.push({ config, request });
    return { ...modelResponse(request, JSON.stringify(rawDiagnosisResult())), usage: { inputTokens: 100, outputTokens: 80 } };
  };
  const result = await runAgentDiagnosis(task(), rolePolicy(), input(), modelConfig(), "worker-local", "small-local", { invoke });
  assert.equal(requests.length, 1);
  assert.equal(result.hypotheses[0]?.evidenceIds.includes("build-error"), true);
  assert.equal(result.rootCauseEstablished, false);
  assert.deepEqual(result.model, { backend: "worker-local", model: "small-local" });
  const prompt = requests[0].request.messages.map((/** @type {any} */ item) => item.content).join("\n");
  assert.match(prompt, /build-error/);
  assert.match(prompt, /Never claim root cause is proven/);
});

test("diagnosis agent requires diagnose role exact repository binding and read-only role policy", async () => {
  const invoke = async () => { throw new Error("model should not be called"); };
  await assert.rejects(() => runAgentDiagnosis(task(rawTask("review")), rolePolicy(), input(), modelConfig(), "worker-local", "small-local", { invoke }), /role diagnose/);
  const mismatch = rawInput(); mismatch.repository.commit = "b".repeat(40);
  await assert.rejects(() => runAgentDiagnosis(task(), rolePolicy(), input(mismatch), modelConfig(), "worker-local", "small-local", { invoke }), /exact Agent Task repository identity/);
  await assert.rejects(() => runAgentDiagnosis(task(rawTask("diagnose", "WORKTREE_WRITE")), rolePolicy(), input(), modelConfig(), "worker-local", "small-local", { invoke }), /not authorized by read-only/);
});

test("non-JSON and structurally invalid model output fails closed", async () => {
  const nonJson = async (/** @type {any} */ _config, /** @type {any} */ request) => modelResponse(request, "not json");
  await assert.rejects(() => runAgentDiagnosis(task(), rolePolicy(), input(), modelConfig(), "worker-local", "small-local", { invoke: nonJson }), /non-JSON/);
  const invalid = rawDiagnosisResult(); invalid.hypotheses[0].evidenceIds = ["invented-proof"];
  const bad = async (/** @type {any} */ _config, /** @type {any} */ request) => modelResponse(request, JSON.stringify(invalid));
  await assert.rejects(() => runAgentDiagnosis(task(), rolePolicy(), input(), modelConfig(), "worker-local", "small-local", { invoke: bad }), /failed Agent Diagnosis Result/);
});

test("CLI composes explicit task role evidence and private model config with injected model", async () => {
  const files = [tempJson("diagnosis-task", rawTask()), tempJson("diagnosis-role", rawRolePolicy()), tempJson("diagnosis-input", rawInput()), tempJson("diagnosis-model", rawModelConfig())];
  const originalLog = console.log, originalError = console.error; let stdout = "", stderr = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; }; console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    const invoke = async (/** @type {any} */ _config, /** @type {any} */ request) => modelResponse(request, JSON.stringify(rawDiagnosisResult()));
    const taskFile = files[0], roleFile = files[1], inputFile = files[2], modelFile = files[3];
    if (!taskFile || !roleFile || !inputFile || !modelFile) throw new Error("test fixture file missing");
    const code = await main(["--task", taskFile, "--role-policy", roleFile, "--input", inputFile, "--model-config", modelFile, "--backend", "worker-local", "--model", "small-local", "--json"], { invoke });
    assert.equal(code, 0); assert.equal(stderr, "");
    const result = JSON.parse(stdout); assert.equal(result.executionAuthorized, false); assert.equal(result.rootCauseEstablished, false);
  } finally { console.log = originalLog; console.error = originalError; for (const file of files) fs.rmSync(file, { force: true }); }
});

test("diagnosis source has no repository mutation subprocess deployment or production provider surface", () => {
  const source = fs.readFileSync(new URL("../scripts/agent-diagnosis.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|writeFile|copyFile|renameSync|rmSync|process\.env|github\.com|xendit|supabase|cloudflare/i);
  assert.match(source, /rootCauseEstablished: false/);
  assert.match(source, /sourceMutationAuthorized: false/);
});
