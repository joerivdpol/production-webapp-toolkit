#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_AUXILIARY_BYTES = 1_048_576;
const MAX_LINKS = 500;
const MAX_SITEMAPS = 32;

/** @typedef {{required:boolean,minLength:number,maxLength:number}} TextBudget */
/** @typedef {{id:string,url:string,expectedStatuses:number[],timeoutMs:number,title:TextBudget,description:TextBudget,expectedCanonical:string|null,allowNoindex:boolean,requiredHreflang:string[],requiredStructuredDataTypes:string[],checkInternalLinks:boolean,maxInternalLinks:number}} SeoRoute */
/** @typedef {{robotsUrl:string,sitemapUrl:string,requireSitemapDeclaration:boolean,requireRoutesInSitemap:boolean,maxSitemaps:number,timeoutMs:number}|null} SitePolicy */
/** @typedef {{version:1,suite:string,site:SitePolicy,routes:SeoRoute[]}} SeoPolicy */

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
/** @param {unknown} value @param {{allowQuery?:boolean,allowFragment?:boolean}} [options] */
function safeUrl(value, options = {}) {
  const raw = text(value, 2048);
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); } catch { return null; }
  if (parsed.username || parsed.password) return null;
  if (!options.allowQuery && parsed.search) return null;
  if (!options.allowFragment && parsed.hash) return null;
  if (parsed.protocol === "https:" || (parsed.protocol === "http:" && loopbackHost(parsed.hostname))) return parsed.toString();
  return null;
}
/** @param {unknown} value @param {number} min @param {number} max */
function boundedInteger(value, min, max) {
  return Number.isInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}
/** @param {unknown} value @param {string} scope */
function validateTextBudget(value, scope) {
  if (!plainObject(value) || !hasOnly(value, ["required", "minLength", "maxLength"]) || typeof value.required !== "boolean") return { ok: false, value: null, error: `${scope} is invalid` };
  const minLength = boundedInteger(value.minLength, 0, 10_000);
  const maxLength = boundedInteger(value.maxLength, 1, 10_000);
  if (minLength === null || maxLength === null || minLength > maxLength) return { ok: false, value: null, error: `${scope} length bounds are invalid` };
  return { ok: true, value: /** @type {TextBudget} */ ({ required: value.required, minLength, maxLength }), error: null };
}
/** @param {unknown} value @param {string} scope @param {number} maxItems */
function stringList(value, scope, maxItems) {
  if (!Array.isArray(value) || value.length > maxItems) return { ok: false, values: null, error: `${scope} must be a bounded array` };
  const values = value.map((item) => text(item, 128));
  if (values.some((item) => !item) || new Set(values).size !== values.length) return { ok: false, values: null, error: `${scope} contains invalid or duplicate values` };
  return { ok: true, values: /** @type {string[]} */ (values).sort(), error: null };
}

