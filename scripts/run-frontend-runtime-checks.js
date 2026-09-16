#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const ASSET_TYPES = new Set(["script", "stylesheet", "image", "font"]);

/** @typedef {{id:string,url:string,expectedStatuses:number[],timeoutMs:number,maxConsoleErrors:number,maxPageErrors:number,maxFailedAssets:number,maxFailedRequests:number,maxHydrationErrors:number,maxCspViolations:number,maxBlockedMutations:number}} FrontendRoute */
/** @typedef {{version:1,suite:string,hydrationMarkers:string[],routes:FrontendRoute[]}} FrontendPolicy */
/** @typedef {{statusCode:number,consoleErrors:number,pageErrors:number,failedAssets:number,failedRequests:number,hydrationErrors:number,cspViolations:number,blockedMutations:number}} RouteObservation */

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
function safeRouteUrl(value) {
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
export function validateFrontendRuntimePolicy(value) {
  if (!plainObject(value) || !hasOnly(value, ["version", "suite", "hydrationMarkers", "routes"])) return { ok: false, policy: null, error: "frontend runtime policy contains unsupported fields" };
  if (value.version !== 1) return { ok: false, policy: null, error: "policy version must be exactly 1" };
  const suite = text(value.suite, 128);
  if (!suite) return { ok: false, policy: null, error: "suite must be a bounded non-empty string" };
  if (!Array.isArray(value.hydrationMarkers) || value.hydrationMarkers.length > 32) return { ok: false, policy: null, error: "hydrationMarkers must be a bounded array" };
  const hydrationMarkers = value.hydrationMarkers.map((item) => text(item, 128)?.toLowerCase() ?? null);
  if (hydrationMarkers.some((item) => !item) || new Set(hydrationMarkers).size !== hydrationMarkers.length) return { ok: false, policy: null, error: "hydrationMarkers must contain unique bounded strings" };
  if (!Array.isArray(value.routes) || value.routes.length === 0 || value.routes.length > 64) return { ok: false, policy: null, error: "routes must be a non-empty bounded array" };

  /** @type {FrontendRoute[]} */
  const routes = [];
  const ids = new Set();
  for (const [index, raw] of value.routes.entries()) {
    if (!plainObject(raw) || !hasOnly(raw, ["id", "url", "expectedStatuses", "timeoutMs", "maxConsoleErrors", "maxPageErrors", "maxFailedAssets", "maxFailedRequests", "maxHydrationErrors", "maxCspViolations", "maxBlockedMutations"])) return { ok: false, policy: null, error: `routes[${index}] contains unsupported fields` };
    const id = text(raw.id, 128);
    const url = safeRouteUrl(raw.url);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || !url) return { ok: false, policy: null, error: `routes[${index}] has invalid id or url` };
    if (ids.has(id)) return { ok: false, policy: null, error: `duplicate route id ${id}` };
    ids.add(id);
    if (!Array.isArray(raw.expectedStatuses) || raw.expectedStatuses.length === 0 || raw.expectedStatuses.length > 16 || raw.expectedStatuses.some((status) => !Number.isInteger(status) || Number(status) < 100 || Number(status) > 599)) return { ok: false, policy: null, error: `routes[${index}].expectedStatuses is invalid` };
    const expectedStatuses = raw.expectedStatuses.map(Number);
    if (new Set(expectedStatuses).size !== expectedStatuses.length) return { ok: false, policy: null, error: `routes[${index}] has duplicate expected statuses` };
    if (!Number.isInteger(raw.timeoutMs) || Number(raw.timeoutMs) < 100 || Number(raw.timeoutMs) > 30_000) return { ok: false, policy: null, error: `routes[${index}].timeoutMs is invalid` };
    try {
      routes.push({
        id, url, expectedStatuses: expectedStatuses.sort((a, b) => a - b), timeoutMs: Number(raw.timeoutMs),
        maxConsoleErrors: boundedCount(raw.maxConsoleErrors, "maxConsoleErrors"),
        maxPageErrors: boundedCount(raw.maxPageErrors, "maxPageErrors"),
        maxFailedAssets: boundedCount(raw.maxFailedAssets, "maxFailedAssets"),
        maxFailedRequests: boundedCount(raw.maxFailedRequests, "maxFailedRequests"),
        maxHydrationErrors: boundedCount(raw.maxHydrationErrors, "maxHydrationErrors"),
        maxCspViolations: boundedCount(raw.maxCspViolations, "maxCspViolations"),
        maxBlockedMutations: boundedCount(raw.maxBlockedMutations, "maxBlockedMutations"),
      });
    } catch (error) { return { ok: false, policy: null, error: error instanceof Error ? error.message : `routes[${index}] threshold is invalid` }; }
  }
  routes.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, policy: /** @type {FrontendPolicy} */ ({ version: 1, suite, hydrationMarkers: /** @type {string[]} */ (hydrationMarkers), routes }), error: null };
}

