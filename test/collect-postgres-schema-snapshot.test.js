import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildObservedPostgresSchemaSnapshot,
  buildPostgresCatalogQuery,
  collectPostgresSchemaSnapshot,
  formatPostgresSchemaCollection,
  main,
  parsePostgresCatalogOutput,
} from "../scripts/collect-postgres-schema-snapshot.js";

/** @returns {any} */
function catalog() {
  return {
    tables: [{ schema: "public", name: "users" }],
    columns: [
      { schema: "public", table: "users", name: "id", type: "bigint", nullable: false, default: null },
      { schema: "public", table: "users", name: "email", type: "text", nullable: false, default: null },
    ],
    constraints: [
      { schema: "public", table: "users", name: "users_pkey", type: "primary_key", definition: "PRIMARY KEY (id)" },
    ],
    indexes: [
      { schema: "public", table: "users", name: "users_email_idx", unique: true, definition: "CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (email)" },
    ],
    enums: [{ schema: "public", name: "status", values: ["active", "disabled"] }],
    views: [{ schema: "public", name: "active_users", materialized: false, definition: "SELECT id FROM users" }],
    sequences: [{ schema: "public", name: "users_id_seq", definition: "data_type=bigint;start=1;increment=1" }],
  };
}

/** @param {any} [value] */
function catalogOutput(value = catalog()) {
  const lines = ["BEGIN"];
  for (const key of ["tables", "columns", "constraints", "indexes", "enums", "views", "sequences"]) {
    lines.push(`${key}\t${JSON.stringify(value[key])}`);
  }
  lines.push("COMMIT", "");
  return lines.join("\n");
}

/** @param {{ runResult?: { ok: true, output: string } | { ok: false, error: { id: string, detail: string } }, now?: string }} [overrides] */
function dependencies(overrides = {}) {
  /** @type {Array<{ service: string, query: string }>} */
  const calls = [];
  return {
    calls,
    value: {
      runPsql: (/** @type {string} */ service, /** @type {string} */ query) => {
        calls.push({ service, query });
        return overrides.runResult ?? { ok: true, output: catalogOutput() };
      },
      now: () => overrides.now ?? "2026-09-16T11:45:00.000Z",
    },
  };
}

/** @param {string[]} args @param {{ runPsql?: (service: string, query: string) => any, now?: () => string }} deps */
function captureMain(args, deps) {
  let stdout = "";
  let stderr = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    return { status: main(args, deps), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}
test("catalog query is explicit, schema-scoped, and read only", () => {
  const query = buildPostgresCatalogQuery(["public", "app"]);
  assert.match(query, /^BEGIN READ ONLY;/);
  assert.match(query, /COMMIT;/);
  assert.match(query, /n\.nspname IN \('public', 'app'\)/);
  assert.doesNotMatch(query, /\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE)\b/i);
  assert.throws(() => buildPostgresCatalogQuery([]));
  assert.throws(() => buildPostgresCatalogQuery(["public;drop"]));
});

test("parses all PostgreSQL catalog sections and ignores transaction chatter", () => {
  const result = parsePostgresCatalogOutput(catalogOutput());
  assert.equal(result.ok, true);
  if (!result.ok || result.catalog === null) return;
  assert.equal(result.catalog.tables[0].name, "users");
  assert.equal(result.catalog.columns.length, 2);
  assert.equal(result.catalog.enums[0].values[1], "disabled");
});

test("rejects missing, duplicate, malformed, and non-array catalog sections", () => {
  const missing = catalogOutput().split("\n").filter((line) => !line.startsWith("views\t")).join("\n");
  assert.equal(parsePostgresCatalogOutput(missing).ok, false);
  assert.equal(parsePostgresCatalogOutput(`${catalogOutput()}tables\t[]\n`).ok, false);
  assert.equal(parsePostgresCatalogOutput(catalogOutput().replace("tables\t[", "tables\t{" )).ok, false);
  assert.equal(parsePostgresCatalogOutput(catalogOutput().replace("tables\t[", "tables\t\"" )).ok, false);
});
test("builds a canonical observed PostgreSQL snapshot", () => {
  const result = buildObservedPostgresSchemaSnapshot(catalog(), {
    identityName: " primary-db ",
    environment: " production ",
    schemas: ["public"],
    collectedAt: "2026-09-16T11:45:00Z",
  });
  assert.equal(result.ok, true);
  if (!result.ok || result.snapshot === null) return;
  assert.equal(result.snapshot.kind, "observed");
  assert.equal(result.snapshot.identity.name, "primary-db");
  assert.equal(result.snapshot.identity.environment, "production");
  assert.equal(result.snapshot.evidence.source, "postgresql-psql-catalog");
  assert.equal(result.snapshot.evidence.authenticated, true);
  assert.equal(result.snapshot.schemas[0]?.tables[0]?.columns[0]?.name, "email");
});

