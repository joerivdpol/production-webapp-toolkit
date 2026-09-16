#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validatePostgresSecuritySnapshot } from "./postgres-security-snapshot.js";

/** @typedef {{ roles: string[], privileges: string[] }} ForbiddenGrantRule */
/** @typedef {{ selector: string, requireRls: boolean, requireForceRls: boolean, forbiddenGrants: ForbiddenGrantRule[], forbidAlwaysTruePolicyRoles: string[] }} TableRule */
/** @typedef {{ schema: string, forbiddenGrants: ForbiddenGrantRule[] }} SchemaRule */
/** @typedef {{ selector: string, forbiddenGrants: ForbiddenGrantRule[] }} SequenceRule */
/** @typedef {{ requireExplicitSearchPath: boolean, forbiddenSearchPathEntries: string[], forbiddenExecuteRoles: string[] }} SecurityDefinerRule */
/** @typedef {{ version: 1, identity: { name: string, environment?: string }, tableRules: TableRule[], schemaRules: SchemaRule[], sequenceRules: SequenceRule[], securityDefiner: SecurityDefinerRule | null }} PostgresSecurityPolicy */
/** @typedef {{ id: string, status: "PASS" | "FAIL", object: string, detail: string }} SecurityCheck */
/** @typedef {{ grantee: string, privileges: string[] }} EvidenceGrant */
/** @typedef {{ name: string, command: string, roles: string[], permissive: boolean, usingAlwaysTrue: boolean | null, checkAlwaysTrue: boolean | null }} EvidencePolicy */
/** @typedef {{ name: string, rlsEnabled: boolean, rlsForced: boolean, grants: EvidenceGrant[], policies: EvidencePolicy[] }} EvidenceTable */
/** @typedef {{ name: string, identityArguments: string, securityDefiner: boolean, searchPath: string[] | null, grants: EvidenceGrant[] }} EvidenceFunction */
/** @typedef {{ name: string, grants: EvidenceGrant[] }} EvidenceSequence */
/** @typedef {{ name: string, grants: EvidenceGrant[], tables: EvidenceTable[], functions: EvidenceFunction[], sequences: EvidenceSequence[] }} EvidenceSchema */
/** @typedef {{ identity: { name: string, environment?: string }, evidence: { source: string, authenticated: boolean, collectedAt: string }, schemas: EvidenceSchema[] }} SecurityEvidence */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed */
function hasOnlyFields(value, allowed) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

/** @param {unknown} value */
function normalizeNames(value) {
  if (!Array.isArray(value)) return null;
  const names = value.map((item) => nonEmptyString(item));
  if (names.some((item) => item === null)) return null;
  const normalized = /** @type {string[]} */ (names);
  if (new Set(normalized).size !== normalized.length) return null;
  return normalized.sort();
}

/** @param {unknown} value */
function normalizeForbiddenGrants(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  /** @type {ForbiddenGrantRule[]} */
  const rules = [];
  for (const raw of value) {
    if (!isPlainObject(raw) || !hasOnlyFields(raw, ["roles", "privileges"])) return null;
    const roles = normalizeNames(raw.roles);
    const privileges = normalizeNames(raw.privileges)?.map((item) => item.toUpperCase()) ?? null;
    if (!roles || roles.length === 0 || !privileges || privileges.length === 0) return null;
    rules.push({ roles, privileges: [...new Set(privileges)].sort() });
  }
  return rules;
}
/** @param {unknown} value */
function normalizeSelector(value) {
  const text = nonEmptyString(value);
  if (!text) return null;
  const match = /^([A-Za-z_][A-Za-z0-9_$]*)\.([A-Za-z_][A-Za-z0-9_$]*|\*)$/.exec(text);
  return match ? `${match[1]}.${match[2]}` : null;
}

