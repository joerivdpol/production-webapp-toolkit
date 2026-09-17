#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { BUILTIN_POLICY_PACKS, inspectManifestPolicyPack } from "./policy-packs.js";
import { validateRepositoryManifest } from "./repository-manifest.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

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
function rejectUnknown(value, allowed, scope, errors) {
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
    errors.push({ id: `${field}-id-invalid`, detail: `${field} contains an invalid portable identifier` });
    return null;
  }
  const result = /** @type {string[]} */ (normalized);
  if (new Set(result).size !== result.length) {
    errors.push({ id: `${field}-duplicate`, detail: `${field} contains duplicate identifiers` });
    return null;
  }
  return result.sort();
}

/** @param {unknown} value @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function policyLayer(value, scope, errors) {
  if (!object(value)) {
    errors.push({ id: `${scope}-invalid`, detail: `${scope} must be an object` });
    return null;
  }
  rejectUnknown(value, ["requirements", "checks"], scope, errors);

  let requirements = null;
  if (!object(value.requirements)) errors.push({ id: `${scope}-requirements-invalid`, detail: `${scope}.requirements must be an object` });
  else {
    rejectUnknown(value.requirements, ["runtime", "database", "capabilities"], `${scope}-requirements`, errors);
    const capabilities = ids(value.requirements.capabilities, `${scope}-capabilities`, errors);
    if (typeof value.requirements.runtime !== "boolean" || typeof value.requirements.database !== "boolean" || !capabilities) {
      errors.push({ id: `${scope}-requirements-fields-invalid`, detail: `${scope}.requirements needs runtime/database booleans and capabilities` });
    } else requirements = { runtime: value.requirements.runtime, database: value.requirements.database, capabilities };
  }

  let checks = null;
  if (!object(value.checks)) errors.push({ id: `${scope}-checks-invalid`, detail: `${scope}.checks must be an object` });
  else {
    rejectUnknown(value.checks, ["required", "advisory"], `${scope}-checks`, errors);
    const required = ids(value.checks.required, `${scope}-required`, errors);
    const advisory = ids(value.checks.advisory, `${scope}-advisory`, errors);
    if (required && advisory) {
      const overlap = required.filter((check) => advisory.includes(check));
      if (overlap.length > 0) errors.push({ id: `${scope}-check-overlap`, detail: `${scope} checks overlap: ${overlap.join(", ")}` });
      else checks = { required, advisory };
    }
  }
  return requirements && checks ? { requirements, checks } : null;
}

/** @param {unknown} value */
export function validateOrganizationPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "organization policy must be an object" }] };
  rejectUnknown(value, ["version", "organization", "global", "profiles", "repositories"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let organization = null;
  if (!object(value.organization)) errors.push({ id: "organization-invalid", detail: "organization must be an object" });
  else {
    rejectUnknown(value.organization, ["id"], "organization", errors);
    const id = portableId(value.organization.id);
    if (!id) errors.push({ id: "organization-id-invalid", detail: "organization.id must be a portable identifier" });
    else organization = { id };
  }

  const global = policyLayer(value.global, "global", errors);

  /** @type {Array<any>} */
  const profiles = [];
  if (!Array.isArray(value.profiles) || value.profiles.length > 128) errors.push({ id: "profiles-invalid", detail: "profiles must be a bounded array" });
  else {
    const seen = new Set();
    for (const [index, raw] of value.profiles.entries()) {
      if (!object(raw)) { errors.push({ id: "profile-policy-invalid", detail: `profiles[${index}] must be an object` }); continue; }
      rejectUnknown(raw, ["profile", "policy"], "profile-policy", errors);
      const profile = portableId(raw.profile);
      const layer = policyLayer(raw.policy, `profiles[${index}].policy`, errors);
      if (!profile || seen.has(profile)) errors.push({ id: "profile-policy-id-invalid", detail: `profiles[${index}].profile is invalid or duplicate` });
      else seen.add(profile);
      if (profile && layer) profiles.push({ profile, policy: layer });
    }
  }

  /** @type {Array<any>} */
  const repositories = [];
  if (!Array.isArray(value.repositories) || value.repositories.length > 512) errors.push({ id: "repositories-invalid", detail: "repositories must be a bounded array" });
  else {
    const seen = new Set();
    for (const [index, raw] of value.repositories.entries()) {
      if (!object(raw)) { errors.push({ id: "repository-policy-invalid", detail: `repositories[${index}] must be an object` }); continue; }
      rejectUnknown(raw, ["repository", "policy"], "repository-policy", errors);
      const repository = portableId(raw.repository);
      const layer = policyLayer(raw.policy, `repositories[${index}].policy`, errors);
      if (!repository || seen.has(repository)) errors.push({ id: "repository-policy-id-invalid", detail: `repositories[${index}].repository is invalid or duplicate` });
      else seen.add(repository);
      if (repository && layer) repositories.push({ repository, policy: layer });
    }
  }

  if (errors.length > 0 || !organization || !global) return { valid: false, policy: null, errors };
  return {
    valid: true,
    policy: {
      version: 1,
      organization,
      global,
      profiles: profiles.sort((a, b) => a.profile.localeCompare(b.profile)),
      repositories: repositories.sort((a, b) => a.repository.localeCompare(b.repository)),
    },
    errors: [],
  };
}

/** @param {any} manifest @param {any} organizationPolicy @param {any} [registry] */
export function inspectOrganizationPolicy(manifest, organizationPolicy, registry = BUILTIN_POLICY_PACKS) {
  const base = inspectManifestPolicyPack(manifest, registry);
  /** @type {Array<{id:string,status:"PASS"|"FAIL",layer:string,detail:string}>} */
  const checks = base.checks.map((item) => ({ id: `base-${item.id}`, status: item.status, layer: "public-pack", detail: item.detail }));
  if (!base.effective || !base.requirements) {
    const fail = checks.filter((item) => item.status === "FAIL").length || 1;
    return { organization: organizationPolicy.organization.id, repository: manifest.repository.id, profile: manifest.profile, layers: ["public-pack"], effective: null, requirements: null, checks, summary: { pass: checks.length - fail, fail }, overallStatus: "FAIL" };
  }

  const selected = [
    { name: "organization-global", policy: organizationPolicy.global },
    ...organizationPolicy.profiles.filter((/** @type {any} */ entry) => entry.profile === manifest.profile).map((/** @type {any} */ entry) => ({ name: `organization-profile:${entry.profile}`, policy: entry.policy })),
    ...organizationPolicy.repositories.filter((/** @type {any} */ entry) => entry.repository === manifest.repository.id).map((/** @type {any} */ entry) => ({ name: `organization-repository:${entry.repository}`, policy: entry.policy })),
  ];

  /** @type {Set<string>} */ const required = new Set(base.effective.required);
  /** @type {Set<string>} */ const advisory = new Set(base.effective.advisory);
  /** @type {Set<string>} */ const requiredCapabilities = new Set(base.requirements.capabilities);
  let requiresRuntime = base.requirements.runtime;
  let requiresDatabase = base.requirements.database;

  const organizationRequired = new Set();
  for (const layer of selected) for (const check of layer.policy.checks.required) organizationRequired.add(check);
  const manifestDowngrades = manifest.checks.advisory.filter((/** @type {string} */ check) => organizationRequired.has(check)).sort();
  checks.push({
    id: "manifest-organization-monotonicity",
    status: manifestDowngrades.length === 0 ? "PASS" : "FAIL",
    layer: "organization",
    detail: manifestDowngrades.length === 0 ? "manifest does not downgrade organization-required checks" : `manifest marks organization-required checks advisory: ${manifestDowngrades.join(", ")}`,
  });

  for (const layer of selected) {
    const downgrade = layer.policy.checks.advisory.filter((/** @type {string} */ check) => required.has(check)).sort();
    checks.push({
      id: "organization-layer-monotonicity",
      status: downgrade.length === 0 ? "PASS" : "FAIL",
      layer: layer.name,
      detail: downgrade.length === 0 ? "layer does not downgrade inherited required checks" : `layer marks inherited required checks advisory: ${downgrade.join(", ")}`,
    });
    requiresRuntime ||= layer.policy.requirements.runtime;
    requiresDatabase ||= layer.policy.requirements.database;
    for (const capability of layer.policy.requirements.capabilities) requiredCapabilities.add(capability);
    for (const check of layer.policy.checks.required) { required.add(check); advisory.delete(check); }
    for (const check of layer.policy.checks.advisory) if (!required.has(check)) advisory.add(check);
  }

  checks.push({ id: "organization-runtime-requirement", status: !requiresRuntime || manifest.runtime !== null ? "PASS" : "FAIL", layer: "effective", detail: requiresRuntime ? "effective organization policy requires an explicit runtime" : "effective organization policy does not require a runtime" });
  checks.push({ id: "organization-database-requirement", status: !requiresDatabase || manifest.database !== null ? "PASS" : "FAIL", layer: "effective", detail: requiresDatabase ? "effective organization policy requires an explicit database" : "effective organization policy does not require a database" });
  const missingCapabilities = [...requiredCapabilities].filter((capability) => !manifest.capabilities.includes(capability)).sort();
  checks.push({ id: "organization-capability-requirements", status: missingCapabilities.length === 0 ? "PASS" : "FAIL", layer: "effective", detail: missingCapabilities.length === 0 ? "all effective organization capabilities are explicitly declared" : `missing effective capabilities: ${missingCapabilities.join(", ")}` });

  const fail = checks.filter((item) => item.status === "FAIL").length;
  return {
    organization: organizationPolicy.organization.id,
    repository: manifest.repository.id,
    profile: manifest.profile,
    layers: ["public-pack", ...selected.map((layer) => layer.name)],
    effective: { required: [...required].sort(), advisory: [...advisory].sort() },
    requirements: { runtime: requiresRuntime, database: requiresDatabase, capabilities: [...requiredCapabilities].sort() },
    checks,
    summary: { pass: checks.length - fail, fail },
    overallStatus: fail > 0 ? "FAIL" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectOrganizationPolicy>} report */
export function formatOrganizationPolicy(report) {
  const lines = ["Organization policy inheritance", "", `Organization: ${report.organization}`, `Repository: ${report.repository}`, `Profile: ${report.profile}`, `Layers: ${report.layers.join(" -> ")}`];
  if (report.effective) lines.push(`Required checks: ${report.effective.required.join(", ")}`, `Advisory checks: ${report.effective.advisory.join(", ") || "(none)"}`);
  lines.push("");
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.layer}  ${check.id}  ${check.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.fail} fail`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv */
function parse(argv) {
  let manifestFile = null, organizationPolicyFile = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--manifest-file", "--organization-policy-file"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--manifest-file") { if (manifestFile) return null; manifestFile = value; }
    else { if (organizationPolicyFile) return null; organizationPolicyFile = value; }
  }
  return manifestFile && organizationPolicyFile ? { manifestFile, organizationPolicyFile, json } : null;
}

/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/organization-policy.js --manifest-file <manifest.json> --organization-policy-file <organization-policy.json> [--json]"); return 1; }
  const rawManifest = readJson(options.manifestFile), rawPolicy = readJson(options.organizationPolicyFile);
  if (!rawManifest || !rawPolicy) { console.error("Organization policy input cannot be read or parsed"); return 1; }
  const manifest = validateRepositoryManifest(rawManifest), policy = validateOrganizationPolicy(rawPolicy);
  if (!manifest.valid || !manifest.manifest || !policy.valid || !policy.policy) { console.error("Organization policy input is invalid"); return 1; }
  const report = inspectOrganizationPolicy(manifest.manifest, policy.policy);
  console.log(options.json ? JSON.stringify(report) : formatOrganizationPolicy(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
