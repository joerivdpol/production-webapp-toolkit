import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatAuthorizationPolicy, inspectAuthorizationPolicy, main, validateAuthorizationPolicy } from "../scripts/audit-authorization-policy.js";
import { validateRouteInventory } from "../scripts/route-inventory.js";

/** @returns {any} */
function inventoryRaw() { return { version: 1, repository: "example-webapp", routes: [
  { id: "admin-users", path: "/admin/users", methods: ["GET"], auth: { mode: "policy", policy: "admin" }, testFiles: [], smokeProbes: [] },
  { id: "homepage", path: "/", methods: ["GET"], auth: { mode: "public" }, testFiles: [], smokeProbes: [] },
] }; }
/** @returns {any} */
function policyRaw() { return { version: 1, surfaces: [
  { id: "admin-users-route", kind: "admin-route", routeId: "admin-users", serverFiles: ["src/server/admin.ts"], guardFiles: ["src/server/admin.ts"], guardCallees: ["requireRole"], clientFiles: ["src/client/Admin.tsx"], clientAuthCallees: ["hasRole"] },
  { id: "account-api", kind: "server-endpoint", serverFiles: ["src/server/account.ts"], guardFiles: ["src/server/account.ts"], guardCallees: ["auth.authorize"], clientFiles: [], clientAuthCallees: [] },
] }; }
function inventory(raw = inventoryRaw()) { const result = validateRouteInventory(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.inventory) throw new Error("inventory invalid"); return result.inventory; }
function policy(raw = policyRaw()) { const result = validateAuthorizationPolicy(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("policy invalid"); return result.policy; }
/** @param {{admin?:string,account?:string,client?:string,middleware?:string}} [content] */
function repository(content = {}) { const root = fs.mkdtempSync(path.join(os.tmpdir(), "authorization-audit-")); fs.mkdirSync(path.join(root, "src/server"), { recursive: true }); fs.mkdirSync(path.join(root, "src/client"), { recursive: true }); fs.writeFileSync(path.join(root, "src/server/admin.ts"), content.admin ?? 'export function loader() { requireRole("admin"); return loadUsers(); }\n'); fs.writeFileSync(path.join(root, "src/server/account.ts"), content.account ?? 'export function action() { auth.authorize("account"); return getAccount(); }\n'); fs.writeFileSync(path.join(root, "src/client/Admin.tsx"), content.client ?? 'export function Admin() { if (!hasRole("admin")) return null; return <main />; }\n'); if (content.middleware !== undefined) fs.writeFileSync(path.join(root, "src/server/middleware.ts"), content.middleware); return root; }
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("validates explicit admin-route and server-endpoint authorization surfaces", () => {
  const result = validateAuthorizationPolicy(policyRaw());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) return;
  assert.deepEqual(result.policy.surfaces.map((item) => item.id), ["account-api", "admin-users-route"]);
});

test("policy rejects missing admin route bindings unsafe files and mismatched client config", () => {
  const route = policyRaw(); delete route.surfaces[0].routeId;
  assert.equal(validateAuthorizationPolicy(route).valid, false);
  const traversal = policyRaw(); traversal.surfaces[0].serverFiles = ["../admin.ts"];
  assert.equal(validateAuthorizationPolicy(traversal).valid, false);
  const extension = policyRaw(); extension.surfaces[0].guardFiles = ["src/server/admin.py"];
  assert.equal(validateAuthorizationPolicy(extension).valid, false);
  const client = policyRaw(); client.surfaces[0].clientAuthCallees = [];
  assert.equal(validateAuthorizationPolicy(client).valid, false);
});

test("policy rejects duplicate ids malformed callees and unknown fields", () => {
  const duplicate = policyRaw(); duplicate.surfaces[1].id = "admin-users-route";
  assert.equal(validateAuthorizationPolicy(duplicate).valid, false);
  const callee = policyRaw(); callee.surfaces[0].guardCallees = ["requireRole()"];
  assert.equal(validateAuthorizationPolicy(callee).valid, false);
  const unknown = policyRaw(); unknown.surfaces[0].roles = ["admin"];
  assert.equal(validateAuthorizationPolicy(unknown).valid, false);
});

