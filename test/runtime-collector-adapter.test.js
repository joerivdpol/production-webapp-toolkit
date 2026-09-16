import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  adaptRuntimeCollectorObservation,
  formatRuntimeCollectorAdapter,
  main,
  validateRuntimeCollectorObservation,
} from "../scripts/runtime-collector-adapter.js";
import { validateRuntimeEvidence } from "../scripts/runtime-evidence.js";

/** @param {"checkout"|"application"|"container"|"process"} [kind] @returns {any} */
function observation(kind = "checkout") {
  return {
    version: 1,
    collector: { kind, source: `synthetic-${kind}`, authenticated: false, collectedAt: "2026-09-16T18:00:00Z" },
    runtime: { name: "example-runtime", environment: "production" },
    deployment: { commit: "0123456789abcdef0123456789abcdef01234567" },
  };
}

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `runtime-collector-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("validates explicit collector observations and normalizes strings", () => {
  const value = observation();
  value.collector.source = " synthetic-checkout ";
  value.runtime.name = " example-runtime ";
  value.runtime.environment = " production ";
  value.deployment.commit = value.deployment.commit.toUpperCase();
  const result = validateRuntimeCollectorObservation(value);
  assert.equal(result.valid, true);
  assert.equal(result.observation?.deployment.commit, "0123456789abcdef0123456789abcdef01234567");
  assert.equal(result.observation?.runtime.name, "example-runtime");
});

test("all supported collector kinds map to explicit identity scopes", () => {
  const expected = {
    checkout: "checkout",
    application: "application-reported",
    container: "container",
    process: "process",
  };
  for (const [kind, scope] of Object.entries(expected)) {
    const result = adaptRuntimeCollectorObservation(observation(/** @type {any} */ (kind)));
    assert.equal(result.valid, true);
    assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.identityScope, scope);
  }
});

test("checkout observation cannot silently present itself as process identity", () => {
  const result = adaptRuntimeCollectorObservation(observation("checkout"));
  assert.equal(result.valid, true);
  assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.kind, "checkout");
  assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.identityScope, "checkout");
  assert.notEqual((/** @type {any} */ (result.evidence?.metadata?.collector))?.identityScope, "process");
});

test("adapter output always validates as canonical Runtime Evidence v1", () => {
  for (const kind of ["checkout", "application", "container", "process"]) {
    const result = adaptRuntimeCollectorObservation(observation(/** @type {any} */ (kind)));
    assert.equal(result.valid, true);
    assert.equal(validateRuntimeEvidence(result.evidence).valid, true);
  }
});

test("collector trust metadata is preserved without changing deployment identity", () => {
  const value = observation("application");
  value.collector.authenticated = true;
  const result = adaptRuntimeCollectorObservation(value);
  assert.equal(result.evidence?.evidence.authenticated, true);
  assert.equal(result.evidence?.deployment.commit, value.deployment.commit);
});

test("rejects unsupported kinds malformed commits timestamps and unknown fields", () => {
  const badKind = observation(); badKind.collector.kind = "ssh";
  assert.equal(validateRuntimeCollectorObservation(badKind).valid, false);

  const badCommit = observation(); badCommit.deployment.commit = "HEAD";
  assert.equal(validateRuntimeCollectorObservation(badCommit).valid, false);

  const badTime = observation(); badTime.collector.collectedAt = "today";
  assert.equal(validateRuntimeCollectorObservation(badTime).valid, false);

  const unknown = observation(); unknown.metadata = { processIdentity: true };
  assert.equal(validateRuntimeCollectorObservation(unknown).valid, false);
});

test("collector cannot inject arbitrary metadata or sensitive fields", () => {
  const value = observation();
  value.collector.token = "synthetic";
  assert.equal(validateRuntimeCollectorObservation(value).valid, false);
  const runtime = observation(); runtime.runtime.secret = "synthetic";
  assert.equal(validateRuntimeCollectorObservation(runtime).valid, false);
});

test("human formatter exposes kind and identity scope", () => {
  const text = formatRuntimeCollectorAdapter(adaptRuntimeCollectorObservation(observation("application")));
  assert.match(text, /Collector kind: application/);
  assert.match(text, /Identity scope: application-reported/);
  assert.match(text, /Result: VALID/);
});

test("CLI emits canonical JSON and leaves observation file unchanged", () => {
  const filename = tempJson(observation("container"));
  const before = fs.readFileSync(filename, "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", filename, "--json"]), 0); }
  finally { console.log = originalLog; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.valid, true);
  assert.equal(parsed.evidence.metadata.collector.identityScope, "container");
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed invalid missing and unknown input", () => {
  const malformed = tempJson("{");
  const invalid = tempJson({ version: 1 });
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--file", invalid]), 1);
  assert.equal(main(["--file", "/tmp/missing-runtime-collector-observation.json"]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  fs.rmSync(invalid, { force: true });
});

test("adapter stays offline read only and delegates canonical validation", () => {
  const source = fs.readFileSync(new URL("../scripts/runtime-collector-adapter.js", import.meta.url), "utf8");
  assert.match(source, /validateRuntimeEvidence/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|https?:\/\/|process\.env|writeFile|rmSync|unlinkSync/);
});
