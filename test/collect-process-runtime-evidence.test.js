import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  collectProcessRuntimeEvidence,
  formatProcessRuntimeEvidence,
  main,
} from "../scripts/collect-process-runtime-evidence.js";
import { validateRuntimeEvidence } from "../scripts/runtime-evidence.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function identity() {
  return {
    version: 1,
    runtime: { name: "worker", environment: "production" },
    deployment: { commit: COMMIT },
  };
}

/** @param {{ok:boolean,payload:any,error:string|null}} result */
function fakeRequest(result) {
  /** @type {Array<{socketPath:string,endpoint:string}>} */
  const calls = [];
  /** @param {string} socketPath @param {string} endpoint */
  const requestIdentity = async (socketPath, endpoint) => {
    calls.push({ socketPath, endpoint });
    return result;
  };  return { requestIdentity, calls };
}

function socketFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-process-socket-"));
  return { root, socketPath: path.join(root, "runtime.sock") };
}

/** @param {string} socketPath @param {(request:http.IncomingMessage,response:http.ServerResponse)=>void} handler */
async function listen(socketPath, handler) {
  const server = http.createServer(handler);
  await new Promise(/** @param {(value?:void)=>void} resolve @param {(reason?:any)=>void} reject */ (resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => resolve());
  });
  return server;
}

/** @param {http.Server} server */
async function close(server) {
  await new Promise(/** @param {(value?:void)=>void} resolve */ (resolve) => {
    server.close(() => resolve());
  });
}

