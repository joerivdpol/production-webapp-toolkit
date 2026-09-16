#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp, isFullObjectId, validateRuntimeEvidence } from "./runtime-evidence.js";

const KIND_SCOPE = Object.freeze({
  checkout: "checkout",
  application: "application-reported",
  container: "container",
  process: "process",
});
/** @param {string} kind */
function identityScope(kind) {
  if (kind === "checkout") return "checkout";
  if (kind === "application") return "application-reported";
  if (kind === "container") return "container";
  if (kind === "process") return "process";
  return null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value */
function text(value) { return typeof value === "string" && value.trim().length > 0 ? value.trim() : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
}

/** @param {unknown} value */
export function validateRuntimeCollectorObservation(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, observation: null, errors: [{ id: "observation-invalid", detail: "runtime collector observation must be an object" }] };
  rejectUnknown(value, ["version", "collector", "runtime", "deployment"], "observation", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let collector = null;
  if (!object(value.collector)) errors.push({ id: "collector-invalid", detail: "collector must be an object" });
  else {
    rejectUnknown(value.collector, ["kind", "source", "authenticated", "collectedAt"], "collector", errors);
    const kind = text(value.collector.kind), source = text(value.collector.source), collectedAt = text(value.collector.collectedAt);
    if (!kind || !(kind in KIND_SCOPE)) errors.push({ id: "collector-kind-invalid", detail: "collector.kind must be checkout, application, container, or process" });
    if (!source) errors.push({ id: "collector-source-invalid", detail: "collector.source must be a non-empty string" });
    if (typeof value.collector.authenticated !== "boolean") errors.push({ id: "collector-authenticated-invalid", detail: "collector.authenticated must be boolean" });
    if (!collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) errors.push({ id: "collector-collected-at-invalid", detail: "collector.collectedAt must be an absolute ISO timestamp" });
    if (kind && kind in KIND_SCOPE && source && typeof value.collector.authenticated === "boolean" && collectedAt && isAbsoluteIsoTimestamp(collectedAt)) {
      collector = { kind, source, authenticated: value.collector.authenticated, collectedAt };
    }
  }

  let runtime = null;
  if (!object(value.runtime)) errors.push({ id: "runtime-invalid", detail: "runtime must be an object" });
  else {
    rejectUnknown(value.runtime, ["name", "environment"], "runtime", errors);
    const name = text(value.runtime.name);
    const environment = value.runtime.environment === undefined ? null : text(value.runtime.environment);
    if (!name) errors.push({ id: "runtime-name-invalid", detail: "runtime.name must be a non-empty string" });
    if (value.runtime.environment !== undefined && !environment) errors.push({ id: "runtime-environment-invalid", detail: "runtime.environment must be non-empty when supplied" });
    if (name && (value.runtime.environment === undefined || environment)) runtime = { name, ...(environment ? { environment } : {}) };
  }

  let deployment = null;
  if (!object(value.deployment)) errors.push({ id: "deployment-invalid", detail: "deployment must be an object" });
  else {
    rejectUnknown(value.deployment, ["commit"], "deployment", errors);
    const commit = text(value.deployment.commit);
    if (!commit || !isFullObjectId(commit)) errors.push({ id: "deployment-commit-invalid", detail: "deployment.commit must be a full Git object ID" });
    else deployment = { commit: commit.toLowerCase() };
  }

  if (errors.length > 0 || collector === null || runtime === null || deployment === null) return { valid: false, observation: null, errors };
  return { valid: true, observation: { version: 1, collector, runtime, deployment }, errors: [] };
}

/** @param {any} observation */
export function adaptRuntimeCollectorObservation(observation) {
  const validation = validateRuntimeCollectorObservation(observation);
  if (!validation.valid || !validation.observation) return { valid: false, evidence: null, errors: validation.errors };
  const normalized = validation.observation;
  const canonical = {
    version: 1,
    runtime: normalized.runtime,
    deployment: normalized.deployment,
    evidence: {
      source: normalized.collector.source,
      authenticated: normalized.collector.authenticated,
      collectedAt: normalized.collector.collectedAt,
    },
    metadata: {
      collector: {
        kind: normalized.collector.kind,
        identityScope: identityScope(normalized.collector.kind),
      },
    },
  };
  const result = validateRuntimeEvidence(canonical);
  if (!result.valid || !result.evidence) return { valid: false, evidence: null, errors: result.errors };
  return { valid: true, evidence: result.evidence, errors: [] };
}

/** @param {ReturnType<typeof adaptRuntimeCollectorObservation>} result */
export function formatRuntimeCollectorAdapter(result) {
  if (!result.valid || !result.evidence) return ["Runtime collector adapter", "", "Result: INVALID", ...result.errors.map((error) => `ERROR  ${error.id}  ${error.detail}`)].join("\n");
  const collector = /** @type {any} */ (result.evidence.metadata?.collector);
  return [
    "Runtime collector adapter",
    "",
    `Collector kind: ${collector?.kind ?? "(unknown)"}`,
    `Identity scope: ${collector?.identityScope ?? "(unknown)"}`,
    `Runtime: ${result.evidence.runtime.name}`,
    `Commit: ${result.evidence.deployment.commit}`,
    `Source: ${result.evidence.evidence.source}`,
    `Authenticated: ${result.evidence.evidence.authenticated}`,
    `Collected at: ${result.evidence.evidence.collectedAt}`,
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parse(argv) {
  let file = null, json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") { json = true; continue; }
    if (arg !== "--file" || file !== null) return null;
    const value = argv[i + 1];
    if (typeof value !== "string" || value.startsWith("--") || value.length === 0) return null;
    file = value; i += 1;
  }
  return file ? { file, json } : null;
}
export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/runtime-collector-adapter.js --file <collector-observation.json> [--json]"); return 1; }
  let input;
  try { input = JSON.parse(fs.readFileSync(options.file, "utf8")); }
  catch { console.error("Runtime collector observation file cannot be read or parsed"); return 1; }
  const result = adaptRuntimeCollectorObservation(input);
  if (options.json) console.log(JSON.stringify(result));
  else console.log(formatRuntimeCollectorAdapter(result));
  return result.valid ? 0 : 1;
}
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
