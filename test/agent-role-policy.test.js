import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  AGENT_ROLE_IDS,
  validateAgentRolePolicy,
  inspectAgentTaskRolePolicy,
  main,
} from "../scripts/agent-role-policy.js";
import { validateAgentTask } from "../scripts/agent-task.js";
import { validateAgentWorker } from "../scripts/agent-worker.js";
import { validateAgentRoutingPolicy, routeAgentTask, main as routeMain } from "../scripts/agent-route.js";

const BASE = "a".repeat(40), NOW = "2026-09-17T12:30:00Z";

/** @param {string} role @param {"READ_ONLY"|"WORKTREE_WRITE"} filesystem @param {"LOW"|"MEDIUM"|"HIGH"|"CRITICAL"} [risk] @returns {any} */
function rawTask(role, filesystem, risk = "LOW") {
  return {
    version: 1,
    id: `task:${role}:policy`,
    role,
    repository: { id: "example-webapp", baseCommit: BASE },
    createdAt: "2026-09-17T12:00:00Z",
    risk,
    objective: "exercise explicit generic role policy",
    authority: { filesystem, shell: "BOUNDED", network: "NONE", merge: false, deploy: false, productionMutation: false },
    scope: { allowedPaths: ["src/**", "test/**"], deniedPaths: [".env"], requiredChecks: ["test"] },
    dependsOn: [],
  };
}

/** @returns {any} */
function templatePolicy() {
  return JSON.parse(fs.readFileSync(new URL("../templates/agent-role-policy.v1.json", import.meta.url), "utf8"));
}

/** @param {any} raw */
function task(raw) { const result = validateAgentTask(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.task) throw new Error("task invalid"); return result.task; }
function policy(raw = templatePolicy()) { const result = validateAgentRolePolicy(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("policy invalid"); return result.policy; }

/** @returns {any} */
function rawWorker() {
  return {
    version: 1, id: "compute-worker", class: "COMPUTE", state: "ONLINE", observedAt: "2026-09-17T12:29:55Z",
    resources: { cpuCores: 8, memoryMiB: 16384, gpu: null },
    capabilities: ["git", "local-model", "worktree", "shell"],
    execution: { worktrees: true, maxReadOnlyTasks: 4, maxWriteTasks: 1 },
    load: { readOnlyTasks: 0, writeTasks: 0 },
    models: [{ id: "model-standard", class: "STANDARD", backend: "local-runtime", contextTokens: 16384, toolUse: true }],
  };
}
function worker() { const result = validateAgentWorker(rawWorker()); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.worker) throw new Error("worker invalid"); return result.worker; }

/** @returns {any} */
function rawRouting() {
  return {
    version: 1, maxWorkerAgeSeconds: 60,
    roles: [
      { id: "repair", requiredCapabilities: ["git", "worktree", "local-model"], preferredWorkerClasses: ["COMPUTE"], preferredModelClasses: ["STANDARD"], minMemoryMiB: 4096, minContextTokens: 4096, requireToolUse: true, maxRisk: "HIGH", authority: { filesystem: "WORKTREE_WRITE", shell: "BOUNDED", network: "NONE" } },
      { id: "diagnose", requiredCapabilities: ["git", "local-model"], preferredWorkerClasses: ["COMPUTE"], preferredModelClasses: ["STANDARD"], minMemoryMiB: 4096, minContextTokens: 4096, requireToolUse: true, maxRisk: "CRITICAL", authority: { filesystem: "READ_ONLY", shell: "BOUNDED", network: "NONE" } },
    ],
  };
}
function routing() { const result = validateAgentRoutingPolicy(rawRouting()); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("routing invalid"); return result.policy; }

/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; }

test("public role template explicitly defines all eight canonical roles", () => {
  const raw = templatePolicy(), result = validateAgentRolePolicy(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.policy?.roles.map((/** @type {any} */ item) => item.id).sort(), [...AGENT_ROLE_IDS].sort());
});

test("role policy may omit a role to disable it explicitly", () => {
  const raw = templatePolicy(); raw.roles = raw.roles.filter((/** @type {any} */ item) => item.id !== "repair");
  const report = inspectAgentTaskRolePolicy(task(rawTask("repair", "WORKTREE_WRITE", "MEDIUM")), policy(raw));
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks[0]?.id, "role-enabled");
});

