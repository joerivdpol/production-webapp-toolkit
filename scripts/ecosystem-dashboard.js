#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inspectOrganizationPolicy, validateOrganizationPolicy } from "./organization-policy.js";
import { BUILTIN_POLICY_PACKS, inspectManifestPolicyPack } from "./policy-packs.js";
import { validateRepositoryCheckEvidence } from "./repository-check-evidence.js";
import { validateRepositoryManifest } from "./repository-manifest.js";
import { resolveSeverityPolicy, validateSeverityPolicy } from "./severity-policy.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const MAX_JSON_BYTES = 4 * 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value @param {number} [max] */
function text(value, max = 1024) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateEcosystemDashboardConfig(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!object(value)) return { valid: false, config: null, errors: [{ id: "config-invalid", detail: "ecosystem dashboard config must be an object" }] };
  unknown(value, ["version", "generatedAt", "repositories"], "config", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const generatedAt = text(value.generatedAt, 128);
  if (!generatedAt || !isAbsoluteIsoTimestamp(generatedAt)) errors.push({ id: "generated-at-invalid", detail: "generatedAt must be an absolute ISO timestamp" });

  /** @type {Array<{manifestFile:string,evidenceFile:string,organizationPolicyFile?:string,severityPolicyFile?:string}>} */
  const repositories = [];
  if (!Array.isArray(value.repositories) || value.repositories.length === 0 || value.repositories.length > 512) {
    errors.push({ id: "repositories-invalid", detail: "repositories must be a non-empty bounded array" });
  } else {
    for (const [index, raw] of value.repositories.entries()) {
      if (!object(raw)) { errors.push({ id: "repository-entry-invalid", detail: `repositories[${index}] must be an object` }); continue; }
      unknown(raw, ["manifestFile", "evidenceFile", "organizationPolicyFile", "severityPolicyFile"], "repository-entry", errors);
      const manifestFile = text(raw.manifestFile), evidenceFile = text(raw.evidenceFile);
      const organizationPolicyFile = raw.organizationPolicyFile === undefined ? null : text(raw.organizationPolicyFile);
      const severityPolicyFile = raw.severityPolicyFile === undefined ? null : text(raw.severityPolicyFile);
      if (!manifestFile || !evidenceFile || (raw.organizationPolicyFile !== undefined && !organizationPolicyFile) || (raw.severityPolicyFile !== undefined && !severityPolicyFile)) {
        errors.push({ id: "repository-entry-fields-invalid", detail: `repositories[${index}] requires manifestFile, evidenceFile, and optional organizationPolicyFile/severityPolicyFile` });
        continue;
      }
      repositories.push({ manifestFile, evidenceFile, ...(organizationPolicyFile ? { organizationPolicyFile } : {}), ...(severityPolicyFile ? { severityPolicyFile } : {}) });
    }
  }
  if (errors.length > 0 || !generatedAt) return { valid: false, config: null, errors };
  return { valid: true, config: { version: 1, generatedAt, repositories }, errors: [] };
}

/** @param {string} filename */
function readJsonBounded(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_JSON_BYTES) return null;
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); } catch { return null; }
}

/** @param {string} baseDir @param {string} filename */
function resolveInput(baseDir, filename) {
  return path.isAbsolute(filename) ? path.resolve(filename) : path.resolve(baseDir, filename);
}

/** @param {Array<{id:string,requirement:"required"|"advisory",impacts:Record<string,"WARN"|"FAIL">}>} policies @param {Map<string,string>} observed */
function evaluateChecks(policies, observed) {
  return policies.map((policy) => {
    const status = observed.get(policy.id) ?? "MISSING";
    const impact = status === "PASS" ? "PASS" : policy.impacts[status] ?? "WARN";
    return { id: policy.id, requirement: policy.requirement, status, impact };
  });
}

/** @param {number} index @param {string} detail */
function technicalFailure(index, detail) {
  return {
    entry: index,
    repository: null,
    profile: null,
    policySource: null,
    evidence: null,
    policyStatus: "UNAVAILABLE",
    checks: [],
    unscopedChecks: [],
    required: { total: 0, pass: 0, warn: 0, fail: 0, unverified: 0, missing: 0 },
    advisory: { total: 0, pass: 0, warn: 0, fail: 0, unverified: 0, missing: 0 },
    technicalStatus: "FAIL",
    overallStatus: "FAIL",
    technicalDetail: detail,
  };
}

