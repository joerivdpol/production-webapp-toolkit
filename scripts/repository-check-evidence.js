#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const STATUSES = new Set(["PASS", "WARN", "FAIL", "UNVERIFIED"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}

/** @param {unknown} value */
function id(value) {
  const normalized = text(value, 128);
  return normalized && ID_PATTERN.test(normalized) ? normalized : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateRepositoryCheckEvidence(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!object(value)) return { valid: false, evidence: null, errors: [{ id: "evidence-invalid", detail: "repository check evidence must be an object" }] };
  unknown(value, ["version", "repository", "evidence", "checks"], "evidence", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let repository = null;
  if (!object(value.repository)) errors.push({ id: "repository-invalid", detail: "repository must be an object" });
  else {
    unknown(value.repository, ["id"], "repository", errors);
    const repositoryId = id(value.repository.id);
    if (!repositoryId) errors.push({ id: "repository-id-invalid", detail: "repository.id must be a portable identifier" });
    else repository = { id: repositoryId };
  }

  let trust = null;
  if (!object(value.evidence)) errors.push({ id: "trust-invalid", detail: "evidence metadata must be an object" });
  else {
    unknown(value.evidence, ["source", "authenticated", "collectedAt"], "trust", errors);
    const source = text(value.evidence.source), collectedAt = text(value.evidence.collectedAt, 128);
    if (!source || typeof value.evidence.authenticated !== "boolean" || !collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) {
      errors.push({ id: "trust-fields-invalid", detail: "evidence metadata requires source, authenticated boolean, and absolute collectedAt" });
    } else trust = { source, authenticated: value.evidence.authenticated, collectedAt };
  }

  /** @type {Array<{id:string,status:"PASS"|"WARN"|"FAIL"|"UNVERIFIED"}>} */
  const checks = [];
  if (!Array.isArray(value.checks) || value.checks.length > 1024) errors.push({ id: "checks-invalid", detail: "checks must be a bounded array" });
  else {
    const seen = new Set();
    for (const [index, raw] of value.checks.entries()) {
      if (!object(raw)) { errors.push({ id: "check-invalid", detail: `checks[${index}] must be an object` }); continue; }
      unknown(raw, ["id", "status"], "check", errors);
      const checkId = id(raw.id), status = text(raw.status, 16);
      if (!checkId || !status || !STATUSES.has(status) || seen.has(checkId)) {
        errors.push({ id: "check-fields-invalid", detail: `checks[${index}] has invalid or duplicate id/status` });
        continue;
      }
      seen.add(checkId);
      checks.push({ id: checkId, status: /** @type {"PASS"|"WARN"|"FAIL"|"UNVERIFIED"} */ (status) });
    }
  }

  if (errors.length > 0 || !repository || !trust) return { valid: false, evidence: null, errors };
  return { valid: true, evidence: { version: 1, repository, evidence: trust, checks: checks.sort((a, b) => a.id.localeCompare(b.id)) }, errors: [] };
}

/** @param {any} evidence */
export function formatRepositoryCheckEvidence(evidence) {
  const counts = Object.fromEntries([...STATUSES].map((status) => [status, /** @type {any[]} */ (evidence.checks).filter((check) => check.status === status).length]));
  return [
    "Repository Check Evidence v1",
    "",
    `Repository: ${evidence.repository.id}`,
    `Checks: ${evidence.checks.length}`,
    `Status: ${counts.PASS} pass, ${counts.WARN} warn, ${counts.FAIL} fail, ${counts.UNVERIFIED} unverified`,
    `Source: ${evidence.evidence.source}`,
    `Authenticated: ${evidence.evidence.authenticated}`,
    `Collected at: ${evidence.evidence.collectedAt}`,
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parse(argv) {
  let file = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--file" || file !== null) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    file = value; index += 1;
  }
  return file ? { file, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/repository-check-evidence.js --file <evidence.json> [--json]"); return 1; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(options.file, "utf8")); }
  catch { console.error("Repository check evidence cannot be read or parsed"); return 1; }
  const result = validateRepositoryCheckEvidence(raw);
  if (!result.valid || !result.evidence) { console.error("Repository check evidence is invalid"); return 1; }
  console.log(options.json ? JSON.stringify(result.evidence) : formatRepositoryCheckEvidence(result.evidence));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
