import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  collectApplicationRuntimeEvidence,
  formatApplicationRuntimeEvidence,
  main,
  validateVersionEndpointUrl,
} from "../scripts/collect-application-runtime-evidence.js";
import { validateRuntimeEvidence } from "../scripts/runtime-evidence.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function identity() {
  return {
    version: 1,
    runtime: { name: "example-app", environment: "production" },
    deployment: { commit: COMMIT },
  };
}

/** @param {any} value */
function tempJson(value) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-app-runtime-"));
  const filename = path.join(root, "version.json");
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return { root, filename };
}

test("explicit application identity file emits canonical application-reported Runtime Evidence", async () => {
  const fixture = tempJson(identity());
  try {
    const result = await collectApplicationRuntimeEvidence(
      { file: fixture.filename },
      { now: () => "2026-09-16T18:45:00Z" },
    );
    assert.equal(result.ok, true);
    assert.equal(validateRuntimeEvidence(result.evidence).valid, true);
    assert.equal(result.evidence?.deployment.commit, COMMIT);
    assert.equal(result.evidence?.runtime.name, "example-app");
    assert.equal(result.evidence?.evidence.source, "application-build-file");
    assert.equal(result.evidence?.evidence.authenticated, false);
    assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.kind, "application");
    assert.equal((/** @type {any} */ (result.evidence?.metadata?.collector))?.identityScope, "application-reported");
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("HTTPS endpoint collection is GET-only, no-redirect, and unauthenticated", async () => {
  /** @type {Array<{url:string,options:any}>} */
  const calls = [];
  /** @type {typeof fetch} */
  const fetcher = /** @type {any} */ (async (/** @type {any} */ url, /** @type {any} */ options) => {
    calls.push({ url: String(url), options });
    return new Response(JSON.stringify(identity()), {
      status: 200,
      headers: { "content-type": "application/json", "content-length": String(JSON.stringify(identity()).length) },
    });
  });
  const result = await collectApplicationRuntimeEvidence(
    { url: "https://example.invalid/version" },
    { fetcher, now: () => "2026-09-16T18:45:00Z" },
  );
  assert.equal(result.ok, true);
  assert.equal(result.evidence?.evidence.source, "application-version-endpoint");
  assert.equal(result.evidence?.evidence.authenticated, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://example.invalid/version");
  assert.equal(calls[0]?.options.method, "GET");
  assert.equal(calls[0]?.options.redirect, "error");
  assert.deepEqual(calls[0]?.options.headers, { accept: "application/json" });
});

test("URL policy allows HTTPS and loopback HTTP but rejects unsafe URL forms", () => {
  assert.equal(validateVersionEndpointUrl("https://example.com/version")?.protocol, "https:");
  assert.equal(validateVersionEndpointUrl("http://localhost:3000/version")?.hostname, "localhost");
  assert.equal(validateVersionEndpointUrl("http://127.0.0.1/version")?.hostname, "127.0.0.1");
  assert.equal(validateVersionEndpointUrl("http://[::1]/version")?.hostname, "[::1]");
  assert.equal(validateVersionEndpointUrl("http://example.com/version"), null);
  const credentialUrl = new URL(["https://synthetic-user", "example.com/version"].join("@"));
  assert.equal(validateVersionEndpointUrl(credentialUrl.href), null);
  assert.equal(validateVersionEndpointUrl("https://example.com/version?token=synthetic"), null);
  assert.equal(validateVersionEndpointUrl("https://example.com/version#fragment"), null);
  assert.equal(validateVersionEndpointUrl("file:///tmp/version.json"), null);
});

test("collector requires exactly one explicit source before any fetch", async () => {
  let fetchCalls = 0;
  /** @type {typeof fetch} */
  const fetcher = /** @type {any} */ (async () => { fetchCalls += 1; throw new Error("unexpected"); });
  assert.equal((await collectApplicationRuntimeEvidence({}, { fetcher })).ok, false);
  assert.equal((await collectApplicationRuntimeEvidence({ file: "/tmp/a", url: "https://example.com/version" }, { fetcher })).ok, false);
  assert.equal(fetchCalls, 0);
});

test("identity payload fails closed on unknown fields and malformed runtime or commit", async () => {
  /** @type {Array<(value:any)=>void>} */
  const mutations = [
    (value) => { value.extra = true; },
    (value) => { value.runtime.secret = "synthetic"; },
    (value) => { value.deployment.commit = "HEAD"; },
    (value) => { value.version = 2; },
  ];
  for (const mutate of mutations) {
    const value = identity();
    mutate(/** @type {any} */ (value));
    const fixture = tempJson(value);
    try {
      const result = await collectApplicationRuntimeEvidence({ file: fixture.filename }, { now: () => "2026-09-16T18:45:00Z" });
      assert.equal(result.ok, false);
    } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
  }
});

test("identity file must be bounded regular non-symlink JSON", async () => {
  const fixture = tempJson(identity());
  const symlink = path.join(fixture.root, "link.json");
  fs.symlinkSync(fixture.filename, symlink);
  try {
    assert.equal((await collectApplicationRuntimeEvidence({ file: symlink })).ok, false);
    fs.writeFileSync(fixture.filename, "{");
    assert.equal((await collectApplicationRuntimeEvidence({ file: fixture.filename })).ok, false);
    fs.writeFileSync(fixture.filename, "x".repeat(70 * 1024));
    assert.equal((await collectApplicationRuntimeEvidence({ file: fixture.filename })).ok, false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("endpoint errors invalid JSON and oversized responses fail closed", async () => {
  /** @type {typeof fetch} */
  const failed = /** @type {any} */ (async () => new Response("no", { status: 503 }));
  assert.equal((await collectApplicationRuntimeEvidence({ url: "https://example.com/version" }, { fetcher: failed })).ok, false);

  /** @type {typeof fetch} */
  const invalid = /** @type {any} */ (async () => new Response("{", { status: 200 }));
  assert.equal((await collectApplicationRuntimeEvidence({ url: "https://example.com/version" }, { fetcher: invalid })).ok, false);

  /** @type {typeof fetch} */
  const oversized = /** @type {any} */ (async () => new Response("{}", { status: 200, headers: { "content-length": "999999" } }));
  assert.equal((await collectApplicationRuntimeEvidence({ url: "https://example.com/version" }, { fetcher: oversized })).ok, false);

  /** @type {typeof fetch} */
  const throws = /** @type {any} */ (async () => { throw new Error("network details"); });
  const result = await collectApplicationRuntimeEvidence({ url: "https://example.com/version" }, { fetcher: throws });
  assert.equal(result.ok, false);
  assert.doesNotMatch(result.error ?? "", /network details/);
});

test("collector timestamp is created only after successful source validation", async () => {
  let clockCalls = 0;
  /** @type {typeof fetch} */
  const failed = /** @type {any} */ (async () => new Response("no", { status: 500 }));
  await collectApplicationRuntimeEvidence(
    { url: "https://example.com/version" },
    { fetcher: failed, now: () => { clockCalls += 1; return "2026-09-16T18:45:00Z"; } },
  );
  assert.equal(clockCalls, 0);

  const fixture = tempJson(identity());
  try {
    const invalidClock = await collectApplicationRuntimeEvidence({ file: fixture.filename }, { now: () => "today" });
    assert.equal(invalidClock.ok, false);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("human output states application-reported identity and authentication limit", async () => {
  const fixture = tempJson(identity());
  try {
    const result = await collectApplicationRuntimeEvidence({ file: fixture.filename }, { now: () => "2026-09-16T18:45:00Z" });
    const output = formatApplicationRuntimeEvidence(result);
    assert.match(output, /Identity scope: application-reported/);
    assert.match(output, /Authenticated: false/);
    assert.match(output, /Reported commit:/);
  } finally { fs.rmSync(fixture.root, { recursive: true, force: true }); }
});

test("CLI emits canonical JSON from explicit file input and rejects ambiguous arguments", async () => {
  const fixture = tempJson(identity());
  const originalLog = console.log;
  const originalError = console.error;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  console.error = () => {};
  try {
    assert.equal(await main(["--file", fixture.filename, "--json"]), 0);
    assert.equal(validateRuntimeEvidence(JSON.parse(stdout)).valid, true);
    assert.equal(await main(["--file", fixture.filename, "--url", "https://example.com/version"]), 1);
    assert.equal(await main(["--unknown"]), 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("collector file path is local read-only and endpoint surface is constrained GET", () => {
  const source = fs.readFileSync(new URL("../scripts/collect-application-runtime-evidence.js", import.meta.url), "utf8");
  assert.match(source, /adaptRuntimeCollectorObservation/);
  assert.match(source, /redirect: "error"/);
  assert.match(source, /method: "GET"/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|process\.env|writeFile|appendFile|rmSync|unlinkSync|renameSync|mkdirSync/);
  assert.doesNotMatch(source, /method:\s*"(?:POST|PUT|PATCH|DELETE)"|authorization|cookie/i);
});
