#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pathToFileURL } from "node:url";

const METHODS = new Set(["GET", "HEAD"]);
const RESPONSE_MODES = new Set(["status-only", "json-object"]);
const DEFAULT_MAX_BYTES = 64 * 1024;

/** @typedef {{ mode:"status-only"|"json-object", requiredKeys:string[], maxBytes:number }} ResponsePolicy */
/** @typedef {{ id:string,url:string,method:"GET"|"HEAD",expectedStatuses:number[],timeoutMs:number,response:ResponsePolicy }} SmokeProbe */
/** @typedef {{ version:1,suite:string,probes:SmokeProbe[] }} SmokePolicy */

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
  return lower === "localhost" || lower.endsWith(".localhost") || lower === "127.0.0.1" || lower === "[::1]" || lower === "::1";
}

/** @param {unknown} value */
function safeProbeUrl(value) {
  const raw = text(value, 2048);
  if (!raw) return null;
  let parsed;
  try { parsed = new URL(raw); }
  catch { return null; }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.protocol === "https:") return parsed.toString();
  if (parsed.protocol === "http:" && loopbackHost(parsed.hostname)) return parsed.toString();
  return null;
}

/** @param {unknown} value */
export function validateSyntheticSmokePolicy(value) {
  if (!plainObject(value) || !hasOnly(value, ["version", "suite", "probes"])) {
    return { ok: false, policy: null, error: "synthetic smoke policy contains unsupported fields" };
  }
  if (value.version !== 1) return { ok: false, policy: null, error: "policy version must be exactly 1" };
  const suite = text(value.suite, 128);
  if (!suite) return { ok: false, policy: null, error: "suite must be a bounded non-empty string" };
  if (!Array.isArray(value.probes) || value.probes.length === 0 || value.probes.length > 64) {
    return { ok: false, policy: null, error: "probes must be a non-empty array with at most 64 entries" };
  }

  /** @type {SmokeProbe[]} */
  const probes = [];
  const ids = new Set();
  for (const [index, raw] of value.probes.entries()) {
    if (!plainObject(raw) || !hasOnly(raw, ["id", "url", "method", "expectedStatuses", "timeoutMs", "response"])) {
      return { ok: false, policy: null, error: `probes[${index}] contains unsupported fields` };
    }
    const id = text(raw.id, 128);
    const url = safeProbeUrl(raw.url);
    const method = text(raw.method, 8)?.toUpperCase() ?? null;
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || !url || !method || !METHODS.has(method)) {
      return { ok: false, policy: null, error: `probes[${index}] has invalid id url or method` };
    }
    if (ids.has(id)) return { ok: false, policy: null, error: `duplicate probe id ${id}` };
    ids.add(id);

    if (!Array.isArray(raw.expectedStatuses) || raw.expectedStatuses.length === 0 || raw.expectedStatuses.length > 16 ||
        raw.expectedStatuses.some((status) => !Number.isInteger(status) || Number(status) < 100 || Number(status) > 599)) {
      return { ok: false, policy: null, error: `probes[${index}].expectedStatuses is invalid` };
    }
    const expectedStatuses = raw.expectedStatuses.map(Number);
    if (new Set(expectedStatuses).size !== expectedStatuses.length) return { ok: false, policy: null, error: `probes[${index}] has duplicate expected statuses` };

    if (!Number.isInteger(raw.timeoutMs) || Number(raw.timeoutMs) < 100 || Number(raw.timeoutMs) > 30_000) {
      return { ok: false, policy: null, error: `probes[${index}].timeoutMs must be between 100 and 30000` };
    }

    let response = /** @type {ResponsePolicy} */ ({ mode: "status-only", requiredKeys: [], maxBytes: DEFAULT_MAX_BYTES });
    if (raw.response !== undefined) {
      if (!plainObject(raw.response) || !hasOnly(raw.response, ["mode", "requiredKeys", "maxBytes"])) {
        return { ok: false, policy: null, error: `probes[${index}].response contains unsupported fields` };
      }
      const mode = text(raw.response.mode, 32)?.toLowerCase() ?? null;
      if (!mode || !RESPONSE_MODES.has(mode)) return { ok: false, policy: null, error: `probes[${index}].response.mode is invalid` };
      const requiredRaw = raw.response.requiredKeys === undefined ? [] : raw.response.requiredKeys;
      if (!Array.isArray(requiredRaw) || requiredRaw.length > 32) return { ok: false, policy: null, error: `probes[${index}].response.requiredKeys is invalid` };
      const requiredKeys = requiredRaw.map((item) => text(item, 128));
      if (requiredKeys.some((item) => !item) || new Set(requiredKeys).size !== requiredKeys.length) return { ok: false, policy: null, error: `probes[${index}].response.requiredKeys must be unique bounded strings` };
      if (mode === "status-only" && requiredKeys.length > 0) return { ok: false, policy: null, error: `probes[${index}] status-only response cannot require JSON keys` };
      if (method === "HEAD" && mode === "json-object") return { ok: false, policy: null, error: `probes[${index}] HEAD probes cannot require a JSON body` };
      const maxBytes = raw.response.maxBytes === undefined ? DEFAULT_MAX_BYTES : Number(raw.response.maxBytes);
      if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) return { ok: false, policy: null, error: `probes[${index}].response.maxBytes is invalid` };
      response = { mode: /** @type {"status-only"|"json-object"} */ (mode), requiredKeys: /** @type {string[]} */ (requiredKeys), maxBytes };
    }
    probes.push({ id, url, method: /** @type {"GET"|"HEAD"} */ (method), expectedStatuses: expectedStatuses.sort((a, b) => a - b), timeoutMs: Number(raw.timeoutMs), response });
  }
  probes.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, policy: /** @type {SmokePolicy} */ ({ version: 1, suite, probes }), error: null };
}

