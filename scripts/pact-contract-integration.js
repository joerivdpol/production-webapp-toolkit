#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

export const PACT_INTEGRATION_VERSION = "17.1.4";
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_FILE_BYTES;
const MAX_OUTPUT_BYTES = MAX_FILE_BYTES;
const ID = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const COMMIT = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const HASH = z.string().regex(/^[a-f0-9]{64}$/);
const VERSION = z.string().regex(/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/).max(64);
const REPOSITORY = z.strictObject({ id: ID, commit: COMMIT });
const CONTRACT_PATH = z.string().max(256).refine((value) =>
  /^[A-Za-z0-9][A-Za-z0-9._/-]*\.json$/.test(value)
  && value.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
);
const Policy = z.strictObject({
  version: z.literal(1),
  scenarioId: ID,
  pactVersion: z.literal(PACT_INTEGRATION_VERSION),
  consumer: REPOSITORY,
  provider: REPOSITORY,
  dataClassification: z.literal("SYNTHETIC_ONLY"),
  timeoutMs: z.number().int().min(1000).max(30000),
  allowedMethods: z.array(z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])).min(1).max(7),
  contracts: z.array(z.strictObject({
    path: CONTRACT_PATH,
    sha256: HASH,
    interactionCount: z.number().int().min(1).max(64),
  })).min(1).max(16),
}).superRefine((value, ctx) => {
  if (new Set(value.allowedMethods).size !== value.allowedMethods.length
      || new Set(value.contracts.map((entry) => entry.path)).size !== value.contracts.length
      || value.contracts.reduce((total, entry) => total + entry.interactionCount, 0) > 256) {
    ctx.addIssue({ code: "custom", message: "duplicate or excessive contract scope" });
  }
});
const Headers = z.record(z.string(), z.string().min(1).max(128)).refine((headers) => {
  const keys = Object.keys(headers).map((key) => key.toLowerCase());
  return keys.length <= 3 && new Set(keys).size === keys.length
    && keys.every((key) => ["accept", "content-type", "x-synthetic-scenario"].includes(key))
    && Object.values(headers).every((value) => /^[A-Za-z0-9 /;=._+-]+$/.test(value));
});
// Only literal HTTP examples in v1. Provider states, plugins, generators, pending
// interactions, request filters and flexible matching rules are not authorized.
const HttpPath = z.string().max(256).refine((value) =>
  /^\/(?:[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*)?$/.test(value),
);
const Contract = z.strictObject({
  consumer: z.strictObject({ name: ID }),
  provider: z.strictObject({ name: ID }),
  metadata: z.strictObject({
    pactSpecification: z.strictObject({ version: z.literal("3.0.0") }),
    "pact-js": z.strictObject({ version: VERSION }).optional(),
    pactRust: z.strictObject({ ffi: VERSION, models: VERSION }).optional(),
  }),
  interactions: z.array(z.strictObject({
    description: z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]*$/),
    request: z.strictObject({
      method: z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]),
      path: HttpPath,
      headers: Headers.optional(),
      body: z.unknown().optional(),
    }),
    response: z.strictObject({
      status: z.number().int().min(200).max(599).refine((status) => status < 300 || status >= 400),
      headers: Headers.optional(),
      body: z.unknown().optional(),
    }),
  })).min(1).max(64),
});

