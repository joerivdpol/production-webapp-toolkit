#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

/** @typedef {{ grantee: string, privileges: string[] }} GrantSnapshot */
/** @typedef {{ name: string, command: string, roles: string[], permissive: boolean, usingAlwaysTrue: boolean | null, checkAlwaysTrue: boolean | null }} PolicySnapshot */
/** @typedef {{ name: string, rlsEnabled: boolean, rlsForced: boolean, grants: GrantSnapshot[], policies: PolicySnapshot[] }} SecurityTableSnapshot */
/** @typedef {{ name: string, identityArguments: string, securityDefiner: boolean, searchPath: string[] | null, grants: GrantSnapshot[] }} FunctionSecuritySnapshot */
/** @typedef {{ name: string, grants: GrantSnapshot[] }} SequenceSecuritySnapshot */
/** @typedef {{ name: string, grants: GrantSnapshot[], tables: SecurityTableSnapshot[], functions: FunctionSecuritySnapshot[], sequences: SequenceSecuritySnapshot[] }} SecuritySchemaSnapshot */
/** @typedef {{ version: 1, engine: "postgresql", identity: { name: string, environment?: string }, evidence: { source: string, authenticated: boolean, collectedAt: string }, schemas: SecuritySchemaSnapshot[] }} PostgresSecuritySnapshot */
/** @typedef {{ id: string, detail: string }} SecuritySnapshotError */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {SecuritySnapshotError[]} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {string} scope @param {string} name @param {Set<string>} seen @param {SecuritySnapshotError[]} errors */
function requireUnique(scope, name, seen, errors) {
  if (seen.has(name)) errors.push({ id: `${scope}-duplicate`, detail: `${scope} contains duplicate "${name}"` });
  else seen.add(name);
}

