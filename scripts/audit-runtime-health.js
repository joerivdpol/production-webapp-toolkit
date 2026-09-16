#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";
import { validateRuntimeHealthEvidence } from "./runtime-health-evidence.js";

const SEVERITIES = new Set(["blocking", "advisory"]);

/** @typedef {{id:string,severity:"blocking"|"advisory",allowDegraded:boolean}} HealthRequirement */
/** @typedef {{version:1,evaluatedAt:string,runtime:{name:string,environment?:string},maxEvidenceAgeSeconds:number,freshnessSeverity:"blocking"|"advisory",checks:HealthRequirement[]}} RuntimeHealthPolicy */
/** @typedef {{id:string,status:"PASS"|"WARN"|"FAIL",subject:string,detail:string}} HealthAuditCheck */

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
/** @param {Record<string, unknown>} value @param {string[]} allowed */
function hasOnly(value, allowed) { return Object.keys(value).every((key) => allowed.includes(key)); }
/** @param {"blocking"|"advisory"} severity */
function issueStatus(severity) { return severity === "blocking" ? "FAIL" : "WARN"; }

/** @param {unknown} value */
export function validateRuntimeHealthPolicy(value) {
  if (!plainObject(value) || !hasOnly(value, ["version", "evaluatedAt", "runtime", "maxEvidenceAgeSeconds", "freshnessSeverity", "checks"])) {
    return { ok: false, policy: null, error: "runtime health policy contains unsupported fields" };
  }
  if (value.version !== 1) return { ok: false, policy: null, error: "policy version must be exactly 1" };
  const evaluatedAt = text(value.evaluatedAt, 64);
  if (!evaluatedAt || !isAbsoluteIsoTimestamp(evaluatedAt)) return { ok: false, policy: null, error: "evaluatedAt must be an absolute ISO timestamp" };
  if (!Number.isInteger(value.maxEvidenceAgeSeconds) || Number(value.maxEvidenceAgeSeconds) < 0 || Number(value.maxEvidenceAgeSeconds) > 31_536_000) {
    return { ok: false, policy: null, error: "maxEvidenceAgeSeconds must be a bounded non-negative integer" };
  }
  const freshnessSeverity = text(value.freshnessSeverity, 16)?.toLowerCase() ?? null;
  if (!freshnessSeverity || !SEVERITIES.has(freshnessSeverity)) return { ok: false, policy: null, error: "freshnessSeverity must be blocking or advisory" };

  if (!plainObject(value.runtime) || !hasOnly(value.runtime, ["name", "environment"])) return { ok: false, policy: null, error: "runtime policy identity is invalid" };
  const runtimeName = text(value.runtime.name, 128);
  const environment = value.runtime.environment === undefined ? null : text(value.runtime.environment, 128);
  if (!runtimeName || (value.runtime.environment !== undefined && !environment)) return { ok: false, policy: null, error: "runtime policy identity is invalid" };

  if (!Array.isArray(value.checks) || value.checks.length === 0 || value.checks.length > 256) return { ok: false, policy: null, error: "checks must be a non-empty bounded array" };
  /** @type {HealthRequirement[]} */
  const checks = [];
  const ids = new Set();
  for (const [index, raw] of value.checks.entries()) {
    if (!plainObject(raw) || !hasOnly(raw, ["id", "severity", "allowDegraded"])) return { ok: false, policy: null, error: `checks[${index}] contains unsupported fields` };
    const id = text(raw.id, 128);
    const severity = text(raw.severity, 16)?.toLowerCase() ?? null;
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || !severity || !SEVERITIES.has(severity) || typeof raw.allowDegraded !== "boolean") {
      return { ok: false, policy: null, error: `checks[${index}] is invalid` };
    }
    if (ids.has(id)) return { ok: false, policy: null, error: `duplicate health policy check ${id}` };
    ids.add(id);
    checks.push({ id, severity: /** @type {"blocking"|"advisory"} */ (severity), allowDegraded: raw.allowDegraded });
  }
  checks.sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    policy: /** @type {RuntimeHealthPolicy} */ ({
      version: 1,
      evaluatedAt,
      runtime: { name: runtimeName, ...(environment ? { environment } : {}) },
      maxEvidenceAgeSeconds: Number(value.maxEvidenceAgeSeconds),
      freshnessSeverity: /** @type {"blocking"|"advisory"} */ (freshnessSeverity),
      checks,
    }),
    error: null,
  };
}

