#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

export const DR_AREAS = ["source", "database", "secrets", "dns", "deployment", "rollback", "restore"];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v) ? v : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value */
function portableId(value) { const v = text(value, 128); return v && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v) ? v : null; }
/** @param {unknown} value */
function safePath(value) { const v = text(value, 512); if (!v || path.isAbsolute(v) || v.includes("\\")) return null; const normalized = path.posix.normalize(v); return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && normalized === v ? v : null; }
/** @param {unknown} value */
function reviewAge(value) { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 10 * 365 * 24 * 60 ? Number(value) : null; }

/** @param {unknown} value */
export function validateDisasterRecoveryContract(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, contract: null, errors: [{ id: "contract-invalid", detail: "disaster recovery contract must be an object" }] };
  unknown(value, ["version", "plans"], "contract", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (!Array.isArray(value.plans) || value.plans.length === 0 || value.plans.length > 128) { errors.push({ id: "plans-invalid", detail: "plans must be a non-empty bounded array" }); return { valid: false, contract: null, errors }; }
  /** @type {Array<any>} */ const plans = [];
  const ids = new Set();
  for (const [index, raw] of value.plans.entries()) {
    if (!object(raw)) { errors.push({ id: "plan-invalid", detail: `plans[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "reviewedAt", "maxReviewAgeMinutes", "areas"], "plan", errors);
    const id = portableId(raw.id), reviewedAt = text(raw.reviewedAt, 128), maxReviewAgeMinutes = reviewAge(raw.maxReviewAgeMinutes);
    if (!id || ids.has(id)) errors.push({ id: "plan-id-invalid", detail: `plans[${index}].id is invalid or duplicate` }); else ids.add(id);
    if (!reviewedAt || !isAbsoluteIsoTimestamp(reviewedAt)) errors.push({ id: "reviewed-at-invalid", detail: `plans[${index}].reviewedAt must be an absolute ISO timestamp` });
    if (maxReviewAgeMinutes === null) errors.push({ id: "review-age-invalid", detail: `plans[${index}].maxReviewAgeMinutes is invalid` });
    if (!object(raw.areas)) { errors.push({ id: "areas-invalid", detail: `plans[${index}].areas must be an object` }); continue; }
    unknown(raw.areas, DR_AREAS, "areas", errors);
    /** @type {Record<string,any>} */ const areas = {};
    for (const area of DR_AREAS) {
      const rawArea = raw.areas[area];
      if (!object(rawArea)) { errors.push({ id: "area-missing", detail: `plans[${index}].areas.${area} must be explicitly configured` }); continue; }
      unknown(rawArea, ["owner", "runbookPath"], `area-${area}`, errors);
      const owner = portableId(rawArea.owner), runbookPath = safePath(rawArea.runbookPath);
      if (!owner || !runbookPath) { errors.push({ id: "area-fields-invalid", detail: `plans[${index}].areas.${area} requires portable owner and safe runbookPath` }); continue; }
      areas[area] = { owner, runbookPath };
    }
    if (id && reviewedAt && isAbsoluteIsoTimestamp(reviewedAt) && maxReviewAgeMinutes !== null && DR_AREAS.every((area) => areas[area])) plans.push({ id, reviewedAt, maxReviewAgeMinutes, areas });
  }
  if (errors.length) return { valid: false, contract: null, errors };
  plans.sort((a, b) => a.id.localeCompare(b.id));
  return { valid: true, contract: { version: 1, plans }, errors: [] };
}

/** @param {any} contract */
export function formatDisasterRecoveryContract(contract) { return ["Disaster Recovery Contract v1", "", `Plans: ${contract.plans.length}`, `Required areas per plan: ${DR_AREAS.join(", ")}`, "Result: VALID"].join("\n"); }
/** @param {string[]} argv */
function parse(argv) { let file = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (arg !== "--file" || file) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; file = next; i += 1; } return file ? { file, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/disaster-recovery-contract.js --file <contract.json> [--json]"); return 1; } let raw; try { raw = JSON.parse(fs.readFileSync(options.file, "utf8")); } catch { console.error("Disaster recovery contract cannot be read or parsed"); return 1; } const result = validateDisasterRecoveryContract(raw); if (!result.valid || !result.contract) { console.error("Disaster recovery contract is invalid"); return 1; } console.log(options.json ? JSON.stringify(result.contract) : formatDisasterRecoveryContract(result.contract)); return 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
