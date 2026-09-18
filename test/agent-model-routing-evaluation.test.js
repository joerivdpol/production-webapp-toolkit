import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { validateAgentTelemetryEvidence } from "../scripts/agent-resource-telemetry.js";
import {
  evaluateModelRouting,
  formatModelRoutingEvaluation,
  main,
  validateModelRoutingEvaluationPolicy,
} from "../scripts/agent-model-routing-evaluation.js";

const COMMIT = "a".repeat(40);
const COLLECTED = "2026-09-18T09:00:00Z";
const EVALUATED = "2026-09-18T09:05:00Z";

/** @param {number} second */
function iso(second) {
  return new Date(Date.parse("2026-09-18T08:00:00Z") + second * 1000).toISOString();
}
/** @param {Partial<any>} [overrides] @returns {any} */
function run(overrides = {}) {
  const index = Number(overrides.index ?? 0);
  const startedAt = overrides.startedAt ?? iso(index * 10);
  const latencyMs = Number(overrides.latencyMs ?? 1000);
  const completedAt = overrides.completedAt ?? new Date(Date.parse(startedAt) + latencyMs).toISOString();
  const copy = { ...overrides }; delete copy.index;
  return {
    runId: "run:" + index,
    taskId: "task:diagnose:" + index,
    role: "diagnose",
    repository: { id: "demo", commit: COMMIT },
    worker: { id: "worker:persistent", class: "PERSISTENT" },
    model: { id: "small-local", class: "SMALL", backend: "ollama" },
    startedAt,
    completedAt,
    latencyMs,
    resources: { cpuTimeMs: Math.min(latencyMs, 900), gpuTimeMs: null },
    usage: { inputTokens: 100, outputTokens: 30 },
    proposal: { outcome: "ACCEPTED" },
    review: { effortSeconds: 30 },
    defect: { reopened: false },
    evaluation: { corpusId: "agent-corpus-v1", status: "PASS" },
    ...copy,
  };
}
/** @param {any[]} runs @param {string} [collectedAt] @param {boolean} [authenticated] */
function rawTelemetry(runs, collectedAt = COLLECTED, authenticated = false) {
  return { version: 1, evidence: { source: "agent-runner", authenticated, collectedAt }, runs };
}
/** @param {Partial<any>} [overrides] @returns {any} */
function rawPolicy(overrides = {}) {
  return {
    version: 1,
    evaluatedAt: EVALUATED,
    maxEvidenceAgeSeconds: 3600,
    roles: [{
      id: "diagnose",
      modelClassOrder: ["SMALL", "STANDARD", "STRONG"],
      minEvaluatedRuns: 2,
      maxEvaluationFailures: 0,
      maxReopenedDefects: 0,
    }],
    ...overrides,
  };
}
/** @param {any} raw */
function telemetry(raw) {
  const result = validateAgentTelemetryEvidence(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.evidence) throw new Error("telemetry fixture invalid");
  return result.evidence;
}
function policy(raw = rawPolicy()) {
  const result = validateModelRoutingEvaluationPolicy(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) throw new Error("policy fixture invalid");
  return result.policy;
}
/** @param {any} raw */
function report(raw) {
  return evaluateModelRouting(telemetry(raw), policy());
}
/** @param {any} result */
function firstRole(result) {
  const role = /** @type {any} */ (result.roles[0]);
  assert.ok(role, "expected one role result");
  return role;
}
/** @param {any} role */
function firstModel(role) {
  const model = role.models[0];
  assert.ok(model, "expected one model result");
  return model;
}
test("policy validates explicit role thresholds and ordered unique model classes", () => {
  const result = validateModelRoutingEvaluationPolicy(rawPolicy());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  const duplicate = rawPolicy();
  duplicate.roles[0].modelClassOrder = ["SMALL", "SMALL"];
  assert.equal(validateModelRoutingEvaluationPolicy(duplicate).valid, false);
  const unknown = rawPolicy();
  unknown.roles[0].id = "super-agent";
  assert.equal(validateModelRoutingEvaluationPolicy(unknown).valid, false);
  const zero = rawPolicy();
  zero.roles[0].minEvaluatedRuns = 0;
  assert.equal(validateModelRoutingEvaluationPolicy(zero).valid, false);
});

