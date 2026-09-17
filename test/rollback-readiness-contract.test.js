import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatRollbackReadinessContract, main, validateRollbackReadinessContract } from "../scripts/rollback-readiness-contract.js";

/** @returns {any} */
function noneContract() {
  return { version: 1, rollback: { runbookPath: "docs/rollback.md", command: "bun run deploy:rollback" }, migration: { mode: "NONE", compatibility: "NOT_APPLICABLE" } };
}
/** @returns {any} */
function checkContract() {
  return { version: 1, rollback: { runbookPath: "docs/rollback.md", command: "bun run deploy:rollback" }, migration: { mode: "CHECK", compatibility: "COMPATIBLE", roots: ["migrations"], appliedManifestPath: "evidence/applied-migrations.json" } };
}
/** @param {any} value */
function tempJson(value) { const file = path.join(os.tmpdir(), `rollback-contract-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("validates explicit rollback runbook command and no-migration mode", () => {
  const result = validateRollbackReadinessContract(noneContract());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.contract) return;
  assert.equal(result.contract.migration.mode, "NONE");
  assert.match(formatRollbackReadinessContract(result.contract), /Result: VALID/);
});

test("validates migration CHECK mode with explicit history and compatibility assessment", () => {
  const result = validateRollbackReadinessContract(checkContract());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.contract) return;
  assert.deepEqual(result.contract.migration.roots, ["migrations"]);
});

test("NONE mode rejects migration evidence fields and non-applicable mismatch", () => {
  const roots = noneContract(); roots.migration.roots = ["migrations"];
  assert.equal(validateRollbackReadinessContract(roots).valid, false);
  const compatibility = noneContract(); compatibility.migration.compatibility = "COMPATIBLE";
  assert.equal(validateRollbackReadinessContract(compatibility).valid, false);
});

test("CHECK mode rejects unsafe roots manifest and NOT_APPLICABLE compatibility", () => {
  const unsafe = checkContract(); unsafe.migration.roots = ["../migrations"];
  assert.equal(validateRollbackReadinessContract(unsafe).valid, false);
  const manifest = checkContract(); manifest.migration.appliedManifestPath = "/tmp/manifest.json";
  assert.equal(validateRollbackReadinessContract(manifest).valid, false);
  const compatibility = checkContract(); compatibility.migration.compatibility = "NOT_APPLICABLE";
  assert.equal(validateRollbackReadinessContract(compatibility).valid, false);
});

test("rollback command and runbook path are bounded single-line safe values", () => {
  const unsafePath = noneContract(); unsafePath.rollback.runbookPath = "../rollback.md";
  assert.equal(validateRollbackReadinessContract(unsafePath).valid, false);
  const multiline = noneContract(); multiline.rollback.command = "echo first\necho second";
  assert.equal(validateRollbackReadinessContract(multiline).valid, false);
});

test("unknown fields and duplicate migration roots fail closed", () => {
  const unknown = noneContract(); unknown.rollback.shell = "bash";
  assert.equal(validateRollbackReadinessContract(unknown).valid, false);
  const duplicate = checkContract(); duplicate.migration.roots = ["migrations", "migrations"];
  assert.equal(validateRollbackReadinessContract(duplicate).valid, false);
});

test("CLI emits canonical JSON without changing source contract", () => {
  const file = tempJson(checkContract()), before = fs.readFileSync(file, "utf8");
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", file, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).migration.mode, "CHECK");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.rmSync(file, { force: true });
});

test("CLI rejects malformed and unknown input and validator remains offline read only", () => {
  const malformed = tempJson("{");
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  const source = fs.readFileSync(new URL("../scripts/rollback-readiness-contract.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
