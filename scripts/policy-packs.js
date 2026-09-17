#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateRepositoryManifest } from "./repository-manifest.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export const BUILTIN_POLICY_PACK_REGISTRY = {
  version: 1,
  packs: [
    {
      id: "service",
      extends: null,
      requires: { runtime: true, database: false, capabilities: [] },
      checks: {
        required: ["ci-evidence", "dependency-drift", "git-governance", "public-safety", "repository-quality"],
        advisory: ["deployment-evidence", "runtime-health", "vulnerabilities"],
      },
    },
    {
      id: "webapp",
      extends: "service",
      requires: { runtime: true, database: false, capabilities: [] },
      checks: { required: [], advisory: ["accessibility", "authorization", "performance", "route-coverage", "seo"] },
    },
    {
      id: "python-service",
      extends: "service",
      requires: { runtime: true, database: false, capabilities: [] },
      checks: { required: [], advisory: [] },
    },
    {
      id: "database-service",
      extends: "service",
      requires: { runtime: true, database: true, capabilities: [] },
      checks: {
        required: ["database-security", "environment-contract", "migration-safety", "schema-drift"],
        advisory: ["backup-readiness", "disaster-recovery", "rollback-readiness"],
      },
    },
    {
      id: "database-backed-webapp",
      extends: "webapp",
      requires: { runtime: true, database: true, capabilities: [] },
      checks: {
        required: ["database-security", "environment-contract", "migration-safety", "schema-drift"],
        advisory: ["backup-readiness", "disaster-recovery", "rollback-readiness"],
      },
    },
    {
      id: "payment-service",
      extends: "database-service",
      requires: { runtime: true, database: true, capabilities: ["payments"] },
      checks: {
        required: ["artifact-provenance", "payment-integrity", "rollback-readiness", "vulnerabilities", "webhook-safety"],
        advisory: ["backup-readiness", "disaster-recovery"],
      },
    },
    {
      id: "booking-service",
      extends: "database-service",
      requires: { runtime: true, database: true, capabilities: ["bookings"] },
      checks: {
        required: ["artifact-provenance", "booking-integrity", "rollback-readiness"],
        advisory: ["backup-readiness", "disaster-recovery"],
      },
    },
    {
      id: "worker",
      extends: "service",
      requires: { runtime: true, database: false, capabilities: [] },
      checks: { required: [], advisory: ["job-scheduler", "runtime-health"] },
    },
    {
      id: "bot",
      extends: "service",
      requires: { runtime: true, database: false, capabilities: [] },
      checks: { required: [], advisory: ["job-scheduler", "runtime-health"] },
    },
  ],
};

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function portableId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return ID_PATTERN.test(normalized) ? normalized : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value @param {string} field @param {Array<{id:string,detail:string}>} errors */
function ids(value, field, errors) {
  if (!Array.isArray(value) || value.length > 256) {
    errors.push({ id: `${field}-invalid`, detail: `${field} must be a bounded array` });
    return null;
  }
  const normalized = value.map(portableId);
  if (normalized.some((item) => item === null)) {
    errors.push({ id: `${field}-id-invalid`, detail: `${field} contains an invalid identifier` });
    return null;
  }
  const result = /** @type {string[]} */ (normalized);
  if (new Set(result).size !== result.length) {
    errors.push({ id: `${field}-duplicate`, detail: `${field} contains duplicate identifiers` });
    return null;
  }
  return result.sort();
}

