import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatRollbackReadiness, inspectRollbackReadiness, main } from "../scripts/audit-rollback-readiness.js";
import { validateArtifactProvenance } from "../scripts/artifact-provenance.js";
import { validateChangeSurfaceEvidence } from "../scripts/change-surface-evidence.js";
import { validateRollbackReadinessContract } from "../scripts/rollback-readiness-contract.js";

const PREVIOUS_COMMIT = "1".repeat(40);
const CURRENT_COMMIT = "2".repeat(40);
const CURRENT_HASH = "c".repeat(64);
const COMMAND = "bun run deploy:rollback";

/** @param {string|Buffer} value */
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
/** @param {string} commit @param {string} hash @param {string} [target] @returns {any} */
function rawProvenance(commit, hash, target = "production") {
  return {
    version: 1,
    source: { commit },
    build: { ci: { provider: "github-actions", workflow: "release", runId: commit.slice(0, 8) }, artifact: { name: "app.tgz", sha256: hash } },
    deployment: { target, artifactSha256: hash, runtime: { name: "web", environment: "production" } },
    evidence: { source: "synthetic", authenticated: false, collectedAt: "2026-09-17T00:00:00Z" },
  };
}
/** @param {string[]} [surfaces] @returns {any} */
function rawChange(surfaces = ["frontend"]) {
  return { version: 1, source: { baseCommit: PREVIOUS_COMMIT, headCommit: CURRENT_COMMIT }, metrics: { filesChanged: 2, additions: 10, deletions: 2 }, surfaces, flags: { testsChanged: true, environmentChanged: false, majorDependencyUpgrade: false }, evidence: { source: "synthetic", authenticated: false, collectedAt: "2026-09-17T00:00:00Z" } };
}
/** @returns {any} */
function rawContractNone() { return { version: 1, rollback: { runbookPath: "docs/rollback.md", command: COMMAND }, migration: { mode: "NONE", compatibility: "NOT_APPLICABLE" } }; }
/** @param {"COMPATIBLE"|"INCOMPATIBLE"|"UNVERIFIED"} [compatibility] @returns {any} */
function rawContractCheck(compatibility = "COMPATIBLE") { return { version: 1, rollback: { runbookPath: "docs/rollback.md", command: COMMAND }, migration: { mode: "CHECK", compatibility, roots: ["migrations"], appliedManifestPath: "evidence/applied-migrations.json" } }; }
/** @param {any} raw */
function validatedProvenance(raw) { const result = validateArtifactProvenance(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.provenance) throw new Error("provenance fixture invalid"); return result.provenance; }
/** @param {any} [raw] */
function validatedChange(raw = rawChange()) { const result = validateChangeSurfaceEvidence(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.evidence) throw new Error("change fixture invalid"); return result.evidence; }
/** @param {any} [raw] */
function validatedContract(raw = rawContractNone()) { const result = validateRollbackReadinessContract(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.contract) throw new Error("contract fixture invalid"); return result.contract; }

/** @returns {string} */
function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rollback-readiness-"));
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/rollback.md"), `# Rollback\n\nRun: ${COMMAND}\n`);
  return root;
}
/** @param {string} root @param {string} contents */
/** @param {string} root @param {string} [contents] */
function artifact(root, contents = "previous release artifact") { const file = path.join(root, "previous-artifact.tgz"); fs.writeFileSync(file, contents); return { file, hash: sha256(contents) }; }
/** @param {string} root @param {string} sql */
function configureMigrations(root, sql) {
  fs.mkdirSync(path.join(root, "migrations"), { recursive: true });
  fs.mkdirSync(path.join(root, "evidence"), { recursive: true });
  fs.writeFileSync(path.join(root, "migrations/20260916010000_applied.sql"), "CREATE TABLE baseline(id bigint);\n");
  fs.writeFileSync(path.join(root, "migrations/20260917010000_release.sql"), sql);
  const baseline = fs.readFileSync(path.join(root, "migrations/20260916010000_applied.sql"));
  fs.writeFileSync(path.join(root, "evidence/applied-migrations.json"), JSON.stringify({ version: 1, migrations: [{ path: "migrations/20260916010000_applied.sql", sha256: sha256(baseline) }] }));
}
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; }