/** @param {unknown} value */
function normalizeTableRules(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  /** @type {TableRule[]} */
  const rules = [];
  const selectors = new Set();
  for (const raw of value) {
    if (!isPlainObject(raw) || !hasOnlyFields(raw, ["selector", "requireRls", "requireForceRls", "forbiddenGrants", "forbidAlwaysTruePolicyRoles"])) return null;
    const selector = normalizeSelector(raw.selector);
    const forbiddenGrants = normalizeForbiddenGrants(raw.forbiddenGrants);
    const policyRoles = raw.forbidAlwaysTruePolicyRoles === undefined ? [] : normalizeNames(raw.forbidAlwaysTruePolicyRoles);
    if (!selector || forbiddenGrants === null || policyRoles === null) return null;
    if (raw.requireRls !== undefined && raw.requireRls !== true) return null;
    if (raw.requireForceRls !== undefined && raw.requireForceRls !== true) return null;
    if (selectors.has(selector)) return null;
    selectors.add(selector);
    const requireRls = raw.requireRls === true;
    const requireForceRls = raw.requireForceRls === true;
    if (!requireRls && !requireForceRls && forbiddenGrants.length === 0 && policyRoles.length === 0) return null;
    rules.push({ selector, requireRls, requireForceRls, forbiddenGrants, forbidAlwaysTruePolicyRoles: policyRoles });
  }
  return rules;
}
/** @param {unknown} value */
function normalizeSchemaRules(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  /** @type {SchemaRule[]} */
  const rules = [];
  const names = new Set();
  for (const raw of value) {
    if (!isPlainObject(raw) || !hasOnlyFields(raw, ["schema", "forbiddenGrants"])) return null;
    const schema = nonEmptyString(raw.schema);
    const forbiddenGrants = normalizeForbiddenGrants(raw.forbiddenGrants);
    if (!schema || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema) || forbiddenGrants === null || forbiddenGrants.length === 0 || names.has(schema)) return null;
    names.add(schema);
    rules.push({ schema, forbiddenGrants });
  }
  return rules;
}

/** @param {unknown} value */
function normalizeSequenceRules(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  /** @type {SequenceRule[]} */
  const rules = [];
  const selectors = new Set();
  for (const raw of value) {
    if (!isPlainObject(raw) || !hasOnlyFields(raw, ["selector", "forbiddenGrants"])) return null;
    const selector = normalizeSelector(raw.selector);
    const forbiddenGrants = normalizeForbiddenGrants(raw.forbiddenGrants);
    if (!selector || forbiddenGrants === null || forbiddenGrants.length === 0 || selectors.has(selector)) return null;
    selectors.add(selector);
    rules.push({ selector, forbiddenGrants });
  }
  return rules;
}
/** @param {unknown} value */
function normalizeSecurityDefiner(value) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value) || !hasOnlyFields(value, ["requireExplicitSearchPath", "forbiddenSearchPathEntries", "forbiddenExecuteRoles"])) return undefined;
  if (value.requireExplicitSearchPath !== undefined && value.requireExplicitSearchPath !== true) return undefined;
  const forbiddenSearchPathEntries = value.forbiddenSearchPathEntries === undefined ? [] : normalizeNames(value.forbiddenSearchPathEntries);
  const forbiddenExecuteRoles = value.forbiddenExecuteRoles === undefined ? [] : normalizeNames(value.forbiddenExecuteRoles);
  if (forbiddenSearchPathEntries === null || forbiddenExecuteRoles === null) return undefined;
  const requireExplicitSearchPath = value.requireExplicitSearchPath === true;
  if (!requireExplicitSearchPath && forbiddenSearchPathEntries.length === 0 && forbiddenExecuteRoles.length === 0) return undefined;
  return { requireExplicitSearchPath, forbiddenSearchPathEntries, forbiddenExecuteRoles };
}

/** @param {unknown} value */
function normalizePolicyIdentity(value) {
  if (!isPlainObject(value) || !hasOnlyFields(value, ["name", "environment"])) return null;
  const name = nonEmptyString(value.name);
  const environment = value.environment === undefined ? null : nonEmptyString(value.environment);
  if (!name || (value.environment !== undefined && !environment)) return null;
  return { name, ...(environment ? { environment } : {}) };
}

/** @param {unknown} value */
export function validatePostgresSecurityPolicy(value) {
  if (!isPlainObject(value) || !hasOnlyFields(value, ["version", "identity", "tableRules", "schemaRules", "sequenceRules", "securityDefiner"]) || value.version !== 1) {
    return { ok: false, policy: null, error: "PostgreSQL security policy must be a version 1 object" };
  }
  const identity = normalizePolicyIdentity(value.identity);
  const tableRules = normalizeTableRules(value.tableRules);
  const schemaRules = normalizeSchemaRules(value.schemaRules);
  const sequenceRules = normalizeSequenceRules(value.sequenceRules);
  const securityDefiner = normalizeSecurityDefiner(value.securityDefiner);
  if (identity === null || tableRules === null || schemaRules === null || sequenceRules === null || securityDefiner === undefined) {
    return { ok: false, policy: null, error: "PostgreSQL security policy contains invalid rules" };
  }
  if (tableRules.length === 0 && schemaRules.length === 0 && sequenceRules.length === 0 && securityDefiner === null) {
    return { ok: false, policy: null, error: "PostgreSQL security policy must contain at least one rule" };
  }
  return { ok: true, policy: /** @type {PostgresSecurityPolicy} */ ({ version: 1, identity, tableRules, schemaRules, sequenceRules, securityDefiner }), error: null };
}
/** @param {string} selector @param {string} schema @param {string} name */
function selectorMatches(selector, schema, name) {
  const [expectedSchema, expectedName] = selector.split(".");
  return expectedSchema === schema && (expectedName === "*" || expectedName === name);
}

