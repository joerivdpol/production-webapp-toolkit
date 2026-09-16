import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  executeSyntheticSmoke,
  formatSyntheticSmoke,
  main,
  validateSyntheticSmokePolicy,
} from "../scripts/run-synthetic-smoke-tests.js";

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    suite: "production-core",
    probes: [
      { id: "homepage", url: "https://example.com/", method: "GET", expectedStatuses: [200], timeoutMs: 5000 },
      { id: "api", url: "https://api.example.com/health", method: "HEAD", expectedStatuses: [200, 204], timeoutMs: 3000 },
    ],
  };
}

function policy(raw = rawPolicy()) {
  const result = validateSyntheticSmokePolicy(raw);
  assert.equal(result.ok, true);
  if (!result.ok || !result.policy) throw new Error("policy fixture invalid");
  return result.policy;
}

/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const filename = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("policy permits only explicit GET or HEAD probes with safe URLs", () => {
  assert.equal(validateSyntheticSmokePolicy(rawPolicy()).ok, true);
  const post = rawPolicy(); post.probes[0].method = "POST";
  assert.equal(validateSyntheticSmokePolicy(post).ok, false);
  const query = rawPolicy(); query.probes[0].url = "https://example.com/?action=run";
  assert.equal(validateSyntheticSmokePolicy(query).ok, false);
  const userinfo = rawPolicy(); userinfo.probes[0].url = "https://named-user@example.com/";
  assert.equal(validateSyntheticSmokePolicy(userinfo).ok, false);
  const publicHttp = rawPolicy(); publicHttp.probes[0].url = "http://example.com/";
  assert.equal(validateSyntheticSmokePolicy(publicHttp).ok, false);
});

test("loopback HTTP remains available for local verification", () => {
  const raw = rawPolicy(); raw.probes[0].url = "http://127.0.0.1:8080/health";
  assert.equal(validateSyntheticSmokePolicy(raw).ok, true);
});

test("policy rejects duplicate ids statuses unsupported fields and unbounded inputs", () => {
  const duplicateId = rawPolicy(); duplicateId.probes[1].id = "homepage";
  assert.equal(validateSyntheticSmokePolicy(duplicateId).ok, false);
  const duplicateStatus = rawPolicy(); duplicateStatus.probes[0].expectedStatuses = [200, 200];
  assert.equal(validateSyntheticSmokePolicy(duplicateStatus).ok, false);
  const unknown = rawPolicy(); unknown.probes[0].customHeaders = { x: "value" };
  assert.equal(validateSyntheticSmokePolicy(unknown).ok, false);
  const timeout = rawPolicy(); timeout.probes[0].timeoutMs = 60000;
  assert.equal(validateSyntheticSmokePolicy(timeout).ok, false);
});

test("status-only probes pass and preserve explicit non-destructive boundaries", async () => {
  /** @type {any[]} */
  const seen = [];
  const report = await executeSyntheticSmoke(policy(), {
    runProbe: async (probe) => { seen.push(probe); return { ok: true, statusCode: 200, contentType: "text/html", json: null }; },
    now: () => "2026-09-16T18:45:00Z",
  });
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.boundaries.methods, ["GET", "HEAD"]);
  assert.equal(report.boundaries.redirectsFollowed, false);
  assert.equal(report.boundaries.credentialsAccepted, false);
  assert.equal(report.boundaries.requestBodiesSent, false);
  assert.equal(seen.every((probe) => ["GET", "HEAD"].includes(probe.method)), true);
});

test("unexpected status and request failures are blocking smoke failures", async () => {
  const statusReport = await executeSyntheticSmoke(policy(), {
    runProbe: async () => ({ ok: true, statusCode: 503, contentType: "text/plain", json: null }),
    now: () => "2026-09-16T18:45:00Z",
  });
  assert.equal(statusReport.overallStatus, "FAIL");
  const requestReport = await executeSyntheticSmoke(policy(), {
    runProbe: async () => ({ ok: false, error: "request-error" }),
    now: () => "2026-09-16T18:45:00Z",
  });
  assert.equal(requestReport.overallStatus, "FAIL");
  assert.doesNotMatch(JSON.stringify(requestReport), /ECONNREFUSED|stack/);
});

