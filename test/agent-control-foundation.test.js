import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateAgentTask, main as taskMain } from "../scripts/agent-task.js";
import { validateAgentWorker, main as workerMain } from "../scripts/agent-worker.js";
import { validateAgentRoutingPolicy, routeAgentTask, main as routeMain } from "../scripts/agent-route.js";

const BASE = "a".repeat(40);
const NOW = "2026-09-17T11:30:00Z";

/** @returns {any} */
function rawTask(role = "diagnose") {
  return {
    version: 1,
    id: `task:${role}:1`,
    role,
    repository: { id: "example-webapp", baseCommit: BASE },
    createdAt: "2026-09-17T11:29:00Z",
    risk: role === "repair" ? "MEDIUM" : "LOW",
    objective: `perform ${role} task`,
    authority: {
      filesystem: role === "repair" ? "WORKTREE_WRITE" : "READ_ONLY",
      shell: "BOUNDED",
      network: "NONE",
      merge: false,
      deploy: false,
      productionMutation: false,
    },
    scope: { allowedPaths: ["src/**", "test/**"], deniedPaths: [".env"], requiredChecks: ["typecheck", "test"] },
    dependsOn: [],
  };
}

/** @param {string} workerId @param {"PERSISTENT"|"COMPUTE"} workerClass @param {any[]} models @returns {any} */
function rawWorker(workerId, workerClass, models) {
  const compute = workerClass === "COMPUTE";
  return {
    version: 1,
    id: workerId,
    class: workerClass,
    state: "ONLINE",
    observedAt: "2026-09-17T11:29:50Z",
    resources: { cpuCores: compute ? 16 : 4, memoryMiB: compute ? 32768 : 8192, gpu: compute ? { vendor: "generic-gpu", name: "compute-accelerator", vramMiB: 8192 } : null },
    capabilities: compute ? ["git", "local-model", "worktree", "docker", "shell", "network-read"] : ["git", "local-model", "docker", "shell"],
    execution: { worktrees: compute, maxReadOnlyTasks: compute ? 4 : 2, maxWriteTasks: compute ? 1 : 0 },
    load: { readOnlyTasks: 0, writeTasks: 0 },
    models,
  };
}

function smallModel() { return { id: "model-small", class: "SMALL", backend: "local-runtime-a", contextTokens: 8192, toolUse: true }; }
function standardModel() { return { id: "model-standard", class: "STANDARD", backend: "local-runtime-b", contextTokens: 16384, toolUse: true }; }
function strongModel() { return { id: "model-strong", class: "STRONG", backend: "local-runtime-b", contextTokens: 8192, toolUse: true }; }

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    maxWorkerAgeSeconds: 120,
    roles: [
      {
        id: "diagnose",
        requiredCapabilities: ["git", "local-model"],
        preferredWorkerClasses: ["PERSISTENT", "COMPUTE"],
        preferredModelClasses: ["SMALL", "STANDARD", "STRONG"],
        minMemoryMiB: 2048,
        minContextTokens: 4096,
        requireToolUse: true,
        maxRisk: "MEDIUM",
        authority: { filesystem: "READ_ONLY", shell: "BOUNDED", network: "READ_ONLY" },
      },
      {
        id: "review",
        requiredCapabilities: ["git", "local-model"],
        preferredWorkerClasses: ["COMPUTE", "PERSISTENT"],
        preferredModelClasses: ["STRONG", "REVIEW", "STANDARD"],
        minMemoryMiB: 8192,
        minContextTokens: 8192,
        requireToolUse: true,
        maxRisk: "HIGH",
        authority: { filesystem: "READ_ONLY", shell: "BOUNDED", network: "NONE" },
      },
      {
        id: "repair",
        requiredCapabilities: ["git", "local-model", "worktree"],
        preferredWorkerClasses: ["COMPUTE", "PERSISTENT"],
        preferredModelClasses: ["STANDARD", "STRONG"],
        minMemoryMiB: 8192,
        minContextTokens: 8192,
        requireToolUse: true,
        maxRisk: "MEDIUM",
        authority: { filesystem: "WORKTREE_WRITE", shell: "BOUNDED", network: "READ_ONLY" },
      },
    ],
  };
}

