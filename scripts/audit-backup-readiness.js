#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateBackupReadinessEvidence } from "./backup-readiness-evidence.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v) ? v : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value */
function systemId(value) { const v = text(value, 128); return v && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v) ? v : null; }
/** @param {unknown} value */
function safePath(value) { const v = text(value, 512); if (!v || path.isAbsolute(v) || v.includes("\\")) return null; const normalized = path.posix.normalize(v); return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && normalized === v ? v : null; }
/** @param {unknown} value */
function positiveMinutes(value) { return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= 10 * 365 * 24 * 60 ? Number(value) : null; }

/** @param {unknown} value */
export function validateBackupReadinessPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "backup readiness policy must be an object" }] };
  unknown(value, ["version", "systems"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (!Array.isArray(value.systems) || value.systems.length === 0 || value.systems.length > 256) { errors.push({ id: "systems-invalid", detail: "systems must be a non-empty bounded array" }); return { valid: false, policy: null, errors }; }
  /** @type {Array<any>} */ const systems = [];
  const ids = new Set();
  for (const [index, raw] of value.systems.entries()) {
    if (!object(raw)) { errors.push({ id: "system-invalid", detail: `systems[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "maxBackupAgeMinutes", "requireEncrypted", "restoreInstructionsPath", "maxRestoreTestAgeMinutes"], "system", errors);
    const id = systemId(raw.id), maxBackupAgeMinutes = positiveMinutes(raw.maxBackupAgeMinutes), restoreInstructionsPath = safePath(raw.restoreInstructionsPath), maxRestoreTestAgeMinutes = positiveMinutes(raw.maxRestoreTestAgeMinutes);
    if (!id || ids.has(id)) errors.push({ id: "system-id-invalid", detail: `systems[${index}].id is invalid or duplicate` });
    else ids.add(id);
    if (maxBackupAgeMinutes === null || maxRestoreTestAgeMinutes === null || !restoreInstructionsPath || typeof raw.requireEncrypted !== "boolean") errors.push({ id: "system-fields-invalid", detail: `systems[${index}] requires bounded ages, encryption policy, and safe restore instructions path` });
    if (id && maxBackupAgeMinutes !== null && maxRestoreTestAgeMinutes !== null && restoreInstructionsPath && typeof raw.requireEncrypted === "boolean") systems.push({ id, maxBackupAgeMinutes, requireEncrypted: raw.requireEncrypted, restoreInstructionsPath, maxRestoreTestAgeMinutes });
  }
  if (errors.length) return { valid: false, policy: null, errors };
  systems.sort((a, b) => a.id.localeCompare(b.id));
  return { valid: true, policy: { version: 1, systems }, errors: [] };
}

/** @param {string} root @param {string} relative */
function instructionFile(root, relative) {
  const base = path.resolve(root), absolute = path.resolve(base, relative), rel = path.relative(base, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  try { const stat = fs.lstatSync(absolute); return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0; } catch { return false; }
}
/** @param {string} timestamp */
function ms(timestamp) { return Date.parse(timestamp); }
/** @param {string} older @param {string} newer */
function ageMinutes(older, newer) { return (ms(newer) - ms(older)) / 60_000; }

/** @param {string} root @param {any} policy @param {any} evidence @param {string} evaluatedAt */
export function inspectBackupReadiness(root, policy, evidence, evaluatedAt) {
  /** @type {Array<any>} */ const checks = [];
  /** @param {string} id @param {"PASS"|"WARN"|"FAIL"} status @param {string} system @param {string} detail */
  const add = (id, status, system, detail) => checks.push({ id, status, system, detail });
  const bySystem = new Map(evidence.systems.map((/** @type {any} */ item) => [item.id, item]));
  const collectionFuture = ms(evidence.evidence.collectedAt) > ms(evaluatedAt);
  if (collectionFuture) add("backup-evidence-future", "FAIL", "(evidence)", "evidence collection time is after evaluation time");

  for (const cfg of policy.systems) {
    const observed = bySystem.get(cfg.id);
    if (!observed) { add("backup-system-evidence-missing", "FAIL", cfg.id, "backup evidence does not contain this configured system"); continue; }
    const backupAfterCollection = ms(observed.backup.completedAt) > ms(evidence.evidence.collectedAt);
    const restoreAfterCollection = ms(observed.restoreTest.testedAt) > ms(evidence.evidence.collectedAt);
    if (backupAfterCollection || restoreAfterCollection) add("backup-evidence-timeline-invalid", "FAIL", cfg.id, "backup or restore-test time is after evidence collection time");

    if (observed.backup.status !== "SUCCESS") add("backup-latest-failed", "FAIL", cfg.id, "latest recorded backup status is FAILED");
    else add("backup-latest-success", "PASS", cfg.id, "latest recorded backup status is SUCCESS");
    const backupAge = ageMinutes(observed.backup.completedAt, evaluatedAt);
    if (backupAge < 0) add("backup-time-future", "FAIL", cfg.id, "backup completion time is after evaluation time");
    else if (backupAge > cfg.maxBackupAgeMinutes) add("backup-stale", "FAIL", cfg.id, `backup age ${backupAge.toFixed(1)} minutes exceeds policy maximum ${cfg.maxBackupAgeMinutes}`);
    else add("backup-fresh", "PASS", cfg.id, `backup age ${backupAge.toFixed(1)} minutes is within policy maximum ${cfg.maxBackupAgeMinutes}`);

    if (cfg.requireEncrypted && !observed.backup.encrypted) add("backup-unencrypted", "FAIL", cfg.id, "policy requires encrypted backup evidence");
    else if (!cfg.requireEncrypted && !observed.backup.encrypted) add("backup-encryption-not-required", "WARN", cfg.id, "policy explicitly permits unencrypted backup evidence; no encryption claim is made");
    else add("backup-encrypted", "PASS", cfg.id, "backup evidence declares encrypted=true");

    if (instructionFile(root, cfg.restoreInstructionsPath)) add("restore-instructions-present", "PASS", cfg.id, "configured restore instructions file exists as a non-empty regular file");
    else add("restore-instructions-missing", "FAIL", cfg.id, "configured restore instructions file is missing, empty, symlinked, or outside repository");

    if (observed.restoreTest.status !== "PASS") add("restore-test-failed", "FAIL", cfg.id, "latest restore test status is FAIL");
    else add("restore-test-pass", "PASS", cfg.id, "latest restore test status is PASS");
    const restoreAge = ageMinutes(observed.restoreTest.testedAt, evaluatedAt);
    if (restoreAge < 0) add("restore-test-time-future", "FAIL", cfg.id, "restore test time is after evaluation time");
    else if (restoreAge > cfg.maxRestoreTestAgeMinutes) add("restore-test-stale", "FAIL", cfg.id, `restore test age ${restoreAge.toFixed(1)} minutes exceeds policy maximum ${cfg.maxRestoreTestAgeMinutes}`);
    else add("restore-test-fresh", "PASS", cfg.id, `restore test age ${restoreAge.toFixed(1)} minutes is within policy maximum ${cfg.maxRestoreTestAgeMinutes}`);
  }
  const summary = { pass: checks.filter((item) => item.status === "PASS").length, warn: checks.filter((item) => item.status === "WARN").length, fail: checks.filter((item) => item.status === "FAIL").length };
  return { systems: policy.systems.length, evaluatedAt, evidenceCollectedAt: evidence.evidence.collectedAt, evidenceAuthenticated: evidence.evidence.authenticated, checks: checks.sort((a, b) => `${a.system}:${a.id}`.localeCompare(`${b.system}:${b.id}`)), summary, technicalStatus: "PASS", overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS", semantics: "caller-supplied backup and restore-test metadata plus repository restore-instruction file presence; backup contents, encryption implementation, restore completeness, and recoverability are not independently verified" };
}

/** @param {ReturnType<typeof inspectBackupReadiness>} report */
export function formatBackupReadiness(report) { const lines = ["Backup readiness audit", "", `Systems: ${report.systems}`, `Evaluated at: ${report.evaluatedAt}`, `Evidence collected at: ${report.evidenceCollectedAt}`, `Evidence authenticated: ${report.evidenceAuthenticated}`, `Semantics: ${report.semantics}`, ""]; for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.system}  ${check.id}  ${check.detail}`); lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`); return lines.join("\n"); }
/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) { let root = null, policyFile = null, evidenceFile = null, evaluatedAt = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--root", "--policy", "--evidence", "--evaluated-at"].includes(arg ?? "")) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; i += 1; if (arg === "--root") { if (root) return null; root = next; } else if (arg === "--policy") { if (policyFile) return null; policyFile = next; } else if (arg === "--evidence") { if (evidenceFile) return null; evidenceFile = next; } else { if (evaluatedAt) return null; evaluatedAt = next; } } return root && policyFile && evidenceFile && evaluatedAt ? { root, policyFile, evidenceFile, evaluatedAt, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/audit-backup-readiness.js --root <repository> --policy <policy.json> --evidence <evidence.json> --evaluated-at <absolute-ISO> [--json]"); return 1; } if (!isAbsoluteIsoTimestamp(options.evaluatedAt)) { console.error("evaluated-at must be an absolute ISO timestamp"); return 1; } const rawPolicy = readJson(options.policyFile), rawEvidence = readJson(options.evidenceFile); if (!rawPolicy || !rawEvidence) { console.error("Backup policy or evidence cannot be read or parsed"); return 1; } const policyResult = validateBackupReadinessPolicy(rawPolicy), evidenceResult = validateBackupReadinessEvidence(rawEvidence); if (!policyResult.valid || !policyResult.policy || !evidenceResult.valid || !evidenceResult.evidence) { console.error("Backup policy or evidence is invalid"); return 1; } const root = path.resolve(options.root); let stat; try { stat = fs.lstatSync(root); } catch { console.error("Backup repository is unavailable"); return 1; } if (!stat.isDirectory() || stat.isSymbolicLink()) { console.error("Backup repository must be a regular directory"); return 1; } const report = inspectBackupReadiness(root, policyResult.policy, evidenceResult.evidence, options.evaluatedAt); console.log(options.json ? JSON.stringify(report) : formatBackupReadiness(report)); return report.overallStatus === "FAIL" ? 1 : 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
