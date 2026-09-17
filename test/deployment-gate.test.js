import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatDeploymentGate,
  inspectDeploymentGate,
  main,
  validateDeploymentGatePolicy,
} from "../scripts/deployment-gate.js";
import { REQUIRED_ROLLBACK_REPORT_BASE_CHECK_IDS, validateRollbackReadinessReport } from "../scripts/audit-rollback-readiness.js";
import { REQUIRED_RELEASE_BUNDLE_CHECK_IDS, validateReleaseEvidenceBundle } from "../scripts/release-evidence-bundle.js";

const CURRENT = "a".repeat(40);
const PREVIOUS = "b".repeat(40);
const ARTIFACT = "c".repeat(64);
const PREVIOUS_ARTIFACT = "d".repeat(64);
const EVALUATED = "2026-09-17T10:05:00Z";
const REQUIRED_EVIDENCE = [
  "ci-evidence", "dependency-sbom", "vulnerability-evidence", "vulnerability-policy",
  "artifact-provenance", "runtime-evidence", "runtime-health-evidence", "runtime-health-policy",
];
const ROLLBACK_SUCCESS_CHECK_IDS = [
  ...REQUIRED_ROLLBACK_REPORT_BASE_CHECK_IDS,
  "previous-artifact-hash",
  "rollback-command-documented",
  "migration-not-applicable",
];

/** @returns {any} */
function rawBundle() {
  return {
    version: 1,
    source: { commit: CURRENT },
    createdAt: "2026-09-17T10:00:00Z",
    baseline: { commit: PREVIOUS, status: "MATCH", relationship: "expected-ancestor-of-comparison", ahead: 1, behind: 0 },
    artifact: { name: "dist.tgz", sha256: ARTIFACT },
    runtime: { name: "web", environment: "production" },
    trust: {
      ciAuthenticated: true,
      provenanceAuthenticated: true,
      runtimeAuthenticated: true,
      runtimeHealthAuthenticated: true,
      vulnerabilityAuthenticated: false,
    },
    results: {
      ciChecks: [{ name: "quality", status: "PASS" }, { name: "build", status: "PASS" }],
      artifactProvenance: "PASS",
      runtimeHealth: "PASS",
      vulnerabilities: "WARN",
      vulnerabilityFindings: 1,
    },
    evidenceIndex: REQUIRED_EVIDENCE.map((id, index) => ({ id, sha256: String(index + 1).repeat(64).slice(0, 64) })),
    checks: REQUIRED_RELEASE_BUNDLE_CHECK_IDS.map((id) => ({ id, status: "PASS", detail: `synthetic ${id} passes` })),
    summary: { pass: REQUIRED_RELEASE_BUNDLE_CHECK_IDS.length, fail: 0 },
    technicalStatus: "PASS",
    bundleStatus: "VALID",
    semantics: "coherent release evidence only",
  };
}

/** @param {any} raw */
function bundle(raw = rawBundle()) {
  const result = validateReleaseEvidenceBundle(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.bundle) throw new Error("bundle fixture invalid");
  return result.bundle;
}

/** @returns {any} */
function rawRollback() {
  return {
    version: 1,
    currentCommit: CURRENT,
    previousCommit: PREVIOUS,
    deploymentTarget: "production",
    runtime: { name: "web", environment: "production" },
    artifacts: { currentSha256: ARTIFACT, previousSha256: PREVIOUS_ARTIFACT },
    migration: { mode: "NONE", newMigrations: 0, hazards: 0, compatibility: "NOT_APPLICABLE" },
    trust: {
      currentProvenanceAuthenticated: true,
      previousProvenanceAuthenticated: true,
      changeEvidenceAuthenticated: false,
    },
    checks: ROLLBACK_SUCCESS_CHECK_IDS.map((id) => ({ id, status: "PASS", detail: `synthetic ${id} passes` })),
    summary: { pass: ROLLBACK_SUCCESS_CHECK_IDS.length, warn: 0, fail: 0 },
    technicalStatus: "PASS",
    overallStatus: "PASS",
    semantics: "validated rollback readiness evidence only",
  };
}

