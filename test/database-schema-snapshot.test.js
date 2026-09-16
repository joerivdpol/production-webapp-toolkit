import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  main,
  validateDatabaseSchemaSnapshot,
} from "../scripts/database-schema-snapshot.js";

/** @type {string[]} */
const fixtures = [];

/** @param {"expected" | "observed"} kind @param {Record<string, any>} [overrides] @returns {Record<string, any>} */
function snapshot(kind, overrides = {}) {
  return {
    version: 1,
    engine: "postgresql",
    kind,
    identity: { name: "app-db", environment: "production" },
    evidence: {
      source: kind === "expected" ? "migration-review" : "postgres-catalog",
      authenticated: kind === "observed",
      collectedAt: "2026-09-16T08:00:00Z",
    },
    ...(kind === "expected" ? { migrationManifestSha256: "a".repeat(64) } : {}),
    schemas: [
      {
        name: "public",
        tables: [
          {
            name: "users",
            columns: [
              { name: "email", type: "text", nullable: false, default: null },
              { name: "id", type: "uuid", nullable: false, default: "gen_random_uuid()" },
            ],
            constraints: [
              { name: "users_pkey", type: "primary_key", definition: "PRIMARY KEY (id)" },
            ],
            indexes: [
              { name: "users_email_idx", unique: true, definition: "CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (email)" },
            ],
          },
        ],
        enums: [{ name: "user_status", values: ["active", "disabled"] }],
        views: [{ name: "active_users", materialized: false, definition: "SELECT id FROM public.users WHERE active = true" }],
        sequences: [{ name: "legacy_seq", definition: "START 1 INCREMENT 1" }],
      },
    ],
    ...overrides,
  };
}

