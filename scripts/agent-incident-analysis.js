#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateAgentTask } from "./agent-task.js";
import { validateAgentRolePolicy, inspectAgentTaskRolePolicy } from "./agent-role-policy.js";
import { readAgentModelConfigFile, validateAgentModelRequest, invokeAgentLocalModel } from "./agent-local-model.js";
import { validateRuntimeEvidence, isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";
import { validateRuntimeHealthEvidence } from "./runtime-health-evidence.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERIFY_KINDS = new Set(["INSPECT", "TEST", "QUERY"]);
const METRIC_STATUS = new Set(["INFO", "WARN", "FAIL"]);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value @param {number} [max] */
function text(value, max = 2048) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}
/** @param {unknown} value */
function id(value) {
  const normalized = text(value, 128);
  return normalized && ID.test(normalized) ? normalized : null;
}
/** @param {unknown} value */
function safePath(value) {
  const normalized = text(value, 512);
  if (!normalized || path.isAbsolute(normalized) || normalized.includes("\\")) return null;
  const posix = path.posix.normalize(normalized);
  return posix !== "." && posix !== ".." && !posix.startsWith("../") && posix === normalized ? normalized : null;
}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
}
/** @param {string} value */
function secretLike(value) {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(value)
    || /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value);
}
/** @param {string} observedAt @param {string} evaluatedAt */
function notFuture(observedAt, evaluatedAt) {
  return Date.parse(observedAt) <= Date.parse(evaluatedAt);
}
/** @param {unknown} value */
export function validateAgentIncidentInput(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, input: null, errors: [{ id: "input-invalid", detail: "incident input must be an object" }] };
  rejectUnknown(value, ["version","taskId","repository","evaluatedAt","release","runtimeEvidence","runtimeHealthEvidence","errors","metrics","unknowns"], "input", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "incident input version must be exactly 1" });
  const taskId = id(value.taskId), evaluatedAt = text(value.evaluatedAt, 64);
  if (!taskId) errors.push({ id: "task-id-invalid", detail: "taskId must be a portable identifier" });
  if (!evaluatedAt || !isAbsoluteIsoTimestamp(evaluatedAt)) errors.push({ id: "evaluated-at-invalid", detail: "evaluatedAt must be an absolute ISO timestamp" });

  let repository = null;
  if (!object(value.repository)) errors.push({ id: "repository-invalid", detail: "repository must be an object" });
  else {
    rejectUnknown(value.repository, ["id","commit"], "repository", errors);
    const repositoryId = id(value.repository.id), commit = text(value.repository.commit, 128)?.toLowerCase() ?? null;
    if (!repositoryId || !commit || !isFullObjectId(commit)) errors.push({ id: "repository-fields-invalid", detail: "repository requires portable id and full commit" });
    else repository = { id: repositoryId, commit };
  }

  let release = null;
  if (!object(value.release)) errors.push({ id: "release-invalid", detail: "release must be an object" });
  else {
    rejectUnknown(value.release, ["id","commit","deployedAt","artifactSha256"], "release", errors);
    const releaseId = id(value.release.id), commit = text(value.release.commit, 128)?.toLowerCase() ?? null;
    const deployedAt = text(value.release.deployedAt, 64), artifactSha256 = value.release.artifactSha256 === undefined ? null : text(value.release.artifactSha256, 64)?.toLowerCase() ?? null;
    if (!releaseId || !commit || !isFullObjectId(commit) || !deployedAt || !isAbsoluteIsoTimestamp(deployedAt) || (artifactSha256 !== null && !HASH.test(artifactSha256))) errors.push({ id: "release-fields-invalid", detail: "release identity, commit, deployment time, or optional artifact hash is invalid" });
    else release = { id: releaseId, commit, deployedAt, ...(artifactSha256 ? { artifactSha256 } : {}) };
  }
  const runtimeResult = validateRuntimeEvidence(value.runtimeEvidence);
  if (!runtimeResult.valid || !runtimeResult.evidence) errors.push({ id: "runtime-evidence-invalid", detail: "runtimeEvidence must satisfy Runtime Evidence v1" });
  const healthResult = validateRuntimeHealthEvidence(value.runtimeHealthEvidence);
  if (!healthResult.valid || !healthResult.evidence) errors.push({ id: "runtime-health-evidence-invalid", detail: "runtimeHealthEvidence must satisfy Runtime Health Evidence v1" });

  /** @type {Array<{id:string,source:string,observedAt:string,count:number,summary:string,path?:string}>} */ const incidentErrors = [];
  const errorIds = new Set();
  if (!Array.isArray(value.errors) || value.errors.length === 0 || value.errors.length > 128) errors.push({ id: "errors-invalid", detail: "errors must be a non-empty bounded array" });
  else for (const [index, raw] of value.errors.entries()) {
    if (!object(raw)) { errors.push({ id: "error-invalid", detail: `errors[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["id","source","observedAt","count","summary","path"], "error", errors);
    const errorId = id(raw.id), source = id(raw.source), observedAt = text(raw.observedAt, 64), summary = text(raw.summary, 2048);
    const count = Number.isSafeInteger(raw.count) && Number(raw.count) > 0 && Number(raw.count) <= 1_000_000_000 ? Number(raw.count) : null;
    const errorPath = raw.path === undefined ? null : safePath(raw.path);
    if (!errorId || errorIds.has(errorId) || !source || !observedAt || !isAbsoluteIsoTimestamp(observedAt) || count === null || !summary || secretLike(summary) || (raw.path !== undefined && !errorPath)) {
      errors.push({ id: "error-fields-invalid", detail: `errors[${index}] has invalid, duplicate, unsafe, or secret-like fields` }); continue;
    }
    if (evaluatedAt && isAbsoluteIsoTimestamp(evaluatedAt) && !notFuture(observedAt, evaluatedAt)) errors.push({ id: "error-future-invalid", detail: `errors[${index}] is later than evaluatedAt` });
    errorIds.add(errorId); incidentErrors.push({ id: errorId, source, observedAt, count, summary, ...(errorPath ? { path: errorPath } : {}) });
  }
  /** @type {Array<{id:string,source:string,observedAt:string,name:string,value:number,unit:string,status:string}>} */ const metrics = [];
  const metricIds = new Set();
  if (!Array.isArray(value.metrics) || value.metrics.length > 128) errors.push({ id: "metrics-invalid", detail: "metrics must be a bounded array" });
  else for (const [index, raw] of value.metrics.entries()) {
    if (!object(raw)) { errors.push({ id: "metric-invalid", detail: `metrics[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["id","source","observedAt","name","value","unit","status"], "metric", errors);
    const metricId = id(raw.id), source = id(raw.source), observedAt = text(raw.observedAt, 64), name = id(raw.name), unit = text(raw.unit, 32), status = text(raw.status, 16);
    const metricValue = typeof raw.value === "number" && Number.isFinite(raw.value) && Math.abs(raw.value) <= 1e15 ? raw.value : null;
    if (!metricId || metricIds.has(metricId) || !source || !observedAt || !isAbsoluteIsoTimestamp(observedAt) || !name || metricValue === null || !unit || !status || !METRIC_STATUS.has(status)) {
      errors.push({ id: "metric-fields-invalid", detail: `metrics[${index}] has invalid or duplicate fields` }); continue;
    }
    if (evaluatedAt && isAbsoluteIsoTimestamp(evaluatedAt) && !notFuture(observedAt, evaluatedAt)) errors.push({ id: "metric-future-invalid", detail: `metrics[${index}] is later than evaluatedAt` });
    metricIds.add(metricId); metrics.push({ id: metricId, source, observedAt, name, value: metricValue, unit, status });
  }

  /** @type {string[]} */ const unknowns = [];
  if (!Array.isArray(value.unknowns) || value.unknowns.length > 64) errors.push({ id: "unknowns-invalid", detail: "unknowns must be a bounded array" });
  else for (const raw of value.unknowns) {
    const item = text(raw, 1024);
    if (!item || secretLike(item)) errors.push({ id: "unknown-invalid", detail: "unknowns contains invalid or secret-like text" }); else unknowns.push(item);
  }
  if (errors.length || !taskId || !repository || !evaluatedAt || !release || !runtimeResult.valid || !runtimeResult.evidence || !healthResult.valid || !healthResult.evidence) return { valid: false, input: null, errors };
  const runtime = runtimeResult.evidence, health = healthResult.evidence;
  if (repository.commit !== release.commit || repository.commit !== runtime.deployment.commit) errors.push({ id: "commit-binding-invalid", detail: "repository, release, and runtime deployment commit must match exactly" });
  if (runtime.runtime.name !== health.runtime.name || (runtime.runtime.environment ?? null) !== (health.runtime.environment ?? null)) errors.push({ id: "runtime-identity-invalid", detail: "runtime health identity must equal runtime deployment identity" });
  /** @type {Array<[string,string]>} */ const timeline = [["release", release.deployedAt], ["runtime", runtime.evidence.collectedAt], ["runtime-health", health.evidence.collectedAt]];
  for (const [label, timestamp] of timeline) {
    if (!notFuture(timestamp, evaluatedAt)) errors.push({ id: `${label}-future-invalid`, detail: `${label} timestamp is later than evaluatedAt` });
  }
  if (Date.parse(runtime.evidence.collectedAt) < Date.parse(release.deployedAt)) errors.push({ id: "runtime-before-release-invalid", detail: "runtime evidence cannot predate the evaluated release deployment" });
  if (Date.parse(health.evidence.collectedAt) < Date.parse(release.deployedAt)) errors.push({ id: "health-before-release-invalid", detail: "runtime health evidence cannot predate the evaluated release deployment" });
  if (errors.length) return { valid: false, input: null, errors };

  return {
    valid: true,
    input: {
      version: 1, taskId, repository, evaluatedAt, release,
      runtimeEvidence: runtime, runtimeHealthEvidence: health,
      errors: incidentErrors.sort((a,b)=>a.id.localeCompare(b.id)),
      metrics: metrics.sort((a,b)=>a.id.localeCompare(b.id)),
      unknowns,
    },
    errors: [],
  };
}
/** @param {any} input */
export function incidentEvidenceIds(input) {
  const ids = new Set(["release", "runtime-deployment"]);
  for (const check of input.runtimeHealthEvidence.checks) ids.add(`health:${check.id}`);
  for (const item of input.errors) ids.add(`error:${item.id}`);
  for (const item of input.metrics) ids.add(`metric:${item.id}`);
  return ids;
}

/** @param {unknown} value @param {Set<string>} evidenceIds @param {string} taskId */
export function validateAgentIncidentResult(value, evidenceIds, taskId) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, result: null, errors: [{ id: "result-invalid", detail: "incident result must be an object" }] };
  rejectUnknown(value, ["version","taskId","hypotheses","unknowns","recommendedNextStep"], "result", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "incident result version must be exactly 1" });
  if (value.taskId !== taskId) errors.push({ id: "task-binding-invalid", detail: "incident result taskId must equal the evaluated task" });

  /** @type {Array<any>} */ const hypotheses = []; const hypothesisIds = new Set();
  if (!Array.isArray(value.hypotheses) || value.hypotheses.length === 0 || value.hypotheses.length > 12) errors.push({ id: "hypotheses-invalid", detail: "hypotheses must be a non-empty bounded array" });
  else for (const [index, raw] of value.hypotheses.entries()) {
    if (!object(raw)) { errors.push({ id: "hypothesis-invalid", detail: `hypotheses[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["id","statement","evidenceIds","verification"], "hypothesis", errors);
    const hypothesisId = id(raw.id), statement = text(raw.statement, 2048);
    const refs = [];
    if (!Array.isArray(raw.evidenceIds) || raw.evidenceIds.length === 0 || raw.evidenceIds.length > 64) errors.push({ id: "hypothesis-evidence-invalid", detail: `hypotheses[${index}] evidenceIds must be non-empty` });
    else {
      const seen = new Set();
      for (const rawId of raw.evidenceIds) {
        const evidenceId = id(rawId);
        if (!evidenceId || seen.has(evidenceId) || !evidenceIds.has(evidenceId)) errors.push({ id: "hypothesis-evidence-reference-invalid", detail: `hypotheses[${index}] references unknown or duplicate evidence` });
        else { seen.add(evidenceId); refs.push(evidenceId); }
      }
    }
    const verification = [];
    if (!Array.isArray(raw.verification) || raw.verification.length === 0 || raw.verification.length > 12) errors.push({ id: "verification-invalid", detail: `hypotheses[${index}] verification must be non-empty` });
    else for (const [stepIndex, rawStep] of raw.verification.entries()) {
      if (!object(rawStep)) { errors.push({ id: "verification-entry-invalid", detail: `hypotheses[${index}] verification[${stepIndex}] must be an object` }); continue; }
      rejectUnknown(rawStep, ["kind","instruction"], "verification", errors);
      const kind = text(rawStep.kind, 32), instruction = text(rawStep.instruction, 2048);
      if (!kind || !VERIFY_KINDS.has(kind) || !instruction || secretLike(instruction)) errors.push({ id: "verification-fields-invalid", detail: "verification must be bounded INSPECT, TEST, or QUERY without secret-like content" });
      else verification.push({ kind, instruction });
    }
    if (!hypothesisId || hypothesisIds.has(hypothesisId) || !statement || secretLike(statement)) errors.push({ id: "hypothesis-fields-invalid", detail: `hypotheses[${index}] id or statement is invalid` });
    else { hypothesisIds.add(hypothesisId); hypotheses.push({ id: hypothesisId, statement, evidenceIds: refs.sort(), verification }); }
  }

  const resultUnknowns = [];
  if (!Array.isArray(value.unknowns) || value.unknowns.length > 64) errors.push({ id: "unknowns-invalid", detail: "result unknowns must be bounded" });
  else for (const raw of value.unknowns) { const item = text(raw, 1024); if (!item || secretLike(item)) errors.push({ id: "unknown-invalid", detail: "result unknowns contains invalid text" }); else resultUnknowns.push(item); }

  let next = null;
  if (!object(value.recommendedNextStep)) errors.push({ id: "next-step-invalid", detail: "recommendedNextStep must be an object" });
  else {
    rejectUnknown(value.recommendedNextStep, ["kind","instruction"], "recommended-next-step", errors);
    const kind = text(value.recommendedNextStep.kind, 32), instruction = text(value.recommendedNextStep.instruction, 2048);
    if (!kind || !VERIFY_KINDS.has(kind) || !instruction || secretLike(instruction)) errors.push({ id: "next-step-fields-invalid", detail: "recommendedNextStep must be read-only INSPECT, TEST, or QUERY" });
    else next = { kind, instruction };
  }
  if (errors.length || !next) return { valid: false, result: null, errors };
  return {
    valid: true,
    result: {
      version: 1, taskId,
      hypotheses: hypotheses.sort((a,b)=>a.id.localeCompare(b.id)),
      unknowns: resultUnknowns, recommendedNextStep: next,
      incidentResolved: false, rootCauseEstablished: false,
      restartAuthorized: false, rollbackAuthorized: false, deployAuthorized: false,
      providerMutationAuthorized: false, sourceMutationAuthorized: false,
      semantics: "model-generated incident hypotheses bound only to supplied sanitized runtime evidence; no hypothesis establishes root cause or authorizes operational recovery",
    },
    errors: [],
  };
}

/** @param {any} task @param {any} input */
function buildPrompt(task, input) {
  const evidence = [
    { id: "release", source: "release", summary: `release ${input.release.id} commit ${input.release.commit} deployed ${input.release.deployedAt}` },
    { id: "runtime-deployment", source: input.runtimeEvidence.evidence.source, summary: `runtime ${input.runtimeEvidence.runtime.name} commit ${input.runtimeEvidence.deployment.commit} collected ${input.runtimeEvidence.evidence.collectedAt}` },
    ...input.runtimeHealthEvidence.checks.map((/** @type {any} */ check) => ({ id: `health:${check.id}`, source: input.runtimeHealthEvidence.evidence.source, summary: `${check.category} ${check.status}${check.latencyMs === undefined ? "" : ` ${check.latencyMs}ms`}` })),
    ...input.errors.map((/** @type {any} */ item) => ({ id: `error:${item.id}`, source: item.source, summary: `${item.summary} count=${item.count} observed=${item.observedAt}${item.path ? ` path=${item.path}` : ""}` })),
    ...input.metrics.map((/** @type {any} */ item) => ({ id: `metric:${item.id}`, source: item.source, summary: `${item.name}=${item.value} ${item.unit} status=${item.status} observed=${item.observedAt}` })),
  ];
  return {
    system: [
      "You are a read-only production incident analysis agent.",
      "Return one JSON object only. Never claim root cause or incident resolution is established.",
      "Every hypothesis must cite one or more supplied evidenceIds.",
      "Verification steps may only be INSPECT, TEST, or QUERY proposals.",
      "Never propose restart, rollback, deployment, provider mutation, credential access, payment/booking action, migration, or source mutation.",
      "Schema: {version:1,taskId:string,hypotheses:[{id:string,statement:string,evidenceIds:string[],verification:[{kind:'INSPECT'|'TEST'|'QUERY',instruction:string}]}],unknowns:string[],recommendedNextStep:{kind:'INSPECT'|'TEST'|'QUERY',instruction:string}}",
    ].join(" "),
    user: JSON.stringify({ task: { id: task.id, objective: task.objective, repository: task.repository, risk: task.risk }, release: input.release, runtime: input.runtimeEvidence.runtime, evidence, knownUnknowns: input.unknowns }),
  };
}
/** @param {any} task @param {any} rolePolicy @param {any} input @param {any} modelConfig @param {string} backend @param {string} model @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function runAgentIncidentAnalysis(task, rolePolicy, input, modelConfig, backend, model, deps = {}) {
  if (task.role !== "incident") throw new Error("Incident Analysis v1 requires task role incident");
  if (task.id !== input.taskId || task.repository.id !== input.repository.id || task.repository.baseCommit !== input.repository.commit) throw new Error("incident input is not bound to the exact Agent Task repository identity");
  const roleAudit = inspectAgentTaskRolePolicy(task, rolePolicy);
  if (roleAudit.overallStatus !== "PASS" || roleAudit.leaseRequired || task.authority.filesystem !== "READ_ONLY" || task.authority.network !== "NONE") throw new Error("incident task is not authorized by read-only Agent Role Policy v1");
  const prompt = buildPrompt(task, input);
  const request = validateAgentModelRequest({ version: 1, backend, model, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], temperature: 0, maxOutputTokens: 4096, timeoutMs: 60000 });
  if (!request.valid || !request.request) throw new Error("incident model request is invalid");
  const invoke = deps.invoke ?? invokeAgentLocalModel, response = await invoke(modelConfig, request.request);
  let rawResult; try { rawResult = JSON.parse(response.content); } catch { throw new Error("incident model returned non-JSON output"); }
  const validated = validateAgentIncidentResult(rawResult, incidentEvidenceIds(input), task.id);
  if (!validated.valid || !validated.result) throw new Error("incident model output failed Incident Result v1 validation");
  return { ...validated.result, model: { backend: response.backend, model: response.model }, rolePolicyStatus: roleAudit.overallStatus };
}

/** @param {string} filename */
function readJsonFile(filename) {
  const resolved = path.resolve(filename); let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error("incident input file is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_INPUT_BYTES) throw new Error("incident input must be a bounded regular non-symlink file");
  try { return JSON.parse(fs.readFileSync(resolved, "utf8")); } catch { throw new Error("incident input cannot be parsed"); }
}
/** @param {string[]} argv */
function parse(argv) {
  const values = new Map(), flags = new Set(), allowed = new Set(["--task","--role-policy","--input","--model-config","--backend","--model"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]; if (arg === "--json") { if (flags.has(arg)) return null; flags.add(arg); continue; }
    if (!allowed.has(arg ?? "") || values.has(arg)) return null;
    const next = argv[index + 1]; if (typeof next !== "string" || next.startsWith("--")) return null;
    values.set(arg, next); index += 1;
  }
  for (const key of allowed) if (!values.has(key)) return null;
  return { values, json: flags.has("--json") };
}

/** @param {string[]} argv @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/agent-incident-analysis.js --task <task.json> --role-policy <roles.json> --input <incident-input.json> --model-config <models.json> --backend <id> --model <id> [--json]"); return 1; }
  try {
    const taskRaw = readJsonFile(options.values.get("--task")), roleRaw = readJsonFile(options.values.get("--role-policy")), inputRaw = readJsonFile(options.values.get("--input"));
    const taskResult = validateAgentTask(taskRaw), roleResult = validateAgentRolePolicy(roleRaw), inputResult = validateAgentIncidentInput(inputRaw);
    if (!taskResult.valid || !taskResult.task || !roleResult.valid || !roleResult.policy || !inputResult.valid || !inputResult.input) throw new Error("incident task, role policy, or input is invalid");
    const modelConfig = readAgentModelConfigFile(options.values.get("--model-config"));
    const result = await runAgentIncidentAnalysis(taskResult.task, roleResult.policy, inputResult.input, modelConfig, options.values.get("--backend"), options.values.get("--model"), deps);
    console.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "agent incident analysis failed");
    return 1;
  }
}
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = await main();
