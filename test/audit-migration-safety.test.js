import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  inspectMigrationSafety,
  main,
  parseMigrationId,
  sanitizeSql,
  validateMigrationManifest,
  validateMigrationRoots,
} from "../scripts/audit-migration-safety.js";

/** @type {string[]} */
const fixtures = [];

/** @param {string} prefix */
function tempDir(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

/** @param {Record<string, string | Buffer>} files */
function repository(files) {
  const root = tempDir("migration-safety-");
  for (const [relative, contents] of Object.entries(files)) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  return root;
}

/** @param {string | Buffer} value */
function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {string} root @param {string[]} paths */
function manifestFor(root, paths) {
  return {
    version: /** @type {1} */ (1),
    migrations: paths.map((relative) => ({
      path: relative,
      sha256: hash(fs.readFileSync(path.join(root, relative))),
    })),
  };
}

/** @param {string} root @param {unknown} value */
function manifestFile(root, value) {
  const filename = path.join(root, "applied-migrations.json");
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value, null, 2));
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
  for (const root of fixtures.splice(0).reverse()) fs.rmSync(root, { recursive: true, force: true });
});

test("parses common timestamp and Flyway migration identifiers", () => {
  assert.deepEqual(parseMigrationId("migrations/20260916120000_create_users.sql"), { scheme: "numeric-prefix", id: "20260916120000" });
  assert.deepEqual(parseMigrationId("migrations/20260916-create-users.sql"), { scheme: "numeric-prefix", id: "20260916" });
  assert.deepEqual(parseMigrationId("migrations/V2.3__create_users.sql"), { scheme: "flyway", id: "2.3" });
  assert.equal(parseMigrationId("migrations/create_users.sql"), null);
});

test("SQL sanitization hides comments, strings, quoted identifiers, and dollar bodies", () => {
  const sql = [
    "-- DROP TABLE hidden;",
    "SELECT 'DROP COLUMN hidden';",
    'SELECT "DROP INDEX hidden";',
    "/* TRUNCATE TABLE hidden; */",
    "CREATE FUNCTION f() RETURNS void AS $$ BEGIN DELETE FROM hidden; END $$ LANGUAGE plpgsql;",
    "CREATE TABLE visible(id bigint);",
  ].join("\n");
  const sanitized = sanitizeSql(sql);
  for (const hidden of ["DROP TABLE", "DROP COLUMN", "DROP INDEX", "TRUNCATE", "DELETE FROM hidden"]) assert.equal(sanitized.includes(hidden), false);
  assert.match(sanitized, /CREATE TABLE visible/);
});

test("safe additive migration with matching applied manifest is PASS", () => {
  const sql = "CREATE TABLE users(id bigint PRIMARY KEY);\n";
  const relative = "migrations/20260916120000_create_users.sql";
  const root = repository({ [relative]: sql });
  const manifest = manifestFor(root, [relative]);
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest });
  assert.equal(report.historyStatus, "MATCH");
  assert.equal(report.migrations[0]?.history, "APPLIED");
  assert.equal(report.migrations[0]?.scanned, true);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.technicalStatus, "PASS");
});

test("missing history manifest is a readiness warning rather than invented history truth", () => {
  const root = repository({
    "migrations/20260916120000_create_users.sql": "CREATE TABLE users(id bigint);\n",
  });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: null });
  assert.equal(report.historyConfigured, false);
  assert.equal(report.historyStatus, "NOT_CONFIGURED");
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.technicalStatus, "PASS");
  assert.ok(report.checks.some((check) => check.id === "history-not-configured"));
});

test("destructive DDL and destructive data operations are explicit warnings", () => {
  const relative = "migrations/20260916120100_destructive.sql";
  const sql = [
    "ALTER TABLE users DROP COLUMN legacy;",
    "DROP TABLE old_users;",
    "DROP TYPE old_status;",
    "DROP INDEX old_idx;",
    "ALTER TABLE users DROP CONSTRAINT users_fk;",
    "TRUNCATE TABLE scratch;",
    "DELETE FROM audit_log;",
  ].join("\n");
  const root = repository({ [relative]: sql });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.equal(report.overallStatus, "WARN");
  const ids = new Set(report.checks.map((check) => check.id));
  assert.ok(ids.has("destructive-ddl"));
  assert.ok(ids.has("destructive-data-operation"));
  assert.ok(ids.has("unbounded-delete"));
});