/** @param {FrontendRoute} route @param {string[]} hydrationMarkers */
async function observeRouteWithPlaywright(route, hydrationMarkers) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: false });
    const page = await context.newPage();
    const requestedOrigin = new URL(route.url).origin;
    let consoleErrors = 0, pageErrors = 0, hydrationErrors = 0, cspViolations = 0, blockedMutations = 0;
    const failedAssetKeys = new Set();
    const failedRequestKeys = new Set();
    const intentionallyBlockedKeys = new Set();
    /** @param {string} message */
    const hydrationMatch = (message) => hydrationMarkers.some((marker) => message.toLowerCase().includes(marker));

    await page.exposeFunction("__toolkitRecordCsp", () => { cspViolations += 1; });
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", () => {
        const recorder = /** @type {any} */ (window).__toolkitRecordCsp;
        if (typeof recorder === "function") void recorder();
      });
    });
    await page.route("**/*", async (intercept) => {
      const request = intercept.request();
      const method = request.method().toUpperCase();
      if (!READ_METHODS.has(method)) {
        blockedMutations += 1;
        intentionallyBlockedKeys.add(`${method}:${request.url()}`);
        await intercept.abort("blockedbyclient");
        return;
      }
      if (request.isNavigationRequest() && new URL(request.url()).origin !== requestedOrigin) { await intercept.abort("blockedbyclient"); return; }
      await intercept.continue();
    });
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      consoleErrors += 1;
      if (hydrationMatch(message.text())) hydrationErrors += 1;
    });
    page.on("pageerror", (error) => {
      pageErrors += 1;
      if (hydrationMatch(error.message)) hydrationErrors += 1;
    });
    page.on("requestfailed", (request) => {
      const key = `${request.method()}:${request.url()}`;
      if (intentionallyBlockedKeys.has(key)) return;
      failedRequestKeys.add(key);
      if (ASSET_TYPES.has(request.resourceType())) failedAssetKeys.add(key);
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const request = response.request();
      const key = `${request.method()}:${request.url()}`;
      failedRequestKeys.add(key);
      if (ASSET_TYPES.has(request.resourceType())) failedAssetKeys.add(key);
    });

    let statusCode = 0;
    try {
      const response = await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: route.timeoutMs });
      statusCode = response?.status() ?? 0;
      await page.waitForLoadState("load", { timeout: Math.min(route.timeoutMs, 5000) }).catch(() => {});
    } catch { return { ok: false, error: "route-navigation-failed" }; }
    await context.close();
    return { ok: true, observation: { statusCode, consoleErrors, pageErrors, failedAssets: failedAssetKeys.size, failedRequests: failedRequestKeys.size, hydrationErrors, cspViolations, blockedMutations } };
  } finally { await browser.close(); }
}