test("guarded admin route and server endpoint pass with client defense in depth", () => {
  const root = repository();
  const report = inspectAuthorizationPolicy(root, policy(), inventory());
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks.some((item) => item.id === "authorization-guard-present" && item.surface === "admin-users-route"), true);
  assert.equal(report.checks.some((item) => item.id === "client-auth-defense-in-depth"), true);
  assert.match(report.semantics, /control-flow dominance.*not proven/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("guard names in comments and strings do not satisfy AST call evidence", () => {
  const root = repository({ admin: 'export function loader() { const note = "requireRole(\\"admin\\")"; /* requireRole("admin") */ return loadUsers(); }\n' });
  const report = inspectAuthorizationPolicy(root, policy(), inventory());
  assert.equal(report.checks.some((item) => item.id === "authorization-guard-missing" && item.surface === "admin-users-route"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("client authorization without server guard is reported explicitly as client-only", () => {
  const root = repository({ admin: 'export function loader() { return loadUsers(); }\n' });
  const report = inspectAuthorizationPolicy(root, policy(), inventory());
  assert.equal(report.checks.some((item) => item.id === "authorization-guard-missing" && item.surface === "admin-users-route"), true);
  assert.equal(report.checks.some((item) => item.id === "client-only-authorization" && item.surface === "admin-users-route"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("centralized middleware guard files are supported without requiring duplicate endpoint calls", () => {
  const root = repository({ admin: 'export function loader() { return loadUsers(); }\n', middleware: 'export function protect() { requireRole("admin"); }\n' });
  const raw = policyRaw(); raw.surfaces[0].guardFiles = ["src/server/middleware.ts"];
  const report = inspectAuthorizationPolicy(root, policy(raw), inventory());
  assert.equal(report.checks.some((item) => item.id === "authorization-guard-present" && item.surface === "admin-users-route"), true);
  assert.equal(report.overallStatus, "PASS");
  fs.rmSync(root, { recursive: true, force: true });
});

test("property-access guard callees match exactly rather than by substring", () => {
  const root = repository({ account: 'export function action() { auth.authorizeLater("account"); return getAccount(); }\n' });
  const report = inspectAuthorizationPolicy(root, policy(), inventory());
  assert.equal(report.checks.some((item) => item.id === "authorization-guard-missing" && item.surface === "account-api"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("admin route must exist and be policy-bound in Route Inventory v1", () => {
  const root = repository();
  const missing = inventoryRaw(); missing.routes = missing.routes.filter((/** @type {any} */ item) => item.id !== "admin-users");
  assert.equal(inspectAuthorizationPolicy(root, policy(), inventory(missing)).checks.some((item) => item.id === "admin-route-inventory-missing"), true);
  const publicRoute = inventoryRaw(); publicRoute.routes[0].auth = { mode: "public" };
  assert.equal(inspectAuthorizationPolicy(root, policy(), inventory(publicRoute)).checks.some((item) => item.id === "admin-route-not-policy-bound"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing symlinked oversized and syntactically invalid files fail closed", () => {
  const root = repository();
  fs.rmSync(path.join(root, "src/server/admin.ts"));
  fs.symlinkSync("/etc/passwd", path.join(root, "src/server/admin.ts"));
  let report = inspectAuthorizationPolicy(root, policy(), inventory());
  assert.equal(report.checks.some((item) => item.id === "server-file-uninspectable"), true);
  fs.rmSync(path.join(root, "src/server/admin.ts"));
  fs.writeFileSync(path.join(root, "src/server/admin.ts"), "export function broken( {");
  report = inspectAuthorizationPolicy(root, policy(), inventory());
  assert.equal(report.checks.some((item) => item.id === "guard-file-uninspectable"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("client files are observational and missing client evidence cannot be treated as server safety", () => {
  const root = repository(); fs.rmSync(path.join(root, "src/client/Admin.tsx"));
  const report = inspectAuthorizationPolicy(root, policy(), inventory());
  assert.equal(report.checks.some((item) => item.id === "client-file-uninspectable"), true);
  assert.equal(report.checks.some((item) => item.id === "authorization-guard-present" && item.surface === "admin-users-route"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("human report exposes structural findings without source payloads", () => {
  const secret = "UNIQUE_AUTH_SOURCE_PAYLOAD_451";
  const root = repository({ admin: `export function loader() { const secret = "${secret}"; return loadUsers(); }\n` });
  const output = formatAuthorizationPolicy(inspectAuthorizationPolicy(root, policy(), inventory()));
  assert.match(output, /authorization-guard-missing/);
  assert.doesNotMatch(output, new RegExp(secret));
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI emits JSON for PASS and returns blocking exit for unguarded surface", () => {
  const root = repository(), policyFile = tempJson("auth-policy", policyRaw()), inventoryFile = tempJson("auth-routes", inventoryRaw());
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", policyFile, "--route-inventory", inventoryFile, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  fs.writeFileSync(path.join(root, "src/server/account.ts"), "export function action() { return getAccount(); }\n");
  assert.equal(main(["--root", root, "--policy", policyFile, "--route-inventory", inventoryFile]), 1);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(policyFile, { force: true }); fs.rmSync(inventoryFile, { force: true });
});

test("CLI rejects malformed policy inventory missing repository and unknown options", () => {
  const malformed = tempJson("auth-bad", "{");
  assert.equal(main(["--root", "/tmp/missing-auth-repo", "--policy", malformed, "--route-inventory", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("authorization audit is local read only and uses TypeScript AST rather than raw regex truth", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-authorization-policy.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /ts\.isCallExpression/);
  assert.match(source, /validateRouteInventory/);
});
