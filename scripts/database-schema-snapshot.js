#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const SNAPSHOT_VERSION = 1;
const CONSTRAINT_TYPES = new Set([
  "primary_key",
  "unique",
  "foreign_key",
  "check",
  "exclusion",
]);

/** @typedef {{ name: string, type: string, nullable: boolean, default: string | null }} ColumnSnapshot */
/** @typedef {{ name: string, type: "primary_key" | "unique" | "foreign_key" | "check" | "exclusion", definition: string }} ConstraintSnapshot */
/** @typedef {{ name: string, unique: boolean, definition: string }} IndexSnapshot */
/** @typedef {{ name: string, columns: ColumnSnapshot[], constraints: ConstraintSnapshot[], indexes: IndexSnapshot[] }} TableSnapshot */
/** @typedef {{ name: string, values: string[] }} EnumSnapshot */
/** @typedef {{ name: string, materialized: boolean, definition: string }} ViewSnapshot */
/** @typedef {{ name: string, definition: string }} SequenceSnapshot */
/** @typedef {{ name: string, tables: TableSnapshot[], enums: EnumSnapshot[], views: ViewSnapshot[], sequences: SequenceSnapshot[] }} SchemaSnapshot */
/** @typedef {{ version: 1, engine: "postgresql", kind: "expected" | "observed", identity: { name: string, environment?: string }, evidence: { source: string, authenticated: boolean, collectedAt: string }, migrationManifestSha256?: string, schemas: SchemaSnapshot[] }} DatabaseSchemaSnapshot */
/** @typedef {{ id: string, detail: string }} SnapshotError */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function stringValue(value) {
  return typeof value === "string" ? value.trim() : null;
}

/** @param {unknown} value */
function definitionValue(value) {
  const text = stringValue(value);
  return text === null ? null : text.replace(/\s+/g, " ");
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {SnapshotError[]} errors */
function rejectUnknownFields(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {string} scope @param {string} name @param {Set<string>} seen @param {SnapshotError[]} errors */
function requireUniqueName(scope, name, seen, errors) {
  if (seen.has(name)) errors.push({ id: `${scope}-name-duplicate`, detail: `${scope} contains duplicate name "${name}"` });
  else seen.add(name);
}

/** @param {unknown} value @param {string} scope @param {SnapshotError[]} errors */
function normalizeColumns(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-columns-invalid`, detail: `${scope}.columns must be an array` });
    return [];
  }
  /** @type {ColumnSnapshot[]} */
  const columns = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "column-invalid", detail: `${scope}.columns[${index}] must be an object` });
      continue;
    }
    rejectUnknownFields(raw, ["name", "type", "nullable", "default"], "column", errors);
    const name = stringValue(raw.name);
    const type = definitionValue(raw.type);
    if (!name) errors.push({ id: "column-name-invalid", detail: `${scope}.columns[${index}].name must be non-empty` });
    if (!type) errors.push({ id: "column-type-invalid", detail: `${scope}.columns[${index}].type must be non-empty` });
    if (typeof raw.nullable !== "boolean") errors.push({ id: "column-nullable-invalid", detail: `${scope}.columns[${index}].nullable must be boolean` });
    if (raw.default !== null && typeof raw.default !== "string") errors.push({ id: "column-default-invalid", detail: `${scope}.columns[${index}].default must be string or null` });
    if (name) requireUniqueName("column", name, names, errors);
    if (name && type && typeof raw.nullable === "boolean" && (raw.default === null || typeof raw.default === "string")) {
      columns.push({
        name,
        type,
        nullable: raw.nullable,
        default: raw.default === null ? null : definitionValue(raw.default),
      });
    }
  }
  return columns.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {unknown} value @param {string} scope @param {SnapshotError[]} errors */
function normalizeConstraints(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-constraints-invalid`, detail: `${scope}.constraints must be an array` });
    return [];
  }
  /** @type {ConstraintSnapshot[]} */
  const constraints = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "constraint-invalid", detail: `${scope}.constraints[${index}] must be an object` });
      continue;
    }
    rejectUnknownFields(raw, ["name", "type", "definition"], "constraint", errors);
    const name = stringValue(raw.name);
    const type = stringValue(raw.type);
    const definition = definitionValue(raw.definition);
    if (!name) errors.push({ id: "constraint-name-invalid", detail: `${scope}.constraints[${index}].name must be non-empty` });
    if (!type || !CONSTRAINT_TYPES.has(type)) errors.push({ id: "constraint-type-invalid", detail: `${scope}.constraints[${index}].type is unsupported` });
    if (!definition) errors.push({ id: "constraint-definition-invalid", detail: `${scope}.constraints[${index}].definition must be non-empty` });
    if (name) requireUniqueName("constraint", name, names, errors);
    if (name && type && CONSTRAINT_TYPES.has(type) && definition) {
      constraints.push({ name, type: /** @type {ConstraintSnapshot["type"]} */ (type), definition });
    }
  }
  return constraints.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {unknown} value @param {string} scope @param {SnapshotError[]} errors */