/** @param {unknown} value */
export function validatePolicyPackRegistry(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!object(value)) return { valid: false, registry: null, errors: [{ id: "registry-invalid", detail: "policy pack registry must be an object" }] };
  unknown(value, ["version", "packs"], "registry", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (!Array.isArray(value.packs) || value.packs.length === 0 || value.packs.length > 128) {
    errors.push({ id: "packs-invalid", detail: "packs must be a non-empty bounded array" });
    return { valid: false, registry: null, errors };
  }

  /** @type {Array<any>} */
  const packs = [];
  const seen = new Set();
  for (const [index, raw] of value.packs.entries()) {
    if (!object(raw)) { errors.push({ id: "pack-invalid", detail: `packs[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "extends", "requires", "checks"], "pack", errors);
    const id = portableId(raw.id);
    const parent = raw.extends === null ? null : portableId(raw.extends);
    if (!id || seen.has(id)) errors.push({ id: "pack-id-invalid", detail: `packs[${index}].id is invalid or duplicate` });
    else seen.add(id);
    if (raw.extends !== null && !parent) errors.push({ id: "pack-extends-invalid", detail: `packs[${index}].extends must be null or a portable id` });

    let requires = null;
    if (!object(raw.requires)) errors.push({ id: "pack-requires-invalid", detail: `packs[${index}].requires must be an object` });
    else {
      unknown(raw.requires, ["runtime", "database", "capabilities"], "pack-requires", errors);
      const capabilities = ids(raw.requires.capabilities, "pack-capabilities", errors);
      if (typeof raw.requires.runtime !== "boolean" || typeof raw.requires.database !== "boolean" || !capabilities) {
        errors.push({ id: "pack-requires-fields-invalid", detail: `packs[${index}].requires needs runtime/database booleans and capabilities` });
      } else requires = { runtime: raw.requires.runtime, database: raw.requires.database, capabilities };
    }

    let checks = null;
    if (!object(raw.checks)) errors.push({ id: "pack-checks-invalid", detail: `packs[${index}].checks must be an object` });
    else {
      unknown(raw.checks, ["required", "advisory"], "pack-checks", errors);
      const required = ids(raw.checks.required, "pack-required-checks", errors);
      const advisory = ids(raw.checks.advisory, "pack-advisory-checks", errors);
      if (required && advisory) {
        const overlap = required.filter((check) => advisory.includes(check));
        if (overlap.length > 0) errors.push({ id: "pack-check-overlap", detail: `pack checks overlap: ${overlap.join(", ")}` });
        else checks = { required, advisory };
      }
    }
    if (id && requires && checks && (raw.extends === null || parent)) packs.push({ id, extends: parent, requires, checks });
  }

  if (errors.length > 0) return { valid: false, registry: null, errors };
  const byId = new Map(packs.map((pack) => [pack.id, pack]));
  for (const pack of packs) {
    if (pack.extends && !byId.has(pack.extends)) errors.push({ id: "pack-parent-missing", detail: `${pack.id} extends unknown pack ${pack.extends}` });
    const visited = new Set([pack.id]);
    let current = pack;
    while (current.extends) {
      if (visited.has(current.extends)) { errors.push({ id: "pack-inheritance-cycle", detail: `policy pack inheritance cycle includes ${pack.id}` }); break; }
      visited.add(current.extends);
      const parent = byId.get(current.extends);
      if (!parent) break;
      current = parent;
    }
  }
  if (errors.length > 0) return { valid: false, registry: null, errors };
  return { valid: true, registry: { version: 1, packs: packs.sort((a, b) => a.id.localeCompare(b.id)) }, errors: [] };
}

/** @param {any} registry @param {string} packId */
function lineage(registry, packId) {
  const byId = new Map(/** @type {any[]} */ (registry.packs).map((/** @type {any} */ pack) => [pack.id, pack]));
  /** @type {any[]} */
  const result = [];
  let current = byId.get(packId) ?? null;
  while (current) { result.unshift(current); current = current.extends ? byId.get(current.extends) ?? null : null; }
  return result;
}

/** @param {any} manifest @param {any} registry */
export function inspectManifestPolicyPack(manifest, registry) {
  const packs = lineage(registry, manifest.profile);
  /** @type {Array<{id:string,status:"PASS"|"FAIL",detail:string}>} */
  const checks = [];
  /** @param {string} id @param {boolean} passed @param {string} detail */
  const add = (id, passed, detail) => checks.push({ id, status: passed ? "PASS" : "FAIL", detail });
  if (packs.length === 0) {
    add("policy-pack-known", false, `profile ${manifest.profile} does not resolve to a registered policy pack`);
    return { repository: manifest.repository.id, profile: manifest.profile, lineage: [], effective: null, checks, summary: { pass: 0, fail: 1 }, overallStatus: "FAIL" };
  }
  add("policy-pack-known", true, `profile ${manifest.profile} resolves to a policy pack`);

  /** @type {Set<string>} */ const packRequired = new Set();
  /** @type {Set<string>} */ const packAdvisory = new Set();
  /** @type {Set<string>} */ const requiredCapabilities = new Set();
  let requiresRuntime = false, requiresDatabase = false;
  for (const pack of packs) {
    requiresRuntime ||= pack.requires.runtime;
    requiresDatabase ||= pack.requires.database;
    for (const capability of pack.requires.capabilities) requiredCapabilities.add(capability);
    for (const check of pack.checks.required) { packRequired.add(check); packAdvisory.delete(check); }
    for (const check of pack.checks.advisory) if (!packRequired.has(check)) packAdvisory.add(check);
  }

  add("runtime-requirement", !requiresRuntime || manifest.runtime !== null, requiresRuntime ? "selected policy pack requires an explicit runtime" : "selected policy pack does not require a runtime");
  add("database-requirement", !requiresDatabase || manifest.database !== null, requiresDatabase ? "selected policy pack requires an explicit database" : "selected policy pack does not require a database");
  const missingCapabilities = [...requiredCapabilities].filter((capability) => !manifest.capabilities.includes(capability)).sort();
  add("capability-requirements", missingCapabilities.length === 0, missingCapabilities.length === 0 ? "all policy-pack capabilities are explicitly declared" : `missing required capabilities: ${missingCapabilities.join(", ")}`);

  const downgradeAttempts = manifest.checks.advisory.filter((/** @type {string} */ check) => packRequired.has(check)).sort();
  add("required-check-monotonicity", downgradeAttempts.length === 0, downgradeAttempts.length === 0 ? "manifest does not downgrade policy-pack required checks" : `manifest marks policy-pack required checks advisory: ${downgradeAttempts.join(", ")}`);

  const effectiveRequired = new Set([...packRequired, ...manifest.checks.required]);
  const effectiveAdvisory = new Set([...packAdvisory, ...manifest.checks.advisory]);
  for (const check of effectiveRequired) effectiveAdvisory.delete(check);
  const fail = checks.filter((item) => item.status === "FAIL").length;
  return {
    repository: manifest.repository.id,
    profile: manifest.profile,
    lineage: packs.map((pack) => pack.id),
    requirements: { runtime: requiresRuntime, database: requiresDatabase, capabilities: [...requiredCapabilities].sort() },
    effective: { required: [...effectiveRequired].sort(), advisory: [...effectiveAdvisory].sort() },
    checks,
    summary: { pass: checks.length - fail, fail },
    overallStatus: fail > 0 ? "FAIL" : "PASS",
  };
}

const builtinValidation = validatePolicyPackRegistry(BUILTIN_POLICY_PACK_REGISTRY);
if (!builtinValidation.valid || !builtinValidation.registry) throw new Error("built-in policy pack registry is invalid");
export const BUILTIN_POLICY_PACKS = builtinValidation.registry;

/** @param {ReturnType<typeof inspectManifestPolicyPack>} report */
export function formatManifestPolicyPack(report) {
  const lines = ["Policy pack resolution", "", `Repository: ${report.repository}`, `Profile: ${report.profile}`, `Lineage: ${report.lineage.join(" -> ") || "(unresolved)"}`];
  if (report.effective) lines.push(`Required checks: ${report.effective.required.join(", ")}`, `Advisory checks: ${report.effective.advisory.join(", ") || "(none)"}`);
  lines.push("");
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.fail} fail`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv */
function parse(argv) {
  let manifestFile = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--manifest-file" || manifestFile !== null) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    manifestFile = value; index += 1;
  }
  return manifestFile ? { manifestFile, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/policy-packs.js --manifest-file <manifest.json> [--json]"); return 1; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(options.manifestFile, "utf8")); }
  catch { console.error("Repository manifest cannot be read or parsed"); return 1; }
  const manifest = validateRepositoryManifest(raw);
  if (!manifest.valid || !manifest.manifest) { console.error("Repository manifest is invalid"); return 1; }
  const report = inspectManifestPolicyPack(manifest.manifest, BUILTIN_POLICY_PACKS);
  console.log(options.json ? JSON.stringify(report) : formatManifestPolicyPack(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
