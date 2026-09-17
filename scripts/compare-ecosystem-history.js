#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const OVERALL = new Set(["PASS", "WARN", "FAIL"]);
const TECHNICAL = new Set(["PASS", "FAIL"]);
const POLICY = new Set(["PASS", "FAIL", "UNAVAILABLE"]);
const OBSERVED = new Set(["PASS", "WARN", "FAIL", "UNVERIFIED", "MISSING"]);
const RAW_OBSERVED = new Set(["PASS", "WARN", "FAIL", "UNVERIFIED"]);
const IMPACT = new Set(["PASS", "WARN", "FAIL"]);
const REQUIREMENT = new Set(["required", "advisory"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value @param {number} [max] */
function text(value, max = 1024) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}
/** @param {unknown} value */
function id(value) { const normalized = text(value, 128); return normalized && ID_PATTERN.test(normalized) ? normalized : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value */
function nonNegativeInteger(value) { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null; }

/** @param {unknown} value @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function validateCategorySummary(value, scope, errors) {
  if (!object(value)) { errors.push({ id: `${scope}-invalid`, detail: `${scope} must be an object` }); return null; }
  const fields = ["total", "pass", "warn", "fail", "unverified", "missing"];
  unknown(value, fields, scope, errors);
  /** @type {Record<string,number>} */ const result = {};
  for (const field of fields) {
    const normalized = nonNegativeInteger(value[field]);
    if (normalized === null) errors.push({ id: `${scope}-${field}-invalid`, detail: `${scope}.${field} must be a non-negative integer` });
    else result[field] = normalized;
  }
  if (fields.every((field) => field in result)) {
    const total = result.total ?? 0, pass = result.pass ?? 0, warn = result.warn ?? 0, fail = result.fail ?? 0, unverified = result.unverified ?? 0, missing = result.missing ?? 0;
    if (total !== pass + warn + fail + unverified + missing) errors.push({ id: `${scope}-count-mismatch`, detail: `${scope} status counts must sum to total` });
  }
  return fields.every((field) => field in result) ? result : null;
}

/** @param {unknown} value @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function validateTrust(value, scope, errors) {
  if (value === null) return null;
  if (!object(value)) { errors.push({ id: `${scope}-invalid`, detail: `${scope} must be null or an object` }); return undefined; }
  unknown(value, ["source", "authenticated", "collectedAt"], scope, errors);
  const source = text(value.source), collectedAt = text(value.collectedAt, 128);
  if (!source || typeof value.authenticated !== "boolean" || !collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) {
    errors.push({ id: `${scope}-fields-invalid`, detail: `${scope} requires source, authenticated boolean, and absolute collectedAt` });
    return undefined;
  }
  return { source, authenticated: value.authenticated, collectedAt };
}

/** @param {unknown} value @param {Array<{id:string,detail:string}>} errors @param {string} scope */
function validateScopedChecks(value, errors, scope) {
  if (!Array.isArray(value) || value.length > 4096) { errors.push({ id: `${scope}-invalid`, detail: `${scope} must be a bounded array` }); return null; }
  const seen = new Set();
  const result = [];
  for (const [index, raw] of value.entries()) {
    if (!object(raw)) { errors.push({ id: `${scope}-item-invalid`, detail: `${scope}[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "requirement", "status", "impact"], `${scope}-item`, errors);
    const checkId = id(raw.id), requirement = text(raw.requirement, 16), status = text(raw.status, 16), impact = text(raw.impact, 16);
    const key = checkId;
    if (!checkId || !requirement || !REQUIREMENT.has(requirement) || !status || !OBSERVED.has(status) || !impact || !IMPACT.has(impact) || seen.has(key)) {
      errors.push({ id: `${scope}-fields-invalid`, detail: `${scope}[${index}] has invalid or duplicate fields` });
      continue;
    }
    seen.add(key);
    const expectedImpact = status === "PASS" ? "PASS" : requirement === "required" && status === "FAIL" ? "FAIL" : "WARN";
    if (impact !== expectedImpact) errors.push({ id: `${scope}-impact-invalid`, detail: `${scope}[${index}] impact is inconsistent with requirement and status` });
    result.push({ id: checkId, requirement, status, impact });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/** @param {unknown} value @param {Array<{id:string,detail:string}>} errors @param {string} scope */
function validateUnscopedChecks(value, errors, scope) {
  if (!Array.isArray(value) || value.length > 4096) { errors.push({ id: `${scope}-invalid`, detail: `${scope} must be a bounded array` }); return null; }
  const seen = new Set(), result = [];
  for (const [index, raw] of value.entries()) {
    if (!object(raw)) { errors.push({ id: `${scope}-item-invalid`, detail: `${scope}[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "status"], `${scope}-item`, errors);
    const checkId = id(raw.id), status = text(raw.status, 16);
    if (!checkId || !status || !RAW_OBSERVED.has(status) || seen.has(checkId)) { errors.push({ id: `${scope}-fields-invalid`, detail: `${scope}[${index}] has invalid or duplicate fields` }); continue; }
    seen.add(checkId); result.push({ id: checkId, status });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

/** @param {Array<any>} checks @param {"required"|"advisory"} requirement */
function computedCategory(checks, requirement) {
  const selected = checks.filter((item) => item.requirement === requirement);
  return {
    total: selected.length,
    pass: selected.filter((item) => item.status === "PASS").length,
    warn: selected.filter((item) => item.status === "WARN").length,
    fail: selected.filter((item) => item.status === "FAIL").length,
    unverified: selected.filter((item) => item.status === "UNVERIFIED").length,
    missing: selected.filter((item) => item.status === "MISSING").length,
  };
}
/** @param {Record<string,number>} left @param {Record<string,number>} right */
function sameSummary(left, right) { return ["total", "pass", "warn", "fail", "unverified", "missing"].every((key) => left[key] === right[key]); }

/** @param {unknown} raw @param {number} index @param {Array<{id:string,detail:string}>} errors */
function validateRepositoryRow(raw, index, errors) {
  const scope = `repositories[${index}]`;
  if (!object(raw)) { errors.push({ id: "repository-row-invalid", detail: `${scope} must be an object` }); return null; }
  unknown(raw, ["entry", "repository", "profile", "policySource", "evidence", "policyStatus", "evidenceTimeStatus", "checks", "unscopedChecks", "required", "advisory", "technicalStatus", "overallStatus", "technicalDetail"], "repository-row", errors);
  const entry = nonNegativeInteger(raw.entry);
  const repository = raw.repository === null ? null : id(raw.repository);
  const profile = raw.profile === null ? null : id(raw.profile);
  const policySource = raw.policySource === null ? null : text(raw.policySource, 32);
  const policyStatus = text(raw.policyStatus, 16), technicalStatus = text(raw.technicalStatus, 16), overallStatus = text(raw.overallStatus, 16);
  const evidenceTimeStatus = raw.evidenceTimeStatus === undefined ? null : text(raw.evidenceTimeStatus, 16);
  const technicalDetail = raw.technicalDetail === null ? null : text(raw.technicalDetail, 1024);
  if (entry === null || (raw.repository !== null && !repository) || (raw.profile !== null && !profile) || (raw.policySource !== null && !["public-pack", "organization"].includes(policySource ?? "")) || !policyStatus || !POLICY.has(policyStatus) || !technicalStatus || !TECHNICAL.has(technicalStatus) || !overallStatus || !OVERALL.has(overallStatus) || (raw.evidenceTimeStatus !== undefined && !["VALID", "FUTURE"].includes(evidenceTimeStatus ?? "")) || (raw.technicalDetail !== null && !technicalDetail)) {
    errors.push({ id: "repository-row-fields-invalid", detail: `${scope} has invalid scalar fields` });
  }
  const trust = validateTrust(raw.evidence, `${scope}.evidence`, errors);
  const checks = validateScopedChecks(raw.checks, errors, `${scope}.checks`);
  const unscopedChecks = validateUnscopedChecks(raw.unscopedChecks, errors, `${scope}.unscopedChecks`);
  const required = validateCategorySummary(raw.required, `${scope}.required`, errors), advisory = validateCategorySummary(raw.advisory, `${scope}.advisory`, errors);
  if (!checks || !unscopedChecks || !required || !advisory || trust === undefined || entry === null || !policyStatus || !technicalStatus || !overallStatus) return null;
  if (!sameSummary(required, computedCategory(checks, "required"))) errors.push({ id: "required-summary-mismatch", detail: `${scope}.required does not match scoped checks` });
  if (!sameSummary(advisory, computedCategory(checks, "advisory"))) errors.push({ id: "advisory-summary-mismatch", detail: `${scope}.advisory does not match scoped checks` });
  if (repository === null && technicalStatus !== "FAIL") errors.push({ id: "unidentified-technical-status-invalid", detail: `${scope} without repository identity must be technical FAIL` });
  if (policyStatus === "UNAVAILABLE" && technicalStatus !== "FAIL") errors.push({ id: "unavailable-policy-status-invalid", detail: `${scope} unavailable policy requires technical FAIL` });
  const hasFailImpact = checks.some((item) => item.impact === "FAIL"), hasWarnImpact = checks.some((item) => item.impact === "WARN"), future = evidenceTimeStatus === "FUTURE";
  const expectedOverall = technicalStatus === "FAIL" || policyStatus === "FAIL" ? "FAIL" : hasFailImpact ? "FAIL" : hasWarnImpact || future ? "WARN" : "PASS";
  if (overallStatus !== expectedOverall) errors.push({ id: "repository-overall-mismatch", detail: `${scope}.overallStatus is inconsistent with stored policy/check truth` });
  return { entry, repository, profile, policySource, evidence: trust, policyStatus, evidenceTimeStatus, checks, unscopedChecks, required, advisory, technicalStatus, overallStatus, technicalDetail };
}

/** @param {unknown} value */
export function validateEcosystemDashboardSnapshot(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, snapshot: null, errors: [{ id: "snapshot-invalid", detail: "ecosystem dashboard snapshot must be an object" }] };
  unknown(value, ["version", "generatedAt", "repositories", "summary", "technicalStatus", "overallStatus"], "snapshot", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const generatedAt = text(value.generatedAt, 128);
  if (!generatedAt || !isAbsoluteIsoTimestamp(generatedAt)) errors.push({ id: "generated-at-invalid", detail: "generatedAt must be an absolute ISO timestamp" });
  const technicalStatus = text(value.technicalStatus, 16), overallStatus = text(value.overallStatus, 16);
  if (!technicalStatus || !TECHNICAL.has(technicalStatus) || !overallStatus || !OVERALL.has(overallStatus)) errors.push({ id: "snapshot-status-invalid", detail: "snapshot technicalStatus/overallStatus is invalid" });
  /** @type {Array<any>} */ const repositories = [];
  if (!Array.isArray(value.repositories) || value.repositories.length > 4096) errors.push({ id: "repositories-invalid", detail: "repositories must be a bounded array" });
  else for (const [index, raw] of value.repositories.entries()) { const row = validateRepositoryRow(raw, index, errors); if (row) repositories.push(row); }
  if (!object(value.summary)) errors.push({ id: "summary-invalid", detail: "summary must be an object" });
  else {
    unknown(value.summary, ["repositories", "pass", "warn", "fail", "technicalFail", "requiredChecks", "advisoryChecks"], "summary", errors);
    const expected = {
      repositories: repositories.length,
      pass: repositories.filter((item) => item.overallStatus === "PASS").length,
      warn: repositories.filter((item) => item.overallStatus === "WARN").length,
      fail: repositories.filter((item) => item.overallStatus === "FAIL").length,
      technicalFail: repositories.filter((item) => item.technicalStatus === "FAIL").length,
      requiredChecks: repositories.reduce((sum, item) => sum + item.required.total, 0),
      advisoryChecks: repositories.reduce((sum, item) => sum + item.advisory.total, 0),
    };
    for (const [key, expectedValue] of Object.entries(expected)) if (value.summary[key] !== expectedValue) errors.push({ id: "summary-mismatch", detail: `summary.${key} does not match repository rows` });
    const expectedTechnical = expected.technicalFail > 0 ? "FAIL" : "PASS", expectedOverall = expected.fail > 0 ? "FAIL" : expected.warn > 0 ? "WARN" : "PASS";
    if (technicalStatus && technicalStatus !== expectedTechnical) errors.push({ id: "technical-status-mismatch", detail: "snapshot technicalStatus does not match rows" });
    if (overallStatus && overallStatus !== expectedOverall) errors.push({ id: "overall-status-mismatch", detail: "snapshot overallStatus does not match rows" });
  }
  if (errors.length > 0 || !generatedAt || !technicalStatus || !overallStatus) return { valid: false, snapshot: null, errors };
  return { valid: true, snapshot: { version: 1, generatedAt, repositories, technicalStatus, overallStatus }, errors: [] };
}

/** @param {string} value */
function statusRank(value) { return value === "PASS" ? 2 : value === "WARN" ? 1 : 0; }
/** @param {string} previous @param {string} current */
function trend(previous, current) { const delta = statusRank(current) - statusRank(previous); return delta > 0 ? "IMPROVED" : delta < 0 ? "REGRESSED" : "UNCHANGED"; }
/** @param {any[]} rows */
function duplicateIds(rows) { const counts = new Map(); for (const row of rows) if (row.repository) counts.set(row.repository, (counts.get(row.repository) ?? 0) + 1); return new Set([...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id)); }
/** @param {any[]} rows @param {Set<string>} duplicates */
function uniqueRepositoryMap(rows, duplicates) { return new Map(rows.filter((row) => row.repository && !duplicates.has(row.repository)).map((row) => [row.repository, row])); }
/** @param {any[]} checks */
function checkMap(checks) { return new Map(checks.map((check) => [check.id, check])); }

/** @param {any} previous @param {any} current */
function compareChecks(previous, current) {
  const before = checkMap(previous.checks), after = checkMap(current.checks), ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes = []; let unchanged = 0;
  const counts = { added: 0, removed: 0, statusChanged: 0, requirementChanged: 0, bothChanged: 0, unchanged: 0 };
  for (const id of ids) {
    const oldCheck = before.get(id) ?? null, newCheck = after.get(id) ?? null;
    let change;
    if (!oldCheck) change = "ADDED";
    else if (!newCheck) change = "REMOVED";
    else {
      const statusChanged = oldCheck.status !== newCheck.status, requirementChanged = oldCheck.requirement !== newCheck.requirement;
      change = statusChanged && requirementChanged ? "STATUS_AND_REQUIREMENT_CHANGED" : statusChanged ? "STATUS_CHANGED" : requirementChanged ? "REQUIREMENT_CHANGED" : "UNCHANGED";
    }
    if (change === "UNCHANGED") { unchanged += 1; continue; }
    if (change === "ADDED") counts.added += 1;
    else if (change === "REMOVED") counts.removed += 1;
    else if (change === "STATUS_CHANGED") counts.statusChanged += 1;
    else if (change === "REQUIREMENT_CHANGED") counts.requirementChanged += 1;
    else counts.bothChanged += 1;
    changes.push({ id, change, previous: oldCheck ? { requirement: oldCheck.requirement, status: oldCheck.status } : null, current: newCheck ? { requirement: newCheck.requirement, status: newCheck.status } : null });
  }
  counts.unchanged = unchanged;
  return { changes, summary: counts };
}

/** @param {any} previous @param {any} current */
export function compareEcosystemHistory(previous, current) {
  if (Date.parse(current.generatedAt) <= Date.parse(previous.generatedAt)) throw new Error("current dashboard must be newer than previous dashboard");
  const previousDuplicates = duplicateIds(previous.repositories), currentDuplicates = duplicateIds(current.repositories);
  const before = uniqueRepositoryMap(previous.repositories, previousDuplicates), after = uniqueRepositoryMap(current.repositories, currentDuplicates);
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();
  const repositories = [];
  const summary = { improved: 0, regressed: 0, unchanged: 0, added: 0, removed: 0, profileChanged: 0, policySourceChanged: 0, checkChanges: 0 };
  for (const repository of ids) {
    const oldRow = before.get(repository) ?? null, newRow = after.get(repository) ?? null;
    if (!oldRow) { summary.added += 1; repositories.push({ repository, change: "ADDED", previous: null, current: { profile: newRow.profile, policySource: newRow.policySource, overallStatus: newRow.overallStatus, technicalStatus: newRow.technicalStatus }, checkChanges: null }); continue; }
    if (!newRow) { summary.removed += 1; repositories.push({ repository, change: "REMOVED", previous: { profile: oldRow.profile, policySource: oldRow.policySource, overallStatus: oldRow.overallStatus, technicalStatus: oldRow.technicalStatus }, current: null, checkChanges: null }); continue; }
    const statusTrend = trend(oldRow.overallStatus, newRow.overallStatus);
    if (statusTrend === "IMPROVED") summary.improved += 1; else if (statusTrend === "REGRESSED") summary.regressed += 1; else summary.unchanged += 1;
    const profileChanged = oldRow.profile !== newRow.profile, policySourceChanged = oldRow.policySource !== newRow.policySource;
    if (profileChanged) summary.profileChanged += 1; if (policySourceChanged) summary.policySourceChanged += 1;
    const checkChanges = compareChecks(oldRow, newRow); summary.checkChanges += checkChanges.changes.length;
    repositories.push({ repository, change: statusTrend, profileChanged, policySourceChanged, previous: { profile: oldRow.profile, policySource: oldRow.policySource, overallStatus: oldRow.overallStatus, technicalStatus: oldRow.technicalStatus }, current: { profile: newRow.profile, policySource: newRow.policySource, overallStatus: newRow.overallStatus, technicalStatus: newRow.technicalStatus }, checkChanges });
  }
  const previousUnidentified = /** @type {any[]} */ (previous.repositories).filter((row) => row.repository === null).length, currentUnidentified = /** @type {any[]} */ (current.repositories).filter((row) => row.repository === null).length;
  const comparisonChanged = summary.improved + summary.regressed + summary.added + summary.removed + summary.profileChanged + summary.policySourceChanged + summary.checkChanges > 0 || previousDuplicates.size > 0 || currentDuplicates.size > 0 || previousUnidentified !== currentUnidentified;
  return {
    version: 1,
    previousGeneratedAt: previous.generatedAt,
    currentGeneratedAt: current.generatedAt,
    truth: { previousOverallStatus: previous.overallStatus, currentOverallStatus: current.overallStatus, previousTechnicalStatus: previous.technicalStatus, currentTechnicalStatus: current.technicalStatus },
    anomalies: { previousDuplicateRepositoryIds: [...previousDuplicates].sort(), currentDuplicateRepositoryIds: [...currentDuplicates].sort(), previousUnidentifiedRows: previousUnidentified, currentUnidentifiedRows: currentUnidentified },
    repositories,
    summary,
    comparisonStatus: comparisonChanged ? "CHANGED" : "UNCHANGED",
    technicalStatus: "PASS",
    semantics: "historical comparison reports differences only; previous and current dashboard truth is preserved exactly and is never recomputed into a new gate",
  };
}

/** @param {ReturnType<typeof compareEcosystemHistory>} report */
export function formatEcosystemHistory(report) {
  const lines = ["Ecosystem history comparison", "", `Previous: ${report.previousGeneratedAt} (${report.truth.previousOverallStatus})`, `Current: ${report.currentGeneratedAt} (${report.truth.currentOverallStatus})`, `Comparison: ${report.comparisonStatus}`, `Semantics: ${report.semantics}`, ""];
  for (const row of report.repositories) lines.push(`${row.change.padEnd(9)}  ${row.repository}  ${row.previous?.overallStatus ?? "(absent)"} -> ${row.current?.overallStatus ?? "(absent)"}${row.checkChanges ? `  checks changed ${row.checkChanges.changes.length}` : ""}`);
  lines.push("", `Repositories: ${report.summary.improved} improved, ${report.summary.regressed} regressed, ${report.summary.unchanged} unchanged, ${report.summary.added} added, ${report.summary.removed} removed`, `Check changes: ${report.summary.checkChanges}`, `Current truth: ${report.truth.currentOverallStatus}`, `Technical: ${report.technicalStatus}`);
  return lines.join("\n");
}

/** @param {string} filename */
function readJsonBounded(filename) { let stat; try { stat = fs.lstatSync(filename); } catch { return null; } if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_JSON_BYTES) return null; try { return JSON.parse(fs.readFileSync(filename, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) { let previousFile = null, currentFile = null, json = false; for (let index = 0; index < argv.length; index += 1) { const argument = argv[index]; if (argument === "--json") { json = true; continue; } if (!["--previous", "--current"].includes(argument ?? "")) return null; const value = argv[index + 1]; if (typeof value !== "string" || value.startsWith("--")) return null; index += 1; if (argument === "--previous") { if (previousFile) return null; previousFile = value; } else { if (currentFile) return null; currentFile = value; } } return previousFile && currentFile ? { previousFile, currentFile, json } : null; }

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/compare-ecosystem-history.js --previous <dashboard.json> --current <dashboard.json> [--json]"); return 1; }
  const rawPrevious = readJsonBounded(path.resolve(options.previousFile)), rawCurrent = readJsonBounded(path.resolve(options.currentFile));
  if (!rawPrevious || !rawCurrent) { console.error("Ecosystem dashboard snapshot cannot be read or parsed"); return 1; }
  const previous = validateEcosystemDashboardSnapshot(rawPrevious), current = validateEcosystemDashboardSnapshot(rawCurrent);
  if (!previous.valid || !previous.snapshot || !current.valid || !current.snapshot) { console.error("Ecosystem dashboard snapshot is invalid"); return 1; }
  let report; try { report = compareEcosystemHistory(previous.snapshot, current.snapshot); } catch { console.error("Ecosystem dashboard history order is invalid"); return 1; }
  console.log(options.json ? JSON.stringify(report) : formatEcosystemHistory(report));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
