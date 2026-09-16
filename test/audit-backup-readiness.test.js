import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatBackupReadiness, inspectBackupReadiness, main, validateBackupReadinessPolicy } from "../scripts/audit-backup-readiness.js";
import { validateBackupReadinessEvidence } from "../scripts/backup-readiness-evidence.js";

const EVALUATED = "2026-09-17T00:10:00Z";
/** @returns {any} */
function rawPolicy() { return { version: 1, systems: [{ id: "primary-db", maxBackupAgeMinutes: 60, requireEncrypted: true, restoreInstructionsPath: "docs/restore.md", maxRestoreTestAgeMinutes: 1440 }] }; }
/** @returns {any} */
function rawEvidence() { return { version: 1, evidence: { source: "backup-controller", authenticated: false, collectedAt: "2026-09-17T00:00:00Z" }, systems: [{ id: "primary-db", backup: { completedAt: "2026-09-16T23:30:00Z", status: "SUCCESS", encrypted: true }, restoreTest: { testedAt: "2026-09-16T22:00:00Z", status: "PASS" } }] }; }
function policy(raw = rawPolicy()) { const result = validateBackupReadinessPolicy(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("policy invalid"); return result.policy; }
function evidence(raw = rawEvidence()) { const result = validateBackupReadinessEvidence(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.evidence) throw new Error("evidence invalid"); return result.evidence; }
function repository() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-readiness-")); fs.mkdirSync(path.join(root, "docs")); fs.writeFileSync(path.join(root, "docs/restore.md"), "restore procedure\n"); return root; }
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }
test("fresh successful encrypted backup with recent restore test passes", () => {
  const root = repository(), report = inspectBackupReadiness(root, policy(), evidence(), EVALUATED);
  assert.equal(report.overallStatus, "PASS");
  for (const id of ["backup-latest-success", "backup-fresh", "backup-encrypted", "restore-instructions-present", "restore-test-pass", "restore-test-fresh"]) assert.equal(report.checks.some((item) => item.id === id && item.status === "PASS"), true);
  assert.match(report.semantics, /not independently verified/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("stale or failed backup remains separate blocking evidence", () => {
  const stale = rawEvidence(); stale.systems[0].backup.completedAt = "2026-09-16T20:00:00Z";
  let root = repository(), report = inspectBackupReadiness(root, policy(), evidence(stale), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "backup-stale"), true);
  fs.rmSync(root, { recursive: true, force: true });
  const failed = rawEvidence(); failed.systems[0].backup.status = "FAILED";
  root = repository(); report = inspectBackupReadiness(root, policy(), evidence(failed), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "backup-latest-failed"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("encryption requirement is explicit and non-required encryption stays visible", () => {
  const raw = rawEvidence(); raw.systems[0].backup.encrypted = false;
  let root = repository(), report = inspectBackupReadiness(root, policy(), evidence(raw), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "backup-unencrypted"), true);
  fs.rmSync(root, { recursive: true, force: true });
  const allow = rawPolicy(); allow.systems[0].requireEncrypted = false;
  root = repository(); report = inspectBackupReadiness(root, policy(allow), evidence(raw), EVALUATED);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "backup-encryption-not-required"), true);
  fs.rmSync(root, { recursive: true, force: true });
});
test("restore instructions must be non-empty regular non-symlink file", () => {
  let root = repository(); fs.rmSync(path.join(root, "docs/restore.md"));
  let report = inspectBackupReadiness(root, policy(), evidence(), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "restore-instructions-missing"), true);
  fs.rmSync(root, { recursive: true, force: true });
  root = repository(); fs.rmSync(path.join(root, "docs/restore.md")); fs.symlinkSync("/etc/passwd", path.join(root, "docs/restore.md"));
  report = inspectBackupReadiness(root, policy(), evidence(), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "restore-instructions-missing"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("failed and stale restore tests are independently blocking", () => {
  const failed = rawEvidence(); failed.systems[0].restoreTest.status = "FAIL";
  let root = repository(), report = inspectBackupReadiness(root, policy(), evidence(failed), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "restore-test-failed"), true);
  fs.rmSync(root, { recursive: true, force: true });
  const stale = rawEvidence(); stale.systems[0].restoreTest.testedAt = "2026-09-15T00:00:00Z";
  root = repository(); report = inspectBackupReadiness(root, policy(), evidence(stale), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "restore-test-stale"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("future collection and timeline inconsistencies fail closed", () => {
  const future = rawEvidence(); future.evidence.collectedAt = "2026-09-17T01:00:00Z";
  let root = repository(), report = inspectBackupReadiness(root, policy(), evidence(future), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "backup-evidence-future"), true);
  fs.rmSync(root, { recursive: true, force: true });
  const timeline = rawEvidence(); timeline.systems[0].backup.completedAt = "2026-09-17T00:05:00Z";
  root = repository(); report = inspectBackupReadiness(root, policy(), evidence(timeline), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "backup-evidence-timeline-invalid"), true);
  fs.rmSync(root, { recursive: true, force: true });
});
test("missing system evidence is blocking without substituting another system", () => {
  const raw = rawEvidence(); raw.systems[0].id = "other-db";
  const root = repository(), report = inspectBackupReadiness(root, policy(), evidence(raw), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "backup-system-evidence-missing" && item.system === "primary-db"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("policy rejects unsafe restore paths duplicate ids and invalid age bounds", () => {
  const unsafe = rawPolicy(); unsafe.systems[0].restoreInstructionsPath = "../restore.md";
  assert.equal(validateBackupReadinessPolicy(unsafe).valid, false);
  const duplicate = rawPolicy(); duplicate.systems.push(structuredClone(duplicate.systems[0]));
  assert.equal(validateBackupReadinessPolicy(duplicate).valid, false);
  const age = rawPolicy(); age.systems[0].maxBackupAgeMinutes = 0;
  assert.equal(validateBackupReadinessPolicy(age).valid, false);
});

test("authentication metadata is reported but never changes readiness truth", () => {
  const raw = rawEvidence(); raw.evidence.authenticated = true;
  const root = repository(), report = inspectBackupReadiness(root, policy(), evidence(raw), EVALUATED);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.evidenceAuthenticated, true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("human report exposes status and age without restore-instruction contents", () => {
  const marker = "UNIQUE_RESTORE_TEXT_229";
  const root = repository(); fs.writeFileSync(path.join(root, "docs/restore.md"), marker);
  const output = formatBackupReadiness(inspectBackupReadiness(root, policy(), evidence(), EVALUATED));
  assert.match(output, /backup-fresh/);
  assert.doesNotMatch(output, new RegExp(marker));
  fs.rmSync(root, { recursive: true, force: true });
});
test("CLI composes policy evidence repository instructions and explicit evaluation time", () => {
  const root = repository(), policyFile = tempJson("backup-policy", rawPolicy()), evidenceFile = tempJson("backup-evidence", rawEvidence());
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", policyFile, "--evidence", evidenceFile, "--evaluated-at", EVALUATED, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  assert.equal(main(["--root", root, "--policy", policyFile, "--evidence", evidenceFile, "--evaluated-at", "today"]), 1);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(policyFile, { force: true }); fs.rmSync(evidenceFile, { force: true });
});

test("CLI rejects malformed input and unknown options", () => {
  const malformed = tempJson("backup-bad", "{");
  assert.equal(main(["--root", "/tmp/missing-backup-repo", "--policy", malformed, "--evidence", malformed, "--evaluated-at", EVALUATED]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("backup audit is local read only and restore instruction contents are not read", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-backup-readiness.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /lstatSync/);
  assert.match(source, /validateBackupReadinessEvidence/);
});
