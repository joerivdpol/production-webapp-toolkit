import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatSeverityPolicy,
  main,
  resolveSeverityPolicy,
  validateSeverityPolicy,
} from "../scripts/severity-policy.js";

function base() {
  return { required: ["public-safety", "repository-quality"], advisory: ["seo", "performance"] };
}
/** @returns {any} */
function policy() {
  return {
    version: 1,
    rules: [
      { check: "seo", requirement: "required", impacts: { warn: "FAIL", missing: "FAIL" } },
      { check: "performance", requirement: "advisory", impacts: { fail: "FAIL" } },
    ],
  };
}
/** @param {any} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `severity-policy-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("validates deterministic severity rules", () => {
  const raw = policy(); raw.rules.reverse();
  const result = validateSeverityPolicy(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) return;
  assert.deepEqual(result.policy.rules.map((rule) => rule.check), ["performance", "seo"]);
});

test("empty rules are a valid explicit no-op policy", () => {
  const result = validateSeverityPolicy({ version: 1, rules: [] });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("baseline severity preserves existing dashboard semantics", () => {
  const checked = validateSeverityPolicy({ version: 1, rules: [] });
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  const report = resolveSeverityPolicy(base(), checked.policy);
  const required = report.effective.checks.find((item) => item.id === "public-safety");
  const advisory = report.effective.checks.find((item) => item.id === "seo");
  assert.deepEqual(required?.impacts, { WARN: "WARN", FAIL: "FAIL", UNVERIFIED: "WARN", MISSING: "WARN" });
  assert.deepEqual(advisory?.impacts, { WARN: "WARN", FAIL: "WARN", UNVERIFIED: "WARN", MISSING: "WARN" });
  assert.equal(report.overallStatus, "PASS");
});

test("advisory check can be promoted to required and severity can be strengthened", () => {
  const checked = validateSeverityPolicy(policy());
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  const report = resolveSeverityPolicy(base(), checked.policy);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.effective.required.includes("seo"), true);
  const seo = report.effective.checks.find((item) => item.id === "seo");
  assert.deepEqual(seo?.impacts, { WARN: "FAIL", FAIL: "FAIL", UNVERIFIED: "WARN", MISSING: "FAIL" });
  const performance = report.effective.checks.find((item) => item.id === "performance");
  assert.equal(performance?.requirement, "advisory");
  assert.equal(performance?.impacts.FAIL, "FAIL");
});

test("new checks may be added explicitly as required or advisory", () => {
  const raw = { version: 1, rules: [{ check: "custom-control", requirement: "required", impacts: { missing: "FAIL" } }] };
  const checked = validateSeverityPolicy(raw);
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  const report = resolveSeverityPolicy(base(), checked.policy);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.effective.required.includes("custom-control"), true);
  assert.equal(report.effective.checks.find((item) => item.id === "custom-control")?.impacts.MISSING, "FAIL");
});

test("required check cannot be downgraded to advisory", () => {
  const checked = validateSeverityPolicy({ version: 1, rules: [{ check: "public-safety", requirement: "advisory", impacts: {} }] });
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  const report = resolveSeverityPolicy(base(), checked.policy);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.effective.required.includes("public-safety"), true);
  assert.equal(report.validations.some((item) => item.id === "requirement-weakening" && item.status === "FAIL"), true);
});

test("required FAIL impact cannot be weakened to WARN", () => {
  const checked = validateSeverityPolicy({ version: 1, rules: [{ check: "public-safety", requirement: "required", impacts: { fail: "WARN" } }] });
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  const report = resolveSeverityPolicy(base(), checked.policy);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.effective.checks.find((item) => item.id === "public-safety")?.impacts.FAIL, "FAIL");
  assert.equal(report.validations.some((item) => item.id === "severity-weakening"), true);
});

test("promotion to required establishes required baseline before severity override", () => {
  const checked = validateSeverityPolicy({ version: 1, rules: [{ check: "seo", requirement: "required", impacts: { fail: "WARN" } }] });
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  const report = resolveSeverityPolicy(base(), checked.policy);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.effective.checks.find((item) => item.id === "seo")?.impacts.FAIL, "FAIL");
});

test("advisory failure may explicitly become blocking without changing requirement label", () => {
  const checked = validateSeverityPolicy({ version: 1, rules: [{ check: "seo", requirement: "advisory", impacts: { fail: "FAIL" } }] });
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  const report = resolveSeverityPolicy(base(), checked.policy);
  assert.equal(report.overallStatus, "PASS");
  const seo = report.effective.checks.find((item) => item.id === "seo");
  assert.equal(seo?.requirement, "advisory");
  assert.equal(seo?.impacts.FAIL, "FAIL");
});

test("policy validator rejects duplicate rules malformed impacts and unknown fields", () => {
  const duplicate = policy(); duplicate.rules.push(structuredClone(duplicate.rules[0]));
  const malformed = policy(); malformed.rules[0].impacts.warn = "PASS";
  const unknown = policy(); unknown.rules[0].allowWeakening = true;
  assert.equal(validateSeverityPolicy(duplicate).valid, false);
  assert.equal(validateSeverityPolicy(malformed).valid, false);
  assert.equal(validateSeverityPolicy(unknown).valid, false);
});

test("human output exposes effective impacts and weakening conflicts", () => {
  const checked = validateSeverityPolicy({ version: 1, rules: [{ check: "public-safety", requirement: "advisory", impacts: {} }] });
  assert.equal(checked.valid, true);
  if (!checked.valid || !checked.policy) return;
  const text = formatSeverityPolicy(resolveSeverityPolicy(base(), checked.policy));
  assert.match(text, /requirement-weakening/);
  assert.match(text, /public-safety/);
  assert.match(text, /Overall: FAIL/);
});

test("CLI resolves severity over canonical repository manifest policy", () => {
  const manifestFile = tempJson({
    version: 1,
    repository: { id: "example-web" },
    profile: "webapp",
    runtime: { type: "node-service" },
    database: null,
    capabilities: [],
    checks: { required: ["custom-project-check"], advisory: [] },
  });
  const severityFile = tempJson({ version: 1, rules: [{ check: "seo", requirement: "required", impacts: { missing: "FAIL" } }] });
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--manifest-file", manifestFile, "--severity-policy-file", severityFile, "--json"]), 0); }
  finally { console.log = original; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.effective.required.includes("seo"), true);
  assert.equal(parsed.effective.checks.find((/** @type {any} */ item) => item.id === "seo").impacts.MISSING, "FAIL");
  fs.rmSync(manifestFile, { force: true }); fs.rmSync(severityFile, { force: true });
});

test("CLI exits nonzero on explicit weakening conflict", () => {
  const manifestFile = tempJson({
    version: 1,
    repository: { id: "example-web" },
    profile: "webapp",
    runtime: { type: "node-service" },
    database: null,
    capabilities: [],
    checks: { required: ["custom-project-check"], advisory: [] },
  });
  const severityFile = tempJson({ version: 1, rules: [{ check: "public-safety", requirement: "advisory", impacts: {} }] });
  assert.equal(main(["--manifest-file", manifestFile, "--severity-policy-file", severityFile]), 1);
  fs.rmSync(manifestFile, { force: true }); fs.rmSync(severityFile, { force: true });
});

test("CLI rejects malformed missing and unknown input", () => {
  const malformed = tempJson("{");
  assert.equal(main(["--manifest-file", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("severity engine remains offline read only and delegates canonical policy resolution", () => {
  const source = fs.readFileSync(new URL("../scripts/severity-policy.js", import.meta.url), "utf8");
  assert.match(source, /inspectManifestPolicyPack/);
  assert.match(source, /inspectOrganizationPolicy/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