/** @param {unknown} value */
function snapshotFile(value) {
  const filename = path.join(os.tmpdir(), `schema-snapshot-${process.pid}-${fixtures.length}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  fixtures.push(filename);
  return filename;
}

/** @param {...string} args */
function runMain(...args) {
  let stdout = "";
  let stderr = "";
  const log = console.log;
  const error = console.error;
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    return { status: main(args), stdout, stderr };
  } finally {
    console.log = log;
    console.error = error;
  }
}

afterEach(() => {
  for (const filename of fixtures.splice(0).reverse()) fs.rmSync(filename, { recursive: true, force: true });
});

test("normalizes a valid expected PostgreSQL schema snapshot deterministically", () => {
  const value = snapshot("expected");
  value.schemas[0].tables[0].columns.reverse();
  value.schemas[0].views[0].definition = "  SELECT   id   FROM public.users WHERE active = true  ";
  value.migrationManifestSha256 = value.migrationManifestSha256.toUpperCase();
  const result = validateDatabaseSchemaSnapshot(value);
  assert.equal(result.ok, true);
  if (!result.ok || !result.snapshot) return;
  assert.deepEqual(result.snapshot.schemas[0]?.tables[0]?.columns.map((item) => item.name), ["email", "id"]);
  assert.equal(result.snapshot.schemas[0]?.views[0]?.definition, "SELECT id FROM public.users WHERE active = true");
  assert.equal(result.snapshot.migrationManifestSha256, "a".repeat(64));
});

test("observed snapshots may omit migration binding but expected snapshots may not", () => {
  const observed = validateDatabaseSchemaSnapshot(snapshot("observed"));
  assert.equal(observed.ok, true);

  const expected = snapshot("expected");
  delete expected.migrationManifestSha256;
  const result = validateDatabaseSchemaSnapshot(expected);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.id === "expected-migration-binding-missing"));
});

test("rejects unsupported engines, kinds, malformed identity, trust, and timestamps", () => {
  const cases = [
    { ...snapshot("observed"), engine: "mysql" },
    { ...snapshot("observed"), kind: "runtime" },
    { ...snapshot("observed"), identity: { name: "" } },
    { ...snapshot("observed"), identity: { name: "db", environment: "" } },
    { ...snapshot("observed"), evidence: { source: "", authenticated: false, collectedAt: "2026-09-16T08:00:00Z" } },
    { ...snapshot("observed"), evidence: { source: "collector", authenticated: "true", collectedAt: "2026-09-16T08:00:00Z" } },
    { ...snapshot("observed"), evidence: { source: "collector", authenticated: false, collectedAt: "2026-09-16T08:00:00" } },
    { ...snapshot("observed"), migrationManifestSha256: "bad" },
  ];
  for (const value of cases) assert.equal(validateDatabaseSchemaSnapshot(value).ok, false);
});

test("rejects unknown core fields throughout the snapshot contract", () => {
  const values = [
    { ...snapshot("observed"), extra: true },
    { ...snapshot("observed"), identity: { ...snapshot("observed").identity, extra: true } },
    { ...snapshot("observed"), evidence: { ...snapshot("observed").evidence, extra: true } },
    { ...snapshot("observed"), schemas: [{ ...snapshot("observed").schemas[0], extra: true }] },
    { ...snapshot("observed"), schemas: [{ ...snapshot("observed").schemas[0], tables: [{ ...snapshot("observed").schemas[0].tables[0], extra: true }] }] },
    { ...snapshot("observed"), schemas: [{ ...snapshot("observed").schemas[0], tables: [{ ...snapshot("observed").schemas[0].tables[0], columns: [{ ...snapshot("observed").schemas[0].tables[0].columns[0], extra: true }] }] }] },
  ];
  for (const value of values) {
    const result = validateDatabaseSchemaSnapshot(value);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.id.endsWith("-field-unknown")));
  }
});

test("rejects duplicate named database objects", () => {
  const duplicateTable = snapshot("observed");
  duplicateTable.schemas[0].tables.push(structuredClone(duplicateTable.schemas[0].tables[0]));
  assert.equal(validateDatabaseSchemaSnapshot(duplicateTable).ok, false);

  const duplicateColumn = snapshot("observed");
  duplicateColumn.schemas[0].tables[0].columns.push(structuredClone(duplicateColumn.schemas[0].tables[0].columns[0]));
  assert.equal(validateDatabaseSchemaSnapshot(duplicateColumn).ok, false);

  const duplicateSchema = snapshot("observed");
  duplicateSchema.schemas.push(structuredClone(duplicateSchema.schemas[0]));
  assert.equal(validateDatabaseSchemaSnapshot(duplicateSchema).ok, false);
});

test("validates columns, constraints, indexes, enums, views, and sequences", () => {
  const invalidConstraint = snapshot("observed");
  invalidConstraint.schemas[0].tables[0].constraints[0].type = "trigger";
  assert.equal(validateDatabaseSchemaSnapshot(invalidConstraint).ok, false);

  const invalidColumn = snapshot("observed");
  invalidColumn.schemas[0].tables[0].columns[0].nullable = "no";
  assert.equal(validateDatabaseSchemaSnapshot(invalidColumn).ok, false);

  const invalidIndex = snapshot("observed");
  invalidIndex.schemas[0].tables[0].indexes[0].unique = "yes";
  assert.equal(validateDatabaseSchemaSnapshot(invalidIndex).ok, false);

  const duplicateEnumValue = snapshot("observed");
  duplicateEnumValue.schemas[0].enums[0].values.push("active");
  assert.equal(validateDatabaseSchemaSnapshot(duplicateEnumValue).ok, false);

  const invalidView = snapshot("observed");
  invalidView.schemas[0].views[0].materialized = "false";
  assert.equal(validateDatabaseSchemaSnapshot(invalidView).ok, false);

  const invalidSequence = snapshot("observed");
  invalidSequence.schemas[0].sequences[0].definition = " ";
  assert.equal(validateDatabaseSchemaSnapshot(invalidSequence).ok, false);
});

test("enum value ordering is preserved while named database objects are sorted", () => {
  const value = snapshot("observed");
  value.schemas[0].enums[0].values = ["disabled", "active"];
  value.schemas[0].tables.push({
    name: "accounts",
    columns: [],
    constraints: [],
    indexes: [],
  });
  const result = validateDatabaseSchemaSnapshot(value);
  assert.equal(result.ok, true);
  if (!result.ok || !result.snapshot) return;
  assert.deepEqual(result.snapshot.schemas[0]?.tables.map((item) => item.name), ["accounts", "users"]);
  assert.deepEqual(result.snapshot.schemas[0]?.enums[0]?.values, ["disabled", "active"]);
});

test("CLI emits stable normalized JSON and human metadata", () => {
  const filename = snapshotFile(snapshot("expected"));
  const json = runMain("--file", filename, "--json");
  assert.equal(json.status, 0);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.snapshot.kind, "expected");
  assert.equal(parsed.snapshot.engine, "postgresql");

  const human = runMain("--file", filename);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Database schema snapshot/);
  assert.match(human.stdout, /Kind: expected/);
  assert.match(human.stdout, /Result: VALID/);
});

test("CLI rejects malformed, missing, invalid files and unknown arguments", () => {
  const malformed = snapshotFile("{");
  const invalid = snapshot("expected");
  delete invalid.migrationManifestSha256;
  const invalidFile = snapshotFile(invalid);
  const missing = path.join(os.tmpdir(), "schema-snapshot-no-such-file.json");
  for (const args of [
    [],
    ["--file", malformed],
    ["--file", invalidFile],
    ["--file", missing],
    ["--file", invalidFile, "--unknown"],
  ]) assert.equal(runMain(...args).status, 1);
});

test("snapshot validator has no database, Git, network, environment, or write surface", () => {
  const source = fs.readFileSync(path.resolve("scripts/database-schema-snapshot.js"), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|https?:\/\//);
  assert.doesNotMatch(source, /process\.env|postgres(?:ql)?:\/\/|psql|supabase/);
  assert.doesNotMatch(source, /writeFile|appendFile|unlink|rmSync|rename|mkdir/);
  assert.match(source, /migrationManifestSha256/);
});
