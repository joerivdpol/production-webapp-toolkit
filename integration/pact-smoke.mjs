#!/usr/bin/env node
// Real native consumer/provider verification. No production URLs or credentials.
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pactSha256, verifyPactContracts } from "../scripts/pact-contract-integration.js";

process.env.PACT_DO_NOT_TRACK = "true";
process.env.PACT_LOG_LEVEL = "error";
process.env.SCARF_ANALYTICS = "false";
const { PactV3 } = await import("@pact-foundation/pact");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pwt-pact-smoke-"));
const consumer = path.join(root, "consumer"), provider = path.join(root, "provider");
const summaries = [];

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function init(cwd) {
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "test@example.invalid"]);
  git(cwd, ["config", "user.name", "Toolkit Test"]);
  git(cwd, ["add", "."]); git(cwd, ["commit", "-qm", "synthetic fixture"]);
  return git(cwd, ["rev-parse", "HEAD"]);
}
async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
async function listen(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

try {
  fs.mkdirSync(path.join(consumer, "contracts"), { recursive: true });
  fs.mkdirSync(provider);
  fs.writeFileSync(path.join(provider, "fixture.json"), JSON.stringify({ status: "ready" }));
  const pact = new PactV3({ consumer: "synthetic-consumer", provider: "synthetic-provider", dir: path.join(consumer, "contracts"), logLevel: "error" });
  pact.uponReceiving("synthetic status").withRequest({ method: "GET", path: "/status", headers: { Accept: "application/json" } })
    .willRespondWith({ status: 200, headers: { "Content-Type": "application/json" }, body: { status: "ready" } });
  pact.uponReceiving("synthetic echo").withRequest({ method: "POST", path: "/echo", headers: { "Content-Type": "application/json" }, body: { value: "synthetic-message" } })
    .willRespondWith({ status: 200, headers: { "Content-Type": "application/json" }, body: { value: "synthetic-message" } });
  await pact.executeTest(async ({ url }) => {
    const status = await fetch(`${url}/status`, { headers: { Accept: "application/json" } });
    assert.equal(status.status, 200); assert.deepEqual(await status.json(), { status: "ready" });
    const echo = await fetch(`${url}/echo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "synthetic-message" }) });
    assert.equal(echo.status, 200); assert.deepEqual(await echo.json(), { value: "synthetic-message" });
  });
  const consumerCommit = init(consumer), providerCommit = init(provider);
  const contractPath = `contracts/${fs.readdirSync(path.join(consumer, "contracts")).find((file) => file.endsWith(".json"))}`;
  const policy = { version: 1, scenarioId: "synthetic-native-smoke", pactVersion: "17.1.4",
    consumer: { id: "synthetic-consumer", commit: consumerCommit }, provider: { id: "synthetic-provider", commit: providerCommit },
    dataClassification: "SYNTHETIC_ONLY", timeoutMs: 15000, allowedMethods: ["GET", "POST"],
    contracts: [{ path: contractPath, sha256: pactSha256(fs.readFileSync(path.join(consumer, contractPath))), interactionCount: 2 }],
  };

  for (const scenario of ["proxy-isolation", "pass", "mismatch", "redirect", "timeout", "oversized", "close-failure", "cleanup-drift"]) {
    let closed = false, redirectedRequests = 0;
    const target = scenario === "redirect" ? await listen((_request, response) => { redirectedRequests += 1; response.end("not-authorized"); }) : null;
    let proxiedRequests = 0;
    const previousAgent = http.globalAgent;
    const proxy = scenario === "proxy-isolation" ? await listen((_request, response) => { proxiedRequests += 1; response.writeHead(502).end(); }) : null;
    if (proxy) http.globalAgent = new http.Agent({ proxyEnv: { http_proxy: proxy.baseUrl } });
    const expectedPass = ["pass", "proxy-isolation"].includes(scenario);
    const timeoutMs = scenario === "timeout" ? 2500 : 15000;
    const started = Date.now();
    const report = await verifyPactContracts(consumer, provider, { ...policy, timeoutMs }, new Date().toISOString(), async () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(provider, "fixture.json"), "utf8"));
      const service = await listen((request, response) => {
        if (scenario === "timeout") { request.resume(); return; }
        if (scenario === "redirect") { response.writeHead(302, { Location: `${target.baseUrl}/escape` }).end(); return; }
        if (scenario === "oversized") { response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ data: "x".repeat(1024 * 1024 + 1) })); return; }
        if (request.method === "GET" && request.url === "/status") {
          response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ status: scenario === "mismatch" ? "broken" : fixture.status })); return;
        }
        if (request.method === "POST" && request.url === "/echo") {
          const chunks = []; request.on("data", (chunk) => chunks.push(chunk));
          request.on("end", () => { response.writeHead(200, { "Content-Type": "application/json" }).end(Buffer.concat(chunks)); }); return;
        }
        response.writeHead(404).end();
      });
      return { baseUrl: service.baseUrl, close: async () => {
        await close(service.server); closed = true;
        if (scenario === "cleanup-drift") fs.writeFileSync(path.join(provider, "fixture.json"), "{}");
        if (scenario === "close-failure") throw new Error("synthetic private cleanup detail");
      } };
    });
    try {
      assert.equal(closed, true, `${scenario}: cleanup not performed`);
      assert.equal(report.overallStatus, expectedPass ? "PASS" : "FAIL", JSON.stringify({ scenario, report }));
      if (expectedPass || scenario === "mismatch") assert.equal(report.technicalStatus, "PASS", JSON.stringify(report));
      else assert.equal(report.technicalStatus, "FAIL", JSON.stringify(report));
      if (scenario === "mismatch") assert.equal(report.verificationStatus, "FAIL", JSON.stringify(report));
      if (scenario === "timeout") { assert.equal(report.reason, "timeout"); assert.ok(Date.now() - started < 10000); }
      if (scenario === "cleanup-drift") assert.equal(report.reason, "post-cleanup-integrity-failed");
      if (scenario === "redirect") assert.equal(redirectedRequests, 0, "redirect must not reach target");
      if (proxy) assert.equal(proxiedRequests, 0, "synthetic provider requests must not use the ambient proxy");
      assert.equal(report.cleanupStatus, scenario === "close-failure" ? "FAIL" : "PASS");
      assert.equal(report.runtimeIdentityVerified, false); assert.equal(report.authenticity, "UNVERIFIED");
      assert.doesNotMatch(JSON.stringify(report), /127\.0\.0\.1|synthetic private cleanup|pwt-pact-smoke-|synthetic-message/);
      summaries.push({ scenario, outcome: "PASS", verificationStatus: report.verificationStatus, reason: report.reason, cleanupStatus: report.cleanupStatus });
      console.log(JSON.stringify(summaries.at(-1)));
    } finally {
      if (proxy) { http.globalAgent.destroy(); http.globalAgent = previousAgent; await close(proxy.server); }
      if (target) await close(target.server);
    }
  }
  console.log(JSON.stringify({ integration: "pact", consumerGeneration: "PASS", scenarios: summaries.length, overallStatus: "PASS" }));
} finally { fs.rmSync(root, { recursive: true, force: true }); }
