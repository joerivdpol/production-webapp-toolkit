import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatRepositoryCheckEvidence, main, validateRepositoryCheckEvidence } from "../scripts/repository-check-evidence.js";

/** @returns {any} */
function evidence() {
  return {
    version: 1,
    repository: { id: "example-web" },
    evidence: { source: "synthetic", authenticated: false, collectedAt: "2026-09-17T07:00:00Z" },
    checks: [
      { id: "public-safety", status: "PASS" },
      { id: "vulnerabilities", status: "WARN" },
      { id: "runtime-health", status: "UNVERIFIED" },
      { id: "custom-check", status: "FAIL" },
    ],
  };
}
/** @param {any} value */
function tempJson(value) { const file = path.join(os.tmpdir(), `check-evidence-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("validates and canonicalizes repository check evidence", () => {
  const raw = evidence(); raw.checks.reverse();
  const result = validateRepositoryCheckEvidence(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.evidence) return;
  assert.deepEqual(result.evidence.checks.map((item) => item.id), ["custom-check", "public-safety", "runtime-health", "vulnerabilities"]);
  assert.match(formatRepositoryCheckEvidence(result.evidence), /1 pass, 1 warn, 1 fail, 1 unverified/);
});

test("empty check evidence is valid explicit absence of observations", () => {
  const raw = evidence(); raw.checks = [];
  const result = validateRepositoryCheckEvidence(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("rejects duplicate ids unsupported statuses and malformed repository identity", () => {
  const duplicate = evidence(); duplicate.checks.push({ id: "public-safety", status: "PASS" });
  const status = evidence(); status.checks[0].status = "MISSING";
  const repository = evidence(); repository.repository.id = "bad repo id";
  assert.equal(validateRepositoryCheckEvidence(duplicate).valid, false);
  assert.equal(validateRepositoryCheckEvidence(status).valid, false);
  assert.equal(validateRepositoryCheckEvidence(repository).valid, false);
});

test("rejects malformed trust timestamps and unknown fields", () => {
  const timestamp = evidence(); timestamp.evidence.collectedAt = "today";
  const unknown = evidence(); unknown.checks[0].detail = "payload";
  assert.equal(validateRepositoryCheckEvidence(timestamp).valid, false);
  assert.equal(validateRepositoryCheckEvidence(unknown).valid, false);
});

test("CLI emits canonical JSON without mutating input", () => {
  const file = tempJson(evidence()), before = fs.readFileSync(file, "utf8");
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", file, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).repository.id, "example-web");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.rmSync(file, { force: true });
});

test("CLI rejects malformed missing and unknown input", () => {
  const malformed = tempJson("{");
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--file", "/tmp/missing-check-evidence.json"]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("check evidence validator remains offline read only", () => {
  const source = fs.readFileSync(new URL("../scripts/repository-check-evidence.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