function task(raw = rawTask()) { const result = validateAgentTask(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.task) throw new Error("task fixture invalid"); return result.task; }
/** @param {any} raw */
function worker(raw) { const result = validateAgentWorker(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.worker) throw new Error("worker fixture invalid"); return result.worker; }
function policy(raw = rawPolicy()) { const result = validateAgentRoutingPolicy(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("policy fixture invalid"); return result.policy; }
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; }

test("Agent Task v1 validates bounded read-only diagnostic authority", () => {
  const result = validateAgentTask(rawTask());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.task?.authority.productionMutation, false);
});

test("Agent Task v1 rejects production, merge, deployment, unsafe paths, and unknown roles", () => {
  for (const key of ["merge", "deploy", "productionMutation"]) {
    const raw = rawTask(); raw.authority[key] = true;
    assert.equal(validateAgentTask(raw).valid, false);
  }
  const unsafe = rawTask(); unsafe.scope.allowedPaths = ["../secret"];
  assert.equal(validateAgentTask(unsafe).valid, false);
  const role = rawTask(); role.role = "super-admin";
  assert.equal(validateAgentTask(role).valid, false);
});

test("Agent Worker v1 supports persistent CPU and compute GPU workers", () => {
  const persistent = validateAgentWorker(rawWorker("persistent-worker", "PERSISTENT", [smallModel()]));
  const compute = validateAgentWorker(rawWorker("compute-worker", "COMPUTE", [standardModel(), strongModel()]));
  assert.equal(persistent.valid, true, JSON.stringify(persistent.errors));
  assert.equal(compute.valid, true, JSON.stringify(compute.errors));
  assert.equal(persistent.worker?.resources.gpu, null);
  assert.equal(compute.worker?.resources.gpu?.vramMiB, 8192);
});

test("Agent Worker v1 rejects load above capacity and duplicate model ids", () => {
  const load = rawWorker("persistent-worker", "PERSISTENT", [smallModel()]); load.load.readOnlyTasks = 3;
  assert.equal(validateAgentWorker(load).valid, false);
  const duplicate = rawWorker("compute-worker", "COMPUTE", [standardModel(), standardModel()]);
  assert.equal(validateAgentWorker(duplicate).valid, false);
});

test("diagnose prefers the persistent worker when a suitable small model exists", () => {
  const workers = [worker(rawWorker("compute-worker", "COMPUTE", [standardModel(), strongModel()])), worker(rawWorker("persistent-worker", "PERSISTENT", [smallModel()]))];
  const report = routeAgentTask(task(), workers, policy(), NOW);
  assert.equal(report.status, "ROUTED");
  assert.equal(report.selected?.workerId, "persistent-worker");
  assert.equal(report.selected?.modelId, "model-small");
});

test("diagnose falls back to the compute worker when the persistent worker has no eligible model", () => {
  const workers = [worker(rawWorker("persistent-worker", "PERSISTENT", [])), worker(rawWorker("compute-worker", "COMPUTE", [standardModel()]))];
  const report = routeAgentTask(task(), workers, policy(), NOW);
  assert.equal(report.selected?.workerId, "compute-worker");
});

test("review prefers strong compute model and repair requires worktree write capacity", () => {
  const compute = worker(rawWorker("compute-worker", "COMPUTE", [standardModel(), strongModel()]));
  const persistent = worker(rawWorker("persistent-worker", "PERSISTENT", [smallModel()]));
  const reviewRaw = rawTask("review"); reviewRaw.risk = "HIGH";
  let report = routeAgentTask(task(reviewRaw), [persistent, compute], policy(), NOW);
  assert.equal(report.selected?.workerId, "compute-worker");
  assert.equal(report.selected?.modelId, "model-strong");
  report = routeAgentTask(task(rawTask("repair")), [persistent, compute], policy(), NOW);
  assert.equal(report.selected?.workerId, "compute-worker");
});

