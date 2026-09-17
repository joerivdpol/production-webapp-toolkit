import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatScheduledReporting,
  main,
  planScheduledReporting,
  validateScheduledReportingPolicy,
} from "../scripts/scheduled-reporting.js";
import { validateEcosystemDashboardSnapshot } from "../scripts/compare-ecosystem-history.js";

/** @returns {any} */
function policy() {
  return {
    version: 1,
    schedule: { id: "daily-readiness", cadence: "DAILY", timezone: "Asia/Jakarta", hour: 8, minute: 0 },
    notification: {
      sinks: ["engineering-alerts"],
      onOverall: ["WARN", "FAIL"],
      onTechnicalFailure: true,
      onRegression: true,
      onRepositoryAdded: false,
      onRepositoryRemoved: true,
    },
  };
}

/** @param {"PASS"|"WARN"|"FAIL"} overall @param {string} generatedAt @param {string} [repository] @returns {any} */
function snapshot(overall, generatedAt, repository = "example-web") {
  const status = overall === "PASS" ? "PASS" : overall === "WARN" ? "WARN" : "FAIL";
  const impact = overall === "PASS" ? "PASS" : overall === "WARN" ? "WARN" : "FAIL";
  const required = {
    total: 1,
    pass: overall === "PASS" ? 1 : 0,
    warn: overall === "WARN" ? 1 : 0,
    fail: overall === "FAIL" ? 1 : 0,
    unverified: 0,
    missing: 0,
  };
  const row = {
    entry: 0,
    repository,
    profile: "webapp",
    policySource: "public-pack",
    evidence: { source: "synthetic", authenticated: false, collectedAt: generatedAt },
    policyStatus: "PASS",
    evidenceTimeStatus: "VALID",
    checks: [{ id: "repository-quality", requirement: "required", status, impact }],
    unscopedChecks: [],
    required,
    advisory: { total: 0, pass: 0, warn: 0, fail: 0, unverified: 0, missing: 0 },
    technicalStatus: "PASS",
    overallStatus: overall,
    technicalDetail: null,
  };
  return {
    version: 1,
    generatedAt,
    repositories: [row],
    summary: { repositories: 1, pass: overall === "PASS" ? 1 : 0, warn: overall === "WARN" ? 1 : 0, fail: overall === "FAIL" ? 1 : 0, technicalFail: 0, requiredChecks: 1, advisoryChecks: 0 },
    technicalStatus: "PASS",
    overallStatus: overall,
  };
}

/** @param {string} generatedAt @returns {any} */
function emptySnapshot(generatedAt) {
  return {
    version: 1,
    generatedAt,
    repositories: [],
    summary: { repositories: 0, pass: 0, warn: 0, fail: 0, technicalFail: 0, requiredChecks: 0, advisoryChecks: 0 },
    technicalStatus: "PASS",
    overallStatus: "PASS",
  };
}

/** @param {string} generatedAt @returns {any} */
function technicalFailureSnapshot(generatedAt) {
  return {
    version: 1,
    generatedAt,
    repositories: [{
      entry: 0,
      repository: null,
      profile: null,
      policySource: null,
      evidence: null,
      policyStatus: "UNAVAILABLE",
      checks: [],
      unscopedChecks: [],
      required: { total: 0, pass: 0, warn: 0, fail: 0, unverified: 0, missing: 0 },
      advisory: { total: 0, pass: 0, warn: 0, fail: 0, unverified: 0, missing: 0 },
      technicalStatus: "FAIL",
      overallStatus: "FAIL",
      technicalDetail: "synthetic failure",
    }],
    summary: { repositories: 1, pass: 0, warn: 0, fail: 1, technicalFail: 1, requiredChecks: 0, advisoryChecks: 0 },
    technicalStatus: "FAIL",
    overallStatus: "FAIL",
  };
}

