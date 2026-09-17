#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateAgentTask } from "./agent-task.js";
import { validateAgentRolePolicy, inspectAgentTaskRolePolicy } from "./agent-role-policy.js";
import { readAgentModelConfigFile, validateAgentModelRequest, invokeAgentLocalModel } from "./agent-local-model.js";
import { isFullObjectId } from "./runtime-evidence.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EVIDENCE_STATUS = new Set(["INFO", "PASS", "WARN", "FAIL", "UNVERIFIED"]);
const VERIFY_KINDS = new Set(["INSPECT", "TEST", "QUERY"]);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] @param {boolean} [singleLine] */
function text(value, max = 2048, singleLine = true) { if (typeof value !== "string") return null; const v = value.trim(); if (v.length === 0 || v.length > max || v.includes("\u0000")) return null; if (singleLine && /[\r\n]/.test(v)) return null; return v; }
/** @param {unknown} value */
function id(value) { const v = text(value, 128); return v && ID.test(v) ? v : null; }
/** @param {unknown} value */
function safePath(value) { const v = text(value, 512); if (!v || v.startsWith("/") || v.includes("\\")) return null; const n = path.posix.normalize(v); return n !== "." && n !== ".." && !n.startsWith("../") && n === v ? v : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }

/** @param {unknown} value */
export function validateAgentDiagnosisInput(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, input: null, errors: [{ id: "input-invalid", detail: "diagnosis input must be an object" }] };
  unknown(value, ["version", "taskId", "repository", "evidence", "changedFiles", "unknowns"], "input", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "diagnosis input version must be exactly 1" });
  const taskId = id(value.taskId); if (!taskId) errors.push({ id: "task-id-invalid", detail: "taskId must be portable" });
  let repository = null;
  if (!object(value.repository)) errors.push({ id: "repository-invalid", detail: "repository must be an object" });
  else {
    unknown(value.repository, ["id", "commit"], "repository", errors);
    const repositoryId = id(value.repository.id), commit = text(value.repository.commit, 128)?.toLowerCase() ?? null;
    if (!repositoryId || !commit || !isFullObjectId(commit)) errors.push({ id: "repository-fields-invalid", detail: "repository requires portable id and full commit" });
    else repository = { id: repositoryId, commit };
  }
  /** @type {Array<{id:string,source:string,status:string,summary:string,path?:string}>} */ const evidence = [];
  const evidenceIds = new Set();
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > 256) errors.push({ id: "evidence-invalid", detail: "evidence must be a non-empty bounded array" });
  else for (const [index, raw] of value.evidence.entries()) {
    if (!object(raw)) { errors.push({ id: "evidence-entry-invalid", detail: `evidence[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "source", "status", "summary", "path"], "evidence-entry", errors);
    const evidenceId = id(raw.id), source = id(raw.source), status = text(raw.status, 32), summary = text(raw.summary, 2048), evidencePath = raw.path === undefined ? null : safePath(raw.path);
    if (!evidenceId || evidenceIds.has(evidenceId) || !source || !status || !EVIDENCE_STATUS.has(status) || !summary || (raw.path !== undefined && !evidencePath)) { errors.push({ id: "evidence-fields-invalid", detail: `evidence[${index}] has invalid or duplicate fields` }); continue; }
    evidenceIds.add(evidenceId); evidence.push({ id: evidenceId, source, status, summary, ...(evidencePath ? { path: evidencePath } : {}) });
  }
  /** @type {string[]} */ const changedFiles = [];
  if (!Array.isArray(value.changedFiles) || value.changedFiles.length > 512) errors.push({ id: "changed-files-invalid", detail: "changedFiles must be a bounded array" });
  else {
    const seen = new Set();
    for (const raw of value.changedFiles) { const file = safePath(raw); if (!file || seen.has(file)) { errors.push({ id: "changed-file-invalid", detail: "changedFiles contains unsafe or duplicate paths" }); continue; } seen.add(file); changedFiles.push(file); }
  }
  /** @type {string[]} */ const inputUnknowns = [];
  if (!Array.isArray(value.unknowns) || value.unknowns.length > 64) errors.push({ id: "unknowns-invalid", detail: "unknowns must be a bounded array" });
  else for (const raw of value.unknowns) { const item = text(raw, 1024); if (!item) errors.push({ id: "unknown-invalid", detail: "unknowns contains invalid text" }); else inputUnknowns.push(item); }
  if (errors.length > 0 || !taskId || !repository) return { valid: false, input: null, errors };
  return { valid: true, input: { version: 1, taskId, repository, evidence: evidence.sort((a, b) => a.id.localeCompare(b.id)), changedFiles: changedFiles.sort(), unknowns: inputUnknowns }, errors: [] };
}

/** @param {unknown} value @param {Set<string>} allowedEvidenceIds @param {string} taskId */
export function validateAgentDiagnosisResult(value, allowedEvidenceIds, taskId) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, result: null, errors: [{ id: "result-invalid", detail: "diagnosis result must be an object" }] };
  unknown(value, ["version", "taskId", "hypotheses", "unknowns", "recommendedNextStep"], "result", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "diagnosis result version must be exactly 1" });
  if (value.taskId !== taskId) errors.push({ id: "task-binding-invalid", detail: "diagnosis result taskId must equal the evaluated task" });
  /** @type {Array<any>} */ const hypotheses = [];
  const hypothesisIds = new Set();
  if (!Array.isArray(value.hypotheses) || value.hypotheses.length === 0 || value.hypotheses.length > 12) errors.push({ id: "hypotheses-invalid", detail: "hypotheses must be a non-empty bounded array" });
  else for (const [index, raw] of value.hypotheses.entries()) {
    if (!object(raw)) { errors.push({ id: "hypothesis-invalid", detail: `hypotheses[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "statement", "evidenceIds", "verification"], "hypothesis", errors);
    const hypothesisId = id(raw.id), statement = text(raw.statement, 2048);
    const evidenceIds = [];
    if (!Array.isArray(raw.evidenceIds) || raw.evidenceIds.length === 0 || raw.evidenceIds.length > 64) errors.push({ id: "hypothesis-evidence-invalid", detail: `hypotheses[${index}].evidenceIds must be non-empty` });
    else {
      const seen = new Set();
      for (const rawId of raw.evidenceIds) { const evidenceId = id(rawId); if (!evidenceId || seen.has(evidenceId) || !allowedEvidenceIds.has(evidenceId)) { errors.push({ id: "hypothesis-evidence-reference-invalid", detail: `hypotheses[${index}] references unknown or duplicate evidence` }); continue; } seen.add(evidenceId); evidenceIds.push(evidenceId); }
    }
    const verification = [];
    if (!Array.isArray(raw.verification) || raw.verification.length === 0 || raw.verification.length > 12) errors.push({ id: "hypothesis-verification-invalid", detail: `hypotheses[${index}].verification must be non-empty` });
    else for (const [stepIndex, step] of raw.verification.entries()) {
      if (!object(step)) { errors.push({ id: "verification-invalid", detail: `hypotheses[${index}].verification[${stepIndex}] must be an object` }); continue; }
      unknown(step, ["kind", "instruction"], "verification", errors);
      const kind = text(step.kind, 32), instruction = text(step.instruction, 2048);
      if (!kind || !VERIFY_KINDS.has(kind) || !instruction) errors.push({ id: "verification-fields-invalid", detail: `hypotheses[${index}].verification[${stepIndex}] is invalid` });
      else verification.push({ kind, instruction });
    }
    if (!hypothesisId || hypothesisIds.has(hypothesisId) || !statement) errors.push({ id: "hypothesis-fields-invalid", detail: `hypotheses[${index}] has invalid or duplicate id/statement` });
    else { hypothesisIds.add(hypothesisId); hypotheses.push({ id: hypothesisId, statement, evidenceIds: [...new Set(evidenceIds)].sort(), verification }); }
  }
  const resultUnknowns = [];
  if (!Array.isArray(value.unknowns) || value.unknowns.length > 64) errors.push({ id: "result-unknowns-invalid", detail: "result unknowns must be a bounded array" });
  else for (const raw of value.unknowns) { const item = text(raw, 1024); if (!item) errors.push({ id: "result-unknown-invalid", detail: "result unknowns contains invalid text" }); else resultUnknowns.push(item); }
  let recommendedNextStep = null;
  if (!object(value.recommendedNextStep)) errors.push({ id: "next-step-invalid", detail: "recommendedNextStep must be an object" });
  else {
    unknown(value.recommendedNextStep, ["kind", "instruction"], "recommended-next-step", errors);
    const kind = text(value.recommendedNextStep.kind, 32), instruction = text(value.recommendedNextStep.instruction, 2048);
    if (!kind || !VERIFY_KINDS.has(kind) || !instruction) errors.push({ id: "next-step-fields-invalid", detail: "recommendedNextStep requires INSPECT, TEST, or QUERY and bounded instruction" });
    else recommendedNextStep = { kind, instruction };
  }
  if (errors.length > 0 || !recommendedNextStep) return { valid: false, result: null, errors };
  return { valid: true, result: { version: 1, taskId, hypotheses: hypotheses.sort((a, b) => a.id.localeCompare(b.id)), unknowns: resultUnknowns, recommendedNextStep, executionAuthorized: false, sourceMutationAuthorized: false, rootCauseEstablished: false, semantics: "model-generated hypotheses bound only to explicit supplied evidence; verification is required before treating any hypothesis as root cause" }, errors: [] };
}

/** @param {string} filename */
function readJsonFile(filename) { const resolved = path.resolve(filename); let stat; try { stat = fs.lstatSync(resolved); } catch { throw new Error("diagnosis input file is unavailable"); } if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_INPUT_BYTES) throw new Error("diagnosis input must be a bounded regular non-symlink file"); try { return JSON.parse(fs.readFileSync(resolved, "utf8")); } catch { throw new Error("diagnosis input cannot be parsed"); } }

