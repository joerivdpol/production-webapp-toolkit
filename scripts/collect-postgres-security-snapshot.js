#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validatePostgresSecuritySnapshot } from "./postgres-security-snapshot.js";

const MAX_PSQL_OUTPUT_BYTES = 32 * 1024 * 1024;
const CATALOG_KEYS = [
  "tables",
  "tableGrants",
  "policies",
  "schemaGrants",
  "functions",
  "functionGrants",
  "sequences",
  "sequenceGrants",
];

/** @param {unknown} value */
function validIdentifier(value) {
  return typeof value === "string" && /^[A-Za-z_][A-Za-z0-9_$]*$/.test(value);
}

/** @param {unknown} value */
function validService(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {string} value */
function quoteLiteral(value) {
  return `'${value.replaceAll("'", "''")}'`;
}

/** @param {string[]} schemas */
export function buildPostgresSecurityQuery(schemas) {
  if (!Array.isArray(schemas) || schemas.length === 0 || schemas.some((item) => !validIdentifier(item))) {
    throw new Error("schemas must be non-empty PostgreSQL identifiers");
  }
  const schemaList = schemas.map(quoteLiteral).join(", ");
  return `BEGIN READ ONLY;
SELECT 'tables', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'name', c.relname,
  'rlsEnabled', c.relrowsecurity,
  'rlsForced', c.relforcerowsecurity
) ORDER BY n.nspname, c.relname), '[]'::jsonb)::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN (${schemaList}) AND c.relkind IN ('r','p');

SELECT 'tableGrants', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'table', c.relname,
  'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
  'privilege', x.privilege_type
) ORDER BY n.nspname, c.relname, x.grantee, x.privilege_type), '[]'::jsonb)::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('r', c.relowner))) x
WHERE n.nspname IN (${schemaList}) AND c.relkind IN ('r','p');

SELECT 'policies', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'table', c.relname,
  'name', p.polname,
  'command', CASE p.polcmd WHEN '*' THEN 'ALL' WHEN 'r' THEN 'SELECT' WHEN 'a' THEN 'INSERT' WHEN 'w' THEN 'UPDATE' WHEN 'd' THEN 'DELETE' END,
  'roles', (SELECT jsonb_agg(CASE WHEN role_oid = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(role_oid) END ORDER BY role_oid) FROM unnest(p.polroles) role_oid),
  'permissive', p.polpermissive,
  'usingAlwaysTrue', CASE WHEN p.polqual IS NULL THEN NULL ELSE regexp_replace(lower(pg_get_expr(p.polqual, p.polrelid, true)), '[()[:space:]]', '', 'g') IN ('true','true::boolean') END,
  'checkAlwaysTrue', CASE WHEN p.polwithcheck IS NULL THEN NULL ELSE regexp_replace(lower(pg_get_expr(p.polwithcheck, p.polrelid, true)), '[()[:space:]]', '', 'g') IN ('true','true::boolean') END
) ORDER BY n.nspname, c.relname, p.polname), '[]'::jsonb)::text
FROM pg_policy p
JOIN pg_class c ON c.oid = p.polrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN (${schemaList});

SELECT 'schemaGrants', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
  'privilege', x.privilege_type
) ORDER BY n.nspname, x.grantee, x.privilege_type), '[]'::jsonb)::text
FROM pg_namespace n
CROSS JOIN LATERAL aclexplode(COALESCE(n.nspacl, acldefault('n', n.nspowner))) x
WHERE n.nspname IN (${schemaList});

SELECT 'functions', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'name', p.proname,
  'identityArguments', pg_get_function_identity_arguments(p.oid),
  'securityDefiner', p.prosecdef,
  'searchPath', CASE WHEN sp.setting IS NULL THEN NULL ELSE string_to_array(sp.setting, ',') END
) ORDER BY n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)), '[]'::jsonb)::text
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
LEFT JOIN LATERAL (
  SELECT substring(config FROM length('search_path=') + 1) AS setting
  FROM unnest(COALESCE(p.proconfig, ARRAY[]::text[])) config
  WHERE config LIKE 'search_path=%'
  LIMIT 1
) sp ON true
WHERE n.nspname IN (${schemaList});

SELECT 'functionGrants', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'name', p.proname,
  'identityArguments', pg_get_function_identity_arguments(p.oid),
  'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
  'privilege', x.privilege_type
) ORDER BY n.nspname, p.proname, x.grantee, x.privilege_type), '[]'::jsonb)::text
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) x
WHERE n.nspname IN (${schemaList});

SELECT 'sequences', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'name', c.relname
) ORDER BY n.nspname, c.relname), '[]'::jsonb)::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname IN (${schemaList}) AND c.relkind = 'S';

SELECT 'sequenceGrants', COALESCE(jsonb_agg(jsonb_build_object(
  'schema', n.nspname,
  'name', c.relname,
  'grantee', CASE WHEN x.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(x.grantee) END,
  'privilege', x.privilege_type
) ORDER BY n.nspname, c.relname, x.grantee, x.privilege_type), '[]'::jsonb)::text
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL aclexplode(COALESCE(c.relacl, acldefault('S', c.relowner))) x
WHERE n.nspname IN (${schemaList}) AND c.relkind = 'S';
COMMIT;
`;
}

/** @typedef {{ tables: any[], tableGrants: any[], policies: any[], schemaGrants: any[], functions: any[], functionGrants: any[], sequences: any[], sequenceGrants: any[] }} SecurityCatalog */

/** @param {string} output */
export function parsePostgresSecurityOutput(output) {
  /** @type {Record<string, unknown[]>} */
  const values = {};
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const separator = line.indexOf("\t");
    if (separator === -1) continue;
    const key = line.slice(0, separator);
    if (!CATALOG_KEYS.includes(key)) continue;
    if (values[key] !== undefined) return { ok: false, catalog: null, error: `duplicate PostgreSQL security section ${key}` };
    let parsed;
    try { parsed = JSON.parse(line.slice(separator + 1)); }
    catch { return { ok: false, catalog: null, error: `PostgreSQL security section ${key} is not valid JSON` }; }
    if (!Array.isArray(parsed)) return { ok: false, catalog: null, error: `PostgreSQL security section ${key} must be an array` };
    values[key] = parsed;
  }
  for (const key of CATALOG_KEYS) {
    if (values[key] === undefined) return { ok: false, catalog: null, error: `PostgreSQL security output is missing section ${key}` };
  }
  return { ok: true, catalog: /** @type {SecurityCatalog} */ (values), error: null };
}

