#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  formatVulnerabilityEvidence,
  validateVulnerabilityEvidence,
  validateVulnerabilityQueryManifest,
} from "./vulnerability-evidence.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const MAX_API_BYTES = 16 * 1024 * 1024;
const ALERTS_PER_PAGE = 100;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {unknown} value */
function normalizeRepository(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/.test(normalized)) return null;
  const [owner, repository] = normalized.split("/");
  return owner && repository ? { slug: normalized, owner, repository } : null;
}
function githubCliAuthCheck() {
  const result = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], {
    encoding: "utf8",
    maxBuffer: MAX_API_BYTES,
  });
  return result.status === 0;
}

/** @param {string} endpoint */
function githubCliApiGet(endpoint) {
  const result = spawnSync("gh", ["api", "--method", "GET", endpoint], {
    encoding: "utf8",
    maxBuffer: MAX_API_BYTES,
  });
  if (result.status !== 0) {
    return { ok: false, error: { id: "github-api-request-failed", detail: "GitHub API request failed" } };
  }
  try { return { ok: true, value: JSON.parse(result.stdout) }; }
  catch { return { ok: false, error: { id: "github-api-json-invalid", detail: "GitHub API returned invalid JSON" } }; }
}

/** @param {unknown} value */
function normalizeSeverity(value) {
  const severity = text(value)?.toUpperCase() ?? "UNKNOWN";
  if (severity === "MEDIUM") return "MODERATE";
  return ["LOW", "MODERATE", "HIGH", "CRITICAL"].includes(severity) ? severity : "UNKNOWN";
}

/** @param {unknown} value */
function normalizeRelationship(value) {
  const relationship = text(value)?.toLowerCase() ?? "unknown";
  if (relationship === "direct") return "direct";
  if (relationship === "indirect") return "transitive";
  return "unknown";
}
/** @param {{ecosystem:string,name:string}} pkg */
function packageFamilyKey(pkg) {
  return `${pkg.ecosystem.toLowerCase()}\u0000${pkg.name}`;
}

/** @param {unknown} advisory @param {string} primaryId */
function advisoryAliases(advisory, primaryId) {
  if (!isPlainObject(advisory)) return [];
  const aliases = new Set();
  const cve = text(advisory.cve_id);
  if (cve && cve !== primaryId) aliases.add(cve);
  if (Array.isArray(advisory.identifiers)) {
    for (const item of advisory.identifiers) {
      if (!isPlainObject(item)) continue;
      const value = text(item.value);
      if (value && value !== primaryId && value.length <= 255) aliases.add(value);
    }
  }
  return [...aliases].sort();
}

/** @param {unknown} vulnerability */
function patchedVersion(vulnerability) {
  if (!isPlainObject(vulnerability) || !isPlainObject(vulnerability.first_patched_version)) return [];
  const identifier = text(vulnerability.first_patched_version.identifier);
  return identifier && identifier.length <= 255 ? [identifier] : [];
}

/** @param {unknown} raw */
function openAlertState(raw) {
  return isPlainObject(raw) && text(raw.state)?.toLowerCase() === "open";
}

/** @param {any} manifest */
function manifestFamilies(manifest) {
  const families = new Map();
  for (const pkg of manifest.packages) {
    const key = packageFamilyKey(pkg);
    if (families.has(key)) throw new Error(`manifest has multiple exact versions for ${pkg.ecosystem}:${pkg.name}`);
    families.set(key, pkg);
  }
  return families;
}
/** @param {any} manifest @param {unknown[]} alerts @param {string} collectedAt */
export function adaptGitHubDependabotAlerts(manifest, alerts, collectedAt) {
  if (!isAbsoluteIsoTimestamp(collectedAt)) throw new Error("collectedAt must be an absolute ISO timestamp");
  const families = manifestFamilies(manifest);
  const packages = new Map(manifest.packages.map((/** @type {any} */ pkg) => [packageFamilyKey(pkg), {
    ecosystem: pkg.ecosystem,
    name: pkg.name,
    version: pkg.version,
    relationship: pkg.relationship,
    vulnerabilities: [],
  }]));

  for (const raw of alerts) {
    if (!openAlertState(raw)) continue;
    if (!isPlainObject(raw) || !isPlainObject(raw.dependency) || !isPlainObject(raw.dependency.package)) {
      throw new Error("Dependabot alert dependency package is invalid");
    }
    const ecosystem = text(raw.dependency.package.ecosystem);
    const name = text(raw.dependency.package.name);
    if (!ecosystem || !name) throw new Error("Dependabot alert package identity is invalid");
    const key = packageFamilyKey({ ecosystem, name });
    const manifestPackage = families.get(key);
    const outputPackage = packages.get(key);
    if (!manifestPackage || !outputPackage) {
      throw new Error(`open Dependabot alert package is missing from explicit manifest: ${ecosystem}:${name}`);
    }
    const providerRelationship = normalizeRelationship(raw.dependency.relationship);
    if (providerRelationship !== "unknown" && providerRelationship !== manifestPackage.relationship) {
      throw new Error(`Dependabot relationship disagrees with manifest for ${ecosystem}:${name}`);
    }
    const advisory = raw.security_advisory;
    const securityVulnerability = raw.security_vulnerability;
    if (!isPlainObject(advisory) || !isPlainObject(securityVulnerability)) {
      throw new Error("Dependabot security advisory or vulnerability is invalid");
    }
    const id = text(advisory.ghsa_id);
    if (!id || id.length > 255) throw new Error("Dependabot GHSA id is invalid");
    const updatedAt = text(advisory.updated_at);
    if (updatedAt && !isAbsoluteIsoTimestamp(updatedAt)) throw new Error("Dependabot advisory updated_at is invalid");
    const severity = normalizeSeverity(securityVulnerability.severity ?? advisory.severity);
    const fixedVersions = patchedVersion(securityVulnerability);
    const aliases = advisoryAliases(advisory, id);
    const existing = outputPackage.vulnerabilities.find((/** @type {any} */ item) => item.id === id);
    if (existing) {
      if (existing.severity !== severity) throw new Error(`Dependabot duplicate alert severity disagrees for ${id}`);
      existing.aliases = [...new Set([...existing.aliases, ...aliases])].sort();
      existing.fixedVersions = [...new Set([...existing.fixedVersions, ...fixedVersions])].sort();
      if (updatedAt && (!existing.modified || Date.parse(updatedAt) > Date.parse(existing.modified))) existing.modified = updatedAt;
      continue;
    }
    outputPackage.vulnerabilities.push({
      id,
      aliases,
      severity,
      ...(updatedAt ? { modified: updatedAt } : {}),
      fixedVersions,
    });
  }

  const candidate = {
    version: 1,
    source: { provider: "github-dependabot", authenticated: true, collectedAt },
    packages: [...packages.values()],
  };  const validated = validateVulnerabilityEvidence(candidate);
  if (!validated.ok || validated.evidence === null) {
    throw new Error("adapted Dependabot evidence failed canonical validation");
  }
  return validated.evidence;
}

