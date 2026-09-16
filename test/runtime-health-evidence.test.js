import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatRuntimeHealthEvidence,
  main,
  validateRuntimeHealthEvidence,
} from "../scripts/runtime-health-evidence.js";

/** @returns {any} */
function rawEvidence() {
  return {
    version: 1,
    runtime: { name: "web", environment: "production" },
    evidence: { source: "synthetic-health", authenticated: false, collectedAt: "2026-09-16T18:30:00Z" },
    checks: [
      { id: "database", category: "database", status: "healthy", latencyMs: 11 },
      { id: "http", category: "HTTP", status: "DEGRADED", latencyMs: 82 },
    ],
  };
}

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `runtime-health-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("normalizes explicit runtime health evidence without deployment identity", () => {
  const result = validateRuntimeHealthEvidence(rawEvidence());
  assert.equal(result.valid, true);
  if (!result.valid || !result.evidence) return;
  assert.deepEqual(result.evidence.checks.map((item) => item.id), ["database", "http"]);
  assert.equal(result.evidence.checks[0]?.status, "HEALTHY");
  assert.equal(result.evidence.checks[1]?.category, "http");
  assert.equal("deployment" in result.evidence, false);
  assert.match(formatRuntimeHealthEvidence(result.evidence), /Deployment identity: NOT INCLUDED/);
});

test("supports bounded generic health categories and status states", () => {
  const value = rawEvidence();
  value.checks = [
    { id: "http", category: "http", status: "HEALTHY" },
    { id: "db", category: "database", status: "DEGRADED" },
    { id: "api", category: "upstream", status: "UNHEALTHY" },
    { id: "queue", category: "queue", status: "UNKNOWN" },
    { id: "jobs", category: "job", status: "HEALTHY" },
    { id: "custom", category: "custom", status: "HEALTHY" },
  ];
  const result = validateRuntimeHealthEvidence(value);
  assert.equal(result.valid, true);
});

test("rejects unknown top-level and check fields rather than guessing semantics", () => {
  const top = rawEvidence();
  top.deployment = { commit: "a".repeat(40) };
  assert.equal(validateRuntimeHealthEvidence(top).valid, false);

  const check = rawEvidence();
  check.checks[0].detail = "postgres password leaked here";
  assert.equal(validateRuntimeHealthEvidence(check).valid, false);
});

test("rejects duplicate ids invalid categories statuses and latency", () => {
  const duplicate = rawEvidence();
  duplicate.checks.push({ id: "http", category: "http", status: "HEALTHY" });
  assert.equal(validateRuntimeHealthEvidence(duplicate).valid, false);

  const category = rawEvidence();
  category.checks[0].category = "filesystem";
  assert.equal(validateRuntimeHealthEvidence(category).valid, false);

  const status = rawEvidence();
  status.checks[0].status = "MAYBE";
  assert.equal(validateRuntimeHealthEvidence(status).valid, false);

  const latency = rawEvidence();
  latency.checks[0].latencyMs = -1;
  assert.equal(validateRuntimeHealthEvidence(latency).valid, false);
});

test("requires explicit runtime identity and source trust metadata", () => {
  const noName = rawEvidence();
  noName.runtime.name = "";
  assert.equal(validateRuntimeHealthEvidence(noName).valid, false);

  const badTime = rawEvidence();
  badTime.evidence.collectedAt = "today";
  assert.equal(validateRuntimeHealthEvidence(badTime).valid, false);

  const badAuth = rawEvidence();
  badAuth.evidence.authenticated = "yes";
  assert.equal(validateRuntimeHealthEvidence(badAuth).valid, false);
});

test("CLI emits canonical JSON and leaves input unchanged", () => {
  const filename = tempJson(rawEvidence());
  const before = fs.readFileSync(filename, "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", filename, "--json"]), 0); }
  finally { console.log = originalLog; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.runtime.name, "web");
  assert.equal(parsed.checks[0].id, "database");
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed missing invalid and unknown input", () => {
  const malformed = tempJson("{");
  const invalid = tempJson({ version: 1 });
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--file", invalid]), 1);
  assert.equal(main(["--file", "/tmp/missing-runtime-health.json"]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  fs.rmSync(invalid, { force: true });
});

test("runtime health evidence core stays offline and read only", () => {
  const source = fs.readFileSync(new URL("../scripts/runtime-health-evidence.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /isAbsoluteIsoTimestamp/);
});
