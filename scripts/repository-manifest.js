#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function portableId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return ID_PATTERN.test(normalized) ? normalized : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value @param {string} field @param {Array<{id:string,detail:string}>} errors @param {boolean} allowEmpty */
function idList(value, field, errors, allowEmpty) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 256) {
    errors.push({ id: `${field}-invalid`, detail: `${field} must be a ${allowEmpty ? "bounded" : "non-empty bounded"} array` });
    return null;
  }
  const normalized = value.map(portableId);
  if (normalized.some((item) => item === null)) {
    errors.push({ id: `${field}-id-invalid`, detail: `${field} contains an invalid portable identifier` });
    return null;
  }
  const items = /** @type {string[]} */ (normalized);
  if (new Set(items).size !== items.length) {
    errors.push({ id: `${field}-duplicate`, detail: `${field} contains duplicate identifiers` });
    return null;
  }
  return items.sort();
}

/** @param {unknown} value @param {string} field @param {Array<{id:string,detail:string}>} errors */
function systemDeclaration(value, field, errors) {
  if (value === null) return null;
  if (!object(value)) {
    errors.push({ id: `${field}-invalid`, detail: `${field} must be null or an object` });
    return undefined;
  }
  rejectUnknown(value, ["type", "provider"], field, errors);
  const type = portableId(value.type);
  const provider = value.provider === undefined ? null : portableId(value.provider);
  if (!type || (value.provider !== undefined && !provider)) {
    errors.push({ id: `${field}-fields-invalid`, detail: `${field} requires a portable type and optional portable provider` });
    return undefined;
  }
  return { type, ...(provider ? { provider } : {}) };
}

/** @param {unknown} value */
export function validateRepositoryManifest(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!object(value)) return { valid: false, manifest: null, errors: [{ id: "manifest-invalid", detail: "repository manifest must be an object" }] };
  rejectUnknown(value, ["version", "repository", "profile", "runtime", "database", "capabilities", "checks"], "manifest", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let repository = null;
  if (!object(value.repository)) errors.push({ id: "repository-invalid", detail: "repository must be an object" });
  else {
    rejectUnknown(value.repository, ["id"], "repository", errors);
    const id = portableId(value.repository.id);
    if (!id) errors.push({ id: "repository-id-invalid", detail: "repository.id must be a portable identifier" });
    else repository = { id };
  }

  const profile = portableId(value.profile);
  if (!profile) errors.push({ id: "profile-invalid", detail: "profile must be a portable policy-pack identifier" });

  if (!("runtime" in value)) errors.push({ id: "runtime-missing", detail: "runtime must be explicitly declared as null or an object" });
  if (!("database" in value)) errors.push({ id: "database-missing", detail: "database must be explicitly declared as null or an object" });
  const runtime = "runtime" in value ? systemDeclaration(value.runtime, "runtime", errors) : undefined;
  const database = "database" in value ? systemDeclaration(value.database, "database", errors) : undefined;

  const capabilities = idList(value.capabilities, "capabilities", errors, true);

  let checks = null;
  if (!object(value.checks)) errors.push({ id: "checks-invalid", detail: "checks must be an object" });
  else {
    rejectUnknown(value.checks, ["required", "advisory"], "checks", errors);
    const required = idList(value.checks.required, "required-checks", errors, false);
    const advisory = idList(value.checks.advisory, "advisory-checks", errors, true);
    if (required && advisory) {
      const overlap = required.filter((id) => advisory.includes(id));
      if (overlap.length > 0) errors.push({ id: "check-severity-overlap", detail: `checks cannot be both required and advisory: ${overlap.join(", ")}` });
      else checks = { required, advisory };
    }
  }

  if (errors.length > 0 || !repository || !profile || runtime === undefined || database === undefined || !capabilities || !checks) {
    return { valid: false, manifest: null, errors };
  }
  return {
    valid: true,
    manifest: {
      version: 1,
      repository,
      profile,
      runtime,
      database,
      capabilities,
      checks,
    },
    errors: [],
  };
}

/** @param {any} manifest */
export function formatRepositoryManifest(manifest) {
  /** @param {null|{type:string,provider?:string}} value */
  const system = (value) => value === null ? "none" : `${value.type}${value.provider ? ` (${value.provider})` : ""}`;
  return [
    "Repository Manifest v1",
    "",
    `Repository: ${manifest.repository.id}`,
    `Profile: ${manifest.profile}`,
    `Runtime: ${system(manifest.runtime)}`,
    `Database: ${system(manifest.database)}`,
    `Capabilities: ${manifest.capabilities.join(", ") || "(none)"}`,
    `Required checks: ${manifest.checks.required.join(", ")}`,
    `Advisory checks: ${manifest.checks.advisory.join(", ") || "(none)"}`,
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parse(argv) {
  let file = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--file" || file !== null) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    file = value; index += 1;
  }
  return file ? { file, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/repository-manifest.js --file <manifest.json> [--json]"); return 1; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(options.file, "utf8")); }
  catch { console.error("Repository manifest cannot be read or parsed"); return 1; }
  const result = validateRepositoryManifest(raw);
  if (!result.valid || !result.manifest) { console.error("Repository manifest is invalid"); return 1; }
  console.log(options.json ? JSON.stringify(result.manifest) : formatRepositoryManifest(result.manifest));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