/**
 * @param {{ repository:unknown, manifest:any }} options
 * @param {{ authCheck?:()=>boolean, apiGet?:(endpoint:string)=>any, now?:()=>string }} [dependencies]
 */
export function collectGitHubDependabotEvidence(options, dependencies = {}) {
  const repository = normalizeRepository(options.repository);
  if (repository === null) {
    return { ok: false, error: { id: "github-repository-invalid", detail: "repository must be an explicit owner/name slug" } };
  }
  const manifestResult = validateVulnerabilityQueryManifest(options.manifest);
  if (!manifestResult.ok || manifestResult.manifest === null) {
    return { ok: false, error: { id: "manifest-invalid", detail: "vulnerability query manifest is invalid" } };
  }
  try { manifestFamilies(manifestResult.manifest); }
  catch { return { ok: false, error: { id: "manifest-ambiguous", detail: "manifest must contain one exact version per package family" } }; }

  const authCheck = dependencies.authCheck ?? githubCliAuthCheck;
  if (!authCheck()) {
    return { ok: false, error: { id: "github-auth-required", detail: "GitHub CLI authentication for github.com is required" } };
  }
  const apiGet = dependencies.apiGet ?? githubCliApiGet;
  const owner = encodeURIComponent(repository.owner);
  const name = encodeURIComponent(repository.repository);
  const alerts = [];
  let pagesFetched = 0;
  for (let page = 1; page <= 1000; page += 1) {
    const endpoint = `repos/${owner}/${name}/dependabot/alerts?state=open&per_page=${ALERTS_PER_PAGE}&page=${page}`;
    const pageResult = apiGet(endpoint);
    if (!pageResult.ok) return pageResult;
    pagesFetched += 1;
    if (!Array.isArray(pageResult.value)) {
      return { ok: false, error: { id: "github-dependabot-response-invalid", detail: "Dependabot API response must be an array" } };
    }
    alerts.push(...pageResult.value);
    if (pageResult.value.length < ALERTS_PER_PAGE) break;
    if (page === 1000) {
      return { ok: false, error: { id: "github-dependabot-pagination-limit", detail: "Dependabot pagination exceeded safety limit" } };
    }
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const collectedAt = now();
  if (!isAbsoluteIsoTimestamp(collectedAt)) {
    return { ok: false, error: { id: "collection-time-invalid", detail: "collector clock returned an invalid timestamp" } };
  }
  try {
    const evidence = adaptGitHubDependabotAlerts(manifestResult.manifest, alerts, collectedAt);
    return {
      ok: true,
      evidence,
      collection: { repository: repository.slug, alerts: alerts.length, pages: pagesFetched },
    };
  } catch {
    return { ok: false, error: { id: "github-dependabot-adapter-failed", detail: "Dependabot alerts could not be bound to explicit vulnerability evidence" } };
  }
}
/** @param {string[]} argv */
function parseArguments(argv) {
  let repository = null;
  let manifestFile = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--repository" && argument !== "--manifest-file") return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--repository") {
      if (repository !== null) return null;
      repository = value;
    } else {
      if (manifestFile !== null) return null;
      manifestFile = value;
    }
  }
  return repository && manifestFile ? { repository, manifestFile, json } : null;
}

/**
 * @param {string[]} argv
 * @param {{ authCheck?:()=>boolean, apiGet?:(endpoint:string)=>any, now?:()=>string }} [dependencies]
 */
export function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/collect-github-dependabot-evidence.js --repository <owner/name> --manifest-file <manifest.json> [--json]");
    return 1;
  }  let rawManifest;
  try { rawManifest = JSON.parse(fs.readFileSync(options.manifestFile, "utf8")); }
  catch { console.error("Vulnerability query manifest cannot be read or parsed"); return 1; }
  const result = collectGitHubDependabotEvidence({ repository: options.repository, manifest: rawManifest }, dependencies);
  if (!result.ok) {
    console.error(result.error.detail);
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.evidence) : formatVulnerabilityEvidence(result.evidence));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
