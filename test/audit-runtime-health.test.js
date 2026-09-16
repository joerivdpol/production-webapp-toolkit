import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatRuntimeHealthAudit,
  inspectRuntimeHealth,
  main,
  validateRuntimeHealthPolicy,
} from "../scripts/audit-runtime-health.js";
import { validateRuntimeHealthEvidence } from "../scripts/runtime-health-evidence.js";

/** @returns {any} */
function rawEvidence() {
  return {
    version: 1,
    runtime: { name: "web", environment: "production" },
    evidence: { source: "synthetic-health", authenticated: false, collectedAt: "2026-09-16T18:30:00Z" },
    checks: [
      { id: "http", category: "http", status: "HEALTHY", latencyMs: 50 },
      { id: "database", category: "database", status: "HEALTHY", latencyMs: 10 },
      { id: "jobs", category: "job", status: "HEALTHY" },
    ],
  };
}

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    evaluatedAt: "2026-09-16T18:31:00Z",
    runtime: { name: "web", environment: "production" },
    maxEvidenceAgeSeconds: 120,
    freshnessSeverity: "blocking",
    checks: [
      { id: "http", severity: "blocking", allowDegraded: false },
      { id: "database", severity: "blocking", allowDegraded: true },
    ],
  };
}

function evidence(raw = rawEvidence()) {
  const result = validateRuntimeHealthEvidence(raw);
  assert.equal(result.valid, true);
  if (!result.valid || !result.evidence) throw new Error("evidence fixture invalid");
  return result.evidence;
}

function policy(raw = rawPolicy()) {
  const result = validateRuntimeHealthPolicy(raw);
  assert.equal(result.ok, true);
  if (!result.ok || !result.policy) throw new Error("policy fixture invalid");
  return result.policy;
}

/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const filename = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("validates explicit health policy and rejects ambiguous configuration", () => {
  assert.equal(validateRuntimeHealthPolicy(rawPolicy()).ok, true);
  const unknown = rawPolicy(); unknown.extra = true;
  assert.equal(validateRuntimeHealthPolicy(unknown).ok, false);
  const duplicate = rawPolicy(); duplicate.checks.push({ ...duplicate.checks[0] });
  assert.equal(validateRuntimeHealthPolicy(duplicate).ok, false);
  const noFreshness = rawPolicy(); delete noFreshness.maxEvidenceAgeSeconds;
  assert.equal(validateRuntimeHealthPolicy(noFreshness).ok, false);
});

test("fresh matching healthy evidence passes without evaluating deployment identity", () => {
  const report = inspectRuntimeHealth(evidence(), policy());
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.deploymentIdentityStatus, "NOT_EVALUATED");
  assert.equal(report.summary.fail, 0);
});

test("degraded status is warning when explicitly allowed", () => {
  const raw = rawEvidence(); raw.checks[1].status = "DEGRADED";
  const report = inspectRuntimeHealth(evidence(raw), policy());
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((/** @type {any} */ item) => item.id === "health-check-degraded" && item.status === "WARN"), true);
});

test("blocking degraded unhealthy unknown and missing checks fail", () => {
  for (const status of ["DEGRADED", "UNHEALTHY", "UNKNOWN"]) {
    const raw = rawEvidence(); raw.checks[0].status = status;
    assert.equal(inspectRuntimeHealth(evidence(raw), policy()).overallStatus, "FAIL");
  }
  const missing = rawEvidence(); missing.checks = missing.checks.filter((/** @type {any} */ item) => item.id !== "http");
  assert.equal(inspectRuntimeHealth(evidence(missing), policy()).overallStatus, "FAIL");
});

test("advisory unhealthy check warns without blocking", () => {
  const policyRaw = rawPolicy(); policyRaw.checks[0].severity = "advisory";
  const evidenceRaw = rawEvidence(); evidenceRaw.checks[0].status = "UNHEALTHY";
  const report = inspectRuntimeHealth(evidence(evidenceRaw), policy(policyRaw));
  assert.equal(report.overallStatus, "WARN");
});

test("stale and future evidence follow explicit freshness severity", () => {
  const stale = rawPolicy(); stale.evaluatedAt = "2026-09-16T18:40:00Z";
  assert.equal(inspectRuntimeHealth(evidence(), policy(stale)).overallStatus, "FAIL");

  const advisory = rawPolicy(); advisory.evaluatedAt = "2026-09-16T18:29:00Z"; advisory.freshnessSeverity = "advisory";
  assert.equal(inspectRuntimeHealth(evidence(), policy(advisory)).overallStatus, "WARN");
});

test("wrong runtime identity blocks before health conclusions", () => {
  const raw = rawEvidence(); raw.runtime.name = "worker";
  const report = inspectRuntimeHealth(evidence(raw), policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.length, 1);
  assert.equal(report.checks[0]?.id, "runtime-identity-mismatch");
});

test("unconfigured nonhealthy checks remain visible warnings", () => {
  const raw = rawEvidence(); raw.checks.find((/** @type {any} */ item) => item.id === "jobs").status = "UNHEALTHY";
  const report = inspectRuntimeHealth(evidence(raw), policy());
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((/** @type {any} */ item) => item.id === "health-check-unconfigured" && item.subject === "jobs" && item.status === "WARN"), true);
});

test("authentication metadata never changes health truth", () => {
  const unauthenticated = inspectRuntimeHealth(evidence(), policy());
  const raw = rawEvidence(); raw.evidence.authenticated = true;
  const authenticated = inspectRuntimeHealth(evidence(raw), policy());
  assert.equal(unauthenticated.overallStatus, authenticated.overallStatus);
});

test("human output states deployment identity is not evaluated", () => {
  const text = formatRuntimeHealthAudit(inspectRuntimeHealth(evidence(), policy()));
  assert.match(text, /Deployment identity: NOT EVALUATED/);
  assert.match(text, /Overall: PASS/);
});

test("CLI preserves PASS WARN FAIL semantics", () => {
  const evidenceFile = tempJson("health-evidence", rawEvidence());
  const policyFile = tempJson("health-policy", rawPolicy());
  assert.equal(main(["--evidence-file", evidenceFile, "--policy", policyFile]), 0);

  const unhealthy = rawEvidence(); unhealthy.checks[0].status = "UNHEALTHY";
  fs.writeFileSync(evidenceFile, JSON.stringify(unhealthy));
  assert.equal(main(["--evidence-file", evidenceFile, "--policy", policyFile]), 1);
  fs.rmSync(evidenceFile, { force: true }); fs.rmSync(policyFile, { force: true });
});

test("CLI rejects malformed and incomplete inputs", () => {
  const malformed = tempJson("health-malformed", "{");
  const policyFile = tempJson("health-policy", rawPolicy());
  assert.equal(main(["--evidence-file", malformed, "--policy", policyFile]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true }); fs.rmSync(policyFile, { force: true });
});

test("health audit core stays offline read only and delegates canonical evidence validation", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-runtime-health.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /validateRuntimeHealthEvidence/);
});
