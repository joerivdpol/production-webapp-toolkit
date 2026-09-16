#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validatePerformanceEvidence } from "./performance-evidence.js";
import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

/** @typedef {{id:string,maxLcpMs?:number,maxCls?:number,maxInpMs?:number}} RouteBudget */
/** @typedef {{version:1,maxEvidenceAgeSeconds:number,bundle?:{maxTotalBytes?:number,maxJsBytes?:number,maxCssBytes?:number},routes:RouteBudget[]}} PerformancePolicy */
/** @typedef {{id:string,status:"PASS"|"FAIL",scope:string,detail:string}} Check */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {Record<string, unknown>} value @param {string[]} allowed */
function hasOnly(value, allowed) { return Object.keys(value).every((key) => allowed.includes(key)); }
/** @param {unknown} value @param {number} maximum */
function positiveInteger(value, maximum) {
  return Number.isInteger(value) && Number(value) > 0 && Number(value) <= maximum ? Number(value) : null;
}
/** @param {unknown} value @param {number} maximum */
function nonNegativeNumber(value, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
}
/** @param {unknown} value */
function boundedId(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(value.trim()) ? value.trim() : null;
}

/** @param {unknown} value */
export function validatePerformancePolicy(value) {
  if (!plainObject(value) || !hasOnly(value, ["version", "maxEvidenceAgeSeconds", "bundle", "routes"])) return { ok: false, policy: null, error: "performance policy contains unsupported fields" };
  if (value.version !== 1) return { ok: false, policy: null, error: "policy version must be exactly 1" };
  const maxEvidenceAgeSeconds = positiveInteger(value.maxEvidenceAgeSeconds, 31_536_000);
  if (maxEvidenceAgeSeconds === null) return { ok: false, policy: null, error: "maxEvidenceAgeSeconds must be a bounded positive integer" };

  /** @type {{maxTotalBytes?:number,maxJsBytes?:number,maxCssBytes?:number}|undefined} */
  let bundle;
  if (value.bundle !== undefined) {
    if (!plainObject(value.bundle) || !hasOnly(value.bundle, ["maxTotalBytes", "maxJsBytes", "maxCssBytes"])) return { ok: false, policy: null, error: "bundle budget contains unsupported fields" };
    bundle = {};
    if (value.bundle.maxTotalBytes !== undefined) {
      const limit = positiveInteger(value.bundle.maxTotalBytes, 1_000_000_000_000);
      if (limit === null) return { ok: false, policy: null, error: "bundle.maxTotalBytes must be a bounded positive integer" };
      bundle.maxTotalBytes = limit;
    }
    if (value.bundle.maxJsBytes !== undefined) {
      const limit = positiveInteger(value.bundle.maxJsBytes, 1_000_000_000_000);
      if (limit === null) return { ok: false, policy: null, error: "bundle.maxJsBytes must be a bounded positive integer" };
      bundle.maxJsBytes = limit;
    }
    if (value.bundle.maxCssBytes !== undefined) {
      const limit = positiveInteger(value.bundle.maxCssBytes, 1_000_000_000_000);
      if (limit === null) return { ok: false, policy: null, error: "bundle.maxCssBytes must be a bounded positive integer" };
      bundle.maxCssBytes = limit;
    }
    if (Object.keys(bundle).length === 0) return { ok: false, policy: null, error: "bundle budget must configure at least one maximum" };
  }

  if (!Array.isArray(value.routes) || value.routes.length > 128) return { ok: false, policy: null, error: "routes must be a bounded array" };
  /** @type {RouteBudget[]} */
  const routes = [];
  const ids = new Set();
  for (const [index, raw] of value.routes.entries()) {
    if (!plainObject(raw) || !hasOnly(raw, ["id", "maxLcpMs", "maxCls", "maxInpMs"])) return { ok: false, policy: null, error: `routes[${index}] contains unsupported fields` };
    const id = boundedId(raw.id);
    if (!id || ids.has(id)) return { ok: false, policy: null, error: `routes[${index}].id is invalid or duplicate` };
    ids.add(id);
    const route = /** @type {RouteBudget} */ ({ id });
    if (raw.maxLcpMs !== undefined) {
      const limit = nonNegativeNumber(raw.maxLcpMs, 600_000);
      if (limit === null) return { ok: false, policy: null, error: `routes[${index}].maxLcpMs is invalid` };
      route.maxLcpMs = limit;
    }
    if (raw.maxCls !== undefined) {
      const limit = nonNegativeNumber(raw.maxCls, 100);
      if (limit === null) return { ok: false, policy: null, error: `routes[${index}].maxCls is invalid` };
      route.maxCls = limit;
    }
    if (raw.maxInpMs !== undefined) {
      const limit = nonNegativeNumber(raw.maxInpMs, 600_000);
      if (limit === null) return { ok: false, policy: null, error: `routes[${index}].maxInpMs is invalid` };
      route.maxInpMs = limit;
    }
    if (route.maxLcpMs === undefined && route.maxCls === undefined && route.maxInpMs === undefined) return { ok: false, policy: null, error: `routes[${index}] must configure at least one metric budget` };
    routes.push(route);
  }
  if (!bundle && routes.length === 0) return { ok: false, policy: null, error: "policy must configure a bundle or route budget" };
  routes.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, policy: /** @type {PerformancePolicy} */ ({ version: 1, maxEvidenceAgeSeconds, ...(bundle ? { bundle } : {}), routes }), error: null };
}