/** @param {unknown} value */
export function validatePactContractPolicy(value) {
  const result = Policy.safeParse(value);
  return result.success
    ? { valid: true, policy: result.data, errors: [] }
    : { valid: false, policy: null, errors: [{ id: "pact-policy-invalid", detail: "policy must declare a bounded exact-commit synthetic contract scope" }] };
}
/** @param {unknown} value @param {number} [depth] @param {{nodes:number}} [budget] @returns {boolean} */
function safeJson(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (depth > 16 || budget.nodes > 10000) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.length <= 8192 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value);
  if (Array.isArray(value)) return value.length <= 256 && value.every((entry) => safeJson(entry, depth + 1, budget));
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.entries(value).every(([key, entry]) =>
    /^[A-Za-z0-9_-]{1,80}$/.test(key)
    && !["__proto__", "prototype", "constructor"].includes(key)
    && safeJson(entry, depth + 1, budget));
}
/** @param {unknown} value @param {unknown} rawPolicy @param {number} expectedCount */
export function validatePactContract(value, rawPolicy, expectedCount) {
  const policy = validatePactContractPolicy(rawPolicy).policy;
  const parsed = Contract.safeParse(value);
  if (!policy || !parsed.success) return { valid: false, contract: null, errors: [{ id: "pact-contract-invalid", detail: "only bounded literal HTTP Pact v3 contracts are supported" }] };
  const contract = parsed.data;
  const valid = contract.consumer.name === policy.consumer.id
    && contract.provider.name === policy.provider.id
    && contract.interactions.length === expectedCount
    && new Set(contract.interactions.map((entry) => entry.description)).size === expectedCount
    && contract.interactions.every((entry) => policy.allowedMethods.includes(entry.request.method)
      && (!Object.hasOwn(entry.request, "body") || safeJson(entry.request.body))
      && (!Object.hasOwn(entry.response, "body") || safeJson(entry.response.body)));
  return valid ? { valid: true, contract, errors: [] }
    : { valid: false, contract: null, errors: [{ id: "pact-contract-binding-invalid", detail: "identity, interaction count, method scope or JSON body limits do not match policy" }] };
}
/** @param {Buffer|string} bytes */
export function pactSha256(bytes) { return crypto.createHash("sha256").update(bytes).digest("hex"); }
/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    encoding: "utf8", timeout: 10000, maxBuffer: MAX_FILE_BYTES + 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
  });
  if (result.status !== 0) throw new Error("Pact repository inspection failed");
  return result.stdout.trim();
}
/** @param {string} root @param {string} commit */
function inspectRepository(root, commit) {
  const resolved = path.resolve(root);
  if (!fs.lstatSync(resolved).isDirectory() || fs.realpathSync(resolved) !== resolved
      || path.resolve(git(resolved, ["rev-parse", "--show-toplevel"])) !== resolved
      || git(resolved, ["rev-parse", "HEAD"]) !== commit
      || git(resolved, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
    throw new Error("Pact repository must be a clean non-symlink root at the exact policy commit");
  }
  return resolved;
}
/** @param {string} root @param {string} relative */
function readContractFile(root, relative) {
  const filename = path.join(root, relative);
  if (fs.realpathSync(filename) !== filename) throw new Error("Pact contract symlinks are not allowed");
  const tree = git(root, ["ls-tree", "HEAD", "--", relative]).split(/\s+/);
  const mode = tree[0], objectId = tree[2];
  if (mode !== "100644" && mode !== "100755") throw new Error("Pact contract must be a tracked regular file");
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw new Error("Pact contract file exceeds input limits");
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count !== stat.size || count > MAX_FILE_BYTES) throw new Error("Pact contract changed or exceeds input limits");
    const bytes = buffer.subarray(0, count);
    const format = git(root, ["rev-parse", "--show-object-format"]);
    if (!["sha1", "sha256"].includes(format) || crypto.createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== objectId) {
      throw new Error("Pact contract bytes do not match the committed Git blob");
    }
    return bytes;
  } finally { fs.closeSync(fd); }
}
/** @param {string} consumerRoot @param {unknown} rawPolicy */
export function inspectPactContracts(consumerRoot, rawPolicy) {
  const policy = validatePactContractPolicy(rawPolicy).policy;
  if (!policy) throw new Error("Pact policy is invalid");
  const root = inspectRepository(consumerRoot, policy.consumer.commit);
  let total = 0;
  const prepared = policy.contracts.map((entry) => {
    const bytes = readContractFile(root, entry.path);
    total += bytes.length;
    if (total > MAX_TOTAL_BYTES || pactSha256(bytes) !== entry.sha256) throw new Error("Pact contract hash or total byte limit does not match policy");
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Pact contract JSON is invalid"); }
    const contract = validatePactContract(value, policy, entry.interactionCount).contract;
    if (!contract) throw new Error("Pact contract is outside authorized scope");
    return { entry, bytes, contract };
  });
  return { policy, root, prepared };
}
/** @param {unknown} value */
export function isPactLoopbackUrl(value) {
  if (typeof value !== "string") return false;
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(value);
  return !!match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535;
}

/**
 * Method/path-bounded network gateway around the explicit synthetic provider.
 * Native Pact sees only this gateway; unexpected redirects never reach it.
 * @param {string} baseUrl @param {Array<{request:{method:string,path:string}}>} interactions @param {number} timeoutMs
 */
