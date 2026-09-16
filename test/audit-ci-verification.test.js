import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatCiVerification,
  inspectCiVerification,
  inspectCiVerificationFromFile,
  main,
} from "../scripts/audit-ci-verification.js";

/** @type {string[]} */
const temporaryPaths = [];
const SHA1 = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA1 = "89abcdef0123456789abcdef0123456789abcdef";

/** @param {string} [commit] @returns {Record<string, any>} */
function validEvidence(commit = SHA1) {
  return {
    version: 1,
    commit,
    ci: { provider: "github-actions", workflow: "CI", runId: "12345" },
    evidence: { source: "github-api", authenticated: false, collectedAt: "2026-09-16T05:00:00Z" },
    checks: [
      { name: "typecheck", status: "PASS" },
      { name: "test", status: "PASS" },
      { name: "lint", status: "PASS" },
      { name: "build", status: "PASS" },
    ],
  };
}
/** @param {unknown} value */
function evidenceFile(value) {
  const filename = path.join(os.tmpdir(), `ci-verification-${process.pid}-${temporaryPaths.length}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value, null, 2));
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

test("exact commit with all required checks passing is PASS", () => {
  const result = inspectCiVerification(validEvidence(), {
    expectedCommit: SHA1,
    requiredChecks: ["typecheck", "test", "lint", "build"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.commitStatus, "MATCH");
  assert.equal(result.report.checksStatus, "PASS");
  assert.equal(result.report.overallStatus, "PASS");
  assert.equal(result.report.technicalStatus, "PASS");
});
test("commit mismatch is a non-technical warning when required checks pass", () => {
  const result = inspectCiVerification(validEvidence(OTHER_SHA1), {
    expectedCommit: SHA1,
    requiredChecks: ["typecheck", "test"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.commitStatus, "MISMATCH");
  assert.equal(result.report.checksStatus, "PASS");
  assert.equal(result.report.overallStatus, "WARN");
  assert.equal(result.report.technicalStatus, "PASS");
});

test("a failed required check is blocking FAIL", () => {
  const evidence = validEvidence();
  evidence.checks[1].status = "FAIL";
  const result = inspectCiVerification(evidence, {
    expectedCommit: SHA1,
    requiredChecks: ["typecheck", "test"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.checksStatus, "FAIL");
  assert.equal(result.report.requiredChecks[1]?.status, "FAIL");
  assert.equal(result.report.overallStatus, "FAIL");
});

test("skipped or missing required checks are UNVERIFIED warnings", () => {
  const evidence = validEvidence();
  evidence.checks[1].status = "SKIPPED";
  const skipped = inspectCiVerification(evidence, {
    expectedCommit: SHA1,
    requiredChecks: ["typecheck", "test"],
  });
  assert.equal(skipped.ok, true);
  if (skipped.ok) {
    assert.equal(skipped.report.checksStatus, "UNVERIFIED");
    assert.equal(skipped.report.overallStatus, "WARN");
  }

  const missing = inspectCiVerification(validEvidence(), {
    expectedCommit: SHA1,
    requiredChecks: ["typecheck", "security"],
  });
  assert.equal(missing.ok, true);
  if (missing.ok) {
    assert.equal(missing.report.requiredChecks[1]?.status, "MISSING");
    assert.equal(missing.report.checksStatus, "UNVERIFIED");
    assert.equal(missing.report.overallStatus, "WARN");
  }
});
test("failed non-required checks do not change the verification result", () => {
  const evidence = validEvidence();
  evidence.checks.push({ name: "optional-security", status: "FAIL" });
  const result = inspectCiVerification(evidence, {
    expectedCommit: SHA1,
    requiredChecks: ["typecheck", "test"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.checksStatus, "PASS");
  assert.equal(result.report.overallStatus, "PASS");
});

test("policy accepts SHA-256, normalizes expected commit, and rejects duplicate required checks", () => {
  const sha256 = "A".repeat(64);
  const result = inspectCiVerification(validEvidence("a".repeat(64)), {
    expectedCommit: sha256,
    requiredChecks: [" typecheck ", "test"],
  });
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.report.expectedCommit, "a".repeat(64));
    assert.deepEqual(result.report.requiredChecks.map((check) => check.name), ["typecheck", "test"]);
  }

  for (const options of [
    { expectedCommit: "HEAD", requiredChecks: ["test"] },
    { expectedCommit: SHA1, requiredChecks: [] },
    { expectedCommit: SHA1, requiredChecks: ["test", " test "] },
    { expectedCommit: SHA1, requiredChecks: [" "] },
  ]) {
    assert.equal(inspectCiVerification(validEvidence(), options).ok, false);
  }
});
test("file adapter rejects malformed, unreadable, and schema-invalid evidence", () => {
  const malformed = inspectCiVerificationFromFile({
    evidenceFile: evidenceFile("{"),
    expectedCommit: SHA1,
    requiredChecks: ["test"],
  });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.id, "ci-evidence-json-malformed");

  const missing = inspectCiVerificationFromFile({
    evidenceFile: path.join(os.tmpdir(), "ci-verification-no-such-file.json"),
    expectedCommit: SHA1,
    requiredChecks: ["test"],
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.error.id, "ci-evidence-file-read-failed");

  const invalid = validEvidence();
  invalid.checks[0].status = "SUCCESS";
  const schema = inspectCiVerificationFromFile({
    evidenceFile: evidenceFile(invalid),
    expectedCommit: SHA1,
    requiredChecks: ["test"],
  });
  assert.equal(schema.ok, false);
  if (!schema.ok) assert.equal(schema.error.id, "ci-evidence-invalid");
});

test("trust metadata is retained but does not change verification truth", () => {
  const evidence = validEvidence();
  evidence.evidence.authenticated = true;
  evidence.evidence.source = "trusted-collector";
  const result = inspectCiVerification(evidence, {
    expectedCommit: SHA1,
    requiredChecks: ["typecheck"],
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.evidence.trust.authenticated, true);
  assert.equal(result.report.evidence.trust.source, "trusted-collector");
  assert.equal(result.report.overallStatus, "PASS");
});
test("CLI has stable JSON and human output with PASS, WARN, and FAIL exit semantics", () => {
  const passingFile = evidenceFile(validEvidence());
  const pass = runCli("--evidence-file", passingFile, "--expected-commit", SHA1, "--require-check", "test", "--json");
  assert.equal(pass.status, 0);
  const parsedPass = JSON.parse(pass.stdout);
  assert.equal(parsedPass.overallStatus, "PASS");

  const mismatchFile = evidenceFile(validEvidence(OTHER_SHA1));
  const warn = runCli("--evidence-file", mismatchFile, "--expected-commit", SHA1, "--require-check", "test");
  assert.equal(warn.status, 0);
  assert.match(warn.stdout, /Commit: MISMATCH/);
  assert.match(warn.stdout, /Overall: WARN/);

  const failedEvidence = validEvidence();
  failedEvidence.checks[1].status = "FAIL";
  const fail = runCli("--evidence-file", evidenceFile(failedEvidence), "--expected-commit", SHA1, "--require-check", "test");
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /Required checks: FAIL/);
  assert.match(fail.stdout, /Overall: FAIL/);
});

test("file verification is read only and human formatting exposes the stable report", () => {
  const filename = evidenceFile(validEvidence());
  const before = fs.readFileSync(filename, "utf8");
  const result = inspectCiVerificationFromFile({ evidenceFile: filename, expectedCommit: SHA1, requiredChecks: ["typecheck", "test"] });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const human = formatCiVerification(result.report);
  for (const label of ["CI verification", "Expected commit", "Evidence commit", "Commit: MATCH", "Required checks: PASS", "Provider", "Source", "Technical: PASS", "Overall: PASS"]) {
    assert.match(human, new RegExp(label));
  }
  assert.equal(fs.readFileSync(filename, "utf8"), before);
});
test("CI verification delegates canonical validation and has no command or network surface", () => {
  const source = fs.readFileSync(path.resolve("scripts/audit-ci-verification.js"), "utf8");
  assert.match(source, /validateCiEvidence/);
  assert.match(source, /isFullObjectId/);
  for (const forbidden of ["child_process", "spawnSync", "execFile", "fetch(", "process.env", "https://", "http://", "writeFile", "git "]) {
    assert.equal(source.includes(forbidden), false, `forbidden ${forbidden} surface`);
  }
});