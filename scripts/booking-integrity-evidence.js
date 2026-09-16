#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v) ? v : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value @param {number} min @param {number} max */
function count(value, min, max) { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null; }

/** @param {unknown} value */
export function validateBookingIntegrityEvidence(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, evidence: null, errors: [{ id: "evidence-invalid", detail: "booking integrity evidence must be an object" }] };
  unknown(value, ["version", "artifact", "evidence", "profiles"], "evidence", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let artifact = null;
  if (!object(value.artifact)) errors.push({ id: "artifact-invalid", detail: "artifact must be an object" });
  else {
    unknown(value.artifact, ["commit"], "artifact", errors);
    const commit = text(value.artifact.commit, 128);
    if (!commit || !isFullObjectId(commit)) errors.push({ id: "artifact-commit-invalid", detail: "artifact.commit must be a full Git object id" });
    else artifact = { commit: commit.toLowerCase() };
  }

  let trust = null;
  if (!object(value.evidence)) errors.push({ id: "trust-invalid", detail: "evidence metadata must be an object" });
  else {
    unknown(value.evidence, ["source", "authenticated", "collectedAt"], "trust", errors);
    const source = text(value.evidence.source), collectedAt = text(value.evidence.collectedAt, 128);
    if (!source || typeof value.evidence.authenticated !== "boolean" || !collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) errors.push({ id: "trust-fields-invalid", detail: "evidence metadata requires source, authenticated, and absolute collectedAt" });
    else trust = { source, authenticated: value.evidence.authenticated, collectedAt };
  }

  /** @type {Array<any>} */ const profiles = [];
  if (!Array.isArray(value.profiles) || value.profiles.length === 0 || value.profiles.length > 128) errors.push({ id: "profiles-invalid", detail: "profiles must be a non-empty bounded array" });
  else {
    const ids = new Set();
    for (const [index, raw] of value.profiles.entries()) {
      if (!object(raw)) { errors.push({ id: "profile-invalid", detail: `profiles[${index}] must be an object` }); continue; }
      unknown(raw, ["id", "metrics"], "profile", errors);
      const id = text(raw.id, 128);
      if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || ids.has(id)) { errors.push({ id: "profile-id-invalid", detail: `profiles[${index}].id is invalid or duplicate` }); continue; }
      ids.add(id);
      if (!object(raw.metrics)) { errors.push({ id: "metrics-invalid", detail: `profiles[${index}].metrics must be an object` }); continue; }
      unknown(raw.metrics, ["concurrency", "duplicatePrevention", "expiryRelease", "retrySafety", "timezone"], "metrics", errors);
      /** @type {Record<string,[string,string]>} */
      const shapes = {
        concurrency: ["competingAttempts", "oversoldUnits"],
        duplicatePrevention: ["duplicateAttempts", "duplicateBookings"],
        expiryRelease: ["expiredClaims", "unreleasedClaims"],
        retrySafety: ["retryAttempts", "duplicateBookings"],
        timezone: ["cases", "mismatches"],
      };
      /** @type {Record<string,any>} */ const metrics = {};
      for (const [name, fields] of Object.entries(shapes)) {
        const metric = raw.metrics[name];
        if (!object(metric)) { errors.push({ id: "metric-invalid", detail: `profiles[${index}].metrics.${name} must be an object` }); continue; }
        unknown(metric, fields, `metric-${name}`, errors);
        const [firstField, secondField] = fields;
        const first = count(metric[firstField], name === "concurrency" ? 2 : 1, 1_000_000);
        const second = count(metric[secondField], 0, 1_000_000);
        if (first === null || second === null) { errors.push({ id: "metric-fields-invalid", detail: `profiles[${index}].metrics.${name} contains invalid counts` }); continue; }
        metrics[name] = { [firstField]: first, [secondField]: second };
      }
      if (Object.keys(metrics).length === Object.keys(shapes).length) profiles.push({ id, metrics });
    }
  }

  if (errors.length || !artifact || !trust) return { valid: false, evidence: null, errors };
  profiles.sort((a, b) => a.id.localeCompare(b.id));
  return { valid: true, evidence: { version: 1, artifact, evidence: trust, profiles }, errors: [] };
}

/** @param {any} evidence */
export function formatBookingIntegrityEvidence(evidence) { return ["Booking Integrity Evidence v1", "", `Commit: ${evidence.artifact.commit}`, `Profiles: ${evidence.profiles.length}`, `Source: ${evidence.evidence.source}`, `Authenticated: ${evidence.evidence.authenticated}`, `Collected at: ${evidence.evidence.collectedAt}`, "Result: VALID"].join("\n"); }
/** @param {string[]} argv */
function parse(argv) { let file = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (arg !== "--file" || file) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; file = next; i += 1; } return file ? { file, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/booking-integrity-evidence.js --file <evidence.json> [--json]"); return 1; } let raw; try { raw = JSON.parse(fs.readFileSync(options.file, "utf8")); } catch { console.error("Booking integrity evidence cannot be read or parsed"); return 1; } const result = validateBookingIntegrityEvidence(raw); if (!result.valid || !result.evidence) { console.error("Booking integrity evidence is invalid"); return 1; } console.log(options.json ? JSON.stringify(result.evidence) : formatBookingIntegrityEvidence(result.evidence)); return 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
