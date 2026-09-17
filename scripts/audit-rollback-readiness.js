#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifactProvenance } from "./artifact-provenance.js";
import { inspectMigrationSafety } from "./audit-migration-safety.js";
import { validateChangeSurfaceEvidence } from "./change-surface-evidence.js";
import { validateRollbackReadinessContract } from "./rollback-readiness-contract.js";

const MAX_RUNBOOK_BYTES = 2 * 1024 * 1024;
const ROLLBACK_HAZARDS = new Set([
  "destructive-ddl",
  "destructive-data-operation",
  "unbounded-delete",
  "irreversible-enum-change",
  "column-type-rewrite",
]);

/** @param {string} root @param {string} relative */
function repositoryPath(root, relative) {
  const base = path.resolve(root), absolute = path.resolve(base, relative), rel = path.relative(base, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
  return absolute;
}

/** @param {string} root @param {string} relative @param {string} command */
function inspectRunbook(root, relative, command) {
  const absolute = repositoryPath(root, relative);
  if (!absolute) return { present: false, commandDocumented: false };
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { return { present: false, commandDocumented: false }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_RUNBOOK_BYTES) return { present: false, commandDocumented: false };
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) return { present: false, commandDocumented: false };
  return { present: true, commandDocumented: buffer.toString("utf8").includes(command) };
}

/** @param {string} filename */
function sha256RegularFile(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) return null;
  const hash = crypto.createHash("sha256"), descriptor = fs.openSync(filename, "r"), buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let offset = 0;
    while (offset < stat.size) {
      const count = fs.readSync(descriptor, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
      if (count <= 0) return null;
      hash.update(buffer.subarray(0, count));
      offset += count;
    }
  } finally { fs.closeSync(descriptor); }
  return hash.digest("hex");
}

/** @param {string} root @param {string} relative */
function readRepositoryJson(root, relative) {
  const absolute = repositoryPath(root, relative);
  if (!absolute) return null;
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 4 * 1024 * 1024) return null;
  try { return JSON.parse(fs.readFileSync(absolute, "utf8")); } catch { return null; }
}

/** @param {any} provenance */
function provenanceInternallyConsistent(provenance) {
  return provenance.build.artifact.sha256 === provenance.deployment.artifactSha256;
}

/** @param {any} current @param {any} previous */
function sameRuntime(current, previous) {
  return current.deployment.runtime.name === previous.deployment.runtime.name &&
    (current.deployment.runtime.environment ?? null) === (previous.deployment.runtime.environment ?? null);
}

/**
 * @param {string} root
 * @param {any} contract
 * @param {any} current
 * @param {any} previous
 * @param {any} change
 * @param {string} previousArtifactFile
 */
