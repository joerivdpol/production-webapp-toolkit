import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatPerformanceBudgetAudit,
  inspectPerformanceBudgets,
  main,
  validatePerformancePolicy,
} from "../scripts/audit-performance-budgets.js";
import { validatePerformanceEvidence } from "../scripts/performance-evidence.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** @returns {any} */
function rawEvidence() {
  return {
    version: 1,
    artifact: { commit: COMMIT, totalBytes: 500000, jsBytes: 300000, cssBytes: 100000 },
    source: { name: "lighthouse-ci", authenticated: false, collectedAt: "2026-09-16T19:30:00Z" },
    routes: [
      { id: "homepage", lcpMs: 1800, cls: 0.04, inpMs: 120 },
      { id: "booking", lcpMs: 2200, cls: 0.08 },
    ],
  };
}

function evidence(raw = rawEvidence()) {
  const result = validatePerformanceEvidence(raw);
  assert.equal(result.ok, true);
  if (!result.ok || !result.evidence) throw new Error("evidence fixture invalid");
  return result.evidence;
}

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    maxEvidenceAgeSeconds: 3600,
    bundle: { maxTotalBytes: 600000, maxJsBytes: 350000, maxCssBytes: 120000 },
    routes: [
      { id: "homepage", maxLcpMs: 2500, maxCls: 0.1, maxInpMs: 200 },
      { id: "booking", maxLcpMs: 2500, maxCls: 0.1 },
    ],
  };
}

function policy(raw = rawPolicy()) {
  const result = validatePerformancePolicy(raw);
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

function inspect(raw = rawEvidence(), policyValue = rawPolicy()) {
  return inspectPerformanceBudgets(evidence(raw), policy(policyValue), { expectedCommit: COMMIT, evaluatedAt: "2026-09-16T19:45:00Z" });
}

test("fresh matching evidence within all budgets passes", () => {
  const report = inspect();
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.summary.fail, 0);
});

test("bundle total JS and CSS budgets are independently blocking", () => {
  for (const field of ["totalBytes", "jsBytes", "cssBytes"]) {
    const raw = rawEvidence();
    raw.artifact[field] = field === "totalBytes" ? 700000 : 400000;
    if (field === "cssBytes") raw.artifact.totalBytes = 800000;
    const report = inspect(raw);
    assert.equal(report.overallStatus, "FAIL");
    assert.equal(report.checks.some((check) => check.scope === "bundle" && check.status === "FAIL"), true);
  }
});

test("LCP CLS and INP route budgets are independently blocking", () => {
  /** @type {Array<["lcpMs"|"cls"|"inpMs", number, string]>} */
  const cases = [["lcpMs", 3000, "lcp-budget"], ["cls", 0.2, "cls-budget"], ["inpMs", 300, "inp-budget"]];
  for (const [field, value, id] of cases) {
    const raw = rawEvidence(); raw.routes[0][field] = value;
    const report = inspect(raw);
    assert.equal(report.checks.some((check) => check.id === id && check.status === "FAIL"), true);
  }
});

test("missing configured route or metric fails closed", () => {
  const missingRoute = rawEvidence(); missingRoute.routes = missingRoute.routes.filter((/** @type {any} */ route) => route.id !== "booking");
  assert.equal(inspect(missingRoute).checks.some((check) => check.id === "route-missing"), true);

  const missingMetric = rawEvidence(); delete missingMetric.routes[0].inpMs;
  assert.equal(inspect(missingMetric).checks.some((check) => check.id === "metric-missing"), true);
});

test("commit mismatch stale and future evidence are blocking trust failures", () => {
  const mismatch = inspectPerformanceBudgets(evidence(), policy(), { expectedCommit: "abcdefabcdefabcdefabcdefabcdefabcdefabcd", evaluatedAt: "2026-09-16T19:45:00Z" });
  assert.equal(mismatch.checks.some((check) => check.id === "commit-mismatch"), true);
  const stale = inspectPerformanceBudgets(evidence(), policy(), { expectedCommit: COMMIT, evaluatedAt: "2026-09-16T21:00:01Z" });
  assert.equal(stale.checks.some((check) => check.id === "evidence-stale"), true);
  const future = inspectPerformanceBudgets(evidence(), policy(), { expectedCommit: COMMIT, evaluatedAt: "2026-09-16T19:00:00Z" });
  assert.equal(future.checks.some((check) => check.id === "evidence-future"), true);
});

test("authentication metadata never changes numeric budget truth", () => {
  const unauthenticated = inspect();
  const raw = rawEvidence(); raw.source.authenticated = true;
  const authenticated = inspect(raw);
  assert.equal(unauthenticated.overallStatus, authenticated.overallStatus);
  assert.deepEqual(unauthenticated.checks.map((check) => check.id), authenticated.checks.map((check) => check.id));
});

test("policy may configure only bundle or only selected route metrics", () => {
  const bundleOnly = rawPolicy(); bundleOnly.routes = [];
  assert.equal(validatePerformancePolicy(bundleOnly).ok, true);
  const routeOnly = rawPolicy(); delete routeOnly.bundle; routeOnly.routes = [{ id: "homepage", maxLcpMs: 2500 }];
  assert.equal(validatePerformancePolicy(routeOnly).ok, true);
});

test("policy rejects empty ambiguous duplicate and unbounded configuration", () => {
  const empty = rawPolicy(); delete empty.bundle; empty.routes = [];
  assert.equal(validatePerformancePolicy(empty).ok, false);
  const duplicate = rawPolicy(); duplicate.routes.push(structuredClone(duplicate.routes[0]));
  assert.equal(validatePerformancePolicy(duplicate).ok, false);
  const stale = rawPolicy(); stale.maxEvidenceAgeSeconds = 0;
  assert.equal(validatePerformancePolicy(stale).ok, false);
  const unknown = rawPolicy(); unknown.score = 90;
  assert.equal(validatePerformancePolicy(unknown).ok, false);
});

test("human output states trust boundary and concrete budget values", () => {
  const raw = rawEvidence(); raw.routes[0].lcpMs = 3000;
  const text = formatPerformanceBudgetAudit(inspect(raw));
  assert.match(text, /Authentication: trust metadata only/);
  assert.match(text, /lcpMs 3000 exceeds maximum 2500/);
  assert.match(text, /Overall: FAIL/);
});

test("CLI emits JSON and preserves PASS FAIL semantics", () => {
  const evidenceFile = tempJson("performance-evidence", rawEvidence());
  const policyFile = tempJson("performance-policy", rawPolicy());
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["--evidence-file", evidenceFile, "--policy", policyFile, "--expected-commit", COMMIT, "--evaluated-at", "2026-09-16T19:45:00Z", "--json"]), 0);
  } finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  const failing = rawEvidence(); failing.artifact.totalBytes = 700000;
  fs.writeFileSync(evidenceFile, JSON.stringify(failing));
  assert.equal(main(["--evidence-file", evidenceFile, "--policy", policyFile, "--expected-commit", COMMIT, "--evaluated-at", "2026-09-16T19:45:00Z"]), 1);
  fs.rmSync(evidenceFile, { force: true }); fs.rmSync(policyFile, { force: true });
});

test("audit core stays offline read only and delegates canonical evidence validation", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-performance-budgets.js", import.meta.url), "utf8");
  assert.match(source, /validatePerformanceEvidence/);
  assert.doesNotMatch(source, /process\.env|node:child_process|spawnSync|execFile|\bfetch\s*\(|https?:\/\/|writeFile/);
});
