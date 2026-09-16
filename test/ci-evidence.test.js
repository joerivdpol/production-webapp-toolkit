import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  main,
  validateCiEvidence,
} from "../scripts/ci-evidence.js";

/** @type {string[]} */
const temporaryPaths = [];

/** @param {string} [commit] @returns {Record<string, any>} */
function validEvidence(commit = "0123456789abcdef0123456789abcdef01234567") {
  return {
    version: 1,
    commit,
    ci: { provider: "github-actions", workflow: "CI", runId: "12345" },
    evidence: {
      source: "github-api",
      authenticated: false,
      collectedAt: "2026-09-16T05:00:00Z",
    },
    checks: [
      { name: "typecheck", status: "PASS" },
      { name: "test", status: "PASS" },
      { name: "lint", status: "PASS" },
      { name: "build", status: "PASS" },
    ],
  };
}
/** @param {unknown} value */
function invalidIds(value) {
  return validateCiEvidence(value).errors.map((error) => error.id);
}

/** @param {string} contents */
function evidenceFile(contents) {
  const filename = path.join(os.tmpdir(), `ci-evidence-${process.pid}-${temporaryPaths.length}.json`);
  fs.writeFileSync(filename, contents);
  temporaryPaths.push(filename);
  return filename;
}

/** @param {...string} args */
function runCli(...args) {
  let stdout = "";
  let stderr = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    return { status: main(args), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

afterEach(() => {
  for (const filename of temporaryPaths.splice(0)) fs.rmSync(filename, { force: true });
});
test("accepts SHA-1 and SHA-256 evidence and normalizes strings", () => {
  const sha1 = validEvidence();
  sha1.commit = sha1.commit.toUpperCase();
  sha1.ci.provider = " github-actions ";
  sha1.ci.workflow = " CI ";
  sha1.ci.runId = " 12345 ";
  sha1.evidence.source = " github-api ";
  sha1.evidence.collectedAt = " 2026-09-16T12:00:00+07:00 ";
  sha1.checks[0].name = " typecheck ";

  const result = validateCiEvidence(sha1);
  assert.equal(result.valid, true);
  assert.equal(result.evidence?.commit, "0123456789abcdef0123456789abcdef01234567");
  assert.deepEqual(result.evidence?.ci, { provider: "github-actions", workflow: "CI", runId: "12345" });
  assert.equal(result.evidence?.evidence.source, "github-api");
  assert.equal(result.evidence?.checks[0]?.name, "typecheck");

  const sha256 = validEvidence("A".repeat(64));
  const result256 = validateCiEvidence(sha256);
  assert.equal(result256.valid, true);
  assert.equal(result256.evidence?.commit, "a".repeat(64));
});

test("requires version, full commit, CI identity, and trust metadata", () => {
  const missingVersion = validEvidence();
  delete missingVersion.version;
  assert.ok(invalidIds(missingVersion).includes("version-missing"));

  const invalidCommit = validEvidence("HEAD");
  assert.ok(invalidIds(invalidCommit).includes("commit-invalid"));

  const missingCi = validEvidence();
  delete missingCi.ci;
  assert.ok(invalidIds(missingCi).includes("ci-missing"));

  const emptyProvider = validEvidence();
  emptyProvider.ci.provider = " ";
  assert.ok(invalidIds(emptyProvider).includes("ci-provider-invalid"));

  const invalidTrust = validEvidence();
  invalidTrust.evidence.authenticated = "false";
  assert.ok(invalidIds(invalidTrust).includes("evidence-authenticated-invalid"));

  for (const timestamp of [
    "2026-09-16T05:00:00",
    "not-a-timestamp",
    "2026-02-30T05:00:00Z",
    "2026-09-16T05:00:00+25:00",
  ]) {
    const candidate = validEvidence();
    candidate.evidence.collectedAt = timestamp;
    assert.ok(invalidIds(candidate).includes("evidence-collected-at-invalid"), timestamp);
  }
});

test("requires a non-empty unique check set with explicit statuses", () => {
  const empty = validEvidence();
  empty.checks = [];
  assert.ok(invalidIds(empty).includes("checks-invalid"));

  const duplicate = validEvidence();
  duplicate.checks.push({ name: " typecheck ", status: "PASS" });
  assert.ok(invalidIds(duplicate).includes("check-name-duplicate"));
  const invalidStatus = validEvidence();
  invalidStatus.checks[1].status = "SUCCESS";
  assert.ok(invalidIds(invalidStatus).includes("check-status-invalid"));

  const emptyName = validEvidence();
  emptyName.checks[0].name = " ";
  assert.ok(invalidIds(emptyName).includes("check-name-invalid"));

  for (const status of ["PASS", "FAIL", "SKIPPED"]) {
    const candidate = validEvidence();
    candidate.checks[0].status = status;
    assert.equal(validateCiEvidence(candidate).valid, true, status);
  }
});

test("rejects unknown fields throughout the version 1 contract", () => {
  const candidates = [
    { ...validEvidence(), extra: true },
    { ...validEvidence(), ci: { ...validEvidence().ci, extra: true } },
    { ...validEvidence(), evidence: { ...validEvidence().evidence, extra: true } },
    { ...validEvidence(), checks: [{ ...validEvidence().checks[0], extra: true }] },
  ];
  for (const candidate of candidates) {
    const result = validateCiEvidence(candidate);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.id.endsWith("-field-unknown")));
  }
});