async function startGateway(baseUrl, interactions, timeoutMs) {
  const allowed = new Set(interactions.map((entry) => `${entry.request.method} ${entry.request.path}`));
  const requests = new Map();
  // Never inherit a global Agent that can redirect loopback traffic via a proxy.
  const upstreamAgent = new http.Agent({ keepAlive: false, maxSockets: 4, maxTotalSockets: 4 });
  let failed = false;
  const server = http.createServer((incoming, outgoing) => {
    const key = `${incoming.method} ${incoming.url}`;
    if (!allowed.has(key)) { failed = true; outgoing.writeHead(502).end(); incoming.resume(); return; }
    requests.set(key, (requests.get(key) ?? 0) + 1);
    /** @type {Buffer[]} */ const chunks = [];
    let size = 0;
    incoming.on("error", () => { failed = true; outgoing.destroy(); });
    incoming.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_FILE_BYTES) { failed = true; incoming.destroy(); outgoing.destroy(); }
      else chunks.push(chunk);
    });
    incoming.on("end", () => {
      const headers = Object.fromEntries(Object.entries(incoming.headers)
        .filter(([key]) => ["accept", "content-type", "x-synthetic-scenario"].includes(key)));
      const body = Buffer.concat(chunks);
      const request = http.request(`${baseUrl}${incoming.url}`, {
        method: incoming.method, headers: { ...headers, "content-length": String(body.length) }, timeout: timeoutMs, agent: upstreamAgent,
      }, (response) => {
        const status = response.statusCode ?? 502;
        if (status >= 300 && status < 400) { failed = true; response.destroy(); outgoing.writeHead(502).end(); return; }
        /** @type {Buffer[]} */ const parts = [];
        let bytes = 0;
        response.on("data", (part) => {
          bytes += part.length;
          if (bytes > MAX_FILE_BYTES) { failed = true; response.destroy(); outgoing.destroy(); }
          else parts.push(part);
        });
        response.on("error", () => { failed = true; outgoing.destroy(); });
        response.on("end", () => {
          const responseHeaders = Object.fromEntries(Object.entries(response.headers)
            .filter(([key]) => ["content-type", "x-synthetic-scenario"].includes(key)));
          outgoing.writeHead(status, responseHeaders).end(Buffer.concat(parts));
        });
      });
      request.on("timeout", () => { failed = true; request.destroy(); });
      request.on("error", () => { failed = true; if (!outgoing.headersSent) outgoing.writeHead(502); outgoing.end(); });
      outgoing.on("close", () => request.destroy());
      request.end(body);
    });
  });
  server.requestTimeout = timeoutMs;
  server.headersTimeout = timeoutMs;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(null)); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Pact gateway could not start"); }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    failed: () => failed,
    complete: () => {
      const expected = new Map();
      for (const interaction of interactions) {
        const key = `${interaction.request.method} ${interaction.request.path}`;
        expected.set(key, (expected.get(key) ?? 0) + 1);
      }
      return !failed && [...expected].every(([key, count]) => requests.get(key) === count);
    },
    close: async () => { upstreamAgent.destroy(); server.closeAllConnections(); await new Promise((resolve, reject) => { server.close((error) => error ? reject(error) : resolve(null)); }); },
  };
}

/** @param {{baseUrl:string,files:string[],provider:string,commit:string,timeoutMs:number}} options */
function runVerifier(options) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL("./pact-verifier-worker.js", import.meta.url))], {
      cwd: os.tmpdir(), detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8", PACT_DO_NOT_TRACK: "true", PACT_LOG_LEVEL: "error", SCARF_ANALYTICS: "false" },
    });
    let reason = "completed", outputBytes = 0;
    const stop = () => { try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already stopped */ } };
    const timer = setTimeout(() => { reason = "timeout"; stop(); }, options.timeoutMs);
    const collect = (/** @type {Buffer} */ chunk) => { outputBytes += chunk.length; if (outputBytes > MAX_OUTPUT_BYTES) { reason = "output-limit"; stop(); } };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdin.on("error", () => { /* close/error event below is authoritative */ });
    child.once("error", () => { reason = "worker-error"; });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ status: reason === "completed" && code === 0 ? "PASS" : reason === "completed" && code === 1 ? "FAIL" : "ERROR", reason: reason === "completed" && code !== 0 ? "verification-rejected" : reason });
    });
    child.stdin.end(JSON.stringify(options));
  });
}

/**
 * Caller callbacks are trusted test code, not a sandbox or runtime attestation.
 * @param {string} consumerRoot @param {string} providerRoot @param {unknown} rawPolicy
 * @param {string} collectedAt @param {()=>Promise<{baseUrl:string,close:()=>Promise<void>}>} startProvider
 */
