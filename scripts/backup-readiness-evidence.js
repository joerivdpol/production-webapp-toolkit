#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const BACKUP_STATUS = new Set(["SUCCESS", "FAILED"]);
const RESTORE_STATUS = new Set(["PASS", "FAIL"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v) ? v : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value */
function systemId(value) { const v = text(value, 128); return v && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v) ? v : null; }

/** @param {unknown} value */
export function validateBackupReadinessEvidence(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, evidence: null, errors: [{ id: "evidence-invalid", detail: "backup readiness evidence must be an object" }] };
  unknown(value, ["version", "evidence", "systems"], "evidence", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let trust = null;
  if (!object(value.evidence)) errors.push({ id: "trust-invalid", detail: "evidence metadata must be an object" });
  else {
    unknown(value.evidence, ["source", "authenticated", "collectedAt"], "trust", errors);
    const source = text(value.evidence.source), collectedAt = text(value.evidence.collectedAt, 128);
    if (!source || typeof value.evidence.authenticated !== "boolean" || !collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) errors.push({ id: "trust-fields-invalid", detail: "evidence metadata requires source, authenticated, and absolute collectedAt" });
    else trust = { source, authenticated: value.evidence.authenticated, collectedAt };
  }

  /** @type {Array<any>} */ const systems = [];
  if (!Array.isArray(value.systems) || value.systems.length === 0 || value.systems.length > 256) errors.push({ id: "systems-invalid", detail: "systems must be a non-empty bounded array" });
  else {
    const ids = new Set();
    for (const [index, raw] of value.systems.entries()) {
      if (!object(raw)) { errors.push({ id: "system-invalid", detail: `systems[${index}] must be an object` }); continue; }
      unknown(raw, ["id", "backup", "restoreTest"], "system", errors);
      const id = systemId(raw.id);
      if (!id || ids.has(id)) { errors.push({ id: "system-id-invalid", detail: `systems[${index}].id is invalid or duplicate` }); continue; }
      ids.add(id);
      let backup = null;
      if (!object(raw.backup)) errors.push({ id: "backup-invalid", detail: `systems[${index}].backup must be an object` });
      else {
        unknown(raw.backup, ["completedAt", "status", "encrypted"], "backup", errors);
        const completedAt = text(raw.backup.completedAt, 128), status = text(raw.backup.status, 16);
        if (!completedAt || !isAbsoluteIsoTimestamp(completedAt) || !status || !BACKUP_STATUS.has(status) || typeof raw.backup.encrypted !== "boolean") errors.push({ id: "backup-fields-invalid", detail: `systems[${index}].backup requires absolute completedAt, status, and encrypted boolean` });
        else backup = { completedAt, status, encrypted: raw.backup.encrypted };
      }
      let restoreTest = null;
      if (!object(raw.restoreTest)) errors.push({ id: "restore-test-invalid", detail: `systems[${index}].restoreTest must be an object` });
      else {
        unknown(raw.restoreTest, ["testedAt", "status"], "restore-test", errors);
        const testedAt = text(raw.restoreTest.testedAt, 128), status = text(raw.restoreTest.status, 16);
        if (!testedAt || !isAbsoluteIsoTimestamp(testedAt) || !status || !RESTORE_STATUS.has(status)) errors.push({ id: "restore-test-fields-invalid", detail: `systems[${index}].restoreTest requires absolute testedAt and PASS or FAIL status` });
        else restoreTest = { testedAt, status };
      }
      if (backup && restoreTest) systems.push({ id, backup, restoreTest });
    }
  }
  if (errors.length || !trust) return { valid: false, evidence: null, errors };
  systems.sort((a, b) => a.id.localeCompare(b.id));
  return { valid: true, evidence: { version: 1, evidence: trust, systems }, errors: [] };
}

/** @param {any} evidence */
export function formatBackupReadinessEvidence(evidence) { return ["Backup Readiness Evidence v1", "", `Systems: ${evidence.systems.length}`, `Source: ${evidence.evidence.source}`, `Authenticated: ${evidence.evidence.authenticated}`, `Collected at: ${evidence.evidence.collectedAt}`, "Result: VALID"].join("\n"); }
/** @param {string[]} argv */
function parse(argv) { let file = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (arg !== "--file" || file) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; file = next; i += 1; } return file ? { file, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/backup-readiness-evidence.js --file <evidence.json> [--json]"); return 1; } let raw; try { raw = JSON.parse(fs.readFileSync(options.file, "utf8")); } catch { console.error("Backup readiness evidence cannot be read or parsed"); return 1; } const result = validateBackupReadinessEvidence(raw); if (!result.valid || !result.evidence) { console.error("Backup readiness evidence is invalid"); return 1; } console.log(options.json ? JSON.stringify(result.evidence) : formatBackupReadinessEvidence(result.evidence)); return 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