/** @param {any} raw */
function rollback(raw = rawRollback()) {
  const result = validateRollbackReadinessReport(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.report) throw new Error("rollback fixture invalid");
  return result.report;
}

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    maxBundleAgeSeconds: 900,
    requiredAuthenticatedEvidence: ["ci", "provenance", "runtime", "runtimeHealth"],
    requiredCiChecks: ["quality", "build"],
    allowedRuntimeHealthStatuses: ["PASS"],
    allowedVulnerabilityStatuses: ["PASS", "WARN"],
    rollback: {
      allowedStatuses: ["PASS"],
      requiredAuthenticatedEvidence: ["currentProvenance", "previousProvenance"],
    },
  };
}

/** @param {any} raw */
function policy(raw = rawPolicy()) {
  const result = validateDeploymentGatePolicy(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) throw new Error("policy fixture invalid");
  return result.policy;
}

/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

test("deployment gate policy validates explicit trust, CI, result, and rollback requirements", () => {
  const result = validateDeploymentGatePolicy(rawPolicy());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) return;
  assert.deepEqual(result.policy.requiredCiChecks, ["build", "quality"]);
  assert.deepEqual(result.policy.requiredAuthenticatedEvidence, ["ci", "provenance", "runtime", "runtimeHealth"]);
});

test("deployment gate policy cannot allow FAIL or omit all authentication requirements", () => {
  const releaseFail = rawPolicy(); releaseFail.allowedRuntimeHealthStatuses = ["PASS", "FAIL"];
  assert.equal(validateDeploymentGatePolicy(releaseFail).valid, false);
  const rollbackFail = rawPolicy(); rollbackFail.rollback.allowedStatuses = ["PASS", "FAIL"];
  assert.equal(validateDeploymentGatePolicy(rollbackFail).valid, false);
  const noTrust = rawPolicy(); noTrust.requiredAuthenticatedEvidence = [];
  assert.equal(validateDeploymentGatePolicy(noTrust).valid, false);
  const noRollbackTrust = rawPolicy(); noRollbackTrust.rollback.requiredAuthenticatedEvidence = [];
  assert.equal(validateDeploymentGatePolicy(noRollbackTrust).valid, false);
});

test("rollback readiness report validator accepts canonical machine-readable output", () => {
  const result = validateRollbackReadinessReport(rawRollback());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.report) return;
  assert.equal(result.report.artifacts.currentSha256, ARTIFACT);
  assert.equal(result.report.overallStatus, "PASS");
});

test("rollback readiness report permits repeated finding classes across distinct migration paths", () => {
  const raw = rawRollback();
  raw.migration = { mode: "CHECK", newMigrations: 2, hazards: 2, compatibility: "COMPATIBLE" };
  raw.checks = raw.checks.filter((/** @type {any} */ item) => item.id !== "migration-not-applicable");
  raw.checks.push(
    { id: "migration-history-bound", status: "PASS", detail: "history matches" },
    { id: "migration-surface-binding", status: "PASS", detail: "database surface bound" },
    { id: "migration-compatibility", status: "PASS", detail: "compatibility declared" },
    { id: "migration-safety-destructive-ddl", status: "FAIL", detail: "blocking migration finding", path: "migrations/001.sql" },
    { id: "migration-safety-destructive-ddl", status: "FAIL", detail: "blocking migration finding", path: "migrations/002.sql" },
    { id: "migration-rollback-hazard-destructive-ddl", status: "FAIL", detail: "rollback hazard", path: "migrations/001.sql" },
  );
  raw.summary = { pass: raw.checks.filter((/** @type {any} */ item) => item.status === "PASS").length, warn: 0, fail: 3 };
  raw.overallStatus = "FAIL";
  const result = validateRollbackReadinessReport(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.report?.checks.filter((item) => item.id === "migration-safety-destructive-ddl").length, 2);
});

test("rollback readiness report validator requires canonical rollback checks", () => {
  const raw = rawRollback();
  raw.checks = raw.checks.filter((/** @type {any} */ item) => item.id !== "runtime-identity");
  raw.summary = { pass: raw.checks.length, warn: 0, fail: 0 };
  const result = validateRollbackReadinessReport(raw);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((item) => item.id === "required-rollback-check-missing"), true);
});

test("rollback readiness report validator rejects tampered summary, hash, and unknown fields", () => {
  const summary = rawRollback(); summary.summary.fail = 1;
  assert.equal(validateRollbackReadinessReport(summary).valid, false);
  const hash = rawRollback(); hash.artifacts.currentSha256 = "bad";
  assert.equal(validateRollbackReadinessReport(hash).valid, false);
  const unknown = rawRollback(); unknown.deployNow = true;
  assert.equal(validateRollbackReadinessReport(unknown).valid, false);
});