/** @param {any} evidence @param {PerformancePolicy} policy @param {{expectedCommit:string,evaluatedAt:string}} context */
export function inspectPerformanceBudgets(evidence, policy, context) {
  /** @type {Check[]} */
  const checks = [];
  const expectedCommit = typeof context.expectedCommit === "string" ? context.expectedCommit.trim() : "";
  if (!isFullObjectId(expectedCommit)) throw new Error("expectedCommit must be a full Git object id");
  if (!isAbsoluteIsoTimestamp(context.evaluatedAt)) throw new Error("evaluatedAt must be an absolute ISO timestamp");

  const normalizedExpected = expectedCommit.toLowerCase();
  checks.push(evidence.artifact.commit === normalizedExpected
    ? { id: "commit-match", status: "PASS", scope: "evidence", detail: "performance evidence is bound to the expected commit" }
    : { id: "commit-mismatch", status: "FAIL", scope: "evidence", detail: `performance evidence commit ${evidence.artifact.commit} does not match expected commit ${normalizedExpected}` });

  const collected = Date.parse(evidence.source.collectedAt);
  const evaluated = Date.parse(context.evaluatedAt);
  const ageSeconds = Math.floor((evaluated - collected) / 1000);
  if (ageSeconds < 0) checks.push({ id: "evidence-future", status: "FAIL", scope: "evidence", detail: "performance evidence is future dated" });
  else if (ageSeconds > policy.maxEvidenceAgeSeconds) checks.push({ id: "evidence-stale", status: "FAIL", scope: "evidence", detail: `performance evidence age ${ageSeconds}s exceeds maximum ${policy.maxEvidenceAgeSeconds}s` });
  else checks.push({ id: "evidence-fresh", status: "PASS", scope: "evidence", detail: `performance evidence age ${ageSeconds}s is within policy` });

  if (policy.bundle) {
    /** @param {string} id @param {string} field @param {number} actual @param {number|undefined} maximum */
    const addBundleCheck = (id, field, actual, maximum) => {
      if (maximum === undefined) return;
      checks.push(actual <= maximum
        ? { id, status: "PASS", scope: "bundle", detail: `${field} ${actual} is within maximum ${maximum}` }
        : { id, status: "FAIL", scope: "bundle", detail: `${field} ${actual} exceeds maximum ${maximum}` });
    };
    addBundleCheck("bundle-total", "totalBytes", evidence.artifact.totalBytes, policy.bundle.maxTotalBytes);
    addBundleCheck("bundle-js", "jsBytes", evidence.artifact.jsBytes, policy.bundle.maxJsBytes);
    addBundleCheck("bundle-css", "cssBytes", evidence.artifact.cssBytes, policy.bundle.maxCssBytes);
  }

  const byRoute = new Map(evidence.routes.map((/** @type {any} */ route) => [route.id, route]));
  for (const budget of policy.routes) {
    const measured = byRoute.get(budget.id);
    if (!measured) {
      checks.push({ id: "route-missing", status: "FAIL", scope: budget.id, detail: "configured route has no performance evidence" });
      continue;
    }
    /** @param {string} id @param {"lcpMs"|"cls"|"inpMs"} field @param {number|undefined} maximum */
    const addMetricCheck = (id, field, maximum) => {
      if (maximum === undefined) return;
      const actual = measured[field];
      if (actual === undefined) {
        checks.push({ id: "metric-missing", status: "FAIL", scope: budget.id, detail: `${field} is required by policy but missing from evidence` });
        return;
      }
      checks.push(actual <= maximum
        ? { id, status: "PASS", scope: budget.id, detail: `${field} ${actual} is within maximum ${maximum}` }
        : { id, status: "FAIL", scope: budget.id, detail: `${field} ${actual} exceeds maximum ${maximum}` });
    };
    addMetricCheck("lcp-budget", "lcpMs", budget.maxLcpMs);
    addMetricCheck("cls-budget", "cls", budget.maxCls);
    addMetricCheck("inp-budget", "inpMs", budget.maxInpMs);
  }

  const fail = checks.filter((check) => check.status === "FAIL").length;
  return {
    commit: evidence.artifact.commit,
    source: evidence.source,
    evaluatedAt: context.evaluatedAt,
    checks,
    summary: { pass: checks.length - fail, fail },
    technicalStatus: "PASS",
    overallStatus: fail > 0 ? "FAIL" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectPerformanceBudgets>} report */
export function formatPerformanceBudgetAudit(report) {
  const lines = [
    "Performance budget audit",
    "",
    `Commit: ${report.commit}`,
    `Source: ${report.source.name}`,
    `Authenticated: ${report.source.authenticated}`,
    `Collected at: ${report.source.collectedAt}`,
    `Evaluated at: ${report.evaluatedAt}`,
    "Authentication: trust metadata only; it does not change budget truth",
    "",
  ];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.scope}  ${check.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let evidenceFile = null, policyFile = null, expectedCommit = null, evaluatedAt = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--evidence-file", "--policy", "--expected-commit", "--evaluated-at"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || value.length === 0) return null;
    index += 1;
    if (argument === "--evidence-file") { if (evidenceFile !== null) return null; evidenceFile = value; }
    else if (argument === "--policy") { if (policyFile !== null) return null; policyFile = value; }
    else if (argument === "--expected-commit") { if (expectedCommit !== null) return null; expectedCommit = value; }
    else { if (evaluatedAt !== null) return null; evaluatedAt = value; }
  }
  return evidenceFile && policyFile && expectedCommit && evaluatedAt ? { evidenceFile, policyFile, expectedCommit, evaluatedAt, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) { console.error("Usage: node scripts/audit-performance-budgets.js --evidence-file <performance.json> --policy <policy.json> --expected-commit <full-sha> --evaluated-at <ISO timestamp> [--json]"); return 1; }
  let rawEvidence, rawPolicy;
  try { rawEvidence = JSON.parse(fs.readFileSync(options.evidenceFile, "utf8")); } catch { console.error("Performance evidence file cannot be read or parsed"); return 1; }
  try { rawPolicy = JSON.parse(fs.readFileSync(options.policyFile, "utf8")); } catch { console.error("Performance policy cannot be read or parsed"); return 1; }
  const evidenceResult = validatePerformanceEvidence(rawEvidence);
  const policyResult = validatePerformancePolicy(rawPolicy);
  if (!evidenceResult.ok || !evidenceResult.evidence) { console.error(evidenceResult.error ?? "Performance evidence is invalid"); return 1; }
  if (!policyResult.ok || !policyResult.policy) { console.error(policyResult.error ?? "Performance policy is invalid"); return 1; }
  let report;
  try { report = inspectPerformanceBudgets(evidenceResult.evidence, policyResult.policy, { expectedCommit: options.expectedCommit, evaluatedAt: options.evaluatedAt }); }
  catch (error) { console.error(error instanceof Error ? error.message : "Performance budget audit input is invalid"); return 1; }
  console.log(options.json ? JSON.stringify(report) : formatPerformanceBudgetAudit(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