/** @param {Array<{id:string,requirement:string,status:string,impact:string}>} checks @param {"required"|"advisory"} requirement */
function categorySummary(checks, requirement) {
  const selected = checks.filter((item) => item.requirement === requirement);
  return {
    total: selected.length,
    pass: selected.filter((item) => item.status === "PASS").length,
    warn: selected.filter((item) => item.status === "WARN").length,
    fail: selected.filter((item) => item.status === "FAIL").length,
    unverified: selected.filter((item) => item.status === "UNVERIFIED").length,
    missing: selected.filter((item) => item.status === "MISSING").length,
  };
}

/** @param {string} baseDir @param {any} entry @param {number} index @param {string} generatedAt */
function inspectEntry(baseDir, entry, index, generatedAt) {
  const rawManifest = readJsonBounded(resolveInput(baseDir, entry.manifestFile));
  if (!rawManifest) return technicalFailure(index, "repository manifest cannot be read safely");
  const manifest = validateRepositoryManifest(rawManifest);
  if (!manifest.valid || !manifest.manifest) return technicalFailure(index, "repository manifest is invalid");

  const rawEvidence = readJsonBounded(resolveInput(baseDir, entry.evidenceFile));
  if (!rawEvidence) return { ...technicalFailure(index, "repository check evidence cannot be read safely"), repository: manifest.manifest.repository.id, profile: manifest.manifest.profile };
  const evidence = validateRepositoryCheckEvidence(rawEvidence);
  if (!evidence.valid || !evidence.evidence) return { ...technicalFailure(index, "repository check evidence is invalid"), repository: manifest.manifest.repository.id, profile: manifest.manifest.profile };
  if (evidence.evidence.repository.id !== manifest.manifest.repository.id) {
    return { ...technicalFailure(index, "repository check evidence identity does not match manifest"), repository: manifest.manifest.repository.id, profile: manifest.manifest.profile };
  }

  let policyReport;
  let policySource = "public-pack";
  if (entry.organizationPolicyFile) {
    const rawPolicy = readJsonBounded(resolveInput(baseDir, entry.organizationPolicyFile));
    if (!rawPolicy) return { ...technicalFailure(index, "organization policy cannot be read safely"), repository: manifest.manifest.repository.id, profile: manifest.manifest.profile };
    const policy = validateOrganizationPolicy(rawPolicy);
    if (!policy.valid || !policy.policy) return { ...technicalFailure(index, "organization policy is invalid"), repository: manifest.manifest.repository.id, profile: manifest.manifest.profile };
    policyReport = inspectOrganizationPolicy(manifest.manifest, policy.policy, BUILTIN_POLICY_PACKS);
    policySource = "organization";
  } else {
    policyReport = inspectManifestPolicyPack(manifest.manifest, BUILTIN_POLICY_PACKS);
  }

  const effective = policyReport.effective;
  if (!effective) {
    return {
      entry: index,
      repository: manifest.manifest.repository.id,
      profile: manifest.manifest.profile,
      policySource,
      evidence: evidence.evidence.evidence,
      policyStatus: "FAIL",
      checks: [],
      unscopedChecks: evidence.evidence.checks,
      required: { total: 0, pass: 0, warn: 0, fail: 0, unverified: 0, missing: 0 },
      advisory: { total: 0, pass: 0, warn: 0, fail: 0, unverified: 0, missing: 0 },
      technicalStatus: "PASS",
      overallStatus: "FAIL",
      technicalDetail: null,
    };
  }

  /** @type {any} */
  let severityPolicy = { version: 1, rules: [] };
  if (entry.severityPolicyFile) {
    const rawSeverity = readJsonBounded(resolveInput(baseDir, entry.severityPolicyFile));
    if (!rawSeverity) return { ...technicalFailure(index, "severity policy cannot be read safely"), repository: manifest.manifest.repository.id, profile: manifest.manifest.profile };
    const validatedSeverity = validateSeverityPolicy(rawSeverity);
    if (!validatedSeverity.valid || !validatedSeverity.policy) return { ...technicalFailure(index, "severity policy is invalid"), repository: manifest.manifest.repository.id, profile: manifest.manifest.profile };
    severityPolicy = validatedSeverity.policy;
  }
  const severityReport = resolveSeverityPolicy(effective, severityPolicy);
  const observed = new Map(evidence.evidence.checks.map((item) => [item.id, item.status]));
  const checks = evaluateChecks(severityReport.effective.checks, observed)
    .sort((a, b) => `${a.requirement}:${a.id}`.localeCompare(`${b.requirement}:${b.id}`));
  const scopedIds = new Set(checks.map((item) => item.id));
  const unscopedChecks = evidence.evidence.checks.filter((item) => !scopedIds.has(item.id));
  const required = categorySummary(checks, "required"), advisory = categorySummary(checks, "advisory");
  const futureEvidence = Date.parse(evidence.evidence.evidence.collectedAt) > Date.parse(generatedAt);
  const impactFail = checks.some((item) => item.impact === "FAIL");
  const impactWarn = checks.some((item) => item.impact === "WARN") || futureEvidence;
  const policyFailed = policyReport.overallStatus === "FAIL" || severityReport.overallStatus === "FAIL";

  return {
    entry: index,
    repository: manifest.manifest.repository.id,
    profile: manifest.manifest.profile,
    policySource,
    evidence: evidence.evidence.evidence,
    policyStatus: policyFailed ? "FAIL" : "PASS",
    evidenceTimeStatus: futureEvidence ? "FUTURE" : "VALID",
    checks,
    unscopedChecks,
    required,
    advisory,
    technicalStatus: "PASS",
    overallStatus: policyFailed || impactFail ? "FAIL" : impactWarn ? "WARN" : "PASS",
    technicalDetail: null,
  };
}

