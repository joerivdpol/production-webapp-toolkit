#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inspectOrganizationPolicy, validateOrganizationPolicy } from "./organization-policy.js";
import { BUILTIN_POLICY_PACKS, inspectManifestPolicyPack } from "./policy-packs.js";
import { validateRepositoryManifest } from "./repository-manifest.js";

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const REQUIREMENTS = new Set(["required", "advisory"]);
const IMPACTS = new Set(["WARN", "FAIL"]);
const IMPACT_FIELDS = ["warn", "fail", "unverified", "missing"];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}

/** @param {unknown} value */
function id(value) {
  const normalized = text(value, 128);
  return normalized && ID_PATTERN.test(normalized) ? normalized : null;
}

/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateSeverityPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "severity policy must be an object" }] };
  rejectUnknown(value, ["version", "rules"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  /** @type {Array<{check:string,requirement:"required"|"advisory",impacts:Record<string,"WARN"|"FAIL">}>} */
  const rules = [];
  if (!Array.isArray(value.rules) || value.rules.length > 1024) {
    errors.push({ id: "rules-invalid", detail: "rules must be a bounded array" });
  } else {
    const seen = new Set();
    for (const [index, raw] of value.rules.entries()) {
      if (!object(raw)) { errors.push({ id: "rule-invalid", detail: `rules[${index}] must be an object` }); continue; }
      rejectUnknown(raw, ["check", "requirement", "impacts"], "rule", errors);
      const check = id(raw.check), requirement = text(raw.requirement, 16);
      if (!check || !requirement || !REQUIREMENTS.has(requirement) || seen.has(check)) {
        errors.push({ id: "rule-fields-invalid", detail: `rules[${index}] has invalid or duplicate check/requirement` });
        continue;
      }
      seen.add(check);
      if (!object(raw.impacts)) { errors.push({ id: "rule-impacts-invalid", detail: `rules[${index}].impacts must be an object` }); continue; }
      rejectUnknown(raw.impacts, IMPACT_FIELDS, "rule-impacts", errors);
      /** @type {Record<string,"WARN"|"FAIL">} */
      const impacts = {};
      let impactInvalid = false;
      for (const field of IMPACT_FIELDS) {
        if (raw.impacts[field] === undefined) continue;
        const impact = text(raw.impacts[field], 8);
        if (!impact || !IMPACTS.has(impact)) { impactInvalid = true; errors.push({ id: "rule-impact-invalid", detail: `rules[${index}].impacts.${field} must be WARN or FAIL` }); }
        else impacts[field] = /** @type {"WARN"|"FAIL"} */ (impact);
      }
      if (!impactInvalid) rules.push({ check, requirement: /** @type {"required"|"advisory"} */ (requirement), impacts });
    }
  }
  if (errors.length > 0) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, rules: rules.sort((a, b) => a.check.localeCompare(b.check)) }, errors: [] };
}

/** @param {"required"|"advisory"} requirement */
function defaultImpacts(requirement) {
  return {
    WARN: /** @type {"WARN"|"FAIL"} */ ("WARN"),
    FAIL: /** @type {"WARN"|"FAIL"} */ (requirement === "required" ? "FAIL" : "WARN"),
    UNVERIFIED: /** @type {"WARN"|"FAIL"} */ ("WARN"),
    MISSING: /** @type {"WARN"|"FAIL"} */ ("WARN"),
  };
}

/** @param {"WARN"|"FAIL"} value */
function impactRank(value) { return value === "FAIL" ? 1 : 0; }

