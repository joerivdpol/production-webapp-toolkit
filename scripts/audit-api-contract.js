#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateApiContractSnapshot } from "./api-contract-snapshot.js";

/** @typedef {{ type: string, nullable: boolean, enum?: Array<string|number|boolean>, properties?: Record<string, ApiSchema>, required?: string[], additionalProperties?: boolean, items?: ApiSchema }} ApiSchema */
/** @typedef {{ method: string, path: string, parameters: Array<{name:string,in:string,required:boolean,schema:ApiSchema}>, body: any, responses: any[] }} ApiOperation */
/** @typedef {{ id: string, status: "PASS"|"WARN"|"FAIL", operation: string, location: string, detail: string }} ApiCheck */

/** @param {unknown} value */
function enumKey(value) {
  return `${typeof value}:${String(value)}`;
}

/** @param {ApiCheck[]} checks @param {"WARN"|"FAIL"} status @param {string} id @param {string} operation @param {string} location @param {string} detail */
function issue(checks, status, id, operation, location, detail) {
  checks.push({ id, status, operation, location, detail });
}

/** @param {ApiSchema} baseline @param {ApiSchema} candidate @param {string} operation @param {string} location @param {ApiCheck[]} checks */
function compareRequestSchema(baseline, candidate, operation, location, checks) {
  if (baseline.type !== candidate.type) {
    issue(checks, "FAIL", "request-type-changed", operation, location, "request schema type changed");
    return;
  }
  if (baseline.nullable && !candidate.nullable) issue(checks, "FAIL", "request-nullability-narrowed", operation, location, "request schema no longer accepts null");
  const baseEnum = baseline.enum?.map(enumKey) ?? null;
  const candidateEnum = candidate.enum?.map(enumKey) ?? null;
  if (baseEnum === null && candidateEnum !== null) {
    issue(checks, "FAIL", "request-enum-narrowed", operation, location, "request schema introduced an enum restriction");
  } else if (baseEnum !== null && candidateEnum !== null && baseEnum.some((value) => !candidateEnum.includes(value))) {
    issue(checks, "FAIL", "request-enum-narrowed", operation, location, "request schema removed previously accepted enum values");
  }
  if (baseline.type === "array" && baseline.items && candidate.items) {
    compareRequestSchema(baseline.items, candidate.items, operation, `${location}[]`, checks);
    return;
  }
  if (baseline.type !== "object" || !baseline.properties || !candidate.properties) return;
  const baseRequired = new Set(baseline.required ?? []);
  const candidateRequired = new Set(candidate.required ?? []);
  for (const name of candidateRequired) {
    if (!baseRequired.has(name)) issue(checks, "FAIL", "request-required-added", operation, `${location}.${name}`, "candidate requires a property that was not previously required");
  }
  if (baseline.additionalProperties && !candidate.additionalProperties) {
    issue(checks, "FAIL", "request-additional-properties-narrowed", operation, location, "candidate no longer accepts additional request properties");
  }
  for (const [name, baseProperty] of Object.entries(baseline.properties)) {
    const candidateProperty = candidate.properties[name];
    if (!candidateProperty) {
      if (!candidate.additionalProperties) issue(checks, "FAIL", "request-property-removed", operation, `${location}.${name}`, "candidate no longer declares or accepts a previous request property");
      continue;
    }
    compareRequestSchema(baseProperty, candidateProperty, operation, `${location}.${name}`, checks);
  }
}

