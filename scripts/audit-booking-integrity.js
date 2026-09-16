#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { calleeNameList, inspectTypeScriptCalls, sourcePathList } from "./typescript-call-evidence.js";
import { validateBookingIntegrityEvidence } from "./booking-integrity-evidence.js";
import { isFullObjectId } from "./runtime-evidence.js";

const CONTROLS = ["atomicClaim", "duplicatePrevention", "expiry", "release", "timezoneConsistency", "retrySafety"];
const SEVERITIES = new Set(["FAIL", "WARN", "IGNORE"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v) ? v : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value @param {number} min @param {number} max */
function count(value, min, max) { return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null; }
/** @param {unknown} raw @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function staticControl(raw, scope, errors) {
  if (!object(raw)) { errors.push({ id: "control-invalid", detail: `${scope} must be an object` }); return null; }
  unknown(raw, ["severity", "evidenceFiles", "callees"], "control", errors);
  const severity = text(raw.severity, 16);
  if (!severity || !SEVERITIES.has(severity)) { errors.push({ id: "control-severity-invalid", detail: `${scope}.severity is invalid` }); return null; }
  const evidenceFiles = sourcePathList(raw.evidenceFiles, { minimum: severity === "IGNORE" ? 0 : 1, maximum: 128 });
  const callees = calleeNameList(raw.callees, { minimum: severity === "IGNORE" ? 0 : 1, maximum: 64 });
  if (!evidenceFiles || !callees || ((evidenceFiles.length === 0) !== (callees.length === 0)) || (severity !== "IGNORE" && evidenceFiles.length === 0)) { errors.push({ id: "control-evidence-invalid", detail: `${scope} requires evidence files and callees unless IGNORE` }); return null; }
  return { severity, evidenceFiles, callees };
}
/** @param {unknown} raw @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function empiricalPolicy(raw, scope, errors) {
  if (!object(raw)) { errors.push({ id: "empirical-policy-invalid", detail: `${scope} must be an object` }); return null; }
  unknown(raw, ["required", "minCompetingAttempts", "maxOversoldUnits", "maxDuplicateBookings", "maxUnreleasedClaims", "maxRetryDuplicateBookings", "maxTimezoneMismatches"], "empirical", errors);
  if (typeof raw.required !== "boolean") { errors.push({ id: "empirical-required-invalid", detail: `${scope}.required must be boolean` }); return null; }
  const minCompetingAttempts = count(raw.minCompetingAttempts, 2, 1_000_000);
  const maxOversoldUnits = count(raw.maxOversoldUnits, 0, 1_000_000);
  const maxDuplicateBookings = count(raw.maxDuplicateBookings, 0, 1_000_000);
  const maxUnreleasedClaims = count(raw.maxUnreleasedClaims, 0, 1_000_000);
  const maxRetryDuplicateBookings = count(raw.maxRetryDuplicateBookings, 0, 1_000_000);
  const maxTimezoneMismatches = count(raw.maxTimezoneMismatches, 0, 1_000_000);
  if ([minCompetingAttempts, maxOversoldUnits, maxDuplicateBookings, maxUnreleasedClaims, maxRetryDuplicateBookings, maxTimezoneMismatches].some((item) => item === null)) { errors.push({ id: "empirical-fields-invalid", detail: `${scope} contains invalid bounded thresholds` }); return null; }
  return { required: raw.required, minCompetingAttempts, maxOversoldUnits, maxDuplicateBookings, maxUnreleasedClaims, maxRetryDuplicateBookings, maxTimezoneMismatches };
}

/** @param {unknown} value */
export function validateBookingIntegrityPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "booking integrity policy must be an object" }] };
  unknown(value, ["version", "profiles"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (!Array.isArray(value.profiles) || value.profiles.length === 0 || value.profiles.length > 128) { errors.push({ id: "profiles-invalid", detail: "profiles must be a non-empty bounded array" }); return { valid: false, policy: null, errors }; }
  /** @type {Array<any>} */ const profiles = [];
  const ids = new Set();
  for (const [index, raw] of value.profiles.entries()) {
    if (!object(raw)) { errors.push({ id: "profile-invalid", detail: `profiles[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "controls", "empiricalEvidence"], "profile", errors);
    const id = text(raw.id, 128);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || ids.has(id)) { errors.push({ id: "profile-id-invalid", detail: `profiles[${index}].id is invalid or duplicate` }); continue; }
    ids.add(id);
    if (!object(raw.controls)) { errors.push({ id: "controls-invalid", detail: `profiles[${index}].controls must be an object` }); continue; }
    unknown(raw.controls, CONTROLS, "controls", errors);
    /** @type {Record<string,any>} */ const controls = {};
    for (const name of CONTROLS) {
      if (!(name in raw.controls)) { errors.push({ id: "control-missing", detail: `profiles[${index}].controls.${name} must be explicitly configured` }); continue; }
      const control = staticControl(raw.controls[name], `profiles[${index}].controls.${name}`, errors); if (control) controls[name] = control;
    }
    const empiricalEvidence = empiricalPolicy(raw.empiricalEvidence, `profiles[${index}].empiricalEvidence`, errors);
    if (empiricalEvidence && CONTROLS.every((name) => controls[name])) profiles.push({ id, controls, empiricalEvidence });
  }
  if (errors.length) return { valid: false, policy: null, errors };
  profiles.sort((a, b) => a.id.localeCompare(b.id));
  return { valid: true, policy: { version: 1, profiles }, errors: [] };
}

/** @param {string} root @param {any} policy @param {any|null} evidence @param {string|null} expectedCommit */
export function inspectBookingIntegrity(root, policy, evidence, expectedCommit) {
  /** @type {Array<any>} */ const checks = [];
  /** @param {string} id @param {"PASS"|"WARN"|"FAIL"} status @param {string} profile @param {string} control @param {string} detail */
  const add = (id, status, profile, control, detail) => checks.push({ id, status, profile, control, detail });
  const evidenceProfiles = new Map((evidence?.profiles ?? []).map((/** @type {any} */ item) => [item.id, item]));
  const commitMatches = evidence && expectedCommit ? evidence.artifact.commit === expectedCommit.toLowerCase() : false;

  if (evidence && expectedCommit && !commitMatches) add("booking-evidence-commit-mismatch", "FAIL", "(evidence)", "artifact", "booking integrity evidence belongs to a different source commit");

  for (const profile of policy.profiles) {
    for (const name of CONTROLS) {
      const control = profile.controls[name];
      if (control.severity === "IGNORE") { add("booking-control-ignored", "WARN", profile.id, name, "control is explicitly not required; no integrity claim is made"); continue; }
      let inspectable = true, found = false;
      for (const file of control.evidenceFiles) {
        const result = inspectTypeScriptCalls(root, file);
        if (!result.ok) { inspectable = false; add("booking-control-evidence-uninspectable", control.severity, profile.id, name, `${file} cannot be safely parsed`); continue; }
        if (control.callees.some((/** @type {string} */ callee) => result.calls.has(callee))) found = true;
      }
      if (inspectable && found) add("booking-control-present", "PASS", profile.id, name, "configured control call is structurally present");
      else if (inspectable) add("booking-control-missing", control.severity, profile.id, name, "no configured control call is structurally present");
    }

    const empirical = profile.empiricalEvidence;
    const observed = evidenceProfiles.get(profile.id);
    if (!evidence) {
      add(empirical.required ? "booking-evidence-required" : "booking-evidence-not-configured", empirical.required ? "FAIL" : "WARN", profile.id, "empiricalEvidence", empirical.required ? "commit-bound empirical booking evidence is required" : "empirical evidence is not configured; no concurrency outcome claim is made");
      continue;
    }
    if (!expectedCommit || !commitMatches) continue;
    if (!observed) { add("booking-evidence-profile-missing", empirical.required ? "FAIL" : "WARN", profile.id, "empiricalEvidence", "booking evidence does not contain this profile id"); continue; }
    const metrics = observed.metrics;
    /** @type {Array<[string,boolean,string]>} */
    const empiricalChecks = [
      ["concurrency-attempts", metrics.concurrency.competingAttempts >= empirical.minCompetingAttempts, `${metrics.concurrency.competingAttempts}/${empirical.minCompetingAttempts} competing attempts observed`],
      ["oversell", metrics.concurrency.oversoldUnits <= empirical.maxOversoldUnits, `${metrics.concurrency.oversoldUnits}/${empirical.maxOversoldUnits} maximum oversold units`],
      ["duplicate-prevention", metrics.duplicatePrevention.duplicateBookings <= empirical.maxDuplicateBookings, `${metrics.duplicatePrevention.duplicateBookings}/${empirical.maxDuplicateBookings} maximum duplicate bookings`],
      ["expiry-release", metrics.expiryRelease.unreleasedClaims <= empirical.maxUnreleasedClaims, `${metrics.expiryRelease.unreleasedClaims}/${empirical.maxUnreleasedClaims} maximum unreleased expired claims`],
      ["retry-safety", metrics.retrySafety.duplicateBookings <= empirical.maxRetryDuplicateBookings, `${metrics.retrySafety.duplicateBookings}/${empirical.maxRetryDuplicateBookings} maximum retry duplicates`],
      ["timezone-consistency", metrics.timezone.mismatches <= empirical.maxTimezoneMismatches, `${metrics.timezone.mismatches}/${empirical.maxTimezoneMismatches} maximum timezone mismatches`],
    ];
    for (const [id, passed, detail] of empiricalChecks) add(`booking-${id}`, passed ? "PASS" : "FAIL", profile.id, "empiricalEvidence", detail);
  }
  const summary = { pass: checks.filter((item) => item.status === "PASS").length, warn: checks.filter((item) => item.status === "WARN").length, fail: checks.filter((item) => item.status === "FAIL").length };
  return { profiles: policy.profiles.length, evidenceCommit: evidence?.artifact.commit ?? null, expectedCommit, evidenceAuthenticated: evidence?.evidence.authenticated ?? null, checks: checks.sort((a, b) => `${a.profile}:${a.control}:${a.id}`.localeCompare(`${b.profile}:${b.control}:${b.id}`)), summary, technicalStatus: "PASS", overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS", semantics: "static call presence and caller-supplied empirical outcome evidence only; database atomicity, locking, isolation level, inventory capacity rules, and real-world correctness are not independently proven" };
}

/** @param {ReturnType<typeof inspectBookingIntegrity>} report */
export function formatBookingIntegrity(report) { const lines = ["Booking integrity audit", "", `Profiles: ${report.profiles}`, `Expected commit: ${report.expectedCommit ?? "(not supplied)"}`, `Evidence commit: ${report.evidenceCommit ?? "(not supplied)"}`, `Evidence authenticated: ${report.evidenceAuthenticated ?? "(not supplied)"}`, `Semantics: ${report.semantics}`, ""]; for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.profile}  ${check.control}  ${check.id}  ${check.detail}`); lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`); return lines.join("\n"); }
/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) { let root = null, policyFile = null, evidenceFile = null, expectedCommit = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--root", "--policy", "--evidence", "--expected-commit"].includes(arg ?? "")) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; i += 1; if (arg === "--root") { if (root) return null; root = next; } else if (arg === "--policy") { if (policyFile) return null; policyFile = next; } else if (arg === "--evidence") { if (evidenceFile) return null; evidenceFile = next; } else { if (expectedCommit) return null; expectedCommit = next; } } if ((evidenceFile === null) !== (expectedCommit === null)) return null; return root && policyFile ? { root, policyFile, evidenceFile, expectedCommit, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/audit-booking-integrity.js --root <repository> --policy <booking-policy.json> [--evidence <evidence.json> --expected-commit <full-commit>] [--json]"); return 1; } if (options.expectedCommit && !isFullObjectId(options.expectedCommit)) { console.error("Expected commit must be a full Git object id"); return 1; } const rawPolicy = readJson(options.policyFile); if (!rawPolicy) { console.error("Booking integrity policy cannot be read or parsed"); return 1; } const policyResult = validateBookingIntegrityPolicy(rawPolicy); if (!policyResult.valid || !policyResult.policy) { console.error("Booking integrity policy is invalid"); return 1; } let evidence = null; if (options.evidenceFile) { const rawEvidence = readJson(options.evidenceFile); if (!rawEvidence) { console.error("Booking integrity evidence cannot be read or parsed"); return 1; } const evidenceResult = validateBookingIntegrityEvidence(rawEvidence); if (!evidenceResult.valid || !evidenceResult.evidence) { console.error("Booking integrity evidence is invalid"); return 1; } evidence = evidenceResult.evidence; } const root = path.resolve(options.root); let stat; try { stat = fs.lstatSync(root); } catch { console.error("Booking repository is unavailable"); return 1; } if (!stat.isDirectory() || stat.isSymbolicLink()) { console.error("Booking repository must be a regular directory"); return 1; } const report = inspectBookingIntegrity(root, policyResult.policy, evidence, options.expectedCommit); console.log(options.json ? JSON.stringify(report) : formatBookingIntegrity(report)); return report.overallStatus === "FAIL" ? 1 : 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
