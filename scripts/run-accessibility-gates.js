#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import axe from "axe-core";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** @typedef {"critical"|"serious"|"moderate"|"minor"|"unknown"} Impact */
const IMPACTS = new Set(["critical", "serious", "moderate", "minor", "unknown"]);
/** @param {unknown} value @returns {Impact} */
function normalizeImpact(value) {
  return typeof value === "string" && IMPACTS.has(value) ? /** @type {Impact} */ (value) : "unknown";
}

/** @typedef {{id:string,url:string,expectedStatuses:number[],timeoutMs:number,tags:string[],maxCritical:number,maxSerious:number,maxModerate:number,maxMinor:number,maxUnknown:number}} AccessibilityRoute */
/** @typedef {{version:1,suite:string,routes:AccessibilityRoute[]}} AccessibilityPolicy */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function plainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value @param {number} [max] */
function text(value, max = 255) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}
/** @param {Record<string, unknown>} value @param {string[]} allowed */
function hasOnly(value, allowed) { return Object.keys(value).every((key) => allowed.includes(key)); }
/** @param {string} hostname */
function loopbackHost(hostname) {
  const lower = hostname.toLowerCase();
  return lower === "localhost" || lower.endsWith(".localhost") || lower === "127.0.0.1" || lower === "::1" || lower === "[::1]";
}
/** @param {unknown} value */
function safeUrl(value) {
  const raw = text(value, 2048);
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:" && loopbackHost(parsed.hostname)) return parsed.toString();
  return null;
}
/** @param {unknown} value @param {string} field */
function boundedCount(value, field) {
  if (!Number.isInteger(value) || Number(value) < 0 || Number(value) > 1_000_000) throw new Error(`${field} must be a bounded non-negative integer`);
  return Number(value);
}

/** @param {unknown} value */
export function validateAccessibilityPolicy(value) {
  if (!plainObject(value) || !hasOnly(value, ["version", "suite", "routes"])) return { ok: false, policy: null, error: "accessibility policy contains unsupported fields" };
  if (value.version !== 1) return { ok: false, policy: null, error: "policy version must be exactly 1" };
  const suite = text(value.suite, 128);
  if (!suite) return { ok: false, policy: null, error: "suite must be a bounded non-empty string" };
  if (!Array.isArray(value.routes) || value.routes.length === 0 || value.routes.length > 64) return { ok: false, policy: null, error: "routes must be a non-empty bounded array" };

  /** @type {AccessibilityRoute[]} */
  const routes = [];
  const ids = new Set();
  for (const [index, raw] of value.routes.entries()) {
    if (!plainObject(raw) || !hasOnly(raw, ["id", "url", "expectedStatuses", "timeoutMs", "tags", "maxCritical", "maxSerious", "maxModerate", "maxMinor", "maxUnknown"])) return { ok: false, policy: null, error: `routes[${index}] contains unsupported fields` };
    const id = text(raw.id, 128);
    const url = safeUrl(raw.url);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || ids.has(id) || !url) return { ok: false, policy: null, error: `routes[${index}] has invalid id or url` };
    ids.add(id);
    if (!Array.isArray(raw.expectedStatuses) || raw.expectedStatuses.length === 0 || raw.expectedStatuses.length > 16 || raw.expectedStatuses.some((status) => !Number.isInteger(status) || Number(status) < 100 || Number(status) > 599)) return { ok: false, policy: null, error: `routes[${index}].expectedStatuses is invalid` };
    const expectedStatuses = raw.expectedStatuses.map(Number);
    if (new Set(expectedStatuses).size !== expectedStatuses.length) return { ok: false, policy: null, error: `routes[${index}] has duplicate expected statuses` };
    if (!Number.isInteger(raw.timeoutMs) || Number(raw.timeoutMs) < 100 || Number(raw.timeoutMs) > 30_000) return { ok: false, policy: null, error: `routes[${index}].timeoutMs is invalid` };
    if (!Array.isArray(raw.tags) || raw.tags.length === 0 || raw.tags.length > 32) return { ok: false, policy: null, error: `routes[${index}].tags must be a non-empty bounded array` };
    const tags = raw.tags.map((item) => text(item, 64));
    if (tags.some((item) => !item || !/^[A-Za-z0-9._-]+$/.test(item)) || new Set(tags).size !== tags.length) return { ok: false, policy: null, error: `routes[${index}].tags contains invalid or duplicate values` };
    try {
      routes.push({
        id,
        url,
        expectedStatuses: expectedStatuses.sort((a, b) => a - b),
        timeoutMs: Number(raw.timeoutMs),
        tags: /** @type {string[]} */ (tags).sort(),
        maxCritical: boundedCount(raw.maxCritical, "maxCritical"),
        maxSerious: boundedCount(raw.maxSerious, "maxSerious"),
        maxModerate: boundedCount(raw.maxModerate, "maxModerate"),
        maxMinor: boundedCount(raw.maxMinor, "maxMinor"),
        maxUnknown: boundedCount(raw.maxUnknown, "maxUnknown"),
      });
    } catch (error) { return { ok: false, policy: null, error: error instanceof Error ? error.message : `routes[${index}] thresholds are invalid` }; }
  }
  routes.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, policy: /** @type {AccessibilityPolicy} */ ({ version: 1, suite, routes }), error: null };
}