/** @param {any} task @param {any} input */
function buildPrompt(task, input) {
  const payload = { task: { id: task.id, objective: task.objective, repository: task.repository, risk: task.risk, requiredChecks: task.scope.requiredChecks }, evidence: input.evidence, changedFiles: input.changedFiles, knownUnknowns: input.unknowns };
  const system = [
    "You are a read-only software diagnosis agent.",
    "Return one JSON object only. Never claim root cause is proven.",
    "Every hypothesis must cite one or more evidenceIds that exist in the supplied evidence.",
    "Verification steps are proposals only and must use kind INSPECT, TEST, or QUERY.",
    "Do not propose source mutation, merge, deployment, credential access, payment/booking action, migration, or production mutation.",
    "Schema: {version:1,taskId:string,hypotheses:[{id:string,statement:string,evidenceIds:string[],verification:[{kind:'INSPECT'|'TEST'|'QUERY',instruction:string}]}],unknowns:string[],recommendedNextStep:{kind:'INSPECT'|'TEST'|'QUERY',instruction:string}}",
  ].join(" ");
  return { system, user: JSON.stringify(payload) };
}

/** @param {any} task @param {any} rolePolicy @param {any} input @param {any} modelConfig @param {string} backend @param {string} model @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function runAgentDiagnosis(task, rolePolicy, input, modelConfig, backend, model, deps = {}) {
  if (task.role !== "diagnose") throw new Error("Agent Diagnosis v1 requires task role diagnose");
  if (task.id !== input.taskId || task.repository.id !== input.repository.id || task.repository.baseCommit !== input.repository.commit) throw new Error("diagnosis input is not bound to the exact Agent Task repository identity");
  const roleAudit = inspectAgentTaskRolePolicy(task, rolePolicy); if (roleAudit.overallStatus !== "PASS" || roleAudit.leaseRequired) throw new Error("diagnosis task is not authorized by read-only Agent Role Policy v1");
  const prompt = buildPrompt(task, input);
  const rawRequest = { version: 1, backend, model, messages: [{ role: "system", content: prompt.system }, { role: "user", content: prompt.user }], temperature: 0, maxOutputTokens: 2048, timeoutMs: 60000 };
  const request = validateAgentModelRequest(rawRequest); if (!request.valid || !request.request) throw new Error("diagnosis model request is invalid");
  const invoke = deps.invoke ?? invokeAgentLocalModel;
  const response = await invoke(modelConfig, request.request);
  let rawResult; try { rawResult = JSON.parse(response.content); } catch { throw new Error("diagnosis model returned non-JSON output"); }
  const validated = validateAgentDiagnosisResult(rawResult, new Set(input.evidence.map((/** @type {any} */ item) => item.id)), task.id);
  if (!validated.valid || !validated.result) throw new Error("diagnosis model output failed Agent Diagnosis Result v1 validation");
  return { ...validated.result, model: { backend: response.backend, model: response.model }, rolePolicyStatus: roleAudit.overallStatus };
}