/** @param {ApiSchema} baseline @param {ApiSchema} candidate @param {string} operation @param {string} location @param {ApiCheck[]} checks */
function compareResponseSchema(baseline, candidate, operation, location, checks) {
  if (baseline.type !== candidate.type) {
    issue(checks, "FAIL", "response-type-changed", operation, location, "response schema type changed");
    return;
  }
  if (!baseline.nullable && candidate.nullable) issue(checks, "FAIL", "response-nullability-widened", operation, location, "response may now produce null");
  const baseEnum = baseline.enum?.map(enumKey) ?? null;
  const candidateEnum = candidate.enum?.map(enumKey) ?? null;
  if (baseEnum !== null && candidateEnum === null) {
    issue(checks, "FAIL", "response-enum-widened", operation, location, "response enum restriction was removed");
  } else if (baseEnum !== null && candidateEnum !== null && candidateEnum.some((value) => !baseEnum.includes(value))) {
    issue(checks, "FAIL", "response-enum-widened", operation, location, "response may now produce new enum values");
  }
  if (baseline.type === "array" && baseline.items && candidate.items) {
    compareResponseSchema(baseline.items, candidate.items, operation, `${location}[]`, checks);
    return;
  }
  if (baseline.type !== "object" || !baseline.properties || !candidate.properties) return;
  const baseRequired = new Set(baseline.required ?? []);
  const candidateRequired = new Set(candidate.required ?? []);
  for (const name of baseRequired) {
    if (!candidateRequired.has(name) || !candidate.properties[name]) {
      issue(checks, "FAIL", "response-required-removed", operation, `${location}.${name}`, "candidate no longer guarantees a required response property");
    }
  }
  if (!baseline.additionalProperties && candidate.additionalProperties) {
    issue(checks, "FAIL", "response-additional-properties-widened", operation, location, "candidate may now produce undeclared response properties");
  }
  for (const [name, baseProperty] of Object.entries(baseline.properties)) {
    const candidateProperty = candidate.properties[name];
    if (candidateProperty) compareResponseSchema(baseProperty, candidateProperty, operation, `${location}.${name}`, checks);
  }
  if (!baseline.additionalProperties) {
    for (const name of Object.keys(candidate.properties)) {
      if (!(name in baseline.properties)) issue(checks, "FAIL", "response-property-added", operation, `${location}.${name}`, "candidate added a response property outside the closed baseline object");
    }
  }
}

/** @param {ApiOperation} baseline @param {ApiOperation} candidate @param {ApiCheck[]} checks */
function compareOperation(baseline, candidate, checks) {
  const operation = `${baseline.method} ${baseline.path}`;
  const baselineParams = new Map(baseline.parameters.map((item) => [`${item.in}:${item.name.toLowerCase()}`, item]));
  const candidateParams = new Map(candidate.parameters.map((item) => [`${item.in}:${item.name.toLowerCase()}`, item]));
  for (const [key, baseParam] of baselineParams) {
    const candidateParam = candidateParams.get(key);
    if (!candidateParam) {
      issue(checks, "FAIL", "request-parameter-removed", operation, `parameter:${key}`, "candidate removed a previously declared request parameter");
      continue;
    }
    if (!baseParam.required && candidateParam.required) issue(checks, "FAIL", "request-parameter-required", operation, `parameter:${key}`, "candidate made an optional parameter required");
    compareRequestSchema(baseParam.schema, candidateParam.schema, operation, `parameter:${key}`, checks);
  }
  for (const [key, candidateParam] of candidateParams) {
    if (!baselineParams.has(key) && candidateParam.required) issue(checks, "FAIL", "request-required-parameter-added", operation, `parameter:${key}`, "candidate added a required request parameter");
  }

  if (baseline.body === null && candidate.body?.required) issue(checks, "FAIL", "request-body-required-added", operation, "body", "candidate introduced a required request body");
  if (baseline.body !== null && candidate.body === null) issue(checks, "FAIL", "request-body-removed", operation, "body", "candidate removed a previously declared request body");
  if (baseline.body !== null && candidate.body !== null) {
    if (!baseline.body.required && candidate.body.required) issue(checks, "FAIL", "request-body-required", operation, "body", "candidate made request body required");
    if (baseline.body.mediaType !== candidate.body.mediaType) issue(checks, "FAIL", "request-media-type-changed", operation, "body", "request body media type changed");
    compareRequestSchema(baseline.body.schema, candidate.body.schema, operation, "body", checks);
  }

  const baselineResponses = new Map(baseline.responses.map((item) => [`${item.status}:${item.mediaType}`, item]));
  const candidateResponses = new Map(candidate.responses.map((item) => [`${item.status}:${item.mediaType}`, item]));
  for (const [key, baseResponse] of baselineResponses) {
    const candidateResponse = candidateResponses.get(key);
    if (!candidateResponse) {
      issue(checks, "FAIL", "response-removed", operation, `response:${key}`, "candidate removed a baseline response contract");
      continue;
    }
    if (baseResponse.schema === null && candidateResponse.schema !== null) issue(checks, "FAIL", "response-body-added", operation, `response:${key}`, "candidate added a response body where baseline declared none");
    else if (baseResponse.schema !== null && candidateResponse.schema === null) issue(checks, "FAIL", "response-body-removed", operation, `response:${key}`, "candidate removed a baseline response body");
    else if (baseResponse.schema !== null && candidateResponse.schema !== null) compareResponseSchema(baseResponse.schema, candidateResponse.schema, operation, `response:${key}`, checks);
  }
  for (const key of candidateResponses.keys()) {
    if (!baselineResponses.has(key)) issue(checks, "WARN", "response-added", operation, `response:${key}`, "candidate declares an additional response status or media type");
  }
}