/** @param {AccessibilityRoute} route */
async function observeRouteWithAxe(route) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: false });
    const page = await context.newPage();
    const requestedOrigin = new URL(route.url).origin;
    let blockedMutations = 0;
    await page.route("**/*", async (intercept) => {
      const request = intercept.request();
      const method = request.method().toUpperCase();
      if (!READ_METHODS.has(method)) { blockedMutations += 1; await intercept.abort("blockedbyclient"); return; }
      if (request.isNavigationRequest() && new URL(request.url()).origin !== requestedOrigin) { await intercept.abort("blockedbyclient"); return; }
      await intercept.continue();
    });
    let statusCode = 0;
    try {
      const response = await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: route.timeoutMs });
      statusCode = response?.status() ?? 0;
      await page.waitForLoadState("load", { timeout: Math.min(route.timeoutMs, 5000) }).catch(() => {});
      await page.addScriptTag({ content: axe.source });
      const raw = await page.evaluate(async (tags) => {
        const axeApi = /** @type {any} */ (window).axe;
        return axeApi.run(document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
      }, route.tags);
      const violations = Array.isArray(raw?.violations) ? raw.violations : [];
      const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 };
      const rules = [];
      for (const violation of violations) {
        const id = text(violation?.id, 128);
        const impact = normalizeImpact(violation?.impact);
        const nodes = Array.isArray(violation?.nodes) ? violation.nodes.length : 0;
        if (!id || !Number.isInteger(nodes) || nodes < 0 || nodes > 1_000_000) return { ok: false, error: "axe-result-invalid" };
        counts[impact] += nodes;
        rules.push({ id, impact, nodes });
      }
      rules.sort((a, b) => a.id.localeCompare(b.id));
      return { ok: true, observation: { statusCode, blockedMutations, counts, rules } };
    } catch { return { ok: false, error: "accessibility-route-failed" }; }
    finally { await context.close(); }
  } finally { await browser.close(); }
}

