import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatBookingIntegrity, inspectBookingIntegrity, main, validateBookingIntegrityPolicy } from "../scripts/audit-booking-integrity.js";
import { validateBookingIntegrityEvidence } from "../scripts/booking-integrity-evidence.js";

const COMMIT = "b".repeat(40);
const CONTROLS = ["atomicClaim", "duplicatePrevention", "expiry", "release", "timezoneConsistency", "retrySafety"];
/** @returns {Record<string,string>} */
function calls() { return { atomicClaim: "claimInventory", duplicatePrevention: "rejectDuplicate", expiry: "expireClaim", release: "releaseInventory", timezoneConsistency: "normalizeBookingTime", retrySafety: "dedupeRetry" }; }
/** @returns {any} */
function rawPolicy() {
  const names = calls();
  /** @type {Record<string,any>} */
  const controls = {};
  for (const name of CONTROLS) controls[name] = { severity: "FAIL", evidenceFiles: ["src/bookings/core.ts"], callees: [names[name]] };
  return { version: 1, profiles: [{ id: "booking-core", controls, empiricalEvidence: { required: true, minCompetingAttempts: 4, maxOversoldUnits: 0, maxDuplicateBookings: 0, maxUnreleasedClaims: 0, maxRetryDuplicateBookings: 0, maxTimezoneMismatches: 0 } }] };
}
/** @returns {any} */
function rawEvidence() { return { version: 1, artifact: { commit: COMMIT }, evidence: { source: "synthetic-booking-suite", authenticated: false, collectedAt: "2026-09-17T00:00:00Z" }, profiles: [{ id: "booking-core", metrics: { concurrency: { competingAttempts: 8, oversoldUnits: 0 }, duplicatePrevention: { duplicateAttempts: 4, duplicateBookings: 0 }, expiryRelease: { expiredClaims: 3, unreleasedClaims: 0 }, retrySafety: { retryAttempts: 5, duplicateBookings: 0 }, timezone: { cases: 6, mismatches: 0 } } }] }; }
function policy(raw = rawPolicy()) { const result = validateBookingIntegrityPolicy(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("policy invalid"); return result.policy; }
function evidence(raw = rawEvidence()) { const result = validateBookingIntegrityEvidence(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.evidence) throw new Error("evidence invalid"); return result.evidence; }
/** @param {string} [source] */
function repository(source) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "booking-integrity-")); fs.mkdirSync(path.join(root, "src/bookings"), { recursive: true });
  const c = calls();
  const normal = `export function booking(input) { ${c.atomicClaim}(input); ${c.duplicatePrevention}(input); ${c.expiry}(input); ${c.release}(input); ${c.timezoneConsistency}(input); ${c.retrySafety}(input); }\n`;
  fs.writeFileSync(path.join(root, "src/bookings/core.ts"), source ?? normal);
  return root;
}
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("policy requires all six static booking controls plus explicit empirical thresholds", () => {
  const result = validateBookingIntegrityPolicy(rawPolicy());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) return;
  assert.deepEqual(Object.keys(result.policy.profiles[0].controls).sort(), [...CONTROLS].sort());
  const missing = rawPolicy(); delete missing.profiles[0].controls.release;
  assert.equal(validateBookingIntegrityPolicy(missing).valid, false);
});

