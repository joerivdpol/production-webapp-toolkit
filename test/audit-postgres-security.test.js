import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatPostgresSecurityAudit,
  inspectPostgresSecurity,
  main,
  validatePostgresSecurityPolicy,
} from "../scripts/audit-postgres-security.js";
import { validatePostgresSecuritySnapshot } from "../scripts/postgres-security-snapshot.js";

/** @returns {any} */
function rawSnapshot() {
  return {
    version: 1,
    engine: "postgresql",
    identity: { name: "primary-db", environment: "production" },
    evidence: { source: "synthetic", authenticated: true, collectedAt: "2026-09-16T12:30:00Z" },
    schemas: [{ name: "public", grants: [], tables: [], functions: [], sequences: [] }],
  };
}

/** @param {any} overrides */
function policy(overrides = {}) {
  return {
    version: 1,
    identity: { name: "primary-db", environment: "production" },
    tableRules: [],
    schemaRules: [],
    sequenceRules: [],
    securityDefiner: null,
    ...overrides,
  };
}

function validatedSnapshot(value = rawSnapshot()) {
  const result = validatePostgresSecuritySnapshot(value);
  assert.equal(result.ok, true);
  if (!result.ok || result.snapshot === null) throw new Error("fixture invalid");
  return result.snapshot;
}

/** @param {any} value */
function validatedPolicy(value) {
  const result = validatePostgresSecurityPolicy(value);
  assert.equal(result.ok, true);
  if (!result.ok || result.policy === null) throw new Error("policy fixture invalid");
  return result.policy;
}

test("requires explicit identity and at least one security rule", () => {
  assert.equal(validatePostgresSecurityPolicy({ version: 1, identity: { name: "db" } }).ok, false);
  assert.equal(validatePostgresSecurityPolicy(policy({
    tableRules: [{ selector: "public.users", requireRls: true }],
  })).ok, true);
  assert.equal(validatePostgresSecurityPolicy(policy({
    tableRules: [{ selector: "bad selector", requireRls: true }],
  })).ok, false);
});

test("database identity mismatch blocks policy evaluation", () => {
  const snapshot = validatedSnapshot();
  const result = inspectPostgresSecurity(snapshot, validatedPolicy({
    ...policy({ tableRules: [{ selector: "public.*", requireRls: true }] }),
    identity: { name: "other-db" },
  }));
  assert.equal(result.overallStatus, "FAIL");
  assert.equal(result.checks.length, 1);
  assert.equal(result.checks[0]?.id, "database-identity");
});

test("RLS and FORCE RLS requirements are evaluated independently", () => {
  const raw = rawSnapshot();
  raw.schemas[0].tables.push({
    name: "users", rlsEnabled: true, rlsForced: false, grants: [], policies: [],
  });
  const snapshot = validatedSnapshot(raw);
  const report = inspectPostgresSecurity(snapshot, validatedPolicy(policy({
    tableRules: [{ selector: "public.users", requireRls: true, requireForceRls: true }],
  })));
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((item) => item.id === "rls-required")?.status, "PASS");
  assert.equal(report.checks.find((item) => item.id === "force-rls-required")?.status, "FAIL");
});

test("wildcard table selectors must match at least one object", () => {
  const report = inspectPostgresSecurity(validatedSnapshot(), validatedPolicy(policy({
    tableRules: [{ selector: "private.*", requireRls: true }],
  })));
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "table-selector-empty"), true);
});

test("forbidden table grants and PUBLIC grants are blocking", () => {
  const raw = rawSnapshot();
  raw.schemas[0].tables.push({
    name: "payments", rlsEnabled: true, rlsForced: true,
    grants: [{ grantee: "PUBLIC", privileges: ["SELECT"] }], policies: [],
  });
  const report = inspectPostgresSecurity(validatedSnapshot(raw), validatedPolicy(policy({
    tableRules: [{
      selector: "public.payments",
      forbiddenGrants: [{ roles: ["anon"], privileges: ["SELECT"] }],
    }],
  })));
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((item) => item.id === "forbidden-grants")?.status, "FAIL");
});

test("schema and sequence grant policies are explicit", () => {
  const raw = rawSnapshot();
  raw.schemas[0].grants = [{ grantee: "anon", privileges: ["USAGE"] }];
  raw.schemas[0].sequences = [{ name: "users_id_seq", grants: [{ grantee: "anon", privileges: ["USAGE"] }] }];
  const report = inspectPostgresSecurity(validatedSnapshot(raw), validatedPolicy(policy({
    schemaRules: [{ schema: "public", forbiddenGrants: [{ roles: ["anon"], privileges: ["USAGE"] }] }],
    sequenceRules: [{ selector: "public.*", forbiddenGrants: [{ roles: ["anon"], privileges: ["USAGE"] }] }],
  })));
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.filter((item) => item.id === "forbidden-grants" && item.status === "FAIL").length, 2);
});