/** @param {unknown} value @param {string} scope @param {SecuritySnapshotError[]} errors */
function normalizeGrants(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-grants-invalid`, detail: `${scope}.grants must be an array` });
    return [];
  }
  /** @type {GrantSnapshot[]} */
  const grants = [];
  const seen = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "grant-invalid", detail: `${scope}.grants[${index}] must be an object` });
      continue;
    }
    rejectUnknown(raw, ["grantee", "privileges"], "grant", errors);
    const grantee = nonEmptyString(raw.grantee);
    if (!grantee) errors.push({ id: "grant-grantee-invalid", detail: `${scope}.grants[${index}].grantee must be non-empty` });
    if (!Array.isArray(raw.privileges) || raw.privileges.length === 0) {
      errors.push({ id: "grant-privileges-invalid", detail: `${scope}.grants[${index}].privileges must be a non-empty array` });
      continue;
    }
    const privileges = raw.privileges.map((item) => nonEmptyString(item)?.toUpperCase() ?? null);
    if (privileges.some((item) => item === null) || new Set(privileges).size !== privileges.length) {
      errors.push({ id: "grant-privileges-invalid", detail: `${scope}.grants[${index}].privileges must contain unique non-empty names` });
      continue;
    }
    if (!grantee) continue;
    requireUnique("grant grantee", grantee, seen, errors);
    grants.push({ grantee, privileges: /** @type {string[]} */ (privileges).sort() });
  }
  return grants.sort((a, b) => a.grantee.localeCompare(b.grantee));
}
/** @param {unknown} value @param {string} scope @param {SecuritySnapshotError[]} errors */
function normalizePolicies(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-policies-invalid`, detail: `${scope}.policies must be an array` });
    return [];
  }
  /** @type {PolicySnapshot[]} */
  const policies = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "policy-invalid", detail: `${scope}.policies[${index}] must be an object` });
      continue;
    }
    rejectUnknown(raw, ["name", "command", "roles", "permissive", "usingAlwaysTrue", "checkAlwaysTrue"], "policy", errors);
    const name = nonEmptyString(raw.name);
    const command = nonEmptyString(raw.command)?.toUpperCase() ?? null;
    if (!name) errors.push({ id: "policy-name-invalid", detail: `${scope}.policies[${index}].name must be non-empty` });
    if (!command || !["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"].includes(command)) errors.push({ id: "policy-command-invalid", detail: `${scope}.policies[${index}].command is unsupported` });
    if (!Array.isArray(raw.roles) || raw.roles.length === 0) {
      errors.push({ id: "policy-roles-invalid", detail: `${scope}.policies[${index}].roles must be a non-empty array` });
      continue;
    }
    const roles = raw.roles.map((item) => nonEmptyString(item)).filter((item) => item !== null);
    if (roles.length !== raw.roles.length || new Set(roles).size !== roles.length) {
      errors.push({ id: "policy-roles-invalid", detail: `${scope}.policies[${index}].roles must contain unique non-empty names` });
      continue;
    }
    if (typeof raw.permissive !== "boolean") errors.push({ id: "policy-permissive-invalid", detail: `${scope}.policies[${index}].permissive must be boolean` });
    for (const key of ["usingAlwaysTrue", "checkAlwaysTrue"]) {
      if (raw[key] !== null && typeof raw[key] !== "boolean") errors.push({ id: `policy-${key}-invalid`, detail: `${scope}.policies[${index}].${key} must be boolean or null` });
    }
    if (!name || !command || typeof raw.permissive !== "boolean" || (raw.usingAlwaysTrue !== null && typeof raw.usingAlwaysTrue !== "boolean") || (raw.checkAlwaysTrue !== null && typeof raw.checkAlwaysTrue !== "boolean")) continue;
    requireUnique("policy", name, names, errors);
    policies.push({
      name,
      command,
      roles: /** @type {string[]} */ (roles).sort(),
      permissive: raw.permissive,
      usingAlwaysTrue: raw.usingAlwaysTrue,
      checkAlwaysTrue: raw.checkAlwaysTrue,
    });
  }
  return policies.sort((a, b) => a.name.localeCompare(b.name));
}
/** @param {unknown} value @param {string} scope @param {SecuritySnapshotError[]} errors */
function normalizeTables(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-tables-invalid`, detail: `${scope}.tables must be an array` });
    return [];
  }
  /** @type {SecurityTableSnapshot[]} */
  const tables = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "table-invalid", detail: `${scope}.tables[${index}] must be an object` });
      continue;
    }
    rejectUnknown(raw, ["name", "rlsEnabled", "rlsForced", "grants", "policies"], "table", errors);
    const name = nonEmptyString(raw.name);
    if (!name) errors.push({ id: "table-name-invalid", detail: `${scope}.tables[${index}].name must be non-empty` });
    if (typeof raw.rlsEnabled !== "boolean") errors.push({ id: "table-rls-enabled-invalid", detail: `${scope}.tables[${index}].rlsEnabled must be boolean` });
    if (typeof raw.rlsForced !== "boolean") errors.push({ id: "table-rls-forced-invalid", detail: `${scope}.tables[${index}].rlsForced must be boolean` });
    const grants = normalizeGrants(raw.grants, `${scope}.tables[${index}]`, errors);
    const policies = normalizePolicies(raw.policies, `${scope}.tables[${index}]`, errors);
    if (!name || typeof raw.rlsEnabled !== "boolean" || typeof raw.rlsForced !== "boolean") continue;
    requireUnique("table", name, names, errors);
    tables.push({ name, rlsEnabled: raw.rlsEnabled, rlsForced: raw.rlsForced, grants, policies });
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}
/** @param {unknown} value @param {string} scope @param {SecuritySnapshotError[]} errors */
function normalizeFunctions(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-functions-invalid`, detail: `${scope}.functions must be an array` });
    return [];
  }
  /** @type {FunctionSecuritySnapshot[]} */
  const functions = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "function-invalid", detail: `${scope}.functions[${index}] must be an object` });
      continue;
    }
    rejectUnknown(raw, ["name", "identityArguments", "securityDefiner", "searchPath", "grants"], "function", errors);
    const name = nonEmptyString(raw.name);
    const identityArguments = typeof raw.identityArguments === "string" ? raw.identityArguments.trim() : null;
    if (!name) errors.push({ id: "function-name-invalid", detail: `${scope}.functions[${index}].name must be non-empty` });
    if (identityArguments === null) errors.push({ id: "function-identity-arguments-invalid", detail: `${scope}.functions[${index}].identityArguments must be a string` });
    if (typeof raw.securityDefiner !== "boolean") errors.push({ id: "function-security-definer-invalid", detail: `${scope}.functions[${index}].securityDefiner must be boolean` });
    let searchPath = null;
    if (raw.searchPath !== null) {
      if (!Array.isArray(raw.searchPath) || raw.searchPath.some((item) => !nonEmptyString(item))) {
        errors.push({ id: "function-search-path-invalid", detail: `${scope}.functions[${index}].searchPath must be null or an array of non-empty strings` });
      } else {
        const entries = raw.searchPath.map((item) => /** @type {string} */ (nonEmptyString(item)));
        if (new Set(entries).size !== entries.length) errors.push({ id: "function-search-path-duplicate", detail: `${scope}.functions[${index}].searchPath entries must be unique` });
        else searchPath = entries;
      }
    }
    const grants = normalizeGrants(raw.grants, `${scope}.functions[${index}]`, errors);
    if (!name || identityArguments === null || typeof raw.securityDefiner !== "boolean") continue;
    const signature = `${name}(${identityArguments})`;
    requireUnique("function signature", signature, names, errors);
    functions.push({ name, identityArguments, securityDefiner: raw.securityDefiner, searchPath, grants });
  }
  return functions.sort((a, b) => `${a.name}(${a.identityArguments})`.localeCompare(`${b.name}(${b.identityArguments})`));
}