function normalizeIndexes(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-indexes-invalid`, detail: `${scope}.indexes must be an array` });
    return [];
  }
  /** @type {IndexSnapshot[]} */
  const indexes = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "index-invalid", detail: `${scope}.indexes[${index}] must be an object` });
      continue;
    }
    rejectUnknownFields(raw, ["name", "unique", "definition"], "index", errors);
    const name = stringValue(raw.name);
    const definition = definitionValue(raw.definition);
    if (!name) errors.push({ id: "index-name-invalid", detail: `${scope}.indexes[${index}].name must be non-empty` });
    if (typeof raw.unique !== "boolean") errors.push({ id: "index-unique-invalid", detail: `${scope}.indexes[${index}].unique must be boolean` });
    if (!definition) errors.push({ id: "index-definition-invalid", detail: `${scope}.indexes[${index}].definition must be non-empty` });
    if (name) requireUniqueName("index", name, names, errors);
    if (name && typeof raw.unique === "boolean" && definition) indexes.push({ name, unique: raw.unique, definition });
  }
  return indexes.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {unknown} value @param {string} scope @param {SnapshotError[]} errors */
function normalizeTables(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-tables-invalid`, detail: `${scope}.tables must be an array` });
    return [];
  }
  /** @type {TableSnapshot[]} */
  const tables = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "table-invalid", detail: `${scope}.tables[${index}] must be an object` });
      continue;
    }
    rejectUnknownFields(raw, ["name", "columns", "constraints", "indexes"], "table", errors);
    const name = stringValue(raw.name);
    if (!name) {
      errors.push({ id: "table-name-invalid", detail: `${scope}.tables[${index}].name must be non-empty` });
      continue;
    }
    requireUniqueName("table", name, names, errors);
    const tableScope = `${scope}.table.${name}`;
    tables.push({
      name,
      columns: normalizeColumns(raw.columns, tableScope, errors),
      constraints: normalizeConstraints(raw.constraints, tableScope, errors),
      indexes: normalizeIndexes(raw.indexes, tableScope, errors),
    });
  }
  return tables.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {unknown} value @param {string} scope @param {SnapshotError[]} errors */
function normalizeEnums(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-enums-invalid`, detail: `${scope}.enums must be an array` });
    return [];
  }
  /** @type {EnumSnapshot[]} */
  const enums = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "enum-invalid", detail: `${scope}.enums[${index}] must be an object` });
      continue;
    }
    rejectUnknownFields(raw, ["name", "values"], "enum", errors);
    const name = stringValue(raw.name);
    if (!name) errors.push({ id: "enum-name-invalid", detail: `${scope}.enums[${index}].name must be non-empty` });
    if (name) requireUniqueName("enum", name, names, errors);
    /** @type {string[]} */
    const values = [];
    if (!Array.isArray(raw.values) || raw.values.length === 0) {
      errors.push({ id: "enum-values-invalid", detail: `${scope}.enums[${index}].values must be a non-empty array` });
    } else {
      const seen = new Set();
      for (const rawValue of raw.values) {
        const item = stringValue(rawValue);
        if (!item) errors.push({ id: "enum-value-invalid", detail: `${scope}.enums[${index}] contains an empty enum value` });
        else if (seen.has(item)) errors.push({ id: "enum-value-duplicate", detail: `${scope}.enums[${index}] contains duplicate enum value "${item}"` });
        else { seen.add(item); values.push(item); }
      }
    }
    if (name && values.length > 0) enums.push({ name, values });
  }
  return enums.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {unknown} value @param {string} scope @param {SnapshotError[]} errors */
function normalizeViews(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-views-invalid`, detail: `${scope}.views must be an array` });
    return [];
  }
  /** @type {ViewSnapshot[]} */
  const views = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "view-invalid", detail: `${scope}.views[${index}] must be an object` });
      continue;
    }
    rejectUnknownFields(raw, ["name", "materialized", "definition"], "view", errors);
    const name = stringValue(raw.name);
    const definition = definitionValue(raw.definition);
    if (!name) errors.push({ id: "view-name-invalid", detail: `${scope}.views[${index}].name must be non-empty` });
    if (typeof raw.materialized !== "boolean") errors.push({ id: "view-materialized-invalid", detail: `${scope}.views[${index}].materialized must be boolean` });
    if (!definition) errors.push({ id: "view-definition-invalid", detail: `${scope}.views[${index}].definition must be non-empty` });
    if (name) requireUniqueName("view", name, names, errors);
    if (name && typeof raw.materialized === "boolean" && definition) views.push({ name, materialized: raw.materialized, definition });
  }
  return views.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {unknown} value @param {string} scope @param {SnapshotError[]} errors */