/** @param {unknown} value */
export function validateSeoPolicy(value) {
  if (!plainObject(value) || !hasOnly(value, ["version", "suite", "site", "routes"])) return { ok: false, policy: null, error: "SEO policy contains unsupported fields" };
  if (value.version !== 1) return { ok: false, policy: null, error: "policy version must be exactly 1" };
  const suite = text(value.suite, 128);
  if (!suite) return { ok: false, policy: null, error: "suite must be a bounded non-empty string" };

  /** @type {SitePolicy} */
  let site = null;
  if (value.site !== null && value.site !== undefined) {
    if (!plainObject(value.site) || !hasOnly(value.site, ["robotsUrl", "sitemapUrl", "requireSitemapDeclaration", "requireRoutesInSitemap", "maxSitemaps", "timeoutMs"])) return { ok: false, policy: null, error: "site policy contains unsupported fields" };
    const robotsUrl = safeUrl(value.site.robotsUrl);
    const sitemapUrl = safeUrl(value.site.sitemapUrl);
    const timeoutMs = boundedInteger(value.site.timeoutMs, 100, 30_000);
    const maxSitemaps = boundedInteger(value.site.maxSitemaps, 1, MAX_SITEMAPS);
    if (!robotsUrl || !sitemapUrl || new URL(robotsUrl).origin !== new URL(sitemapUrl).origin || typeof value.site.requireSitemapDeclaration !== "boolean" || typeof value.site.requireRoutesInSitemap !== "boolean" || timeoutMs === null || maxSitemaps === null) return { ok: false, policy: null, error: "site policy is invalid" };
    site = { robotsUrl, sitemapUrl, requireSitemapDeclaration: value.site.requireSitemapDeclaration, requireRoutesInSitemap: value.site.requireRoutesInSitemap, maxSitemaps, timeoutMs };
  }

  if (!Array.isArray(value.routes) || value.routes.length === 0 || value.routes.length > 64) return { ok: false, policy: null, error: "routes must be a non-empty bounded array" };
  /** @type {SeoRoute[]} */
  const routes = [];
  const ids = new Set();
  let routeOrigin = null;
  for (const [index, raw] of value.routes.entries()) {
    if (!plainObject(raw) || !hasOnly(raw, ["id", "url", "expectedStatuses", "timeoutMs", "title", "description", "expectedCanonical", "allowNoindex", "requiredHreflang", "requiredStructuredDataTypes", "checkInternalLinks", "maxInternalLinks"])) return { ok: false, policy: null, error: `routes[${index}] contains unsupported fields` };
    const id = text(raw.id, 128);
    const url = safeUrl(raw.url);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || ids.has(id) || !url) return { ok: false, policy: null, error: `routes[${index}] has invalid id or url` };
    ids.add(id);
    const currentOrigin = new URL(url).origin;
    routeOrigin ??= currentOrigin;
    if (currentOrigin !== routeOrigin) return { ok: false, policy: null, error: "all configured SEO routes must share one origin" };
    if (site && currentOrigin !== new URL(site.robotsUrl).origin) return { ok: false, policy: null, error: "site and route origins must match" };
    if (!Array.isArray(raw.expectedStatuses) || raw.expectedStatuses.length === 0 || raw.expectedStatuses.length > 16 || raw.expectedStatuses.some((status) => !Number.isInteger(status) || Number(status) < 100 || Number(status) > 599)) return { ok: false, policy: null, error: `routes[${index}].expectedStatuses is invalid` };
    const expectedStatuses = raw.expectedStatuses.map(Number);
    if (new Set(expectedStatuses).size !== expectedStatuses.length) return { ok: false, policy: null, error: `routes[${index}] has duplicate expected statuses` };
    const timeoutMs = boundedInteger(raw.timeoutMs, 100, 30_000);
    if (timeoutMs === null) return { ok: false, policy: null, error: `routes[${index}].timeoutMs is invalid` };
    const title = validateTextBudget(raw.title, `routes[${index}].title`);
    const description = validateTextBudget(raw.description, `routes[${index}].description`);
    if (!title.ok || !title.value) return { ok: false, policy: null, error: title.error };
    if (!description.ok || !description.value) return { ok: false, policy: null, error: description.error };
    let expectedCanonical = null;
    if (raw.expectedCanonical !== null) {
      expectedCanonical = safeUrl(raw.expectedCanonical, { allowQuery: true });
      if (!expectedCanonical || new URL(expectedCanonical).origin !== currentOrigin) return { ok: false, policy: null, error: `routes[${index}].expectedCanonical is invalid` };
    }
    if (typeof raw.allowNoindex !== "boolean" || typeof raw.checkInternalLinks !== "boolean") return { ok: false, policy: null, error: `routes[${index}] boolean controls are invalid` };
    const maxInternalLinks = boundedInteger(raw.maxInternalLinks, 0, MAX_LINKS);
    if (maxInternalLinks === null || (raw.checkInternalLinks && maxInternalLinks === 0)) return { ok: false, policy: null, error: `routes[${index}].maxInternalLinks is invalid` };
    const hreflang = stringList(raw.requiredHreflang, `routes[${index}].requiredHreflang`, 64);
    const structured = stringList(raw.requiredStructuredDataTypes, `routes[${index}].requiredStructuredDataTypes`, 64);
    if (!hreflang.ok || !hreflang.values) return { ok: false, policy: null, error: hreflang.error };
    if (!structured.ok || !structured.values) return { ok: false, policy: null, error: structured.error };
    if (hreflang.values.some((item) => !/^(?:x-default|[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*)$/.test(item))) return { ok: false, policy: null, error: `routes[${index}].requiredHreflang contains invalid language tags` };
    routes.push({ id, url, expectedStatuses: expectedStatuses.sort((a, b) => a - b), timeoutMs, title: title.value, description: description.value, expectedCanonical, allowNoindex: raw.allowNoindex, requiredHreflang: hreflang.values, requiredStructuredDataTypes: structured.values, checkInternalLinks: raw.checkInternalLinks, maxInternalLinks });
  }
  routes.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, policy: /** @type {SeoPolicy} */ ({ version: 1, suite, site, routes }), error: null };
}