test("stale, future-dated, full, and authority-incompatible workers do not route", () => {
  const stale = rawWorker("persistent-worker", "PERSISTENT", [smallModel()]); stale.observedAt = "2026-09-17T11:00:00Z";
  let report = routeAgentTask(task(), [worker(stale)], policy(), NOW);
  assert.equal(report.status, "UNROUTABLE");
  const future = rawWorker("persistent-worker", "PERSISTENT", [smallModel()]); future.observedAt = "2026-09-17T11:31:00Z";
  report = routeAgentTask(task(), [worker(future)], policy(), NOW);
  assert.equal(report.status, "UNROUTABLE");
  const full = rawWorker("persistent-worker", "PERSISTENT", [smallModel()]); full.load.readOnlyTasks = 2;
  report = routeAgentTask(task(), [worker(full)], policy(), NOW);
  assert.equal(report.status, "UNROUTABLE");
  const elevated = rawTask(); elevated.authority.filesystem = "WORKTREE_WRITE";
  report = routeAgentTask(task(elevated), [worker(rawWorker("compute-worker", "COMPUTE", [standardModel()]))], policy(), NOW);
  assert.equal(report.status, "UNROUTABLE");
  assert.match(report.reason, /authority exceeds/);
});


test("public worker evidence rejects private endpoint configuration", () => {
  const raw = rawWorker("persistent-worker", "PERSISTENT", [smallModel()]);
  raw.endpoint = "https://private-worker.invalid";
  assert.equal(validateAgentWorker(raw).valid, false);
  const modelEndpoint = rawWorker("persistent-worker", "PERSISTENT", [smallModel()]);
  modelEndpoint.models[0].endpoint = "http://127.0.0.1:1234";
  assert.equal(validateAgentWorker(modelEndpoint).valid, false);
});

test("worker must explicitly support requested shell and network authority", () => {
  const noShell = rawWorker("persistent-worker", "PERSISTENT", [smallModel()]);
  noShell.capabilities = noShell.capabilities.filter((/** @type {string} */ value) => value !== "shell");
  let report = routeAgentTask(task(), [worker(noShell)], policy(), NOW);
  assert.equal(report.status, "UNROUTABLE");
  assert.equal(report.candidates[0]?.reason, "worker lacks bounded shell capability");

  const networkTask = rawTask();
  networkTask.authority.network = "READ_ONLY";
  const noNetwork = rawWorker("persistent-worker", "PERSISTENT", [smallModel()]);
  report = routeAgentTask(task(networkTask), [worker(noNetwork)], policy(), NOW);
  assert.equal(report.status, "UNROUTABLE");
  assert.equal(report.candidates[0]?.reason, "worker lacks read-only network capability");
});

test("routing policy rejects duplicate roles and unsupported authority", () => {
  const duplicate = rawPolicy(); duplicate.roles.push(structuredClone(duplicate.roles[0]));
  assert.equal(validateAgentRoutingPolicy(duplicate).valid, false);
  const elevated = rawPolicy(); elevated.roles[0].authority.network = "WRITE";
  assert.equal(validateAgentRoutingPolicy(elevated).valid, false);
});

test("CLIs validate explicit files and router is proposal-only", () => {
  const taskFile = tempJson("agent-task", rawTask());
  const workerFile = tempJson("agent-worker", rawWorker("persistent-worker", "PERSISTENT", [smallModel()]));
  const policyFile = tempJson("agent-routing", rawPolicy());
  const original = console.log; let output = ""; console.log = (...args) => { output += `${args.join(" ")}\n`; };
  try {
    assert.equal(taskMain(["--file", taskFile, "--json"]), 0);
    assert.equal(workerMain(["--file", workerFile, "--json"]), 0);
    assert.equal(routeMain(["--task", taskFile, "--policy", policyFile, "--worker", workerFile, "--evaluated-at", NOW, "--json"]), 0);
  } finally { console.log = original; }
  assert.match(output, /persistent-worker/);
  for (const file of [taskFile, workerFile, policyFile]) fs.rmSync(file, { force: true });
  const sources = ["agent-task.js", "agent-worker.js", "agent-route.js"].map((name) => fs.readFileSync(new URL(`../scripts/${name}`, import.meta.url), "utf8")).join("\n");
  assert.doesNotMatch(sources, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|writeFile|copyFile|https?:\/\//);
});
