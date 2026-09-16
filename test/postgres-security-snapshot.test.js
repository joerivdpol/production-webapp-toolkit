import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatPostgresSecuritySnapshot,
  main,
  validatePostgresSecuritySnapshot,
} from "../scripts/postgres-security-snapshot.js";

/** @returns {any} */
function rawSnapshot() {
  return {
    version: 1,
    engine: "postgresql",
    identity: { name: "primary-db", environment: "production" },
    evidence: { source: "synthetic-catalog", authenticated: true, collectedAt: "2026-09-16T12:30:00Z" },
    schemas: [{
      name: "public",
      grants: [{ grantee: "authenticated", privileges: ["USAGE"] }],
      tables: [{
        name: "users",
        rlsEnabled: true,
        rlsForced: false,
        grants: [{ grantee: "authenticated", privileges: ["SELECT"] }],
        policies: [{
          name: "users_select",
          command: "SELECT",
          roles: ["authenticated"],
          permissive: true,
          usingAlwaysTrue: false,
          checkAlwaysTrue: null,
        }],
      }],
      functions: [{
        name: "admin_task",
        identityArguments: "uuid",
        securityDefiner: true,
        searchPath: ["pg_catalog", "app_private"],
        grants: [{ grantee: "service_role", privileges: ["EXECUTE"] }],
      }],
      sequences: [{ name: "users_id_seq", grants: [{ grantee: "authenticated", privileges: ["SELECT"] }] }],
    }],
  };
}
/** @param {any} value */
function tempFile(value) {
  const filename = path.join(os.tmpdir(), `postgres-security-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("normalizes a valid PostgreSQL security snapshot", () => {
  const result = validatePostgresSecuritySnapshot(rawSnapshot());
  assert.equal(result.ok, true);
  if (!result.ok || result.snapshot === null) return;
  assert.equal(result.snapshot.identity.name, "primary-db");
  assert.equal(result.snapshot.schemas[0]?.tables[0]?.name, "users");
  assert.deepEqual(result.snapshot.schemas[0]?.tables[0]?.grants[0]?.privileges, ["SELECT"]);
  assert.equal(result.snapshot.schemas[0]?.functions[0]?.searchPath?.[1], "app_private");
  assert.match(formatPostgresSecuritySnapshot(result.snapshot), /Result: VALID/);
});

test("rejects unknown fields, duplicate objects, and malformed grants", () => {
  const unknown = rawSnapshot();
  unknown.extra = true;
  assert.equal(validatePostgresSecuritySnapshot(unknown).ok, false);

  const duplicate = rawSnapshot();
  duplicate.schemas[0].tables.push(structuredClone(duplicate.schemas[0].tables[0]));
  assert.equal(validatePostgresSecuritySnapshot(duplicate).ok, false);

  const grants = rawSnapshot();
  grants.schemas[0].tables[0].grants = [{ grantee: "anon", privileges: ["select", "SELECT"] }];
  assert.equal(validatePostgresSecuritySnapshot(grants).ok, false);
});

test("normalizes policy commands, roles, privileges, and object ordering", () => {
  const value = rawSnapshot();
  value.schemas[0].grants = [{ grantee: "PUBLIC", privileges: ["usage"] }];
  value.schemas[0].tables[0].policies[0].command = "select";
  value.schemas[0].tables[0].policies[0].roles = ["authenticated", "anon"];
  const result = validatePostgresSecuritySnapshot(value);
  assert.equal(result.ok, true);
  if (!result.ok || result.snapshot === null) return;
  assert.equal(result.snapshot.schemas[0]?.tables[0]?.policies[0]?.command, "SELECT");
  assert.deepEqual(result.snapshot.schemas[0]?.tables[0]?.policies[0]?.roles, ["anon", "authenticated"]);
  assert.deepEqual(result.snapshot.schemas[0]?.grants[0]?.privileges, ["USAGE"]);
});

test("rejects malformed RLS, policy, function, and sequence evidence", () => {
  const values = [rawSnapshot(), rawSnapshot(), rawSnapshot(), rawSnapshot()];
  values[0].schemas[0].tables[0].rlsEnabled = "yes";
  values[1].schemas[0].tables[0].policies[0].usingAlwaysTrue = "unknown";
  values[2].schemas[0].functions[0].searchPath = ["public", "public"];
  values[3].schemas[0].sequences[0].grants = "invalid";
  for (const value of values) assert.equal(validatePostgresSecuritySnapshot(value).ok, false);
});

test("requires absolute evidence timestamps and explicit database identity", () => {
  const badTime = rawSnapshot();
  badTime.evidence.collectedAt = "2026-09-16";
  assert.equal(validatePostgresSecuritySnapshot(badTime).ok, false);

  const badIdentity = rawSnapshot();
  badIdentity.identity.name = " ";
  assert.equal(validatePostgresSecuritySnapshot(badIdentity).ok, false);
});

test("CLI validates files and emits stable JSON without mutating input", () => {
  const filename = tempFile(rawSnapshot());
  const before = fs.readFileSync(filename, "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", filename, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).identity.name, "primary-db");
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  fs.rmSync(filename, { force: true });
});

test("snapshot CLI rejects malformed, missing, invalid, and unknown input", () => {
  const malformed = tempFile("{");
  const invalid = tempFile({ version: 1, engine: "postgresql" });
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--file", invalid]), 1);
  assert.equal(main(["--file", "/tmp/definitely-missing-security-snapshot.json"]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  fs.rmSync(invalid, { force: true });
});

test("security snapshot contract carries no raw policy expressions or function definitions", () => {
  const result = validatePostgresSecuritySnapshot(rawSnapshot());
  assert.equal(result.ok, true);
  if (!result.ok || result.snapshot === null) return;
  const serialized = JSON.stringify(result.snapshot);
  assert.doesNotMatch(serialized, /qual|withCheck|functionDefinition|sourceSql/);
  const source = fs.readFileSync(new URL("../scripts/postgres-security-snapshot.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|\bpsql\b|writeFile/);
});