test("bounded DELETE does not trigger the unbounded-delete warning", () => {
  const relative = "migrations/20260916120200_cleanup.sql";
  const root = repository({ [relative]: "DELETE FROM audit_log WHERE created_at < now();\n" });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.equal(report.checks.some((check) => check.id === "unbounded-delete"), false);
});

test("locking and validation risks are classified without blocking intentional migration work", () => {
  const relative = "migrations/20260916120300_locking.sql";
  const sql = [
    "CREATE INDEX users_email_idx ON users(email);",
    'ALTER TABLE users ALTER COLUMN "age" TYPE bigint;',
    "ALTER TABLE users ALTER COLUMN email SET NOT NULL;",
    'ALTER TABLE users ADD CONSTRAINT "users_org_fk" FOREIGN KEY (org_id) REFERENCES orgs(id);',
    "LOCK TABLE users IN ACCESS EXCLUSIVE MODE;",
    "REINDEX TABLE users;",
  ].join("\n");
  const root = repository({ [relative]: sql });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  const ids = new Set(report.checks.map((check) => check.id));
  for (const id of ["blocking-index-build", "column-type-rewrite", "not-null-validation", "foreign-key-validation", "explicit-locking-operation"]) assert.ok(ids.has(id), id);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.technicalStatus, "PASS");
});

test("safer PostgreSQL index and deferred foreign-key forms avoid the matching warnings", () => {
  const relative = "migrations/20260916120400_safer.sql";
  const sql = [
    "CREATE INDEX CONCURRENTLY users_email_idx ON users(email);",
    "ALTER TABLE users ADD CONSTRAINT users_org_fk FOREIGN KEY (org_id) REFERENCES orgs(id) NOT VALID;",
  ].join("\n");
  const root = repository({ [relative]: sql });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.equal(report.checks.some((check) => check.id === "blocking-index-build"), false);
  assert.equal(report.checks.some((check) => check.id === "foreign-key-validation"), false);
  assert.equal(report.overallStatus, "PASS");
});

test("CREATE INDEX CONCURRENTLY inside an explicit transaction is blocking FAIL", () => {
  const relative = "migrations/20260916120500_bad_concurrent.sql";
  const root = repository({ [relative]: "BEGIN;\nCREATE INDEX CONCURRENTLY users_email_idx ON users(email);\nCOMMIT;\n" });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "concurrent-index-in-transaction")?.severity, "FAIL");
});

test("unbalanced explicit transactions are blocking FAIL", () => {
  const relative = "migrations/20260916120600_unbalanced.sql";
  const root = repository({ [relative]: "BEGIN;\nCREATE TABLE users(id bigint);\n" });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.equal(report.overallStatus, "FAIL");
  assert.ok(report.checks.some((check) => check.id === "transaction-boundary-unbalanced"));
});

test("new NOT NULL columns and volatile defaults are highlighted", () => {
  const relative = "migrations/20260916120700_columns.sql";
  const sql = [
    "ALTER TABLE users ADD COLUMN external_id text NOT NULL;",
    "ALTER TABLE users ADD COLUMN created_token uuid DEFAULT gen_random_uuid();",
  ].join("\n");
  const root = repository({ [relative]: sql });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.ok(report.checks.some((check) => check.id === "not-null-column-no-default"));
  assert.ok(report.checks.some((check) => check.id === "volatile-column-default"));
  assert.equal(report.overallStatus, "WARN");
});

test("enum value additions are classified as hard-to-reverse warnings", () => {
  const relative = "migrations/20260916120800_enum.sql";
  const root = repository({ [relative]: "ALTER TYPE status ADD VALUE 'archived';\n" });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.ok(report.checks.some((check) => check.id === "irreversible-enum-change"));
  assert.equal(report.overallStatus, "WARN");
});

test("comments, literals, and function bodies do not create destructive false positives", () => {
  const relative = "migrations/20260916120900_function.sql";
  const sql = [
    "-- DROP TABLE users;",
    "SELECT 'TRUNCATE TABLE users';",
    "CREATE FUNCTION cleanup() RETURNS void AS $$ BEGIN DELETE FROM users; END $$ LANGUAGE plpgsql;",
    "CREATE TABLE safe_table(id bigint);",
  ].join("\n");
  const root = repository({ [relative]: sql });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  for (const id of ["destructive-ddl", "destructive-data-operation", "unbounded-delete"]) assert.equal(report.checks.some((check) => check.id === id), false, id);
  assert.equal(report.overallStatus, "PASS");
});