/** @param {string} actual @param {string[]} forbidden */
function roleIsForbidden(actual, forbidden) {
  if (actual === "PUBLIC") return forbidden.length > 0;
  return forbidden.includes(actual);
}

/** @param {{ grantee: string, privileges: string[] }[]} grants @param {ForbiddenGrantRule[]} rules @param {string} object @param {SecurityCheck[]} checks */
function evaluateGrants(grants, rules, object, checks) {
  for (const rule of rules) {
    const violations = [];
    for (const grant of grants) {
      if (!roleIsForbidden(grant.grantee, rule.roles)) continue;
      const matched = grant.privileges.filter((privilege) => rule.privileges.includes(privilege));
      if (matched.length > 0) violations.push(`${grant.grantee}:${matched.sort().join("+")}`);
    }
    checks.push({
      id: "forbidden-grants",
      status: violations.length === 0 ? "PASS" : "FAIL",
      object,
      detail: violations.length === 0 ? "forbidden grants are absent" : `forbidden grants present for ${violations.join(", ")}`,
    });
  }
}
/** @param {SecurityEvidence} snapshot @param {PostgresSecurityPolicy} policy */
export function inspectPostgresSecurity(snapshot, policy) {
  /** @type {SecurityCheck[]} */
  const checks = [];
  const identityMatches = snapshot.identity.name === policy.identity.name &&
    (policy.identity.environment === undefined || snapshot.identity.environment === policy.identity.environment);
  checks.push({
    id: "database-identity",
    status: identityMatches ? "PASS" : "FAIL",
    object: "database",
    detail: identityMatches ? "database identity matches explicit policy binding" : "database identity does not match explicit policy binding",
  });
  if (!identityMatches) {
    return {
      identity: snapshot.identity,
      evidence: snapshot.evidence,
      policyIdentity: policy.identity,
      checks,
      summary: { pass: 0, fail: 1 },
      technicalStatus: "PASS",
      overallStatus: "FAIL",
    };
  }
  const tableEntries = [];
  const sequenceEntries = [];
  for (const schema of snapshot.schemas) {
    for (const table of schema.tables) tableEntries.push({ schema: schema.name, table });
    for (const sequence of schema.sequences) sequenceEntries.push({ schema: schema.name, sequence });
  }

  for (const rule of policy.tableRules) {
    const matches = tableEntries.filter((item) => selectorMatches(rule.selector, item.schema, item.table.name));
    if (matches.length === 0) {
      checks.push({ id: "table-selector-empty", status: "FAIL", object: rule.selector, detail: "table selector matched no evidence objects" });
      continue;
    }
    for (const item of matches) {
      const object = `table:${item.schema}.${item.table.name}`;
      if (rule.requireRls) checks.push({ id: "rls-required", status: item.table.rlsEnabled ? "PASS" : "FAIL", object, detail: item.table.rlsEnabled ? "row level security is enabled" : "row level security is not enabled" });
      if (rule.requireForceRls) checks.push({ id: "force-rls-required", status: item.table.rlsForced ? "PASS" : "FAIL", object, detail: item.table.rlsForced ? "forced row level security is enabled" : "forced row level security is not enabled" });
      evaluateGrants(item.table.grants, rule.forbiddenGrants, object, checks);
      if (rule.forbidAlwaysTruePolicyRoles.length > 0) {
        const exposed = item.table.policies.filter((entry) =>
          entry.permissive &&
          entry.roles.some((role) => roleIsForbidden(role, rule.forbidAlwaysTruePolicyRoles)) &&
          (entry.usingAlwaysTrue === true || entry.checkAlwaysTrue === true),
        );
        checks.push({
          id: "always-true-policy",
          status: exposed.length === 0 ? "PASS" : "FAIL",
          object,
          detail: exposed.length === 0 ? "no forbidden permissive always-true policies detected" : `forbidden permissive always-true policies: ${exposed.map((entry) => entry.name).sort().join(", ")}`,
        });
      }
    }
  }

  for (const rule of policy.schemaRules) {
    const schema = snapshot.schemas.find((item) => item.name === rule.schema);
    if (!schema) {
      checks.push({ id: "schema-rule-target-missing", status: "FAIL", object: `schema:${rule.schema}`, detail: "schema policy target is absent from evidence" });
      continue;
    }
    evaluateGrants(schema.grants, rule.forbiddenGrants, `schema:${schema.name}`, checks);
  }
  for (const rule of policy.sequenceRules) {
    const matches = sequenceEntries.filter((item) => selectorMatches(rule.selector, item.schema, item.sequence.name));
    if (matches.length === 0) {
      checks.push({ id: "sequence-selector-empty", status: "FAIL", object: rule.selector, detail: "sequence selector matched no evidence objects" });
      continue;
    }
    for (const item of matches) evaluateGrants(item.sequence.grants, rule.forbiddenGrants, `sequence:${item.schema}.${item.sequence.name}`, checks);
  }

  if (policy.securityDefiner !== null) {
    for (const schema of snapshot.schemas) {
      for (const fn of schema.functions.filter((item) => item.securityDefiner)) {
        const object = `function:${schema.name}.${fn.name}(${fn.identityArguments})`;
        if (policy.securityDefiner.requireExplicitSearchPath) {
          checks.push({ id: "security-definer-search-path-required", status: fn.searchPath === null ? "FAIL" : "PASS", object, detail: fn.searchPath === null ? "security definer function has no explicit search_path" : "security definer function has an explicit search_path" });
        }
        if (policy.securityDefiner.forbiddenSearchPathEntries.length > 0 && fn.searchPath !== null) {
          const forbidden = fn.searchPath.filter((entry) => policy.securityDefiner?.forbiddenSearchPathEntries.includes(entry));
          checks.push({ id: "security-definer-search-path-forbidden", status: forbidden.length === 0 ? "PASS" : "FAIL", object, detail: forbidden.length === 0 ? "search_path contains no forbidden entries" : `search_path contains forbidden entries: ${forbidden.join(", ")}` });
        }
        if (policy.securityDefiner.forbiddenExecuteRoles.length > 0) evaluateGrants(fn.grants, [{ roles: policy.securityDefiner.forbiddenExecuteRoles, privileges: ["EXECUTE"] }], object, checks);
      }
    }
  }
  if (policy.securityDefiner !== null) {
    const definerCount = snapshot.schemas.reduce((total, schema) => total + schema.functions.filter((item) => item.securityDefiner).length, 0);
    if (definerCount === 0) checks.push({ id: "security-definer-scan", status: "PASS", object: "database", detail: "no security definer functions are present in evidence" });
  }

  const pass = checks.filter((check) => check.status === "PASS").length;
  const fail = checks.filter((check) => check.status === "FAIL").length;
  return {
    identity: snapshot.identity,
    evidence: snapshot.evidence,
    policyIdentity: policy.identity,
    checks,
    summary: { pass, fail },
    technicalStatus: "PASS",
    overallStatus: fail > 0 ? "FAIL" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectPostgresSecurity>} report */
export function formatPostgresSecurityAudit(report) {
  const lines = [
    "PostgreSQL security audit",
    "",
    `Database: ${report.identity.name}`,
    `Environment: ${report.identity.environment ?? "(not supplied)"}`,
    `Evidence source: ${report.evidence.source}`,
    `Authenticated: ${report.evidence.authenticated}`,
    "",
  ];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.object}  ${check.detail}`);
  lines.push(
    "",
    `Checks: ${report.summary.pass} pass, ${report.summary.fail} fail`,
    `Technical: ${report.technicalStatus}`,
    `Overall: ${report.overallStatus}`,
  );
  return lines.join("\n");
}

/** @param {string} filename */
function readJson(filename) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(filename, "utf8")), error: null }; }
  catch { return { ok: false, value: null, error: "file cannot be read or parsed" }; }
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let snapshotFile = null;
  let policyFile = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--snapshot-file", "--policy"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--snapshot-file") {
      if (snapshotFile !== null) return null;
      snapshotFile = value;
    } else {
      if (policyFile !== null) return null;
      policyFile = value;
    }
  }
  return snapshotFile && policyFile ? { snapshotFile, policyFile, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/audit-postgres-security.js --snapshot-file <security-snapshot.json> --policy <policy.json> [--json]");
    return 1;
  }
  const snapshotFile = readJson(options.snapshotFile);
  const policyFile = readJson(options.policyFile);
  if (!snapshotFile.ok || !policyFile.ok) {
    console.error("PostgreSQL security audit input file cannot be read or parsed");
    return 1;
  }
  const snapshotValidation = validatePostgresSecuritySnapshot(snapshotFile.value);
  const policyValidation = validatePostgresSecurityPolicy(policyFile.value);
  if (!snapshotValidation.ok || snapshotValidation.snapshot === null || !policyValidation.ok || policyValidation.policy === null) {
    console.error("PostgreSQL security audit input is invalid");
    return 1;
  }
  const report = inspectPostgresSecurity(snapshotValidation.snapshot, policyValidation.policy);
  console.log(options.json ? JSON.stringify(report) : formatPostgresSecurityAudit(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
