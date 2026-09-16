#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { normalizeLicenseExpression, validateLicenseEvidence } from "./license-evidence.js";

const RELATIONSHIPS = new Set(["direct-production", "direct-development", "direct-optional", "transitive"]);
const ISSUE_STATUSES = new Set(["WARN", "FAIL"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value @param {string} field @param {Array<{id:string,detail:string}>} errors */
function expressionList(value, field, errors) {
  if (!Array.isArray(value)) { errors.push({ id: `${field}-invalid`, detail: `${field} must be an array` }); return []; }
  const expressions = [];
  for (const [index, raw] of value.entries()) {
    const normalized = normalizeLicenseExpression(raw);
    if (normalized === null) { errors.push({ id: `${field}-entry-invalid`, detail: `${field}[${index}] is not a supported exact expression` }); continue; }
    expressions.push(normalized);
  }
  if (new Set(expressions).size !== expressions.length) errors.push({ id: `${field}-duplicate`, detail: `${field} must not contain duplicates` });
  return [...new Set(expressions)].sort();
}

/** @param {unknown} value */
export function validateLicensePolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, policy: null, errors: [{ id: "policy-invalid", detail: "license policy must be an object" }] };
  rejectUnknown(value, ["version", "includedRelationships", "allowedExpressions", "deniedExpressions", "unknownStatus", "unlistedStatus"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  const included = Array.isArray(value.includedRelationships) ? value.includedRelationships : [];
  if (!Array.isArray(value.includedRelationships) || included.length === 0 || included.some((item) => typeof item !== "string" || !RELATIONSHIPS.has(item))) {
    errors.push({ id: "included-relationships-invalid", detail: "includedRelationships must contain supported relationship values" });
  }
  if (new Set(included).size !== included.length) errors.push({ id: "included-relationships-duplicate", detail: "includedRelationships must be unique" });
  const allowedExpressions = expressionList(value.allowedExpressions, "allowedExpressions", errors);
  const deniedExpressions = expressionList(value.deniedExpressions, "deniedExpressions", errors);
  const overlap = allowedExpressions.filter((item) => deniedExpressions.includes(item));
  if (overlap.length > 0) errors.push({ id: "expression-policy-overlap", detail: "an exact license expression cannot be both allowed and denied" });
  if (!ISSUE_STATUSES.has(String(value.unknownStatus ?? ""))) errors.push({ id: "unknown-status-invalid", detail: "unknownStatus must be WARN or FAIL" });
  if (!ISSUE_STATUSES.has(String(value.unlistedStatus ?? ""))) errors.push({ id: "unlisted-status-invalid", detail: "unlistedStatus must be WARN or FAIL" });
  if (errors.length > 0) return { ok: false, policy: null, errors };
  return {
    ok: true,
    policy: {
      version: 1,
      includedRelationships: [...included].sort(),
      allowedExpressions,
      deniedExpressions,
      unknownStatus: value.unknownStatus,
      unlistedStatus: value.unlistedStatus,
    },
    errors: [],
  };
}

/** @param {any} evidence @param {any} policy */
export function inspectLicensePolicy(evidence, policy) {
  const included = new Set(policy.includedRelationships);
  const allowed = new Set(policy.allowedExpressions);
  const denied = new Set(policy.deniedExpressions);
  const checks = [];
  for (const item of evidence.packages) {
    const subject = `${item.name}@${item.version}`;
    if (!included.has(item.relationship)) {
      checks.push({ id: "relationship-out-of-scope", status: "PASS", subject, relationship: item.relationship, licenseExpression: item.licenseExpression, detail: "package relationship is outside the explicit license policy scope" });
      continue;
    }
    if (item.licenseExpression === null) {
      checks.push({ id: "license-unknown", status: policy.unknownStatus, subject, relationship: item.relationship, licenseExpression: null, detail: "installed package manifest does not provide a supported exact license expression" });
      continue;
    }
    if (denied.has(item.licenseExpression)) {
      checks.push({ id: "license-denied", status: "FAIL", subject, relationship: item.relationship, licenseExpression: item.licenseExpression, detail: "exact declared license expression is denied by policy" });
      continue;
    }
    if (allowed.has(item.licenseExpression)) {
      checks.push({ id: "license-allowed", status: "PASS", subject, relationship: item.relationship, licenseExpression: item.licenseExpression, detail: "exact declared license expression is allowed by policy" });
      continue;
    }
    checks.push({ id: "license-unlisted", status: policy.unlistedStatus, subject, relationship: item.relationship, licenseExpression: item.licenseExpression, detail: "exact declared license expression is not listed by policy" });
  }

  const pass = checks.filter((item) => item.status === "PASS").length;
  const warn = checks.filter((item) => item.status === "WARN").length;
  const fail = checks.filter((item) => item.status === "FAIL").length;
  return {
    artifact: evidence.artifact,
    source: evidence.source,
    checks,
    summary: { pass, warn, fail },
    technicalStatus: "PASS",
    overallStatus: fail > 0 ? "FAIL" : warn > 0 ? "WARN" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectLicensePolicy>} report */
export function formatLicenseAudit(report) {
  const lines = [
    "Dependency license policy audit",
    "",
    `Artifact: ${report.artifact.name}@${report.artifact.version}`,
    `Evidence source: ${report.source.kind}`,
    "Interpretation: exact declared expressions only; no legal equivalence is inferred",
    "",
  ];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(4)}  ${check.subject}  ${check.relationship}  ${check.licenseExpression ?? "UNKNOWN"}  ${check.id}`);
  }
  lines.push(
    "",
    `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`,
    `Technical: ${report.technicalStatus}`,
    `Overall: ${report.overallStatus}`,
  );
  return lines.join("\n");
}

/** @param {string} filename */
function readJson(filename) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(filename, "utf8")) }; }
  catch { return { ok: false, value: null }; }
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let evidenceFile = null;
  let policyFile = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--evidence-file" && argument !== "--policy") return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--evidence-file") { if (evidenceFile !== null) return null; evidenceFile = value; }
    else { if (policyFile !== null) return null; policyFile = value; }
  }
  return evidenceFile && policyFile ? { evidenceFile, policyFile, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/audit-licenses.js --evidence-file <license-evidence.json> --policy <license-policy.json> [--json]");
    return 1;
  }
  const evidenceRaw = readJson(options.evidenceFile);
  const policyRaw = readJson(options.policyFile);
  if (!evidenceRaw.ok) { console.error("License evidence file cannot be read or parsed"); return 1; }
  if (!policyRaw.ok) { console.error("License policy file cannot be read or parsed"); return 1; }
  const evidenceResult = validateLicenseEvidence(evidenceRaw.value);
  const policyResult = validateLicensePolicy(policyRaw.value);
  if (!evidenceResult.ok || evidenceResult.evidence === null) { console.error("License evidence is invalid"); return 1; }
  if (!policyResult.ok || policyResult.policy === null) { console.error("License policy is invalid"); return 1; }
  const report = inspectLicensePolicy(evidenceResult.evidence, policyResult.policy);
  console.log(options.json ? JSON.stringify(report) : formatLicenseAudit(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
