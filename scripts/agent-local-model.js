#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TYPES = new Set(["OLLAMA", "OPENAI_COMPATIBLE"]);
const THINKING = new Set(["DEFAULT", "DISABLED"]);
const ROLES = new Set(["system", "user"]);
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 4096) { if (typeof value !== "string") return null; const normalized = value.trim(); return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null; }
/** @param {unknown} value */
function id(value) { const normalized = text(value, 128); return normalized && ID.test(normalized) ? normalized : null; }
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }

/** @param {unknown} value */
function loopbackOrigin(value) {
  const raw = text(value, 2048); if (!raw) return null;
  let url; try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash || !url.port) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  const hostname = url.hostname.toLowerCase();
  if (hostname !== "127.0.0.1" && hostname !== "[::1]") return null;
  return url.origin;
}

/** @param {unknown} value */
export function validateAgentModelConfig(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, config: null, errors: [{ id: "config-invalid", detail: "agent model config must be an object" }] };
  unknown(value, ["version", "backends"], "config", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  /** @type {Array<any>} */ const backends = [];
  const backendIds = new Set();
  if (!Array.isArray(value.backends) || value.backends.length === 0 || value.backends.length > 16) errors.push({ id: "backends-invalid", detail: "backends must be a non-empty bounded array" });
  else for (const [index, raw] of value.backends.entries()) {
    if (!object(raw)) { errors.push({ id: "backend-invalid", detail: `backends[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "type", "baseUrl", "models"], "backend", errors);
    const backendId = id(raw.id), type = text(raw.type, 32), baseUrl = loopbackOrigin(raw.baseUrl);
    /** @type {Array<any>} */ const models = [];
    const modelIds = new Set();
    if (!Array.isArray(raw.models) || raw.models.length === 0 || raw.models.length > 64) errors.push({ id: "models-invalid", detail: `backends[${index}].models must be a non-empty bounded array` });
    else for (const [modelIndex, modelRaw] of raw.models.entries()) {
      if (!object(modelRaw)) { errors.push({ id: "model-invalid", detail: `backends[${index}].models[${modelIndex}] must be an object` }); continue; }
      unknown(modelRaw, ["id", "providerModel", "thinking"], "model", errors);
      const modelId = id(modelRaw.id), providerModel = text(modelRaw.providerModel, 512), thinking = modelRaw.thinking === undefined ? "DEFAULT" : text(modelRaw.thinking, 32);
      if (!modelId || modelIds.has(modelId) || !providerModel || !thinking || !THINKING.has(thinking)) { errors.push({ id: "model-fields-invalid", detail: `backends[${index}].models[${modelIndex}] is invalid or duplicate` }); continue; }
      modelIds.add(modelId); models.push({ id: modelId, providerModel, thinking });
    }
    if (!backendId || backendIds.has(backendId) || !type || !TYPES.has(type) || !baseUrl) { errors.push({ id: "backend-fields-invalid", detail: `backends[${index}] has invalid or duplicate id, type, or loopback baseUrl` }); continue; }
    if (type !== "OLLAMA" && models.some((model) => model.thinking !== "DEFAULT")) errors.push({ id: "thinking-provider-invalid", detail: `backends[${index}] thinking override is supported only for OLLAMA` });
    backendIds.add(backendId); backends.push({ id: backendId, type, baseUrl, models: models.sort((a, b) => a.id.localeCompare(b.id)) });
  }
  if (errors.length > 0) return { valid: false, config: null, errors };
  return { valid: true, config: { version: 1, backends: backends.sort((a, b) => a.id.localeCompare(b.id)) }, errors: [] };
}

/** @param {unknown} value */
export function validateAgentModelRequest(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, request: null, errors: [{ id: "request-invalid", detail: "agent model request must be an object" }] };
  unknown(value, ["version", "backend", "model", "messages", "temperature", "maxOutputTokens", "timeoutMs"], "request", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "request version must be exactly 1" });
  const backend = id(value.backend), model = id(value.model);
  if (!backend || !model) errors.push({ id: "model-identity-invalid", detail: "request backend and model must be portable identifiers" });
  const temperature = typeof value.temperature === "number" && Number.isFinite(value.temperature) && value.temperature >= 0 && value.temperature <= 2 ? value.temperature : null;
  const maxOutputTokens = integer(value.maxOutputTokens, 1, 8192), timeoutMs = integer(value.timeoutMs, 1000, 300000);
  if (temperature === null || maxOutputTokens === null || timeoutMs === null) errors.push({ id: "generation-options-invalid", detail: "temperature, maxOutputTokens, or timeoutMs is invalid" });
  /** @type {Array<{role:"system"|"user",content:string}>} */ const messages = [];
  if (!Array.isArray(value.messages) || value.messages.length === 0 || value.messages.length > 8) errors.push({ id: "messages-invalid", detail: "messages must be a non-empty bounded array" });
  else for (const [index, raw] of value.messages.entries()) {
    if (!object(raw)) { errors.push({ id: "message-invalid", detail: `messages[${index}] must be an object` }); continue; }
    unknown(raw, ["role", "content"], "message", errors);
    const role = text(raw.role, 16), content = typeof raw.content === "string" && raw.content.length > 0 && Buffer.byteLength(raw.content, "utf8") <= MAX_PROMPT_BYTES && !raw.content.includes("\u0000") ? raw.content : null;
    if (!role || !ROLES.has(role) || !content) { errors.push({ id: "message-fields-invalid", detail: `messages[${index}] has invalid role or bounded content` }); continue; }
    messages.push({ role: /** @type {"system"|"user"} */ (role), content });
  }
  if (errors.length > 0 || !backend || !model || temperature === null || maxOutputTokens === null || timeoutMs === null) return { valid: false, request: null, errors };
  return { valid: true, request: { version: 1, backend, model, messages, temperature, maxOutputTokens, timeoutMs }, errors: [] };
}

/** @param {string} filename @param {number} maxBytes */
function readRegularTextFile(filename, maxBytes) {
  const resolved = path.resolve(filename);
  let stat; try { stat = fs.lstatSync(resolved); } catch { throw new Error("local model input file is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) throw new Error("local model input must be a bounded non-empty regular file");
  const bytes = fs.readFileSync(resolved); if (bytes.includes(0)) throw new Error("local model input contains binary NUL content");
  return bytes.toString("utf8");
}

/** @param {string} filename */
export function readAgentPromptFile(filename) { return readRegularTextFile(filename, MAX_PROMPT_BYTES); }

/** @param {string} filename */
export function readAgentModelConfigFile(filename) {
  let raw; try { raw = JSON.parse(readRegularTextFile(filename, MAX_CONFIG_BYTES)); } catch { throw new Error("agent model config cannot be read or parsed"); }
  const result = validateAgentModelConfig(raw); if (!result.valid || !result.config) throw new Error("agent model config is invalid");
  return result.config;
}

/** @param {Response} response */
async function boundedJson(response) {
  if (!response.body) throw new Error("local model provider returned an empty response");
  const reader = response.body.getReader();
  /** @type {Uint8Array[]} */ const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    if (!value) continue;
    total += value.byteLength; if (total > MAX_RESPONSE_BYTES) { try { await reader.cancel(); } catch { /* ignore */ } throw new Error("local model provider response exceeds bounded size"); }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks.map((value) => Buffer.from(value)));
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error("local model provider returned malformed JSON"); }
}

/** @param {any} config @param {any} request @param {{fetchImpl?:typeof fetch}} [dependencies] */
export async function invokeAgentLocalModel(config, request, dependencies = {}) {
  const backend = config.backends.find((/** @type {any} */ item) => item.id === request.backend);
  if (!backend) throw new Error("requested local model backend is not configured");
  const model = backend.models.find((/** @type {any} */ item) => item.id === request.model);
  if (!model) throw new Error("requested symbolic local model is not configured for the backend");
  const fetchImpl = dependencies.fetchImpl ?? globalThis.fetch;
  const endpoint = backend.type === "OLLAMA" ? `${backend.baseUrl}/api/chat` : `${backend.baseUrl}/v1/chat/completions`;
  const payload = backend.type === "OLLAMA"
    ? { model: model.providerModel, messages: request.messages, stream: false, ...(model.thinking === "DISABLED" ? { think: false } : {}), options: { temperature: request.temperature, num_predict: request.maxOutputTokens } }
    : { model: model.providerModel, messages: request.messages, stream: false, temperature: request.temperature, max_tokens: request.maxOutputTokens };
  let response;
  try {
    response = await fetchImpl(endpoint, { method: "POST", redirect: "error", headers: { "content-type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(request.timeoutMs) });
  } catch { throw new Error("local model provider request failed"); }
  if (!response.ok) throw new Error(`local model provider returned HTTP ${response.status}`);
  const raw = await boundedJson(response);
  if (!object(raw)) throw new Error("local model provider response must be an object");
  let content = null, finishReason = null, inputTokens = null, outputTokens = null;
  if (backend.type === "OLLAMA") {
    content = object(raw.message) && typeof raw.message.content === "string" ? raw.message.content : null;
    finishReason = text(raw.done_reason, 128) ?? (raw.done === true ? "stop" : null);
    inputTokens = integer(raw.prompt_eval_count, 0, Number.MAX_SAFE_INTEGER);
    outputTokens = integer(raw.eval_count, 0, Number.MAX_SAFE_INTEGER);
  } else {
    const first = Array.isArray(raw.choices) ? raw.choices[0] : null;
    content = object(first) && object(first.message) && typeof first.message.content === "string" ? first.message.content : null;
    finishReason = object(first) ? text(first.finish_reason, 128) : null;
    inputTokens = object(raw.usage) ? integer(raw.usage.prompt_tokens, 0, Number.MAX_SAFE_INTEGER) : null;
    outputTokens = object(raw.usage) ? integer(raw.usage.completion_tokens, 0, Number.MAX_SAFE_INTEGER) : null;
  }
  if (content === null || Buffer.byteLength(content, "utf8") > MAX_RESPONSE_BYTES || content.includes("\u0000")) throw new Error("local model provider response content is invalid or oversized");
  return {
    version: 1,
    backend: request.backend,
    model: request.model,
    content,
    finishReason: finishReason ?? "unknown",
    usage: { inputTokens, outputTokens },
    semantics: "response from one explicitly selected worker-local backend; no fallback backend or cloud provider is attempted",
  };
}

/** @param {string[]} argv */
function parse(argv) {
  const values = new Map(), flags = new Set(), allowed = new Set(["--config", "--backend", "--model", "--prompt-file", "--system-file", "--temperature", "--max-output-tokens", "--timeout-ms"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]; if (arg === "--json") { if (flags.has(arg)) return null; flags.add(arg); continue; }
    if (!allowed.has(arg ?? "") || values.has(arg)) return null;
    const next = argv[index + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; values.set(arg, next); index += 1;
  }
  for (const required of ["--config", "--backend", "--model", "--prompt-file", "--temperature", "--max-output-tokens", "--timeout-ms"]) if (!values.has(required)) return null;
  return { values, json: flags.has("--json") };
}

/** @param {string[]} argv @param {{fetchImpl?:typeof fetch}} [dependencies] */
export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/agent-local-model.js --config <private-config.json> --backend <id> --model <id> --prompt-file <file> [--system-file <file>] --temperature <0..2> --max-output-tokens <n> --timeout-ms <n> [--json]"); return 1; }
  try {
    const config = readAgentModelConfigFile(options.values.get("--config"));
    const messages = [];
    const systemFile = options.values.get("--system-file"); if (systemFile) messages.push({ role: "system", content: readAgentPromptFile(systemFile) });
    messages.push({ role: "user", content: readAgentPromptFile(options.values.get("--prompt-file")) });
    const rawRequest = { version: 1, backend: options.values.get("--backend"), model: options.values.get("--model"), messages, temperature: Number(options.values.get("--temperature")), maxOutputTokens: Number(options.values.get("--max-output-tokens")), timeoutMs: Number(options.values.get("--timeout-ms")) };
    const request = validateAgentModelRequest(rawRequest); if (!request.valid || !request.request) throw new Error("agent model request is invalid");
    const result = await invokeAgentLocalModel(config, request.request, dependencies);
    console.log(options.json ? JSON.stringify(result) : result.content);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "local model invocation failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = await main();
