#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateRollbackReadinessReport } from "./audit-rollback-readiness.js";
import { validateReleaseEvidenceBundle } from "./release-evidence-bundle.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const RELEASE_TRUST_IDS = new Set([
  "ci",
  "provenance",
  "runtime",
  "runtimeHealth",
  "vulnerability",
]);
const ROLLBACK_TRUST_IDS = new Set([
  "currentProvenance",
  "previousProvenance",
  "changeEvidence",
]);
const NON_FAIL_RESULTS = new Set(["PASS", "WARN"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized)
    ? normalized
    : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value @param {Set<string>} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function enumList(value, allowed, scope, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    errors.push({ id: `${scope}-invalid`, detail: `${scope} must be a non-empty bounded array` });
    return null;
  }
  const normalized = value.map((item) => text(item, 128));
  if (normalized.some((item) => item === null) || normalized.some((item) => !allowed.has(/** @type {string} */ (item))) || new Set(normalized).size !== normalized.length) {
    errors.push({ id: `${scope}-invalid`, detail: `${scope} contains invalid or duplicate values` });
    return null;
  }
  return /** @type {string[]} */ (normalized).sort();
}

/** @param {unknown} value @param {Array<{id:string,detail:string}>} errors */
function ciCheckList(value, errors) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 256) {
    errors.push({ id: "required-ci-checks-invalid", detail: "requiredCiChecks must be a non-empty bounded array" });
    return null;
  }
  const normalized = value.map((item) => text(item, 256));
  if (normalized.some((item) => item === null) || new Set(normalized).size !== normalized.length) {
    errors.push({ id: "required-ci-checks-invalid", detail: "requiredCiChecks contains invalid or duplicate names" });
    return null;
  }
  return /** @type {string[]} */ (normalized).sort();
}