/** @param {any} evidence @param {RuntimeHealthPolicy} policy */
export function inspectRuntimeHealth(evidence, policy) {
  /** @type {HealthAuditCheck[]} */
  const checks = [];
  if (evidence.runtime.name !== policy.runtime.name || (policy.runtime.environment !== undefined && evidence.runtime.environment !== policy.runtime.environment)) {
    checks.push({ id: "runtime-identity-mismatch", status: "FAIL", subject: "runtime", detail: "health evidence belongs to a different runtime identity" });
    return buildReport(evidence, policy, checks);
  }

  const evaluatedMs = Date.parse(policy.evaluatedAt);
  const collectedMs = Date.parse(evidence.evidence.collectedAt);
  const ageSeconds = Math.floor((evaluatedMs - collectedMs) / 1000);
  if (ageSeconds < 0) {
    checks.push({ id: "health-evidence-future", status: issueStatus(policy.freshnessSeverity), subject: "evidence", detail: "health evidence was collected after the policy evaluation time" });
  } else if (ageSeconds > policy.maxEvidenceAgeSeconds) {
    checks.push({ id: "health-evidence-stale", status: issueStatus(policy.freshnessSeverity), subject: "evidence", detail: `health evidence age ${ageSeconds}s exceeds maximum ${policy.maxEvidenceAgeSeconds}s` });
  } else {
    checks.push({ id: "health-evidence-fresh", status: "PASS", subject: "evidence", detail: `health evidence age ${ageSeconds}s is within policy` });
  }

  const observed = new Map(evidence.checks.map((/** @type {any} */ check) => [check.id, check]));
  const configured = new Set(policy.checks.map((check) => check.id));
  for (const requirement of policy.checks) {
    const observedCheck = observed.get(requirement.id);
    if (!observedCheck) {
      checks.push({ id: "health-check-missing", status: issueStatus(requirement.severity), subject: requirement.id, detail: "required health check is absent from evidence" });
      continue;
    }
    if (observedCheck.status === "HEALTHY") {
      checks.push({ id: "health-check-healthy", status: "PASS", subject: requirement.id, detail: `${observedCheck.category} health is healthy` });
    } else if (observedCheck.status === "DEGRADED" && requirement.allowDegraded) {
      checks.push({ id: "health-check-degraded", status: "WARN", subject: requirement.id, detail: `${observedCheck.category} health is degraded but policy permits degraded operation` });
    } else {
      checks.push({
        id: observedCheck.status === "DEGRADED" ? "health-check-degraded" : observedCheck.status === "UNHEALTHY" ? "health-check-unhealthy" : "health-check-unknown",
        status: issueStatus(requirement.severity),
        subject: requirement.id,
        detail: `${observedCheck.category} health status is ${observedCheck.status.toLowerCase()}`,
      });
    }
  }

  for (const observedCheck of evidence.checks) {
    if (configured.has(observedCheck.id)) continue;
    checks.push({
      id: "health-check-unconfigured",
      status: observedCheck.status === "HEALTHY" ? "PASS" : "WARN",
      subject: observedCheck.id,
      detail: `unconfigured ${observedCheck.category} check reported ${observedCheck.status.toLowerCase()}`,
    });
  }
  return buildReport(evidence, policy, checks);
}

/** @param {any} evidence @param {RuntimeHealthPolicy} policy @param {HealthAuditCheck[]} checks */
function buildReport(evidence, policy, checks) {
  const summary = {
    pass: checks.filter((check) => check.status === "PASS").length,
    warn: checks.filter((check) => check.status === "WARN").length,
    fail: checks.filter((check) => check.status === "FAIL").length,
  };
  return {
    runtime: evidence.runtime,
    evidence: evidence.evidence,
    evaluatedAt: policy.evaluatedAt,
    checks,
    summary,
    deploymentIdentityStatus: "NOT_EVALUATED",
    technicalStatus: "PASS",
    overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectRuntimeHealth>} report */
export function formatRuntimeHealthAudit(report) {
  const lines = [
    "Runtime health audit", "",
    `Runtime: ${report.runtime.name}`,
    `Environment: ${report.runtime.environment ?? "(not supplied)"}`,
    `Source: ${report.evidence.source}`,
    `Authenticated: ${report.evidence.authenticated}`,
    `Collected at: ${report.evidence.collectedAt}`,
    `Evaluated at: ${report.evaluatedAt}`,
    "Deployment identity: NOT EVALUATED", "",
  ];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.subject}  ${check.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string} filename */
function readJson(filename) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(filename, "utf8")) }; }
  catch { return { ok: false, value: null }; }
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let evidenceFile = null, policyFile = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--evidence-file" && argument !== "--policy") return null;
    const candidate = argv[index + 1];
    if (typeof candidate !== "string" || candidate.startsWith("--") || candidate.length === 0) return null;
    index += 1;
    if (argument === "--evidence-file") { if (evidenceFile !== null) return null; evidenceFile = candidate; }
    else { if (policyFile !== null) return null; policyFile = candidate; }
  }
  return evidenceFile && policyFile ? { evidenceFile, policyFile, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/audit-runtime-health.js --evidence-file <runtime-health.json> --policy <policy.json> [--json]");
    return 1;
  }
  const rawEvidence = readJson(options.evidenceFile);
  const rawPolicy = readJson(options.policyFile);
  if (!rawEvidence.ok || !rawPolicy.ok) { console.error("Runtime health audit input cannot be read or parsed"); return 1; }
  const evidenceResult = validateRuntimeHealthEvidence(rawEvidence.value);
  const policyResult = validateRuntimeHealthPolicy(rawPolicy.value);
  if (!evidenceResult.valid || !evidenceResult.evidence || !policyResult.ok || !policyResult.policy) {
    console.error("Runtime health evidence or policy is invalid");
    return 1;
  }
  const report = inspectRuntimeHealth(evidenceResult.evidence, policyResult.policy);
  console.log(options.json ? JSON.stringify(report) : formatRuntimeHealthAudit(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
