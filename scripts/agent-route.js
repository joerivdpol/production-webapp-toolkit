#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateAgentTask } from "./agent-task.js";
import { validateAgentWorker } from "./agent-worker.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const MODEL_CLASSES = new Set(["SMALL", "STANDARD", "STRONG", "REVIEW"]);
const WORKER_CLASSES = new Set(["PERSISTENT", "COMPUTE"]);
const FILESYSTEM = new Set(["READ_ONLY", "WORKTREE_WRITE"]);
const SHELL = new Set(["NONE", "BOUNDED"]);
const NETWORK = new Set(["NONE", "READ_ONLY"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const RISK_RANK = new Map([["LOW", 0], ["MEDIUM", 1], ["HIGH", 2], ["CRITICAL", 3]]);
const AUTH_RANK = {
  filesystem: new Map([["READ_ONLY", 0], ["WORKTREE_WRITE", 1]]),
  shell: new Map([["NONE", 0], ["BOUNDED", 1]]),
  network: new Map([["NONE", 0], ["READ_ONLY", 1]]),
};

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
/** @param {unknown} value @param {(value:unknown)=>string|null} validator @param {boolean} [allowEmpty] @param {number} [max] */
function uniqueList(value, validator, allowEmpty = false, max = 64) { if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) return null; const out = value.map(validator); if (out.some((v) => v === null)) return null; const items = out; return new Set(items).size === items.length ? items : null; }
/** @param {Set<string>} set */
function enumValue(set) { return (/** @type {unknown} */ value) => { const v = text(value, 32); return v && set.has(v) ? v : null; }; }

/** @param {unknown} value */
export function validateAgentRoutingPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "agent routing policy must be an object" }] };
  unknown(value, ["version", "maxWorkerAgeSeconds", "roles"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const maxWorkerAgeSeconds = integer(value.maxWorkerAgeSeconds, 1, 86400); if (!maxWorkerAgeSeconds) errors.push({ id: "max-worker-age-invalid", detail: "maxWorkerAgeSeconds must be a positive bounded integer" });
  const roles = [];
  const ids = new Set();
  if (!Array.isArray(value.roles) || value.roles.length === 0 || value.roles.length > 64) errors.push({ id: "roles-invalid", detail: "roles must be a non-empty bounded array" });
  else for (const [index, raw] of value.roles.entries()) {
    if (!object(raw)) { errors.push({ id: "role-invalid", detail: `roles[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "requiredCapabilities", "preferredWorkerClasses", "preferredModelClasses", "minMemoryMiB", "minContextTokens", "requireToolUse", "maxRisk", "authority"], "role", errors);
    const roleId = id(raw.id), requiredCapabilities = uniqueList(raw.requiredCapabilities, id, true, 128), preferredWorkerClasses = uniqueList(raw.preferredWorkerClasses, enumValue(WORKER_CLASSES)), preferredModelClasses = uniqueList(raw.preferredModelClasses, enumValue(MODEL_CLASSES));
    const minMemoryMiB = integer(raw.minMemoryMiB, 256, 16 * 1024 * 1024), minContextTokens = integer(raw.minContextTokens, 1024, 4 * 1024 * 1024), requireToolUse = raw.requireToolUse, maxRisk = text(raw.maxRisk, 32);
    let authority = null;
    if (!object(raw.authority)) errors.push({ id: "role-authority-invalid", detail: `roles[${index}].authority must be an object` });
    else {
      unknown(raw.authority, ["filesystem", "shell", "network"], "role-authority", errors);
      const filesystem = text(raw.authority.filesystem, 32), shell = text(raw.authority.shell, 32), network = text(raw.authority.network, 32);
      if (!filesystem || !FILESYSTEM.has(filesystem) || !shell || !SHELL.has(shell) || !network || !NETWORK.has(network)) errors.push({ id: "role-authority-fields-invalid", detail: `roles[${index}].authority is invalid` });
      else authority = { filesystem, shell, network };
    }
    if (!roleId || ids.has(roleId) || !requiredCapabilities || !preferredWorkerClasses || !preferredModelClasses || !minMemoryMiB || !minContextTokens || typeof requireToolUse !== "boolean" || !maxRisk || !RISK_RANK.has(maxRisk) || !authority) {
      errors.push({ id: "role-fields-invalid", detail: `roles[${index}] has invalid or duplicate fields` }); continue;
    }
    ids.add(roleId); roles.push({ id: roleId, requiredCapabilities: requiredCapabilities.sort(), preferredWorkerClasses, preferredModelClasses, minMemoryMiB, minContextTokens, requireToolUse, maxRisk, authority });
  }
  if (errors.length > 0 || !maxWorkerAgeSeconds) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, maxWorkerAgeSeconds, roles: roles.sort((a, b) => a.id.localeCompare(b.id)) }, errors: [] };
}

/** @param {any} task @param {any} role */
function authorityWithin(task, role) {
  return (AUTH_RANK.filesystem.get(task.authority.filesystem) ?? 999) <= (AUTH_RANK.filesystem.get(role.authority.filesystem) ?? -1) &&
    (AUTH_RANK.shell.get(task.authority.shell) ?? 999) <= (AUTH_RANK.shell.get(role.authority.shell) ?? -1) &&
    (AUTH_RANK.network.get(task.authority.network) ?? 999) <= (AUTH_RANK.network.get(role.authority.network) ?? -1);
}
/** @param {string} value @param {string[]} preferred */
function classRank(value, preferred) { const i = preferred.indexOf(value); return i === -1 ? 10_000 : i; }

/** @param {any} task @param {any[]} workers @param {any} policy @param {string} evaluatedAt */
export function routeAgentTask(task, workers, policy, evaluatedAt) {
  if (!isAbsoluteIsoTimestamp(evaluatedAt)) throw new Error("evaluatedAt must be an absolute ISO timestamp");
  const role = policy.roles.find((/** @type {any} */ item) => item.id === task.role);
  if (!role) return { version: 1, taskId: task.id, role: task.role, evaluatedAt, status: "UNROUTABLE", reason: "no routing policy exists for task role", selected: null, candidates: [] };
  if ((RISK_RANK.get(task.risk) ?? 999) > (RISK_RANK.get(role.maxRisk) ?? -1)) return { version: 1, taskId: task.id, role: task.role, evaluatedAt, status: "UNROUTABLE", reason: `task risk ${task.risk} exceeds role maximum ${role.maxRisk}`, selected: null, candidates: [] };
  if (!authorityWithin(task, role)) return { version: 1, taskId: task.id, role: task.role, evaluatedAt, status: "UNROUTABLE", reason: "task authority exceeds role policy", selected: null, candidates: [] };

  /** @type {Array<any>} */ const candidates = [];
  for (const worker of workers) {
    const ageSeconds = (Date.parse(evaluatedAt) - Date.parse(worker.observedAt)) / 1000;
    let reason = null;
    if (worker.state !== "ONLINE") reason = `worker state is ${worker.state}`;
    else if (ageSeconds < 0) reason = "worker heartbeat is future-dated";
    else if (ageSeconds > policy.maxWorkerAgeSeconds) reason = `worker heartbeat age ${ageSeconds}s exceeds ${policy.maxWorkerAgeSeconds}s`;
    else if (worker.resources.memoryMiB < role.minMemoryMiB) reason = "worker memory is below role minimum";
    else if (role.requiredCapabilities.some((/** @type {string} */ cap) => !worker.capabilities.includes(cap))) reason = "worker lacks required capabilities";
    else if (task.authority.shell === "BOUNDED" && !worker.capabilities.includes("shell")) reason = "worker lacks bounded shell capability";
    else if (task.authority.network === "READ_ONLY" && !worker.capabilities.includes("network-read")) reason = "worker lacks read-only network capability";
    else if (task.authority.filesystem === "WORKTREE_WRITE" && (!worker.execution.worktrees || worker.execution.maxWriteTasks === 0)) reason = "worker cannot host write tasks";
    else if (task.authority.filesystem === "WORKTREE_WRITE" && worker.load.writeTasks >= worker.execution.maxWriteTasks) reason = "worker write capacity is full";
    else if (task.authority.filesystem === "READ_ONLY" && worker.load.readOnlyTasks >= worker.execution.maxReadOnlyTasks) reason = "worker read-only capacity is full";

    let model = null;
    if (!reason) {
      const viableModels = worker.models.filter((/** @type {any} */ item) => item.contextTokens >= role.minContextTokens && (!role.requireToolUse || item.toolUse) && role.preferredModelClasses.includes(item.class));
      viableModels.sort((/** @type {any} */ a, /** @type {any} */ b) => classRank(a.class, role.preferredModelClasses) - classRank(b.class, role.preferredModelClasses) || a.id.localeCompare(b.id));
      model = viableModels[0] ?? null;
      if (!model) reason = "worker has no model satisfying role requirements";
    }
    candidates.push({ workerId: worker.id, workerClass: worker.class, ageSeconds, eligible: reason === null, reason: reason ?? "eligible", model: model ? { id: model.id, class: model.class, backend: model.backend } : null });
  }
  const eligible = candidates.filter((/** @type {any} */ item) => item.eligible && item.model !== null);
  eligible.sort((/** @type {any} */ a, /** @type {any} */ b) => classRank(a.workerClass, role.preferredWorkerClasses) - classRank(b.workerClass, role.preferredWorkerClasses) || classRank(a.model.class, role.preferredModelClasses) - classRank(b.model.class, role.preferredModelClasses) || a.workerId.localeCompare(b.workerId));
  const selected = /** @type {any} */ (eligible[0] ?? null);
  return selected ? { version: 1, taskId: task.id, role: task.role, evaluatedAt, status: "ROUTED", reason: "highest-ranked eligible worker and model selected deterministically", selected: { workerId: selected.workerId, modelId: selected.model.id, modelClass: selected.model.class, backend: selected.model.backend }, candidates } : { version: 1, taskId: task.id, role: task.role, evaluatedAt, status: "UNROUTABLE", reason: "no eligible worker/model pair satisfies task and role policy", selected: null, candidates };
}

/** @param {any} report */
export function formatAgentRoute(report) { const lines = ["Agent Route v1", "", `Task: ${report.taskId}`, `Role: ${report.role}`, `Evaluated at: ${report.evaluatedAt}`, `Status: ${report.status}`, `Reason: ${report.reason}`]; if (report.selected) lines.push(`Worker: ${report.selected.workerId}`, `Model: ${report.selected.modelId} (${report.selected.modelClass})`); lines.push("", "Candidates:"); for (const item of report.candidates) lines.push(`${item.eligible ? "ELIGIBLE" : "REJECT"}  ${item.workerId}  ${item.model?.id ?? "no-model"}  ${item.reason}`); return lines.join("\n"); }
/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) { let task = null, policy = null, evaluatedAt = null, json = false; const workers = []; for (let i = 0; i < argv.length; i += 1) { const a = argv[i]; if (a === "--json") { json = true; continue; } if (!["--task", "--policy", "--worker", "--evaluated-at"].includes(a ?? "")) return null; const v = argv[i + 1]; if (typeof v !== "string" || v.startsWith("--")) return null; i += 1; if (a === "--task") { if (task) return null; task = v; } else if (a === "--policy") { if (policy) return null; policy = v; } else if (a === "--evaluated-at") { if (evaluatedAt) return null; evaluatedAt = v; } else workers.push(v); } return task && policy && evaluatedAt && workers.length > 0 ? { task, policy, evaluatedAt, workers, json } : null; }
/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/agent-route.js --task <task.json> --policy <routing.json> --worker <worker.json> [--worker <worker.json> ...] --evaluated-at <absolute-ISO> [--json]"); return 1; } const rawTask = readJson(options.task), rawPolicy = readJson(options.policy), rawWorkers = options.workers.map(readJson); if (!rawTask || !rawPolicy || rawWorkers.some((item) => !item)) { console.error("Agent routing input cannot be read or parsed"); return 1; } const task = validateAgentTask(rawTask), policy = validateAgentRoutingPolicy(rawPolicy), workerResults = rawWorkers.map(validateAgentWorker); if (!task.valid || !task.task || !policy.valid || !policy.policy || workerResults.some((item) => !item.valid || !item.worker)) { console.error("Agent routing input is invalid"); return 1; } try { const report = routeAgentTask(task.task, workerResults.map((item) => item.worker), policy.policy, options.evaluatedAt); console.log(options.json ? JSON.stringify(report) : formatAgentRoute(report)); return report.status === "ROUTED" ? 0 : 1; } catch (error) { console.error(error instanceof Error ? error.message : "Agent routing failed"); return 1; } }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
