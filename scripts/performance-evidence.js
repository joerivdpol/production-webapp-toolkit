#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

/** @typedef {{id:string,lcpMs?:number,cls?:number,inpMs?:number}} PerformanceRoute */
/** @typedef {{version:1,artifact:{commit:string,totalBytes:number,jsBytes:number,cssBytes:number},source:{name:string,authenticated:boolean,collectedAt:string},routes:PerformanceRoute[]}} PerformanceEvidence */

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
/** @param {unknown} value @param {number} maximum */
function boundedInteger(value, maximum) {
  return Number.isInteger(value) && Number(value) >= 0 && Number(value) <= maximum ? Number(value) : null;
}
/** @param {unknown} value @param {number} maximum */
function boundedNumber(value, maximum) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= maximum ? value : null;
}

/** @param {unknown} value */
export function validatePerformanceEvidence(value) {
  if (!plainObject(value) || !hasOnly(value, ["version", "artifact", "source", "routes"])) return { ok: false, evidence: null, error: "performance evidence contains unsupported fields" };
  if (value.version !== 1) return { ok: false, evidence: null, error: "version must be exactly 1" };

  if (!plainObject(value.artifact) || !hasOnly(value.artifact, ["commit", "totalBytes", "jsBytes", "cssBytes"])) return { ok: false, evidence: null, error: "artifact must contain only commit and bundle byte counts" };
  const commitRaw = text(value.artifact.commit, 64);
  if (!commitRaw || !isFullObjectId(commitRaw)) return { ok: false, evidence: null, error: "artifact.commit must be a full Git object id" };
  const totalBytes = boundedInteger(value.artifact.totalBytes, 1_000_000_000_000);
  const jsBytes = boundedInteger(value.artifact.jsBytes, 1_000_000_000_000);
  const cssBytes = boundedInteger(value.artifact.cssBytes, 1_000_000_000_000);
  if (totalBytes === null || jsBytes === null || cssBytes === null || jsBytes + cssBytes > totalBytes) return { ok: false, evidence: null, error: "artifact byte counts are invalid or inconsistent" };

  if (!plainObject(value.source) || !hasOnly(value.source, ["name", "authenticated", "collectedAt"])) return { ok: false, evidence: null, error: "source must contain only name authenticated and collectedAt" };
  const sourceName = text(value.source.name, 128);
  const collectedAt = text(value.source.collectedAt, 64);
  if (!sourceName || typeof value.source.authenticated !== "boolean" || !collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) return { ok: false, evidence: null, error: "source evidence metadata is invalid" };

  if (!Array.isArray(value.routes) || value.routes.length === 0 || value.routes.length > 128) return { ok: false, evidence: null, error: "routes must be a non-empty bounded array" };
  /** @type {PerformanceRoute[]} */
  const routes = [];
  const ids = new Set();
  for (const [index, raw] of value.routes.entries()) {
    if (!plainObject(raw) || !hasOnly(raw, ["id", "lcpMs", "cls", "inpMs"])) return { ok: false, evidence: null, error: `routes[${index}] contains unsupported fields` };
    const id = text(raw.id, 128);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || ids.has(id)) return { ok: false, evidence: null, error: `routes[${index}].id is invalid or duplicate` };
    ids.add(id);
    const route = /** @type {PerformanceRoute} */ ({ id });
    if (raw.lcpMs !== undefined) {
      const metric = boundedNumber(raw.lcpMs, 600_000);
      if (metric === null) return { ok: false, evidence: null, error: `routes[${index}].lcpMs is invalid` };
      route.lcpMs = metric;
    }
    if (raw.cls !== undefined) {
      const metric = boundedNumber(raw.cls, 100);
      if (metric === null) return { ok: false, evidence: null, error: `routes[${index}].cls is invalid` };
      route.cls = metric;
    }
    if (raw.inpMs !== undefined) {
      const metric = boundedNumber(raw.inpMs, 600_000);
      if (metric === null) return { ok: false, evidence: null, error: `routes[${index}].inpMs is invalid` };
      route.inpMs = metric;
    }
    if (route.lcpMs === undefined && route.cls === undefined && route.inpMs === undefined) return { ok: false, evidence: null, error: `routes[${index}] must include at least one measured metric` };
    routes.push(route);
  }
  routes.sort((a, b) => a.id.localeCompare(b.id));
  return {
    ok: true,
    evidence: /** @type {PerformanceEvidence} */ ({
      version: 1,
      artifact: { commit: commitRaw.toLowerCase(), totalBytes, jsBytes, cssBytes },
      source: { name: sourceName, authenticated: value.source.authenticated, collectedAt },
      routes,
    }),
    error: null,
  };
}

/** @param {PerformanceEvidence} evidence */
export function formatPerformanceEvidence(evidence) {
  return [
    "Performance Evidence v1",
    "",
    `Commit: ${evidence.artifact.commit}`,
    `Bundle: total=${evidence.artifact.totalBytes} js=${evidence.artifact.jsBytes} css=${evidence.artifact.cssBytes}`,
    `Source: ${evidence.source.name}`,
    `Authenticated: ${evidence.source.authenticated}`,
    `Collected at: ${evidence.source.collectedAt}`,
    `Routes: ${evidence.routes.length}`,
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  let file = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--file" || file !== null) { console.error("Usage: node scripts/performance-evidence.js --file <performance.json> [--json]"); return 1; }
    const candidate = argv[index + 1];
    if (typeof candidate !== "string" || candidate.startsWith("--") || candidate.length === 0) { console.error("Usage: node scripts/performance-evidence.js --file <performance.json> [--json]"); return 1; }
    file = candidate; index += 1;
  }
  if (!file) { console.error("Usage: node scripts/performance-evidence.js --file <performance.json> [--json]"); return 1; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { console.error("Performance evidence file cannot be read or parsed"); return 1; }
  const validated = validatePerformanceEvidence(raw);
  if (!validated.ok || !validated.evidence) { console.error(validated.error ?? "Performance evidence is invalid"); return 1; }
  console.log(json ? JSON.stringify(validated.evidence) : formatPerformanceEvidence(validated.evidence));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