/** @param {string} root @param {string[]} [surfaces] */
function cleanInputs(root, surfaces = ["frontend"]) {
  const previousArtifact = artifact(root);
  return {
    previousArtifact,
    previous: validatedProvenance(rawProvenance(PREVIOUS_COMMIT, previousArtifact.hash)),
    current: validatedProvenance(rawProvenance(CURRENT_COMMIT, CURRENT_HASH)),
    change: validatedChange(rawChange(surfaces)),
  };
}

test("clean release with available prior artifact documented rollback command and no schema migration passes", () => {
  const root = repository(), inputs = cleanInputs(root);
  const report = inspectRollbackReadiness(root, validatedContract(), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks.some((item) => item.id === "previous-artifact-hash" && item.status === "PASS"), true);
  assert.equal(report.checks.some((item) => item.id === "rollback-command-documented" && item.status === "PASS"), true);
  assert.match(report.semantics, /does not execute rollback/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("previous artifact must exist as exact regular file with matching SHA256", () => {
  const root = repository(), inputs = cleanInputs(root);
  fs.writeFileSync(inputs.previousArtifact.file, "tampered");
  let report = inspectRollbackReadiness(root, validatedContract(), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.checks.some((item) => item.id === "previous-artifact-hash" && item.status === "FAIL"), true);
  fs.writeFileSync(inputs.previousArtifact.file, "");
  report = inspectRollbackReadiness(root, validatedContract(), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.checks.some((item) => item.id === "previous-artifact-available" && item.status === "FAIL"), true);
  fs.rmSync(inputs.previousArtifact.file); fs.symlinkSync("/etc/passwd", inputs.previousArtifact.file);
  report = inspectRollbackReadiness(root, validatedContract(), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.checks.some((item) => item.id === "previous-artifact-available" && item.status === "FAIL"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("release identity binds distinct commits target runtime and exact change base/head", () => {
  const root = repository(), inputs = cleanInputs(root);
  const wrongTarget = validatedProvenance(rawProvenance(PREVIOUS_COMMIT, inputs.previousArtifact.hash, "staging"));
  let report = inspectRollbackReadiness(root, validatedContract(), inputs.current, wrongTarget, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.checks.some((item) => item.id === "deployment-target" && item.status === "FAIL"), true);
  const wrongChange = rawChange(); wrongChange.source.baseCommit = "3".repeat(40);
  report = inspectRollbackReadiness(root, validatedContract(), inputs.current, inputs.previous, validatedChange(wrongChange), inputs.previousArtifact.file);
  assert.equal(report.checks.some((item) => item.id === "change-base" && item.status === "FAIL"), true);
  const same = validatedProvenance(rawProvenance(CURRENT_COMMIT, inputs.previousArtifact.hash));
  report = inspectRollbackReadiness(root, validatedContract(), inputs.current, same, validatedChange({ ...rawChange(), source: { baseCommit: CURRENT_COMMIT, headCommit: CURRENT_COMMIT } }), inputs.previousArtifact.file);
  assert.equal(report.checks.some((item) => item.id === "distinct-release" && item.status === "FAIL"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("runbook must be regular bounded and contain the exact configured rollback command", () => {
  const root = repository(), inputs = cleanInputs(root);
  fs.writeFileSync(path.join(root, "docs/rollback.md"), "# Rollback\nmanual steps only\n");
  let report = inspectRollbackReadiness(root, validatedContract(), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.checks.some((item) => item.id === "rollback-command-documented" && item.status === "FAIL"), true);
  fs.rmSync(path.join(root, "docs/rollback.md")); fs.symlinkSync("/etc/passwd", path.join(root, "docs/rollback.md"));
  report = inspectRollbackReadiness(root, validatedContract(), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.checks.some((item) => item.id === "rollback-runbook-present" && item.status === "FAIL"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("database surface with explicit NONE migration mode remains visible as WARN not invented schema truth", () => {
  const root = repository(), inputs = cleanInputs(root, ["database"]);
  const report = inspectRollbackReadiness(root, validatedContract(), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "migration-not-applicable" && item.status === "WARN"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("additive new migration with matching applied history and explicit compatibility passes", () => {
  const root = repository(); configureMigrations(root, "CREATE TABLE release_addition(id bigint);\n");
  const inputs = cleanInputs(root, ["database"]);
  const report = inspectRollbackReadiness(root, validatedContract(rawContractCheck()), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.migration.newMigrations, 1);
  assert.equal(report.migration.hazards, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("destructive and hard-to-reverse new migrations block rollback even with COMPATIBLE caller claim", () => {
  const root = repository(); configureMigrations(root, "DROP TABLE baseline;\n");
  const inputs = cleanInputs(root, ["database"]);
  const report = inspectRollbackReadiness(root, validatedContract(rawContractCheck()), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "migration-rollback-hazard-destructive-ddl"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("CHECK mode requires explicit COMPATIBLE assessment and consistent database surface", () => {
  const root = repository(); configureMigrations(root, "CREATE TABLE release_addition(id bigint);\n");
  let inputs = cleanInputs(root, ["database"]);
  let report = inspectRollbackReadiness(root, validatedContract(rawContractCheck("UNVERIFIED")), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.checks.some((item) => item.id === "migration-compatibility" && item.status === "FAIL"), true);
  inputs = cleanInputs(root, ["frontend"]);
  report = inspectRollbackReadiness(root, validatedContract(rawContractCheck()), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.checks.some((item) => item.id === "migration-surface-mismatch" && item.status === "FAIL"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("modified applied history blocks rollback through canonical migration safety", () => {
  const root = repository(); configureMigrations(root, "CREATE TABLE release_addition(id bigint);\n");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "evidence/applied-migrations.json"), "utf8"));
  manifest.migrations[0].sha256 = "0".repeat(64); fs.writeFileSync(path.join(root, "evidence/applied-migrations.json"), JSON.stringify(manifest));
  const inputs = cleanInputs(root, ["database"]);
  const report = inspectRollbackReadiness(root, validatedContract(rawContractCheck()), inputs.current, inputs.previous, inputs.change, inputs.previousArtifact.file);
  assert.equal(report.checks.some((item) => item.id === "migration-safety-modified-applied-migration"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("human output exposes identities and finding classes but never artifact or runbook contents", () => {
  const root = repository(), inputs = cleanInputs(root), marker = "SECRET_ROLLBACK_MARKER_489";
  fs.appendFileSync(path.join(root, "docs/rollback.md"), `${marker}\n`); fs.writeFileSync(inputs.previousArtifact.file, marker);
  const previous = validatedProvenance(rawProvenance(PREVIOUS_COMMIT, sha256(marker)));
  const text = formatRollbackReadiness(inspectRollbackReadiness(root, validatedContract(), inputs.current, previous, inputs.change, inputs.previousArtifact.file));
  assert.match(text, /Rollback readiness audit/);
  assert.doesNotMatch(text, new RegExp(marker));
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI composes canonical provenance change contract and artifact evidence", () => {
  const root = repository(), inputs = cleanInputs(root);
  const contractFile = tempJson("rollback-contract", rawContractNone());
  const currentFile = tempJson("rollback-current", rawProvenance(CURRENT_COMMIT, CURRENT_HASH));
  const previousFile = tempJson("rollback-previous", rawProvenance(PREVIOUS_COMMIT, inputs.previousArtifact.hash));
  const changeFile = tempJson("rollback-change", rawChange());
  const args = ["--root", root, "--contract", contractFile, "--current-provenance-file", currentFile, "--previous-provenance-file", previousFile, "--change-evidence-file", changeFile, "--previous-artifact-file", inputs.previousArtifact.file, "--json"];
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(args), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  for (const file of [contractFile, currentFile, previousFile, changeFile]) fs.rmSync(file, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI rejects malformed missing and unknown input and audit source has no network or execution surface", () => {
  const malformed = tempJson("rollback-bad", "{");
  assert.equal(main(["--root", "/tmp/missing", "--contract", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  const source = fs.readFileSync(new URL("../scripts/audit-rollback-readiness.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\//);
  assert.match(source, /validateArtifactProvenance/);
  assert.match(source, /validateChangeSurfaceEvidence/);
  assert.match(source, /inspectMigrationSafety/);
});