/** @param {SmokeProbe} probe */
function requestProbe(probe) {
  return new Promise((resolve) => {
    const target = new URL(probe.url);
    const transport = target.protocol === "https:" ? https : http;
    let settled = false;
    /** @param {unknown} value */
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = transport.request(target, {
      method: probe.method,
      headers: {
        accept: probe.response.mode === "json-object" ? "application/json" : "*/*",
        "user-agent": "production-webapp-toolkit-smoke/1",
      },
      timeout: probe.timeoutMs,
    }, (response) => {
      const statusCode = response.statusCode ?? 0;
      const contentType = typeof response.headers["content-type"] === "string" ? response.headers["content-type"] : "";
      if (probe.method === "HEAD" || probe.response.mode === "status-only") {
        finish({ ok: true, statusCode, contentType, json: null });
        response.destroy();
        return;
      }
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > probe.response.maxBytes) {
          finish({ ok: false, error: "response-too-large" });
          response.destroy();
        } else {
          chunks.push(chunk);
        }
      });
      response.on("end", () => {
        if (settled) return;
        if (!/(?:^|[+/])json(?:;|$)/i.test(contentType)) {
          finish({ ok: false, error: "response-not-json" });
          return;
        }
        let json;
        try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { finish({ ok: false, error: "response-invalid-json" }); return; }
        if (!plainObject(json)) { finish({ ok: false, error: "response-json-not-object" }); return; }
        finish({ ok: true, statusCode, contentType, json });
      });
      response.on("error", () => finish({ ok: false, error: "response-error" }));
    });
    request.on("timeout", () => { finish({ ok: false, error: "request-timeout" }); request.destroy(); });
    request.on("error", () => finish({ ok: false, error: "request-error" }));
    request.end();
  });
}

