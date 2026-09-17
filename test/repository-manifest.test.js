import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatRepositoryManifest,
  main,
  validateRepositoryManifest,
} from "../scripts/repository-manifest.js";

/** @returns {any} */
function manifest() {
  return {
    version: 1,
    repository: { id: "example-webapp" },
    profile: "webapp",
    runtime: { type: "cloudflare-worker", provider: "cloudflare" },
    database: { type: "postgres", provider: "supabase" },
    capabilities: ["payments", "bookings"],
    checks: {
      required: ["deployment-evidence", "migration-safety", "e2e"],
      advisory: ["accessibility", "performance"],
    },
  };
}

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(
    os.tmpdir(),
    `repository-manifest-${process.pid}-${Math.random().toString(16).slice(2)}.json`,
  );
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("validates and canonicalizes an explicit repository manifest", () => {
  const raw = manifest();
  raw.capabilities.reverse();
  raw.checks.required.reverse();
  const result = validateRepositoryManifest(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.manifest) return;
  assert.deepEqual(result.manifest.capabilities, ["bookings", "payments"]);
  assert.deepEqual(result.manifest.checks.required, [
    "deployment-evidence",
    "e2e",
    "migration-safety",
  ]);
  assert.ok(result.manifest.runtime);
  assert.equal(result.manifest.runtime.provider, "cloudflare");
  assert.match(formatRepositoryManifest(result.manifest), /Result: VALID/);
});

test("runtime and database declarations are explicit and may intentionally be null", () => {
  const raw = manifest();
  raw.runtime = null;
  raw.database = null;
  raw.capabilities = [];
  const result = validateRepositoryManifest(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.manifest) return;
  assert.equal(result.manifest.runtime, null);
  assert.equal(result.manifest.database, null);
  assert.deepEqual(result.manifest.capabilities, []);
});

test("omitted runtime or database is invalid rather than inferred", () => {
  const noRuntime = manifest();
  delete noRuntime.runtime;
  const noDatabase = manifest();
  delete noDatabase.database;
  assert.equal(validateRepositoryManifest(noRuntime).valid, false);
  assert.equal(validateRepositoryManifest(noDatabase).valid, false);
});

test("profile capability and check identifiers stay portable", () => {
  const badProfile = manifest();
  badProfile.profile = "profile with spaces";
  const badCapability = manifest();
  badCapability.capabilities = ["payments", "bad capability"];
  const badCheck = manifest();  badCheck.checks.required = ["migration safety"];
  assert.equal(validateRepositoryManifest(badProfile).valid, false);
  assert.equal(validateRepositoryManifest(badCapability).valid, false);
  assert.equal(validateRepositoryManifest(badCheck).valid, false);
});

test("runtime and database provider are optional portable declarations", () => {
  const raw = manifest();
  raw.runtime = { type: "node-service" };
  raw.database = { type: "postgres" };
  const result = validateRepositoryManifest(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.manifest) return;
  assert.deepEqual(result.manifest.runtime, { type: "node-service" });
  assert.deepEqual(result.manifest.database, { type: "postgres" });
});

test("required checks cannot be empty and advisory checks may be empty", () => {
  const emptyRequired = manifest();
  emptyRequired.checks.required = [];
  assert.equal(validateRepositoryManifest(emptyRequired).valid, false);
  const emptyAdvisory = manifest();
  emptyAdvisory.checks.advisory = [];
  assert.equal(validateRepositoryManifest(emptyAdvisory).valid, true);
});

test("required and advisory check sets cannot overlap", () => {
  const raw = manifest();
  raw.checks.advisory.push("e2e");  const result = validateRepositoryManifest(raw);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((item) => item.id === "check-severity-overlap"), true);
});

test("duplicate capabilities checks and unsupported fields fail closed", () => {
  const duplicateCapability = manifest();
  duplicateCapability.capabilities.push("payments");
  const duplicateCheck = manifest();
  duplicateCheck.checks.required.push("e2e");
  const unknown = manifest();
  unknown.organizationPolicy = "private";
  assert.equal(validateRepositoryManifest(duplicateCapability).valid, false);
  assert.equal(validateRepositoryManifest(duplicateCheck).valid, false);
  assert.equal(validateRepositoryManifest(unknown).valid, false);
});

test("repository runtime and database declarations reject malformed fields", () => {
  const repository = manifest();
  repository.repository.id = "invalid repo id";
  const runtime = manifest();
  runtime.runtime = { provider: "cloudflare" };
  const database = manifest();
  database.database = { type: "postgres", provider: "provider with spaces" };
  assert.equal(validateRepositoryManifest(repository).valid, false);
  assert.equal(validateRepositoryManifest(runtime).valid, false);
  assert.equal(validateRepositoryManifest(database).valid, false);
});

test("CLI emits stable canonical JSON and never mutates the input file", () => {  const filename = tempJson(manifest());
  const before = fs.readFileSync(filename, "utf8");
  const original = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", filename, "--json"]), 0); }
  finally { console.log = original; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.repository.id, "example-webapp");
  assert.deepEqual(parsed.capabilities, ["bookings", "payments"]);
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed missing and unknown input", () => {
  const malformed = tempJson("{");
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--file", "/tmp/missing-repository-manifest.json"]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("manifest validator remains offline and repository-content agnostic", () => {
  const source = fs.readFileSync(
    new URL("../scripts/repository-manifest.js", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(/);
  assert.doesNotMatch(source, /process\.env|readdirSync|statSync|lstatSync|writeFile/);
});