#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";
import { validateVulnerabilityEvidence } from "./vulnerability-evidence.js";

const SEVERITIES = new Set(["LOW", "MODERATE", "HIGH", "CRITICAL", "UNKNOWN"]);
const RELATIONSHIPS = new Set(["direct", "transitive", "unknown"]);

/** @typedef {{ id:string,reason:string,expiresAt?:string }} VulnerabilityException */
/** @typedef {{ version:1,evaluatedAt:string,maxEvidenceAgeSeconds:number|null,blockingSeverities:string[],blockingRelationships:string[],exceptions:VulnerabilityException[] }} VulnerabilityPolicy */
/** @typedef {{ id:string,status:"PASS"|"WARN"|"FAIL",subject:string,severity:string,relationship:string,exploitability:"UNKNOWN",fixStatus:"AVAILABLE"|"UNKNOWN",detail:string }} VulnerabilityCheck */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {unknown} value @param {Set<string>} allowed */
function normalizedUniqueList(value, allowed) {
  if (!Array.isArray(value)) return null;
  const items = value.map((item) => text(item)?.toUpperCase() ?? null);
  if (items.some((item) => item === null || !allowed.has(/** @type {string} */ (item)))) return null;
  if (new Set(items).size !== items.length) return null;
  return /** @type {string[]} */ (items);
}
/** @param {unknown} value */
function normalizedRelationshipList(value) {
  if (!Array.isArray(value)) return null;
  const items = value.map((item) => text(item)?.toLowerCase() ?? null);
  if (items.some((item) => item === null || !RELATIONSHIPS.has(/** @type {string} */ (item)))) return null;
  if (new Set(items).size !== items.length) return null;
  return /** @type {string[]} */ (items);
}

/** @param {unknown} value */
export function validateVulnerabilityPolicy(value) {
  if (!isPlainObject(value)) return { ok: false, policy: null, error: "policy must be an object" };
  const allowed = ["version", "evaluatedAt", "maxEvidenceAgeSeconds", "blockingSeverities", "blockingRelationships", "exceptions"];
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) return { ok: false, policy: null, error: `unsupported policy field ${key}` };
  }
  if (value.version !== 1) return { ok: false, policy: null, error: "policy version must be exactly 1" };
  const evaluatedAt = text(value.evaluatedAt);
  if (!evaluatedAt || !isAbsoluteIsoTimestamp(evaluatedAt)) {
    return { ok: false, policy: null, error: "evaluatedAt must be an absolute ISO timestamp" };
  }
  let maxEvidenceAgeSeconds = null;
  if (value.maxEvidenceAgeSeconds !== undefined) {
    if (!Number.isInteger(value.maxEvidenceAgeSeconds) || Number(value.maxEvidenceAgeSeconds) < 0) {
      return { ok: false, policy: null, error: "maxEvidenceAgeSeconds must be a non-negative integer" };
    }
    maxEvidenceAgeSeconds = Number(value.maxEvidenceAgeSeconds);
  }  const blockingSeverities = normalizedUniqueList(value.blockingSeverities, SEVERITIES);
  if (blockingSeverities === null) {
    return { ok: false, policy: null, error: "blockingSeverities must be a unique severity array" };
  }
  const blockingRelationships = normalizedRelationshipList(value.blockingRelationships);
  if (blockingRelationships === null) {
    return { ok: false, policy: null, error: "blockingRelationships must be a unique relationship array" };
  }
  const rawExceptions = value.exceptions === undefined ? [] : value.exceptions;
  if (!Array.isArray(rawExceptions)) return { ok: false, policy: null, error: "exceptions must be an array" };
  /** @type {VulnerabilityException[]} */
  const exceptions = [];
  const seen = new Set();
  for (const [index, raw] of rawExceptions.entries()) {
    if (!isPlainObject(raw)) return { ok: false, policy: null, error: `exceptions[${index}] must be an object` };
    for (const key of Object.keys(raw)) {
      if (!["id", "reason", "expiresAt"].includes(key)) {
        return { ok: false, policy: null, error: `exceptions[${index}] contains unsupported field ${key}` };
      }
    }
    const id = text(raw.id);
    const reason = text(raw.reason);
    const expiresAt = raw.expiresAt === undefined ? null : text(raw.expiresAt);
    if (!id || id.length > 255 || /[\u0000\r\n]/.test(id)) return { ok: false, policy: null, error: `exceptions[${index}].id is invalid` };
    if (!reason || reason.length > 512 || /[\u0000\r\n]/.test(reason)) return { ok: false, policy: null, error: `exceptions[${index}].reason is invalid` };
    if (expiresAt !== null && !isAbsoluteIsoTimestamp(expiresAt)) return { ok: false, policy: null, error: `exceptions[${index}].expiresAt is invalid` };
    if (seen.has(id)) return { ok: false, policy: null, error: `duplicate exception ${id}` };
    seen.add(id);
    exceptions.push({ id, reason, ...(expiresAt ? { expiresAt } : {}) });
  }  exceptions.sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    policy: /** @type {VulnerabilityPolicy} */ ({
      version: 1,
      evaluatedAt,
      maxEvidenceAgeSeconds,
      blockingSeverities,
      blockingRelationships,
      exceptions,
    }),
    error: null,
  };
}

