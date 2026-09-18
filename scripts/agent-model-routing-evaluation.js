#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateAgentTelemetryEvidence } from "./agent-resource-telemetry.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const ROLES = new Set(["diagnose","reproduce","review","repair","docs","contract","dependency","incident"]);
const MODEL_CLASSES = new Set(["SMALL","STANDARD","STRONG","REVIEW"]);
const MAX_FILE_BYTES = 16 * 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value @param {number} [max] */
function text(value, max = 512) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}
/** @param {unknown} value */
function modelClass(value) {
  const normalized = text(value, 32);
  return normalized && MODEL_CLASSES.has(normalized) ? normalized : null;
}
/** @param {unknown} value */
export function validateModelRoutingEvaluationPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "model routing evaluation policy must be an object" }] };
  rejectUnknown(value, ["version","evaluatedAt","maxEvidenceAgeSeconds","roles"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "policy version must be exactly 1" });
  const evaluatedAt = text(value.evaluatedAt, 64), maxEvidenceAgeSeconds = integer(value.maxEvidenceAgeSeconds, 1, 365 * 24 * 3600);
  if (!evaluatedAt || !isAbsoluteIsoTimestamp(evaluatedAt)) errors.push({ id: "evaluated-at-invalid", detail: "evaluatedAt must be an absolute ISO timestamp" });
  if (maxEvidenceAgeSeconds === null) errors.push({ id: "max-evidence-age-invalid", detail: "maxEvidenceAgeSeconds must be a bounded positive integer" });
  /** @type {Array<any>} */ const roles = []; const roleIds = new Set();
  if (!Array.isArray(value.roles) || value.roles.length === 0 || value.roles.length > ROLES.size) errors.push({ id: "roles-invalid", detail: "roles must be a non-empty bounded array" });
  else for (const [index, raw] of value.roles.entries()) {
    if (!object(raw)) { errors.push({ id: "role-invalid", detail: `roles[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["id","modelClassOrder","minEvaluatedRuns","maxEvaluationFailures","maxReopenedDefects"], "role", errors);
    const roleId = text(raw.id, 32);
    const classes = Array.isArray(raw.modelClassOrder) ? raw.modelClassOrder.map(modelClass) : null;
    const minEvaluatedRuns = integer(raw.minEvaluatedRuns, 1, 100000), maxEvaluationFailures = integer(raw.maxEvaluationFailures, 0, 100000), maxReopenedDefects = integer(raw.maxReopenedDefects, 0, 100000);
    if (!roleId || !ROLES.has(roleId) || roleIds.has(roleId) || !classes || classes.length === 0 || classes.length > MODEL_CLASSES.size || classes.some((item) => item === null) || new Set(classes).size !== classes.length || minEvaluatedRuns === null || maxEvaluationFailures === null || maxReopenedDefects === null) {
      errors.push({ id: "role-fields-invalid", detail: `roles[${index}] contains invalid or duplicate routing-evaluation fields` });
      continue;
    }
    roleIds.add(roleId);
    roles.push({ id: roleId, modelClassOrder: /** @type {string[]} */ (classes), minEvaluatedRuns, maxEvaluationFailures, maxReopenedDefects });
  }
  if (errors.length || !evaluatedAt || maxEvidenceAgeSeconds === null) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, evaluatedAt, maxEvidenceAgeSeconds, roles: roles.sort((a,b)=>a.id.localeCompare(b.id)) }, errors: [] };
}
/** @param {any[]} runs */
function summarizeRuns(runs) {
  const summary = {
    runs: runs.length,
    evaluatedRuns: 0,
    evaluationPass: 0,
    evaluationFail: 0,
    notEvaluated: 0,
    reopenedDefects: 0,
    proposals: { accepted: 0, rejected: 0, notApplicable: 0 },
    latencyMs: 0,
    cpuTimeMs: 0,
    gpuTimeMs: 0,
    gpuTimeReported: 0,
    inputTokens: 0,
    outputTokens: 0,
    tokenUsageReported: 0,
  };
  for (const run of runs) {
    summary.latencyMs += run.latencyMs;
    summary.cpuTimeMs += run.resources.cpuTimeMs;
    if (run.resources.gpuTimeMs !== null) { summary.gpuTimeMs += run.resources.gpuTimeMs; summary.gpuTimeReported += 1; }
    if (run.usage.inputTokens !== null && run.usage.outputTokens !== null) {
      summary.inputTokens += run.usage.inputTokens; summary.outputTokens += run.usage.outputTokens; summary.tokenUsageReported += 1;
    }
    if (run.evaluation.status === "PASS") { summary.evaluationPass += 1; summary.evaluatedRuns += 1; }
    else if (run.evaluation.status === "FAIL") { summary.evaluationFail += 1; summary.evaluatedRuns += 1; }
    else summary.notEvaluated += 1;
    if (run.defect.reopened) summary.reopenedDefects += 1;
    if (run.proposal.outcome === "ACCEPTED") summary.proposals.accepted += 1;
    else if (run.proposal.outcome === "REJECTED") summary.proposals.rejected += 1;
    else summary.proposals.notApplicable += 1;
  }
  return { ...summary, averageLatencyMs: runs.length === 0 ? null : Math.floor(summary.latencyMs / runs.length) };
}
/** @param {any} run */
function modelKey(run) { return `${run.model.backend}:${run.model.id}:${run.model.class}`; }
/** @param {any[]} runs @param {any} rolePolicy */
function evaluateModels(runs, rolePolicy) {
  const groups = new Map();
  for (const run of runs.filter((item) => item.role === rolePolicy.id)) {
    const key = modelKey(run), bucket = groups.get(key) ?? [];
    bucket.push(run); groups.set(key, bucket);
  }
  /** @type {Array<any>} */ const models = [];
  for (const [key, bucket] of groups.entries()) {
    const first = bucket[0], summary = summarizeRuns(bucket);
    let status = "UNVERIFIED", reason = "insufficient evaluated runs";
    if (summary.evaluatedRuns >= rolePolicy.minEvaluatedRuns) {
      if (summary.evaluationFail > rolePolicy.maxEvaluationFailures) { status = "DISQUALIFIED"; reason = "evaluation failures exceed policy maximum"; }
      else if (summary.reopenedDefects > rolePolicy.maxReopenedDefects) { status = "DISQUALIFIED"; reason = "reopened defects exceed policy maximum"; }
      else { status = "QUALIFIED"; reason = "measured evaluation and defect evidence satisfy policy"; }
    }
    models.push({
      key,
      model: { id: first.model.id, class: first.model.class, backend: first.model.backend },
      workerClasses: [...new Set(bucket.map((/** @type {any} */ item) => item.worker.class))].sort(),
      status, reason, measurements: summary,
    });
  }
  return models.sort((a,b) => rolePolicy.modelClassOrder.indexOf(a.model.class) - rolePolicy.modelClassOrder.indexOf(b.model.class)
    || (a.measurements.averageLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.measurements.averageLatencyMs ?? Number.MAX_SAFE_INTEGER)
    || a.key.localeCompare(b.key));
}
/** @param {any[]} models @param {any} rolePolicy */
function recommendModel(models, rolePolicy) {
  const byClass = new Map();
  for (const className of rolePolicy.modelClassOrder) byClass.set(className, models.filter((/** @type {any} */ item) => item.model.class === className));
  const blockedClasses = [];
  for (const className of rolePolicy.modelClassOrder) {
    const candidates = byClass.get(className) ?? [];
    if (candidates.length === 0) return { status: "UNVERIFIED", reason: `no telemetry exists for preferred model class ${className}`, selected: null, blockedClasses };
    const qualified = candidates.filter((/** @type {any} */ item) => item.status === "QUALIFIED");
    if (qualified.length > 0) {
      qualified.sort((/** @type {any} */ a, /** @type {any} */ b) => (a.measurements.averageLatencyMs ?? Number.MAX_SAFE_INTEGER) - (b.measurements.averageLatencyMs ?? Number.MAX_SAFE_INTEGER) || a.key.localeCompare(b.key));
      const selected = qualified[0];
      return {
        status: blockedClasses.length === 0 ? "QUALIFIED_SMALLEST_MEASURED_CLASS" : "ESCALATION_REQUIRED_BY_MEASURED_QUALITY",
        reason: blockedClasses.length === 0 ? "smallest preferred measured class has a qualified exact model" : "all earlier model classes were disqualified by measured quality evidence",
        selected: { ...selected.model, key: selected.key },
        blockedClasses,
      };
    }
    const unverified = candidates.some((/** @type {any} */ item) => item.status === "UNVERIFIED");
    if (unverified) return { status: "UNVERIFIED", reason: `preferred model class ${className} lacks sufficient measured quality evidence`, selected: null, blockedClasses };
    blockedClasses.push(className);
  }
  return { status: "NO_QUALIFIED_MODEL", reason: "all configured model classes are disqualified by measured quality evidence", selected: null, blockedClasses };
}
/** @param {any} telemetry @param {any} policy */
export function evaluateModelRouting(telemetry, policy) {
  const collectedMs = Date.parse(telemetry.evidence.collectedAt), evaluatedMs = Date.parse(policy.evaluatedAt);
  const ageSeconds = Math.floor((evaluatedMs - collectedMs) / 1000);
  const future = collectedMs > evaluatedMs, stale = ageSeconds > policy.maxEvidenceAgeSeconds;
  const roles = [];
  for (const rolePolicy of policy.roles) {
    const models = evaluateModels(telemetry.runs, rolePolicy);
    const recommendation = future || stale
      ? { status: "UNVERIFIED", reason: future ? "telemetry evidence is future-dated" : "telemetry evidence is stale", selected: null, blockedClasses: [] }
      : recommendModel(models, rolePolicy);
    roles.push({ role: rolePolicy.id, policy: rolePolicy, models, recommendation });
  }
  return {
    version: 1,
    evaluatedAt: policy.evaluatedAt,
    telemetry: {
      collectedAt: telemetry.evidence.collectedAt,
      ageSeconds,
      source: telemetry.evidence.source,
      authenticatedMetadata: telemetry.evidence.authenticated,
      fresh: !future && !stale,
    },
    roles,
    routingPolicyMutationAuthorized: false,
    automaticModelDeploymentAuthorized: false,
    qualityScore: null,
    semantics: "deterministic evidence-based routing recommendation only; exact model identities qualify from measured corpus outcomes and reopened-defect evidence, missing measurements remain UNVERIFIED, stronger classes are recommended only after earlier configured classes are explicitly DISQUALIFIED, and caller authentication metadata is not cryptographic proof",
  };
}
/** @param {string} filename */
function readJson(filename) {
  const resolved = path.resolve(filename); let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error("model routing evaluation input cannot be read"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw new Error("model routing evaluation input must be a bounded regular non-symlink file");
  try { return JSON.parse(fs.readFileSync(resolved, "utf8")); } catch { throw new Error("model routing evaluation input JSON cannot be parsed"); }
}
/** @param {any} report */
export function formatModelRoutingEvaluation(report) {
  const lines = ["Model Routing Evaluation v1", "", `Evaluated at: ${report.evaluatedAt}`, `Telemetry: ${report.telemetry.collectedAt} age=${report.telemetry.ageSeconds}s fresh=${report.telemetry.fresh}`, ""];
  for (const role of report.roles) {
    lines.push(`${role.role}: ${role.recommendation.status}  ${role.recommendation.selected?.key ?? "no-selection"}`);
    for (const model of role.models) lines.push(`  ${model.status.padEnd(12)} ${model.key}  evaluated=${model.measurements.evaluatedRuns} fail=${model.measurements.evaluationFail} reopened=${model.measurements.reopenedDefects} avgLatencyMs=${model.measurements.averageLatencyMs ?? "n/a"}`);
  }
  lines.push("", `Semantics: ${report.semantics}`);
  return lines.join("\n");
}
/** @param {string[]} argv */
function parse(argv) {
  let telemetry = null, policy = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") { if (json) return null; json = true; continue; }
    if (arg !== "--telemetry" && arg !== "--policy") return null;
    const next = argv[index + 1]; if (typeof next !== "string" || next.startsWith("--")) return null;
    if (arg === "--telemetry") { if (telemetry) return null; telemetry = next; } else { if (policy) return null; policy = next; }
    index += 1;
  }
  return telemetry && policy ? { telemetry, policy, json } : null;
}
export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/agent-model-routing-evaluation.js --telemetry <agent-telemetry.json> --policy <model-routing-evaluation-policy.json> [--json]"); return 1; }
  try {
    const telemetryResult = validateAgentTelemetryEvidence(readJson(options.telemetry));
    const policyResult = validateModelRoutingEvaluationPolicy(readJson(options.policy));
    if (!telemetryResult.valid || !telemetryResult.evidence || !policyResult.valid || !policyResult.policy) throw new Error("model routing evaluation telemetry or policy is invalid");
    const report = evaluateModelRouting(telemetryResult.evidence, policyResult.policy);
    console.log(options.json ? JSON.stringify(report) : formatModelRoutingEvaluation(report));
    return report.roles.some((role) => ["NO_QUALIFIED_MODEL"].includes(role.recommendation.status)) ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "model routing evaluation failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