/** @param {any} config @param {string} baseDir */
export function inspectEcosystemDashboard(config, baseDir) {
  const repositories = /** @type {any[]} */ (config.repositories).map((entry, index) => inspectEntry(baseDir, entry, index, config.generatedAt));
  const seen = new Map();
  for (const repository of repositories) {
    if (!repository.repository) continue;
    const previous = seen.get(repository.repository);
    if (previous !== undefined) {
      repository.technicalStatus = "FAIL";
      repository.overallStatus = "FAIL";
      repository.technicalDetail = "duplicate repository identity in dashboard config";
      const prior = repositories[previous];
      if (prior) { prior.technicalStatus = "FAIL"; prior.overallStatus = "FAIL"; prior.technicalDetail = "duplicate repository identity in dashboard config"; }
    } else seen.set(repository.repository, repository.entry);
  }
  repositories.sort((a, b) => (a.repository ?? `~${a.entry}`).localeCompare(b.repository ?? `~${b.entry}`));
  const summary = {
    repositories: repositories.length,
    pass: repositories.filter((item) => item.overallStatus === "PASS").length,
    warn: repositories.filter((item) => item.overallStatus === "WARN").length,
    fail: repositories.filter((item) => item.overallStatus === "FAIL").length,
    technicalFail: repositories.filter((item) => item.technicalStatus === "FAIL").length,
    requiredChecks: repositories.reduce((sum, item) => sum + item.required.total, 0),
    advisoryChecks: repositories.reduce((sum, item) => sum + item.advisory.total, 0),
  };
  return {
    version: 1,
    generatedAt: config.generatedAt,
    repositories,
    summary,
    technicalStatus: summary.technicalFail > 0 ? "FAIL" : "PASS",
    overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectEcosystemDashboard>} report */
export function formatEcosystemDashboard(report) {
  const lines = ["Ecosystem dashboard", "", `Generated at: ${report.generatedAt}`, "", "REPOSITORY  PROFILE  REQUIRED  ADVISORY  POLICY  OVERALL"];
  for (const repository of report.repositories) {
    const name = repository.repository ?? `(entry ${repository.entry + 1})`;
    const profile = repository.profile ?? "unknown";
    lines.push(`${name}  ${profile}  ${repository.required.pass}/${repository.required.total} pass  ${repository.advisory.pass}/${repository.advisory.total} pass  ${repository.policyStatus}  ${repository.overallStatus}`);
    if (repository.technicalDetail) lines.push(`  technical: ${repository.technicalDetail}`);
  }
  lines.push("", `Repositories: ${report.summary.repositories}`, `Overall: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Result: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv */
function parse(argv) {
  let configFile = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--config" || configFile !== null) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    configFile = value; index += 1;
  }
  return configFile ? { configFile, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/ecosystem-dashboard.js --config <dashboard-config.json> [--json]"); return 1; }
  const absoluteConfig = path.resolve(options.configFile);
  const raw = readJsonBounded(absoluteConfig);
  if (!raw) { console.error("Ecosystem dashboard config cannot be read or parsed"); return 1; }
  const validated = validateEcosystemDashboardConfig(raw);
  if (!validated.valid || !validated.config) { console.error("Ecosystem dashboard config is invalid"); return 1; }
  const report = inspectEcosystemDashboard(validated.config, path.dirname(absoluteConfig));
  console.log(options.json ? JSON.stringify(report) : formatEcosystemDashboard(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