/** @param {VulnerabilityException[]} exceptions @param {{id:string,aliases:string[]}} vulnerability @param {number} evaluatedMs */
function matchingException(exceptions, vulnerability, evaluatedMs) {
  const ids = new Set([vulnerability.id, ...vulnerability.aliases]);
  for (const exception of exceptions) {
    if (!ids.has(exception.id)) continue;
    const expiresMs = exception.expiresAt ? Date.parse(exception.expiresAt) : null;
    if (expiresMs !== null && expiresMs <= evaluatedMs) {
      return { exception, active: false };
    }
    return { exception, active: true };
  }
  return null;
}

/** @param {string} ecosystem @param {string} name @param {string} version @param {string} vulnerabilityId */
function subject(ecosystem, name, version, vulnerabilityId) {
  return `${ecosystem}:${name}@${version}:${vulnerabilityId}`;
}
/** @param {any} evidence @param {VulnerabilityPolicy} policy */
export function inspectVulnerabilities(evidence, policy) {
  /** @type {VulnerabilityCheck[]} */
  const checks = [];
  const evaluatedMs = Date.parse(policy.evaluatedAt);
  const collectedMs = Date.parse(evidence.source.collectedAt);
  const ageSeconds = Math.floor((evaluatedMs - collectedMs) / 1000);
  if (ageSeconds < 0) {
    checks.push({
      id: "evidence-future",
      status: "FAIL",
      subject: "evidence",
      severity: "UNKNOWN",
      relationship: "unknown",
      exploitability: "UNKNOWN",
      fixStatus: "UNKNOWN",
      detail: "evidence collection time is later than policy evaluation time",
    });
  } else if (policy.maxEvidenceAgeSeconds !== null && ageSeconds > policy.maxEvidenceAgeSeconds) {
    checks.push({
      id: "evidence-stale",
      status: "FAIL",
      subject: "evidence",
      severity: "UNKNOWN",
      relationship: "unknown",
      exploitability: "UNKNOWN",
      fixStatus: "UNKNOWN",
      detail: `evidence age ${ageSeconds}s exceeds configured maximum ${policy.maxEvidenceAgeSeconds}s`,
    });
  } else {
    checks.push({
      id: "evidence-freshness",
      status: "PASS",
      subject: "evidence",
      severity: "UNKNOWN",
      relationship: "unknown",
      exploitability: "UNKNOWN",
      fixStatus: "UNKNOWN",
      detail: policy.maxEvidenceAgeSeconds === null ? "no maximum evidence age configured" : `evidence age ${ageSeconds}s is within policy`,
    });
  }
  let findingCount = 0;
  for (const pkg of evidence.packages) {
    for (const vulnerability of pkg.vulnerabilities) {
      findingCount += 1;
      const exceptionMatch = matchingException(policy.exceptions, vulnerability, evaluatedMs);
      const fixStatus = vulnerability.fixedVersions.length > 0 ? "AVAILABLE" : "UNKNOWN";
      const itemSubject = subject(pkg.ecosystem, pkg.name, pkg.version, vulnerability.id);
      if (exceptionMatch?.active) {
        checks.push({
          id: "vulnerability-excepted",
          status: "WARN",
          subject: itemSubject,
          severity: vulnerability.severity,
          relationship: pkg.relationship,
          exploitability: "UNKNOWN",
          fixStatus,
          detail: `known vulnerability is covered by active exception ${exceptionMatch.exception.id}; exploitability remains unknown`,
        });
        continue;
      }
      const blocked = policy.blockingSeverities.includes(vulnerability.severity) &&
        policy.blockingRelationships.includes(pkg.relationship);
      const expired = exceptionMatch && !exceptionMatch.active ? `; matching exception ${exceptionMatch.exception.id} is expired` : "";
      checks.push({
        id: blocked ? "vulnerability-blocking" : "vulnerability-advisory",
        status: blocked ? "FAIL" : "WARN",
        subject: itemSubject,
        severity: vulnerability.severity,
        relationship: pkg.relationship,
        exploitability: "UNKNOWN",
        fixStatus,
        detail: `known vulnerability; exploitability is not established; fix ${fixStatus.toLowerCase()}${expired}`,
      });
    }
  }
  if (findingCount === 0) {
    checks.push({
      id: "no-known-vulnerabilities",
      status: "PASS",
      subject: "packages",
      severity: "UNKNOWN",
      relationship: "unknown",
      exploitability: "UNKNOWN",
      fixStatus: "UNKNOWN",
      detail: "evidence contains no vulnerability records for the queried package versions",
    });
  }
  const summary = {
    pass: checks.filter((check) => check.status === "PASS").length,
    warn: checks.filter((check) => check.status === "WARN").length,
    fail: checks.filter((check) => check.status === "FAIL").length,
  };
  return {
    source: evidence.source,
    policy,
    checks,
    summary,
    findingCount,
    technicalStatus: "PASS",
    overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectVulnerabilities>} report */
export function formatVulnerabilityAudit(report) {
  const lines = [
    "Vulnerability evidence audit",
    "",
    `Provider: ${report.source.provider}`,
    `Authenticated: ${report.source.authenticated}`,
    `Collected at: ${report.source.collectedAt}`,
    `Evaluated at: ${report.policy.evaluatedAt}`,
    "Exploitability: advisory presence does not establish exploitability",
    "",
  ];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.subject}  severity=${check.severity}  relationship=${check.relationship}  fix=${check.fixStatus}`);
  }
  lines.push(
    "",
    `Findings: ${report.findingCount}`,
    `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`,
    `Technical: ${report.technicalStatus}`,
    `Overall: ${report.overallStatus}`,
  );
  return lines.join("\n");
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
    if (argument === "--evidence-file") {
      if (evidenceFile !== null) return null;
      evidenceFile = value;
    } else {
      if (policyFile !== null) return null;
      policyFile = value;
    }
  }
  return evidenceFile && policyFile ? { evidenceFile, policyFile, json } : null;
}

/** @param {string} filename */
function readJson(filename) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(filename, "utf8")) }; }
  catch { return { ok: false, value: null }; }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/audit-vulnerabilities.js --evidence-file <evidence.json> --policy <policy.json> [--json]");
    return 1;
  }  const rawEvidence = readJson(options.evidenceFile);
  const rawPolicy = readJson(options.policyFile);
  if (!rawEvidence.ok) { console.error("Vulnerability evidence cannot be read or parsed"); return 1; }
  if (!rawPolicy.ok) { console.error("Vulnerability policy cannot be read or parsed"); return 1; }
  const evidenceResult = validateVulnerabilityEvidence(rawEvidence.value);
  const policyResult = validateVulnerabilityPolicy(rawPolicy.value);
  if (!evidenceResult.ok || evidenceResult.evidence === null) {
    console.error("Vulnerability evidence is invalid");
    return 1;
  }
  if (!policyResult.ok || policyResult.policy === null) {
    console.error("Vulnerability policy is invalid");
    return 1;
  }
  const report = inspectVulnerabilities(evidenceResult.evidence, policyResult.policy);
  console.log(options.json ? JSON.stringify(report) : formatVulnerabilityAudit(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
