import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compareDatabaseSchemaSnapshots,
  formatDatabaseSchemaDrift,
  inspectDatabaseSchemaDrift,
  main,
} from "../scripts/audit-database-schema-drift.js";
import {
  migrationManifestDigest,
  validateMigrationManifest,
} from "../scripts/audit-migration-safety.js";
import { validateDatabaseSchemaSnapshot } from "../scripts/database-schema-snapshot.js";

/** @type {string[]} */
const fixtures = [];

/** @returns {import("../scripts/audit-migration-safety.js").MigrationManifest} */
function manifest() {
  const result = validateMigrationManifest({
    version: 1,
    migrations: [
      { path: "migrations/20260916120000_base.sql", sha256: "a".repeat(64) },
      { path: "migrations/20260916121000_users.sql", sha256: "b".repeat(64) },
    ],
  }, ["migrations"]);
  if (!result.ok || !result.manifest) throw new Error("fixture manifest invalid");
  return result.manifest;
}

/** @param {"expected" | "observed"} kind @param {Record<string, any>} [overrides] @returns {Record<string, any>} */
function rawSnapshot(kind, overrides = {}) {
  const digest = migrationManifestDigest(manifest());
  return {
    version: 1,
    engine: "postgresql",
    kind,
    identity: { name: "app-db", environment: "production" },
    evidence: {
      source: kind === "expected" ? "migration-review" : "postgres-catalog",
      authenticated: kind === "observed",
      collectedAt: "2026-09-16T08:30:00Z",
    },
    ...(kind === "expected" ? { migrationManifestSha256: digest } : {}),
    schemas: [
      {
        name: "public",
        tables: [
          {
            name: "users",
            columns: [
              { name: "id", type: "uuid", nullable: false, default: "gen_random_uuid()" },
              { name: "email", type: "text", nullable: false, default: null },
            ],
            constraints: [{ name: "users_pkey", type: "primary_key", definition: "PRIMARY KEY (id)" }],
            indexes: [{ name: "users_email_idx", unique: true, definition: "CREATE UNIQUE INDEX users_email_idx ON public.users USING btree (email)" }],
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

/** @param {"expected" | "observed"} kind @param {Record<string, any>} [overrides] */
function snapshot(kind, overrides = {}) {
  const result = validateDatabaseSchemaSnapshot(rawSnapshot(kind, overrides));
  if (!result.ok || !result.snapshot) throw new Error("fixture snapshot invalid");
  return result.snapshot;
}

/** @param {unknown} value @param {string} label */
function jsonFile(value, label) {
  const filename = path.join(os.tmpdir(), `schema-drift-${label}-${process.pid}-${fixtures.length}.json`);
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

test("matching expected, observed, and migration manifest is full PASS", () => {
  const expected = snapshot("expected");
  const observed = snapshot("observed");
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  assert.equal(report.identity.status, "MATCH");
  assert.equal(report.migrationBinding.status, "MATCH");
  assert.equal(report.schemaDrift.status, "MATCH");
  assert.equal(report.schemaDrift.differenceCount, 0);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.technicalStatus, "PASS");
});

test("matching schemas without explicit manifest binding remain WARN", () => {
  const report = inspectDatabaseSchemaDrift(snapshot("expected"), snapshot("observed"));
  assert.equal(report.migrationBinding.status, "UNVERIFIED");
  assert.equal(report.schemaDrift.status, "MATCH");
  assert.equal(report.overallStatus, "WARN");
});

test("expected snapshot bound to a different migration manifest is blocking FAIL", () => {
  const expected = snapshot("expected");
  const observed = snapshot("observed");
  const changed = validateMigrationManifest({
    version: 1,
    migrations: [
      { path: "migrations/20260916120000_base.sql", sha256: "a".repeat(64) },
      { path: "migrations/20260916121000_users.sql", sha256: "c".repeat(64) },
    ],
  }, ["migrations"]);
  if (!changed.ok || !changed.manifest) throw new Error("changed manifest invalid");
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: changed.manifest });
  assert.equal(report.migrationBinding.status, "MISMATCH");
  assert.equal(report.schemaDrift.status, "MATCH");
  assert.equal(report.overallStatus, "FAIL");
});

test("observed migration digest claim is checked independently of structural schema", () => {
  const expected = snapshot("expected");
  const observed = snapshot("observed", { migrationManifestSha256: "d".repeat(64) });
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  assert.equal(report.migrationBinding.status, "MATCH");
  assert.equal(report.migrationBinding.observedManifestStatus, "MISMATCH");
  assert.equal(report.schemaDrift.status, "MATCH");
  assert.equal(report.overallStatus, "FAIL");
});

test("matching observed migration digest remains independent trust metadata", () => {
  const expected = snapshot("expected");
  const observed = snapshot("observed", { migrationManifestSha256: expected.migrationManifestSha256 });
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  assert.equal(report.migrationBinding.observedManifestStatus, "MATCH");
  assert.equal(report.overallStatus, "PASS");
});

test("database identity mismatch blocks comparison instead of producing fake drift", () => {
  const expected = snapshot("expected");
  const observed = snapshot("observed", { identity: { name: "other-db", environment: "production" } });
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  assert.equal(report.identity.status, "MISMATCH");
  assert.equal(report.schemaDrift.status, "UNVERIFIED");
  assert.equal(report.schemaDrift.differenceCount, 0);
  assert.equal(report.overallStatus, "FAIL");
});

test("expected environment binding must match when configured", () => {
  const expected = snapshot("expected");
  const observed = snapshot("observed", { identity: { name: "app-db", environment: "staging" } });
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  assert.equal(report.identity.status, "MISMATCH");
  assert.equal(report.overallStatus, "FAIL");
});

test("expected identity without environment binds only the database name", () => {
  const expected = snapshot("expected", { identity: { name: "app-db" } });
  const observed = snapshot("observed", { identity: { name: "app-db", environment: "staging" } });
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  assert.equal(report.identity.status, "MATCH");
  assert.equal(report.overallStatus, "PASS");
});

test("missing and extra schema objects are reported without raw SQL definitions", () => {
  const expected = snapshot("expected");
  const observedRaw = rawSnapshot("observed");
  observedRaw.schemas[0].tables = [];
  observedRaw.schemas[0].views.push({ name: "extra_view", materialized: false, definition: "SELECT 'sensitive-marker'::text" });
  const observed = snapshot("observed", { schemas: observedRaw.schemas });
  const differences = compareDatabaseSchemaSnapshots(expected, observed);
  assert.ok(differences.some((item) => item.path === "table:public.users" && item.change === "MISSING"));
  assert.ok(differences.some((item) => item.path === "view:public.extra_view" && item.change === "EXTRA"));
  assert.equal(JSON.stringify(differences).includes("sensitive-marker"), false);

  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  assert.equal(report.schemaDrift.status, "MISMATCH");
  assert.equal(report.overallStatus, "FAIL");
});

test("column drift reports only changed field names", () => {
  const expected = snapshot("expected");
  const observedRaw = rawSnapshot("observed");
  const email = observedRaw.schemas[0].tables[0].columns.find((/** @type {any} */ item) => item.name === "email");
  email.type = "citext";
  email.nullable = true;
  email.default = "'private-literal-marker'::citext";
  const observed = snapshot("observed", { schemas: observedRaw.schemas });
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  const difference = report.schemaDrift.differences.find((item) => item.path === "column:public.users.email");
  assert.deepEqual(difference?.fields, ["default", "nullable", "type"]);
  assert.equal(JSON.stringify(report).includes("private-literal-marker"), false);
  assert.equal(report.overallStatus, "FAIL");
});

test("constraint, index, view, and sequence changes are detected without exposing definitions", () => {
  const expected = snapshot("expected");
  const observedRaw = rawSnapshot("observed");
  observedRaw.schemas[0].tables[0].constraints[0].definition = "CHECK (secret_column = 'constraint-marker')";
  observedRaw.schemas[0].tables[0].indexes[0].definition = "CREATE INDEX hidden_marker ON public.users(id)";
  observedRaw.schemas[0].views[0].definition = "SELECT 'view-marker'::text";
  observedRaw.schemas[0].sequences[0].definition = "START 9 INCREMENT 3";
  const observed = snapshot("observed", { schemas: observedRaw.schemas });
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  for (const pathValue of [
    "constraint:public.users.users_pkey",
    "index:public.users.users_email_idx",
    "view:public.active_users",
    "sequence:public.legacy_seq",
  ]) assert.ok(report.schemaDrift.differences.some((item) => item.path === pathValue));
  const serialized = JSON.stringify(report);
  for (const marker of ["constraint-marker", "hidden_marker", "view-marker", "START 9"]) assert.equal(serialized.includes(marker), false);
});

test("enum value ordering is schema drift", () => {
  const expected = snapshot("expected");
  const observedRaw = rawSnapshot("observed");
  observedRaw.schemas[0].enums[0].values = ["disabled", "active"];
  const observed = snapshot("observed", { schemas: observedRaw.schemas });
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  const difference = report.schemaDrift.differences.find((item) => item.path === "enum:public.user_status");
  assert.deepEqual(difference?.fields, ["values"]);
  assert.equal(report.overallStatus, "FAIL");
});

test("normalized definition whitespace does not create drift", () => {
  const expected = snapshot("expected");
  const observedRaw = rawSnapshot("observed");
  observedRaw.schemas[0].tables[0].constraints[0].definition = "  PRIMARY   KEY   (id)  ";
  observedRaw.schemas[0].tables[0].indexes[0].definition = " CREATE  UNIQUE INDEX users_email_idx ON public.users USING btree (email) ";
  observedRaw.schemas[0].views[0].definition = " SELECT   id FROM public.users WHERE active = true ";
  const observed = snapshot("observed", { schemas: observedRaw.schemas });
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  assert.equal(report.schemaDrift.status, "MATCH");
  assert.equal(report.overallStatus, "PASS");
});

test("snapshot trust metadata does not change schema truth", () => {
  const expected = snapshot("expected", {
    evidence: { source: "manual-expected", authenticated: false, collectedAt: "2026-09-16T08:30:00Z" },
  });
  const observed = snapshot("observed", {
    evidence: { source: "manual-observed", authenticated: false, collectedAt: "2026-09-16T08:31:00Z" },
  });
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  assert.equal(report.evidence.expected.authenticated, false);
  assert.equal(report.evidence.observed.authenticated, false);
  assert.equal(report.overallStatus, "PASS");
});

test("migration manifest digest is deterministic and order-sensitive", () => {
  const first = manifest();
  const same = manifest();
  assert.equal(migrationManifestDigest(first), migrationManifestDigest(same));
  const reversed = { version: /** @type {1} */ (1), migrations: [...first.migrations].reverse() };
  assert.notEqual(migrationManifestDigest(first), migrationManifestDigest(reversed));
});

test("wrong snapshot kinds are rejected by the drift inspector", () => {
  assert.throws(
    () => inspectDatabaseSchemaDrift(snapshot("observed"), snapshot("observed"), { manifest: manifest() }),
    /expected snapshot must have kind expected/,
  );
  assert.throws(
    () => inspectDatabaseSchemaDrift(snapshot("expected"), snapshot("expected"), { manifest: manifest() }),
    /observed snapshot must have kind observed/,
  );
});

test("human drift output contains paths and changed field names but no raw definitions", () => {
  const expected = snapshot("expected");
  const observedRaw = rawSnapshot("observed");
  observedRaw.schemas[0].views[0].definition = "SELECT 'human-secret-marker'::text";
  const observed = snapshot("observed", { schemas: observedRaw.schemas });
  const report = inspectDatabaseSchemaDrift(expected, observed, { manifest: manifest() });
  const text = formatDatabaseSchemaDrift(report);
  assert.match(text, /view:public\.active_users/);
  assert.match(text, /definition/);
  assert.equal(text.includes("human-secret-marker"), false);
});

test("CLI distinguishes PASS with manifest, WARN without manifest, and FAIL on drift", () => {
  const expectedFile = jsonFile(rawSnapshot("expected"), "expected");
  const observedFile = jsonFile(rawSnapshot("observed"), "observed");
  const manifestFile = jsonFile(manifest(), "manifest");

  const pass = runMain(
    "--expected-file", expectedFile,
    "--observed-file", observedFile,
    "--migration-manifest", manifestFile,
    "--migration-root", "migrations",
    "--json",
  );
  assert.equal(pass.status, 0);
  assert.equal(JSON.parse(pass.stdout).overallStatus, "PASS");

  const warn = runMain("--expected-file", expectedFile, "--observed-file", observedFile, "--json");
  assert.equal(warn.status, 0);
  assert.equal(JSON.parse(warn.stdout).overallStatus, "WARN");

  const drifted = rawSnapshot("observed");
  drifted.schemas[0].tables[0].columns[0].type = "text";
  const driftFile = jsonFile(drifted, "drifted");
  const fail = runMain(
    "--expected-file", expectedFile,
    "--observed-file", driftFile,
    "--migration-manifest", manifestFile,
    "--migration-root", "migrations",
    "--json",
  );
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).schemaDrift.status, "MISMATCH");
});

test("CLI rejects malformed, missing, invalid, and wrong-kind snapshot inputs", () => {
  const expectedFile = jsonFile(rawSnapshot("expected"), "expected-valid");
  const observedFile = jsonFile(rawSnapshot("observed"), "observed-valid");
  const malformed = jsonFile("{", "malformed");
  const invalidExpected = rawSnapshot("expected");
  delete invalidExpected.migrationManifestSha256;
  const invalidExpectedFile = jsonFile(invalidExpected, "invalid-expected");
  const wrongKindObserved = jsonFile(rawSnapshot("expected"), "wrong-kind");
  const missing = path.join(os.tmpdir(), "schema-drift-no-such-snapshot.json");

  for (const args of [
    [],
    ["--expected-file", missing, "--observed-file", observedFile],
    ["--expected-file", malformed, "--observed-file", observedFile],
    ["--expected-file", invalidExpectedFile, "--observed-file", observedFile],
    ["--expected-file", expectedFile, "--observed-file", wrongKindObserved],
    ["--expected-file", expectedFile, "--observed-file", missing],
    ["--expected-file", expectedFile, "--observed-file", observedFile, "--unknown"],
  ]) assert.equal(runMain(...args).status, 1);
});

test("migration manifest CLI input must be paired with explicit roots", () => {
  const expectedFile = jsonFile(rawSnapshot("expected"), "expected-pair");
  const observedFile = jsonFile(rawSnapshot("observed"), "observed-pair");
  const manifestFile = jsonFile(manifest(), "manifest-pair");
  assert.equal(runMain("--expected-file", expectedFile, "--observed-file", observedFile, "--migration-manifest", manifestFile).status, 1);
  assert.equal(runMain("--expected-file", expectedFile, "--observed-file", observedFile, "--migration-root", "migrations").status, 1);
  assert.equal(runMain("--expected-file", expectedFile, "--observed-file", observedFile, "--migration-manifest", manifestFile, "--migration-root", "../outside").status, 1);
});

test("invalid migration manifest is a structural CLI input failure", () => {
  const expectedFile = jsonFile(rawSnapshot("expected"), "expected-manifest");
  const observedFile = jsonFile(rawSnapshot("observed"), "observed-manifest");
  const invalidManifest = jsonFile({ version: 1, migrations: [{ path: "outside/x.sql", sha256: "a".repeat(64) }] }, "invalid-manifest");
  const result = runMain(
    "--expected-file", expectedFile,
    "--observed-file", observedFile,
    "--migration-manifest", invalidManifest,
    "--migration-root", "migrations",
  );
  assert.equal(result.status, 1);
});

test("drift audit has no database, Git, network, environment, or write surface", () => {
  const source = fs.readFileSync(path.resolve("scripts/audit-database-schema-drift.js"), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|https?:\/\//);
  assert.doesNotMatch(source, /process\.env|postgres(?:ql)?:\/\/|psql|supabase/);
  assert.doesNotMatch(source, /writeFile|appendFile|unlink|rmSync|rename|mkdir/);
  assert.match(source, /migrationManifestDigest/);
  assert.match(source, /validateDatabaseSchemaSnapshot/);
});