export function inspectRollbackReadiness(root, contract, current, previous, change, previousArtifactFile) {
  /** @type {Array<{id:string,status:"PASS"|"WARN"|"FAIL",detail:string,path?:string}>} */
  const checks = [];
  /** @param {string} id @param {"PASS"|"WARN"|"FAIL"} status @param {string} detail @param {string} [migrationPath] */
  const add = (id, status, detail, migrationPath) => checks.push({ id, status, detail, ...(migrationPath ? { path: migrationPath } : {}) });

  add("current-provenance-hash", provenanceInternallyConsistent(current) ? "PASS" : "FAIL", "current build and deployment artifact SHA256 must match");
  add("previous-provenance-hash", provenanceInternallyConsistent(previous) ? "PASS" : "FAIL", "previous build and deployment artifact SHA256 must match");
  add("distinct-release", current.source.commit !== previous.source.commit ? "PASS" : "FAIL", "current and previous source commits must be distinct exact releases");
  add("deployment-target", current.deployment.target === previous.deployment.target ? "PASS" : "FAIL", "current and previous provenance must target the same deployment identity");
  add("runtime-identity", sameRuntime(current, previous) ? "PASS" : "FAIL", "current and previous provenance must bind the same runtime identity");
  add("change-base", change.source.baseCommit === previous.source.commit ? "PASS" : "FAIL", "change evidence base commit must equal previous release commit");
  add("change-head", change.source.headCommit === current.source.commit ? "PASS" : "FAIL", "change evidence head commit must equal current release commit");

  const artifactHash = sha256RegularFile(previousArtifactFile);
  add("previous-artifact-available", artifactHash !== null ? "PASS" : "FAIL", "previous artifact must be available as an explicit regular non-symlink file");
  if (artifactHash !== null) add("previous-artifact-hash", artifactHash === previous.build.artifact.sha256 ? "PASS" : "FAIL", "available previous artifact SHA256 must match previous provenance");

  const runbook = inspectRunbook(root, contract.rollback.runbookPath, contract.rollback.command);
  add("rollback-runbook-present", runbook.present ? "PASS" : "FAIL", "rollback runbook must be a bounded regular non-symlink repository file");
  if (runbook.present) add("rollback-command-documented", runbook.commandDocumented ? "PASS" : "FAIL", "explicit rollback command must appear in the configured runbook");

  let migrationSummary = { mode: contract.migration.mode, newMigrations: 0, hazards: 0, compatibility: contract.migration.compatibility };
  let technicalFailure = false;
  const databaseSurface = change.surfaces.includes("database");
  if (contract.migration.mode === "NONE") {
    add(
      "migration-not-applicable",
      databaseSurface ? "WARN" : "PASS",
      databaseSurface
        ? "contract declares no schema migration while broad database surface changed; absence of a schema migration is caller-declared"
        : "contract explicitly declares no schema migration for this release",
    );
  } else {
    const rawManifest = readRepositoryJson(root, contract.migration.appliedManifestPath);
    if (rawManifest === null) {
      add("migration-manifest-unavailable", "FAIL", "applied migration manifest cannot be read safely from the repository");
      technicalFailure = true;
    } else {
      let report;
      try { report = inspectMigrationSafety(root, { migrationRoots: contract.migration.roots, manifest: rawManifest }); }
      catch { report = null; }
      if (!report) {
        add("migration-audit-unavailable", "FAIL", "canonical migration safety audit could not evaluate rollback inputs");
        technicalFailure = true;
      } else {
        const structuralFailures = report.checks.filter((item) => item.severity === "FAIL");
        for (const failure of structuralFailures) add(`migration-safety-${failure.id}`, "FAIL", "canonical migration safety reported a blocking finding", /** @type {any} */ (failure).path);
        if (report.technicalStatus === "FAIL") technicalFailure = true;

        const newMigrations = report.migrations.filter((item) => item.history === "NEW");
        const hazards = [];
        for (const migration of newMigrations) {
          for (const risk of migration.risks) if (ROLLBACK_HAZARDS.has(risk.id)) hazards.push({ id: risk.id, path: migration.path });
        }
        migrationSummary = { mode: contract.migration.mode, newMigrations: newMigrations.length, hazards: hazards.length, compatibility: contract.migration.compatibility };
        add("migration-history-bound", report.historyStatus === "MATCH" ? "PASS" : "FAIL", "applied migration manifest must match repository history before rollback analysis");
        if (newMigrations.length > 0 && !databaseSurface) add("migration-surface-mismatch", "FAIL", "new migration files exist but change evidence does not declare the database surface");
        else add("migration-surface-binding", "PASS", newMigrations.length > 0 ? "database change surface is bound to new migration evidence" : "no new migration files were found after the applied manifest");
        add("migration-compatibility", contract.migration.compatibility === "COMPATIBLE" ? "PASS" : "FAIL", "schema rollback compatibility must be explicitly assessed as COMPATIBLE for CHECK mode");
        for (const hazard of hazards) add(`migration-rollback-hazard-${hazard.id}`, "FAIL", "new migration contains an automatically recognized destructive or hard-to-reverse rollback hazard", hazard.path);
        if (hazards.length === 0) add("migration-rollback-hazards", "PASS", "no automatically recognized destructive or hard-to-reverse hazards were found in new migrations");
      }
    }
  }

  const summary = {
    pass: checks.filter((item) => item.status === "PASS").length,
    warn: checks.filter((item) => item.status === "WARN").length,
    fail: checks.filter((item) => item.status === "FAIL").length,
  };
  return {
    currentCommit: current.source.commit,
    previousCommit: previous.source.commit,
    deploymentTarget: current.deployment.target,
    runtime: current.deployment.runtime,
    migration: migrationSummary,
    trust: {
      currentProvenanceAuthenticated: current.evidence.authenticated,
      previousProvenanceAuthenticated: previous.evidence.authenticated,
      changeEvidenceAuthenticated: change.evidence.authenticated,
    },
    checks,
    summary,
    technicalStatus: technicalFailure ? "FAIL" : "PASS",
    overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS",
    semantics: "rollback readiness proves explicit evidence bindings, prior artifact hash availability, documented rollback command, and bounded migration checks; it does not execute rollback or independently prove caller-declared schema compatibility",
  };
}