/** @param {unknown} value @param {Set<string>} output */
function collectJsonLdTypes(value, output) {
  if (Array.isArray(value)) { for (const item of value) collectJsonLdTypes(item, output); return; }
  if (!plainObject(value)) return;
  const rawType = value["@type"];
  const types = Array.isArray(rawType) ? rawType : [rawType];
  for (const item of types) if (typeof item === "string" && item.trim() && item.length <= 128) output.add(item.trim());
  if (value["@graph"] !== undefined) collectJsonLdTypes(value["@graph"], output);
}

/** @param {SeoRoute} route */
async function observePageWithPlaywright(route) {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ serviceWorkers: "block", ignoreHTTPSErrors: false });
    const page = await context.newPage();
    const origin = new URL(route.url).origin;
    let blockedMutations = 0;
    await page.route("**/*", async (intercept) => {
      const request = intercept.request();
      const method = request.method().toUpperCase();
      if (!READ_METHODS.has(method)) { blockedMutations += 1; await intercept.abort("blockedbyclient"); return; }
      if (request.isNavigationRequest() && new URL(request.url()).origin !== origin) { await intercept.abort("blockedbyclient"); return; }
      await intercept.continue();
    });    try {
      const response = await page.goto(route.url, { waitUntil: "domcontentloaded", timeout: route.timeoutMs });
      const statusCode = response?.status() ?? 0;
      const xRobotsTag = response?.headers()["x-robots-tag"] ?? "";
      await page.waitForLoadState("load", { timeout: Math.min(route.timeoutMs, 5000) }).catch(() => {});
      const observation = await page.evaluate((pageOrigin) => {
        const titles = [...document.querySelectorAll("title")];
        const descriptions = [...document.querySelectorAll('meta[name="description" i]')];
        const canonicals = [...document.querySelectorAll('link[rel~="canonical" i]')];
        const robots = [...document.querySelectorAll('meta[name="robots" i], meta[name="googlebot" i]')];
        const alternates = [...document.querySelectorAll('link[rel~="alternate" i][hreflang]')];
        const jsonLd = [...document.querySelectorAll('script[type="application/ld+json" i]')];
        const links = new Set();
        for (const node of document.querySelectorAll("a[href]")) {
          const href = node.getAttribute("href");
          if (!href || href.startsWith("#") || /^(?:mailto|tel|javascript|data):/i.test(href)) continue;
          try {
            const parsed = new URL(href, document.baseURI);
            parsed.hash = "";
            if (parsed.origin === pageOrigin && (parsed.protocol === "https:" || parsed.protocol === "http:")) links.add(parsed.toString());
          } catch {}
        }
        return {
          titleCount: titles.length,
          title: document.title,
          descriptionCount: descriptions.length,
          description: descriptions[0]?.getAttribute("content") ?? "",
          canonicals: canonicals.map((node) => new URL(node.getAttribute("href") ?? "", document.baseURI).toString()),
          robots: robots.map((node) => node.getAttribute("content") ?? ""),
          hreflang: alternates.map((node) => ({ lang: node.getAttribute("hreflang") ?? "", href: new URL(node.getAttribute("href") ?? "", document.baseURI).toString() })), jsonLd: jsonLd.map((node) => node.textContent ?? ""),
          internalLinks: [...links].sort(),
        };
      }, origin);
      const structuredTypes = new Set();
      let malformedJsonLd = 0;
      if (!Array.isArray(observation.jsonLd) || observation.jsonLd.length > 128) return { ok: false, error: "seo-observation-invalid" };
      for (const raw of observation.jsonLd) {
        if (typeof raw !== "string" || raw.length > MAX_AUXILIARY_BYTES) return { ok: false, error: "seo-observation-invalid" };
        try { collectJsonLdTypes(JSON.parse(raw), structuredTypes); }
        catch { malformedJsonLd += 1; }
      }
      return {
        ok: true,
        observation: {
          titleCount: observation.titleCount,
          title: observation.title,
          descriptionCount: observation.descriptionCount,
          description: observation.description,
          canonicals: observation.canonicals,
          robots: observation.robots,
          hreflang: observation.hreflang,
          structuredTypes: [...structuredTypes].sort(),
          malformedJsonLd,
          internalLinks: observation.internalLinks,
          statusCode,
          xRobotsTag,
          blockedMutations,
        },
      };
    } catch { return { ok: false, error: "seo-route-failed" }; } finally { await context.close(); }
  } finally { await browser.close(); }
}