/** @param {any} effective @param {any} policy */
export function resolveSeverityPolicy(effective, policy) {
  /** @type {Map<string,{id:string,requirement:"required"|"advisory",impacts:Record<string,"WARN"|"FAIL">}>} */
  const checks = new Map();
  for (const check of effective.required) checks.set(check, { id: check, requirement: "required", impacts: defaultImpacts("required") });
  for (const check of effective.advisory) if (!checks.has(check)) checks.set(check, { id: check, requirement: "advisory", impacts: defaultImpacts("advisory") });

  /** @type {Array<{id:string,status:"PASS"|"FAIL",check:string,detail:string}>} */
  const validations = [];
  for (const rule of policy.rules) {
    const existing = checks.get(rule.check) ?? null;
    let requirement = existing?.requirement ?? rule.requirement;
    if (existing?.requirement === "required" && rule.requirement === "advisory") {
      validations.push({ id: "requirement-weakening", status: "FAIL", check: rule.check, detail: "required check cannot be downgraded to advisory" });
      requirement = "required";
    } else {
      if (existing?.requirement === "advisory" && rule.requirement === "required") requirement = "required";
      validations.push({ id: "requirement-monotone", status: "PASS", check: rule.check, detail: existing ? "requirement is preserved or strengthened" : "severity policy explicitly adds check requirement" });
    }

    const baseline = defaultImpacts(requirement);
    const impacts = { ...(existing ? defaultImpacts(requirement) : baseline) };
    const mappings = /** @type {Array<[string,"WARN"|"FAIL"|"UNVERIFIED"|"MISSING"]>} */ ([
      ["warn", "WARN"], ["fail", "FAIL"], ["unverified", "UNVERIFIED"], ["missing", "MISSING"],
    ]);
    for (const [field, status] of mappings) {
      const desired = rule.impacts[field];
      if (!desired) continue;
      const minimum = baseline[status];
      if (impactRank(desired) < impactRank(minimum)) {
        validations.push({ id: "severity-weakening", status: "FAIL", check: rule.check, detail: `${status} impact cannot be weakened below ${minimum}` });
      } else {
        impacts[status] = desired;
        validations.push({ id: "severity-monotone", status: "PASS", check: rule.check, detail: `${status} impact is preserved or strengthened` });
      }
    }
    checks.set(rule.check, { id: rule.check, requirement, impacts });
  }

  const resolved = [...checks.values()].sort((a, b) => a.id.localeCompare(b.id));
  const fail = validations.filter((item) => item.status === "FAIL").length;
  return {
    effective: {
      required: resolved.filter((item) => item.requirement === "required").map((item) => item.id),
      advisory: resolved.filter((item) => item.requirement === "advisory").map((item) => item.id),
      checks: resolved,
    },
    validations,
    summary: { pass: validations.length - fail, fail },
    overallStatus: fail > 0 ? "FAIL" : "PASS",
  };
}

/** @param {ReturnType<typeof resolveSeverityPolicy>} report */
export function formatSeverityPolicy(report) {
  const lines = ["Severity policy resolution", "", `Required checks: ${report.effective.required.join(", ") || "(none)"}`, `Advisory checks: ${report.effective.advisory.join(", ") || "(none)"}`, ""];
  for (const check of report.effective.checks) lines.push(`${check.requirement.toUpperCase().padEnd(8)}  ${check.id}  WARN=${check.impacts.WARN} FAIL=${check.impacts.FAIL} UNVERIFIED=${check.impacts.UNVERIFIED} MISSING=${check.impacts.MISSING}`);
  lines.push("");
  for (const validation of report.validations) lines.push(`${validation.status.padEnd(4)}  ${validation.id}  ${validation.check}  ${validation.detail}`);
  lines.push("", `Policy checks: ${report.summary.pass} pass, ${report.summary.fail} fail`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) {
  let manifestFile = null, severityPolicyFile = null, organizationPolicyFile = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--manifest-file", "--severity-policy-file", "--organization-policy-file"].includes(argument ?? "")) return null;
    const value = argv[index + 1]; if (typeof value !== "string" || value.startsWith("--")) return null; index += 1;
    if (argument === "--manifest-file") { if (manifestFile) return null; manifestFile = value; }
    else if (argument === "--severity-policy-file") { if (severityPolicyFile) return null; severityPolicyFile = value; }
    else { if (organizationPolicyFile) return null; organizationPolicyFile = value; }
  }
  return manifestFile && severityPolicyFile ? { manifestFile, severityPolicyFile, organizationPolicyFile, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/severity-policy.js --manifest-file <manifest.json> --severity-policy-file <severity.json> [--organization-policy-file <organization.json>] [--json]"); return 1; }
  const rawManifest = readJson(options.manifestFile), rawSeverity = readJson(options.severityPolicyFile), rawOrganization = options.organizationPolicyFile ? readJson(options.organizationPolicyFile) : null;
  if (!rawManifest || !rawSeverity || (options.organizationPolicyFile && !rawOrganization)) { console.error("Severity policy input cannot be read or parsed"); return 1; }
  const manifest = validateRepositoryManifest(rawManifest), severity = validateSeverityPolicy(rawSeverity);
  if (!manifest.valid || !manifest.manifest || !severity.valid || !severity.policy) { console.error("Severity policy input is invalid"); return 1; }
  let base;
  if (rawOrganization) {
    const organization = validateOrganizationPolicy(rawOrganization);
    if (!organization.valid || !organization.policy) { console.error("Severity policy organization input is invalid"); return 1; }
    base = inspectOrganizationPolicy(manifest.manifest, organization.policy, BUILTIN_POLICY_PACKS);
  } else base = inspectManifestPolicyPack(manifest.manifest, BUILTIN_POLICY_PACKS);
  if (!base.effective || base.overallStatus === "FAIL") { console.error("Base policy cannot be resolved"); return 1; }
  const report = resolveSeverityPolicy(base.effective, severity.policy);
  console.log(options.json ? JSON.stringify(report) : formatSeverityPolicy(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
