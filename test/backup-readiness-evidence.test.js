import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatBackupReadinessEvidence, main, validateBackupReadinessEvidence } from "../scripts/backup-readiness-evidence.js";

/** @returns {any} */
function rawEvidence() { return { version: 1, evidence: { source: "backup-controller", authenticated: false, collectedAt: "2026-09-17T00:00:00Z" }, systems: [{ id: "primary-db", backup: { completedAt: "2026-09-16T23:30:00Z", status: "SUCCESS", encrypted: true }, restoreTest: { testedAt: "2026-09-16T22:00:00Z", status: "PASS" } }] }; }
/** @param {any} value */
function tempJson(value) { const file = path.join(os.tmpdir(), `backup-evidence-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("normalizes explicit backup and restore-test evidence", () => {
  const result = validateBackupReadinessEvidence(rawEvidence());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.evidence) return;
  assert.equal(result.evidence.systems[0].backup.encrypted, true);
  assert.match(formatBackupReadinessEvidence(result.evidence), /Result: VALID/);
});

test("accepts failure and unencrypted facts as evidence without calling them ready", () => {
  const raw = rawEvidence(); raw.systems[0].backup.status = "FAILED"; raw.systems[0].backup.encrypted = false; raw.systems[0].restoreTest.status = "FAIL";
  assert.equal(validateBackupReadinessEvidence(raw).valid, true);
});
test("rejects invalid timestamps statuses trust metadata and duplicate systems", () => {
  const time = rawEvidence(); time.systems[0].backup.completedAt = "yesterday";
  assert.equal(validateBackupReadinessEvidence(time).valid, false);
  const status = rawEvidence(); status.systems[0].restoreTest.status = "UNKNOWN";
  assert.equal(validateBackupReadinessEvidence(status).valid, false);
  const trust = rawEvidence(); trust.evidence.authenticated = "yes";
  assert.equal(validateBackupReadinessEvidence(trust).valid, false);
  const duplicate = rawEvidence(); duplicate.systems.push(structuredClone(duplicate.systems[0]));
  assert.equal(validateBackupReadinessEvidence(duplicate).valid, false);
});

test("rejects unknown evidence fields rather than inventing semantics", () => {
  const raw = rawEvidence(); raw.systems[0].retentionDays = 30;
  assert.equal(validateBackupReadinessEvidence(raw).valid, false);
});

test("CLI emits canonical JSON without changing source evidence", () => {
  const file = tempJson(rawEvidence()), before = fs.readFileSync(file, "utf8");
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", file, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).systems[0].id, "primary-db");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.rmSync(file, { force: true });
});
test("CLI rejects malformed and unknown input", () => {
  const malformed = tempJson("{");
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("backup evidence contract is offline and read only", () => {
  const source = fs.readFileSync(new URL("../scripts/backup-readiness-evidence.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
