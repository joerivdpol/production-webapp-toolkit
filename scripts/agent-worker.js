#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const CLASSES = new Set(["PERSISTENT", "COMPUTE"]);
const STATES = new Set(["ONLINE", "DRAINING", "OFFLINE"]);
const MODEL_CLASSES = new Set(["SMALL", "STANDARD", "STRONG", "REVIEW"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v) ? v : null; }
/** @param {unknown} value */
function id(value) { const v = text(value, 128); return v && ID.test(v) ? v : null; }
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) { return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null; }
/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value @param {boolean} [allowEmpty] */
function idList(value, allowEmpty = true) { if (!Array.isArray(value) || value.length > 256 || (!allowEmpty && value.length === 0)) return null; const out = value.map(id); if (out.some((v) => v === null)) return null; const items = out; return new Set(items).size === items.length ? items.sort() : null; }

/** @param {unknown} value */
export function validateAgentWorker(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, worker: null, errors: [{ id: "worker-invalid", detail: "agent worker must be an object" }] };
  unknown(value, ["version", "id", "class", "state", "observedAt", "resources", "capabilities", "execution", "load", "models"], "worker", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const workerId = id(value.id); if (!workerId) errors.push({ id: "id-invalid", detail: "worker id must be portable" });
  const workerClass = text(value.class, 32); if (!workerClass || !CLASSES.has(workerClass)) errors.push({ id: "class-invalid", detail: "worker class must be PERSISTENT or COMPUTE" });
  const state = text(value.state, 32); if (!state || !STATES.has(state)) errors.push({ id: "state-invalid", detail: "worker state is unsupported" });
  const observedAt = text(value.observedAt, 128); if (!observedAt || !isAbsoluteIsoTimestamp(observedAt)) errors.push({ id: "observed-at-invalid", detail: "observedAt must be an absolute ISO timestamp" });

  let resources = null;
  if (!object(value.resources)) errors.push({ id: "resources-invalid", detail: "resources must be an object" });
  else {
    unknown(value.resources, ["cpuCores", "memoryMiB", "gpu"], "resources", errors);
    const cpuCores = integer(value.resources.cpuCores, 1, 4096), memoryMiB = integer(value.resources.memoryMiB, 256, 16 * 1024 * 1024);
    let gpu = null;
    if (value.resources.gpu !== null) {
      if (!object(value.resources.gpu)) errors.push({ id: "gpu-invalid", detail: "gpu must be null or an object" });
      else {
        unknown(value.resources.gpu, ["vendor", "name", "vramMiB"], "gpu", errors);
        const vendor = id(value.resources.gpu.vendor), name = text(value.resources.gpu.name, 256), vramMiB = integer(value.resources.gpu.vramMiB, 128, 1024 * 1024);
        if (!vendor || !name || !vramMiB) errors.push({ id: "gpu-fields-invalid", detail: "gpu fields are invalid" });
        else gpu = { vendor, name, vramMiB };
      }
    }
    if (!cpuCores || !memoryMiB) errors.push({ id: "resource-fields-invalid", detail: "cpuCores and memoryMiB must be positive bounded integers" });
    else resources = { cpuCores, memoryMiB, gpu };
  }
  const capabilities = idList(value.capabilities, false); if (!capabilities) errors.push({ id: "capabilities-invalid", detail: "capabilities must be a non-empty unique id array" });

  let execution = null;
  if (!object(value.execution)) errors.push({ id: "execution-invalid", detail: "execution must be an object" });
  else {
    unknown(value.execution, ["worktrees", "maxReadOnlyTasks", "maxWriteTasks"], "execution", errors);
    const worktrees = value.execution.worktrees, maxReadOnlyTasks = integer(value.execution.maxReadOnlyTasks, 1, 1024), maxWriteTasks = integer(value.execution.maxWriteTasks, 0, 128);
    if (typeof worktrees !== "boolean" || !maxReadOnlyTasks || maxWriteTasks === null) errors.push({ id: "execution-fields-invalid", detail: "execution fields are invalid" });
    else if (!worktrees && maxWriteTasks > 0) errors.push({ id: "execution-worktree-invalid", detail: "write tasks require worktree support" });
    else execution = { worktrees, maxReadOnlyTasks, maxWriteTasks };
  }

  let load = null;
  if (!object(value.load)) errors.push({ id: "load-invalid", detail: "load must be an object" });
  else {
    unknown(value.load, ["readOnlyTasks", "writeTasks"], "load", errors);
    const readOnlyTasks = integer(value.load.readOnlyTasks, 0, 1024), writeTasks = integer(value.load.writeTasks, 0, 128);
    if (readOnlyTasks === null || writeTasks === null) errors.push({ id: "load-fields-invalid", detail: "load counters must be non-negative bounded integers" });
    else if (execution && (readOnlyTasks > execution.maxReadOnlyTasks || writeTasks > execution.maxWriteTasks)) errors.push({ id: "load-capacity-invalid", detail: "active load cannot exceed declared worker capacity" });
    else load = { readOnlyTasks, writeTasks };
  }

  const models = [];
  const modelIds = new Set();
  if (!Array.isArray(value.models) || value.models.length > 64) errors.push({ id: "models-invalid", detail: "models must be a bounded array" });
  else for (const [index, raw] of value.models.entries()) {
    if (!object(raw)) { errors.push({ id: "model-invalid", detail: `models[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "class", "backend", "contextTokens", "toolUse"], "model", errors);
    const modelId = id(raw.id), modelClass = text(raw.class, 32), backend = id(raw.backend), contextTokens = integer(raw.contextTokens, 1024, 4 * 1024 * 1024), toolUse = raw.toolUse;
    if (!modelId || modelIds.has(modelId) || !modelClass || !MODEL_CLASSES.has(modelClass) || !backend || !contextTokens || typeof toolUse !== "boolean") { errors.push({ id: "model-fields-invalid", detail: `models[${index}] has invalid or duplicate fields` }); continue; }
    modelIds.add(modelId); models.push({ id: modelId, class: modelClass, backend, contextTokens, toolUse });
  }
  if (errors.length > 0 || !workerId || !workerClass || !state || !observedAt || !resources || !capabilities || !execution || !load) return { valid: false, worker: null, errors };
  return { valid: true, worker: { version: 1, id: workerId, class: workerClass, state, observedAt, resources, capabilities, execution, load, models: models.sort((a, b) => a.id.localeCompare(b.id)) }, errors: [] };
}

/** @param {any} worker */
export function formatAgentWorker(worker) {
  return ["Agent Worker v1", "", `Worker: ${worker.id}`, `Class: ${worker.class}`, `State: ${worker.state}`, `Observed at: ${worker.observedAt}`, `CPU cores: ${worker.resources.cpuCores}`, `Memory MiB: ${worker.resources.memoryMiB}`, `GPU: ${worker.resources.gpu ? `${worker.resources.gpu.name} (${worker.resources.gpu.vramMiB} MiB)` : "none"}`, `Capabilities: ${worker.capabilities.join(", ")}`, `Load: ${worker.load.readOnlyTasks} read / ${worker.load.writeTasks} write`, `Models: ${worker.models.map((/** @type {any} */ m) => `${m.id}:${m.class}`).join(", ") || "none"}`, "Result: VALID"].join("\n");
}
/** @param {string[]} argv */
function parse(argv) { let file = null, json = false; for (let i = 0; i < argv.length; i += 1) { const a = argv[i]; if (a === "--json") { json = true; continue; } if (a !== "--file" || file !== null) return null; const v = argv[i + 1]; if (typeof v !== "string" || v.startsWith("--")) return null; file = v; i += 1; } return file ? { file, json } : null; }
/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/agent-worker.js --file <agent-worker.json> [--json]"); return 1; } let raw; try { raw = JSON.parse(fs.readFileSync(options.file, "utf8")); } catch { console.error("Agent worker cannot be read or parsed"); return 1; } const result = validateAgentWorker(raw); if (!result.valid || !result.worker) { console.error("Agent worker is invalid"); return 1; } console.log(options.json ? JSON.stringify(result.worker) : formatAgentWorker(result.worker)); return 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