/** @param {unknown} value */
export function validateDeploymentGatePolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "deployment gate policy must be an object" }] };
  rejectUnknown(value, ["version", "maxBundleAgeSeconds", "requiredAuthenticatedEvidence", "requiredCiChecks", "allowedRuntimeHealthStatuses", "allowedVulnerabilityStatuses", "rollback"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const maxBundleAgeSeconds = Number.isSafeInteger(value.maxBundleAgeSeconds) && Number(value.maxBundleAgeSeconds) >= 1 && Number(value.maxBundleAgeSeconds) <= 365 * 24 * 60 * 60 ? Number(value.maxBundleAgeSeconds) : null;
  if (maxBundleAgeSeconds === null) errors.push({ id: "max-bundle-age-invalid", detail: "maxBundleAgeSeconds must be a positive bounded integer" });

  const requiredAuthenticatedEvidence = enumList(value.requiredAuthenticatedEvidence, RELEASE_TRUST_IDS, "required-authenticated-evidence", errors);
  const requiredCiChecks = ciCheckList(value.requiredCiChecks, errors);
  const allowedRuntimeHealthStatuses = enumList(value.allowedRuntimeHealthStatuses, NON_FAIL_RESULTS, "allowed-runtime-health-statuses", errors);
  const allowedVulnerabilityStatuses = enumList(value.allowedVulnerabilityStatuses, NON_FAIL_RESULTS, "allowed-vulnerability-statuses", errors);

  let rollback = null;
  if (!object(value.rollback)) errors.push({ id: "rollback-policy-invalid", detail: "rollback must be an object" });
  else {
    rejectUnknown(value.rollback, ["allowedStatuses", "requiredAuthenticatedEvidence"], "rollback", errors);
    const allowedStatuses = enumList(value.rollback.allowedStatuses, NON_FAIL_RESULTS, "rollback-allowed-statuses", errors);
    const requiredRollbackAuth = enumList(value.rollback.requiredAuthenticatedEvidence, ROLLBACK_TRUST_IDS, "rollback-required-authenticated-evidence", errors);
    if (allowedStatuses && requiredRollbackAuth) rollback = { allowedStatuses, requiredAuthenticatedEvidence: requiredRollbackAuth };
  }

  if (errors.length > 0 || !requiredAuthenticatedEvidence || !requiredCiChecks || !allowedRuntimeHealthStatuses || !allowedVulnerabilityStatuses || !rollback) {
    return { valid: false, policy: null, errors };
  }
  return {
    valid: true,
    policy: {
      version: 1,
      maxBundleAgeSeconds,
      requiredAuthenticatedEvidence,
      requiredCiChecks,
      allowedRuntimeHealthStatuses,
      allowedVulnerabilityStatuses,
      rollback,
    },
    errors: [],
  };
}

const RELEASE_TRUST_FIELD = {
  ci: "ciAuthenticated",
  provenance: "provenanceAuthenticated",
  runtime: "runtimeAuthenticated",
  runtimeHealth: "runtimeHealthAuthenticated",
  vulnerability: "vulnerabilityAuthenticated",
};
const ROLLBACK_TRUST_FIELD = {
  currentProvenance: "currentProvenanceAuthenticated",
  previousProvenance: "previousProvenanceAuthenticated",
  changeEvidence: "changeEvidenceAuthenticated",
};

/** @param {any} left @param {any} right */
function sameRuntime(left, right) {
  return left.name === right.name && (left.environment ?? null) === (right.environment ?? null);
}

/** @param {Array<{id:string,status:"PASS"|"BLOCK"|"UNVERIFIED",detail:string}>} checks @param {string} id @param {"PASS"|"BLOCK"|"UNVERIFIED"} status @param {string} detail */
function gateFinding(checks, id, status, detail) {
  checks.push({ id, status, detail });
}

/** @param {any} bundle @param {any} rollback @param {any} policy @param {string} evaluatedAt */
export function inspectDeploymentGate(bundle, rollback, policy, evaluatedAt) {
  /** @type {Array<{id:string,status:"PASS"|"BLOCK"|"UNVERIFIED",detail:string}>} */ const checks = [];
  if (!isAbsoluteIsoTimestamp(evaluatedAt)) throw new Error("evaluatedAt must be an absolute ISO timestamp");
  const bundleAgeSeconds = (Date.parse(evaluatedAt) - Date.parse(bundle.createdAt)) / 1000;
  gateFinding(checks, "release-bundle-time", bundleAgeSeconds < 0 ? "BLOCK" : bundleAgeSeconds > policy.maxBundleAgeSeconds ? "UNVERIFIED" : "PASS", bundleAgeSeconds < 0 ? "release bundle was created after gate evaluation time" : bundleAgeSeconds > policy.maxBundleAgeSeconds ? `release bundle age ${bundleAgeSeconds}s exceeds maximum ${policy.maxBundleAgeSeconds}s` : `release bundle age ${bundleAgeSeconds}s is within maximum ${policy.maxBundleAgeSeconds}s`);

  gateFinding(checks, "release-bundle-status", bundle.bundleStatus === "VALID" ? "PASS" : "BLOCK", bundle.bundleStatus === "VALID" ? "release evidence bundle is coherent" : "release evidence bundle is INVALID");
  gateFinding(checks, "rollback-technical-status", rollback.technicalStatus === "PASS" ? "PASS" : "BLOCK", rollback.technicalStatus === "PASS" ? "rollback audit completed technically" : "rollback audit has a technical failure");
  gateFinding(checks, "release-rollback-commit", bundle.source.commit === rollback.currentCommit ? "PASS" : "BLOCK", "release source commit must equal rollback current commit");
  gateFinding(checks, "release-rollback-artifact", bundle.artifact.sha256 === rollback.artifacts.currentSha256 ? "PASS" : "BLOCK", "release artifact SHA256 must equal rollback current artifact SHA256");
  gateFinding(checks, "release-rollback-runtime", sameRuntime(bundle.runtime, rollback.runtime) ? "PASS" : "BLOCK", "release runtime identity must equal rollback runtime identity");

  gateFinding(checks, "artifact-provenance-result", bundle.results.artifactProvenance === "PASS" ? "PASS" : "BLOCK", "artifact provenance result must be PASS");
  const ciByName = new Map(bundle.results.ciChecks.map((/** @type {any} */ item) => [item.name, item.status]));
  for (const name of policy.requiredCiChecks) {
    const status = ciByName.get(name);
    if (status === "PASS") gateFinding(checks, `ci:${name}`, "PASS", "required CI check passed");
    else if (status === "FAIL") gateFinding(checks, `ci:${name}`, "BLOCK", "required CI check failed");
    else gateFinding(checks, `ci:${name}`, "UNVERIFIED", status ? `required CI check is ${status}` : "required CI check is absent from the bundle");
  }

  const health = bundle.results.runtimeHealth;
  gateFinding(checks, "runtime-health-result", health === "FAIL" ? "BLOCK" : policy.allowedRuntimeHealthStatuses.includes(health) ? "PASS" : "UNVERIFIED", health === "FAIL" ? "runtime health is FAIL" : `runtime health is ${health}`);
  const vulnerabilities = bundle.results.vulnerabilities;
  gateFinding(checks, "vulnerability-result", vulnerabilities === "FAIL" ? "BLOCK" : policy.allowedVulnerabilityStatuses.includes(vulnerabilities) ? "PASS" : "UNVERIFIED", vulnerabilities === "FAIL" ? "vulnerability audit is FAIL" : `vulnerability audit is ${vulnerabilities}`);

  const rollbackStatus = rollback.overallStatus;
  gateFinding(
    checks,
    "rollback-readiness-result",
    rollbackStatus === "FAIL" ? "BLOCK" : policy.rollback.allowedStatuses.includes(rollbackStatus) ? "PASS" : "UNVERIFIED",
    rollbackStatus === "FAIL" ? "rollback readiness is FAIL" : `rollback readiness is ${rollbackStatus}`,
  );

  for (const id of policy.requiredAuthenticatedEvidence) {
    const field = /** @type {keyof typeof RELEASE_TRUST_FIELD} */ (id);
    const trustKey = RELEASE_TRUST_FIELD[field];
    const authenticated = bundle.trust[trustKey] === true;
    gateFinding(checks, `trust:release:${id}`, authenticated ? "PASS" : "UNVERIFIED", authenticated ? `${id} evidence is authenticated` : `${id} evidence is not authenticated`);
  }
  for (const id of policy.rollback.requiredAuthenticatedEvidence) {
    const field = /** @type {keyof typeof ROLLBACK_TRUST_FIELD} */ (id);
    const trustKey = ROLLBACK_TRUST_FIELD[field];
    const authenticated = rollback.trust[trustKey] === true;
    gateFinding(checks, `trust:rollback:${id}`, authenticated ? "PASS" : "UNVERIFIED", authenticated ? `${id} rollback evidence is authenticated` : `${id} rollback evidence is not authenticated`);
  }

  const summary = {
    pass: checks.filter((item) => item.status === "PASS").length,
    block: checks.filter((item) => item.status === "BLOCK").length,
    unverified: checks.filter((item) => item.status === "UNVERIFIED").length,
  };
  const decision = summary.block > 0 ? "BLOCK" : summary.unverified > 0 ? "UNVERIFIED" : "ALLOW";
  return {
    version: 1,
    evaluatedAt,
    bundleCreatedAt: bundle.createdAt,
    bundleAgeSeconds,
    sourceCommit: bundle.source.commit,
    artifactSha256: bundle.artifact.sha256,
    runtime: bundle.runtime,
    deploymentTarget: rollback.deploymentTarget,
    checks,
    summary,
    technicalStatus: "PASS",
    decision,
    executionPerformed: false,
    executionAuthorizedByToolkit: false,
    semantics: "policy decision over validated release and rollback evidence only; ALLOW does not execute or independently authorize a deployment, and BLOCK or UNVERIFIED must not be treated as deployable",
  };
}

/** @param {ReturnType<typeof inspectDeploymentGate>} report */
export function formatDeploymentGate(report) {
  const lines = [
    "Deployment Gate v1",
    "",
    `Evaluated at: ${report.evaluatedAt}`,
    `Bundle created at: ${report.bundleCreatedAt}`,
    `Bundle age: ${report.bundleAgeSeconds}s`,
    `Source commit: ${report.sourceCommit}`,
    `Artifact SHA256: ${report.artifactSha256}`,
    `Runtime: ${report.runtime.name}${report.runtime.environment ? ` / ${report.runtime.environment}` : ""}`,
    `Deployment target: ${report.deploymentTarget}`,
    `Execution performed: ${report.executionPerformed}`,
    `Execution authorized by toolkit: ${report.executionAuthorizedByToolkit}`,
    `Semantics: ${report.semantics}`,
    "",
  ];
  for (const check of report.checks) lines.push(`${check.status.padEnd(10)}  ${check.id}  ${check.detail}`);
  lines.push(
    "",
    `Checks: ${report.summary.pass} pass, ${report.summary.unverified} unverified, ${report.summary.block} block`,
    `Technical: ${report.technicalStatus}`,
    `Decision: ${report.decision}`,
  );
  return lines.join("\n");
}

/** @param {string} file */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { return null; }
}