test("rejects inconsistent catalog rows instead of repairing provider data", () => {
  const unknownTable = catalog();
  unknownTable.columns[0].table = "missing";
  assert.equal(buildObservedPostgresSchemaSnapshot(unknownTable, {
    identityName: "db", schemas: ["public"], collectedAt: "2026-09-16T11:45:00Z",
  }).ok, false);

  const wrongSchema = catalog();
  wrongSchema.views[0].schema = "private";
  assert.equal(buildObservedPostgresSchemaSnapshot(wrongSchema, {
    identityName: "db", schemas: ["public"], collectedAt: "2026-09-16T11:45:00Z",
  }).ok, false);
});
test("collector validates explicit service, identity, environment, and unique schemas before psql", () => {
  const deps = dependencies();
  for (const options of [
    { service: "bad service", identityName: "db", schemas: ["public"] },
    { service: "prod", identityName: " ", schemas: ["public"] },
    { service: "prod", identityName: "db", environment: " ", schemas: ["public"] },
    { service: "prod", identityName: "db", schemas: [] },
    { service: "prod", identityName: "db", schemas: ["bad-name"] },
    { service: "prod", identityName: "db", schemas: ["public", "public"] },
  ]) {
    assert.equal(collectPostgresSchemaSnapshot(options, deps.value).ok, false);
  }
  assert.equal(deps.calls.length, 0);
});

test("collector calls only the explicit service and timestamps after successful collection", () => {
  const deps = dependencies({ now: "2026-09-16T11:50:00.000Z" });
  const result = collectPostgresSchemaSnapshot({
    service: "audit-prod",
    identityName: "primary-db",
    environment: "production",
    schemas: ["public"],
  }, deps.value);
  assert.equal(result.ok, true);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0]?.service, "audit-prod");
  assert.match(deps.calls[0]?.query ?? "", /^BEGIN READ ONLY;/);
  if (!result.ok || result.snapshot === null) return;
  assert.equal(result.snapshot.evidence.collectedAt, "2026-09-16T11:50:00.000Z");
});
test("runner failures are redacted and malformed catalog output is rejected", () => {
  const secretMarker = ["provider", "fixture", "marker"].join("-");
  const failed = dependencies({
    runResult: { ok: false, error: { id: "psql-collection-failed", detail: secretMarker } },
  });
  const result = collectPostgresSchemaSnapshot({
    service: "audit-prod", identityName: "db", schemas: ["public"],
  }, failed.value);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(secretMarker), false);

  const malformed = dependencies({ runResult: { ok: true, output: "tables\t[]\n" } });
  assert.equal(collectPostgresSchemaSnapshot({
    service: "audit-prod", identityName: "db", schemas: ["public"],
  }, malformed.value).ok, false);
});

test("human formatter exposes metadata but not catalog definitions", () => {
  const deps = dependencies();
  const result = collectPostgresSchemaSnapshot({
    service: "audit-prod", identityName: "db", environment: "staging", schemas: ["public"],
  }, deps.value);
  assert.equal(result.ok, true);
  const output = formatPostgresSchemaCollection(result);
  assert.match(output, /Database identity: db/);
  assert.match(output, /Environment: staging/);
  assert.match(output, /Schemas: public/);
  assert.doesNotMatch(output, /CREATE UNIQUE INDEX|PRIMARY KEY|SELECT id FROM users/);
});
test("CLI emits canonical JSON and stable human output with injected collection", () => {
  const deps = dependencies();
  const json = captureMain([
    "--service", "audit-prod",
    "--identity-name", "db",
    "--schema", "public",
    "--json",
  ], deps.value);
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.kind, "observed");
  assert.equal(parsed.identity.name, "db");
  assert.equal(parsed.schemas[0].name, "public");

  const human = captureMain([
    "--service", "audit-prod",
    "--identity-name", "db",
    "--environment", "production",
    "--schema", "public",
  ], deps.value);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /PostgreSQL schema snapshot/);
  assert.match(human.stdout, /Result: VALID/);
});

test("CLI rejects incomplete, duplicate, unknown, and invalid input", () => {
  const deps = dependencies();
  for (const args of [
    [],
    ["--service", "prod", "--identity-name", "db"],
    ["--service", "prod", "--service", "other", "--identity-name", "db", "--schema", "public"],
    ["--service", "prod", "--identity-name", "db", "--schema"],
    ["--service", "prod", "--identity-name", "db", "--schema", "public", "--wat"],
    ["--service", "bad service", "--identity-name", "db", "--schema", "public"],
  ]) {
    assert.equal(captureMain(args, deps.value).status, 1);
  }
});
test("collector source is limited to psql read-only collection and has no credential or write surface", () => {
  const source = fs.readFileSync(new URL("../scripts/collect-postgres-schema-snapshot.js", import.meta.url), "utf8");
  assert.match(source, /spawnSync\("psql"/);
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /--no-psqlrc/);
  assert.match(source, /ON_ERROR_STOP=1/);
  assert.match(source, /service=\$\{service\}/);
  assert.doesNotMatch(source, /process\.env|PGPASSWORD|postgres(?:ql)?:\/\/|fetch\(|https?:\/\//);
  assert.doesNotMatch(source, /writeFile|appendFile|unlink|rmSync|mkdir|git\s|--password|--host|--username/);
});