test("duplicate migration IDs are blocking even when filenames differ", () => {
  const root = repository({
    "migrations/20260916121000_one.sql": "CREATE TABLE one(id bigint);\n",
    "migrations/20260916121000_two.sql": "CREATE TABLE two(id bigint);\n",
  });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.equal(report.overallStatus, "FAIL");
  assert.ok(report.checks.some((check) => check.id === "duplicate-migration-id"));
});

test("unrecognized IDs, invalid timestamps, and width drift are warnings", () => {
  const root = repository({
    "migrations/create_users.sql": "CREATE TABLE users(id bigint);\n",
    "migrations/20261340_invalid_date.sql": "CREATE TABLE bad_date(id bigint);\n",
    "migrations/20260916121100_timestamp.sql": "CREATE TABLE timestamped(id bigint);\n",
  });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  const ids = new Set(report.checks.map((check) => check.id));
  assert.ok(ids.has("migration-id-unrecognized"));
  assert.ok(ids.has("migration-id-invalid-timestamp"));
  assert.ok(ids.has("migration-id-width-drift"));
  assert.equal(report.overallStatus, "WARN");
});

test("duplicate basenames across migration roots warn without conflating exact paths", () => {
  const filename = "20260916121200_shared.sql";
  const root = repository({
    [`db-a/${filename}`]: "CREATE TABLE a(id bigint);\n",
    [`db-b/${filename}`]: "CREATE TABLE b(id bigint);\n",
  });
  const report = inspectMigrationSafety(root, { migrationRoots: ["db-a", "db-b"], manifest: { version: 1, migrations: [] } });
  assert.ok(report.checks.some((check) => check.id === "duplicate-migration-basename"));
  assert.ok(report.checks.some((check) => check.id === "duplicate-migration-id"));
  assert.equal(report.overallStatus, "FAIL");
});

test("matching history manifest distinguishes applied and new migrations", () => {
  const applied = "migrations/20260916121300_applied.sql";
  const next = "migrations/20260916121400_new.sql";
  const root = repository({
    [applied]: "CREATE TABLE applied_table(id bigint);\n",
    [next]: "CREATE TABLE new_table(id bigint);\n",
  });
  const manifest = manifestFor(root, [applied]);
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest });
  assert.equal(report.historyStatus, "MATCH");
  assert.equal(report.summary.applied, 1);
  assert.equal(report.summary.new, 1);
  assert.equal(report.migrations.find((item) => item.path === applied)?.history, "APPLIED");
  assert.equal(report.migrations.find((item) => item.path === next)?.history, "NEW");
  assert.equal(report.overallStatus, "PASS");
});

test("modified applied migration is blocking FAIL", () => {
  const relative = "migrations/20260916121500_applied.sql";
  const original = "CREATE TABLE applied_table(id bigint);\n";
  const root = repository({ [relative]: original });
  const manifest = manifestFor(root, [relative]);
  fs.writeFileSync(path.join(root, relative), `${original}ALTER TABLE applied_table ADD COLUMN changed text;\n`);
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest });
  assert.equal(report.historyStatus, "MISMATCH");
  assert.equal(report.overallStatus, "FAIL");
  assert.ok(report.checks.some((check) => check.id === "modified-applied-migration"));
});

test("missing manifested applied migration is blocking FAIL", () => {
  const present = "migrations/20260916121600_present.sql";
  const missing = "migrations/20260916121500_missing.sql";
  const root = repository({ [present]: "CREATE TABLE present_table(id bigint);\n" });
  const manifest = {
    version: /** @type {1} */ (1),
    migrations: [
      { path: missing, sha256: "a".repeat(64) },
    ],
  };
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest });
  assert.equal(report.historyStatus, "MISMATCH");
  assert.equal(report.overallStatus, "FAIL");
  assert.ok(report.checks.some((check) => check.id === "applied-migration-missing"));
});

