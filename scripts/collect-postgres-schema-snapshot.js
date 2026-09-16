#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateDatabaseSchemaSnapshot } from "./database-schema-snapshot.js";

const MAX_PSQL_OUTPUT_BYTES = 32 * 1024 * 1024;
const CATALOG_KEYS = [
  "tables",
  "columns",
  "constraints",
  "indexes",
  "enums",
  "views",
  "sequences",
];

/** @typedef {{ tables: any[], columns: any[], constraints: any[], indexes: any[], enums: any[], views: any[], sequences: any[] }} PostgresCatalogPayload */

/** @param {string} value */
function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** @param {unknown} value */
function validIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value);
}

/** @param {unknown} value */
function validService(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value);
}

/** @param {string[]} schemas */
export function buildPostgresCatalogQuery(schemas) {
  if (!Array.isArray(schemas) || schemas.length === 0 || schemas.some((item) => !validIdentifier(item))) {
    throw new Error("schemas must be non-empty PostgreSQL identifiers");
  }
  const schemaList = schemas.map(quoteLiteral).join(", ");
  return `BEGIN READ ONLY;
SELECT 'tables', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname, 'name', c.relname
) ORDER BY n.nspname, c.relname), '[]'::jsonb)::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN (${schemaList}) AND c.relkind IN ('r','p');

SELECT 'columns', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'table', c.relname,
  'name', a.attname,
  'type', pg_catalog.format_type(a.atttypid, a.atttypmod),
  'nullable', NOT a.attnotnull,
  'default', CASE WHEN ad.oid IS NULL THEN NULL ELSE pg_get_expr(ad.adbin, ad.adrelid, true) END
) ORDER BY n.nspname, c.relname, a.attnum), '[]'::jsonb)::text
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
WHERE n.nspname IN (${schemaList}) AND c.relkind IN ('r','p') AND a.attnum > 0 AND NOT a.attisdropped;

SELECT 'constraints', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'table', c.relname,
  'name', con.conname,
  'type', CASE con.contype
    WHEN 'p' THEN 'primary_key'
    WHEN 'u' THEN 'unique'
    WHEN 'f' THEN 'foreign_key'
    WHEN 'c' THEN 'check'
    WHEN 'x' THEN 'exclusion'
  END,
  'definition', pg_get_constraintdef(con.oid, true)
) ORDER BY n.nspname, c.relname, con.conname), '[]'::jsonb)::text
FROM pg_constraint con
JOIN pg_class c ON c.oid = con.conrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN (${schemaList}) AND c.relkind IN ('r','p') AND con.contype IN ('p','u','f','c','x');

SELECT 'indexes', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'table', t.relname,
  'name', i.relname,
  'unique', x.indisunique,
  'definition', pg_get_indexdef(i.oid)
) ORDER BY n.nspname, t.relname, i.relname), '[]'::jsonb)::text
FROM pg_index x
JOIN pg_class t ON t.oid = x.indrelid
JOIN pg_class i ON i.oid = x.indexrelid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname IN (${schemaList}) AND t.relkind IN ('r','p');

SELECT 'enums', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'name', t.typname,
  'values', vals.values
) ORDER BY n.nspname, t.typname), '[]'::jsonb)::text
FROM pg_type t
JOIN pg_namespace n ON n.oid = t.typnamespace
JOIN LATERAL (
  SELECT jsonb_agg(e.enumlabel ORDER BY e.enumsortorder) AS values
  FROM pg_enum e
  WHERE e.enumtypid = t.oid
) vals ON vals.values IS NOT NULL
WHERE n.nspname IN (${schemaList});

SELECT 'views', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'name', c.relname,
  'materialized', c.relkind = 'm',
  'definition', pg_get_viewdef(c.oid, true)
) ORDER BY n.nspname, c.relname), '[]'::jsonb)::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN (${schemaList}) AND c.relkind IN ('v','m');

SELECT 'sequences', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', s.schemaname,
  'name', s.sequencename,
  'definition', format('data_type=%s;start=%s;min=%s;max=%s;increment=%s;cycle=%s;cache=%s',
    s.data_type, s.start_value, s.min_value, s.max_value, s.increment_by, s.cycle, s.cache_size)
) ORDER BY s.schemaname, s.sequencename), '[]'::jsonb)::text
FROM pg_sequences s
WHERE s.schemaname IN (${schemaList});
COMMIT;
`;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {string} output */
export function parsePostgresCatalogOutput(output) {
  /** @type {Record<string, unknown[]>} */
  const values = {};
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    const json = line.slice(separator + 1);
    if (!CATALOG_KEYS.includes(key)) continue;
    if (values[key] !== undefined) return { ok: false, catalog: null, error: `duplicate PostgreSQL catalog section ${key}` };
    let parsed;
    try { parsed = JSON.parse(json); }
    catch { return { ok: false, catalog: null, error: `PostgreSQL catalog section ${key} is not valid JSON` }; }
    if (!Array.isArray(parsed)) return { ok: false, catalog: null, error: `PostgreSQL catalog section ${key} must be an array` };
    values[key] = parsed;
  }
  for (const key of CATALOG_KEYS) {
    if (values[key] === undefined) return { ok: false, catalog: null, error: `PostgreSQL catalog output is missing section ${key}` };
  }
  return { ok: true, catalog: /** @type {PostgresCatalogPayload} */ (values), error: null };
}