test("complete authenticated evidence produces ALLOW without execution authority", () => {
  const report = inspectDeploymentGate(bundle(), rollback(), policy(), EVALUATED);
  assert.equal(report.decision, "ALLOW");
  assert.equal(report.summary.block, 0);
  assert.equal(report.summary.unverified, 0);
  assert.equal(report.executionPerformed, false);
  assert.equal(report.executionAuthorizedByToolkit, false);
});

test("standalone release bundle validator requires canonical coherence checks", () => {
  const raw = rawBundle();
  raw.checks = raw.checks.filter((/** @type {any} */ item) => item.id !== "artifact-provenance-coherent");
  raw.summary = { pass: raw.checks.length, fail: 0 };
  const result = validateReleaseEvidenceBundle(raw);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((item) => item.id === "required-coherence-check-missing"), true);
});

test("INVALID release bundle is always BLOCK", () => {
  const raw = rawBundle();
  raw.checks.push({ id: "coherence-failure", status: "FAIL", detail: "synthetic mismatch" });
  raw.summary = { pass: REQUIRED_RELEASE_BUNDLE_CHECK_IDS.length, fail: 1 };
  raw.bundleStatus = "INVALID";
  const report = inspectDeploymentGate(bundle(raw), rollback(), policy(), EVALUATED);
  assert.equal(report.decision, "BLOCK");
  assert.equal(report.checks.some((item) => item.id === "release-bundle-status" && item.status === "BLOCK"), true);
});

test("release bundle freshness uses an explicit evaluation clock", () => {
  const stalePolicy = rawPolicy();
  stalePolicy.maxBundleAgeSeconds = 60;
  let report = inspectDeploymentGate(bundle(), rollback(), policy(stalePolicy), EVALUATED);
  assert.equal(report.decision, "UNVERIFIED");
  assert.equal(report.checks.some((item) => item.id === "release-bundle-time" && item.status === "UNVERIFIED"), true);

  report = inspectDeploymentGate(bundle(), rollback(), policy(), "2026-09-17T09:59:00Z");
  assert.equal(report.decision, "BLOCK");
  assert.equal(report.checks.some((item) => item.id === "release-bundle-time" && item.status === "BLOCK"), true);
});

test("deployment gate policy requires a bounded bundle age", () => {
  const missing = rawPolicy();
  delete missing.maxBundleAgeSeconds;
  assert.equal(validateDeploymentGatePolicy(missing).valid, false);
  const zero = rawPolicy(); zero.maxBundleAgeSeconds = 0;
  assert.equal(validateDeploymentGatePolicy(zero).valid, false);
});

test("release and rollback commit artifact and runtime bindings are independently blocking", () => {
  const commit = rawRollback(); commit.currentCommit = "e".repeat(40);
  let report = inspectDeploymentGate(bundle(), rollback(commit), policy(), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "release-rollback-commit" && item.status === "BLOCK"), true);

  const artifact = rawRollback(); artifact.artifacts.currentSha256 = "e".repeat(64);
  report = inspectDeploymentGate(bundle(), rollback(artifact), policy(), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "release-rollback-artifact" && item.status === "BLOCK"), true);

  const runtime = rawRollback(); runtime.runtime.environment = "staging";
  report = inspectDeploymentGate(bundle(), rollback(runtime), policy(), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "release-rollback-runtime" && item.status === "BLOCK"), true);
  assert.equal(report.decision, "BLOCK");
});

test("artifact provenance FAIL is always blocking", () => {
  const raw = rawBundle(); raw.results.artifactProvenance = "FAIL";
  const report = inspectDeploymentGate(bundle(raw), rollback(), policy(), EVALUATED);
  assert.equal(report.decision, "BLOCK");
  assert.equal(report.checks.some((item) => item.id === "artifact-provenance-result" && item.status === "BLOCK"), true);
});