export async function verifyPactContracts(consumerRoot, providerRoot, rawPolicy, collectedAt, startProvider) {
  if (!isAbsoluteIsoTimestamp(collectedAt) || typeof startProvider !== "function") throw new Error("Pact verification requires explicit timestamp and provider lifecycle");
  const { policy, root, prepared } = inspectPactContracts(consumerRoot, rawPolicy);
  const providerPath = inspectRepository(providerRoot, policy.provider.commit);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pwt-pact-"));
  fs.chmodSync(temp, 0o700);
  /** @type {{baseUrl:string,close:()=>Promise<void>}|null} */ let provider = null;
  /** @type {Awaited<ReturnType<typeof startGateway>>|null} */ let gateway = null;
  let cleanup = "PASS";
  /** @type {any} */ let result = { status: "ERROR", reason: "setup-failed" };
  try {
    const files = prepared.map((item, index) => {
      const filename = path.join(temp, `contract-${index}.json`);
      fs.writeFileSync(filename, item.bytes, { flag: "wx", mode: 0o600 });
      return filename;
    });
    provider = await startProvider();
    if (!provider || typeof provider.close !== "function" || !isPactLoopbackUrl(provider.baseUrl)) throw new Error("invalid synthetic provider lifecycle");
    const interactions = prepared.flatMap((item) => item.contract.interactions);
    gateway = await startGateway(provider.baseUrl, interactions, policy.timeoutMs);
    result = await runVerifier({ baseUrl: gateway.baseUrl, files, provider: policy.provider.id, commit: policy.provider.commit, timeoutMs: policy.timeoutMs });
    if (result.status !== "ERROR" && gateway.failed()) result = { status: "ERROR", reason: "gateway-transport-or-scope-failed" };
    if (result.status === "PASS" && !gateway.complete()) result = { status: "ERROR", reason: "interaction-coverage-incomplete" };
    inspectRepository(root, policy.consumer.commit);
    inspectRepository(providerPath, policy.provider.commit);
    // Revalidate source bytes after execution; evidence cannot silently cover drift.
    inspectPactContracts(root, policy);
  } catch { result = { status: "ERROR", reason: "setup-or-integrity-failed" }; }
  finally {
    try { await gateway?.close(); } catch { cleanup = "FAIL"; }
    try { if (provider && typeof provider.close === "function") await provider.close(); else if (provider) cleanup = "FAIL"; } catch { cleanup = "FAIL"; }
    try { fs.rmSync(temp, { recursive: true, force: true }); } catch { cleanup = "FAIL"; }
  }
  // Cleanup callbacks must not leave a passing report over a changed checkout.
  try { inspectRepository(providerPath, policy.provider.commit); inspectPactContracts(root, policy); }
  catch { result = { status: "ERROR", reason: "post-cleanup-integrity-failed" }; }
  return {
    version: 1, kind: "pact-contract-verification", scenarioId: policy.scenarioId,
    consumer: policy.consumer, provider: policy.provider, collectedAt,
    integration: { library: "@pact-foundation/pact", version: PACT_INTEGRATION_VERSION },
    policySha256: pactSha256(JSON.stringify(policy)),
    contracts: prepared.map((item) => ({ ...item.entry, bytes: item.bytes.length })),
    dataClassification: "SYNTHETIC_ONLY", verificationStatus: result.status, reason: result.reason,
    cleanupStatus: cleanup, technicalStatus: result.status === "ERROR" || cleanup === "FAIL" ? "FAIL" : "PASS",
    overallStatus: result.status === "PASS" && cleanup === "PASS" ? "PASS" : "FAIL",
    executionPerformed: gateway !== null, runtimeIdentityVerified: false, authenticity: "UNVERIFIED",
    brokerAccessConfigured: false, publicationAuthorized: false, productionMutationAuthorized: false,
    semantics: "literal HTTP v3 contract replay against a caller-controlled synthetic loopback provider; clean checkout and exact file hash binding, not runtime identity or authenticity; raw provider data and verifier logs are omitted",
  };
}

/** @param {string[]} [argv] */
export function main(argv = process.argv.slice(2)) {
  const mode = argv[0], values = new Map(); let json = false;
  if (!["validate", "inspect"].includes(mode ?? "")) return 2;
  const allowed = mode === "inspect" ? ["--policy", "--consumer-root"] : ["--policy"];
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === "--json" && !json) { json = true; continue; }
    const value = argv[++index];
    if (!key || !allowed.includes(key) || values.has(key) || !value || value.startsWith("--")) return 2;
    values.set(key, value);
  }
  if (allowed.some((key) => !values.has(key))) return 2;
  try {
    const filename = path.resolve(values.get("--policy"));
    if (fs.realpathSync(filename) !== filename) throw new Error("invalid policy path");
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw new Error("invalid policy file");
    const policy = validatePactContractPolicy(JSON.parse(fs.readFileSync(filename, "utf8"))).policy;
    if (!policy) throw new Error("invalid policy");
    const report = mode === "inspect"
      ? { valid: true, executionPerformed: false, contracts: inspectPactContracts(values.get("--consumer-root"), policy).prepared.map((item) => ({ ...item.entry, bytes: item.bytes.length })) }
      : { valid: true, executionPerformed: false, policy };
    console.log(json ? JSON.stringify(report) : "Pact contract scope: PASS (no execution)");
    return 0;
  } catch { console.error("Pact input or repository validation failed"); return 1; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) process.exitCode = main();