/** @param {{kind:string,service:{name:string},evidence:any,operations:ApiOperation[]}} baseline @param {{kind:string,service:{name:string},evidence:any,operations:ApiOperation[]}} candidate */
export function inspectApiContractCompatibility(baseline, candidate) {
  /** @type {ApiCheck[]} */
  const checks = [];
  if (baseline.kind !== "baseline" || candidate.kind !== "candidate") {
    issue(checks, "FAIL", "snapshot-kind-invalid", "contract", "kind", "comparison requires baseline and candidate snapshots");
  }
  if (baseline.service.name !== candidate.service.name) {
    issue(checks, "FAIL", "service-identity-mismatch", "contract", "service", "candidate belongs to a different service identity");
  }
  if (checks.some((check) => check.status === "FAIL")) {
    return buildReport(baseline, candidate, checks);
  }

  const candidateOperations = new Map(candidate.operations.map((item) => [`${item.method} ${item.path}`, item]));
  const baselineKeys = new Set();
  for (const operation of baseline.operations) {
    const key = `${operation.method} ${operation.path}`;
    baselineKeys.add(key);
    const candidateOperation = candidateOperations.get(key);
    if (!candidateOperation) {
      issue(checks, "FAIL", "operation-removed", key, "operation", "candidate removed a baseline operation");
      continue;
    }
    const before = checks.length;
    compareOperation(operation, candidateOperation, checks);
    if (checks.length === before) checks.push({ id: "operation-compatible", status: "PASS", operation: key, location: "operation", detail: "baseline operation remains compatible" });
  }
  for (const operation of candidate.operations) {
    const key = `${operation.method} ${operation.path}`;
    if (!baselineKeys.has(key)) checks.push({ id: "operation-added", status: "PASS", operation: key, location: "operation", detail: "candidate added an operation" });
  }
  return buildReport(baseline, candidate, checks);
}

/** @param {any} baseline @param {any} candidate @param {ApiCheck[]} checks */
function buildReport(baseline, candidate, checks) {
  const pass = checks.filter((check) => check.status === "PASS").length;
  const warn = checks.filter((check) => check.status === "WARN").length;
  const fail = checks.filter((check) => check.status === "FAIL").length;
  return {
    service: baseline.service?.name ?? null,
    baselineEvidence: baseline.evidence ?? null,
    candidateEvidence: candidate.evidence ?? null,
    checks,
    summary: { pass, warn, fail },
    compatibilityStatus: fail > 0 ? "BREAKING" : "COMPATIBLE",
    technicalStatus: "PASS",
    overallStatus: fail > 0 ? "FAIL" : warn > 0 ? "WARN" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectApiContractCompatibility>} report */
export function formatApiContractAudit(report) {
  const lines = [
    "API contract compatibility audit",
    "",
    `Service: ${report.service}`,
    `Baseline source: ${report.baselineEvidence?.source ?? "(unavailable)"}`,
    `Candidate source: ${report.candidateEvidence?.source ?? "(unavailable)"}`,
    "",
  ];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.operation}  ${check.location}  ${check.detail}`);
  lines.push(
    "",
    `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`,
    `Compatibility: ${report.compatibilityStatus}`,
    `Technical: ${report.technicalStatus}`,
    `Overall: ${report.overallStatus}`,
  );
  return lines.join("\n");
}

/** @param {string} filename */
function readSnapshot(filename) {
  let value;
  try { value = JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch { return { ok: false, snapshot: null }; }
  return validateApiContractSnapshot(value);
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let baselineFile = null;
  let candidateFile = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--baseline-file", "--candidate-file"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--baseline-file") { if (baselineFile !== null) return null; baselineFile = value; }
    else { if (candidateFile !== null) return null; candidateFile = value; }
  }
  return baselineFile && candidateFile ? { baselineFile, candidateFile, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/audit-api-contract.js --baseline-file <baseline.json> --candidate-file <candidate.json> [--json]");
    return 1;
  }
  const baseline = readSnapshot(options.baselineFile);
  const candidate = readSnapshot(options.candidateFile);
  if (!baseline.ok || baseline.snapshot === null || !candidate.ok || candidate.snapshot === null) {
    console.error("API contract snapshot input is invalid");
    return 1;
  }
  const report = inspectApiContractCompatibility(baseline.snapshot, candidate.snapshot);
  console.log(options.json ? JSON.stringify(report) : formatApiContractAudit(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