test("migration manifests reject unsafe paths, bad hashes, duplicates, and unknown fields", () => {
  const valid = { version: 1, migrations: [{ path: "migrations/20260916121700_ok.sql", sha256: "A".repeat(64) }] };
  const normalized = validateMigrationManifest(valid, ["migrations"]);
  assert.equal(normalized.ok, true);
  assert.equal(normalized.manifest?.migrations[0]?.sha256, "a".repeat(64));

  for (const value of [
    { version: 2, migrations: [] },
    { version: 1 },
    { version: 1, migrations: [{ path: "../outside.sql", sha256: "a".repeat(64) }] },
    { version: 1, migrations: [{ path: "other/20260916121700.sql", sha256: "a".repeat(64) }] },
    { version: 1, migrations: [{ path: "migrations/20260916121700.sql", sha256: "bad" }] },
    { version: 1, migrations: [{ path: "migrations/20260916121700.sql", sha256: "a".repeat(64), extra: true }] },
    { version: 1, migrations: [
      { path: "migrations/20260916121700.sql", sha256: "a".repeat(64) },
      { path: "migrations/20260916121700.sql", sha256: "b".repeat(64) },
    ] },
  ]) assert.equal(validateMigrationManifest(value, ["migrations"]).ok, false);
});

test("migration roots must be explicit, unique, and repository relative", () => {
  assert.equal(validateMigrationRoots([]).ok, false);
  assert.equal(validateMigrationRoots(["../outside"]).ok, false);
  assert.equal(validateMigrationRoots(["migrations", "migrations"]).ok, false);
  assert.deepEqual(validateMigrationRoots([" db/migrations "]), { ok: true, roots: ["db/migrations"], error: null });
});

test("missing and invalid migration roots are policy failures, not technical crashes", () => {
  const root = repository({ "README.txt": "fixture\n" });
  const missing = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.equal(missing.technicalStatus, "PASS");
  assert.equal(missing.overallStatus, "FAIL");
  assert.ok(missing.checks.some((check) => check.id === "migration-root-missing"));

  fs.writeFileSync(path.join(root, "not-a-directory"), "fixture\n");
  const invalid = inspectMigrationSafety(root, { migrationRoots: ["not-a-directory"], manifest: { version: 1, migrations: [] } });
  assert.equal(invalid.technicalStatus, "PASS");
  assert.ok(invalid.checks.some((check) => check.id === "migration-root-invalid"));
});

test("migration symlinks are blocking and are never followed outside the repository", () => {
  const root = repository({ "migrations/20260916121800_real.sql": "CREATE TABLE real_table(id bigint);\n" });
  const outside = tempDir("migration-safety-outside-");
  const outsideFile = path.join(outside, "outside.sql");
  fs.writeFileSync(outsideFile, "DROP TABLE production_data;\n");
  fs.symlinkSync(outsideFile, path.join(root, "migrations", "20260916121900_linked.sql"));
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.equal(report.overallStatus, "FAIL");
  assert.ok(report.checks.some((check) => check.id === "migration-symlink"));
  assert.equal(report.migrations.some((item) => item.path.endsWith("linked.sql")), false);
});

test("binary SQL is blocking and oversized SQL is explicitly unscanned with WARN", () => {
  const binaryRoot = repository({
    "migrations/20260916122000_binary.sql": Buffer.from([67, 82, 69, 65, 84, 69, 0, 84, 65, 66, 76, 69]),
  });
  const binary = inspectMigrationSafety(binaryRoot, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.equal(binary.overallStatus, "FAIL");
  assert.ok(binary.checks.some((check) => check.id === "migration-binary"));

  const largeSql = `${" ".repeat(5 * 1024 * 1024 + 32)}CREATE TABLE large_table(id bigint);\n`;
  const largeRoot = repository({ "migrations/20260916122100_large.sql": largeSql });
  const large = inspectMigrationSafety(largeRoot, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.equal(large.overallStatus, "WARN");
  assert.equal(large.migrations[0]?.scanned, false);
  assert.ok(large.checks.some((check) => check.id === "migration-too-large"));
});

test("empty migration directories report WARN rather than inventing migration safety", () => {
  const root = tempDir("migration-safety-empty-");
  fs.mkdirSync(path.join(root, "migrations"));
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: { version: 1, migrations: [] } });
  assert.equal(report.overallStatus, "WARN");
  assert.ok(report.checks.some((check) => check.id === "no-migration-files"));
});

