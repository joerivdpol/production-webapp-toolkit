#!/usr/bin/env node

import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { adaptRuntimeCollectorObservation } from "./runtime-collector-adapter.js";
import { isAbsoluteIsoTimestamp, validateRuntimeEvidence } from "./runtime-evidence.js";

const MAX_RESPONSE_BYTES = 64 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function validSocketPath(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && path.isAbsolute(value) && !value.includes("\0");
}

/** @param {unknown} value */
function validateProcessIdentity(value) {
  if (!object(value)) return { ok: false, value: null, error: "process identity must be an object" };
  for (const key of Object.keys(value)) {
    if (!["version", "runtime", "deployment"].includes(key)) return { ok: false, value: null, error: "process identity contains unsupported fields" };
  }
  if (value.version !== 1) return { ok: false, value: null, error: "process identity version must be exactly 1" };
  if (!object(value.runtime) || !object(value.deployment)) return { ok: false, value: null, error: "process identity runtime and deployment are required" };
  return { ok: true, value, error: null };
}

/** @param {string} socketPath @param {string} endpoint */
function requestUnixIdentity(socketPath, endpoint) {
  return new Promise((resolve) => {
    const request = http.request({
      socketPath,
      path: endpoint,
      method: "GET",
      headers: { accept: "application/json" },
      timeout: 5000,
    }, (response) => {
      if (response.statusCode === undefined || response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        resolve({ ok: false, payload: null, error: "process identity socket returned a non-success status" });
        return;
      }
      /** @type {Buffer[]} */
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) request.destroy();
        else chunks.push(chunk);
      });
      response.on("end", () => {
        if (size > MAX_RESPONSE_BYTES) {
          resolve({ ok: false, payload: null, error: "process identity response is too large" });
          return;
        }
        let payload;        try { payload = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch {
          resolve({ ok: false, payload: null, error: "process identity socket did not return valid JSON" });
          return;
        }
        resolve({ ok: true, payload, error: null });
      });
    });
    request.on("timeout", () => request.destroy());
    request.on("error", () => resolve({ ok: false, payload: null, error: "process identity socket request failed" }));
    request.end();
  });
}

/**
 * @param {{ socketPath:string, endpoint?:string|null }} options
 * @param {{ requestIdentity?:typeof requestUnixIdentity, now?:()=>string }} [dependencies]
 */
export async function collectProcessRuntimeEvidence(options, dependencies = {}) {
  if (!validSocketPath(options.socketPath)) {
    return { ok: false, evidence: null, error: "socketPath must be an explicit absolute local socket path" };
  }
  const endpoint = options.endpoint === undefined || options.endpoint === null ? "/version" : options.endpoint;
  if (typeof endpoint !== "string" || endpoint.length === 0 || endpoint.length > 256 || !endpoint.startsWith("/") || endpoint.includes("..") || endpoint.includes("?") || endpoint.includes("#")) {
    return { ok: false, evidence: null, error: "endpoint must be a bounded absolute HTTP path" };
  }

  const read = await (dependencies.requestIdentity ?? requestUnixIdentity)(options.socketPath, endpoint);
  if (!read.ok) return { ok: false, evidence: null, error: read.error };  const identity = validateProcessIdentity(read.payload);
  if (!identity.ok || !identity.value) return { ok: false, evidence: null, error: identity.error };
  const collectedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  if (!isAbsoluteIsoTimestamp(collectedAt)) {
    return { ok: false, evidence: null, error: "collector clock did not produce an absolute ISO timestamp" };
  }

  const adapted = adaptRuntimeCollectorObservation({
    version: 1,
    collector: { kind: "process", source: "local-process-version-socket", authenticated: false, collectedAt },
    runtime: identity.value.runtime,
    deployment: identity.value.deployment,
  });
  if (!adapted.valid || !adapted.evidence) {
    return { ok: false, evidence: null, error: "process identity could not be adapted to Runtime Evidence v1" };
  }
  const canonical = validateRuntimeEvidence(adapted.evidence);
  if (!canonical.valid || !canonical.evidence) {
    return { ok: false, evidence: null, error: "process evidence failed canonical Runtime Evidence v1 validation" };
  }
  const collector = /** @type {any} */ (canonical.evidence.metadata?.collector);
  if (collector?.kind !== "process" || collector?.identityScope !== "process") {
    return { ok: false, evidence: null, error: "process evidence lost its process identity scope" };
  }
  return { ok: true, evidence: canonical.evidence, error: null };
}

/** @param {Awaited<ReturnType<typeof collectProcessRuntimeEvidence>>} result */
export function formatProcessRuntimeEvidence(result) {
  if (!result.ok || !result.evidence) return `Process runtime evidence\n\nResult: INVALID\nERROR  ${result.error ?? "collection failed"}`;  return [
    "Process runtime evidence",
    "",
    `Runtime: ${result.evidence.runtime.name}`,
    `Environment: ${result.evidence.runtime.environment ?? "(not supplied)"}`,
    `Process-reported commit: ${result.evidence.deployment.commit}`,
    `Identity scope: ${(/** @type {any} */ (result.evidence.metadata?.collector))?.identityScope ?? "(unknown)"}`,
    `Source: ${result.evidence.evidence.source}`,
    `Authenticated: ${result.evidence.evidence.authenticated}`,
    `Collected at: ${result.evidence.evidence.collectedAt}`,
    "Binding: live local process socket response",
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let socketPath = null, endpoint = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--socket" && argument !== "--endpoint") return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || value.length === 0) return null;
    index += 1;
    if (argument === "--socket") {
      if (socketPath !== null) return null;
      socketPath = value;
    } else {
      if (endpoint !== null) return null;
      endpoint = value;
    }
  }  return socketPath ? { socketPath, endpoint, json } : null;
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/collect-process-runtime-evidence.js --socket <absolute-unix-socket> [--endpoint </version>] [--json]");
    return 1;
  }
  const result = await collectProcessRuntimeEvidence(options);
  if (!result.ok || !result.evidence) {
    console.error(result.error ?? "Process runtime evidence collection failed");
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.evidence) : formatProcessRuntimeEvidence(result));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = await main();
}