test("complete static and empirical evidence passes", () => {
  const root = repository();
  const report = inspectBookingIntegrity(root, policy(), evidence(), COMMIT);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks.filter((item) => item.id === "booking-control-present").length, 6);
  assert.equal(report.checks.some((item) => item.id === "booking-oversell" && item.status === "PASS"), true);
  assert.match(report.semantics, /atomicity.*not independently proven/);
  fs.rmSync(root, { recursive: true, force: true });
});
test("oversell duplicate release retry and timezone evidence fail only explicit thresholds", () => {
  const raw = rawEvidence();
  raw.profiles[0].metrics.concurrency.oversoldUnits = 1;
  raw.profiles[0].metrics.duplicatePrevention.duplicateBookings = 1;
  raw.profiles[0].metrics.expiryRelease.unreleasedClaims = 1;
  raw.profiles[0].metrics.retrySafety.duplicateBookings = 1;
  raw.profiles[0].metrics.timezone.mismatches = 1;
  const root = repository(), report = inspectBookingIntegrity(root, policy(), evidence(raw), COMMIT);
  for (const id of ["booking-oversell", "booking-duplicate-prevention", "booking-expiry-release", "booking-retry-safety", "booking-timezone-consistency"]) assert.equal(report.checks.some((item) => item.id === id && item.status === "FAIL"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("insufficient concurrency attempts fail without inventing booking capacity", () => {
  const raw = rawEvidence(); raw.profiles[0].metrics.concurrency.competingAttempts = 2;
  const root = repository(), report = inspectBookingIntegrity(root, policy(), evidence(raw), COMMIT);
  assert.equal(report.checks.some((item) => item.id === "booking-concurrency-attempts" && item.status === "FAIL"), true);
  assert.equal(report.checks.some((item) => /capacity/i.test(item.detail)), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("evidence commit mismatch is blocking and trust authentication does not change truth", () => {
  const raw = rawEvidence(); raw.evidence.authenticated = true;
  const root = repository(), report = inspectBookingIntegrity(root, policy(), evidence(raw), "c".repeat(40));
  assert.equal(report.checks.some((item) => item.id === "booking-evidence-commit-mismatch"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});
test("required empirical evidence blocks when absent while optional evidence remains visible", () => {
  const root = repository();
  const required = inspectBookingIntegrity(root, policy(), null, null);
  assert.equal(required.checks.some((item) => item.id === "booking-evidence-required" && item.status === "FAIL"), true);
  const raw = rawPolicy(); raw.profiles[0].empiricalEvidence.required = false;
  const optional = inspectBookingIntegrity(root, policy(raw), null, null);
  assert.equal(optional.overallStatus, "WARN");
  assert.equal(optional.checks.some((item) => item.id === "booking-evidence-not-configured"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing evidence profile id fails closed", () => {
  const raw = rawEvidence(); raw.profiles[0].id = "other-profile";
  const root = repository(), report = inspectBookingIntegrity(root, policy(), evidence(raw), COMMIT);
  assert.equal(report.checks.some((item) => item.id === "booking-evidence-profile-missing"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing static booking control remains distinct from passing empirical outcome", () => {
  const c = calls();
  const source = `export function booking(input) { ${c.duplicatePrevention}(input); ${c.expiry}(input); ${c.release}(input); ${c.timezoneConsistency}(input); ${c.retrySafety}(input); }\n`;
  const root = repository(source), report = inspectBookingIntegrity(root, policy(), evidence(), COMMIT);
  assert.equal(report.checks.some((item) => item.id === "booking-control-missing" && item.control === "atomicClaim"), true);
  assert.equal(report.checks.some((item) => item.id === "booking-oversell" && item.status === "PASS"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});
test("ignored static control remains an explicit warning and no structural claim", () => {
  const raw = rawPolicy(); raw.profiles[0].controls.expiry = { severity: "IGNORE", evidenceFiles: [], callees: [] };
  const root = repository(), report = inspectBookingIntegrity(root, policy(raw), evidence(), COMMIT);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "booking-control-ignored" && item.control === "expiry"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("uninspectable static source fails closed without exposing source text", () => {
  const root = repository();
  fs.rmSync(path.join(root, "src/bookings/core.ts"));
  fs.symlinkSync("/etc/passwd", path.join(root, "src/bookings/core.ts"));
  const report = inspectBookingIntegrity(root, policy(), evidence(), COMMIT);
  assert.equal(report.checks.some((item) => item.id === "booking-control-evidence-uninspectable"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("policy rejects unsafe paths duplicate ids invalid severity and thresholds", () => {
  const unsafe = rawPolicy(); unsafe.profiles[0].controls.atomicClaim.evidenceFiles = ["../claim.ts"];
  assert.equal(validateBookingIntegrityPolicy(unsafe).valid, false);
  const duplicate = rawPolicy(); duplicate.profiles.push(structuredClone(duplicate.profiles[0]));
  assert.equal(validateBookingIntegrityPolicy(duplicate).valid, false);
  const severity = rawPolicy(); severity.profiles[0].controls.release.severity = "BLOCK";
  assert.equal(validateBookingIntegrityPolicy(severity).valid, false);
  const threshold = rawPolicy(); threshold.profiles[0].empiricalEvidence.minCompetingAttempts = 1;
  assert.equal(validateBookingIntegrityPolicy(threshold).valid, false);
});
test("human report exposes metrics and bounds without source payloads", () => {
  const marker = "UNIQUE_BOOKING_SOURCE_711";
  const c = calls();
  const source = `export function booking(input) { const marker = "${marker}"; ${c.atomicClaim}(input); ${c.duplicatePrevention}(input); ${c.expiry}(input); ${c.release}(input); ${c.timezoneConsistency}(input); ${c.retrySafety}(input); }\n`;
  const root = repository(source), output = formatBookingIntegrity(inspectBookingIntegrity(root, policy(), evidence(), COMMIT));
  assert.match(output, /Booking integrity audit/);
  assert.match(output, /booking-oversell/);
  assert.doesNotMatch(output, new RegExp(marker));
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI composes policy evidence and exact expected commit", () => {
  const root = repository(), policyFile = tempJson("booking-policy", rawPolicy()), evidenceFile = tempJson("booking-evidence", rawEvidence());
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", policyFile, "--evidence", evidenceFile, "--expected-commit", COMMIT, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  assert.equal(main(["--root", root, "--policy", policyFile]), 1);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(policyFile, { force: true }); fs.rmSync(evidenceFile, { force: true });
});

test("CLI requires evidence and expected commit together and rejects malformed input", () => {
  const malformed = tempJson("booking-bad", "{");
  assert.equal(main(["--root", "/tmp/missing-booking-repo", "--policy", malformed]), 1);
  assert.equal(main(["--root", "/tmp/whatever", "--policy", malformed, "--evidence", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("booking audit is local read only and empirical evidence stays caller supplied", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-booking-integrity.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /validateBookingIntegrityEvidence/);
  assert.match(source, /inspectTypeScriptCalls/);
});