/** @param {AccessibilityPolicy} policy @param {{observeRoute?:typeof observeRouteWithAxe, now?:()=>string}} [dependencies] */
export async function executeAccessibilityGates(policy, dependencies = {}) {
  const observe = dependencies.observeRoute ?? observeRouteWithAxe;
  const results = [];
  for (const route of policy.routes) {
    const observed = await observe(route);
    if (!plainObject(observed) || observed.ok !== true || !plainObject(observed.observation)) {
      results.push({ id: route.id, url: route.url, status: "FAIL", findings: ["accessibility-route-failed"], counts: null, rules: [] });
      continue;
    }
    const raw = observed.observation;
    if (!Number.isInteger(raw.statusCode) || Number(raw.statusCode) < 100 || Number(raw.statusCode) > 599 || !plainObject(raw.counts) || !Array.isArray(raw.rules)) {
      results.push({ id: route.id, url: route.url, status: "FAIL", findings: ["accessibility-observation-invalid"], counts: null, rules: [] });
      continue;
    }
    let valid = true;
    let counts;
    let blockedMutations = 0;
    try {
      blockedMutations = boundedCount(raw.blockedMutations, "blockedMutations");
      counts = {
        critical: boundedCount(raw.counts.critical, "critical"),
        serious: boundedCount(raw.counts.serious, "serious"),
        moderate: boundedCount(raw.counts.moderate, "moderate"),
        minor: boundedCount(raw.counts.minor, "minor"),
        unknown: boundedCount(raw.counts.unknown, "unknown"),
      };
    } catch { valid = false; counts = null; }
    const rules = [];
    const ruleIds = new Set();
    for (const rule of raw.rules) {
      if (!plainObject(rule) || !hasOnly(rule, ["id", "impact", "nodes"])) { valid = false; break; }
      const id = text(rule.id, 128);
      const impact = typeof rule.impact === "string" && IMPACTS.has(rule.impact) ? /** @type {Impact} */ (rule.impact) : null;
      if (!id || !impact || ruleIds.has(id) || !Number.isInteger(rule.nodes) || Number(rule.nodes) < 1 || Number(rule.nodes) > 1_000_000) { valid = false; break; }
      ruleIds.add(id);
      rules.push({ id, impact, nodes: Number(rule.nodes) });
    }
    if (!valid || counts === null) {
      results.push({ id: route.id, url: route.url, status: "FAIL", findings: ["accessibility-observation-invalid"], counts: null, rules: [] });
      continue;
    }
    rules.sort((a, b) => a.id.localeCompare(b.id));
    const derived = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 };
    for (const rule of rules) derived[rule.impact] += rule.nodes;
    if (derived.critical !== counts.critical || derived.serious !== counts.serious || derived.moderate !== counts.moderate || derived.minor !== counts.minor || derived.unknown !== counts.unknown) {
      results.push({ id: route.id, url: route.url, status: "FAIL", findings: ["accessibility-observation-invalid"], counts: null, rules: [] });
      continue;
    }
    const findings = [];
    if (!route.expectedStatuses.includes(Number(raw.statusCode))) findings.push("unexpected-route-status");
    if (blockedMutations > 0) findings.push("blocked-mutation-attempts");
    if (counts.critical > route.maxCritical) findings.push("critical-violations");
    if (counts.serious > route.maxSerious) findings.push("serious-violations");
    if (counts.moderate > route.maxModerate) findings.push("moderate-violations");
    if (counts.minor > route.maxMinor) findings.push("minor-violations");
    if (counts.unknown > route.maxUnknown) findings.push("unknown-violations");
    results.push({ id: route.id, url: route.url, status: findings.length > 0 ? "FAIL" : "PASS", findings, counts, rules });
  }
  const collectedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  if (!isAbsoluteIsoTimestamp(collectedAt)) throw new Error("accessibility collection clock must return an absolute ISO timestamp");
  const pass = results.filter((result) => result.status === "PASS").length;
  const fail = results.length - pass;
  return {
    version: 1,
    suite: policy.suite,
    engine: { name: "axe-core", version: axe.version },
    collectedAt,
    boundary: { allowedRequestMethods: ["GET", "HEAD", "OPTIONS"], crossOriginNavigationBlocked: true, serviceWorkersBlocked: true, credentialsConfigured: false },
    results,
    summary: { pass, fail },
    technicalStatus: "PASS",
    overallStatus: fail > 0 ? "FAIL" : "PASS",
  };
}

/** @param {Awaited<ReturnType<typeof executeAccessibilityGates>>} report */
export function formatAccessibilityGates(report) {
  const lines = [
    "Accessibility gates",
    "",
    `Suite: ${report.suite}`,
    `Engine: ${report.engine.name} ${report.engine.version}`,
    `Collected at: ${report.collectedAt}`,
    "Boundary: GET/HEAD/OPTIONS only; mutation methods and cross-origin navigation blocked; no configured credentials",
    "",
  ];
  for (const result of report.results) {
    lines.push(`${result.status.padEnd(4)}  ${result.id}  ${result.url}${result.findings.length ? `  ${result.findings.join(", ")}` : ""}`);
    if (result.counts) lines.push(`      critical=${result.counts.critical} serious=${result.counts.serious} moderate=${result.counts.moderate} minor=${result.counts.minor} unknown=${result.counts.unknown}`);
    for (const rule of result.rules) lines.push(`      ${rule.impact}  ${rule.id}  nodes=${rule.nodes}`);
  }
  lines.push("", `Routes: ${report.summary.pass} pass, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv @param {{observeRoute?:typeof observeRouteWithAxe, now?:()=>string}} [dependencies] */
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  let policyFile = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--policy" || policyFile !== null) { console.error("Usage: node scripts/run-accessibility-gates.js --policy <policy.json> [--json]"); return 1; }
    const candidate = argv[index + 1];
    if (typeof candidate !== "string" || candidate.startsWith("--") || candidate.length === 0) { console.error("Usage: node scripts/run-accessibility-gates.js --policy <policy.json> [--json]"); return 1; }
    policyFile = candidate; index += 1;
  }
  if (!policyFile) { console.error("Usage: node scripts/run-accessibility-gates.js --policy <policy.json> [--json]"); return 1; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(policyFile, "utf8")); } catch { console.error("Accessibility policy cannot be read or parsed"); return 1; }
  const validated = validateAccessibilityPolicy(raw);
  if (!validated.ok || !validated.policy) { console.error(validated.error ?? "Accessibility policy is invalid"); return 1; }
  const report = await executeAccessibilityGates(validated.policy, dependencies);
  console.log(json ? JSON.stringify(report) : formatAccessibilityGates(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = await main();
