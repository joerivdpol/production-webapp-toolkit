import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatRuntimeEvidenceValidation,
  main,
  validateRuntimeEvidence,
} from "../scripts/runtime-evidence.js";

/** @type {string[]} */
const temporaryPaths = [];

/** @returns {Record<string, any>} */
function validEvidence() {
  return {
    version: 1,
    runtime: { name: "runtime-a" },
    deployment: { commit: "0123456789abcdef0123456789abcdef01234567" },
    evidence: {
      source: "manual",
      authenticated: false,
      collectedAt: "2026-09-01T12:00:00Z",
    },
  };
}

/** @param {unknown} value */
function invalidIds(value) {
  return validateRuntimeEvidence(value).errors.map((error) => error.id);
}

/** @param {string} contents */
function evidenceFile(contents) {
  const filename = path.join(os.tmpdir(), `runtime-evidence-${process.pid}-${temporaryPaths.length}.json`);
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
  console.log = (...values) => {
    stdout += `${values.join(" ")}\n`;
  };
  console.error = (...values) => {
    stderr += `${values.join(" ")}\n`;
  };
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

test("accepts SHA-1 and SHA-256 evidence and normalizes required strings", () => {
  const sha1 = validEvidence();
  sha1.runtime.name = " runtime-a ";
  sha1.runtime.environment = " production ";
  sha1.deployment.commit = sha1.deployment.commit.toUpperCase();
  sha1.evidence.source = " manual ";
  sha1.evidence.collectedAt = " 2026-09-01T12:00:00Z ";

  const normalizedSha1 = validateRuntimeEvidence(sha1);
  assert.deepEqual(normalizedSha1, {
    valid: true,
    evidence: {
      version: 1,
      runtime: { name: "runtime-a", environment: "production" },
      deployment: { commit: "0123456789abcdef0123456789abcdef01234567" },
      evidence: { source: "manual", authenticated: false, collectedAt: "2026-09-01T12:00:00Z" },
    },
    errors: [],
  });

  const sha256 = validEvidence();
  sha256.deployment.commit = "a".repeat(64);
  sha256.evidence.collectedAt = "2026-09-01T19:00:00+07:00";
  assert.equal(validateRuntimeEvidence(sha256).valid, true);
});

test("requires exactly version 1 and the required core objects", () => {
  const missingVersion = validEvidence();
  delete missingVersion.version;
  assert.deepEqual(invalidIds(missingVersion), ["version-missing"]);

  const unsupportedVersion = validEvidence();
  unsupportedVersion.version = 2;
  assert.deepEqual(invalidIds(unsupportedVersion), ["version-unsupported"]);

  for (const key of ["runtime", "deployment", "evidence"]) {
    const candidate = validEvidence();
    delete candidate[key];
    assert.ok(invalidIds(candidate).includes(`${key}-missing`));
  }
});

test("requires non-empty runtime name and permits only a non-empty optional environment", () => {
  const missingName = validEvidence();
  delete missingName.runtime.name;
  assert.ok(invalidIds(missingName).includes("runtime-name-missing"));

  const emptyName = validEvidence();
  emptyName.runtime.name = "   ";
  assert.ok(invalidIds(emptyName).includes("runtime-name-invalid"));

  const emptyEnvironment = validEvidence();
  emptyEnvironment.runtime.environment = " ";
  assert.ok(invalidIds(emptyEnvironment).includes("runtime-environment-invalid"));
});

test("rejects missing and non-full deployment commit identifiers", () => {
  const missingCommit = validEvidence();
  delete missingCommit.deployment.commit;
  assert.ok(invalidIds(missingCommit).includes("deployment-commit-missing"));

  for (const commit of ["0123456789ab", "HEAD", "main~1", "not-a-hex-object-id"]) {
    const candidate = validEvidence();
    candidate.deployment.commit = commit;
    assert.ok(invalidIds(candidate).includes("deployment-commit-invalid"), commit);
  }
});

test("requires source, boolean authenticated, and a semantically valid absolute timestamp", () => {
  const missingSource = validEvidence();
  delete missingSource.evidence.source;
  assert.ok(invalidIds(missingSource).includes("evidence-source-missing"));

  const emptySource = validEvidence();
  emptySource.evidence.source = " ";
  assert.ok(invalidIds(emptySource).includes("evidence-source-invalid"));

  const authenticatedString = validEvidence();
  authenticatedString.evidence.authenticated = "false";
  assert.ok(invalidIds(authenticatedString).includes("evidence-authenticated-invalid"));

  const missingCollectedAt = validEvidence();
  delete missingCollectedAt.evidence.collectedAt;
  assert.ok(invalidIds(missingCollectedAt).includes("evidence-collected-at-missing"));

  for (const timestamp of ["2026-09-01T12:00:00", "not-a-timestamp", "2026-02-30T12:00:00Z", "2026-09-01T12:00:00+25:00"]) {
    const candidate = validEvidence();
    candidate.evidence.collectedAt = timestamp;
    assert.ok(invalidIds(candidate).includes("evidence-collected-at-invalid"), timestamp);
  }
});

test("rejects unknown fields in every version 1 core object", () => {
  for (const candidate of [
    { ...validEvidence(), extra: true },
    { ...validEvidence(), runtime: { ...validEvidence().runtime, extra: true } },
    { ...validEvidence(), deployment: { ...validEvidence().deployment, extra: true } },
    { ...validEvidence(), evidence: { ...validEvidence().evidence, extra: true } },
  ]) {
    const result = validateRuntimeEvidence(candidate);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((error) => error.id.endsWith("-field-unknown")));
  }
});

