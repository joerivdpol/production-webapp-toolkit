#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const RELATIONSHIPS = new Set(["direct-production", "direct-development", "direct-optional", "transitive"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;
const PACKAGE_NAME_PATTERN = /^(?:@[A-Za-z0-9._-]+\/)?[A-Za-z0-9._-]+$/;
const LICENSE_PATTERN = /^[A-Za-z0-9.+\-():/ ]{1,256}$/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {unknown} value */
function packageVersion(value) {
  const normalized = nonEmptyString(value);
  return normalized && normalized.length <= 128 && !/\s/.test(normalized) ? normalized : null;
}

/** @param {unknown} value */
export function normalizeLicenseExpression(value) {
  if (value === null) return null;
  const normalized = nonEmptyString(value)?.replace(/\s+/g, " ") ?? null;
  return normalized && LICENSE_PATTERN.test(normalized) ? normalized : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateLicenseEvidence(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, evidence: null, errors: [{ id: "evidence-invalid", detail: "license evidence must be an object" }] };
  rejectUnknown(value, ["version", "artifact", "source", "packages"], "evidence", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let artifact = null;
  if (!isPlainObject(value.artifact)) errors.push({ id: "artifact-invalid", detail: "artifact must be an object" });
  else {
    rejectUnknown(value.artifact, ["name", "version", "sha256", "sourceCommit"], "artifact", errors);
    const name = nonEmptyString(value.artifact.name);
    const version = packageVersion(value.artifact.version);
    const sha256 = nonEmptyString(value.artifact.sha256)?.toLowerCase() ?? null;
    const sourceCommit = nonEmptyString(value.artifact.sourceCommit)?.toLowerCase() ?? null;
    if (!name || name.length > 128) errors.push({ id: "artifact-name-invalid", detail: "artifact.name must be a bounded non-empty string" });
    if (!version) errors.push({ id: "artifact-version-invalid", detail: "artifact.version must be a bounded version token" });
    if (!sha256 || !SHA256_PATTERN.test(sha256)) errors.push({ id: "artifact-sha256-invalid", detail: "artifact.sha256 must be a SHA256 hex digest" });
    if (!sourceCommit || !COMMIT_PATTERN.test(sourceCommit)) errors.push({ id: "artifact-source-commit-invalid", detail: "artifact.sourceCommit must be a full Git object id" });
    if (name && version && sha256 && SHA256_PATTERN.test(sha256) && sourceCommit && COMMIT_PATTERN.test(sourceCommit)) {
      artifact = { name, version, sha256, sourceCommit };
    }
  }

  let source = null;
  if (!isPlainObject(value.source)) errors.push({ id: "source-invalid", detail: "source must be an object" });
  else {
    rejectUnknown(value.source, ["kind", "authenticated", "collectedAt"], "source", errors);
    const kind = nonEmptyString(value.source.kind);
    const collectedAt = nonEmptyString(value.source.collectedAt);
    if (kind !== "installed-package-manifests") errors.push({ id: "source-kind-invalid", detail: "source.kind must be installed-package-manifests" });
    if (typeof value.source.authenticated !== "boolean") errors.push({ id: "source-authenticated-invalid", detail: "source.authenticated must be boolean" });
    if (!collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) errors.push({ id: "source-collected-at-invalid", detail: "source.collectedAt must be an absolute ISO timestamp" });
    if (kind === "installed-package-manifests" && typeof value.source.authenticated === "boolean" && collectedAt && isAbsoluteIsoTimestamp(collectedAt)) {
      source = { kind, authenticated: value.source.authenticated, collectedAt };
    }
  }

  /** @type {Array<{name:string,version:string,relationship:string,licenseExpression:string|null}>} */
  const packages = [];
  if (!Array.isArray(value.packages)) errors.push({ id: "packages-invalid", detail: "packages must be an array" });
  else {
    const seen = new Set();
    for (const [index, raw] of value.packages.entries()) {
      if (!isPlainObject(raw)) { errors.push({ id: "package-invalid", detail: `packages[${index}] must be an object` }); continue; }
      rejectUnknown(raw, ["name", "version", "relationship", "licenseExpression"], "package", errors);
      const name = nonEmptyString(raw.name);
      const version = packageVersion(raw.version);
      const relationship = nonEmptyString(raw.relationship);
      const licenseExpression = normalizeLicenseExpression(raw.licenseExpression);
      if (!name || !PACKAGE_NAME_PATTERN.test(name)) errors.push({ id: "package-name-invalid", detail: `packages[${index}].name is invalid` });
      if (!version) errors.push({ id: "package-version-invalid", detail: `packages[${index}].version is invalid` });
      if (!relationship || !RELATIONSHIPS.has(relationship)) errors.push({ id: "package-relationship-invalid", detail: `packages[${index}].relationship is invalid` });
      if (raw.licenseExpression !== null && licenseExpression === null) errors.push({ id: "package-license-invalid", detail: `packages[${index}].licenseExpression is invalid` });
      if (!name || !version || !relationship || !RELATIONSHIPS.has(relationship)) continue;
      const key = `${name}@${version}`;
      if (seen.has(key)) { errors.push({ id: "package-duplicate", detail: `packages contains duplicate ${key}` }); continue; }
      seen.add(key);
      packages.push({ name, version, relationship, licenseExpression });
    }
  }

  if (errors.length > 0 || artifact === null || source === null) return { ok: false, evidence: null, errors };
  packages.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  return {
    ok: true,
    evidence: { version: 1, artifact, source, packages },
    errors: [],
  };
}

/** @param {NonNullable<ReturnType<typeof validateLicenseEvidence>["evidence"]>} evidence */
export function formatLicenseEvidence(evidence) {
  const known = evidence.packages.filter((item) => item.licenseExpression !== null).length;
  return [
    "License Evidence Contract v1",
    "",
    `Artifact: ${evidence.artifact.name}@${evidence.artifact.version}`,
    `Packages: ${evidence.packages.length}`,
    `Declared licenses: ${known}`,
    `Unknown licenses: ${evidence.packages.length - known}`,
    `Source: ${evidence.source.kind}`,
    `Collected at: ${evidence.source.collectedAt}`,
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let file = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--file" || file !== null) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    file = value;
    index += 1;
  }
  return file === null ? null : { file, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/license-evidence.js --file <license-evidence.json> [--json]");
    return 1;
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(options.file, "utf8")); }
  catch { console.error("License evidence file cannot be read or parsed"); return 1; }
  const result = validateLicenseEvidence(value);
  if (!result.ok || result.evidence === null) {
    console.error("License evidence is invalid");
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.evidence) : formatLicenseEvidence(result.evidence));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