test("required CI FAIL blocks while skipped or missing CI remains UNVERIFIED", () => {
  const failed = rawBundle(); failed.results.ciChecks.find((/** @type {any} */ item) => item.name === "build").status = "FAIL";
  let report = inspectDeploymentGate(bundle(failed), rollback(), policy(), EVALUATED);
  assert.equal(report.decision, "BLOCK");
  assert.equal(report.checks.some((item) => item.id === "ci:build" && item.status === "BLOCK"), true);

  const skipped = rawBundle(); skipped.results.ciChecks.find((/** @type {any} */ item) => item.name === "build").status = "SKIPPED";
  report = inspectDeploymentGate(bundle(skipped), rollback(), policy(), EVALUATED);
  assert.equal(report.decision, "UNVERIFIED");
  assert.equal(report.checks.some((item) => item.id === "ci:build" && item.status === "UNVERIFIED"), true);

  const missing = rawBundle(); missing.results.ciChecks = missing.results.ciChecks.filter((/** @type {any} */ item) => item.name !== "build");
  report = inspectDeploymentGate(bundle(missing), rollback(), policy(), EVALUATED);
  assert.equal(report.decision, "UNVERIFIED");
});

test("runtime health WARN requires explicit policy tolerance and FAIL always blocks", () => {
  const warned = rawBundle(); warned.results.runtimeHealth = "WARN";
  let report = inspectDeploymentGate(bundle(warned), rollback(), policy(), EVALUATED);
  assert.equal(report.decision, "UNVERIFIED");

  const tolerant = rawPolicy(); tolerant.allowedRuntimeHealthStatuses = ["PASS", "WARN"];
  report = inspectDeploymentGate(bundle(warned), rollback(), policy(tolerant), EVALUATED);
  assert.equal(report.decision, "ALLOW");

  const failed = rawBundle(); failed.results.runtimeHealth = "FAIL";
  report = inspectDeploymentGate(bundle(failed), rollback(), policy(tolerant), EVALUATED);
  assert.equal(report.decision, "BLOCK");
});

test("vulnerability WARN requires explicit tolerance while FAIL always blocks", () => {
  assert.equal(inspectDeploymentGate(bundle(), rollback(), policy(), EVALUATED).decision, "ALLOW");

  const strict = rawPolicy(); strict.allowedVulnerabilityStatuses = ["PASS"];
  let report = inspectDeploymentGate(bundle(), rollback(), policy(strict), EVALUATED);
  assert.equal(report.decision, "UNVERIFIED");

  const failed = rawBundle(); failed.results.vulnerabilities = "FAIL";
  report = inspectDeploymentGate(bundle(failed), rollback(), policy(), EVALUATED);
  assert.equal(report.decision, "BLOCK");
});

test("required release authentication gaps are UNVERIFIED, never silently trusted", () => {
  const raw = rawBundle(); raw.trust.runtimeAuthenticated = false;
  const report = inspectDeploymentGate(bundle(raw), rollback(), policy(), EVALUATED);
  assert.equal(report.decision, "UNVERIFIED");
  assert.equal(report.checks.some((item) => item.id === "trust:release:runtime" && item.status === "UNVERIFIED"), true);
});

test("only authentication sources explicitly required by policy affect the decision", () => {
  const raw = rawBundle();
  raw.trust.vulnerabilityAuthenticated = false;
  const report = inspectDeploymentGate(bundle(raw), rollback(), policy(), EVALUATED);
  assert.equal(report.decision, "ALLOW");
});

test("required rollback authentication gaps are UNVERIFIED", () => {
  const raw = rawRollback(); raw.trust.previousProvenanceAuthenticated = false;
  const report = inspectDeploymentGate(bundle(), rollback(raw), policy(), EVALUATED);
  assert.equal(report.decision, "UNVERIFIED");
  assert.equal(report.checks.some((item) => item.id === "trust:rollback:previousProvenance" && item.status === "UNVERIFIED"), true);
});

test("rollback WARN is UNVERIFIED unless explicitly tolerated and FAIL always blocks", () => {
  const warned = rawRollback();
  const warningCheck = warned.checks.find((/** @type {any} */ item) => item.id === "migration-not-applicable");
  warningCheck.status = "WARN";
  warningCheck.detail = "explicit warning";
  warned.summary = { pass: warned.checks.length - 1, warn: 1, fail: 0 };
  warned.overallStatus = "WARN";
  let report = inspectDeploymentGate(bundle(), rollback(warned), policy(), EVALUATED);
  assert.equal(report.decision, "UNVERIFIED");

  const tolerant = rawPolicy(); tolerant.rollback.allowedStatuses = ["PASS", "WARN"];
  report = inspectDeploymentGate(bundle(), rollback(warned), policy(tolerant), EVALUATED);
  assert.equal(report.decision, "ALLOW");

  const failed = rawRollback();
  failed.checks.push({ id: "rollback-failed", status: "FAIL", detail: "explicit failure" });
  failed.summary = { pass: failed.checks.length - 1, warn: 0, fail: 1 };
  failed.overallStatus = "FAIL";
  report = inspectDeploymentGate(bundle(), rollback(failed), policy(tolerant), EVALUATED);
  assert.equal(report.decision, "BLOCK");
});