function normalizeSequences(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: `${scope}-sequences-invalid`, detail: `${scope}.sequences must be an array` });
    return [];
  }
  /** @type {SequenceSnapshot[]} */
  const sequences = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "sequence-invalid", detail: `${scope}.sequences[${index}] must be an object` });
      continue;
    }
    rejectUnknownFields(raw, ["name", "definition"], "sequence", errors);
    const name = stringValue(raw.name);
    const definition = definitionValue(raw.definition);
    if (!name) errors.push({ id: "sequence-name-invalid", detail: `${scope}.sequences[${index}].name must be non-empty` });
    if (!definition) errors.push({ id: "sequence-definition-invalid", detail: `${scope}.sequences[${index}].definition must be non-empty` });
    if (name) requireUniqueName("sequence", name, names, errors);
    if (name && definition) sequences.push({ name, definition });
  }
  return sequences.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {unknown} value @param {SnapshotError[]} errors */
function normalizeSchemas(value, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ id: "schemas-invalid", detail: "schemas must be a non-empty array" });
    return [];
  }
  /** @type {SchemaSnapshot[]} */
  const schemas = [];
  const names = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "schema-invalid", detail: `schemas[${index}] must be an object` });
      continue;
    }
    rejectUnknownFields(raw, ["name", "tables", "enums", "views", "sequences"], "schema", errors);
    const name = stringValue(raw.name);
    if (!name) {
      errors.push({ id: "schema-name-invalid", detail: `schemas[${index}].name must be non-empty` });
      continue;
    }
    requireUniqueName("schema", name, names, errors);
    const scope = `schema.${name}`;
    schemas.push({
      name,
      tables: normalizeTables(raw.tables, scope, errors),
      enums: normalizeEnums(raw.enums, scope, errors),
      views: normalizeViews(raw.views, scope, errors),
      sequences: normalizeSequences(raw.sequences, scope, errors),
    });
  }
  return schemas.sort((a, b) => a.name.localeCompare(b.name));
}

/** @param {unknown} value */
export function validateDatabaseSchemaSnapshot(value) {
  /** @type {SnapshotError[]} */
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, snapshot: null, errors: [{ id: "snapshot-invalid", detail: "database schema snapshot must be a JSON object" }] };
  }
  rejectUnknownFields(
    value,
    ["version", "engine", "kind", "identity", "evidence", "migrationManifestSha256", "schemas"],
    "snapshot",
    errors,
  );
  if (value.version !== SNAPSHOT_VERSION) errors.push({ id: "version-invalid", detail: `version must be exactly ${SNAPSHOT_VERSION}` });
  if (value.engine !== "postgresql") errors.push({ id: "engine-invalid", detail: "engine must be postgresql" });
  if (value.kind !== "expected" && value.kind !== "observed") errors.push({ id: "kind-invalid", detail: "kind must be expected or observed" });

  const identity = value.identity;
  /** @type {{ name?: string, environment?: string }} */
  const normalizedIdentity = {};
  if (!isPlainObject(identity)) {
    errors.push({ id: "identity-invalid", detail: "identity must be an object" });
  } else {
    rejectUnknownFields(identity, ["name", "environment"], "identity", errors);
    const name = stringValue(identity.name);
    if (!name) errors.push({ id: "identity-name-invalid", detail: "identity.name must be non-empty" });
    else normalizedIdentity.name = name;
    if (identity.environment !== undefined) {
      const environment = stringValue(identity.environment);
      if (!environment) errors.push({ id: "identity-environment-invalid", detail: "identity.environment must be non-empty when supplied" });
      else normalizedIdentity.environment = environment;
    }
  }

  const evidence = value.evidence;
  /** @type {{ source?: string, authenticated?: boolean, collectedAt?: string }} */
  const normalizedEvidence = {};
  if (!isPlainObject(evidence)) {
    errors.push({ id: "evidence-invalid", detail: "evidence must be an object" });
  } else {
    rejectUnknownFields(evidence, ["source", "authenticated", "collectedAt"], "evidence", errors);
    const source = stringValue(evidence.source);
    const collectedAt = stringValue(evidence.collectedAt);
    if (!source) errors.push({ id: "evidence-source-invalid", detail: "evidence.source must be non-empty" });
    else normalizedEvidence.source = source;
    if (typeof evidence.authenticated !== "boolean") errors.push({ id: "evidence-authenticated-invalid", detail: "evidence.authenticated must be boolean" });
    else normalizedEvidence.authenticated = evidence.authenticated;
    if (!collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) errors.push({ id: "evidence-collected-at-invalid", detail: "evidence.collectedAt must be an absolute ISO 8601 timestamp" });
    else normalizedEvidence.collectedAt = collectedAt;
  }

  let migrationManifestSha256;
  if (value.migrationManifestSha256 !== undefined) {
    const digest = stringValue(value.migrationManifestSha256);
    if (!digest || !/^[0-9a-fA-F]{64}$/.test(digest)) errors.push({ id: "migration-manifest-digest-invalid", detail: "migrationManifestSha256 must be 64 hexadecimal characters" });
    else migrationManifestSha256 = digest.toLowerCase();
  }
  if (value.kind === "expected" && migrationManifestSha256 === undefined) {
    errors.push({ id: "expected-migration-binding-missing", detail: "expected snapshots require migrationManifestSha256" });
  }

  const schemas = normalizeSchemas(value.schemas, errors);
  if (errors.length > 0) return { ok: false, snapshot: null, errors };
  /** @type {DatabaseSchemaSnapshot} */
  const snapshot = {
    version: 1,
    engine: "postgresql",
    kind: /** @type {"expected" | "observed"} */ (value.kind),
    identity: /** @type {{ name: string, environment?: string }} */ (normalizedIdentity),
    evidence: /** @type {{ source: string, authenticated: boolean, collectedAt: string }} */ (normalizedEvidence),
    ...(migrationManifestSha256 === undefined ? {} : { migrationManifestSha256 }),
    schemas,
  };
  return { ok: true, snapshot, errors: [] };
}

