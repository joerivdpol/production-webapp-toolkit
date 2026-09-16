import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatBookingIntegrityEvidence, main, validateBookingIntegrityEvidence } from "../scripts/booking-integrity-evidence.js";

const COMMIT = "a".repeat(40);
/** @returns {any} */
function rawEvidence() {
  return {
    version: 1,
    artifact: { commit: COMMIT },
    evidence: { source: "synthetic-concurrency-suite", authenticated: false, collectedAt: "2026-09-17T00:00:00Z" },
    profiles: [{ id: "booking-core", metrics: {
      concurrency: { competingAttempts: 8, oversoldUnits: 0 },
      duplicatePrevention: { duplicateAttempts: 4, duplicateBookings: 0 },
      expiryRelease: { expiredClaims: 3, unreleasedClaims: 0 },
      retrySafety: { retryAttempts: 5, duplicateBookings: 0 },
      timezone: { cases: 6, mismatches: 0 },
    } }],
  };
}
/** @param {any} value */
function tempJson(value) { const file = path.join(os.tmpdir(), `booking-evidence-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }
test("normalizes commit-bound booking integrity evidence", () => {
  const raw = rawEvidence(); raw.artifact.commit = COMMIT.toUpperCase();
  const result = validateBookingIntegrityEvidence(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.evidence) return;
  assert.equal(result.evidence.artifact.commit, COMMIT);
  assert.equal(result.evidence.profiles[0].metrics.concurrency.competingAttempts, 8);
  assert.match(formatBookingIntegrityEvidence(result.evidence), /Result: VALID/);
});

test("requires full Git commit and absolute evidence timestamp", () => {
  const commit = rawEvidence(); commit.artifact.commit = "abc123";
  assert.equal(validateBookingIntegrityEvidence(commit).valid, false);
  const timestamp = rawEvidence(); timestamp.evidence.collectedAt = "2026-09-17";
  assert.equal(validateBookingIntegrityEvidence(timestamp).valid, false);
});

test("requires all empirical metric families with bounded integer counts", () => {
  const missing = rawEvidence(); delete missing.profiles[0].metrics.timezone;
  assert.equal(validateBookingIntegrityEvidence(missing).valid, false);
  const attempts = rawEvidence(); attempts.profiles[0].metrics.concurrency.competingAttempts = 1;
  assert.equal(validateBookingIntegrityEvidence(attempts).valid, false);
  const negative = rawEvidence(); negative.profiles[0].metrics.retrySafety.duplicateBookings = -1;
  assert.equal(validateBookingIntegrityEvidence(negative).valid, false);
});
test("rejects duplicate profile ids and malformed trust metadata", () => {
  const duplicate = rawEvidence(); duplicate.profiles.push(structuredClone(duplicate.profiles[0]));
  assert.equal(validateBookingIntegrityEvidence(duplicate).valid, false);
  const trust = rawEvidence(); trust.evidence.authenticated = "yes";
  assert.equal(validateBookingIntegrityEvidence(trust).valid, false);
});

test("rejects unsupported evidence fields", () => {
  const raw = rawEvidence(); raw.extra = true;
  assert.equal(validateBookingIntegrityEvidence(raw).valid, false);
});
test("CLI emits canonical JSON without mutating evidence", () => {
  const file = tempJson(rawEvidence()), before = fs.readFileSync(file, "utf8");
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", file, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).artifact.commit, COMMIT);
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.rmSync(file, { force: true });
});

test("CLI rejects malformed and unknown input", () => {
  const malformed = tempJson("{");
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});