/** @param {any} raw */
function validatedSnapshot(raw) {
  const result = validateEcosystemDashboardSnapshot(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.snapshot) throw new Error("dashboard fixture invalid");
  return result.snapshot;
}

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `scheduled-reporting-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("validates HOURLY DAILY and WEEKLY declarative schedules", () => {
  const hourly = policy(); hourly.schedule = { id: "hourly", cadence: "HOURLY", timezone: "UTC", minute: 15 };
  const daily = policy();
  const weekly = policy(); weekly.schedule = { id: "weekly", cadence: "WEEKLY", timezone: "Europe/Amsterdam", weekday: "MON", hour: 9, minute: 30 };
  assert.equal(validateScheduledReportingPolicy(hourly).valid, true);
  assert.equal(validateScheduledReportingPolicy(daily).valid, true);
  assert.equal(validateScheduledReportingPolicy(weekly).valid, true);
});

test("schedule shapes fail closed when cadence-specific fields are missing or extra", () => {
  const hourly = policy(); hourly.schedule = { id: "hourly", cadence: "HOURLY", timezone: "UTC", hour: 8, minute: 0 };
  const daily = policy(); delete daily.schedule.hour;
  const weekly = policy(); weekly.schedule = { id: "weekly", cadence: "WEEKLY", timezone: "UTC", hour: 8, minute: 0 };
  const badTimezone = policy(); badTimezone.schedule.timezone = "timezone with spaces";
  const unknownTimezone = policy(); unknownTimezone.schedule.timezone = "Asia/Definitely_Not_A_Zone";
  assert.equal(validateScheduledReportingPolicy(hourly).valid, false);
  assert.equal(validateScheduledReportingPolicy(daily).valid, false);
  assert.equal(validateScheduledReportingPolicy(weekly).valid, false);
  assert.equal(validateScheduledReportingPolicy(badTimezone).valid, false);
  assert.equal(validateScheduledReportingPolicy(unknownTimezone).valid, false);
});

test("notification policy uses symbolic sinks and bounded explicit triggers", () => {
  const emptyOverall = policy(); emptyOverall.notification.onOverall = [];
  assert.equal(validateScheduledReportingPolicy(emptyOverall).valid, true);
  const duplicateSink = policy(); duplicateSink.notification.sinks.push("engineering-alerts");
  const badTrigger = policy(); badTrigger.notification.onOverall = ["PASS"];
  const badSink = policy(); badSink.notification.sinks = ["https://example.com/hook"];
  assert.equal(validateScheduledReportingPolicy(duplicateSink).valid, false);
  assert.equal(validateScheduledReportingPolicy(badTrigger).valid, false);
  assert.equal(validateScheduledReportingPolicy(badSink).valid, false);
});

test("clean PASS dashboard generates report but no notification", () => {
  const report = planScheduledReporting(
    validateScheduledReportingPolicy(policy()).policy,
    validatedSnapshot(snapshot("PASS", "2026-09-17T07:00:00Z")),
    null,
    "2026-09-17T07:05:00Z",
  );
  assert.equal(report.notification.notify, false);
  assert.deepEqual(report.notification.sinkIds, []);
  assert.deepEqual(report.notification.reasons, []);
  assert.equal(report.history.status, "NOT_CONFIGURED");
});

test("current WARN and FAIL trigger configured overall notifications", () => {
  for (const overall of /** @type {Array<"WARN"|"FAIL">} */ (["WARN", "FAIL"])) {
    const report = planScheduledReporting(
      validateScheduledReportingPolicy(policy()).policy,
      validatedSnapshot(snapshot(overall, "2026-09-17T07:00:00Z")),
      null,
      "2026-09-17T07:05:00Z",
    );
    assert.equal(report.notification.notify, true);
    assert.deepEqual(report.notification.sinkIds, ["engineering-alerts"]);
    assert.equal(report.notification.reasons.some((item) => item.id === `current-overall-${overall.toLowerCase()}`), true);
  }
});

test("technical failure trigger is independent from overall trigger list", () => {
  const rawPolicy = policy(); rawPolicy.notification.onOverall = [];
  const checked = validateScheduledReportingPolicy(rawPolicy);
  assert.equal(checked.valid, true, JSON.stringify(checked.errors));
  if (!checked.valid || !checked.policy) return;
  const report = planScheduledReporting(checked.policy, validatedSnapshot(technicalFailureSnapshot("2026-09-17T07:00:00Z")), null, "2026-09-17T07:05:00Z");
  assert.equal(report.notification.notify, true);
  assert.equal(report.notification.reasons.some((item) => item.id === "current-technical-failure"), true);
});

test("repository regression can trigger notification even when current overall trigger is disabled", () => {
  const rawPolicy = policy(); rawPolicy.notification.onOverall = []; rawPolicy.notification.onTechnicalFailure = false;
  const checked = validateScheduledReportingPolicy(rawPolicy);
  assert.equal(checked.valid, true, JSON.stringify(checked.errors));
  if (!checked.valid || !checked.policy) return;
  const report = planScheduledReporting(
    checked.policy,
    validatedSnapshot(snapshot("WARN", "2026-09-17T08:00:00Z")),
    validatedSnapshot(snapshot("PASS", "2026-09-17T07:00:00Z")),
    "2026-09-17T08:05:00Z",
  );
  assert.equal(report.notification.notify, true);
  assert.equal(report.notification.reasons.some((item) => item.id === "repository-regression"), true);
  assert.equal(report.history.status, "AVAILABLE");
  assert.equal(report.history.regressed, 1);
});

test("repository addition and removal triggers are separately configurable", () => {
  const addedPolicyRaw = policy(); addedPolicyRaw.notification.onOverall = []; addedPolicyRaw.notification.onTechnicalFailure = false; addedPolicyRaw.notification.onRegression = false; addedPolicyRaw.notification.onRepositoryAdded = true; addedPolicyRaw.notification.onRepositoryRemoved = false;
  const addedPolicy = validateScheduledReportingPolicy(addedPolicyRaw);
  assert.equal(addedPolicy.valid, true);
  if (!addedPolicy.valid || !addedPolicy.policy) return;
  const added = planScheduledReporting(addedPolicy.policy, validatedSnapshot(snapshot("PASS", "2026-09-17T08:00:00Z")), validatedSnapshot(emptySnapshot("2026-09-17T07:00:00Z")), "2026-09-17T08:05:00Z");
  assert.equal(added.notification.reasons.some((item) => item.id === "repository-added"), true);

  const removedPolicyRaw = policy(); removedPolicyRaw.notification.onOverall = []; removedPolicyRaw.notification.onTechnicalFailure = false; removedPolicyRaw.notification.onRegression = false; removedPolicyRaw.notification.onRepositoryAdded = false; removedPolicyRaw.notification.onRepositoryRemoved = true;
  const removedPolicy = validateScheduledReportingPolicy(removedPolicyRaw);
  assert.equal(removedPolicy.valid, true);
  if (!removedPolicy.valid || !removedPolicy.policy) return;
  const removed = planScheduledReporting(removedPolicy.policy, validatedSnapshot(emptySnapshot("2026-09-17T08:00:00Z")), validatedSnapshot(snapshot("PASS", "2026-09-17T07:00:00Z")), "2026-09-17T08:05:00Z");
  assert.equal(removed.notification.reasons.some((item) => item.id === "repository-removed"), true);
});

test("regression trigger remains inactive without previous dashboard rather than inventing history", () => {
  const rawPolicy = policy(); rawPolicy.notification.onOverall = []; rawPolicy.notification.onTechnicalFailure = false;
  const checked = validateScheduledReportingPolicy(rawPolicy);
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  const report = planScheduledReporting(checked.policy, validatedSnapshot(snapshot("PASS", "2026-09-17T07:00:00Z")), null, "2026-09-17T07:05:00Z");
  assert.equal(report.notification.notify, false);
  assert.equal(report.history.status, "NOT_CONFIGURED");
});

test("notification event id is deterministic for identical planning inputs", () => {
  const checked = validateScheduledReportingPolicy(policy());
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  const current = validatedSnapshot(snapshot("WARN", "2026-09-17T07:00:00Z"));
  const first = planScheduledReporting(checked.policy, current, null, "2026-09-17T07:05:00Z");
  const second = planScheduledReporting(checked.policy, current, null, "2026-09-17T07:05:00Z");
  assert.equal(first.notification.eventId, second.notification.eventId);
  assert.match(first.notification.eventId, /^[a-f0-9]{64}$/);
});



test("notification event id changes when symbolic sink policy changes", () => {
  const firstPolicy = validateScheduledReportingPolicy(policy());
  const secondRaw = policy(); secondRaw.notification.sinks = ["secondary-alerts"];
  const secondPolicy = validateScheduledReportingPolicy(secondRaw);
  assert.equal(firstPolicy.valid, true); assert.equal(secondPolicy.valid, true);
  if (!firstPolicy.valid || !firstPolicy.policy || !secondPolicy.valid || !secondPolicy.policy) return;
  const current = validatedSnapshot(snapshot("WARN", "2026-09-17T07:00:00Z"));
  const first = planScheduledReporting(firstPolicy.policy, current, null, "2026-09-17T07:05:00Z");
  const second = planScheduledReporting(secondPolicy.policy, current, null, "2026-09-17T07:05:00Z");
  assert.notEqual(first.notification.eventId, second.notification.eventId);
});

test("future current dashboard relative to evaluation time is rejected", () => {
  const checked = validateScheduledReportingPolicy(policy());
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  assert.throws(
    () => planScheduledReporting(checked.policy, validatedSnapshot(snapshot("PASS", "2026-09-17T08:00:00Z")), null, "2026-09-17T07:59:59Z"),
    /newer than evaluation time/,
  );
});

test("human output makes no-dispatch semantics explicit", () => {
  const checked = validateScheduledReportingPolicy(policy());
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  const text = formatScheduledReporting(planScheduledReporting(checked.policy, validatedSnapshot(snapshot("WARN", "2026-09-17T07:00:00Z")), null, "2026-09-17T07:05:00Z"));
  assert.match(text, /external schedulers/);
  assert.match(text, /toolkit sends no notification itself/);
  assert.match(text, /Sinks: engineering-alerts/);
});

test("CLI emits a machine-readable notification plan but never dispatches", () => {
  const policyFile = tempJson(policy()), currentFile = tempJson(snapshot("WARN", "2026-09-17T07:00:00Z"));
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--policy", policyFile, "--current", currentFile, "--evaluated-at", "2026-09-17T07:05:00Z", "--json"]), 0); }
  finally { console.log = original; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.notification.notify, true);
  assert.deepEqual(parsed.notification.sinkIds, ["engineering-alerts"]);
  fs.rmSync(policyFile, { force: true }); fs.rmSync(currentFile, { force: true });
});

test("CLI rejects invalid policy dashboard history and chronology", () => {
  const invalidPolicy = tempJson({ version: 1 }), current = tempJson(snapshot("PASS", "2026-09-17T07:00:00Z"));
  assert.equal(main(["--policy", invalidPolicy, "--current", current, "--evaluated-at", "2026-09-17T07:05:00Z"]), 1);
  const validPolicy = tempJson(policy()), malformed = tempJson("{");
  assert.equal(main(["--policy", validPolicy, "--current", malformed, "--evaluated-at", "2026-09-17T07:05:00Z"]), 1);
  const previous = tempJson(snapshot("PASS", "2026-09-17T08:00:00Z"));
  assert.equal(main(["--policy", validPolicy, "--current", current, "--previous", previous, "--evaluated-at", "2026-09-17T08:05:00Z"]), 1);
  for (const file of [invalidPolicy, current, validPolicy, malformed, previous]) fs.rmSync(file, { force: true });
});

test("scheduled reporting engine remains offline read only and has no dispatch surface", () => {
  const source = fs.readFileSync(new URL("../scripts/scheduled-reporting.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /compareEcosystemHistory/);
  assert.match(source, /validateEcosystemDashboardSnapshot/);
});