/** @param {string} url @param {number} timeoutMs */
async function fetchTextBounded(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method: "GET", redirect: "manual", credentials: "omit", signal: controller.signal });
    if (response.status >= 300 && response.status < 400) return { ok: false, statusCode: response.status, body: "", error: "redirect-not-followed" };
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_AUXILIARY_BYTES) return { ok: false, statusCode: response.status, body: "", error: "response-too-large" };
    return { ok: true, statusCode: response.status, body };
  } catch { return { ok: false, statusCode: 0, body: "", error: "request-failed" }; }
  finally { clearTimeout(timer); }
}

/** @param {string} url @param {number} timeoutMs */
async function inspectInternalLink(url, timeoutMs) {
  const result = await fetchTextBounded(url, timeoutMs);
  return { ok: result.ok, statusCode: result.statusCode };
}

/** @param {string} value */
function decodeXml(value) {
  return value.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
/** @param {string} xml */function sitemapLocations(xml) {
  const values = [];
  for (const match of xml.matchAll(/<loc(?:\s[^>]*)?>\s*([^<]+?)\s*<\/loc>/gi)) {
    const candidate = decodeXml(match[1] ?? "").trim();
    if (candidate) values.push(candidate);
    if (values.length > 100_000) throw new Error("sitemap contains too many locations");
  }
  return values;
}
/** @param {string} robots */
function robotsSitemaps(robots) {
  const values = [];
  for (const line of robots.split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S+)\s*$/i.exec(line);
    if (match?.[1]) values.push(match[1]);
  }
  return values;
}
/** @param {string[]} values */
function hasNoindex(values) {
  return values.some((value) => typeof value === "string" && /(?:^|[\s,])noindex(?:$|[\s,])/i.test(value));
}
/** @param {string} value @param {TextBudget} budget @param {string} label @param {number} count */
function textBudgetFindings(value, budget, label, count) {
  const findings = [];
  const normalized = typeof value === "string" ? value.trim() : "";
  if (count > 1) findings.push(`duplicate-${label}`);
  if (budget.required && (!normalized || count !== 1)) findings.push(`missing-${label}`);
  if (normalized && (normalized.length < budget.minLength || normalized.length > budget.maxLength)) findings.push(`${label}-length-out-of-budget`);
  return findings;
}
/** @param {NonNullable<SitePolicy>} site @param {SeoRoute[]} routes @param {{fetchText?:typeof fetchTextBounded}} dependencies */
async function inspectSite(site, routes, dependencies) {
  const fetchText = dependencies.fetchText ?? fetchTextBounded;
  const findings = [];
  const robots = await fetchText(site.robotsUrl, site.timeoutMs);
  if (!plainObject(robots) || robots.ok !== true || robots.statusCode !== 200 || typeof robots.body !== "string") {
    findings.push("robots-unavailable");
  } else if (site.requireSitemapDeclaration) {
    const declared = robotsSitemaps(robots.body).map((item) => safeUrl(item, { allowQuery: true })).filter(Boolean);
    if (!declared.includes(site.sitemapUrl)) findings.push("sitemap-not-declared-in-robots");
  }

  const origin = new URL(site.sitemapUrl).origin;
  const queue = [site.sitemapUrl];
  const visited = new Set();
  const indexed = new Set();
  let invalid = false;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || visited.has(current)) continue;
    if (visited.size >= site.maxSitemaps) { findings.push("sitemap-limit-exceeded"); break; }
    visited.add(current);
    const sitemap = await fetchText(current, site.timeoutMs);
    if (!plainObject(sitemap) || sitemap.ok !== true || sitemap.statusCode !== 200 || typeof sitemap.body !== "string") {
      invalid = true;
      continue;
    }    let locations;
    try { locations = sitemapLocations(sitemap.body); }
    catch { invalid = true; continue; }
    const isIndex = /<sitemapindex\b/i.test(sitemap.body);
    for (const location of locations) {
      const normalized = safeUrl(location, { allowQuery: true });
      if (!normalized || new URL(normalized).origin !== origin) { invalid = true; continue; }
      if (isIndex) queue.push(normalized);
      else indexed.add(normalized);
    }
  }
  if (invalid) findings.push("sitemap-unavailable-or-invalid");
  if (site.requireRoutesInSitemap) {
    for (const route of routes) if (!indexed.has(route.url)) findings.push(`route-missing-from-sitemap:${route.id}`);
  }
  return {
    status: findings.length > 0 ? "FAIL" : "PASS",
    findings: [...new Set(findings)].sort(),
    robotsUrl: site.robotsUrl,
    sitemapUrl: site.sitemapUrl,
    sitemapsInspected: visited.size,
    indexedUrls: indexed.size,
  };
}
/** @param {SeoPolicy} policy @param {{observePage?:typeof observePageWithPlaywright,inspectLink?:typeof inspectInternalLink,fetchText?:typeof fetchTextBounded,now?:()=>string}} [dependencies] */
export async function executeSeoProductionChecks(policy, dependencies = {}) {
  const observePage = dependencies.observePage ?? observePageWithPlaywright;
  const inspectLink = dependencies.inspectLink ?? inspectInternalLink;
  const results = [];
  for (const route of policy.routes) {
    const observed = await observePage(route);
    if (!plainObject(observed) || observed.ok !== true || !plainObject(observed.observation)) {
      results.push({ id: route.id, url: route.url, status: "FAIL", findings: ["seo-route-failed"], internalLinks: { checked: 0, broken: 0 } });
      continue;
    }
    const raw = observed.observation;
    const arraysValid = Array.isArray(raw.canonicals) && Array.isArray(raw.robots) && Array.isArray(raw.hreflang) && Array.isArray(raw.structuredTypes) && Array.isArray(raw.internalLinks);
    if (!arraysValid || !Number.isInteger(raw.statusCode) || Number(raw.statusCode) < 100 || Number(raw.statusCode) > 599 || !Number.isInteger(raw.titleCount) || !Number.isInteger(raw.descriptionCount) || !Number.isInteger(raw.malformedJsonLd) || !Number.isInteger(raw.blockedMutations)) {
      results.push({ id: route.id, url: route.url, status: "FAIL", findings: ["seo-observation-invalid"], internalLinks: { checked: 0, broken: 0 } });
      continue;
    }
    const findings = [];
    if (!route.expectedStatuses.includes(Number(raw.statusCode))) findings.push("unexpected-route-status");
    if (Number(raw.blockedMutations) > 0) findings.push("blocked-mutation-attempts");
    findings.push(...textBudgetFindings(typeof raw.title === "string" ? raw.title : "", route.title, "title", Number(raw.titleCount)));
    findings.push(...textBudgetFindings(typeof raw.description === "string" ? raw.description : "", route.description, "description", Number(raw.descriptionCount)));

    const canonicals = raw.canonicals.filter((item) => typeof item === "string");
    if (canonicals.length !== raw.canonicals.length || canonicals.length > 8) findings.push("canonical-observation-invalid");
    if (route.expectedCanonical !== null) {
      if (canonicals.length !== 1) findings.push(canonicals.length === 0 ? "missing-canonical" : "duplicate-canonical");
      else if (canonicals[0] !== route.expectedCanonical) findings.push("canonical-mismatch");
    }    if (!route.allowNoindex && (hasNoindex(raw.robots) || hasNoindex([typeof raw.xRobotsTag === "string" ? raw.xRobotsTag : ""]))) findings.push("unexpected-noindex");

    const languages = new Set();
    let hreflangInvalid = false;
    for (const entry of raw.hreflang) {
      if (!plainObject(entry) || typeof entry.lang !== "string" || typeof entry.href !== "string") { hreflangInvalid = true; break; }
      const key = entry.lang.trim().toLowerCase();
      if (!key || languages.has(key)) { hreflangInvalid = true; break; }
      languages.add(key);
    }
    if (hreflangInvalid) findings.push("hreflang-observation-invalid");
    for (const language of route.requiredHreflang) if (!languages.has(language.toLowerCase())) findings.push(`missing-hreflang:${language}`);

    const types = raw.structuredTypes.filter((item) => typeof item === "string");
    if (types.length !== raw.structuredTypes.length) findings.push("structured-data-observation-invalid");
    if (Number(raw.malformedJsonLd) > 0) findings.push("malformed-structured-data");
    for (const type of route.requiredStructuredDataTypes) if (!types.includes(type)) findings.push(`missing-structured-data:${type}`);

    let checked = 0, broken = 0;
    if (route.checkInternalLinks) {
      const links = raw.internalLinks.filter((item) => typeof item === "string");
      if (links.length !== raw.internalLinks.length || links.length > route.maxInternalLinks) findings.push("internal-link-limit-exceeded");
      else {
        for (const link of links) {
          const normalized = safeUrl(link, { allowQuery: true });
          if (!normalized || new URL(normalized).origin !== new URL(route.url).origin) { findings.push("internal-link-observation-invalid"); continue; }
          const inspection = await inspectLink(normalized, route.timeoutMs);
          checked += 1;
          if (!plainObject(inspection) || inspection.ok !== true || !Number.isInteger(inspection.statusCode) || Number(inspection.statusCode) < 200 || Number(inspection.statusCode) >= 400) broken += 1;
        }
        if (broken > 0) findings.push("broken-internal-links");
      }
    }
    results.push({ id: route.id, url: route.url, status: findings.length > 0 ? "FAIL" : "PASS", findings: [...new Set(findings)].sort(), internalLinks: { checked, broken } });
  }
  const site = policy.site ? await inspectSite(policy.site, policy.routes, dependencies.fetchText ? { fetchText: dependencies.fetchText } : {}) : null;
  const collectedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  if (!isAbsoluteIsoTimestamp(collectedAt)) throw new Error("SEO collection clock must return an absolute ISO timestamp");
  const pass = results.filter((result) => result.status === "PASS").length;
  const fail = results.length - pass;
  return {
    version: 1,
    suite: policy.suite,
    collectedAt,
    boundary: {
      allowedRequestMethods: ["GET", "HEAD", "OPTIONS"],
      crossOriginNavigationBlocked: true,
      serviceWorkersBlocked: true,
      credentialsConfigured: false,
      auxiliaryRedirectsFollowed: false,
    },
    site,
    results,
    summary: { pass, fail },
    technicalStatus: "PASS",
    overallStatus: fail > 0 || site?.status === "FAIL" ? "FAIL" : "PASS",
  };
}

