import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  buildObservedPostgresSecuritySnapshot,
  buildPostgresSecurityQuery,
  collectPostgresSecuritySnapshot,
  formatPostgresSecurityCollection,
  main,
  parsePostgresSecurityOutput,
} from "../scripts/collect-postgres-security-snapshot.js";

/** @returns {any} */
function catalog() {
  return {
    tables: [{ schema: "public", name: "users", rlsEnabled: true, rlsForced: false }],
    tableGrants: [{ schema: "public", table: "users", grantee: "authenticated", privilege: "SELECT" }],
    policies: [{ schema: "public", table: "users", name: "users_select", command: "SELECT", roles: ["authenticated"], permissive: true, usingAlwaysTrue: false, checkAlwaysTrue: null }],
    schemaGrants: [{ schema: "public", grantee: "authenticated", privilege: "USAGE" }],
    functions: [{ schema: "public", name: "admin_task", identityArguments: "uuid", securityDefiner: true, searchPath: ["pg_catalog", "app_private"] }],
    functionGrants: [{ schema: "public", name: "admin_task", identityArguments: "uuid", grantee: "service_role", privilege: "EXECUTE" }],
    sequences: [{ schema: "public", name: "users_id_seq" }],
    sequenceGrants: [{ schema: "public", name: "users_id_seq", grantee: "authenticated", privilege: "SELECT" }],
  };
}

function catalogOutput(value = catalog()) {
  const lines = ["BEGIN"];
  for (const key of ["tables", "tableGrants", "policies", "schemaGrants", "functions", "functionGrants", "sequences", "sequenceGrants"]) {
    lines.push(`${key}\t${JSON.stringify(value[key])}`);
  }
  lines.push("COMMIT", "");
  return lines.join("\n");
}

/** @param {any} overrides */
function dependencies(overrides = {}) {
  /** @type {{ service: string, query: string }[]} */
  const calls = [];
  return {
    calls,
    value: {
      runPsql: /** @param {string} service @param {string} query */ (service, query) => {
        calls.push({ service, query });
        return overrides.runResult ?? { ok: true, output: catalogOutput(), error: null };
      },
      now: () => overrides.now ?? "2026-09-16T12:45:00.000Z",
    },
  };
}

/** @param {string[]} args @param {any} deps */
function captureMain(args, deps) {
  let stdout = "";
  let stderr = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try { return { status: main(args, deps), stdout, stderr }; }
  finally { console.log = originalLog; console.error = originalError; }
}

test("security catalog query is explicit, schema-scoped, and read only", () => {
  const query = buildPostgresSecurityQuery(["public", "app"]);
  assert.match(query, /^BEGIN READ ONLY;/);
  assert.match(query, /COMMIT;/);
  assert.match(query, /relrowsecurity/);
  assert.match(query, /polqual/);
  assert.doesNotMatch(query, /pg_get_functiondef/);
  assert.doesNotMatch(query, /\b(?:INSERT\s+INTO|UPDATE\s+[^;\n]+\s+SET|DELETE\s+FROM|DROP\s+(?:TABLE|SCHEMA|FUNCTION)|ALTER\s+(?:TABLE|SCHEMA|FUNCTION)|TRUNCATE\s+)\b/i);
  assert.throws(() => buildPostgresSecurityQuery([]));
  assert.throws(() => buildPostgresSecurityQuery(["public;drop"]));
});

test("parses all security catalog sections and ignores transaction chatter", () => {
  const result = parsePostgresSecurityOutput(catalogOutput());
  assert.equal(result.ok, true);
  if (!result.ok || result.catalog === null) return;
  assert.equal(result.catalog.tables[0].name, "users");
  assert.equal(result.catalog.policies[0].usingAlwaysTrue, false);
  assert.equal(result.catalog.functions[0].securityDefiner, true);
});

test("rejects missing, duplicate, malformed, and non-array catalog sections", () => {
  const missing = catalogOutput().split("\n").filter((line) => !line.startsWith("policies\t")).join("\n");
  assert.equal(parsePostgresSecurityOutput(missing).ok, false);
  assert.equal(parsePostgresSecurityOutput(`${catalogOutput()}tables\t[]\n`).ok, false);
  assert.equal(parsePostgresSecurityOutput(catalogOutput().replace("tables\t[", "tables\t{" )).ok, false);
  assert.equal(parsePostgresSecurityOutput(catalogOutput().replace("tables\t[", "tables\t\"" )).ok, false);
});

