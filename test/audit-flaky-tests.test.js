import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatFlakyTestAudit,
  inspectFlakyTests,
  main,
  validateFlakyTestPolicy,
} from "../scripts/audit-flaky-tests.js";
import { validateCiEvidence } from "../scripts/ci-evidence.js";

/** @param {string} runId @param {string} collectedAt @param {"PASS"|"FAIL"|"SKIPPED"} testStatus @param {Record<string, "PASS"|"FAIL"|"SKIPPED">} [extra] */
function rawEvidence(runId, collectedAt, testStatus, extra = {}) {
  const checks = { test: testStatus, lint: "PASS", ...extra };
  return {
    version: 1,
    commit: "0123456789abcdef0123456789abcdef01234567",
    ci: { provider: "github-actions", workflow: "CI", runId },
    evidence: { source: "github-api", authenticated: true, collectedAt },
    checks: Object.entries(checks).map(([name, status]) => ({ name, status })),
  };
}

/** @param {ReturnType<typeof rawEvidence>} value */
function evidence(value) {
  const result = validateCiEvidence(value);
  assert.equal(result.valid, true);
  if (!result.valid || result.evidence === null) throw new Error("invalid evidence fixture");
  return result.evidence;
}

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    ci: { provider: "github-actions", workflow: "CI" },
    minimumObservations: 3,
    minimumPasses: 1,
    minimumFailures: 1,
    checks: [
      { name: "test", severity: "blocking" },
      { name: "lint", severity: "advisory" },
    ],
  };
}

function policy() {
  const result = validateFlakyTestPolicy(rawPolicy());
  assert.equal(result.ok, true);
  if (!result.ok || result.policy === null) throw new Error("invalid policy fixture");
  return result.policy;
}

/** @param {string} prefix @param {unknown} value */
function tempJson(prefix, value) {
  const filename = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("policy requires explicit CI cohort, thresholds, and check severities", () => {
  const result = validateFlakyTestPolicy(rawPolicy());
  assert.equal(result.ok, true);
  if (!result.ok || result.policy === null) return;
  assert.equal(result.policy.ci.provider, "github-actions");
  assert.deepEqual(result.policy.checks.map((item) => item.name), ["lint", "test"]);
});

test("policy rejects inconsistent thresholds and ambiguous checks", () => {
  const thresholds = rawPolicy();
  thresholds.minimumObservations = 2;
  thresholds.minimumPasses = 2;
  thresholds.minimumFailures = 1;
  assert.equal(validateFlakyTestPolicy(thresholds).ok, false);

  const duplicate = rawPolicy();
  duplicate.checks.push({ name: "test", severity: "advisory" });
  assert.equal(validateFlakyTestPolicy(duplicate).ok, false);

  const severity = rawPolicy();
  severity.checks[0].severity = "critical";
  assert.equal(validateFlakyTestPolicy(severity).ok, false);

  const missingWorkflow = rawPolicy();
  delete missingWorkflow.ci.workflow;
  assert.equal(validateFlakyTestPolicy(missingWorkflow).ok, false);

  const unknown = rawPolicy();
  unknown.mode = "automatic";
  assert.equal(validateFlakyTestPolicy(unknown).ok, false);
});

test("repeated PASS observations are stable", () => {
  const report = inspectFlakyTests(policy(), [
    evidence(rawEvidence("1", "2026-09-16T01:00:00Z", "PASS")),
    evidence(rawEvidence("2", "2026-09-16T02:00:00Z", "PASS")),
    evidence(rawEvidence("3", "2026-09-16T03:00:00Z", "PASS")),
  ]);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks.find((item) => item.name === "test")?.state, "STABLE");
});

test("mixed PASS and FAIL marks a blocking check flaky", () => {
  const report = inspectFlakyTests(policy(), [
    evidence(rawEvidence("1", "2026-09-16T01:00:00Z", "PASS")),
    evidence(rawEvidence("2", "2026-09-16T02:00:00Z", "FAIL")),
    evidence(rawEvidence("3", "2026-09-16T03:00:00Z", "PASS")),
  ]);
  assert.equal(report.overallStatus, "FAIL");
  const check = report.checks.find((item) => item.name === "test");
  assert.equal(check?.state, "FLAKY");
  assert.equal(check?.pass, 2);
  assert.equal(check?.fail, 1);
});

test("advisory flakiness warns without blocking", () => {
  const report = inspectFlakyTests(policy(), [
    evidence(rawEvidence("1", "2026-09-16T01:00:00Z", "PASS", { lint: "PASS" })),
    evidence(rawEvidence("2", "2026-09-16T02:00:00Z", "PASS", { lint: "FAIL" })),
    evidence(rawEvidence("3", "2026-09-16T03:00:00Z", "PASS", { lint: "PASS" })),
  ]);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.find((item) => item.name === "lint")?.state, "FLAKY");
});

test("consistent failure is not mislabeled flaky", () => {
  const report = inspectFlakyTests(policy(), [
    evidence(rawEvidence("1", "2026-09-16T01:00:00Z", "FAIL")),
    evidence(rawEvidence("2", "2026-09-16T02:00:00Z", "FAIL")),
    evidence(rawEvidence("3", "2026-09-16T03:00:00Z", "FAIL")),
  ]);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks.find((item) => item.name === "test")?.state, "STABLE");
});