test("missing repository is a technical failure", () => {
  const report = inspectMigrationSafety(path.join(os.tmpdir(), "migration-safety-no-such-repository"), {
    migrationRoots: ["migrations"],
    manifest: null,
  });
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.overallStatus, "FAIL");
});

test("CLI JSON and human output preserve PASS WARN FAIL exit semantics", () => {
  const passRelative = "migrations/20260916122200_pass.sql";
  const passRoot = repository({ [passRelative]: "CREATE TABLE pass_table(id bigint);\n" });
  const passManifest = manifestFile(passRoot, manifestFor(passRoot, [passRelative]));
  const pass = runMain(passRoot, "--root", "migrations", "--manifest", passManifest, "--json");
  assert.equal(pass.status, 0);
  assert.equal(JSON.parse(pass.stdout).overallStatus, "PASS");

  const warnRoot = repository({ "migrations/20260916122300_warn.sql": "CREATE INDEX idx ON users(email);\n" });
  const warnManifest = manifestFile(warnRoot, { version: 1, migrations: [] });
  const warn = runMain(warnRoot, "--root", "migrations", "--manifest", warnManifest, "--json");
  assert.equal(warn.status, 0);
  assert.equal(JSON.parse(warn.stdout).overallStatus, "WARN");

  const failRoot = repository({ "migrations/20260916122400_fail.sql": "BEGIN;\nCREATE INDEX CONCURRENTLY idx ON users(email);\nCOMMIT;\n" });
  const failManifest = manifestFile(failRoot, { version: 1, migrations: [] });
  const fail = runMain(failRoot, "--root", "migrations", "--manifest", failManifest, "--json");
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).overallStatus, "FAIL");

  const human = runMain(passRoot, "--root", "migrations", "--manifest", passManifest);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Migration safety audit/);
  assert.match(human.stdout, /History: MATCH/);
  assert.match(human.stdout, /Overall: PASS/);
});

test("CLI accepts multiple roots and rejects invalid or malformed input", () => {
  const root = repository({
    "db-a/20260916122500_a.sql": "CREATE TABLE a(id bigint);\n",
    "db-b/V1__b.sql": "CREATE TABLE b(id bigint);\n",
  });
  const validManifest = manifestFile(root, { version: 1, migrations: [] });
  const valid = runMain(root, "--root", "db-a", "--root", "db-b", "--manifest", validManifest, "--json");
  assert.equal(valid.status, 0);
  assert.equal(JSON.parse(valid.stdout).migrations.length, 2);

  const malformed = manifestFile(root, "{");
  const badSchema = manifestFile(root, { version: 2, migrations: [] });
  for (const args of [
    [root],
    [root, "--root", "../outside"],
    [root, "--root", "db-a", "--root", "db-a"],
    [root, "--root", "db-a", "--manifest", path.join(root, "missing.json")],
    [root, "--root", "db-a", "--manifest", malformed],
    [root, "--root", "db-a", "--manifest", badSchema],
    [root, "--root", "db-a", "--unknown"],
  ]) assert.equal(runMain(...args).status, 1);
});

test("manifest hashes and reports never include SQL contents", () => {
  const relative = "migrations/20260916122600_sensitive.sql";
  const marker = ["do", "not", "echo", "migration", "contents"].join("-");
  const sql = `CREATE TABLE audit_note(note text DEFAULT '${marker}');\n`;
  const root = repository({ [relative]: sql });
  const report = inspectMigrationSafety(root, { migrationRoots: ["migrations"], manifest: manifestFor(root, [relative]) });
  assert.equal(JSON.stringify(report).includes(marker), false);
  assert.equal(report.migrations[0]?.sha256, hash(sql));
});

test("source audit is local, read only, and has no database, Git, or network surface", () => {
  const source = fs.readFileSync(path.resolve("scripts/audit-migration-safety.js"), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|https?:\/\//);
  assert.doesNotMatch(source, /\bpg\b|postgres(?:ql)?:\/\/|supabase|psql/);
  assert.doesNotMatch(source, /writeFile|appendFile|unlink|rmSync|rename|mkdir/);
  assert.match(source, /modified-applied-migration/);
  assert.match(source, /concurrent-index-in-transaction/);
});