/** @param {string[]} argv */
function parse(argv) {
  let bundleFile = null, rollbackFile = null, policyFile = null, evaluatedAt = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--bundle", "--rollback-report", "--policy", "--evaluated-at"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--bundle") { if (bundleFile) return null; bundleFile = value; }
    else if (argument === "--rollback-report") { if (rollbackFile) return null; rollbackFile = value; }
    else if (argument === "--policy") { if (policyFile) return null; policyFile = value; }
    else { if (evaluatedAt) return null; evaluatedAt = value; }
  }
  return bundleFile && rollbackFile && policyFile && evaluatedAt ? { bundleFile, rollbackFile, policyFile, evaluatedAt, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) {
    console.error("Usage: node scripts/deployment-gate.js --bundle <release-bundle.json> --rollback-report <rollback-report.json> --policy <deployment-gate-policy.json> --evaluated-at <absolute-ISO> [--json]");
    return 1;
  }
  if (!isAbsoluteIsoTimestamp(options.evaluatedAt)) { console.error("Deployment gate evaluated-at must be an absolute ISO timestamp"); return 1; }
  const rawBundle = readJson(options.bundleFile), rawRollback = readJson(options.rollbackFile), rawPolicy = readJson(options.policyFile);
  if (!rawBundle || !rawRollback || !rawPolicy) { console.error("Deployment gate input cannot be read or parsed"); return 1; }
  const bundle = validateReleaseEvidenceBundle(rawBundle);
  const rollback = validateRollbackReadinessReport(rawRollback);
  const policy = validateDeploymentGatePolicy(rawPolicy);
  if (!bundle.valid || !bundle.bundle || !rollback.valid || !rollback.report || !policy.valid || !policy.policy) {
    console.error("Deployment gate input is invalid");
    return 1;
  }
  const report = inspectDeploymentGate(bundle.bundle, rollback.report, policy.policy, options.evaluatedAt);
  console.log(options.json ? JSON.stringify(report) : formatDeploymentGate(report));
  return report.decision === "ALLOW" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
