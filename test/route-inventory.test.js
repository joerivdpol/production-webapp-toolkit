import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatRouteInventory, main, validateRouteInventory } from "../scripts/route-inventory.js";

/** @returns {any} */
function rawInventory() {
  return {
    version: 1,
    repository: "example-webapp",
    routes: [
      { id: "admin-users", path: "/admin/users", methods: ["GET"], auth: { mode: "policy", policy: "admin" }, testFiles: ["test/admin-users.test.js"], smokeProbes: ["admin-users-page"] },
      { id: "homepage", path: "/", methods: ["GET", "HEAD"], auth: { mode: "public" }, testFiles: ["test/home.test.js"], smokeProbes: ["homepage"] },
    ],
  };
}

/** @param {any} value */
function tempJson(value) { const file = path.join(os.tmpdir(), `route-inventory-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("validates and deterministically normalizes explicit route inventory", () => {
  const raw = rawInventory(); raw.routes.reverse(); raw.routes[0].methods = ["head", "get"];
  const result = validateRouteInventory(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.inventory) return;
  assert.deepEqual(result.inventory.routes.map((item) => item.id), ["admin-users", "homepage"]);
  assert.deepEqual(result.inventory.routes[1].methods, ["GET", "HEAD"]);
  assert.match(formatRouteInventory(result.inventory), /implementation correctness is not asserted/);
});

test("auth classification is mandatory and public routes cannot carry policy ids", () => {
  const missing = rawInventory(); delete missing.routes[0].auth;
  assert.equal(validateRouteInventory(missing).valid, false);
  const publicPolicy = rawInventory(); publicPolicy.routes[1].auth = { mode: "public", policy: "admin" };
  assert.equal(validateRouteInventory(publicPolicy).valid, false);
  const policyMissing = rawInventory(); policyMissing.routes[0].auth = { mode: "policy" };
  assert.equal(validateRouteInventory(policyMissing).valid, false);
});

test("rejects duplicate ids and overlapping path-method operations", () => {
  const duplicateId = rawInventory(); duplicateId.routes[1].id = "admin-users";
  assert.equal(validateRouteInventory(duplicateId).valid, false);
  const duplicateOperation = rawInventory(); duplicateOperation.routes.push({ id: "admin-alias", path: "/admin/users", methods: ["GET"], auth: { mode: "policy", policy: "admin" }, testFiles: [], smokeProbes: [] });
  const result = validateRouteInventory(duplicateOperation);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((item) => item.id === "route-operation-duplicate"), true);
});

test("route paths methods test files and smoke ids are bounded and explicit", () => {
  const query = rawInventory(); query.routes[0].path = "/admin/users?all=1";
  assert.equal(validateRouteInventory(query).valid, false);
  const method = rawInventory(); method.routes[0].methods = ["GET", " get "];
  assert.equal(validateRouteInventory(method).valid, false);
  const traversal = rawInventory(); traversal.routes[0].testFiles = ["../outside.test.js"];
  assert.equal(validateRouteInventory(traversal).valid, false);
  const smoke = rawInventory(); smoke.routes[0].smokeProbes = ["bad probe"];
  assert.equal(validateRouteInventory(smoke).valid, false);
});

test("unknown fields and ambiguous repository identities fail closed", () => {
  const unknown = rawInventory(); unknown.routes[0].role = "admin";
  assert.equal(validateRouteInventory(unknown).valid, false);
  const repo = rawInventory(); repo.repository = "../private";
  assert.equal(validateRouteInventory(repo).valid, false);
});

test("CLI emits normalized JSON and leaves input unchanged", () => {
  const file = tempJson(rawInventory()), before = fs.readFileSync(file, "utf8");
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", file, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).repository, "example-webapp");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.rmSync(file, { force: true });
});

test("CLI rejects malformed missing and unknown input", () => {
  const malformed = tempJson("{");
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--file", "/tmp/missing-route-inventory.json"]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("route inventory validator stays offline and read only", () => {
  const source = fs.readFileSync(new URL("../scripts/route-inventory.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