/** @param {SecurityCatalog} catalog @param {{ identityName: string, environment?: string | null, schemas: string[], collectedAt: string }} options */
export function buildObservedPostgresSecuritySnapshot(catalog, options) {
  const identityName = nonEmptyString(options.identityName);
  const environment = options.environment === undefined || options.environment === null ? null : nonEmptyString(options.environment);
  if (!identityName) return { ok: false, snapshot: null, error: "identityName must be non-empty" };
  if (options.environment !== undefined && options.environment !== null && !environment) return { ok: false, snapshot: null, error: "environment must be non-empty when supplied" };
  if (!Array.isArray(options.schemas) || options.schemas.length === 0 || options.schemas.some((item) => !validIdentifier(item))) {
    return { ok: false, snapshot: null, error: "schemas must be explicit PostgreSQL identifiers" };
  }
  if (new Set(options.schemas).size !== options.schemas.length) return { ok: false, snapshot: null, error: "schemas must be unique" };
  const schemaNames = new Set(options.schemas);
  /** @type {Map<string, any>} */
  const schemas = new Map(options.schemas.map((name) => [name, { name, grants: [], tables: [], functions: [], sequences: [] }]));
  /** @type {Map<string, any>} */
  const tables = new Map();
  /** @type {Map<string, any>} */
  const functions = new Map();
  /** @type {Map<string, any>} */
  const sequences = new Map();

  try {
    for (const raw of catalog.tables) {
      if (!isPlainObject(raw)) throw new Error("catalog tables must contain objects");
      const schema = nonEmptyString(raw.schema);
      const name = nonEmptyString(raw.name);
      if (!schema || !schemaNames.has(schema) || !name || typeof raw.rlsEnabled !== "boolean" || typeof raw.rlsForced !== "boolean") throw new Error("catalog table has invalid fields");
      const key = `${schema}.${name}`;
      if (tables.has(key)) throw new Error(`catalog contains duplicate table ${key}`);
      const table = { name, rlsEnabled: raw.rlsEnabled, rlsForced: raw.rlsForced, grants: [], policies: [] };
      tables.set(key, table);
      schemas.get(schema).tables.push(table);
    }
    for (const raw of catalog.functions) {
      if (!isPlainObject(raw)) throw new Error("catalog functions must contain objects");
      const schema = nonEmptyString(raw.schema);
      const name = nonEmptyString(raw.name);
      const identityArguments = typeof raw.identityArguments === "string" ? raw.identityArguments.trim() : null;
      if (!schema || !schemaNames.has(schema) || !name || identityArguments === null || typeof raw.securityDefiner !== "boolean") throw new Error("catalog function has invalid fields");
      if (raw.searchPath !== null && (!Array.isArray(raw.searchPath) || raw.searchPath.some((item) => !nonEmptyString(item)))) throw new Error("catalog function search_path is invalid");
      const key = `${schema}.${name}(${identityArguments})`;
      if (functions.has(key)) throw new Error(`catalog contains duplicate function ${key}`);
      const fn = {
        name,
        identityArguments,
        securityDefiner: raw.securityDefiner,
        searchPath: raw.searchPath === null ? null : raw.searchPath,
        grants: [],
      };
      functions.set(key, fn);
      schemas.get(schema).functions.push(fn);
    }
    for (const raw of catalog.sequences) {
      if (!isPlainObject(raw)) throw new Error("catalog sequences must contain objects");
      const schema = nonEmptyString(raw.schema);
      const name = nonEmptyString(raw.name);
      if (!schema || !schemaNames.has(schema) || !name) throw new Error("catalog sequence has invalid fields");
      const key = `${schema}.${name}`;
      if (sequences.has(key)) throw new Error(`catalog contains duplicate sequence ${key}`);
      const sequence = { name, grants: [] };
      sequences.set(key, sequence);
      schemas.get(schema).sequences.push(sequence);
    }
  } catch (error) {
    return { ok: false, snapshot: null, error: error instanceof Error ? error.message : "invalid PostgreSQL security catalog payload" };
  }

  /** @param {{ grants: any[] }} target @param {unknown} granteeValue @param {unknown} privilegeValue @param {string} section */
  const appendGrant = (target, granteeValue, privilegeValue, section) => {
    const grantee = nonEmptyString(granteeValue);
    const privilege = nonEmptyString(privilegeValue)?.toUpperCase() ?? null;
    if (!grantee || !privilege) throw new Error(`${section} grant has invalid fields`);
    let grant = target.grants.find((item) => item.grantee === grantee);
    if (!grant) {
      grant = { grantee, privileges: [] };
      target.grants.push(grant);
    }
    if (grant.privileges.includes(privilege)) throw new Error(`${section} contains duplicate grant privilege`);
    grant.privileges.push(privilege);
  };

  try {
    for (const raw of catalog.schemaGrants) {
      if (!isPlainObject(raw)) throw new Error("catalog schema grants must contain objects");
      const schema = nonEmptyString(raw.schema);
      if (!schema || !schemaNames.has(schema)) throw new Error("schema grant references unknown schema");
      appendGrant(schemas.get(schema), raw.grantee, raw.privilege, "schema");
    }
    for (const raw of catalog.tableGrants) {
      if (!isPlainObject(raw)) throw new Error("catalog table grants must contain objects");
      const schema = nonEmptyString(raw.schema);
      const table = nonEmptyString(raw.table);
      const target = schema && table ? tables.get(`${schema}.${table}`) : null;
      if (!target) throw new Error("table grant references unknown table");
      appendGrant(target, raw.grantee, raw.privilege, "table");
    }
    for (const raw of catalog.functionGrants) {
      if (!isPlainObject(raw)) throw new Error("catalog function grants must contain objects");
      const schema = nonEmptyString(raw.schema);
      const name = nonEmptyString(raw.name);
      const identityArguments = typeof raw.identityArguments === "string" ? raw.identityArguments.trim() : null;
      const key = schema && name && identityArguments !== null ? `${schema}.${name}(${identityArguments})` : null;
      const target = key ? functions.get(key) : null;
      if (!target) throw new Error("function grant references unknown function");
      appendGrant(target, raw.grantee, raw.privilege, "function");
    }
    for (const raw of catalog.sequenceGrants) {
      if (!isPlainObject(raw)) throw new Error("catalog sequence grants must contain objects");
      const schema = nonEmptyString(raw.schema);
      const name = nonEmptyString(raw.name);
      const target = schema && name ? sequences.get(`${schema}.${name}`) : null;
      if (!target) throw new Error("sequence grant references unknown sequence");
      appendGrant(target, raw.grantee, raw.privilege, "sequence");
    }
    for (const raw of catalog.policies) {
      if (!isPlainObject(raw)) throw new Error("catalog policies must contain objects");
      const schema = nonEmptyString(raw.schema);
      const table = nonEmptyString(raw.table);
      const name = nonEmptyString(raw.name);
      const command = nonEmptyString(raw.command)?.toUpperCase() ?? null;
      const target = schema && table ? tables.get(`${schema}.${table}`) : null;
      if (!target || !name || !command || !Array.isArray(raw.roles) || typeof raw.permissive !== "boolean") {
        throw new Error("catalog policy has invalid fields");
      }
      if (raw.roles.some((role) => !nonEmptyString(role))) throw new Error("catalog policy roles are invalid");
      if (raw.usingAlwaysTrue !== null && typeof raw.usingAlwaysTrue !== "boolean") throw new Error("catalog policy USING signal is invalid");
      if (raw.checkAlwaysTrue !== null && typeof raw.checkAlwaysTrue !== "boolean") throw new Error("catalog policy CHECK signal is invalid");
      target.policies.push({
        name, command, roles: raw.roles, permissive: raw.permissive,
        usingAlwaysTrue: raw.usingAlwaysTrue, checkAlwaysTrue: raw.checkAlwaysTrue,
      });
    }
  } catch (error) {
    return { ok: false, snapshot: null, error: error instanceof Error ? error.message : "invalid PostgreSQL security catalog payload" };
  }

  const candidate = {
    version: 1,
    engine: "postgresql",
    identity: { name: identityName, ...(environment === null ? {} : { environment }) },
    evidence: {
      source: "postgresql-psql-security-catalog",
      authenticated: true,
      collectedAt: options.collectedAt,
    },
    schemas: [...schemas.values()],
  };
  const validation = validatePostgresSecuritySnapshot(candidate);
  if (!validation.ok || validation.snapshot === null) {
    return { ok: false, snapshot: null, error: "generated PostgreSQL security snapshot does not satisfy version 1 contract" };
  }
  return { ok: true, snapshot: validation.snapshot, error: null };
}