/** @param {ReturnType<typeof validateDatabaseSchemaSnapshot>} result */
export function formatDatabaseSchemaSnapshot(result) {
  const lines = ["Database schema snapshot", ""];
  if (!result.ok || !result.snapshot) {
    lines.push("Result: INVALID");
    for (const error of result.errors) lines.push(`ERROR  ${error.id}  ${error.detail}`);
    return lines.join("\n");
  }
  const snapshot = result.snapshot;
  const tableCount = snapshot.schemas.reduce((total, schema) => total + schema.tables.length, 0);
  const enumCount = snapshot.schemas.reduce((total, schema) => total + schema.enums.length, 0);
  const viewCount = snapshot.schemas.reduce((total, schema) => total + schema.views.length, 0);
  lines.push(
    `Engine: ${snapshot.engine}`,
    `Kind: ${snapshot.kind}`,
    `Identity: ${snapshot.identity.name}`,
    `Environment: ${snapshot.identity.environment ?? "(not supplied)"}`,
    `Source: ${snapshot.evidence.source}`,
    `Authenticated: ${snapshot.evidence.authenticated}`,
    `Collected at: ${snapshot.evidence.collectedAt}`,
    `Migration manifest: ${snapshot.migrationManifestSha256 ?? "(not supplied)"}`,
    `Schemas: ${snapshot.schemas.length}`,
    `Tables: ${tableCount}`,
    `Enums: ${enumCount}`,
    `Views: ${viewCount}`,
    "",
    "Result: VALID",
  );
  return lines.join("\n");
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  let file = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") json = true;
    else if (argument === "--file") {
      const value = argv[index + 1];
      if (file !== null || typeof value !== "string" || !value || value.startsWith("--")) return null;
      file = value;
      index += 1;
    } else return null;
  }
  return file === null ? null : { file, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/database-schema-snapshot.js --file <schema-snapshot.json> [--json]");
    return 1;
  }
  let value;
  try {
    value = JSON.parse(fs.readFileSync(options.file, "utf8"));
  } catch (error) {
    const result = {
      ok: false,
      snapshot: null,
      errors: [{
        id: error instanceof SyntaxError ? "snapshot-json-invalid" : "snapshot-file-unreadable",
        detail: error instanceof SyntaxError ? "schema snapshot contains invalid JSON" : "schema snapshot file cannot be read",
      }],
    };
    console.log(options.json ? JSON.stringify(result) : formatDatabaseSchemaSnapshot(result));
    return 1;
  }
  const result = validateDatabaseSchemaSnapshot(value);
  console.log(options.json ? JSON.stringify(result) : formatDatabaseSchemaSnapshot(result));
  return result.ok ? 0 : 1;
}

// This contract validator reads only an explicit JSON snapshot file. It performs
// no database, Git, network, shell, environment, migration, or write operation.
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