test("small exact model is qualified when measured evidence satisfies policy", () => {
  const runs = [run({ index: 1 }), run({ index: 2, latencyMs: 800 })];
  const result = report(rawTelemetry(runs));
  const role = firstRole(result);
  assert.equal(role.models.length, 1);
  assert.equal(firstModel(role).status, "QUALIFIED");
  assert.equal(firstModel(role).measurements.evaluatedRuns, 2);
  assert.equal(role.recommendation.status, "QUALIFIED_SMALLEST_MEASURED_CLASS");
  assert.equal(role.recommendation.selected?.id, "small-local");
  assert.equal(role.recommendation.selected?.class, "SMALL");
});
test("insufficient small-model evidence blocks escalation to stronger measured model", () => {
  const runs = [
    run({ index: 1 }),
    run({ index: 2, model: { id: "standard-local", class: "STANDARD", backend: "llama" }, worker: { id: "worker:compute", class: "COMPUTE" } }),
    run({ index: 3, model: { id: "standard-local", class: "STANDARD", backend: "llama" }, worker: { id: "worker:compute", class: "COMPUTE" } }),
  ];
  const result = report(rawTelemetry(runs));
  const role = firstRole(result);
  assert.equal(role.models.find((/** @type {any} */ item) => item.model.class === "SMALL")?.status, "UNVERIFIED");
  assert.equal(role.models.find((/** @type {any} */ item) => item.model.class === "STANDARD")?.status, "QUALIFIED");
  assert.equal(role.recommendation.status, "UNVERIFIED");
  assert.equal(role.recommendation.selected, null);
  assert.deepEqual(role.recommendation.blockedClasses, []);
});

test("stronger class is recommended only after smaller class is explicitly disqualified", () => {
  const runs = [
    run({ index: 1, evaluation: { corpusId: "agent-corpus-v1", status: "FAIL" } }),
    run({ index: 2, evaluation: { corpusId: "agent-corpus-v1", status: "FAIL" } }),
    run({ index: 3, model: { id: "standard-local", class: "STANDARD", backend: "llama" }, worker: { id: "worker:compute", class: "COMPUTE" } }),
    run({ index: 4, model: { id: "standard-local", class: "STANDARD", backend: "llama" }, worker: { id: "worker:compute", class: "COMPUTE" } }),
  ];
  const role = firstRole(report(rawTelemetry(runs)));
  assert.equal(role.models.find((/** @type {any} */ item) => item.model.class === "SMALL")?.status, "DISQUALIFIED");
  assert.equal(role.recommendation.status, "ESCALATION_REQUIRED_BY_MEASURED_QUALITY");
  assert.equal(role.recommendation.selected?.id, "standard-local");
  assert.deepEqual(role.recommendation.blockedClasses, ["SMALL"]);
});
test("reopened defects disqualify an otherwise corpus-passing small model", () => {
  const smallReopened = run({ index: 1, defect: { reopened: true } });
  const smallPass = run({ index: 2 });
  const standardOne = run({ index: 3, model: { id: "standard-local", class: "STANDARD", backend: "llama" }, worker: { id: "worker:compute", class: "COMPUTE" } });
  const standardTwo = run({ index: 4, model: { id: "standard-local", class: "STANDARD", backend: "llama" }, worker: { id: "worker:compute", class: "COMPUTE" } });
  const role = firstRole(report(rawTelemetry([smallReopened, smallPass, standardOne, standardTwo])));
  const small = role.models.find((/** @type {any} */ item) => item.model.class === "SMALL");
  assert.equal(small?.status, "DISQUALIFIED");
  assert.equal(small?.measurements.reopenedDefects, 1);
  assert.equal(role.recommendation.status, "ESCALATION_REQUIRED_BY_MEASURED_QUALITY");
});

