import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUILTIN_POLICY_PACK_REGISTRY,
  BUILTIN_POLICY_PACKS,
  formatManifestPolicyPack,
  inspectManifestPolicyPack,
  main,
  validatePolicyPackRegistry,
} from "../scripts/policy-packs.js";
import { validateRepositoryManifest } from "../scripts/repository-manifest.js";

/** @param {string} profile @param {string[]} [capabilities] @param {boolean} [database] */
function manifest(profile, capabilities = [], database = false) {
  const raw = {
    version: 1,
    repository: { id: "example-project" },
    profile,
    runtime: { type: "node-service" },
    database: database ? { type: "postgres" } : null,
    capabilities,
    checks: { required: ["custom-project-check"], advisory: ["custom-project-advisory"] },
  };
  const result = validateRepositoryManifest(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.manifest) throw new Error("manifest fixture invalid");
  return result.manifest;
}

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(
    os.tmpdir(),
    `policy-pack-${process.pid}-${Math.random().toString(16).slice(2)}.json`,
  );
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("built-in policy pack registry validates deterministically", () => {
  const result = validatePolicyPackRegistry(BUILTIN_POLICY_PACK_REGISTRY);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(
    BUILTIN_POLICY_PACKS.packs.map((pack) => pack.id),
    [
      "booking-service",
      "bot",
      "database-backed-webapp",
      "database-service",
      "payment-service",
      "python-service",
      "service",
      "webapp",
      "worker",
    ],
  );
});

test("webapp inherits service baseline and keeps frontend checks advisory", () => {
  const report = inspectManifestPolicyPack(manifest("webapp"), BUILTIN_POLICY_PACKS);  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.lineage, ["service", "webapp"]);
  assert.equal(report.effective?.required.includes("public-safety"), true);
  assert.equal(report.effective?.required.includes("custom-project-check"), true);
  assert.equal(report.effective?.advisory.includes("accessibility"), true);
  assert.equal(report.effective?.advisory.includes("seo"), true);
});

test("database-backed webapp requires an explicit database declaration", () => {
  const missing = inspectManifestPolicyPack(
    manifest("database-backed-webapp"),
    BUILTIN_POLICY_PACKS,
  );
  assert.equal(missing.overallStatus, "FAIL");
  assert.equal(
    missing.checks.some((item) => item.id === "database-requirement" && item.status === "FAIL"),
    true,
  );
  const present = inspectManifestPolicyPack(
    manifest("database-backed-webapp", [], true),
    BUILTIN_POLICY_PACKS,
  );
  assert.equal(present.overallStatus, "PASS");
  assert.equal(present.effective?.required.includes("migration-safety"), true);
  assert.equal(present.effective?.required.includes("schema-drift"), true);
});

test("payment service requires explicit payments capability and database", () => {
  const missing = inspectManifestPolicyPack(
    manifest("payment-service", [], true),
    BUILTIN_POLICY_PACKS,
  );
  assert.equal(missing.overallStatus, "FAIL");  assert.equal(
    missing.checks.some((item) => item.id === "capability-requirements" && item.status === "FAIL"),
    true,
  );
  const present = inspectManifestPolicyPack(
    manifest("payment-service", ["payments"], true),
    BUILTIN_POLICY_PACKS,
  );
  assert.equal(present.overallStatus, "PASS");
  assert.equal(present.effective?.required.includes("payment-integrity"), true);
  assert.equal(present.effective?.required.includes("webhook-safety"), true);
  assert.equal(present.effective?.required.includes("rollback-readiness"), true);
});

test("booking service requires explicit bookings capability", () => {
  const missing = inspectManifestPolicyPack(
    manifest("booking-service", [], true),
    BUILTIN_POLICY_PACKS,
  );
  assert.equal(missing.overallStatus, "FAIL");
  const present = inspectManifestPolicyPack(
    manifest("booking-service", ["bookings"], true),
    BUILTIN_POLICY_PACKS,
  );
  assert.equal(present.overallStatus, "PASS");
  assert.equal(present.effective?.required.includes("booking-integrity"), true);
});

test("manifest cannot downgrade a policy-pack required check to advisory", () => {
  const project = manifest("webapp");
  project.checks.advisory.push("public-safety");
  project.checks.advisory.sort();
  const report = inspectManifestPolicyPack(project, BUILTIN_POLICY_PACKS);  assert.equal(report.overallStatus, "FAIL");
  assert.equal(
    report.checks.some((item) => item.id === "required-check-monotonicity" && item.status === "FAIL"),
    true,
  );
});

test("manifest may promote pack advisory checks to required without duplication", () => {
  const project = manifest("webapp");
  project.checks.required.push("accessibility");
  project.checks.required.sort();
  const report = inspectManifestPolicyPack(project, BUILTIN_POLICY_PACKS);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.effective?.required.includes("accessibility"), true);
  assert.equal(report.effective?.advisory.includes("accessibility"), false);
});

