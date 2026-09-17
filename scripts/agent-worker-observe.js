#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateAgentWorker } from "./agent-worker.js";
import { readAgentModelConfigFile } from "./agent-local-model.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CLASSES = new Set(["PERSISTENT", "COMPUTE"]);
const STATES = new Set(["ONLINE", "DRAINING", "OFFLINE"]);
const MODEL_CLASSES = new Set(["SMALL", "STANDARD", "STRONG", "REVIEW"]);
const MAX_DECLARATION_BYTES = 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v) ? v : null; }
/** @param {unknown} value */
function id(value) { const v = text(value, 128); return v && ID.test(v) ? v : null; }
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value @param {boolean} allowEmpty */
function ids(value, allowEmpty) { if (!Array.isArray(value) || value.length > 256 || (!allowEmpty && value.length === 0)) return null; const out = value.map(id); if (out.some((item) => item === null)) return null; const items = /** @type {string[]} */ (out); return new Set(items).size === items.length ? items.sort() : null; }

/** @param {unknown} value */
export function validateAgentWorkerDeclaration(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, declaration: null, errors: [{ id: "declaration-invalid", detail: "worker declaration must be an object" }] };
  unknown(value, ["version", "id", "class", "state", "gpu", "capabilities", "execution", "load", "models"], "declaration", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "declaration version must be exactly 1" });
  const workerId = id(value.id), workerClass = text(value.class, 32), state = text(value.state, 32), capabilities = ids(value.capabilities, false);
  if (!workerId || !workerClass || !CLASSES.has(workerClass) || !state || !STATES.has(state) || !capabilities) errors.push({ id: "identity-invalid", detail: "worker id, class, state, or capabilities are invalid" });

  let gpu = null;
  if (value.gpu !== null) {
    if (!object(value.gpu)) errors.push({ id: "gpu-invalid", detail: "gpu must be null or an object" });
    else {
      unknown(value.gpu, ["vendor", "name", "vramMiB"], "gpu", errors);
      const vendor = id(value.gpu.vendor), name = text(value.gpu.name, 256), vramMiB = integer(value.gpu.vramMiB, 128, 1024 * 1024);
      if (!vendor || !name || !vramMiB) errors.push({ id: "gpu-fields-invalid", detail: "gpu metadata is invalid" });
      else gpu = { vendor, name, vramMiB };
    }
  }

  let execution = null;
  if (!object(value.execution)) errors.push({ id: "execution-invalid", detail: "execution must be an object" });
  else {
    unknown(value.execution, ["worktrees", "maxReadOnlyTasks", "maxWriteTasks"], "execution", errors);
    const worktrees = value.execution.worktrees, maxReadOnlyTasks = integer(value.execution.maxReadOnlyTasks, 1, 1024), maxWriteTasks = integer(value.execution.maxWriteTasks, 0, 128);
    if (typeof worktrees !== "boolean" || !maxReadOnlyTasks || maxWriteTasks === null || (!worktrees && maxWriteTasks > 0)) errors.push({ id: "execution-fields-invalid", detail: "execution metadata is invalid" });
    else execution = { worktrees, maxReadOnlyTasks, maxWriteTasks };
  }

  let load = null;
  if (!object(value.load)) errors.push({ id: "load-invalid", detail: "load must be an object" });
  else {
    unknown(value.load, ["readOnlyTasks", "writeTasks"], "load", errors);
    const readOnlyTasks = integer(value.load.readOnlyTasks, 0, 1024), writeTasks = integer(value.load.writeTasks, 0, 128);
    if (readOnlyTasks === null || writeTasks === null || (execution && (readOnlyTasks > execution.maxReadOnlyTasks || writeTasks > execution.maxWriteTasks))) errors.push({ id: "load-fields-invalid", detail: "load is invalid or exceeds declared capacity" });
    else load = { readOnlyTasks, writeTasks };
  }

  /** @type {Array<any>} */ const models = [];
  const modelIds = new Set();
  if (!Array.isArray(value.models) || value.models.length > 64) errors.push({ id: "models-invalid", detail: "models must be a bounded array" });
  else for (const [index, raw] of value.models.entries()) {
    if (!object(raw)) { errors.push({ id: "model-invalid", detail: `models[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "class", "backend", "contextTokens", "toolUse"], "model", errors);
    const modelId = id(raw.id), modelClass = text(raw.class, 32), backend = id(raw.backend), contextTokens = integer(raw.contextTokens, 1024, 4 * 1024 * 1024);
    if (!modelId || modelIds.has(modelId) || !modelClass || !MODEL_CLASSES.has(modelClass) || !backend || !contextTokens || typeof raw.toolUse !== "boolean") { errors.push({ id: "model-fields-invalid", detail: `models[${index}] is invalid or duplicate` }); continue; }
    modelIds.add(modelId); models.push({ id: modelId, class: modelClass, backend, contextTokens, toolUse: raw.toolUse });
  }
  if (errors.length > 0 || !workerId || !workerClass || !state || !capabilities || !execution || !load) return { valid: false, declaration: null, errors };
  return { valid: true, declaration: { version: 1, id: workerId, class: workerClass, state, gpu, capabilities, execution, load, models: models.sort((a, b) => a.id.localeCompare(b.id)) }, errors: [] };
}

/** @param {string} filename */
function readDeclaration(filename) {
  const resolved = path.resolve(filename); let stat; try { stat = fs.lstatSync(resolved); } catch { throw new Error("worker declaration is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_DECLARATION_BYTES) throw new Error("worker declaration must be a bounded regular non-symlink file");
  let raw; try { raw = JSON.parse(fs.readFileSync(resolved, "utf8")); } catch { throw new Error("worker declaration cannot be parsed"); }
  const result = validateAgentWorkerDeclaration(raw); if (!result.valid || !result.declaration) throw new Error("worker declaration is invalid");
  return result.declaration;
}

/** @param {any} declaration @param {any|null} modelConfig @param {{cpuCores?:()=>number,memoryMiB?:()=>number,clock?:()=>string}} [deps] */
export function observeAgentWorker(declaration, modelConfig, deps = {}) {
  const cpuCores = deps.cpuCores ? deps.cpuCores() : os.availableParallelism();
  const memoryMiB = deps.memoryMiB ? deps.memoryMiB() : Math.floor(os.totalmem() / 1024 / 1024);
  if (!Number.isSafeInteger(cpuCores) || cpuCores < 1 || !Number.isSafeInteger(memoryMiB) || memoryMiB < 256) throw new Error("local worker resources are outside Agent Worker v1 bounds");
  if (declaration.models.length > 0 && !modelConfig) throw new Error("model-bearing worker declaration requires explicit private model config");
  if (modelConfig) {
    for (const model of declaration.models) {
      const backend = modelConfig.backends.find((/** @type {any} */ item) => item.id === model.backend);
      if (!backend || !backend.models.some((/** @type {any} */ item) => item.id === model.id)) throw new Error(`symbolic worker model ${model.backend}/${model.id} is absent from private local model config`);
    }
  }
  const observedAt = deps.clock ? deps.clock() : new Date().toISOString();
  if (!isAbsoluteIsoTimestamp(observedAt)) throw new Error("worker observation clock returned an invalid timestamp");
  const candidate = { version: 1, id: declaration.id, class: declaration.class, state: declaration.state, observedAt, resources: { cpuCores, memoryMiB, gpu: declaration.gpu }, capabilities: declaration.capabilities, execution: declaration.execution, load: declaration.load, models: declaration.models };
  const validated = validateAgentWorker(candidate); if (!validated.valid || !validated.worker) throw new Error("observed worker does not satisfy Agent Worker v1");
  return validated.worker;
}

/** @param {string[]} argv */
function parse(argv) { let declaration = null, modelConfig = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--declaration", "--model-config"].includes(arg ?? "")) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; i += 1; if (arg === "--declaration") { if (declaration) return null; declaration = next; } else { if (modelConfig) return null; modelConfig = next; } } return declaration ? { declaration, modelConfig, json } : null; }

/** @param {string[]} argv @param {{cpuCores?:()=>number,memoryMiB?:()=>number,clock?:()=>string}} [deps] */
export function main(argv = process.argv.slice(2), deps = {}) {
  const options = parse(argv); if (!options) { console.error("Usage: node scripts/agent-worker-observe.js --declaration <private-worker.json> [--model-config <private-models.json>] [--json]"); return 1; }
  try {
    const declaration = readDeclaration(options.declaration);
    const modelConfig = options.modelConfig ? readAgentModelConfigFile(options.modelConfig) : null;
    const worker = observeAgentWorker(declaration, modelConfig, deps);
    console.log(options.json ? JSON.stringify(worker) : JSON.stringify(worker, null, 2));
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : "worker observation failed"); return 1; }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