test("preserves JSON metadata and applies a component-based key safeguard recursively", () => {
  const withMetadata = validEvidence();
  withMetadata.metadata = {
    collector: { labels: ["generic", 1, true] },
    note: "token password secret env environment",
    inventory: { event: { envelope: { tokenizerVersion: "v1" } } },
    items: [{ secretaryNote: "ordinary text" }, { passwordlessMode: true }],
  };
  const valid = validateRuntimeEvidence(withMetadata);
  assert.equal(valid.valid, true);
  assert.deepEqual(valid.evidence?.metadata, withMetadata.metadata);

  for (const key of [
    "token",
    "tokens",
    "password",
    "passwords",
    "secret",
    "secrets",
    "credential",
    "credentials",
    "env",
    "environment",
    "apiToken",
    "api_token",
    "api-token",
    "dbPassword",
    "clientSecret",
    "runtimeCredentials",
    "envName",
    "environmentName",
  ]) {
    const candidate = validEvidence();
    candidate.metadata = { safe: [{ nested: { [key]: "value" } }] };
    assert.ok(invalidIds(candidate).includes("metadata-secret-key"));
  }
});

test("does not reject innocent metadata key substrings", () => {
  const candidate = validEvidence();
  candidate.metadata = {
    inventory: "value",
    event: "value",
    envelope: "value",
    tokenizerVersion: "value",
    secretaryNote: "value",
    passwordlessMode: "value",
  };
  assert.equal(validateRuntimeEvidence(candidate).valid, true);
});

test("returns failures without throwing and is deterministic", () => {
  const invalid = { version: 1, runtime: null, deployment: {}, evidence: {} };
  assert.doesNotThrow(() => validateRuntimeEvidence(invalid));
  assert.deepEqual(validateRuntimeEvidence(invalid), validateRuntimeEvidence(invalid));
});

test("CLI validates files, has stable JSON output, and clearly formats valid human output", () => {
  const filename = evidenceFile(JSON.stringify(validEvidence()));
  const jsonResult = runCli("--file", filename, "--json");
  assert.equal(jsonResult.status, 0);
  assert.deepEqual(JSON.parse(jsonResult.stdout), validateRuntimeEvidence(validEvidence()));

  const humanResult = runCli("--file", filename);
  assert.equal(humanResult.status, 0);
  for (const label of ["Runtime evidence", "Runtime:", "Environment:", "Commit:", "Source:", "Authenticated:", "Collected at:", "Result: VALID"]) {
    assert.match(humanResult.stdout, new RegExp(label));
  }
});

test("CLI rejects invalid schema, malformed JSON, missing files, absent files, and unknown options", () => {
  const invalid = validEvidence();
  invalid.evidence.authenticated = "false";
  const invalidFile = evidenceFile(JSON.stringify(invalid));
  const malformedFile = evidenceFile("{");
  const missingFile = path.join(os.tmpdir(), "runtime-evidence-missing-generic.json");

  for (const result of [
    runCli("--file", invalidFile),
    runCli("--file", malformedFile),
    runCli("--file", missingFile),
    runCli(),
    runCli("--file", invalidFile, "--unknown"),
  ]) {
    assert.equal(result.status, 1);
  }

  const invalidJson = runCli("--file", invalidFile, "--json");
  assert.equal(invalidJson.status, 1);
  assert.equal(JSON.parse(invalidJson.stdout).valid, false);
});

test("the evidence CLI stays offline, does not expose command integrations, and does not modify its input", () => {
  const filename = evidenceFile(JSON.stringify(validEvidence(), null, 2));
  const original = fs.readFileSync(filename, "utf8");
  assert.equal(runCli("--file", filename).status, 0);
  assert.equal(fs.readFileSync(filename, "utf8"), original);

  const source = fs.readFileSync(path.resolve("scripts/runtime-evidence.js"), "utf8");
  assert.doesNotMatch(source, /node:child_process|execFile|spawnSync|process\.env|https?:\/\/|\bfetch\s*\(/);
  assert.match(formatRuntimeEvidenceValidation(validateRuntimeEvidence(validEvidence())), /Result: VALID/);
});