/** @param {Awaited<ReturnType<typeof executeSeoProductionChecks>>} report */
export function formatSeoProductionChecks(report) {  const lines = [
    "SEO production checks",
    "",
    `Suite: ${report.suite}`,
    `Collected at: ${report.collectedAt}`,
    "Boundary: GET/HEAD/OPTIONS only; mutation methods and cross-origin navigation blocked; no configured credentials; auxiliary redirects are not followed",
    "",
  ];
  if (report.site) {
    lines.push(`${report.site.status.padEnd(4)}  site  ${report.site.findings.length ? report.site.findings.join(", ") : "robots and sitemap checks passed"}`);
  }
  for (const result of report.results) {
    lines.push(`${result.status.padEnd(4)}  ${result.id}  ${result.url}${result.findings.length ? `  ${result.findings.join(", ")}` : ""}  links=${result.internalLinks.checked}/${result.internalLinks.broken}`);
  }
  lines.push(
    "",
    `Routes: ${report.summary.pass} pass, ${report.summary.fail} fail`,
    `Technical: ${report.technicalStatus}`,
    `Overall: ${report.overallStatus}`,
  );
  return lines.join("\n");
}

/** @param {string[]} argv @param {{observePage?:typeof observePageWithPlaywright,inspectLink?:typeof inspectInternalLink,fetchText?:typeof fetchTextBounded,now?:()=>string}} [dependencies] */
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  let policyFile = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--policy" || policyFile !== null) {
      console.error("Usage: node scripts/run-seo-production-checks.js --policy <policy.json> [--json]");
      return 1;
    }    const candidate = argv[index + 1];
    if (typeof candidate !== "string" || candidate.startsWith("--") || candidate.length === 0) {
      console.error("Usage: node scripts/run-seo-production-checks.js --policy <policy.json> [--json]");
      return 1;
    }
    policyFile = candidate;
    index += 1;
  }
  if (!policyFile) {
    console.error("Usage: node scripts/run-seo-production-checks.js --policy <policy.json> [--json]");
    return 1;
  }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(policyFile, "utf8")); }
  catch { console.error("SEO policy cannot be read or parsed"); return 1; }
  const validated = validateSeoPolicy(raw);
  if (!validated.ok || !validated.policy) {
    console.error(validated.error ?? "SEO policy is invalid");
    return 1;
  }
  const report = await executeSeoProductionChecks(validated.policy, dependencies);
  console.log(json ? JSON.stringify(report) : formatSeoProductionChecks(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = await main();
}