test("validation is deterministic and does not throw for malformed values", () => {
  const invalid = { version: 1, commit: null, ci: null, evidence: [], checks: [null] };
  assert.doesNotThrow(() => validateCiEvidence(invalid));
  assert.deepEqual(validateCiEvidence(invalid), validateCiEvidence(invalid));
});
test("CLI validates files, emits stable JSON, and leaves input unchanged", () => {
  const filename = evidenceFile(JSON.stringify(validEvidence(), null, 2));
  const before = fs.readFileSync(filename, "utf8");

  const jsonResult = runCli("--file", filename, "--json");
  assert.equal(jsonResult.status, 0);
  assert.deepEqual(JSON.parse(jsonResult.stdout), validateCiEvidence(validEvidence()));

  const humanResult = runCli("--file", filename);
  assert.equal(humanResult.status, 0);
  for (const label of ["CI evidence", "Commit:", "Provider:", "Workflow:", "Run ID:", "Source:", "Authenticated:", "Collected at:", "Result: VALID"]) {
    assert.match(humanResult.stdout, new RegExp(label));
  }
  assert.equal(fs.readFileSync(filename, "utf8"), before);
});

test("CLI rejects invalid schema, malformed JSON, missing files, and invalid arguments", () => {
  const invalid = validEvidence();
  invalid.checks[0].status = "SUCCESS";
  const invalidFile = evidenceFile(JSON.stringify(invalid));
  const malformedFile = evidenceFile("{");
  const missingFile = path.join(os.tmpdir(), "ci-evidence-missing-generic.json");

  for (const result of [
    runCli("--file", invalidFile),
    runCli("--file", malformedFile),
    runCli("--file", missingFile),
    runCli(),
    runCli("--file", invalidFile, "--unknown"),
  ]) {
    assert.equal(result.status, 1);
  }
});

test("the CI evidence contract reuses canonical primitives and stays offline and read only", () => {
  const source = fs.readFileSync(path.resolve("scripts/ci-evidence.js"), "utf8");
  assert.match(source, /isAbsoluteIsoTimestamp/);
  assert.match(source, /isFullObjectId/);
  for (const forbidden of ["child_process", "spawnSync", "execFile", "fetch(", "process.env", "https://", "http://", "writeFile"]) {
    assert.equal(source.includes(forbidden), false, `forbidden ${forbidden} surface`);
  }
});