/** @param {unknown} value @param {string} scope @param {SecuritySnapshotError[]} errors */
function normalizeSequences(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-sequences-invalid`, detail: `${scope}.sequences must be an array` });
    return [];
  }
  /** @type {SequenceSecuritySnapshot[]} */
  const sequences = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "sequence-invalid", detail: `${scope}.sequences[${index}] must be an object` });
      continue;
    }
    rejectUnknown(raw, ["name", "grants"], "sequence", errors);
    const name = nonEmptyString(raw.name);
    if (!name) errors.push({ id: "sequence-name-invalid", detail: `${scope}.sequences[${index}].name must be non-empty` });
    const grants = normalizeGrants(raw.grants, `${scope}.sequences[${index}]`, errors);
    if (!name) continue;
    requireUnique("sequence", name, names, errors);
    sequences.push({ name, grants });
  }
  return sequences.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {unknown} value @param {SecuritySnapshotError[]} errors */
function normalizeSchemas(value, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ id: "schemas-invalid", detail: "schemas must be a non-empty array" });
    return [];
  }
  /** @type {SecuritySchemaSnapshot[]} */
  const schemas = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "schema-invalid", detail: `schemas[${index}] must be an object` });
      continue;
    }
    rejectUnknown(raw, ["name", "grants", "tables", "functions", "sequences"], "schema", errors);
    const name = nonEmptyString(raw.name);
    if (!name) errors.push({ id: "schema-name-invalid", detail: `schemas[${index}].name must be non-empty` });
    const scope = `schemas[${index}]`;
    const grants = normalizeGrants(raw.grants, scope, errors);
    const tables = normalizeTables(raw.tables, scope, errors);
    const functions = normalizeFunctions(raw.functions, scope, errors);
    const sequences = normalizeSequences(raw.sequences, scope, errors);
    if (!name) continue;
    requireUnique("schema", name, names, errors);
    schemas.push({ name, grants, tables, functions, sequences });
  }
  return schemas.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {unknown} value */
export function validatePostgresSecuritySnapshot(value) {
  /** @type {SecuritySnapshotError[]} */
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, snapshot: null, errors: [{ id: "snapshot-invalid", detail: "PostgreSQL security snapshot must be an object" }] };
  rejectUnknown(value, ["version", "engine", "identity", "evidence", "schemas"], "snapshot", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (value.engine !== "postgresql") errors.push({ id: "engine-invalid", detail: "engine must be postgresql" });

  let identity = null;
  if (!isPlainObject(value.identity)) errors.push({ id: "identity-invalid", detail: "identity must be an object" });
  else {
    rejectUnknown(value.identity, ["name", "environment"], "identity", errors);
    const name = nonEmptyString(value.identity.name);
    const environment = value.identity.environment === undefined ? null : nonEmptyString(value.identity.environment);
    if (!name) errors.push({ id: "identity-name-invalid", detail: "identity.name must be non-empty" });
    if (value.identity.environment !== undefined && !environment) errors.push({ id: "identity-environment-invalid", detail: "identity.environment must be non-empty when supplied" });
    if (name && (value.identity.environment === undefined || environment)) identity = { name, ...(environment ? { environment } : {}) };
  }

  let evidence = null;
  if (!isPlainObject(value.evidence)) errors.push({ id: "evidence-invalid", detail: "evidence must be an object" });
  else {
    rejectUnknown(value.evidence, ["source", "authenticated", "collectedAt"], "evidence", errors);
    const source = nonEmptyString(value.evidence.source);
    const collectedAt = nonEmptyString(value.evidence.collectedAt);
    if (!source) errors.push({ id: "evidence-source-invalid", detail: "evidence.source must be non-empty" });
    if (typeof value.evidence.authenticated !== "boolean") errors.push({ id: "evidence-authenticated-invalid", detail: "evidence.authenticated must be boolean" });
    if (!collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) errors.push({ id: "evidence-collected-at-invalid", detail: "evidence.collectedAt must be an absolute ISO timestamp" });
    if (source && typeof value.evidence.authenticated === "boolean" && collectedAt && isAbsoluteIsoTimestamp(collectedAt)) {
      evidence = { source, authenticated: value.evidence.authenticated, collectedAt };
    }
  }

  const schemas = normalizeSchemas(value.schemas, errors);
  if (errors.length > 0 || identity === null || evidence === null) return { ok: false, snapshot: null, errors };
  return {
    ok: true,
    snapshot: /** @type {PostgresSecuritySnapshot} */ ({
      version: 1,
      engine: "postgresql",
      identity,
      evidence,
      schemas,
    }),
    errors: [],
  };
}

/** @param {PostgresSecuritySnapshot} snapshot */
export function formatPostgresSecuritySnapshot(snapshot) {
  const tableCount = snapshot.schemas.reduce((total, schema) => total + schema.tables.length, 0);
  const functionCount = snapshot.schemas.reduce((total, schema) => total + schema.functions.length, 0);
  return [
    "PostgreSQL security snapshot",
    "",
    `Database identity: ${snapshot.identity.name}`,
    `Environment: ${snapshot.identity.environment ?? "(not supplied)"}`,
    `Schemas: ${snapshot.schemas.map((item) => item.name).join(", ")}`,
    `Tables: ${tableCount}`,
    `Functions: ${functionCount}`,
    `Source: ${snapshot.evidence.source}`,
    `Authenticated: ${snapshot.evidence.authenticated}`,
    `Collected at: ${snapshot.evidence.collectedAt}`,
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
    console.error("Usage: node scripts/postgres-security-snapshot.js --file <security-snapshot.json> [--json]");
    return 1;
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(options.file, "utf8")); }
  catch { console.error("PostgreSQL security snapshot file cannot be read or parsed"); return 1; }
  const result = validatePostgresSecuritySnapshot(value);
  if (!result.ok || result.snapshot === null) {
    console.error("PostgreSQL security snapshot is invalid");
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.snapshot) : formatPostgresSecuritySnapshot(result.snapshot));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
