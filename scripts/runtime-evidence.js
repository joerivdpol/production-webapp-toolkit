#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONTRACT_VERSION = 1;
const COMMIT_PATTERN = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SENSITIVE_METADATA_KEY_COMPONENTS = new Set([
  "token",
  "tokens",
  "password",
  "passwords",
  "secret",
  "secrets",
  "credential",
  "credentials",
  "env",
  "environment",
]);

/** @typedef {{ id: string, detail: string }} ValidationError */
/** @typedef {{ version: 1, runtime: { name: string, environment?: string }, deployment: { commit: string }, evidence: { source: string, authenticated: boolean, collectedAt: string }, metadata?: Record<string, unknown> }} RuntimeEvidence */
/** @typedef {{ valid: true, evidence: RuntimeEvidence, errors: [] } | { valid: false, evidence: null, errors: ValidationError[] }} ValidationResult */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (!isObject(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value */
function isFiniteJsonNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** @param {unknown} value @param {Set<object>} ancestors @returns {boolean} */
function isJsonSerializable(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (isFiniteJsonNumber(value)) return true;
  if (typeof value !== "object") return false;
  if (ancestors.has(value)) return false;

  ancestors.add(value);
  /** @type {unknown[] | null} */
  const values = Array.isArray(value)
    ? value
    : isPlainObject(value)
      ? Object.values(value)
      : null;
  const valid = values !== null && values.every((item) => isJsonSerializable(item, ancestors));
  ancestors.delete(value);
  return valid;
}

/** @param {unknown} value */
function normalizeString(value) {
  return typeof value === "string" ? value.trim() : null;
}

/** @param {string} value */
function isCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (daysInMonth[month - 1] ?? 0);
}

/** @param {string} value */
function isAbsoluteIsoTimestamp(value) {
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, timezone] = match;
  if (!year || !month || !day || !hour || !minute || !second || !timezone) return false;
  if (!isCalendarDate(`${year}-${month}-${day}`)) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (timezone === "Z") return true;
  const offset = /([+-])(\d{2}):(\d{2})/.exec(timezone);
  return offset !== null && Number(offset[2]) <= 23 && Number(offset[3]) <= 59;
}

/** @param {object} value @param {string[]} allowed @param {string} scope @param {{ id: string, detail: string }[]} errors */
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

/** @param {string} key @returns {boolean} */
function containsSensitiveMetadataKeyComponent(key) {
  const components = key
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((component) => component.toLowerCase());
  return components.some((component) => SENSITIVE_METADATA_KEY_COMPONENTS.has(component));
}

/** @param {unknown} value @param {ValidationError[]} errors */
function validateMetadata(value, errors) {
  if (!isPlainObject(value)) {
    errors.push({ id: "metadata-invalid", detail: "metadata must be a JSON object" });
    return;
  }
  if (!isJsonSerializable(value)) {
    errors.push({ id: "metadata-invalid", detail: "metadata must contain only JSON-serializable values" });
    return;
  }

  /** @param {unknown} candidate */
  function inspectKeys(candidate) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) inspectKeys(item);
    } else if (isPlainObject(candidate)) {
      for (const [key, item] of Object.entries(candidate)) {
        if (containsSensitiveMetadataKeyComponent(key)) {
          errors.push({
            id: "metadata-secret-key",
            detail: "metadata contains a sensitive key and must not include credentials, secrets, or environment values",
          });
        }
        inspectKeys(item);
      }
    }
  }

  inspectKeys(value);
}