/** @param {ReturnType<typeof inspectRollbackReadiness>} report */
export function formatRollbackReadiness(report) {
  const lines = [
    "Rollback readiness audit",
    "",
    `Current commit: ${report.currentCommit}`,
    `Previous commit: ${report.previousCommit}`,
    `Deployment target: ${report.deploymentTarget}`,
    `Runtime: ${report.runtime.name}${report.runtime.environment ? ` / ${report.runtime.environment}` : ""}`,
    `Migration mode: ${report.migration.mode}`,
    `New migrations: ${report.migration.newMigrations}`,
    `Rollback hazards: ${report.migration.hazards}`,
    `Semantics: ${report.semantics}`,
    "",
  ];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}${check.path ? `  ${check.path}` : ""}  ${check.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string} filename */
function readJson(filename) { try { return JSON.parse(fs.readFileSync(filename, "utf8")); } catch { return null; } }

/** @param {string[]} argv */
function parse(argv) {
  let root = null, contractFile = null, currentFile = null, previousFile = null, changeFile = null, artifactFile = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--root", "--contract", "--current-provenance-file", "--previous-provenance-file", "--change-evidence-file", "--previous-artifact-file"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--root") { if (root) return null; root = value; }
    else if (argument === "--contract") { if (contractFile) return null; contractFile = value; }
    else if (argument === "--current-provenance-file") { if (currentFile) return null; currentFile = value; }
    else if (argument === "--previous-provenance-file") { if (previousFile) return null; previousFile = value; }
    else if (argument === "--change-evidence-file") { if (changeFile) return null; changeFile = value; }
    else { if (artifactFile) return null; artifactFile = value; }
  }
  return root && contractFile && currentFile && previousFile && changeFile && artifactFile ? { root, contractFile, currentFile, previousFile, changeFile, artifactFile, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) {
    console.error("Usage: node scripts/audit-rollback-readiness.js --root <repository> --contract <contract.json> --current-provenance-file <current.json> --previous-provenance-file <previous.json> --change-evidence-file <change.json> --previous-artifact-file <artifact> [--json]");
    return 1;
  }
  const root = path.resolve(options.root);
  let rootStat;
  try { rootStat = fs.lstatSync(root); } catch { console.error("Rollback repository is unavailable"); return 1; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) { console.error("Rollback repository must be a regular directory"); return 1; }

  const rawContract = readJson(options.contractFile), rawCurrent = readJson(options.currentFile), rawPrevious = readJson(options.previousFile), rawChange = readJson(options.changeFile);
  if (!rawContract || !rawCurrent || !rawPrevious || !rawChange) { console.error("Rollback readiness input cannot be read or parsed"); return 1; }
  const contract = validateRollbackReadinessContract(rawContract), current = validateArtifactProvenance(rawCurrent), previous = validateArtifactProvenance(rawPrevious), change = validateChangeSurfaceEvidence(rawChange);
  if (!contract.valid || !contract.contract || !current.valid || !current.provenance || !previous.valid || !previous.provenance || !change.valid || !change.evidence) {
    console.error("Rollback readiness input is invalid");
    return 1;
  }
  const report = inspectRollbackReadiness(root, contract.contract, current.provenance, previous.provenance, change.evidence, path.resolve(options.artifactFile));
  console.log(options.json ? JSON.stringify(report) : formatRollbackReadiness(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
