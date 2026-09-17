#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MIGRATION_MODES = new Set(["NONE", "CHECK"]);
const MIGRATION_COMPATIBILITY = new Set(["NOT_APPLICABLE", "COMPATIBLE", "INCOMPATIBLE", "UNVERIFIED"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value @param {number} [max] */
function text(value, max = 512) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}

/** @param {unknown} value */
function safePath(value) {
  const normalized = text(value, 512);
  if (!normalized || path.isAbsolute(normalized) || normalized.includes("\\")) return null;
  const portable = path.posix.normalize(normalized);
  return portable !== "." && portable !== ".." && !portable.startsWith("../") && portable === normalized ? normalized : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
function roots(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return null;
  const normalized = value.map(safePath);
  if (normalized.some((item) => item === null)) return null;
  const result = /** @type {string[]} */ (normalized);
  return new Set(result).size === result.length ? result.sort() : null;
}

/** @param {unknown} value */
export function validateRollbackReadinessContract(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!object(value)) return { valid: false, contract: null, errors: [{ id: "contract-invalid", detail: "rollback readiness contract must be an object" }] };
  unknown(value, ["version", "rollback", "migration"], "contract", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let rollback = null;
  if (!object(value.rollback)) errors.push({ id: "rollback-invalid", detail: "rollback must be an object" });
  else {
    unknown(value.rollback, ["runbookPath", "command"], "rollback", errors);
    const runbookPath = safePath(value.rollback.runbookPath);
    const command = text(value.rollback.command, 1024);
    if (!runbookPath || !command) errors.push({ id: "rollback-fields-invalid", detail: "rollback requires safe runbookPath and bounded single-line command" });
    else rollback = { runbookPath, command };
  }

  let migration = null;
  if (!object(value.migration)) errors.push({ id: "migration-invalid", detail: "migration must be an object" });
  else {
    unknown(value.migration, ["mode", "compatibility", "roots", "appliedManifestPath"], "migration", errors);
    const mode = text(value.migration.mode, 32);
    const compatibility = text(value.migration.compatibility, 32);
    if (!mode || !MIGRATION_MODES.has(mode) || !compatibility || !MIGRATION_COMPATIBILITY.has(compatibility)) {
      errors.push({ id: "migration-fields-invalid", detail: "migration mode or compatibility is invalid" });
    } else if (mode === "NONE") {
      if (compatibility !== "NOT_APPLICABLE" || value.migration.roots !== undefined || value.migration.appliedManifestPath !== undefined) {
        errors.push({ id: "migration-none-invalid", detail: "NONE mode requires NOT_APPLICABLE compatibility and no roots or manifest" });
      } else migration = { mode, compatibility };
    } else {
      const migrationRoots = roots(value.migration.roots);
      const appliedManifestPath = safePath(value.migration.appliedManifestPath);
      if (!migrationRoots || !appliedManifestPath || compatibility === "NOT_APPLICABLE") {
        errors.push({ id: "migration-check-invalid", detail: "CHECK mode requires roots, appliedManifestPath, and an explicit compatibility assessment" });
      } else migration = { mode, compatibility, roots: migrationRoots, appliedManifestPath };
    }
  }

  if (errors.length > 0 || !rollback || !migration) return { valid: false, contract: null, errors };
  return { valid: true, contract: { version: 1, rollback, migration }, errors: [] };
}

/** @param {any} contract */
export function formatRollbackReadinessContract(contract) {
  return [
    "Rollback Readiness Contract v1",
    "",
    `Runbook: ${contract.rollback.runbookPath}`,
    `Migration mode: ${contract.migration.mode}`,
    `Migration compatibility: ${contract.migration.compatibility}`,
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
  if (!options) { console.error("Usage: node scripts/rollback-readiness-contract.js --file <contract.json> [--json]"); return 1; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(options.file, "utf8")); }
  catch { console.error("Rollback readiness contract cannot be read or parsed"); return 1; }
  const result = validateRollbackReadinessContract(raw);
  if (!result.valid || !result.contract) { console.error("Rollback readiness contract is invalid"); return 1; }
  console.log(options.json ? JSON.stringify(result.contract) : formatRollbackReadinessContract(result.contract));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