test("live local process socket emits canonical process-scoped Runtime Evidence", async () => {
  const fixture = socketFixture();
  const server = await listen(fixture.socketPath, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(identity()));
  });
  try {
    const result = await collectProcessRuntimeEvidence(
      { socketPath: fixture.socketPath },
      { now: () => "2026-09-16T19:00:00Z" },
    );    assert.equal(result.ok, true);
    assert.equal(validateRuntimeEvidence(result.evidence).valid, true);
    assert.equal(result.evidence?.deployment.commit, COMMIT);
    assert.equal(result.evidence?.evidence.source, "local-process-version-socket");
    assert.equal(result.evidence?.evidence.authenticated, false);
    assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.kind, "process");
    assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.identityScope, "process");
  } finally {
    await close(server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("socket request is GET-only on the explicit endpoint", async () => {
  const fixture = socketFixture();
  let method = null;
  let requestUrl = null;
  let accept = null;
  const server = await listen(fixture.socketPath, (request, response) => {
    method = request.method;
    requestUrl = request.url;
    accept = request.headers.accept;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(identity()));
  });
  try {
    const result = await collectProcessRuntimeEvidence(
      { socketPath: fixture.socketPath, endpoint: "/internal/version" },
      { now: () => "2026-09-16T19:00:00Z" },
    );
    assert.equal(result.ok, true);
    assert.equal(method, "GET");
    assert.equal(requestUrl, "/internal/version");
    assert.equal(accept, "application/json");
  } finally {    await close(server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("invalid socket paths and endpoints are rejected before any request", async () => {
  const fake = fakeRequest({ ok: true, payload: identity(), error: null });
  assert.equal((await collectProcessRuntimeEvidence({ socketPath: "relative.sock" }, { requestIdentity: fake.requestIdentity })).ok, false);
  assert.equal((await collectProcessRuntimeEvidence({ socketPath: "/tmp/runtime.sock", endpoint: "relative" }, { requestIdentity: fake.requestIdentity })).ok, false);
  assert.equal((await collectProcessRuntimeEvidence({ socketPath: "/tmp/runtime.sock", endpoint: "/a/../b" }, { requestIdentity: fake.requestIdentity })).ok, false);
  assert.equal((await collectProcessRuntimeEvidence({ socketPath: "/tmp/runtime.sock", endpoint: "/version?x=1" }, { requestIdentity: fake.requestIdentity })).ok, false);
  assert.equal(fake.calls.length, 0);
});

test("socket failure and non-success responses fail closed before timestamp", async () => {
  let clockCalls = 0;
  const fake = fakeRequest({ ok: false, payload: null, error: "process identity socket request failed" });
  const result = await collectProcessRuntimeEvidence(
    { socketPath: "/tmp/runtime.sock" },
    { requestIdentity: fake.requestIdentity, now: () => { clockCalls += 1; return "2026-09-16T19:00:00Z"; } },
  );
  assert.equal(result.ok, false);
  assert.equal(clockCalls, 0);
});

test("strict process identity rejects unknown fields and malformed canonical identity", async () => {
  const payloads = [
    { ...identity(), extra: true },
    { ...identity(), version: 2 },
    { version: 1, runtime: {}, deployment: {} },
  ];
  for (const payload of payloads) {
    const fake = fakeRequest({ ok: true, payload, error: null });
    const result = await collectProcessRuntimeEvidence(
      { socketPath: "/tmp/runtime.sock" },
      { requestIdentity: fake.requestIdentity, now: () => "2026-09-16T19:00:00Z" },
    );
    assert.equal(result.ok, false);
  }
});

test("invalid runtime or commit is rejected by the shared adapter", async () => {
  const badRuntime = identity();
  badRuntime.runtime.name = "";
  let fake = fakeRequest({ ok: true, payload: badRuntime, error: null });
  assert.equal((await collectProcessRuntimeEvidence(
    { socketPath: "/tmp/runtime.sock" },
    { requestIdentity: fake.requestIdentity, now: () => "2026-09-16T19:00:00Z" },
  )).ok, false);

  const badCommit = identity();
  badCommit.deployment.commit = "HEAD";
  fake = fakeRequest({ ok: true, payload: badCommit, error: null });
  assert.equal((await collectProcessRuntimeEvidence(
    { socketPath: "/tmp/runtime.sock" },
    { requestIdentity: fake.requestIdentity, now: () => "2026-09-16T19:00:00Z" },
  )).ok, false);
});

test("invalid clock fails only after successful process identity read", async () => {
  const fake = fakeRequest({ ok: true, payload: identity(), error: null });
  const result = await collectProcessRuntimeEvidence(
    { socketPath: "/tmp/runtime.sock" },
    { requestIdentity: fake.requestIdentity, now: () => "today" },
  );
  assert.equal(result.ok, false);
  assert.equal(fake.calls.length, 1);
});

test("human output states process scope live binding and authentication limit", async () => {
  const fake = fakeRequest({ ok: true, payload: identity(), error: null });
  const result = await collectProcessRuntimeEvidence(
    { socketPath: "/tmp/runtime.sock" },
    { requestIdentity: fake.requestIdentity, now: () => "2026-09-16T19:00:00Z" },
  );
  const text = formatProcessRuntimeEvidence(result);
  assert.match(text, /Identity scope: process/);
  assert.match(text, /live local process socket response/);
  assert.match(text, /Authenticated: false/);
});

test("oversized and malformed live socket responses fail closed", async () => {
  for (const body of ["{", "x".repeat(70 * 1024)]) {
    const fixture = socketFixture();
    const server = await listen(fixture.socketPath, (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(body);
    });
    try {
      const result = await collectProcessRuntimeEvidence({ socketPath: fixture.socketPath });
      assert.equal(result.ok, false);
    } finally {
      await close(server);
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test("CLI reads a live local process socket and rejects incomplete input", async () => {
  const fixture = socketFixture();
  const server = await listen(fixture.socketPath, (_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(identity()));
  });
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  console.error = () => {};
  try {
    assert.equal(await main(["--socket", fixture.socketPath, "--json"]), 0);
    const evidence = JSON.parse(stdout);
    assert.equal(validateRuntimeEvidence(evidence).valid, true);
    assert.equal(evidence.metadata.collector.identityScope, "process");
    assert.equal(await main(["--endpoint", "/version"]), 1);
    assert.equal(await main(["--unknown"]), 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    await close(server);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("collector source is restricted to a local HTTP socket client", () => {
  const source = fs.readFileSync(new URL("../scripts/collect-process-runtime-evidence.js", import.meta.url), "utf8");
  assert.match(source, /socketPath/);
  assert.match(source, /method: "GET"/);
  assert.match(source, /adaptRuntimeCollectorObservation/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|https:\/\//);
  assert.doesNotMatch(source, /writeFile|appendFile|rmSync|unlinkSync|renameSync|mkdirSync/);
});
