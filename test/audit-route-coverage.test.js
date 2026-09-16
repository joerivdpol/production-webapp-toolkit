import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatRouteCoverage, inspectRouteCoverage, main, validateRouteCoveragePolicy } from "../scripts/audit-route-coverage.js";
import { validateRouteInventory } from "../scripts/route-inventory.js";
import { validateSyntheticSmokePolicy } from "../scripts/run-synthetic-smoke-tests.js";

/** @returns {any} */
function inventoryRaw() { return { version: 1, repository: "example-webapp", routes: [
  { id: "admin-users", path: "/admin/users", methods: ["GET"], auth: { mode: "policy", policy: "admin" }, testFiles: ["test/admin-users.test.js"], smokeProbes: ["admin-users-page"] },
  { id: "homepage", path: "/", methods: ["GET"], auth: { mode: "public" }, testFiles: ["test/home.test.js"], smokeProbes: ["homepage"] },
] }; }
/** @returns {any} */
function policyRaw() { return { version: 1, requireRulesForAllRoutes: true, rules: [
  { routeId: "admin-users", expectedPath: "/admin/users", requiredMethods: ["GET"], allowedAuthModes: ["policy"], allowedAuthPolicies: ["admin"], minTestFiles: 1, minSmokeProbes: 1 },
  { routeId: "homepage", expectedPath: "/", requiredMethods: ["GET"], allowedAuthModes: ["public"], allowedAuthPolicies: [], minTestFiles: 1, minSmokeProbes: 1 },
] }; }
/** @returns {any} */
function smokeRaw() { return { version: 1, suite: "routes", probes: [
  { id: "admin-users-page", url: "https://example.com/admin/users", method: "GET", expectedStatuses: [200], timeoutMs: 5000, response: { mode: "status-only", requiredKeys: [], maxBytes: 1024 } },
  { id: "homepage", url: "https://example.com/", method: "GET", expectedStatuses: [200], timeoutMs: 5000, response: { mode: "status-only", requiredKeys: [], maxBytes: 1024 } },
] }; }
function inventory(raw = inventoryRaw()) { const result = validateRouteInventory(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.inventory) throw new Error("inventory fixture invalid"); return result.inventory; }
function policy(raw = policyRaw()) { const result = validateRouteCoveragePolicy(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("policy fixture invalid"); return result.policy; }
function smoke(raw = smokeRaw()) { const result = validateSyntheticSmokePolicy(raw); assert.equal(result.ok, true, result.error ?? "smoke invalid"); if (!result.ok || !result.policy) throw new Error("smoke fixture invalid"); return result.policy; }
function repository() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "route-coverage-")); fs.mkdirSync(path.join(root, "test")); fs.writeFileSync(path.join(root, "test/admin-users.test.js"), "// synthetic\n"); fs.writeFileSync(path.join(root, "test/home.test.js"), "// synthetic\n"); return root; }
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("validates explicit route coverage policy and normalizes HTTP methods", () => {
  const raw = policyRaw(); raw.rules[0].requiredMethods = ["get"];
  const result = validateRouteCoveragePolicy(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) return;
  assert.deepEqual(result.policy.rules[0].requiredMethods, ["GET"]);
});

test("policy rejects duplicate routes invalid auth combinations and unbounded minimums", () => {
  const duplicate = policyRaw(); duplicate.rules[1].routeId = "admin-users";
  assert.equal(validateRouteCoveragePolicy(duplicate).valid, false);
  const auth = policyRaw(); auth.rules[1].allowedAuthPolicies = ["admin"];
  assert.equal(validateRouteCoveragePolicy(auth).valid, false);
  const minimum = policyRaw(); minimum.rules[0].minTestFiles = 65;
  assert.equal(validateRouteCoveragePolicy(minimum).valid, false);
});

