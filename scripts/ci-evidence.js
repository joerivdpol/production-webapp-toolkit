#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  isAbsoluteIsoTimestamp,
  isFullObjectId,
} from "./runtime-evidence.js";

const CONTRACT_VERSION = 1;
const CHECK_STATUSES = new Set(["PASS", "FAIL", "SKIPPED"]);

/** @typedef {{ id: string, detail: string }} ValidationError */
/** @typedef {{ name: string, status: "PASS" | "FAIL" | "SKIPPED" }} CiCheck */
/** @typedef {{ version: 1, commit: string, ci: { provider: string, workflow?: string, runId?: string }, evidence: { source: string, authenticated: boolean, collectedAt: string }, checks: CiCheck[] }} CiEvidence */
/** @typedef {{ valid: true, evidence: CiEvidence, errors: [] } | { valid: false, evidence: null, errors: ValidationError[] }} ValidationResult */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value */
function normalizeString(value) {
  return typeof value === "string" ? value.trim() : null;
}
/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {ValidationError[]} errors */
function rejectUnknownFields(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push({
        id: `${scope}-field-unknown`,
        detail: `${scope} contains unsupported version ${CONTRACT_VERSION} field "${key}"`,
      });
    }
  }
}

/** @param {unknown} value @returns {ValidationResult} */
export function validateCiEvidence(value) {
  /** @type {ValidationError[]} */
  const errors = [];
  if (!isPlainObject(value)) {
    return { valid: false, evidence: null, errors: [{ id: "input-invalid", detail: "CI evidence must be a JSON object" }] };
  }

  rejectUnknownFields(value, ["version", "commit", "ci", "evidence", "checks"], "top-level", errors);
  if (!("version" in value)) errors.push({ id: "version-missing", detail: "version is required" });
  else if (value.version !== CONTRACT_VERSION) errors.push({ id: "version-unsupported", detail: `version must be exactly ${CONTRACT_VERSION}` });

  const commit = normalizeString(value.commit);
  if (!("commit" in value)) errors.push({ id: "commit-missing", detail: "commit is required" });
  else if (commit === null || !isFullObjectId(commit)) errors.push({ id: "commit-invalid", detail: "commit must be a full 40- or 64-character hexadecimal Git object ID" });

  const ci = value.ci;
  /** @type {{ provider?: string, workflow?: string, runId?: string }} */
  const normalizedCi = {};
  if (!isPlainObject(ci)) {
    errors.push({ id: "ci-missing", detail: "ci must be an object" });
  } else {
    rejectUnknownFields(ci, ["provider", "workflow", "runId"], "ci", errors);
    const provider = normalizeString(ci.provider);
    if (!("provider" in ci)) errors.push({ id: "ci-provider-missing", detail: "ci.provider is required" });
    else if (provider === null || provider === "") errors.push({ id: "ci-provider-invalid", detail: "ci.provider must be a non-empty string" });
    else normalizedCi.provider = provider;

    if ("workflow" in ci) {
      const workflow = normalizeString(ci.workflow);
      if (workflow === null || workflow === "") errors.push({ id: "ci-workflow-invalid", detail: "ci.workflow must be a non-empty string when supplied" });
      else normalizedCi.workflow = workflow;
    }
    if ("runId" in ci) {
      const runId = normalizeString(ci.runId);
      if (runId === null || runId === "") errors.push({ id: "ci-runid-invalid", detail: "ci.runId must be a non-empty string when supplied" });
      else normalizedCi.runId = runId;
    }
  }

  const trust = value.evidence;
  /** @type {{ source?: string, authenticated?: boolean, collectedAt?: string }} */
  const normalizedTrust = {};
  if (!isPlainObject(trust)) {
    errors.push({ id: "evidence-missing", detail: "evidence must be an object" });
  } else {
    rejectUnknownFields(trust, ["source", "authenticated", "collectedAt"], "evidence", errors);
    const source = normalizeString(trust.source);
    if (!("source" in trust)) errors.push({ id: "evidence-source-missing", detail: "evidence.source is required" });
    else if (source === null || source === "") errors.push({ id: "evidence-source-invalid", detail: "evidence.source must be a non-empty string" });
    else normalizedTrust.source = source;

    if (!("authenticated" in trust)) errors.push({ id: "evidence-authenticated-missing", detail: "evidence.authenticated is required" });
    else if (typeof trust.authenticated !== "boolean") errors.push({ id: "evidence-authenticated-invalid", detail: "evidence.authenticated must be a boolean" });
    else normalizedTrust.authenticated = trust.authenticated;

    const collectedAt = normalizeString(trust.collectedAt);
    if (!("collectedAt" in trust)) errors.push({ id: "evidence-collected-at-missing", detail: "evidence.collectedAt is required" });
    else if (collectedAt === null || !isAbsoluteIsoTimestamp(collectedAt)) errors.push({ id: "evidence-collected-at-invalid", detail: "evidence.collectedAt must be a valid absolute ISO 8601 timestamp with timezone" });
    else normalizedTrust.collectedAt = collectedAt;
  }

  const checks = value.checks;
  /** @type {CiCheck[]} */
  const normalizedChecks = [];
  const seenCheckNames = new Set();
  if (!Array.isArray(checks) || checks.length === 0) {
    errors.push({ id: "checks-invalid", detail: "checks must be a non-empty array" });
  } else {
    for (let index = 0; index < checks.length; index += 1) {
      const check = checks[index];
      if (!isPlainObject(check)) {
        errors.push({ id: "check-invalid", detail: `checks[${index}] must be an object` });
        continue;
      }
      rejectUnknownFields(check, ["name", "status"], "check", errors);
      const name = normalizeString(check.name);
      let nameValid = false;
      if (!("name" in check)) errors.push({ id: "check-name-missing", detail: `checks[${index}].name is required` });
      else if (name === null || name === "") errors.push({ id: "check-name-invalid", detail: `checks[${index}].name must be a non-empty string` });
      else if (seenCheckNames.has(name)) errors.push({ id: "check-name-duplicate", detail: `checks contains duplicate check name "${name}"` });
      else {
        seenCheckNames.add(name);
        nameValid = true;
      }

      const status = normalizeString(check.status);
      const statusValid = status !== null && CHECK_STATUSES.has(status);
      if (!("status" in check)) errors.push({ id: "check-status-missing", detail: `checks[${index}].status is required` });
      else if (!statusValid) errors.push({ id: "check-status-invalid", detail: `checks[${index}].status must be PASS, FAIL, or SKIPPED` });

      if (nameValid && statusValid) {
        normalizedChecks.push({ name: /** @type {string} */ (name), status: /** @type {CiCheck["status"]} */ (status) });
      }
    }
  }

  if (errors.length > 0) return { valid: false, evidence: null, errors };
  /** @type {CiEvidence} */
  const normalized = {
    version: CONTRACT_VERSION,
    commit: /** @type {string} */ (commit).toLowerCase(),
    ci: /** @type {{ provider: string, workflow?: string, runId?: string }} */ (normalizedCi),
    evidence: /** @type {{ source: string, authenticated: boolean, collectedAt: string }} */ (normalizedTrust),
    checks: normalizedChecks,
  };
  return { valid: true, evidence: normalized, errors: [] };
}

