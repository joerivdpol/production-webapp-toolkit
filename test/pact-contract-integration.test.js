import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  inspectPactContracts, isPactLoopbackUrl, main, pactSha256,
  validatePactContract, validatePactContractPolicy, verifyPactContracts,
} from "../scripts/pact-contract-integration.js";

/** @returns {any} */
function policy() {
  return { version: 1, scenarioId: "synthetic-contract", pactVersion: "17.1.4",
    consumer: { id: "synthetic-consumer", commit: "a".repeat(40) },
    provider: { id: "synthetic-provider", commit: "b".repeat(40) },
    dataClassification: "SYNTHETIC_ONLY", timeoutMs: 15000, allowedMethods: ["GET"],
    contracts: [{ path: "contracts/status.json", sha256: "c".repeat(64), interactionCount: 1 }],
  };
}
/** @returns {any} */
function contract() {
  return { consumer: { name: "synthetic-consumer" }, provider: { name: "synthetic-provider" },
    metadata: { pactSpecification: { version: "3.0.0" } },
    interactions: [{ description: "synthetic status", request: { method: "GET", path: "/status" },
      response: { status: 200, headers: { "Content-Type": "application/json" }, body: { status: "ready" } } }],
  };
}
/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pact-unit-"));
  fs.mkdirSync(path.join(root, "contracts"));
  const bytes = JSON.stringify(contract());
  fs.writeFileSync(path.join(root, "contracts/status.json"), bytes);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Toolkit Test"]);
  git(root, ["add", "."]); git(root, ["commit", "-qm", "synthetic fixture"]);
  const raw = policy(); raw.consumer.commit = git(root, ["rev-parse", "HEAD"]);
  raw.provider.commit = raw.consumer.commit;
  raw.contracts[0].sha256 = pactSha256(bytes);
  return { root, policy: raw, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("Pact policy accepts exact identities and bounded synthetic scope", () => {
  assert.equal(validatePactContractPolicy(policy()).valid, true);
  const raw = policy(); raw.consumer.commit = "a".repeat(64);
  assert.equal(validatePactContractPolicy(raw).valid, true);
});

test("Pact policy rejects weak identity version data classification and timeout", () => {
  const cases = [null, [], { ...policy(), pactVersion: "latest" }, { ...policy(), dataClassification: "PRODUCTION" },
    { ...policy(), timeoutMs: 0 }, { ...policy(), timeoutMs: 30001 }, { ...policy(), timeoutMs: 2000.5 }];
  const short = policy(); short.consumer.commit = "abc"; cases.push(short);
  const privateId = policy(); privateId.provider.id = "https://example.invalid"; cases.push(privateId);
  for (const raw of cases) assert.equal(validatePactContractPolicy(raw).valid, false);
});

test("Pact policy rejects broker publishing filters shell and unknown fields", () => {
  for (const key of ["pactBrokerUrl", "publishVerificationResult", "stateHandlers", "requestFilter", "command", "providerBaseUrl", "enablePending", "consumerVersionSelectors"]) {
    assert.equal(validatePactContractPolicy({ ...policy(), [key]: "not-authorized" }).valid, false, key);
  }
});

test("Pact policy rejects traversal absolute glob URL and duplicate paths", () => {
  for (const value of ["../status.json", "/tmp/status.json", "contracts/../status.json", "./status.json", "contracts//status.json", "contracts/*.json", "https://example.invalid/status.json", "contracts\\status.json", "contracts/status.JSON"]) {
    const raw = policy(); raw.contracts[0].path = value;
    assert.equal(validatePactContractPolicy(raw).valid, false, value);
  }
  const duplicate = policy(); duplicate.contracts.push({ ...duplicate.contracts[0] });
  assert.equal(validatePactContractPolicy(duplicate).valid, false);
});

test("Pact policy refuses empty counts unsupported methods and unbounded coverage", () => {
  const empty = policy(); empty.contracts = [];
  const zero = policy(); zero.contracts[0].interactionCount = 0;
  const duplicate = policy(); duplicate.allowedMethods = ["GET", "GET"];
  const trace = policy(); trace.allowedMethods = ["TRACE"];
  const many = policy(); many.contracts = Array.from({ length: 5 }, (_, index) => ({ path: `contracts/${index}.json`, sha256: "c".repeat(64), interactionCount: 64 }));
  for (const raw of [empty, zero, duplicate, trace, many]) assert.equal(validatePactContractPolicy(raw).valid, false);
});

test("Pact contract accepts native v3 metadata and literal JSON expectations", () => {
  const value = contract();
  value.metadata["pact-js"] = { version: "17.1.4" };
  value.metadata.pactRust = { ffi: "0.5.8", models: "1.3.16" };
  assert.equal(validatePactContract(value, policy(), 1).valid, true);
});

test("Pact contract rejects unsupported hooks plugins generators matching and pending", () => {
  for (const key of ["providerStates", "pending", "key", "type"]) {
    const value = contract(); value.interactions[0][key] = true;
    assert.equal(validatePactContract(value, policy(), 1).valid, false, key);
  }
  for (const key of ["generators", "matchingRules", "query"]) {
    const value = contract(); value.interactions[0].request[key] = {};
    assert.equal(validatePactContract(value, policy(), 1).valid, false, key);
  }
  const plugin = contract(); plugin.metadata.plugins = [];
  assert.equal(validatePactContract(plugin, policy(), 1).valid, false);
});

test("Pact contract refuses empty duplicated foreign and incorrectly counted interactions", () => {
  const empty = contract(); empty.interactions = [];
  const duplicate = contract(); duplicate.interactions.push({ ...duplicate.interactions[0] });
  const foreign = contract(); foreign.consumer.name = "foreign-consumer";
  for (const raw of [empty, duplicate, foreign]) assert.equal(validatePactContract(raw, policy(), 1).valid, false);
  assert.equal(validatePactContract(contract(), policy(), 2).valid, false);
});

test("Pact requests cannot escape loopback gateway through path encoding or headers", () => {
  for (const value of ["//example.invalid/path", "http://example.invalid/", "/../path", "/%2f%2fexample", "/path?url=x", "/path#fragment", "/path\\escape"]) {
    const raw = contract(); raw.interactions[0].request.path = value;
    assert.equal(validatePactContract(raw, policy(), 1).valid, false, value);
  }
  for (const key of ["Authorization", "Cookie", "Host", "Location", "X-Forwarded-Host"]) {
    const raw = contract(); raw.interactions[0].request.headers = { [key]: "synthetic" };
    assert.equal(validatePactContract(raw, policy(), 1).valid, false, key);
  }
});

test("Pact contract rejects undeclared mutations redirects duplicate headers and deep payloads", () => {
  const mutation = contract(); mutation.interactions[0].request.method = "POST";
  const redirect = contract(); redirect.interactions[0].response.status = 302;
  const headers = contract(); headers.interactions[0].request.headers = { Accept: "application/json", accept: "application/json" };
  const deep = contract(); let body = {}; for (let index = 0; index < 20; index += 1) body = { nested: body };
  deep.interactions[0].response.body = body;
  const large = contract(); large.interactions[0].response.body = { value: "x".repeat(8193) };
  for (const value of [mutation, redirect, headers, deep, large]) assert.equal(validatePactContract(value, policy(), 1).valid, false);
  const allowed = policy(); allowed.allowedMethods.push("POST");
  assert.equal(validatePactContract(mutation, allowed, 1).valid, true);
});

test("Pact runtime accepts only literal IPv4 loopback with nonprivileged numeric port", () => {
  assert.equal(isPactLoopbackUrl("http://127.0.0.1:54321"), true);
  for (const value of ["http://localhost:5000", "http://0.0.0.0:5000", "https://127.0.0.1:5000", "http://127.0.0.1:80", "http://127.0.0.1:65536", "http://127.0.0.1:05000", "http://127.0.0.1:5000/", "http://user@127.0.0.1:5000", "http://127.0.0.1:5000?secret=x", null]) assert.equal(isPactLoopbackUrl(value), false);
});

test("Pact inspection binds tracked contract exact bytes and clean repository commit", () => {
  const repo = fixture();
  try {
    const output = inspectPactContracts(repo.root, repo.policy);
    assert.equal(output.prepared.length, 1);
    assert.equal(pactSha256(output.prepared[0]?.bytes ?? ""), repo.policy.contracts[0].sha256);
    const wrong = structuredClone(repo.policy); wrong.consumer.commit = "a".repeat(40);
    assert.throws(() => inspectPactContracts(repo.root, wrong), /exact policy commit/);
    wrong.consumer.commit = repo.policy.consumer.commit; wrong.contracts[0].sha256 = "0".repeat(64);
    assert.throws(() => inspectPactContracts(repo.root, wrong), /hash/);
    fs.writeFileSync(path.join(repo.root, "dirty.txt"), "untracked");
    assert.throws(() => inspectPactContracts(repo.root, repo.policy), /clean/);
  } finally { repo.cleanup(); }
});

test("Pact inspection rejects symlink contract and symlink repository ancestors", () => {
  const repo = fixture(), link = `${repo.root}-link`;
  try {
    fs.symlinkSync(repo.root, link);
    assert.throws(() => inspectPactContracts(link, repo.policy), /non-symlink/);
    fs.renameSync(path.join(repo.root, "contracts/status.json"), path.join(repo.root, "actual.json"));
    fs.symlinkSync("../actual.json", path.join(repo.root, "contracts/status.json"));
    git(repo.root, ["add", "."]); git(repo.root, ["commit", "-qm", "symlink fixture"]);
    repo.policy.consumer.commit = git(repo.root, ["rev-parse", "HEAD"]);
    assert.throws(() => inspectPactContracts(repo.root, repo.policy), /symlink/);
  } finally { fs.rmSync(link, { force: true }); repo.cleanup(); }
});

test("Pact verifier does not start provider when preflight fails", async () => {
  const repo = fixture(); let started = false;
  try {
    repo.policy.contracts[0].sha256 = "0".repeat(64);
    await assert.rejects(verifyPactContracts(repo.root, repo.root, repo.policy, "2026-09-19T05:00:00Z", async () => { started = true; throw new Error("must not start"); }), /hash/);
    assert.equal(started, false);
  } finally { repo.cleanup(); }
});

test("Pact verifier cleans invalid provider without disclosing private callback data", async () => {
  const repo = fixture(); let closed = false;
  try {
    const report = await verifyPactContracts(repo.root, repo.root, repo.policy, "2026-09-19T05:00:00Z", async () => ({ baseUrl: "http://example.invalid:5000", close: async () => { closed = true; } }));
    assert.equal(closed, true); assert.equal(report.overallStatus, "FAIL");
    assert.equal(report.executionPerformed, false); assert.equal(report.cleanupStatus, "PASS");
    assert.doesNotMatch(JSON.stringify(report), /example\.invalid|pact-unit-/);
  } finally { repo.cleanup(); }
});

test("Pact provider cleanup errors remain blocking and sanitized", async () => {
  const repo = fixture();
  try {
    const report = await verifyPactContracts(repo.root, repo.root, repo.policy, "2026-09-19T05:00:00Z", async () => ({ baseUrl: "invalid", close: async () => { throw new Error("private provider error"); } }));
    assert.equal(report.overallStatus, "FAIL"); assert.equal(report.cleanupStatus, "FAIL");
    assert.doesNotMatch(JSON.stringify(report), /private provider error/);
  } finally { repo.cleanup(); }
});

test("Pact CLI rejects ambiguous execution and unknown duplicate or missing flags", () => {
  assert.equal(main(["verify", "--provider-url", "http://example.invalid"]), 2);
  assert.equal(main(["validate"]), 2);
  assert.equal(main(["validate", "--policy", "a", "--policy", "b"]), 2);
  assert.equal(main(["validate", "--policy", "a", "--json", "--json"]), 2);
  assert.equal(main(["inspect", "--policy", "a"]), 2);
});


test("Pact inspection rejects hash-updated working bytes hidden by assume-unchanged", () => {
  const repo = fixture();
  try {
    git(repo.root, ["update-index", "--assume-unchanged", "contracts/status.json"]);
    const bytes = JSON.stringify({ ...contract(), metadata: { pactSpecification: { version: "3.0.0" }, "pact-js": { version: "17.1.4" } } });
    fs.writeFileSync(path.join(repo.root, "contracts/status.json"), bytes);
    repo.policy.contracts[0].sha256 = pactSha256(bytes);
    assert.equal(git(repo.root, ["status", "--porcelain"]), "");
    assert.throws(() => inspectPactContracts(repo.root, repo.policy), /committed Git blob/);
  } finally { repo.cleanup(); }
});

test("Pact inspection rejects hash-updated bytes hidden by skip-worktree", () => {
  const repo = fixture();
  try {
    git(repo.root, ["update-index", "--skip-worktree", "contracts/status.json"]);
    const bytes = JSON.stringify(contract(), null, 2);
    fs.writeFileSync(path.join(repo.root, "contracts/status.json"), bytes);
    repo.policy.contracts[0].sha256 = pactSha256(bytes);
    assert.equal(git(repo.root, ["status", "--porcelain"]), "");
    assert.throws(() => inspectPactContracts(repo.root, repo.policy), /committed Git blob/);
  } finally { repo.cleanup(); }
});

test("Pact inspection rejects a committed oversized contract before parsing", () => {
  const repo = fixture();
  try {
    const bytes = " ".repeat(1024 * 1024 + 1);
    fs.writeFileSync(path.join(repo.root, "contracts/status.json"), bytes);
    git(repo.root, ["add", "."]); git(repo.root, ["commit", "-qm", "oversized synthetic fixture"]);
    repo.policy.consumer.commit = git(repo.root, ["rev-parse", "HEAD"]);
    repo.policy.contracts[0].sha256 = pactSha256(bytes);
    assert.throws(() => inspectPactContracts(repo.root, repo.policy), /input limits/);
  } finally { repo.cleanup(); }
});

test("Pact inspection rejects committed malformed JSON and foreign consumer identity", () => {
  for (const bytes of ["{ invalid", JSON.stringify({ ...contract(), consumer: { name: "foreign" } })]) {
    const repo = fixture();
    try {
      fs.writeFileSync(path.join(repo.root, "contracts/status.json"), bytes);
      git(repo.root, ["add", "."]); git(repo.root, ["commit", "-qm", "invalid fixture"]);
      repo.policy.consumer.commit = git(repo.root, ["rev-parse", "HEAD"]);
      repo.policy.contracts[0].sha256 = pactSha256(bytes);
      assert.throws(() => inspectPactContracts(repo.root, repo.policy), /JSON is invalid|outside authorized scope/);
    } finally { repo.cleanup(); }
  }
});

test("Pact rejects invalid timestamp and mismatched provider commit before callback", async () => {
  const repo = fixture(); let called = false;
  const callback = async () => { called = true; throw new Error("must not run"); };
  try {
    await assert.rejects(verifyPactContracts(repo.root, repo.root, repo.policy, "yesterday", callback), /timestamp/);
    repo.policy.provider.commit = "0".repeat(40);
    await assert.rejects(verifyPactContracts(repo.root, repo.root, repo.policy, "2026-09-19T05:00:00Z", callback), /exact policy commit/);
    assert.equal(called, false);
  } finally { repo.cleanup(); }
});

test("Pact reports provider startup exceptions without raw error or stack", async () => {
  const repo = fixture();
  try {
    const report = await verifyPactContracts(repo.root, repo.root, repo.policy, "2026-09-19T05:00:00Z", async () => { throw new Error("synthetic internal provider detail"); });
    assert.equal(report.overallStatus, "FAIL"); assert.equal(report.technicalStatus, "FAIL");
    assert.equal(report.executionPerformed, false); assert.equal(report.cleanupStatus, "PASS");
    assert.doesNotMatch(JSON.stringify(report), /synthetic internal provider detail|pact-unit-|Error:/);
  } finally { repo.cleanup(); }
});

test("Pact rejects prototype keys and unsupported body values", () => {
  for (const body of [JSON.parse('{"__proto__":{"polluted":true}}'), { value: Number.POSITIVE_INFINITY }, { value: undefined }, { value: "\u0000" }, Array(257).fill(true)]) {
    const value = contract(); value.interactions[0].response.body = body;
    assert.equal(validatePactContract(value, policy(), 1).valid, false);
  }
});

test("Pact CLI validates and inspects without executing a provider", () => {
  const repo = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pact-cli-"));
  try {
    const filename = path.join(directory, "policy.json");
    fs.writeFileSync(filename, JSON.stringify(repo.policy));
    for (const args of [["validate", "--policy", filename], ["inspect", "--policy", filename, "--consumer-root", repo.root]]) {
      const result = spawnSync(process.execPath, ["scripts/pact-contract-integration.js", ...args, "--json"], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const report = JSON.parse(result.stdout);
      assert.equal(report.valid, true); assert.equal(report.executionPerformed, false);
    }
    fs.writeFileSync(filename, "{");
    const malformed = spawnSync(process.execPath, ["scripts/pact-contract-integration.js", "validate", "--policy", filename], { encoding: "utf8" });
    assert.equal(malformed.status, 1); assert.doesNotMatch(malformed.stderr, /pact-cli-|SyntaxError|stack/);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); repo.cleanup(); }
});

test("Pact verifier worker fails closed for foreign URLs malformed input and unknown options", () => {
  for (const input of ["{", "null", JSON.stringify({ baseUrl: "https://example.invalid", command: "ignored" })]) {
    const result = spawnSync(process.execPath, ["scripts/pact-verifier-worker.js"], { input, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 2, result.stderr);
    assert.equal(result.stdout, ""); assert.equal(result.stderr, "");
  }
});