test("read-only roles cannot declare leased write mode and write roles require it", () => {
  const read = templatePolicy(); read.roles.find((/** @type {any} */ item) => item.id === "diagnose").writeMode = "LEASED_WORKTREE";
  assert.equal(validateAgentRolePolicy(read).valid, false);
  const write = templatePolicy(); write.roles.find((/** @type {any} */ item) => item.id === "repair").writeMode = "NONE";
  assert.equal(validateAgentRolePolicy(write).valid, false);
});

test("diagnose and review reject write authority", () => {
  for (const role of ["diagnose", "review"]) {
    const report = inspectAgentTaskRolePolicy(task(rawTask(role, "WORKTREE_WRITE", "LOW")), policy());
    assert.equal(report.overallStatus, "FAIL");
    assert.equal(report.checks.some((item) => item.id === "filesystem-authorized" && item.status === "FAIL"), true);
  }
});

test("reproduce repair and docs write tasks require leased worktree", () => {
  for (const role of ["reproduce", "repair", "docs"]) {
    const report = inspectAgentTaskRolePolicy(task(rawTask(role, "WORKTREE_WRITE", "MEDIUM")), policy());
    assert.equal(report.overallStatus, "PASS", role);
    assert.equal(report.leaseRequired, true);
  }
});

test("repair role caps risk independently from permissive routing policy", () => {
  const repair = task(rawTask("repair", "WORKTREE_WRITE", "HIGH"));
  const report = inspectAgentTaskRolePolicy(repair, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "risk-authorized" && item.status === "FAIL"), true);
  const routed = routeAgentTask(repair, [worker()], routing(), NOW, policy());
  assert.equal(routed.status, "UNROUTABLE");
  assert.match(routed.reason, /Agent Role Policy/);
});

test("role policy is an additional restriction and cannot widen routing policy", () => {
  const diagnose = task(rawTask("diagnose", "READ_ONLY", "LOW"));
  const restrictiveRouting = rawRouting(); restrictiveRouting.roles.find((/** @type {any} */ item) => item.id === "diagnose").maxRisk = "LOW";
  diagnose.risk = "MEDIUM";
  const routingResult = validateAgentRoutingPolicy(restrictiveRouting); assert.equal(routingResult.valid, true);
  if (!routingResult.valid || !routingResult.policy) return;
  const routed = routeAgentTask(diagnose, [worker()], routingResult.policy, NOW, policy());
  assert.equal(routed.status, "UNROUTABLE");
  assert.match(routed.reason, /routing role maximum|role maximum/);
});

test("routing remains backward compatible without role policy", () => {
  const repair = task(rawTask("repair", "WORKTREE_WRITE", "HIGH"));
  const routed = routeAgentTask(repair, [worker()], routing(), NOW);
  assert.equal(routed.status, "ROUTED");
  assert.equal(routed.rolePolicy, null);
});

test("CLI validates role policy and optional routing composition", () => {
  const taskFile = tempJson("role-task", rawTask("repair", "WORKTREE_WRITE", "MEDIUM"));
  const roleFile = tempJson("role-policy", templatePolicy());
  const routeFile = tempJson("route-policy", rawRouting());
  const workerFile = tempJson("route-worker", rawWorker());
  const original = console.log; let output = ""; console.log = (...values) => { output += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["--task", taskFile, "--policy", roleFile, "--json"]), 0);
    assert.equal(routeMain(["--task", taskFile, "--policy", routeFile, "--role-policy", roleFile, "--worker", workerFile, "--evaluated-at", NOW, "--json"]), 0);
  } finally { console.log = original; }
  assert.match(output, /LEASED_WORKTREE|leaseRequired/);
  for (const file of [taskFile, roleFile, routeFile, workerFile]) fs.rmSync(file, { force: true });
});

test("public role policy surface contains no endpoints or private deployment configuration", () => {
  const source = fs.readFileSync(new URL("../scripts/agent-role-policy.js", import.meta.url), "utf8");
  const template = fs.readFileSync(new URL("../templates/agent-role-policy.v1.json", import.meta.url), "utf8");
  assert.doesNotMatch(`${source}\n${template}`, /https?:\/\/|ssh|tailscale|endpoint|baseUrl|node:child_process|\bfetch\s*\(|process\.env/);
});
