#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { adaptRuntimeCollectorObservation } from "./runtime-collector-adapter.js";
import { isAbsoluteIsoTimestamp, validateRuntimeEvidence } from "./runtime-evidence.js";

const MAX_INPUT_BYTES = 64 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {string} hostname */
function loopbackHost(hostname) {
  const value = hostname.toLowerCase();
  return value === "localhost" || value === "::1" || value === "[::1]" || /^127(?:\.\d{1,3}){3}$/.test(value);
}

/** @param {string} raw */
export function validateVersionEndpointUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  if (url.username || url.password || url.hash || url.search) return null;
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && loopbackHost(url.hostname)) return url;
  return null;
}

/** @param {unknown} value */
function validateApplicationIdentity(value) {
  if (!object(value)) return { ok: false, value: null, error: "application identity must be an object" };
  for (const key of Object.keys(value)) {
    if (!["version", "runtime", "deployment"].includes(key)) return { ok: false, value: null, error: "application identity contains unsupported fields" };
  }
  if (value.version !== 1) return { ok: false, value: null, error: "application identity version must be exactly 1" };
  if (!object(value.runtime) || !object(value.deployment)) return { ok: false, value: null, error: "application identity runtime and deployment are required" };
  return { ok: true, value, error: null };
}

/** @param {string} filename */
function readIdentityFile(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch { return { ok: false, payload: null, error: "application identity file cannot be inspected" }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_INPUT_BYTES) {
    return { ok: false, payload: null, error: "application identity file must be a bounded regular file" };
  }
  let text;
  try { text = fs.readFileSync(filename, "utf8"); } catch { return { ok: false, payload: null, error: "application identity file cannot be read" }; }
  let payload;
  try { payload = JSON.parse(text); } catch { return { ok: false, payload: null, error: "application identity file is not valid JSON" }; }
  return { ok: true, payload, error: null };
}

/** @param {URL} url @param {typeof fetch} fetcher */
async function readIdentityEndpoint(url, fetcher) {
  let response;
  try {
    response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return { ok: false, payload: null, error: "application version endpoint request failed" };
  }
  if (!response.ok) return { ok: false, payload: null, error: "application version endpoint returned a non-success status" };
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_INPUT_BYTES)) {
    return { ok: false, payload: null, error: "application version endpoint response is too large" };
  }
  let text;
  try { text = await response.text(); } catch { return { ok: false, payload: null, error: "application version endpoint body could not be read" }; }
  if (Buffer.byteLength(text, "utf8") > MAX_INPUT_BYTES) return { ok: false, payload: null, error: "application version endpoint response is too large" };
  let payload;
  try { payload = JSON.parse(text); } catch { return { ok: false, payload: null, error: "application version endpoint did not return valid JSON" }; }
  return { ok: true, payload, error: null };
}

/**
 * @param {{ file?:string|null, url?:string|null }} options
 * @param {{ fetcher?:typeof fetch, now?:()=>string }} [dependencies]
 */
export async function collectApplicationRuntimeEvidence(options, dependencies = {}) {
  const hasFile = typeof options.file === "string" && options.file.length > 0;
  const hasUrl = typeof options.url === "string" && options.url.length > 0;
  if (hasFile === hasUrl) return { ok: false, evidence: null, error: "exactly one application identity source is required" };

  let source;
  let raw;
  if (hasFile) {
    const result = readIdentityFile(/** @type {string} */ (options.file));
    if (!result.ok) return { ok: false, evidence: null, error: result.error };
    source = "application-build-file";
    raw = result.payload;
  } else {
    const url = validateVersionEndpointUrl(/** @type {string} */ (options.url));
    if (!url) return { ok: false, evidence: null, error: "application version endpoint URL is not allowed" };
    const result = await readIdentityEndpoint(url, dependencies.fetcher ?? fetch);
    if (!result.ok) return { ok: false, evidence: null, error: result.error };
    source = "application-version-endpoint";
    raw = result.payload;
  }

  const identity = validateApplicationIdentity(raw);
  if (!identity.ok || !identity.value) return { ok: false, evidence: null, error: identity.error };
  const collectedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  if (!isAbsoluteIsoTimestamp(collectedAt)) return { ok: false, evidence: null, error: "collector clock did not produce an absolute ISO timestamp" };

  const adapted = adaptRuntimeCollectorObservation({
    version: 1,
    collector: { kind: "application", source, authenticated: false, collectedAt },
    runtime: identity.value.runtime,
    deployment: identity.value.deployment,
  });
  if (!adapted.valid || !adapted.evidence) return { ok: false, evidence: null, error: "application identity could not be adapted to Runtime Evidence v1" };
  const canonical = validateRuntimeEvidence(adapted.evidence);
  if (!canonical.valid || !canonical.evidence) return { ok: false, evidence: null, error: "application evidence failed canonical Runtime Evidence v1 validation" };
  const collector = /** @type {any} */ (canonical.evidence.metadata?.collector);
  if (collector?.kind !== "application" || collector?.identityScope !== "application-reported") {
    return { ok: false, evidence: null, error: "application evidence lost its application-reported identity scope" };
  }
  return { ok: true, evidence: canonical.evidence, error: null };
}

/** @param {ReturnType<typeof collectApplicationRuntimeEvidence> extends Promise<infer T> ? T : never} result */
export function formatApplicationRuntimeEvidence(result) {
  if (!result.ok || !result.evidence) return `Application runtime evidence\n\nResult: INVALID\nERROR  ${result.error ?? "collection failed"}`;
  return [
    "Application runtime evidence",
    "",
    `Runtime: ${result.evidence.runtime.name}`,
    `Environment: ${result.evidence.runtime.environment ?? "(not supplied)"}`,
    `Reported commit: ${result.evidence.deployment.commit}`,
    `Identity scope: ${(/** @type {any} */ (result.evidence.metadata?.collector))?.identityScope ?? "(unknown)"}`,
    `Source: ${result.evidence.evidence.source}`,
    `Authenticated: ${result.evidence.evidence.authenticated}`,
    `Collected at: ${result.evidence.evidence.collectedAt}`,
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let file = null, url = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--file" && argument !== "--url") return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || value.length === 0) return null;
    index += 1;
    if (argument === "--file") { if (file !== null) return null; file = value; }
    else { if (url !== null) return null; url = value; }
  }
  return (file === null) === (url === null) ? null : { file, url, json };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/collect-application-runtime-evidence.js (--file <application-identity.json> | --url <version-endpoint>) [--json]");
    return 1;
  }
  const result = await collectApplicationRuntimeEvidence(options);
  if (!result.ok || !result.evidence) { console.error(result.error ?? "Application runtime evidence collection failed"); return 1; }
  console.log(options.json ? JSON.stringify(result.evidence) : formatApplicationRuntimeEvidence(result));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = await main();
