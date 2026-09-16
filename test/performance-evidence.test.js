import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatPerformanceEvidence,
  main,
  validatePerformanceEvidence,
} from "../scripts/performance-evidence.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

/** @returns {any} */
function rawEvidence() {
  return {
    version: 1,
    artifact: { commit: COMMIT, totalBytes: 500000, jsBytes: 300000, cssBytes: 100000 },
    source: { name: "lighthouse-ci", authenticated: false, collectedAt: "2026-09-16T19:30:00Z" },
    routes: [
      { id: "homepage", lcpMs: 1800, cls: 0.04, inpMs: 120 },
      { id: "booking", lcpMs: 2200, cls: 0.08 },
    ],
  };
}

/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const filename = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("valid evidence normalizes commit and route ordering", () => {
  const raw = rawEvidence();
  raw.artifact.commit = COMMIT.toUpperCase();
  raw.routes.reverse();
  const result = validatePerformanceEvidence(raw);
  assert.equal(result.ok, true);
  if (!result.ok || !result.evidence) return;
  assert.equal(result.evidence.artifact.commit, COMMIT);
  assert.deepEqual(result.evidence.routes.map((route) => route.id), ["booking", "homepage"]);
  assert.match(formatPerformanceEvidence(result.evidence), /Result: VALID/);
});

test("bundle byte counts are bounded and internally consistent", () => {
  const inconsistent = rawEvidence(); inconsistent.artifact.totalBytes = 100; inconsistent.artifact.jsBytes = 80; inconsistent.artifact.cssBytes = 40;
  assert.equal(validatePerformanceEvidence(inconsistent).ok, false);
  const negative = rawEvidence(); negative.artifact.jsBytes = -1;
  assert.equal(validatePerformanceEvidence(negative).ok, false);
});

test("route metrics are optional individually but at least one is required", () => {
  const partial = rawEvidence(); partial.routes = [{ id: "home", lcpMs: 1200 }];
  assert.equal(validatePerformanceEvidence(partial).ok, true);
  const empty = rawEvidence(); empty.routes = [{ id: "home" }];
  assert.equal(validatePerformanceEvidence(empty).ok, false);
});

test("route metric bounds and duplicate ids fail closed", () => {
  const badCls = rawEvidence(); badCls.routes[0].cls = -0.1;
  assert.equal(validatePerformanceEvidence(badCls).ok, false);
  const duplicate = rawEvidence(); duplicate.routes[1].id = "homepage";
  assert.equal(validatePerformanceEvidence(duplicate).ok, false);
});

test("trust metadata is explicit and unknown fields are rejected", () => {
  const badTime = rawEvidence(); badTime.source.collectedAt = "today";
  assert.equal(validatePerformanceEvidence(badTime).ok, false);
  const unknown = rawEvidence(); unknown.routes[0].url = "https://example.com/";
  assert.equal(validatePerformanceEvidence(unknown).ok, false);
});

test("CLI validates evidence and leaves source file unchanged", () => {
  const filename = tempJson("performance", rawEvidence());
  const before = fs.readFileSync(filename, "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", filename, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).artifact.commit, COMMIT);
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed missing invalid and unknown input", () => {
  const malformed = tempJson("performance-bad", "{");
  const invalid = tempJson("performance-invalid", { version: 1 });
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--file", invalid]), 1);
  assert.equal(main(["--file", "/tmp/missing-performance-evidence.json"]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  fs.rmSync(invalid, { force: true });
});

test("performance evidence validator stays offline and read only", () => {
  const source = fs.readFileSync(new URL("../scripts/performance-evidence.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.env|node:child_process|spawnSync|execFile|\bfetch\s*\(|https?:\/\/|writeFile/);
  assert.match(source, /isFullObjectId/);
  assert.match(source, /isAbsoluteIsoTimestamp/);
});
