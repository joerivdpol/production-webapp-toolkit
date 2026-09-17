import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateAgentModelConfig,
  validateAgentModelRequest,
  readAgentPromptFile,
  readAgentModelConfigFile,
  invokeAgentLocalModel,
  main,
} from "../scripts/agent-local-model.js";

/** @returns {any} */
function rawConfig() {
  return {
    version: 1,
    backends: [
      { id: "local-a", type: "OLLAMA", baseUrl: "http://127.0.0.1:18080", models: [{ id: "small", providerModel: "synthetic-small", thinking: "DISABLED" }] },
      { id: "local-b", type: "OPENAI_COMPATIBLE", baseUrl: "http://127.0.0.1:18081", models: [{ id: "standard", providerModel: "synthetic-standard", thinking: "DEFAULT" }] },
    ],
  };
}

/** @param {string} backend @param {string} model @returns {any} */
function rawRequest(backend = "local-a", model = "small") {
  return { version: 1, backend, model, messages: [{ role: "system", content: "Follow bounded instructions." }, { role: "user", content: "Reply with READY." }], temperature: 0, maxOutputTokens: 32, timeoutMs: 5000 };
}
function config(raw = rawConfig()) { const result = validateAgentModelConfig(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.config) throw new Error("config invalid"); return result.config; }
function request(raw = rawRequest()) { const result = validateAgentModelRequest(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.request) throw new Error("request invalid"); return result.request; }