/** @param {PostgresCatalogPayload} catalog @param {{ identityName: string, environment?: string | null, schemas: string[], collectedAt: string }} options */
export function buildObservedPostgresSchemaSnapshot(catalog, options) {
  const identityName = nonEmptyString(options.identityName);
  if (!identityName) return { ok: false, snapshot: null, error: "identityName must be non-empty" };
  const environment = (options.environment === null || options.environment === undefined) ? null : nonEmptyString(options.environment);
  if (options.environment !== null && options.environment !== undefined && !environment) return { ok: false, snapshot: null, error: "environment must be non-empty when supplied" };
  if (!Array.isArray(options.schemas) || options.schemas.length === 0 || options.schemas.some((item) => !validIdentifier(item))) {
    return { ok: false, snapshot: null, error: "schemas must be explicit PostgreSQL identifiers" };
  }
  if (typeof options.collectedAt !== "string" || options.collectedAt.trim().length === 0) {
    return { ok: false, snapshot: null, error: "collectedAt is required" };
  }

  const schemaNames = new Set(options.schemas);
  /** @type {Map<string, any>} */
  const schemas = new Map(options.schemas.map((name) => [name, { name, tables: [], enums: [], views: [], sequences: [] }]));
  /** @type {Map<string, any>} */
  const tables = new Map();

  for (const raw of catalog.tables) {
    if (!isPlainObject(raw)) return { ok: false, snapshot: null, error: "catalog tables must contain objects" };
    const schema = nonEmptyString(raw.schema);
    const name = nonEmptyString(raw.name);
    if (!schema || !name || !schemaNames.has(schema)) return { ok: false, snapshot: null, error: "catalog table has invalid schema or name" };
    const key = `${schema}.${name}`;
    if (tables.has(key)) return { ok: false, snapshot: null, error: `catalog contains duplicate table ${key}` };
    const table = { name, columns: [], constraints: [], indexes: [] };
    tables.set(key, table);
    schemas.get(schema).tables.push(table);
  }

  /** @param {Record<string, unknown>} raw @param {string} section */
  const tableFor = (raw, section) => {
    const schema = nonEmptyString(raw.schema);
    const table = nonEmptyString(raw.table);
    if (!schema || !table || !schemaNames.has(schema)) throw new Error(`${section} row has invalid schema or table`);
    const target = tables.get(`${schema}.${table}`);
    if (!target) throw new Error(`${section} row references unknown table ${schema}.${table}`);
    return target;
  };

  try {
    for (const raw of catalog.columns) {
      if (!isPlainObject(raw)) throw new Error("catalog columns must contain objects");
      const target = tableFor(raw, "column");
      const name = nonEmptyString(raw.name);
      const type = nonEmptyString(raw.type);
      if (!name || !type || typeof raw.nullable !== "boolean" || (raw.default !== null && typeof raw.default !== "string")) {
        throw new Error("catalog column has invalid fields");
      }
      target.columns.push({ name, type, nullable: raw.nullable, default: raw.default });
    }

    for (const raw of catalog.constraints) {
      if (!isPlainObject(raw)) throw new Error("catalog constraints must contain objects");
      const target = tableFor(raw, "constraint");
      const name = nonEmptyString(raw.name);
      const type = nonEmptyString(raw.type);
      const definition = nonEmptyString(raw.definition);
      if (!name || !type || !definition) throw new Error("catalog constraint has invalid fields");
      target.constraints.push({ name, type, definition });
    }

    for (const raw of catalog.indexes) {
      if (!isPlainObject(raw)) throw new Error("catalog indexes must contain objects");
      const target = tableFor(raw, "index");
      const name = nonEmptyString(raw.name);
      const definition = nonEmptyString(raw.definition);
      if (!name || !definition || typeof raw.unique !== "boolean") throw new Error("catalog index has invalid fields");
      target.indexes.push({ name, unique: raw.unique, definition });
    }

    for (const raw of catalog.enums) {
      if (!isPlainObject(raw)) throw new Error("catalog enums must contain objects");
      const schema = nonEmptyString(raw.schema);
      const name = nonEmptyString(raw.name);
      if (!schema || !schemaNames.has(schema) || !name || !Array.isArray(raw.values) || raw.values.some((item) => typeof item !== "string")) {
        throw new Error("catalog enum has invalid fields");
      }
      schemas.get(schema).enums.push({ name, values: raw.values });
    }

    for (const raw of catalog.views) {
      if (!isPlainObject(raw)) throw new Error("catalog views must contain objects");
      const schema = nonEmptyString(raw.schema);
      const name = nonEmptyString(raw.name);
      const definition = nonEmptyString(raw.definition);
      if (!schema || !schemaNames.has(schema) || !name || !definition || typeof raw.materialized !== "boolean") {
        throw new Error("catalog view has invalid fields");
      }
      schemas.get(schema).views.push({ name, materialized: raw.materialized, definition });
    }

    for (const raw of catalog.sequences) {
      if (!isPlainObject(raw)) throw new Error("catalog sequences must contain objects");
      const schema = nonEmptyString(raw.schema);
      const name = nonEmptyString(raw.name);
      const definition = nonEmptyString(raw.definition);
      if (!schema || !schemaNames.has(schema) || !name || !definition) throw new Error("catalog sequence has invalid fields");
      schemas.get(schema).sequences.push({ name, definition });
    }
  } catch (error) {
    return { ok: false, snapshot: null, error: error instanceof Error ? error.message : "invalid PostgreSQL catalog payload" };
  }

  const candidate = {
    version: 1,
    engine: "postgresql",
    kind: "observed",
    identity: {
      name: identityName,
      ...(environment === null ? {} : { environment }),
    },
    evidence: {
      source: "postgresql-psql-catalog",
      authenticated: true,
      collectedAt: options.collectedAt,
    },
    schemas: [...schemas.values()],
  };
  const validation = validateDatabaseSchemaSnapshot(candidate);
  if (!validation.ok || validation.snapshot === null) {
    return { ok: false, snapshot: null, error: "generated PostgreSQL snapshot does not satisfy Database Schema Snapshot v1" };
  }
  return { ok: true, snapshot: validation.snapshot, error: null };
}