/** @param {SmokePolicy} policy @param {{runProbe?:typeof requestProbe, now?:()=>string}} [dependencies] */
export async function executeSyntheticSmoke(policy, dependencies = {}) {
  const runner = dependencies.runProbe ?? requestProbe;
  const results = [];
  for (const probe of policy.probes) {
    const observed = await runner(probe);
    if (!plainObject(observed) || observed.ok !== true) {
      results.push({ id: probe.id, status: "FAIL", method: probe.method, url: probe.url, detail: "probe request failed within the non-destructive boundary" });
      continue;
    }
    const statusCode = Number(observed.statusCode);
    if (!Number.isInteger(statusCode) || !probe.expectedStatuses.includes(statusCode)) {
      results.push({ id: probe.id, status: "FAIL", method: probe.method, url: probe.url, detail: `HTTP status ${Number.isInteger(statusCode) ? statusCode : "unknown"} is outside expected set` });
      continue;
    }
    if (probe.response.mode === "json-object") {
      if (!plainObject(observed.json)) {
        results.push({ id: probe.id, status: "FAIL", method: probe.method, url: probe.url, detail: "response did not satisfy bounded JSON object requirement" });
        continue;
      }
      const jsonObject = /** @type {Record<string, unknown>} */ (observed.json);
      const missing = probe.response.requiredKeys.filter((key) => !(key in jsonObject));
      if (missing.length > 0) {
        results.push({ id: probe.id, status: "FAIL", method: probe.method, url: probe.url, detail: `response is missing required JSON keys: ${missing.join(", ")}` });
        continue;
      }
    }
    results.push({ id: probe.id, status: "PASS", method: probe.method, url: probe.url, detail: `HTTP status ${statusCode} satisfied explicit smoke policy` });
  }
  const collectedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  const pass = results.filter((result) => result.status === "PASS").length;
  const fail = results.length - pass;
  return {
    version: 1,
    suite: policy.suite,
    collectedAt,
    boundaries: { methods: ["GET", "HEAD"], redirectsFollowed: false, credentialsAccepted: false, requestBodiesSent: false },
    results,
    summary: { pass, fail },
    technicalStatus: "PASS",
    overallStatus: fail > 0 ? "FAIL" : "PASS",
  };
}

/** @param {Awaited<ReturnType<typeof executeSyntheticSmoke>>} report */
export function formatSyntheticSmoke(report) {
  const lines = [
    "Synthetic production smoke tests", "",
    `Suite: ${report.suite}`,
    `Collected at: ${report.collectedAt}`,
    "Boundary: GET/HEAD only; no redirects; no credentials; no request bodies", "",
  ];
  for (const result of report.results) lines.push(`${result.status.padEnd(4)}  ${result.id}  ${result.method}  ${result.url}  ${result.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv @param {{runProbe?:typeof requestProbe, now?:()=>string}} [dependencies] */
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  let policyFile = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--policy" || policyFile !== null) { console.error("Usage: node scripts/run-synthetic-smoke-tests.js --policy <policy.json> [--json]"); return 1; }
    const candidate = argv[index + 1];
    if (typeof candidate !== "string" || candidate.startsWith("--") || candidate.length === 0) { console.error("Usage: node scripts/run-synthetic-smoke-tests.js --policy <policy.json> [--json]"); return 1; }
    policyFile = candidate;
    index += 1;
  }
  if (!policyFile) { console.error("Usage: node scripts/run-synthetic-smoke-tests.js --policy <policy.json> [--json]"); return 1; }
  let raw;
  try { raw = JSON.parse(fs.readFileSync(policyFile, "utf8")); }
  catch { console.error("Synthetic smoke policy cannot be read or parsed"); return 1; }
  const validated = validateSyntheticSmokePolicy(raw);
  if (!validated.ok || !validated.policy) { console.error(validated.error ?? "Synthetic smoke policy is invalid"); return 1; }
  const report = await executeSyntheticSmoke(validated.policy, dependencies);
  console.log(json ? JSON.stringify(report) : formatSyntheticSmoke(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = await main();