test("complete explicit route bindings pass without claiming implementation truth", () => {
  const root = repository();
  const report = inspectRouteCoverage(inventory(), policy(), { root, smokePolicy: smoke() });
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.summary.pass, 2);
  assert.match(report.semantics.auth, /implementation correctness/);
  assert.match(report.semantics.tests, /CI evidence/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing required route path or method is blocking", () => {
  const root = repository();
  const missingRoute = policyRaw(); missingRoute.rules[0].routeId = "admin-missing";
  assert.equal(inspectRouteCoverage(inventory(), policy(missingRoute), { root, smokePolicy: smoke() }).checks.some((item) => item.id === "route-missing"), true);
  const wrongPath = policyRaw(); wrongPath.rules[0].expectedPath = "/admin/other";
  assert.equal(inspectRouteCoverage(inventory(), policy(wrongPath), { root, smokePolicy: smoke() }).checks.some((item) => item.id === "route-path-mismatch"), true);
  const method = policyRaw(); method.rules[0].requiredMethods = ["POST"];
  assert.equal(inspectRouteCoverage(inventory(), policy(method), { root, smokePolicy: smoke() }).checks.some((item) => item.id === "route-method-missing"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("auth coverage checks declaration binding only and supports private policy ids", () => {
  const root = repository();
  const disallowed = policyRaw(); disallowed.rules[0].allowedAuthModes = ["public"]; disallowed.rules[0].allowedAuthPolicies = [];
  assert.equal(inspectRouteCoverage(inventory(), policy(disallowed), { root, smokePolicy: smoke() }).checks.some((item) => item.id === "route-auth-mode-disallowed"), true);
  const wrongPolicy = policyRaw(); wrongPolicy.rules[0].allowedAuthPolicies = ["super-admin"];
  assert.equal(inspectRouteCoverage(inventory(), policy(wrongPolicy), { root, smokePolicy: smoke() }).checks.some((item) => item.id === "route-auth-policy-disallowed"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("test coverage requires regular non-symlink bound files and configured minimum", () => {
  const root = repository();
  fs.rmSync(path.join(root, "test/admin-users.test.js"));
  fs.symlinkSync("/etc/passwd", path.join(root, "test/admin-users.test.js"));
  const report = inspectRouteCoverage(inventory(), policy(), { root, smokePolicy: smoke() });
  assert.equal(report.checks.some((item) => item.id === "route-test-file-missing" && item.routeId === "admin-users"), true);
  assert.equal(report.checks.some((item) => item.id === "route-test-coverage-insufficient" && item.routeId === "admin-users"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("smoke coverage requires validated policy and resolves bound probe ids", () => {
  const root = repository();
  const noSmoke = inspectRouteCoverage(inventory(), policy(), { root, smokePolicy: null });
  assert.equal(noSmoke.checks.some((item) => item.id === "smoke-policy-required"), true);
  const incomplete = smokeRaw(); incomplete.probes = [incomplete.probes[1]];
  const report = inspectRouteCoverage(inventory(), policy(), { root, smokePolicy: smoke(incomplete) });
  assert.equal(report.checks.some((item) => item.id === "route-smoke-probe-missing" && item.routeId === "admin-users"), true);
  assert.equal(report.checks.some((item) => item.id === "route-smoke-coverage-insufficient" && item.routeId === "admin-users"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("requireRulesForAllRoutes prevents silent policy omission", () => {
  const root = repository();
  const raw = policyRaw(); raw.rules = [raw.rules[0]];
  const report = inspectRouteCoverage(inventory(), policy(raw), { root, smokePolicy: smoke() });
  assert.equal(report.checks.some((item) => item.id === "route-policy-missing" && item.routeId === "homepage"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("rules may deliberately make smoke optional without pretending smoke coverage", () => {
  const root = repository();
  const raw = policyRaw(); for (const rule of raw.rules) rule.minSmokeProbes = 0;
  const report = inspectRouteCoverage(inventory(), policy(raw), { root, smokePolicy: null });
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.smokePolicyConfigured, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("human output states evidence boundaries and never reads test contents", () => {
  const root = repository(); fs.writeFileSync(path.join(root, "test/home.test.js"), "SUPER_SECRET_TEST_PAYLOAD");
  const output = formatRouteCoverage(inspectRouteCoverage(inventory(), policy(), { root, smokePolicy: smoke() }));
  assert.match(output, /declaration binding only/);
  assert.match(output, /bound-file presence only/);
  assert.doesNotMatch(output, /SUPER_SECRET_TEST_PAYLOAD/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI composes route inventory policy test bindings and synthetic smoke policy", () => {
  const root = repository(), inventoryFile = tempJson("routes", inventoryRaw()), policyFile = tempJson("route-policy", policyRaw()), smokeFile = tempJson("smoke", smokeRaw());
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--inventory", inventoryFile, "--policy", policyFile, "--smoke-policy", smokeFile, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  fs.rmSync(path.join(root, "test/home.test.js"));
  assert.equal(main(["--root", root, "--inventory", inventoryFile, "--policy", policyFile, "--smoke-policy", smokeFile]), 1);
  fs.rmSync(root, { recursive: true, force: true }); for (const file of [inventoryFile, policyFile, smokeFile]) fs.rmSync(file, { force: true });
});

test("CLI rejects malformed smoke or route inputs", () => {
  const root = repository(), bad = tempJson("bad-route", "{");
  assert.equal(main(["--root", root, "--inventory", bad, "--policy", bad]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(bad, { force: true });
});

test("route coverage core is local read only and delegates canonical validators", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-route-coverage.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /validateRouteInventory/);
  assert.match(source, /validateSyntheticSmokePolicy/);
});