/** @param {string[]} argv */
function parse(argv) { const values = new Map(), flags = new Set(), allowed = new Set(["--task", "--role-policy", "--input", "--model-config", "--backend", "--model"]); for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { if (flags.has(arg)) return null; flags.add(arg); continue; } if (!allowed.has(arg ?? "") || values.has(arg)) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; values.set(arg, next); i += 1; } for (const key of allowed) if (!values.has(key)) return null; return { values, json: flags.has("--json") }; }

/** @param {string[]} argv @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function main(argv = process.argv.slice(2), deps = {}) {
  const options = parse(argv); if (!options) { console.error("Usage: node scripts/agent-diagnosis.js --task <task.json> --role-policy <role-policy.json> --input <diagnosis-input.json> --model-config <private-models.json> --backend <id> --model <id> [--json]"); return 1; }
  try {
    const taskRaw = readJsonFile(options.values.get("--task")), roleRaw = readJsonFile(options.values.get("--role-policy")), inputRaw = readJsonFile(options.values.get("--input"));
    const taskResult = validateAgentTask(taskRaw), roleResult = validateAgentRolePolicy(roleRaw), inputResult = validateAgentDiagnosisInput(inputRaw);
    if (!taskResult.valid || !taskResult.task || !roleResult.valid || !roleResult.policy || !inputResult.valid || !inputResult.input) throw new Error("diagnosis task, role policy, or evidence input is invalid");
    const modelConfig = readAgentModelConfigFile(options.values.get("--model-config"));
    const result = await runAgentDiagnosis(taskResult.task, roleResult.policy, inputResult.input, modelConfig, options.values.get("--backend"), options.values.get("--model"), deps);
    console.log(options.json ? JSON.stringify(result) : JSON.stringify(result, null, 2));
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : "agent diagnosis failed"); return 1; }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = await main();