/** @param {FrontendPolicy} policy @param {{observeRoute?:typeof observeRouteWithPlaywright, now?:()=>string}} [dependencies] */
export async function executeFrontendRuntimeChecks(policy, dependencies = {}) {
  const observe = dependencies.observeRoute ?? observeRouteWithPlaywright;
  const results = [];
  for (const route of policy.routes) {
    const observed = await observe(route, policy.hydrationMarkers);
    if (!plainObject(observed) || observed.ok !== true || !plainObject(observed.observation)) {
      results.push({ id: route.id, url: route.url, status: "FAIL", findings: ["route-navigation-failed"], metrics: null });
      continue;
    }
    const raw = observed.observation;
    /** @type {RouteObservation} */
    let metrics;
    try {
      metrics = {
        statusCode: boundedCount(raw.statusCode, "statusCode"),
        consoleErrors: boundedCount(raw.consoleErrors, "consoleErrors"),
        pageErrors: boundedCount(raw.pageErrors, "pageErrors"),
        failedAssets: boundedCount(raw.failedAssets, "failedAssets"),
        failedRequests: boundedCount(raw.failedRequests, "failedRequests"),
        hydrationErrors: boundedCount(raw.hydrationErrors, "hydrationErrors"),
        cspViolations: boundedCount(raw.cspViolations, "cspViolations"),
        blockedMutations: boundedCount(raw.blockedMutations, "blockedMutations"),
      };
    } catch { results.push({ id: route.id, url: route.url, status: "FAIL", findings: ["route-observation-invalid"], metrics: null }); continue; }
    if (metrics.statusCode < 100 || metrics.statusCode > 599) {
      results.push({ id: route.id, url: route.url, status: "FAIL", findings: ["route-observation-invalid"], metrics: null });
      continue;
    }
    const findings = [];
    if (!route.expectedStatuses.includes(metrics.statusCode)) findings.push("unexpected-route-status");
    const thresholds = /** @type {Array<{field:keyof RouteObservation,maximum:number,finding:string}>} */ ([
      { field: "consoleErrors", maximum: route.maxConsoleErrors, finding: "console-errors" },
      { field: "pageErrors", maximum: route.maxPageErrors, finding: "page-errors" },
      { field: "failedAssets", maximum: route.maxFailedAssets, finding: "failed-assets" },
      { field: "failedRequests", maximum: route.maxFailedRequests, finding: "failed-requests" },
      { field: "hydrationErrors", maximum: route.maxHydrationErrors, finding: "hydration-errors" },
      { field: "cspViolations", maximum: route.maxCspViolations, finding: "csp-violations" },
      { field: "blockedMutations", maximum: route.maxBlockedMutations, finding: "blocked-mutation-attempts" },
    ]);
    for (const threshold of thresholds) if (metrics[threshold.field] > threshold.maximum) findings.push(threshold.finding);
    results.push({ id: route.id, url: route.url, status: findings.length > 0 ? "FAIL" : "PASS", findings, metrics });
  }
  const pass = results.filter((result) => result.status === "PASS").length;
  const fail = results.length - pass;
  const collectedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  if (!isAbsoluteIsoTimestamp(collectedAt)) throw new Error("frontend runtime collection clock must return an absolute ISO timestamp");
  return {
    version: 1, suite: policy.suite, collectedAt,
    boundary: { allowedRequestMethods: ["GET", "HEAD", "OPTIONS"], crossOriginNavigationBlocked: true, serviceWorkersBlocked: true, credentialsConfigured: false },
    results, summary: { pass, fail }, technicalStatus: "PASS", overallStatus: fail > 0 ? "FAIL" : "PASS",
  };
}

/** @param {Awaited<ReturnType<typeof executeFrontendRuntimeChecks>>} report */
export function formatFrontendRuntimeChecks(report) {
  const lines = ["Frontend runtime checks", "", `Suite: ${report.suite}`, `Collected at: ${report.collectedAt}`, "Boundary: GET/HEAD/OPTIONS only; mutation methods and cross-origin navigation blocked; no configured credentials", ""];
  for (const result of report.results) {
    lines.push(`${result.status.padEnd(4)}  ${result.id}  ${result.url}${result.findings.length ? `  ${result.findings.join(", ")}` : ""}`);
    if (result.metrics) lines.push(`      status=${result.metrics.statusCode} console=${result.metrics.consoleErrors} page=${result.metrics.pageErrors} assets=${result.metrics.failedAssets} requests=${result.metrics.failedRequests} hydration=${result.metrics.hydrationErrors} csp=${result.metrics.cspViolations} blockedMutations=${result.metrics.blockedMutations}`);
  }
  lines.push("", `Routes: ${report.summary.pass} pass, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv @param {{observeRoute?:typeof observeRouteWithPlaywright, now?:()=>string}} [dependencies] */
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  let policyFile = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--policy" || policyFile !== null) { console.error("Usage: node scripts/run-frontend-runtime-checks.js --policy <policy.json> [--json]"); return 1; }
    const candidate = argv[index + 1];
    if (typeof candidate !== "string" || candidate.startsWith("--") || candidate.length === 0) { console.error("Usage: node scripts/run-frontend-runtime-checks.js --policy <policy.json> [--json]"); return 1; }
    policyFile = candidate; index += 1;
  }
  if (!policyFile) { console.error("Usage: node scripts/run-frontend-runtime-checks.js --policy <policy.json> [--json]"); return 1; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(policyFile, "utf8")); } catch { console.error("Frontend runtime policy cannot be read or parsed"); return 1; }
  const validated = validateFrontendRuntimePolicy(raw);
  if (!validated.ok || !validated.policy) { console.error(validated.error ?? "Frontend runtime policy is invalid"); return 1; }
  const report = await executeFrontendRuntimeChecks(validated.policy, dependencies);
  console.log(json ? JSON.stringify(report) : formatFrontendRuntimeChecks(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = await main();