/** @param {string} prefix @param {string} contents */
function tempText(prefix, contents) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.txt`); fs.writeFileSync(file, contents); return file; }
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; }

test("model config accepts explicit Ollama and OpenAI-compatible loopback backends", () => {
  const result = validateAgentModelConfig(rawConfig());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.config?.backends.map((item) => item.id), ["local-a", "local-b"]);
});

test("model config rejects non-loopback, hostname, TLS, credentials, paths, and missing ports", () => {
  for (const baseUrl of [
    "http://192.168.1.10:11434", "http://localhost:11434", "https://127.0.0.1:11434",
    "http://user:pass@127.0.0.1:11434", "http://127.0.0.1:11434/api", "http://127.0.0.1",
  ]) {
    const raw = rawConfig(); raw.backends[0].baseUrl = baseUrl;
    assert.equal(validateAgentModelConfig(raw).valid, false, baseUrl);
  }
});

test("model config rejects duplicate ids and provider-specific thinking on OpenAI-compatible backend", () => {
  const duplicateBackend = rawConfig(); duplicateBackend.backends[1].id = "local-a";
  assert.equal(validateAgentModelConfig(duplicateBackend).valid, false);
  const duplicateModel = rawConfig(); duplicateModel.backends[0].models.push({ ...duplicateModel.backends[0].models[0] });
  assert.equal(validateAgentModelConfig(duplicateModel).valid, false);
  const thinking = rawConfig(); thinking.backends[1].models[0].thinking = "DISABLED";
  assert.equal(validateAgentModelConfig(thinking).valid, false);
});

test("model request requires bounded messages and generation options", () => {
  assert.equal(validateAgentModelRequest(rawRequest()).valid, true);
  const empty = rawRequest(); empty.messages = [];
  assert.equal(validateAgentModelRequest(empty).valid, false);
  const badRole = rawRequest(); badRole.messages[0].role = "tool";
  assert.equal(validateAgentModelRequest(badRole).valid, false);
  const badTokens = rawRequest(); badTokens.maxOutputTokens = 100000;
  assert.equal(validateAgentModelRequest(badTokens).valid, false);
  const badTimeout = rawRequest(); badTimeout.timeoutMs = 500;
  assert.equal(validateAgentModelRequest(badTimeout).valid, false);
});

test("prompt and config readers reject symlinks, empty, binary, and malformed input", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-model-files-"));
  try {
    const prompt = path.join(root, "prompt.txt"); fs.writeFileSync(prompt, "hello");
    assert.equal(readAgentPromptFile(prompt), "hello");
    const link = path.join(root, "link.txt"); fs.symlinkSync(prompt, link);
    assert.throws(() => readAgentPromptFile(link), /regular file/);
    const empty = path.join(root, "empty.txt"); fs.writeFileSync(empty, "");
    assert.throws(() => readAgentPromptFile(empty), /regular file/);
    const binary = path.join(root, "binary.txt"); fs.writeFileSync(binary, Buffer.from([65, 0, 66]));
    assert.throws(() => readAgentPromptFile(binary), /binary NUL/);
    const badJson = path.join(root, "config.json"); fs.writeFileSync(badJson, "{");
    assert.throws(() => readAgentModelConfigFile(badJson), /cannot be read or parsed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Ollama adapter sends exactly one loopback request and disables thinking when configured", async () => {
  /** @type {Array<{url:string,init:any}>} */ const calls = [];
  const fetchImpl = async (/** @type {any} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ message: { role: "assistant", content: "READY" }, done: true, done_reason: "stop", prompt_eval_count: 7, eval_count: 2 }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const result = await invokeAgentLocalModel(config(), request(), { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:18080/api/chat");
  assert.equal(calls[0]?.init?.method, "POST");
  assert.equal(calls[0]?.init?.redirect, "error");
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(body.model, "synthetic-small");
  assert.equal(body.think, false);
  assert.equal(body.options.num_predict, 32);
  assert.equal(result.content, "READY");
  assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 2 });
});

test("OpenAI-compatible adapter uses explicit selected backend without fallback", async () => {
  /** @type {Array<{url:string,init:any}>} */ const calls = [];
  const fetchImpl = async (/** @type {any} */ url, /** @type {any} */ init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 9, completion_tokens: 3 } }), { status: 200 });
  };
  const result = await invokeAgentLocalModel(config(), request(rawRequest("local-b", "standard")), { fetchImpl });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "http://127.0.0.1:18081/v1/chat/completions");
  const body = JSON.parse(String(calls[0]?.init?.body));
  assert.equal(body.model, "synthetic-standard");
  assert.equal(body.max_tokens, 32);
  assert.equal(result.content, "OK");
});

test("provider failure never attempts another configured backend", async () => {
  /** @type {string[]} */ const calls = [];
  const fetchImpl = async (/** @type {any} */ url) => { calls.push(String(url)); throw new Error("synthetic provider failure"); };
  await assert.rejects(() => invokeAgentLocalModel(config(), request(), { fetchImpl }), /provider request failed/);
  assert.deepEqual(calls, ["http://127.0.0.1:18080/api/chat"]);
});

test("normalized model result omits endpoint provider model and prompt payload", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ message: { content: "private answer" }, done: true, eval_count: 1, prompt_eval_count: 1 }), { status: 200 });
  const result = await invokeAgentLocalModel(config(), request(), { fetchImpl });
  const output = JSON.stringify(result);
  assert.doesNotMatch(output, /18080|synthetic-small|Reply with READY|Follow bounded/);
  assert.match(output, /private answer/);
  assert.equal(result.semantics.includes("no fallback"), true);
});

test("malformed and non-success provider responses fail closed without raw provider payload", async () => {
  await assert.rejects(() => invokeAgentLocalModel(config(), request(), { fetchImpl: async () => new Response("private-error-body", { status: 503 }) }), /HTTP 503/);
  await assert.rejects(() => invokeAgentLocalModel(config(), request(), { fetchImpl: async () => new Response("not-json", { status: 200 }) }), /malformed JSON/);
  await assert.rejects(() => invokeAgentLocalModel(config(), request(), { fetchImpl: async () => new Response(JSON.stringify({ done: true }), { status: 200 }) }), /content is invalid/);
});

test("CLI reads private files and can use injected loopback provider without leaking config", async () => {
  const configFile = tempJson("agent-model-config", rawConfig()), promptFile = tempText("agent-prompt", "Reply READY"), systemFile = tempText("agent-system", "Be concise");
  const originalLog = console.log, originalError = console.error; let stdout = "", stderr = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; }; console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    const fetchImpl = async () => new Response(JSON.stringify({ message: { content: "READY" }, done: true, prompt_eval_count: 2, eval_count: 1 }), { status: 200 });
    const code = await main(["--config", configFile, "--backend", "local-a", "--model", "small", "--prompt-file", promptFile, "--system-file", systemFile, "--temperature", "0", "--max-output-tokens", "16", "--timeout-ms", "5000", "--json"], { fetchImpl });
    assert.equal(code, 0); assert.equal(stderr, "");
    const result = JSON.parse(stdout); assert.equal(result.content, "READY");
    assert.doesNotMatch(stdout, /18080|synthetic-small|Be concise|Reply READY/);
  } finally {
    console.log = originalLog; console.error = originalError;
    for (const file of [configFile, promptFile, systemFile]) fs.rmSync(file, { force: true });
  }
});

test("adapter source has no child process environment secret or cloud fallback surface", () => {
  const source = fs.readFileSync(new URL("../scripts/agent-local-model.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|process\.env|api\.openai\.com|anthropic|gemini|authorization/i);
  assert.match(source, /127\.0\.0\.1/);
  assert.match(source, /redirect: "error"/);
});
