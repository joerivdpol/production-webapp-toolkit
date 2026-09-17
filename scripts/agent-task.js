#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ROLES = new Set(["diagnose", "reproduce", "review", "repair", "docs", "contract", "dependency", "incident"]);
const RISKS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const FILESYSTEM = new Set(["READ_ONLY", "WORKTREE_WRITE"]);
const NETWORK = new Set(["NONE", "READ_ONLY"]);
const SHELL = new Set(["NONE", "BOUNDED"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 2048) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000]/.test(v) ? v : null; }
/** @param {unknown} value */
function id(value) { const v = text(value, 128); return v && ID.test(v) ? v : null; }
/** @param {unknown} value */
function safePattern(value) { const v = text(value, 512); if (!v || v.startsWith("/") || v.includes("\\") || v.split("/").includes("..")) return null; return v; }
/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value @param {(value:unknown)=>string|null} validator @param {boolean} [allowEmpty] @param {number} [max] */
function list(value, validator, allowEmpty = true, max = 256) { if (!Array.isArray(value) || value.length > max || (!allowEmpty && value.length === 0)) return null; const out = value.map(validator); if (out.some((v) => v === null)) return null; const items = out; return new Set(items).size === items.length ? items.sort() : null; }

/** @param {unknown} value */
export function validateAgentTask(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, task: null, errors: [{ id: "task-invalid", detail: "agent task must be an object" }] };
  unknown(value, ["version", "id", "role", "repository", "createdAt", "risk", "objective", "authority", "scope", "dependsOn"], "task", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const taskId = id(value.id); if (!taskId) errors.push({ id: "id-invalid", detail: "id must be a portable identifier" });
  const role = text(value.role, 32); if (!role || !ROLES.has(role)) errors.push({ id: "role-invalid", detail: "role is unsupported" });
  const createdAt = text(value.createdAt, 128); if (!createdAt || !isAbsoluteIsoTimestamp(createdAt)) errors.push({ id: "created-at-invalid", detail: "createdAt must be an absolute ISO timestamp" });
  const risk = text(value.risk, 32); if (!risk || !RISKS.has(risk)) errors.push({ id: "risk-invalid", detail: "risk must be LOW, MEDIUM, HIGH, or CRITICAL" });
  const objective = text(value.objective, 4096); if (!objective || /[\r\n]/.test(objective)) errors.push({ id: "objective-invalid", detail: "objective must be a bounded single-line string" });

  let repository = null;
  if (!object(value.repository)) errors.push({ id: "repository-invalid", detail: "repository must be an object" });
  else {
    unknown(value.repository, ["id", "baseCommit"], "repository", errors);
    const repositoryId = id(value.repository.id), baseCommit = text(value.repository.baseCommit, 128)?.toLowerCase() ?? null;
    if (!repositoryId || !baseCommit || !isFullObjectId(baseCommit)) errors.push({ id: "repository-fields-invalid", detail: "repository requires portable id and full baseCommit" });
    else repository = { id: repositoryId, baseCommit };
  }

  let authority = null;
  if (!object(value.authority)) errors.push({ id: "authority-invalid", detail: "authority must be an object" });
  else {
    unknown(value.authority, ["filesystem", "shell", "network", "merge", "deploy", "productionMutation"], "authority", errors);
    const rawAuthority = value.authority;
    const filesystem = text(rawAuthority.filesystem, 32), shell = text(rawAuthority.shell, 32), network = text(rawAuthority.network, 32);
    const bools = ["merge", "deploy", "productionMutation"];
    if (!filesystem || !FILESYSTEM.has(filesystem) || !shell || !SHELL.has(shell) || !network || !NETWORK.has(network) || bools.some((key) => typeof rawAuthority[key] !== "boolean")) {
      errors.push({ id: "authority-fields-invalid", detail: "authority fields are invalid" });
    } else if (rawAuthority.merge || rawAuthority.deploy || rawAuthority.productionMutation) {
      errors.push({ id: "authority-production-invalid", detail: "Agent Task v1 cannot authorize merge, deployment, or production mutation" });
    } else authority = { filesystem, shell, network, merge: false, deploy: false, productionMutation: false };
  }

  let scope = null;
  if (!object(value.scope)) errors.push({ id: "scope-invalid", detail: "scope must be an object" });
  else {
    unknown(value.scope, ["allowedPaths", "deniedPaths", "requiredChecks"], "scope", errors);
    const allowedPaths = list(value.scope.allowedPaths, safePattern, false), deniedPaths = list(value.scope.deniedPaths, safePattern, true), requiredChecks = list(value.scope.requiredChecks, id, false);
    if (!allowedPaths || !deniedPaths || !requiredChecks) errors.push({ id: "scope-fields-invalid", detail: "scope paths and required checks must be bounded unique arrays" });
    else scope = { allowedPaths, deniedPaths, requiredChecks };
  }
  const dependsOn = list(value.dependsOn ?? [], id, true, 64); if (!dependsOn) errors.push({ id: "depends-on-invalid", detail: "dependsOn must be a bounded unique id array" });
  if (errors.length > 0 || !taskId || !role || !repository || !createdAt || !risk || !objective || !authority || !scope || !dependsOn) return { valid: false, task: null, errors };
  return { valid: true, task: { version: 1, id: taskId, role, repository, createdAt, risk, objective, authority, scope, dependsOn }, errors: [] };
}

/** @param {any} task */
export function formatAgentTask(task) {
  return ["Agent Task v1", "", `Task: ${task.id}`, `Role: ${task.role}`, `Repository: ${task.repository.id}@${task.repository.baseCommit}`, `Risk: ${task.risk}`, `Filesystem: ${task.authority.filesystem}`, `Shell: ${task.authority.shell}`, `Network: ${task.authority.network}`, `Required checks: ${task.scope.requiredChecks.join(", ")}`, "Execution authority: no merge, deploy, or production mutation", "Result: VALID"].join("\n");
}

/** @param {string[]} argv */
function parse(argv) { let file = null, json = false; for (let i = 0; i < argv.length; i += 1) { const a = argv[i]; if (a === "--json") { json = true; continue; } if (a !== "--file" || file !== null) return null; const v = argv[i + 1]; if (typeof v !== "string" || v.startsWith("--")) return null; file = v; i += 1; } return file ? { file, json } : null; }
/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/agent-task.js --file <agent-task.json> [--json]"); return 1; } let raw; try { raw = JSON.parse(fs.readFileSync(options.file, "utf8")); } catch { console.error("Agent task cannot be read or parsed"); return 1; } const result = validateAgentTask(raw); if (!result.valid || !result.task) { console.error("Agent task is invalid"); return 1; } console.log(options.json ? JSON.stringify(result.task) : formatAgentTask(result.task)); return 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
