#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const CATEGORIES = new Set(["http", "database", "upstream", "queue", "job", "custom"]);
const STATUSES = new Set(["HEALTHY", "DEGRADED", "UNHEALTHY", "UNKNOWN"]);

/** @typedef {{ id:string, category:string, status:string, latencyMs?:number }} RuntimeHealthCheck */
/** @typedef {{ version:1, runtime:{name:string,environment?:string}, evidence:{source:string,authenticated:boolean,collectedAt:string}, checks:RuntimeHealthCheck[] }} RuntimeHealthEvidence */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value @param {number} [max] */
function text(value, max = 255) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}

/** @param {unknown} value */
function checkId(value) {
  const normalized = text(value, 128);
  return normalized && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(normalized) ? normalized : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed */
function hasOnly(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** @param {unknown} value */
export function validateRuntimeHealthEvidence(value) {
  if (!plainObject(value)) return { valid: false, evidence: null, error: "runtime health evidence must be an object" };
  if (!hasOnly(value, ["version", "runtime", "evidence", "checks"])) return { valid: false, evidence: null, error: "runtime health evidence contains unsupported fields" };
  if (value.version !== 1) return { valid: false, evidence: null, error: "runtime health evidence version must be exactly 1" };

  if (!plainObject(value.runtime) || !hasOnly(value.runtime, ["name", "environment"])) {
    return { valid: false, evidence: null, error: "runtime must be an object with only name and optional environment" };
  }
  const runtimeName = text(value.runtime.name, 128);
  const environment = value.runtime.environment === undefined ? null : text(value.runtime.environment, 128);
  if (!runtimeName) return { valid: false, evidence: null, error: "runtime.name must be a bounded non-empty string" };
  if (value.runtime.environment !== undefined && !environment) return { valid: false, evidence: null, error: "runtime.environment must be a bounded non-empty string when supplied" };

  if (!plainObject(value.evidence) || !hasOnly(value.evidence, ["source", "authenticated", "collectedAt"])) {
    return { valid: false, evidence: null, error: "evidence must contain only source authenticated and collectedAt" };
  }
  const source = text(value.evidence.source, 255);
  const collectedAt = text(value.evidence.collectedAt, 64);
  if (!source || typeof value.evidence.authenticated !== "boolean" || !collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) {
    return { valid: false, evidence: null, error: "evidence requires source boolean authenticated and absolute collectedAt" };
  }

  if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > 256) {
    return { valid: false, evidence: null, error: "checks must be a non-empty bounded array" };
  }
  /** @type {RuntimeHealthCheck[]} */
  const checks = [];
  const ids = new Set();
  for (const [index, raw] of value.checks.entries()) {
    if (!plainObject(raw) || !hasOnly(raw, ["id", "category", "status", "latencyMs"])) {
      return { valid: false, evidence: null, error: `checks[${index}] contains unsupported fields` };
    }
    const id = checkId(raw.id);
    const category = text(raw.category, 32)?.toLowerCase() ?? null;
    const status = text(raw.status, 32)?.toUpperCase() ?? null;
    if (!id || !category || !CATEGORIES.has(category) || !status || !STATUSES.has(status)) {
      return { valid: false, evidence: null, error: `checks[${index}] has invalid id category or status` };
    }
    if (ids.has(id)) return { valid: false, evidence: null, error: `duplicate health check id ${id}` };
    ids.add(id);
    let latencyMs;
    if (raw.latencyMs !== undefined) {
      if (!Number.isInteger(raw.latencyMs) || Number(raw.latencyMs) < 0 || Number(raw.latencyMs) > 86_400_000) {
        return { valid: false, evidence: null, error: `checks[${index}].latencyMs must be a bounded non-negative integer` };
      }
      latencyMs = Number(raw.latencyMs);
    }
    checks.push({ id, category, status, ...(latencyMs === undefined ? {} : { latencyMs }) });
  }
  checks.sort((a, b) => a.id.localeCompare(b.id));
  return {
    valid: true,
    evidence: /** @type {RuntimeHealthEvidence} */ ({
      version: 1,
      runtime: { name: runtimeName, ...(environment ? { environment } : {}) },
      evidence: { source, authenticated: value.evidence.authenticated, collectedAt },
      checks,
    }),
    error: null,
  };
}

/** @param {RuntimeHealthEvidence} evidence */
export function formatRuntimeHealthEvidence(evidence) {
  return [
    "Runtime Health Evidence v1",
    "",
    `Runtime: ${evidence.runtime.name}`,
    `Environment: ${evidence.runtime.environment ?? "(not supplied)"}`,
    `Source: ${evidence.evidence.source}`,
    `Authenticated: ${evidence.evidence.authenticated}`,
    `Collected at: ${evidence.evidence.collectedAt}`,
    `Checks: ${evidence.checks.length}`,
    ...evidence.checks.map((check) => `${check.status.padEnd(9)}  ${check.category.padEnd(8)}  ${check.id}${check.latencyMs === undefined ? "" : `  ${check.latencyMs}ms`}`),
    "",
    "Deployment identity: NOT INCLUDED",
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let file = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--file" || file !== null) return null;
    const candidate = argv[index + 1];
    if (typeof candidate !== "string" || candidate.startsWith("--") || candidate.length === 0) return null;
    file = candidate;
    index += 1;
  }
  return file ? { file, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/runtime-health-evidence.js --file <runtime-health.json> [--json]");
    return 1;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(options.file, "utf8")); }
  catch { console.error("Runtime health evidence file cannot be read or parsed"); return 1; }
  const result = validateRuntimeHealthEvidence(raw);
  if (!result.valid || !result.evidence) { console.error(result.error ?? "Runtime health evidence is invalid"); return 1; }
  console.log(options.json ? JSON.stringify(result.evidence) : formatRuntimeHealthEvidence(result.evidence));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
