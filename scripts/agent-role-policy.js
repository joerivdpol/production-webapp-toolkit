#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { validateAgentTask } from "./agent-task.js";

export const AGENT_ROLE_IDS = ["diagnose", "reproduce", "review", "repair", "docs", "contract", "dependency", "incident"];
const ROLE_IDS = new Set(AGENT_ROLE_IDS);
const RISKS = new Set(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const FILESYSTEM = new Set(["READ_ONLY", "WORKTREE_WRITE"]);
const SHELL = new Set(["NONE", "BOUNDED"]);
const NETWORK = new Set(["NONE", "READ_ONLY"]);
const WRITE_MODES = new Set(["NONE", "LEASED_WORKTREE"]);
const RISK_RANK = new Map([["LOW", 0], ["MEDIUM", 1], ["HIGH", 2], ["CRITICAL", 3]]);
const FS_RANK = new Map([["READ_ONLY", 0], ["WORKTREE_WRITE", 1]]);
const SHELL_RANK = new Map([["NONE", 0], ["BOUNDED", 1]]);
const NETWORK_RANK = new Map([["NONE", 0], ["READ_ONLY", 1]]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v) ? v : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }

/** @param {unknown} value */
export function validateAgentRolePolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "agent role policy must be an object" }] };
  unknown(value, ["version", "roles"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  /** @type {Array<any>} */ const roles = [];
  const ids = new Set();
  if (!Array.isArray(value.roles) || value.roles.length === 0 || value.roles.length > AGENT_ROLE_IDS.length) errors.push({ id: "roles-invalid", detail: "roles must be a non-empty bounded array" });
  else for (const [index, raw] of value.roles.entries()) {
    if (!object(raw)) { errors.push({ id: "role-invalid", detail: `roles[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "maxRisk", "authority", "writeMode"], "role", errors);
    const roleId = text(raw.id, 32), maxRisk = text(raw.maxRisk, 32), writeMode = text(raw.writeMode, 32);
    let authority = null;
    if (!object(raw.authority)) errors.push({ id: "authority-invalid", detail: `roles[${index}].authority must be an object` });
    else {
      unknown(raw.authority, ["filesystem", "shell", "network"], "authority", errors);
      const filesystem = text(raw.authority.filesystem, 32), shell = text(raw.authority.shell, 32), network = text(raw.authority.network, 32);
      if (!filesystem || !FILESYSTEM.has(filesystem) || !shell || !SHELL.has(shell) || !network || !NETWORK.has(network)) errors.push({ id: "authority-fields-invalid", detail: `roles[${index}].authority is invalid` });
      else authority = { filesystem, shell, network };
    }
    if (!roleId || !ROLE_IDS.has(roleId) || ids.has(roleId) || !maxRisk || !RISKS.has(maxRisk) || !writeMode || !WRITE_MODES.has(writeMode) || !authority) {
      errors.push({ id: "role-fields-invalid", detail: `roles[${index}] has invalid or duplicate fields` }); continue;
    }
    if (authority.filesystem === "READ_ONLY" && writeMode !== "NONE") errors.push({ id: "write-mode-inconsistent", detail: `${roleId} cannot require a write lease while filesystem authority is READ_ONLY` });
    if (authority.filesystem === "WORKTREE_WRITE" && writeMode !== "LEASED_WORKTREE") errors.push({ id: "write-mode-unsafe", detail: `${roleId} WORKTREE_WRITE authority requires LEASED_WORKTREE mode` });
    ids.add(roleId); roles.push({ id: roleId, maxRisk, authority, writeMode });
  }
  if (errors.length > 0) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, roles: roles.sort((a, b) => a.id.localeCompare(b.id)) }, errors: [] };
}

/** @param {any} task @param {any} policy */
export function inspectAgentTaskRolePolicy(task, policy) {
  const role = policy.roles.find((/** @type {any} */ item) => item.id === task.role);
  /** @type {Array<{id:string,status:"PASS"|"FAIL",detail:string}>} */ const checks = [];
  /** @param {string} id @param {boolean} passed @param {string} detail */
  const add = (id, passed, detail) => checks.push({ id, status: passed ? "PASS" : "FAIL", detail });
  if (!role) {
    add("role-enabled", false, `role ${task.role} is not enabled by Agent Role Policy v1`);
    return { version: 1, taskId: task.id, role: task.role, checks, leaseRequired: false, overallStatus: "FAIL" };
  }
  add("role-enabled", true, `role ${task.role} is explicitly enabled`);
  add("risk-authorized", (RISK_RANK.get(task.risk) ?? 999) <= (RISK_RANK.get(role.maxRisk) ?? -1), `task risk ${task.risk} must not exceed role maximum ${role.maxRisk}`);
  add("filesystem-authorized", (FS_RANK.get(task.authority.filesystem) ?? 999) <= (FS_RANK.get(role.authority.filesystem) ?? -1), `task filesystem authority ${task.authority.filesystem} must not exceed role maximum ${role.authority.filesystem}`);
  add("shell-authorized", (SHELL_RANK.get(task.authority.shell) ?? 999) <= (SHELL_RANK.get(role.authority.shell) ?? -1), `task shell authority ${task.authority.shell} must not exceed role maximum ${role.authority.shell}`);
  add("network-authorized", (NETWORK_RANK.get(task.authority.network) ?? 999) <= (NETWORK_RANK.get(role.authority.network) ?? -1), `task network authority ${task.authority.network} must not exceed role maximum ${role.authority.network}`);
  const leaseRequired = task.authority.filesystem === "WORKTREE_WRITE";
  add("write-lease-policy", !leaseRequired || role.writeMode === "LEASED_WORKTREE", leaseRequired ? "write task requires LEASED_WORKTREE role policy" : "read-only task does not require a write lease");
  const fail = checks.filter((item) => item.status === "FAIL").length;
  return { version: 1, taskId: task.id, role: task.role, checks, leaseRequired: leaseRequired && fail === 0, overallStatus: fail > 0 ? "FAIL" : "PASS" };
}

/** @param {any} report */
export function formatAgentTaskRolePolicy(report) {
  const lines = ["Agent task role-policy audit", "", `Task: ${report.taskId}`, `Role: ${report.role}`, `Write lease required: ${report.leaseRequired}`, ""];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.detail}`);
  lines.push("", `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv */
function parse(argv) { let taskFile = null, policyFile = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--task", "--policy"].includes(arg ?? "")) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; i += 1; if (arg === "--task") { if (taskFile) return null; taskFile = next; } else { if (policyFile) return null; policyFile = next; } } return taskFile && policyFile ? { taskFile, policyFile, json } : null; }
/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/agent-role-policy.js --task <agent-task.json> --policy <agent-role-policy.json> [--json]"); return 1; }
  const rawTask = readJson(options.taskFile), rawPolicy = readJson(options.policyFile);
  if (!rawTask || !rawPolicy) { console.error("Agent role policy input cannot be read or parsed"); return 1; }
  const task = validateAgentTask(rawTask), policy = validateAgentRolePolicy(rawPolicy);
  if (!task.valid || !task.task || !policy.valid || !policy.policy) { console.error("Agent role policy input is invalid"); return 1; }
  const report = inspectAgentTaskRolePolicy(task.task, policy.policy);
  console.log(options.json ? JSON.stringify(report) : formatAgentTaskRolePolicy(report));
  return report.overallStatus === "PASS" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