/** @param {string} service @param {string} query */
export function runPsqlSecurityQuery(service, query) {
  const result = spawnSync("psql", [
    `service=${service}`,
    "-X", "--no-psqlrc", "--set", "ON_ERROR_STOP=1",
    "--no-align", "--tuples-only", "--field-separator", "\t",
  ], {
    input: query,
    encoding: "utf8",
    maxBuffer: MAX_PSQL_OUTPUT_BYTES,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return { ok: false, output: null, error: { id: "psql-security-collection-failed", detail: "PostgreSQL security catalog collection failed" } };
  }
  return { ok: true, output: result.stdout, error: null };
}

/**
 * @param {{ service: string, identityName: string, environment?: string | null, schemas: string[] }} options
 * @param {{ runPsql?: typeof runPsqlSecurityQuery, now?: () => string }} [dependencies]
 */
export function collectPostgresSecuritySnapshot(options, dependencies = {}) {
  const service = nonEmptyString(options.service);
  const identityName = nonEmptyString(options.identityName);
  const environment = options.environment === undefined || options.environment === null ? null : nonEmptyString(options.environment);
  if (!service || !validService(service)) return { ok: false, snapshot: null, error: { id: "service-invalid", detail: "service must be an explicit libpq service name" } };
  if (!identityName) return { ok: false, snapshot: null, error: { id: "identity-name-invalid", detail: "identityName must be non-empty" } };
  if (options.environment !== undefined && options.environment !== null && !environment) {
    return { ok: false, snapshot: null, error: { id: "environment-invalid", detail: "environment must be non-empty when supplied" } };
  }
  if (!Array.isArray(options.schemas) || options.schemas.length === 0) return { ok: false, snapshot: null, error: { id: "schemas-missing", detail: "at least one explicit schema is required" } };
  const schemas = options.schemas.map((item) => nonEmptyString(item));
  if (schemas.some((item) => item === null || !validIdentifier(item))) return { ok: false, snapshot: null, error: { id: "schema-invalid", detail: "schemas must be valid PostgreSQL identifiers" } };
  const normalizedSchemas = /** @type {string[]} */ (schemas);
  if (new Set(normalizedSchemas).size !== normalizedSchemas.length) return { ok: false, snapshot: null, error: { id: "schema-duplicate", detail: "schemas must be unique" } };

  const query = buildPostgresSecurityQuery(normalizedSchemas);
  const run = dependencies.runPsql ?? runPsqlSecurityQuery;
  const result = run(service, query);
  if (!result.ok || result.output === null) return { ok: false, snapshot: null, error: { id: "collection-failed", detail: "PostgreSQL security catalog collection failed" } };
  const parsed = parsePostgresSecurityOutput(result.output);
  if (!parsed.ok || parsed.catalog === null) return { ok: false, snapshot: null, error: { id: "catalog-output-invalid", detail: parsed.error } };
  const collectedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const built = buildObservedPostgresSecuritySnapshot(parsed.catalog, {
    identityName,
    environment,
    schemas: normalizedSchemas,
    collectedAt,
  });
  if (!built.ok || built.snapshot === null) {
    return { ok: false, snapshot: null, error: { id: "snapshot-build-failed", detail: "PostgreSQL security evidence could not be normalized" } };
  }
  return { ok: true, snapshot: built.snapshot, error: null };
}

/** @param {ReturnType<typeof collectPostgresSecuritySnapshot>} result */
export function formatPostgresSecurityCollection(result) {
  if (!result.ok || result.snapshot === null) return `PostgreSQL security collection failed: ${result.error?.id ?? "unknown"}`;
  const tables = result.snapshot.schemas.reduce((total, schema) => total + schema.tables.length, 0);
  const functions = result.snapshot.schemas.reduce((total, schema) => total + schema.functions.length, 0);
  return [
    "PostgreSQL security snapshot collected",
    `Database: ${result.snapshot.identity.name}`,
    `Environment: ${result.snapshot.identity.environment ?? "(not supplied)"}`,
    `Schemas: ${result.snapshot.schemas.map((item) => item.name).join(", ")}`,
    `Tables: ${tables}`,
    `Functions: ${functions}`,
    `Collected at: ${result.snapshot.evidence.collectedAt}`,
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let service = null;
  let identityName = null;
  let environment = null;
  const schemas = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--service", "--identity-name", "--environment", "--schema"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--service") { if (service !== null) return null; service = value; }
    else if (argument === "--identity-name") { if (identityName !== null) return null; identityName = value; }
    else if (argument === "--environment") { if (environment !== null) return null; environment = value; }
    else schemas.push(value);
  }
  if (service === null || identityName === null || schemas.length === 0) return null;
  return { service, identityName, environment, schemas, json };
}

export function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/collect-postgres-security-snapshot.js --service <libpq-service> --identity-name <name> [--environment <name>] --schema <schema> [--schema <schema> ...] [--json]");
    return 1;
  }
  const result = collectPostgresSecuritySnapshot(options, dependencies);
  if (!result.ok || result.snapshot === null) {
    console.error(`PostgreSQL security collection failed: ${result.error?.id ?? "unknown"}`);
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.snapshot) : formatPostgresSecurityCollection(result));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