test("skipped and missing checks do not count as pass or failure observations", () => {
  const missing = rawEvidence("3", "2026-09-16T03:00:00Z", "PASS");
  missing.checks = missing.checks.filter((item) => item.name !== "test");
  const report = inspectFlakyTests(policy(), [
    evidence(rawEvidence("1", "2026-09-16T01:00:00Z", "PASS")),
    evidence(rawEvidence("2", "2026-09-16T02:00:00Z", "SKIPPED")),
    evidence(missing),
  ]);
  const check = report.checks.find((item) => item.name === "test");
  assert.equal(check?.state, "UNVERIFIED");
  assert.equal(check?.observations, 1);
  assert.equal(check?.skipped, 1);
  assert.equal(check?.missing, 1);
  assert.equal(report.overallStatus, "WARN");
});

test("chronology is derived from explicit evidence timestamps", () => {
  const report = inspectFlakyTests(policy(), [
    evidence(rawEvidence("3", "2026-09-16T03:00:00Z", "PASS")),
    evidence(rawEvidence("1", "2026-09-16T01:00:00Z", "PASS")),
    evidence(rawEvidence("2", "2026-09-16T02:00:00Z", "PASS")),
  ]);
  const check = report.checks.find((item) => item.name === "test");
  assert.equal(check?.firstSeen, "2026-09-16T01:00:00Z");
  assert.equal(check?.lastSeen, "2026-09-16T03:00:00Z");
});

test("evidence from a different provider or workflow fails the cohort", () => {
  const wrongProvider = rawEvidence("2", "2026-09-16T02:00:00Z", "PASS");
  wrongProvider.ci.provider = "other-ci";
  const wrongWorkflow = rawEvidence("3", "2026-09-16T03:00:00Z", "PASS");
  wrongWorkflow.ci.workflow = "Release";
  const report = inspectFlakyTests(policy(), [
    evidence(rawEvidence("1", "2026-09-16T01:00:00Z", "PASS")),
    evidence(wrongProvider),
    evidence(wrongWorkflow),
  ]);
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.evidenceErrors.length, 2);
});

test("duplicate run ids fail closed instead of double-counting reruns", () => {
  const report = inspectFlakyTests(policy(), [
    evidence(rawEvidence("same", "2026-09-16T01:00:00Z", "PASS")),
    evidence(rawEvidence("same", "2026-09-16T02:00:00Z", "FAIL")),
  ]);
  assert.equal(report.technicalStatus, "FAIL");
  assert.match(report.evidenceErrors[0] ?? "", /duplicate CI run id/);
});

test("evidence without an explicit run id fails closed", () => {
  const first = /** @type {any} */ (rawEvidence("1", "2026-09-16T01:00:00Z", "PASS"));
  delete first.ci.runId;
  const report = inspectFlakyTests(policy(), [evidence(first)]);
  assert.equal(report.technicalStatus, "FAIL");
  assert.match(report.evidenceErrors[0] ?? "", /CI run id is required/);
});

test("human output distinguishes stable flaky and unverified states", () => {
  const report = inspectFlakyTests(policy(), [
    evidence(rawEvidence("1", "2026-09-16T01:00:00Z", "PASS")),
    evidence(rawEvidence("2", "2026-09-16T02:00:00Z", "FAIL")),
    evidence(rawEvidence("3", "2026-09-16T03:00:00Z", "PASS")),
  ]);
  const text = formatFlakyTestAudit(report);
  assert.match(text, /test  FLAKY/);
  assert.match(text, /lint  STABLE/);
  assert.match(text, /Overall: FAIL/);
});

test("CLI reads repeated CI evidence and preserves PASS WARN FAIL exit semantics", () => {
  const policyFile = tempJson("flaky-policy", rawPolicy());
  const files = [
    tempJson("ci-1", rawEvidence("1", "2026-09-16T01:00:00Z", "PASS")),
    tempJson("ci-2", rawEvidence("2", "2026-09-16T02:00:00Z", "PASS")),
    tempJson("ci-3", rawEvidence("3", "2026-09-16T03:00:00Z", "PASS")),
  ];
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--policy", policyFile, ...files.flatMap((file) => ["--evidence-file", file]), "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");

  const secondFile = files[1];
  assert.ok(secondFile);
  fs.writeFileSync(secondFile, JSON.stringify(rawEvidence("2", "2026-09-16T02:00:00Z", "FAIL")));
  assert.equal(main(["--policy", policyFile, ...files.flatMap((file) => ["--evidence-file", file])]), 1);
  for (const filename of [policyFile, ...files]) fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed policy, invalid evidence, and duplicate file arguments", () => {
  const badPolicy = tempJson("bad-policy", "{");
  const policyFile = tempJson("flaky-policy", rawPolicy());
  const evidenceFile = tempJson("ci", rawEvidence("1", "2026-09-16T01:00:00Z", "PASS"));
  const invalidEvidence = tempJson("bad-ci", { version: 1 });
  assert.equal(main(["--policy", badPolicy, "--evidence-file", evidenceFile]), 1);
  assert.equal(main(["--policy", policyFile, "--evidence-file", invalidEvidence]), 1);
  assert.equal(main(["--policy", policyFile, "--evidence-file", evidenceFile, "--evidence-file", evidenceFile]), 1);
  assert.equal(main(["--unknown"]), 1);
  for (const filename of [badPolicy, policyFile, evidenceFile, invalidEvidence]) fs.rmSync(filename, { force: true });
});

test("flaky audit stays offline read only and delegates canonical CI evidence validation", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-flaky-tests.js", import.meta.url), "utf8");
  assert.match(source, /validateCiEvidence/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