test("multiple qualified exact models in the same class use lower measured average latency as deterministic tiebreaker", () => {
  const runs = [
    run({ index: 1, model: { id: "small-slow", class: "SMALL", backend: "ollama" }, latencyMs: 1500 }),
    run({ index: 2, model: { id: "small-slow", class: "SMALL", backend: "ollama" }, latencyMs: 1300 }),
    run({ index: 3, model: { id: "small-fast", class: "SMALL", backend: "ollama" }, latencyMs: 500 }),
    run({ index: 4, model: { id: "small-fast", class: "SMALL", backend: "ollama" }, latencyMs: 700 }),
  ];
  const role = firstRole(report(rawTelemetry(runs)));
  assert.equal(role.models.every((/** @type {any} */ item) => item.status === "QUALIFIED"), true);
  assert.equal(role.recommendation.selected?.id, "small-fast");
});
test("not-evaluated runs do not count toward measured quality minimum", () => {
  const runs = [
    run({ index: 1, evaluation: { corpusId: null, status: "NOT_EVALUATED" } }),
    run({ index: 2, evaluation: { corpusId: null, status: "NOT_EVALUATED" } }),
    run({ index: 3, evaluation: { corpusId: "agent-corpus-v1", status: "PASS" } }),
  ];
  const role = firstRole(report(rawTelemetry(runs)));
  assert.equal(firstModel(role).measurements.runs, 3);
  assert.equal(firstModel(role).measurements.evaluatedRuns, 1);
  assert.equal(firstModel(role).status, "UNVERIFIED");
  assert.equal(role.recommendation.status, "UNVERIFIED");
});

test("stale and future telemetry are never used for routing recommendations", () => {
  const runs = [run({ index: 1 }), run({ index: 2 })];
  const stalePolicy = rawPolicy({ evaluatedAt: "2026-09-18T11:00:01Z", maxEvidenceAgeSeconds: 3600 });
  let result = evaluateModelRouting(telemetry(rawTelemetry(runs)), policy(stalePolicy));
  assert.equal(result.telemetry.fresh, false);
  assert.equal(firstRole(result).recommendation.status, "UNVERIFIED");

  result = evaluateModelRouting(telemetry(rawTelemetry(runs, "2026-09-18T09:06:00Z")), policy());
  assert.equal(result.telemetry.fresh, false);
  assert.equal(firstRole(result).recommendation.status, "UNVERIFIED");
});
test("caller authentication metadata does not change qualification truth", () => {
  const runs = [run({ index: 1 }), run({ index: 2 })];
  const untrusted = report(rawTelemetry(runs, COLLECTED, false));
  const metadataTrue = report(rawTelemetry(runs, COLLECTED, true));
  assert.equal(firstRole(untrusted).recommendation.status, firstRole(metadataTrue).recommendation.status);
  assert.equal(metadataTrue.telemetry.authenticatedMetadata, true);
  assert.match(metadataTrue.semantics, /not cryptographic proof/);
});

test("proposal outcomes tokens and resources remain descriptive instead of an artificial quality score", () => {
  const runs = [
    run({ index: 1, proposal: { outcome: "REJECTED" }, usage: { inputTokens: 500, outputTokens: 200 }, resources: { cpuTimeMs: 700, gpuTimeMs: null } }),
    run({ index: 2, usage: { inputTokens: null, outputTokens: null }, resources: { cpuTimeMs: 800, gpuTimeMs: null } }),
  ];
  const result = report(rawTelemetry(runs));
  const model = firstModel(firstRole(result));
  assert.equal(model.status, "QUALIFIED");
  assert.equal(model.measurements.proposals.rejected, 1);
  assert.equal(model.measurements.tokenUsageReported, 1);
  assert.equal(result.qualityScore, null);
});
test("all measured classes disqualified yields blocking no-qualified recommendation", () => {
  const policyValue = rawPolicy();
  policyValue.roles[0].modelClassOrder = ["SMALL", "STANDARD"];
  const runs = [
    run({ index: 1, evaluation: { corpusId: "agent-corpus-v1", status: "FAIL" } }),
    run({ index: 2, evaluation: { corpusId: "agent-corpus-v1", status: "FAIL" } }),
    run({ index: 3, model: { id: "standard-local", class: "STANDARD", backend: "llama" }, evaluation: { corpusId: "agent-corpus-v1", status: "FAIL" } }),
    run({ index: 4, model: { id: "standard-local", class: "STANDARD", backend: "llama" }, evaluation: { corpusId: "agent-corpus-v1", status: "FAIL" } }),
  ];
  const result = evaluateModelRouting(telemetry(rawTelemetry(runs)), policy(policyValue));
  assert.equal(firstRole(result).recommendation.status, "NO_QUALIFIED_MODEL");
  assert.equal(firstRole(result).recommendation.selected, null);
  assert.deepEqual(firstRole(result).recommendation.blockedClasses, ["SMALL", "STANDARD"]);
});