test("bounded JSON object assertions check keys without storing response values", async () => {
  const raw = rawPolicy();
  raw.probes = [{ id: "availability", url: "https://api.example.com/availability", method: "GET", expectedStatuses: [200], timeoutMs: 5000, response: { mode: "json-object", requiredKeys: ["available", "version"], maxBytes: 4096 } }];
  const report = await executeSyntheticSmoke(policy(raw), {
    runProbe: async () => ({ ok: true, statusCode: 200, contentType: "application/json", json: { available: true, version: 3, extraValue: "not-retained" } }),
    now: () => "2026-09-16T18:45:00Z",
  });
  assert.equal(report.overallStatus, "PASS");
  assert.doesNotMatch(JSON.stringify(report), /not-retained|extraValue/);
  const missing = await executeSyntheticSmoke(policy(raw), {
    runProbe: async () => ({ ok: true, statusCode: 200, contentType: "application/json", json: { available: true } }),
    now: () => "2026-09-16T18:45:00Z",
  });
  assert.equal(missing.overallStatus, "FAIL");
  assert.match(missing.results[0]?.detail ?? "", /version/);
});

test("response policy rejects JSON keys in status-only mode and oversized bounds", () => {
  const keys = rawPolicy(); keys.probes[0].response = { mode: "status-only", requiredKeys: ["ok"] };
  assert.equal(validateSyntheticSmokePolicy(keys).ok, false);
  const bytes = rawPolicy(); bytes.probes[0].response = { mode: "json-object", requiredKeys: [], maxBytes: 1000000 };
  assert.equal(validateSyntheticSmokePolicy(bytes).ok, false);
  const headBody = rawPolicy(); headBody.probes[1].response = { mode: "json-object", requiredKeys: [] };
  assert.equal(validateSyntheticSmokePolicy(headBody).ok, false);
});

test("default network runner does not follow redirects and sends no request body", async () => {
  /** @type {Array<{method:string|undefined,url:string|undefined,body:number}>} */
  const requests = [];
  const server = http.createServer((request, response) => {
    let body = 0;
    request.on("data", (chunk) => { body += chunk.length; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body });
      response.writeHead(302, { location: "/second" });
      response.end("redirect");
    });
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", () => { resolve(undefined); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  const raw = rawPolicy(); raw.probes = [{ id: "redirect", url: `http://127.0.0.1:${address.port}/start`, method: "GET", expectedStatuses: [302], timeoutMs: 2000 }];
  const report = await executeSyntheticSmoke(policy(raw), { now: () => "2026-09-16T18:45:00Z" });
  server.close();
  assert.equal(report.overallStatus, "PASS");
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.method, "GET");
  assert.equal(requests[0]?.url, "/start");
  assert.equal(requests[0]?.body, 0);
});

test("real runner bounds JSON response size and rejects non-JSON content", async () => {
  const server = http.createServer((request, response) => {
    if (request.url === "/large") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: "x".repeat(5000) })); }
    else { response.setHeader("content-type", "text/plain"); response.end("not json"); }
  });
  await new Promise((resolve) => { server.listen(0, "127.0.0.1", () => { resolve(undefined); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server address unavailable");
  for (const [pathName, maxBytes] of [["/large", 128], ["/text", 4096]]) {
    const raw = rawPolicy(); raw.probes = [{ id: "json", url: `http://127.0.0.1:${address.port}${pathName}`, method: "GET", expectedStatuses: [200], timeoutMs: 2000, response: { mode: "json-object", requiredKeys: [], maxBytes } }];
    const report = await executeSyntheticSmoke(policy(raw), { now: () => "2026-09-16T18:45:00Z" });
    assert.equal(report.overallStatus, "FAIL");
  }
  server.close();
});

test("CLI emits JSON and preserves PASS FAIL exit semantics with injected probes", async () => {
  const filename = tempJson("smoke-policy", rawPolicy());
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(await main(["--policy", filename, "--json"], { runProbe: async () => ({ ok: true, statusCode: 200, contentType: "text/plain", json: null }), now: () => "2026-09-16T18:45:00Z" }), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  assert.equal(await main(["--policy", filename], { runProbe: async () => ({ ok: false, error: "request-error" }), now: () => "2026-09-16T18:45:00Z" }), 1);
  fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed and incomplete policy input", async () => {
  const malformed = tempJson("smoke-bad", "{");
  assert.equal(await main(["--policy", malformed]), 1);
  assert.equal(await main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("human output states the non-destructive boundary", async () => {
  const report = await executeSyntheticSmoke(policy(), { runProbe: async () => ({ ok: true, statusCode: 200, contentType: "text/plain", json: null }), now: () => "2026-09-16T18:45:00Z" });
  assert.match(formatSyntheticSmoke(report), /GET\/HEAD only; no redirects; no credentials; no request bodies/);
});

test("synthetic smoke source has no subprocess or environment inspection surface", () => {
  const source = fs.readFileSync(new URL("../scripts/run-synthetic-smoke-tests.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.env|node:child_process|spawnSync|execFile/);
  assert.match(source, /new Set\(\["GET", "HEAD"\]\)/);
});