test("builds a canonical PostgreSQL security snapshot", () => {
  const result = buildObservedPostgresSecuritySnapshot(catalog(), {
    identityName: " primary-db ", environment: " production ", schemas: ["public"], collectedAt: "2026-09-16T12:45:00Z",
  });
  assert.equal(result.ok, true);
  if (!result.ok || result.snapshot === null) return;
  assert.equal(result.snapshot.schemas[0]?.tables[0]?.rlsEnabled, true);
  assert.deepEqual(result.snapshot.schemas[0]?.functions[0]?.searchPath, ["pg_catalog", "app_private"]);
});

test("rejects inconsistent catalog references instead of repairing provider data", () => {
  const unknown = catalog();
  unknown.tableGrants[0].table = "missing";
  assert.equal(buildObservedPostgresSecuritySnapshot(unknown, {
    identityName: "db", schemas: ["public"], collectedAt: "2026-09-16T12:45:00Z",
  }).ok, false);

  const badFunction = catalog();
  badFunction.functionGrants[0].identityArguments = "text";
  assert.equal(buildObservedPostgresSecuritySnapshot(badFunction, {
    identityName: "db", schemas: ["public"], collectedAt: "2026-09-16T12:45:00Z",
  }).ok, false);
});

test("collector validates service, identity, environment, and schemas before psql", () => {
  const deps = dependencies();
  for (const options of [
    { service: "bad service", identityName: "db", schemas: ["public"] },
    { service: "prod", identityName: " ", schemas: ["public"] },
    { service: "prod", identityName: "db", environment: " ", schemas: ["public"] },
    { service: "prod", identityName: "db", schemas: [] },
    { service: "prod", identityName: "db", schemas: ["bad-name"] },
    { service: "prod", identityName: "db", schemas: ["public", "public"] },
  ]) assert.equal(collectPostgresSecuritySnapshot(options, deps.value).ok, false);
  assert.equal(deps.calls.length, 0);
});

test("collector calls only the explicit service and timestamps after successful collection", () => {
  const deps = dependencies({ now: "2026-09-16T12:50:00.000Z" });
  const result = collectPostgresSecuritySnapshot({
    service: "audit-prod", identityName: "primary-db", environment: "production", schemas: ["public"],
  }, deps.value);
  assert.equal(result.ok, true);
  assert.equal(deps.calls.length, 1);
  assert.equal(deps.calls[0]?.service, "audit-prod");
  assert.match(deps.calls[0]?.query ?? "", /^BEGIN READ ONLY;/);
  if (!result.ok || result.snapshot === null) return;
  assert.equal(result.snapshot.evidence.collectedAt, "2026-09-16T12:50:00.000Z");
  assert.equal(result.snapshot.evidence.authenticated, true);
});

test("runner failures are redacted and malformed catalog output is rejected", () => {
  const marker = ["provider", "private", "detail"].join("-");
  const failed = dependencies({ runResult: { ok: false, output: null, error: { id: "psql-failed", detail: marker } } });
  const result = collectPostgresSecuritySnapshot({ service: "audit-prod", identityName: "db", schemas: ["public"] }, failed.value);
  assert.equal(result.ok, false);
  assert.equal(JSON.stringify(result).includes(marker), false);
  const malformed = dependencies({ runResult: { ok: true, output: "tables\t[]\n", error: null } });
  assert.equal(collectPostgresSecuritySnapshot({ service: "audit-prod", identityName: "db", schemas: ["public"] }, malformed.value).ok, false);
});

test("human formatter exposes metadata but no raw policy expressions", () => {
  const deps = dependencies();
  const result = collectPostgresSecuritySnapshot({ service: "audit-prod", identityName: "db", schemas: ["public"] }, deps.value);
  const text = formatPostgresSecurityCollection(result);
  assert.match(text, /PostgreSQL security snapshot collected/);
  assert.doesNotMatch(text, /PRIMARY KEY|CREATE|SELECT id/);
});

test("CLI emits canonical JSON and rejects incomplete input", () => {
  const deps = dependencies();
  const result = captureMain(["--service", "audit-prod", "--identity-name", "db", "--schema", "public", "--json"], deps.value);
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).identity.name, "db");
  assert.equal(captureMain(["--service", "audit-prod"], deps.value).status, 1);
  assert.equal(captureMain(["--service", "audit-prod", "--identity-name", "db", "--schema", "public", "--schema", "public"], deps.value).status, 1);
  assert.equal(captureMain(["--unknown"], deps.value).status, 1);
});

test("collector source is limited to psql read-only collection with no credential arguments or file writes", () => {
  const source = fs.readFileSync(new URL("../scripts/collect-postgres-security-snapshot.js", import.meta.url), "utf8");
  assert.match(source, /BEGIN READ ONLY/);
  assert.match(source, /spawnSync\("psql"/);
  assert.doesNotMatch(source, /password|PGPASSWORD|postgresql:\/\/|writeFile|appendFile|unlink|rmSync|process\.env/);
});