test("human format exposes measured routing state without model outputs or prompts", () => {
  const output = formatModelRoutingEvaluation(report(rawTelemetry([run({ index: 1 }), run({ index: 2 })])));
  assert.match(output, /Model Routing Evaluation v1/);
  assert.match(output, /QUALIFIED_SMALLEST_MEASURED_CLASS/);
  assert.doesNotMatch(output, /prompt|response body|model output/i);
});
test("CLI validates explicit telemetry and policy files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-routing-eval-"));
  const telemetryFile = path.join(root, "telemetry.json"), policyFile = path.join(root, "policy.json");
  fs.writeFileSync(telemetryFile, JSON.stringify(rawTelemetry([run({ index: 1 }), run({ index: 2 })])));
  fs.writeFileSync(policyFile, JSON.stringify(rawPolicy()));
  const originalLog = console.log, originalError = console.error; let stdout = "";
  console.log = (...values) => { stdout += values.join(" ") + "\n"; }; console.error = () => {};
  try {
    assert.equal(main(["--telemetry", telemetryFile, "--policy", policyFile, "--json"]), 0);
    assert.equal(JSON.parse(stdout.trim()).roles[0].recommendation.selected.id, "small-local");
    assert.equal(main(["--unknown", "x"]), 1);
  } finally { console.log = originalLog; console.error = originalError; fs.rmSync(root, { recursive: true, force: true }); }
});

test("CLI returns nonzero when every configured class is explicitly disqualified", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "model-routing-eval-fail-"));
  const telemetryFile = path.join(root, "telemetry.json"), policyFile = path.join(root, "policy.json");
  const policyValue = rawPolicy(); policyValue.roles[0].modelClassOrder = ["SMALL"];
  fs.writeFileSync(telemetryFile, JSON.stringify(rawTelemetry([
    run({ index: 1, evaluation: { corpusId: "agent-corpus-v1", status: "FAIL" } }),
    run({ index: 2, evaluation: { corpusId: "agent-corpus-v1", status: "FAIL" } }),
  ])));
  fs.writeFileSync(policyFile, JSON.stringify(policyValue));
  const originalLog = console.log, originalError = console.error; console.log = () => {}; console.error = () => {};
  try { assert.equal(main(["--telemetry", telemetryFile, "--policy", policyFile]), 1); }
  finally { console.log = originalLog; console.error = originalError; fs.rmSync(root, { recursive: true, force: true }); }
});
test("public routing-evaluation policy template is valid and contains no private infrastructure", () => {
  const file = new URL("../templates/agent-model-routing-evaluation-policy.v1.json", import.meta.url);
  const rawText = fs.readFileSync(file, "utf8"), raw = JSON.parse(rawText);
  assert.equal(validateModelRoutingEvaluationPolicy(raw).valid, true);
  assert.doesNotMatch(rawText, /endpoint|hostname|ssh|tailscale|privateInfrastructure|maintainerService/i);
});

test("model routing evaluation source is offline read-only and cannot mutate routing policy", () => {
  const source = fs.readFileSync(new URL("../scripts/agent-model-routing-evaluation.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execSync|fetch\(|https?:\/\//);
  assert.doesNotMatch(source, /writeFile|appendFile|renameSync|unlinkSync|process\.env|Date\.now\(\)/);
  assert.match(source, /routingPolicyMutationAuthorized: false/);
  assert.match(source, /automaticModelDeploymentAuthorized: false/);
});