/** @param {ValidationResult} result */
export function formatCiEvidenceValidation(result) {
  const lines = ["CI evidence", ""];
  if (!result.valid || !result.evidence) {
    lines.push("Result: INVALID");
    for (const error of result.errors) lines.push(`ERROR  ${error.id}  ${error.detail}`);
    return lines.join("\n");
  }

  const evidence = result.evidence;
  lines.push(
    `Commit: ${evidence.commit}`,
    `Provider: ${evidence.ci.provider}`,
    `Workflow: ${evidence.ci.workflow ?? "(not supplied)"}`,
    `Run ID: ${evidence.ci.runId ?? "(not supplied)"}`,
    `Source: ${evidence.evidence.source}`,
    `Authenticated: ${evidence.evidence.authenticated}`,
    `Collected at: ${evidence.evidence.collectedAt}`,
    "",
  );
  for (const check of evidence.checks) lines.push(`${check.status}  ${check.name}`);
  lines.push("", "Result: VALID");
  return lines.join("\n");
}
/** @param {string[]} argv */
export function parseArguments(argv) {
  let file = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--file") {
      const value = argv[index + 1];
      if (file !== null || typeof value !== "string" || value === "" || value.startsWith("--")) return null;
      file = value;
      index += 1;
    } else {
      return null;
    }
  }
  return file === null ? null : { file, json };
}

/** @param {string} id @param {string} detail @returns {ValidationResult} */
function cliFailure(id, detail) {
  return { valid: false, evidence: null, errors: [{ id, detail }] };
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/ci-evidence.js --file <ci-evidence.json> [--json]");
    return 1;
  }

  let input;
  try {
    input = JSON.parse(fs.readFileSync(options.file, "utf8"));
  } catch (error) {
    const result = cliFailure(
      error instanceof SyntaxError ? "json-malformed" : "file-read-failed",
      error instanceof SyntaxError ? "CI evidence file contains malformed JSON" : "CI evidence file could not be read",
    );
    if (options.json) console.log(JSON.stringify(result));
    else console.error(formatCiEvidenceValidation(result));
    return 1;
  }

  const result = validateCiEvidence(input);
  console.log(options.json ? JSON.stringify(result) : formatCiEvidenceValidation(result));
  return result.valid ? 0 : 1;
}

// This CLI only reads the explicit --file input. It performs no Git command,
// network request, environment read, runtime probe, or file write.
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