test("manifest-specific required and advisory checks compose with pack baseline", () => {
  const report = inspectManifestPolicyPack(manifest("python-service"), BUILTIN_POLICY_PACKS);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.effective?.required.includes("custom-project-check"), true);
  assert.equal(report.effective?.advisory.includes("custom-project-advisory"), true);
  assert.deepEqual(report.lineage, ["service", "python-service"]);
});

test("worker and bot resolve through service without inventing scheduler requirement", () => {
  for (const profile of ["worker", "bot"]) {
    const report = inspectManifestPolicyPack(manifest(profile), BUILTIN_POLICY_PACKS);
    assert.equal(report.overallStatus, "PASS");
    assert.equal(report.effective?.advisory.includes("job-scheduler"), true);
    assert.equal(report.effective?.required.includes("job-scheduler"), false);
  }
});

test("unknown manifest profile fails without falling back to heuristic detection", () => {
  const report = inspectManifestPolicyPack(manifest("custom-private-profile"), BUILTIN_POLICY_PACKS);
  assert.equal(report.overallStatus, "FAIL");
  assert.deepEqual(report.lineage, []);
  assert.equal(report.effective, null);
});

test("registry validation rejects duplicate packs missing parents and inheritance cycles", () => {
  const duplicate = /** @type {any} */ (structuredClone(BUILTIN_POLICY_PACK_REGISTRY));
  duplicate.packs.push(structuredClone(duplicate.packs[0]));
  assert.equal(validatePolicyPackRegistry(duplicate).valid, false);

  const missingParent = /** @type {any} */ (structuredClone(BUILTIN_POLICY_PACK_REGISTRY));
  missingParent.packs[0].extends = "missing-parent";
  assert.equal(validatePolicyPackRegistry(missingParent).valid, false);

  const cycle = {
    version: 1,
    packs: [
      { id: "a", extends: "b", requires: { runtime: false, database: false, capabilities: [] }, checks: { required: ["one"], advisory: [] } },
      { id: "b", extends: "a", requires: { runtime: false, database: false, capabilities: [] }, checks: { required: ["two"], advisory: [] } },
    ],
  };
  assert.equal(validatePolicyPackRegistry(cycle).valid, false);
});

test("registry validation rejects local required/advisory overlap and malformed requirements", () => {
  const overlap = /** @type {any} */ (structuredClone(BUILTIN_POLICY_PACK_REGISTRY));
  overlap.packs[0].checks.advisory.push(overlap.packs[0].checks.required[0]);
  assert.equal(validatePolicyPackRegistry(overlap).valid, false);
  const malformed = /** @type {any} */ (structuredClone(BUILTIN_POLICY_PACK_REGISTRY));
  malformed.packs[0].requires.runtime = "yes";
  assert.equal(validatePolicyPackRegistry(malformed).valid, false);
});

test("human output exposes effective policy without private repository data", () => {
  const report = inspectManifestPolicyPack(
    manifest("payment-service", ["payments"], true),
    BUILTIN_POLICY_PACKS,
  );
  const text = formatManifestPolicyPack(report);
  assert.match(text, /service -> database-service -> payment-service/);
  assert.match(text, /payment-integrity/);
  assert.match(text, /Overall: PASS/);
});

test("CLI resolves a validated manifest into deterministic effective policy JSON", () => {
  const raw = {
    version: 1,
    repository: { id: "payments-api" },
    profile: "payment-service",
    runtime: { type: "node-service" },
    database: { type: "postgres" },
    capabilities: ["payments"],
    checks: { required: ["custom-release-gate"], advisory: [] },
  };
  const file = tempJson(raw);
  const original = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--manifest-file", file, "--json"]), 0); }
  finally { console.log = original; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.overallStatus, "PASS");
  assert.equal(parsed.effective.required.includes("payment-integrity"), true);
  assert.equal(parsed.effective.required.includes("custom-release-gate"), true);
  fs.rmSync(file, { force: true });
});

test("CLI rejects malformed invalid and unknown input", () => {
  const malformed = tempJson("{");
  const invalid = tempJson({ version: 1 });
  assert.equal(main(["--manifest-file", malformed]), 1);
  assert.equal(main(["--manifest-file", invalid]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  fs.rmSync(invalid, { force: true });
});

test("policy-pack resolver is offline read only and delegates canonical manifest validation", () => {
  const source = fs.readFileSync(
    new URL("../scripts/policy-packs.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /validateRepositoryManifest/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(/);
  assert.doesNotMatch(source, /process\.env|https?:\/\/|writeFile/);
});