/** @param {unknown} value @returns {ValidationResult} */
export function validateRuntimeEvidence(value) {
  /** @type {ValidationError[]} */
  const errors = [];
  if (!isPlainObject(value)) {
    return { valid: false, evidence: null, errors: [{ id: "input-invalid", detail: "runtime evidence must be a JSON object" }] };
  }

  rejectUnknownFields(value, ["version", "runtime", "deployment", "evidence", "metadata"], "top-level", errors);

  if (!("version" in value)) {
    errors.push({ id: "version-missing", detail: "version is required" });
  } else if (value.version !== CONTRACT_VERSION) {
    errors.push({ id: "version-unsupported", detail: `version must be exactly ${CONTRACT_VERSION}` });
  }

  const runtime = value.runtime;
  /** @type {{ name?: string, environment?: string }} */
  const normalizedRuntime = {};
  if (!isPlainObject(runtime)) {
    errors.push({ id: "runtime-missing", detail: "runtime must be an object" });
  } else {
    rejectUnknownFields(runtime, ["name", "environment"], "runtime", errors);
    const name = normalizeString(runtime.name);
    if (!("name" in runtime)) {
      errors.push({ id: "runtime-name-missing", detail: "runtime.name is required" });
    } else if (name === null || name === "") {
      errors.push({ id: "runtime-name-invalid", detail: "runtime.name must be a non-empty string" });
    } else {
      normalizedRuntime.name = name;
    }
    if ("environment" in runtime) {
      const environment = normalizeString(runtime.environment);
      if (environment === null || environment === "") {
        errors.push({ id: "runtime-environment-invalid", detail: "runtime.environment must be a non-empty string when supplied" });
      } else {
        normalizedRuntime.environment = environment;
      }
    }
  }

  const deployment = value.deployment;
  /** @type {{ commit?: string }} */
  const normalizedDeployment = {};
  if (!isPlainObject(deployment)) {
    errors.push({ id: "deployment-missing", detail: "deployment must be an object" });
  } else {
    rejectUnknownFields(deployment, ["commit"], "deployment", errors);
    const commit = normalizeString(deployment.commit);
    if (!("commit" in deployment)) {
      errors.push({ id: "deployment-commit-missing", detail: "deployment.commit is required" });
    } else if (commit === null || !COMMIT_PATTERN.test(commit)) {
      errors.push({ id: "deployment-commit-invalid", detail: "deployment.commit must be a full 40- or 64-character hexadecimal Git object ID" });
    } else {
      normalizedDeployment.commit = commit.toLowerCase();
    }
  }

  const evidence = value.evidence;
  /** @type {{ source?: string, authenticated?: boolean, collectedAt?: string }} */
  const normalizedEvidence = {};
  if (!isPlainObject(evidence)) {
    errors.push({ id: "evidence-missing", detail: "evidence must be an object" });
  } else {
    rejectUnknownFields(evidence, ["source", "authenticated", "collectedAt"], "evidence", errors);
    const source = normalizeString(evidence.source);
    if (!("source" in evidence)) {
      errors.push({ id: "evidence-source-missing", detail: "evidence.source is required" });
    } else if (source === null || source === "") {
      errors.push({ id: "evidence-source-invalid", detail: "evidence.source must be a non-empty string" });
    } else {
      normalizedEvidence.source = source;
    }
    if (!("authenticated" in evidence)) {
      errors.push({ id: "evidence-authenticated-missing", detail: "evidence.authenticated is required" });
    } else if (typeof evidence.authenticated !== "boolean") {
      errors.push({ id: "evidence-authenticated-invalid", detail: "evidence.authenticated must be a boolean" });
    } else {
      normalizedEvidence.authenticated = evidence.authenticated;
    }
    const collectedAt = normalizeString(evidence.collectedAt);
    if (!("collectedAt" in evidence)) {
      errors.push({ id: "evidence-collected-at-missing", detail: "evidence.collectedAt is required" });
    } else if (collectedAt === null || !isAbsoluteIsoTimestamp(collectedAt)) {
      errors.push({ id: "evidence-collected-at-invalid", detail: "evidence.collectedAt must be a valid absolute ISO 8601 timestamp with timezone" });
    } else {
      normalizedEvidence.collectedAt = collectedAt;
    }
  }

  if ("metadata" in value) validateMetadata(value.metadata, errors);
  if (errors.length > 0) return { valid: false, evidence: null, errors };

  /** @type {RuntimeEvidence} */
  const normalized = {
    version: CONTRACT_VERSION,
    runtime: /** @type {{ name: string, environment?: string }} */ (normalizedRuntime),
    deployment: /** @type {{ commit: string }} */ (normalizedDeployment),
    evidence: /** @type {{ source: string, authenticated: boolean, collectedAt: string }} */ (normalizedEvidence),
    ...("metadata" in value ? { metadata: /** @type {Record<string, unknown>} */ (value.metadata) } : {}),
  };
  return { valid: true, evidence: normalized, errors: [] };
}

/** @param {ValidationResult} result */
export function formatRuntimeEvidenceValidation(result) {
  const lines = ["Runtime evidence", ""];
  if (result.valid && result.evidence) {
    lines.push(
      `Runtime: ${result.evidence.runtime.name}`,
      `Environment: ${result.evidence.runtime.environment ?? "(not supplied)"}`,
      `Commit: ${result.evidence.deployment.commit}`,
      `Source: ${result.evidence.evidence.source}`,
      `Authenticated: ${result.evidence.evidence.authenticated}`,
      `Collected at: ${result.evidence.evidence.collectedAt}`,
      "",
      "Result: VALID",
    );
  } else {
    lines.push("Result: INVALID");
    for (const error of result.errors) lines.push(`ERROR  ${error.id}  ${error.detail}`);
  }
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
    console.error("Usage: node scripts/runtime-evidence.js --file <runtime-evidence.json> [--json]");
    return 1;
  }

  let input;
  try {
    input = JSON.parse(fs.readFileSync(options.file, "utf8"));
  } catch (error) {
    const result = cliFailure(
      error instanceof SyntaxError ? "json-malformed" : "file-read-failed",
      error instanceof SyntaxError ? "runtime evidence file contains malformed JSON" : "runtime evidence file could not be read",
    );
    if (options.json) console.log(JSON.stringify(result));
    else console.error(formatRuntimeEvidenceValidation(result));
    return 1;
  }

  const result = validateRuntimeEvidence(input);
  console.log(options.json ? JSON.stringify(result) : formatRuntimeEvidenceValidation(result));
  return result.valid ? 0 : 1;
}

// This CLI only reads the explicit --file input. It does not inspect Git,
// environment variables, network services, or runtime systems, and never writes files.
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