/**
 * @param {string} service
 * @param {string} query
 * @returns {{ ok: true, output: string } | { ok: false, error: { id: string, detail: string } }}
 */
function runPsql(service, query) {
  const result = spawnSync("psql", [
    "--no-psqlrc",
    "--set", "ON_ERROR_STOP=1",
    "--no-align",
    "--tuples-only",
    "--field-separator", "\t",
    "--quiet",
    "--dbname", `service=${service}`,
    "--command", query,
  ], {
    encoding: "utf8",
    maxBuffer: MAX_PSQL_OUTPUT_BYTES,
  });
  if (result.error || result.status !== 0) {
    return { ok: false, error: { id: "psql-collection-failed", detail: "PostgreSQL catalog collection failed" } };
  }
  return { ok: true, output: result.stdout ?? "" };
}

/**
 * @param {{ service: string, identityName: string, environment?: string | null, schemas: string[] }} options
 * @param {{ runPsql?: typeof runPsql, now?: () => string }} [dependencies]
 */
export function collectPostgresSchemaSnapshot(options, dependencies = {}) {
  const service = nonEmptyString(options.service);
  const identityName = nonEmptyString(options.identityName);
  const environment = (options.environment === null || options.environment === undefined) ? null : nonEmptyString(options.environment);
  if (!service || !validService(service)) {
    return { ok: false, snapshot: null, error: { id: "service-invalid", detail: "service must be an explicit libpq service name" } };
  }
  if (!identityName) {
    return { ok: false, snapshot: null, error: { id: "identity-name-invalid", detail: "identityName must be non-empty" } };
  }
  if (options.environment !== null && options.environment !== undefined && !environment) {
    return { ok: false, snapshot: null, error: { id: "environment-invalid", detail: "environment must be non-empty when supplied" } };
  }
  if (!Array.isArray(options.schemas) || options.schemas.length === 0) {
    return { ok: false, snapshot: null, error: { id: "schemas-missing", detail: "at least one explicit schema is required" } };
  }
  const schemas = options.schemas.map((item) => nonEmptyString(item));
  if (schemas.some((item) => item === null || !validIdentifier(item))) {
    return { ok: false, snapshot: null, error: { id: "schema-invalid", detail: "schemas must be valid PostgreSQL identifiers" } };
  }
  const normalizedSchemas = /** @type {string[]} */ (schemas);
  if (new Set(normalizedSchemas).size !== normalizedSchemas.length) {
    return { ok: false, snapshot: null, error: { id: "schema-duplicate", detail: "schemas must be unique" } };
  }

  let query;
  try { query = buildPostgresCatalogQuery(normalizedSchemas); }
  catch {
    return { ok: false, snapshot: null, error: { id: "catalog-query-invalid", detail: "PostgreSQL catalog query could not be built" } };
  }
  const runner = dependencies.runPsql ?? runPsql;
  const collected = runner(service, query);
  if (!collected.ok) return { ok: false, snapshot: null, error: { id: collected.error.id, detail: "PostgreSQL catalog collection failed" } };

  const parsed = parsePostgresCatalogOutput(collected.output);
  if (!parsed.ok || parsed.catalog === null) {
    return { ok: false, snapshot: null, error: { id: "catalog-output-invalid", detail: parsed.error ?? "PostgreSQL catalog output is invalid" } };
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const collectedAt = now();
  const built = buildObservedPostgresSchemaSnapshot(parsed.catalog, {
    identityName,
    environment,
    schemas: normalizedSchemas,
    collectedAt,
  });
  if (!built.ok || built.snapshot === null) {
    return { ok: false, snapshot: null, error: { id: "snapshot-build-failed", detail: built.error ?? "PostgreSQL snapshot could not be built" } };
  }
  return {
    ok: true,
    snapshot: built.snapshot,
    collection: {
      service,
      schemas: normalizedSchemas,
    },
    error: null,
  };
}

/** @param {ReturnType<typeof collectPostgresSchemaSnapshot> extends infer T ? T : never} result */
export function formatPostgresSchemaCollection(result) {
  if (!result.ok || result.snapshot === null) return `PostgreSQL schema collection failed: ${result.error?.detail ?? "unknown error"}`;
  return [
    "PostgreSQL schema snapshot",
    "",
    `Database identity: ${result.snapshot.identity.name}`,
    `Environment: ${result.snapshot.identity.environment ?? "(not supplied)"}`,
    `Schemas: ${result.snapshot.schemas.map((item) => item.name).join(", ")}`,
    `Collected at: ${result.snapshot.evidence.collectedAt}`,
    `Source: ${result.snapshot.evidence.source}`,
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let service = null;
  let identityName = null;
  let environment = null;
  let json = false;
  /** @type {string[]} */
  const schemas = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--service", "--identity-name", "--environment", "--schema"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--service") {
      if (service !== null) return null;
      service = value;
    } else if (argument === "--identity-name") {
      if (identityName !== null) return null;
      identityName = value;
    } else if (argument === "--environment") {
      if (environment !== null) return null;
      environment = value;
    } else if (argument === "--schema") {
      schemas.push(value);
    }
  }
  if (service === null || identityName === null || schemas.length === 0) return null;
  return { service, identityName, environment, schemas, json };
}

/** @param {string[]} argv @param {{ runPsql?: typeof runPsql, now?: () => string }} [dependencies] */
export function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/collect-postgres-schema-snapshot.js --service <libpq-service> --identity-name <database> --schema <schema> [--schema <schema> ...] [--environment <name>] [--json]");
    return 1;
  }
  const result = collectPostgresSchemaSnapshot({
    service: options.service,
    identityName: options.identityName,
    environment: options.environment,
    schemas: options.schemas,
  }, dependencies);
  if (!result.ok || result.snapshot === null) {
    console.error(`PostgreSQL schema collection failed: ${result.error?.detail ?? "unknown error"}`);
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.snapshot) : formatPostgresSchemaCollection(result));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