test("permissive always-true policies are blocked only for explicitly forbidden roles", () => {
  const raw = rawSnapshot();
  raw.schemas[0].tables.push({
    name: "profiles", rlsEnabled: true, rlsForced: false, grants: [],
    policies: [
      { name: "public_read", command: "SELECT", roles: ["anon"], permissive: true, usingAlwaysTrue: true, checkAlwaysTrue: null },
      { name: "staff_read", command: "SELECT", roles: ["authenticated"], permissive: true, usingAlwaysTrue: true, checkAlwaysTrue: null },
    ],
  });
  const report = inspectPostgresSecurity(validatedSnapshot(raw), validatedPolicy(policy({
    tableRules: [{ selector: "public.profiles", forbidAlwaysTruePolicyRoles: ["anon"] }],
  })));
  assert.equal(report.overallStatus, "FAIL");
  const check = report.checks.find((item) => item.id === "always-true-policy");
  assert.equal(check?.status, "FAIL");
  assert.match(check?.detail ?? "", /public_read/);
  assert.doesNotMatch(check?.detail ?? "", /staff_read/);
});

test("restrictive always-true policies do not trigger permissive exposure rule", () => {
  const raw = rawSnapshot();
  raw.schemas[0].tables.push({
    name: "profiles", rlsEnabled: true, rlsForced: false, grants: [],
    policies: [{ name: "restricted", command: "SELECT", roles: ["anon"], permissive: false, usingAlwaysTrue: true, checkAlwaysTrue: null }],
  });
  const report = inspectPostgresSecurity(validatedSnapshot(raw), validatedPolicy(policy({
    tableRules: [{ selector: "public.profiles", forbidAlwaysTruePolicyRoles: ["anon"] }],
  })));
  assert.equal(report.overallStatus, "PASS");
});

test("security definer policy checks explicit search_path and execute grants", () => {
  const raw = rawSnapshot();
  raw.schemas[0].functions.push({
    name: "dangerous", identityArguments: "uuid", securityDefiner: true,
    searchPath: null,
    grants: [{ grantee: "anon", privileges: ["EXECUTE"] }],
  });
  const report = inspectPostgresSecurity(validatedSnapshot(raw), validatedPolicy(policy({
    securityDefiner: {
      requireExplicitSearchPath: true,
      forbiddenSearchPathEntries: ["public"],
      forbiddenExecuteRoles: ["anon"],
    },
  })));
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((item) => item.id === "security-definer-search-path-required")?.status, "FAIL");
  assert.equal(report.checks.find((item) => item.id === "forbidden-grants")?.status, "FAIL");
});

test("security definer policy passes safe explicit search_path and grants", () => {
  const raw = rawSnapshot();
  raw.schemas[0].functions.push({
    name: "safe_task", identityArguments: "uuid", securityDefiner: true,
    searchPath: ["pg_catalog", "app_private"],
    grants: [{ grantee: "service_role", privileges: ["EXECUTE"] }],
  });
  const report = inspectPostgresSecurity(validatedSnapshot(raw), validatedPolicy(policy({
    securityDefiner: { requireExplicitSearchPath: true, forbiddenSearchPathEntries: ["public"], forbiddenExecuteRoles: ["anon"] },
  })));
  assert.equal(report.overallStatus, "PASS");
});

test("trust metadata is reported but does not change policy truth", () => {
  const raw = rawSnapshot();
  raw.evidence.authenticated = false;
  raw.schemas[0].tables.push({ name: "users", rlsEnabled: true, rlsForced: false, grants: [], policies: [] });
  const report = inspectPostgresSecurity(validatedSnapshot(raw), validatedPolicy(policy({
    tableRules: [{ selector: "public.users", requireRls: true }],
  })));
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.evidence.authenticated, false);
});

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `postgres-security-audit-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("CLI emits stable JSON and PASS/FAIL exit semantics", () => {
  const raw = rawSnapshot();
  raw.schemas[0].tables.push({ name: "users", rlsEnabled: true, rlsForced: false, grants: [], policies: [] });
  const snapshotFile = tempJson(raw);
  const policyFile = tempJson(policy({ tableRules: [{ selector: "public.users", requireRls: true }] }));
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--snapshot-file", snapshotFile, "--policy", policyFile, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  fs.rmSync(snapshotFile, { force: true });
  fs.rmSync(policyFile, { force: true });
});

test("policy validator rejects ambiguous false flags, duplicates, and empty rules", () => {
  assert.equal(validatePostgresSecurityPolicy(policy({ tableRules: [{ selector: "public.users", requireRls: false }] })).ok, false);
  assert.equal(validatePostgresSecurityPolicy(policy({
    tableRules: [
      { selector: "public.users", requireRls: true },
      { selector: "public.users", requireForceRls: true },
    ],
  })).ok, false);
  assert.equal(validatePostgresSecurityPolicy(policy({ securityDefiner: {} })).ok, false);
});

test("human output exposes checks without pretending authentication proves safety", () => {
  const raw = rawSnapshot();
  raw.evidence.authenticated = false;
  raw.schemas[0].tables.push({ name: "users", rlsEnabled: true, rlsForced: false, grants: [], policies: [] });
  const report = inspectPostgresSecurity(validatedSnapshot(raw), validatedPolicy(policy({
    tableRules: [{ selector: "public.users", requireRls: true }],
  })));
  const formatted = formatPostgresSecurityAudit(report);
  assert.match(formatted, /Authenticated: false/);
  assert.match(formatted, /Overall: PASS/);
});

test("security audit core has no database, network, env, or command surface", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-postgres-security.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|\bpsql\b|writeFile/);
  assert.match(source, /validatePostgresSecuritySnapshot/);
});