test("rollback technical failure is blocking", () => {
  const raw = rawRollback();
  raw.checks.push({ id: "migration-audit-unavailable", status: "FAIL", detail: "technical evidence unavailable" });
  raw.summary = { pass: raw.checks.length - 1, warn: 0, fail: 1 };
  raw.technicalStatus = "FAIL";
  raw.overallStatus = "FAIL";
  const report = inspectDeploymentGate(bundle(), rollback(raw), policy(), EVALUATED);
  assert.equal(report.decision, "BLOCK");
  assert.equal(report.checks.some((item) => item.id === "rollback-technical-status" && item.status === "BLOCK"), true);
});

test("human output exposes decision and explicitly denies execution authority", () => {
  const output = formatDeploymentGate(inspectDeploymentGate(bundle(), rollback(), policy(), EVALUATED));
  assert.match(output, /Decision: ALLOW/);
  assert.match(output, /Execution performed: false/);
  assert.match(output, /Execution authorized by toolkit: false/);
  assert.match(output, /does not execute or independently authorize a deployment/);
});

test("CLI exits zero only for ALLOW and nonzero for UNVERIFIED or BLOCK", () => {
  const bundleFile = tempJson("gate-bundle", rawBundle());
  const rollbackFile = tempJson("gate-rollback", rawRollback());
  const policyFile = tempJson("gate-policy", rawPolicy());
  const original = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--bundle", bundleFile, "--rollback-report", rollbackFile, "--policy", policyFile, "--evaluated-at", EVALUATED, "--json"]), 0); }
  finally { console.log = original; }
  assert.equal(JSON.parse(stdout).decision, "ALLOW");

  const unverified = rawBundle(); unverified.trust.runtimeAuthenticated = false;
  fs.writeFileSync(bundleFile, JSON.stringify(unverified));
  assert.equal(main(["--bundle", bundleFile, "--rollback-report", rollbackFile, "--policy", policyFile, "--evaluated-at", EVALUATED]), 1);

  const blocked = rawBundle(); blocked.results.runtimeHealth = "FAIL";
  fs.writeFileSync(bundleFile, JSON.stringify(blocked));
  assert.equal(main(["--bundle", bundleFile, "--rollback-report", rollbackFile, "--policy", policyFile, "--evaluated-at", EVALUATED]), 1);
  for (const file of [bundleFile, rollbackFile, policyFile]) fs.rmSync(file, { force: true });
});

test("CLI rejects malformed input and gate source has no deployment or mutation surface", () => {
  const malformed = tempJson("gate-bad", "{");
  assert.equal(main(["--bundle", malformed, "--rollback-report", malformed, "--policy", malformed, "--evaluated-at", EVALUATED]), 1);
  assert.equal(main(["--unknown"]), 1);
  const bundleFile = tempJson("gate-time-bundle", rawBundle());
  const rollbackFile = tempJson("gate-time-rollback", rawRollback());
  const policyFile = tempJson("gate-time-policy", rawPolicy());
  assert.equal(main(["--bundle", bundleFile, "--rollback-report", rollbackFile, "--policy", policyFile, "--evaluated-at", "today"]), 1);
  fs.rmSync(bundleFile, { force: true }); fs.rmSync(rollbackFile, { force: true }); fs.rmSync(policyFile, { force: true });
  fs.rmSync(malformed, { force: true });

  const source = fs.readFileSync(new URL("../scripts/deployment-gate.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|node:child_process|spawnSync|execFile|process\.env|writeFile|copyFile|docker|kubectl|wrangler|ssh\s/);
  assert.match(source, /validateReleaseEvidenceBundle/);
  assert.match(source, /validateRollbackReadinessReport/);
  assert.match(source, /executionPerformed: false/);
});
