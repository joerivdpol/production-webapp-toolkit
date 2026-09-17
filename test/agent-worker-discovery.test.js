import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openAgentTaskRegistry } from "../scripts/agent-task-registry.js";
import { validateAgentModelConfig } from "../scripts/agent-local-model.js";
import {
  validateAgentWorkerDeclaration,
  observeAgentWorker,
  main as observeMain,
} from "../scripts/agent-worker-observe.js";
import {
  registerAgentWorkerHeartbeat,
  getAgentWorkerRecord,
  listAgentWorkerHeartbeatEvents,
  discoverAgentWorkers,
  main as registryMain,
} from "../scripts/agent-worker-registry.js";

const OBSERVED = "2026-09-17T12:30:00Z";

/** @returns {any} */
function rawDeclaration(workerClass = "PERSISTENT") {
  return {
    version: 1,
    id: workerClass === "PERSISTENT" ? "persistent-worker" : "compute-worker",
    class: workerClass,
    state: "ONLINE",
    gpu: workerClass === "COMPUTE" ? { vendor: "generic-gpu", name: "accelerator", vramMiB: 8192 } : null,
    capabilities: workerClass === "COMPUTE" ? ["git", "local-model", "shell", "worktree"] : ["git", "local-model", "shell"],
    execution: { worktrees: workerClass === "COMPUTE", maxReadOnlyTasks: workerClass === "COMPUTE" ? 4 : 2, maxWriteTasks: workerClass === "COMPUTE" ? 1 : 0 },
    load: { readOnlyTasks: 0, writeTasks: 0 },
    models: [{ id: "small-local", class: "SMALL", backend: "worker-local", contextTokens: 8192, toolUse: true }],
  };
}

/** @returns {any} */
function rawModelConfig() {
  return { version: 1, backends: [{ id: "worker-local", type: "OLLAMA", baseUrl: "http://127.0.0.1:18080", models: [{ id: "small-local", providerModel: "private-provider-model", thinking: "DISABLED" }] }] };
}
function declaration(raw = rawDeclaration()) { const result = validateAgentWorkerDeclaration(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.declaration) throw new Error("declaration invalid"); return result.declaration; }
function modelConfig(raw = rawModelConfig()) { const result = validateAgentModelConfig(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.config) throw new Error("model config invalid"); return result.config; }
function heartbeat(raw = rawDeclaration(), observedAt = OBSERVED) { return observeAgentWorker(declaration(raw), modelConfig(), { cpuCores: () => 6, memoryMiB: () => 15360, clock: () => observedAt }); }

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-worker-registry-"));
  const file = path.join(root, "registry.sqlite");
  return { root, file, db: openAgentTaskRegistry(file) };
}
/** @param {ReturnType<typeof registry>} fixture */
function cleanup(fixture) { try { fixture.db.close(); } catch {} fs.rmSync(fixture.root, { recursive: true, force: true }); }
/** @param {string} root @param {string} name @param {any} value */
function jsonFile(root, name, value) { const file = path.join(root, name); fs.writeFileSync(file, JSON.stringify(value)); return file; }

test("worker declaration validates generic private deployment metadata without endpoint fields", () => {
  const result = validateAgentWorkerDeclaration(rawDeclaration());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  const endpoint = rawDeclaration(); endpoint.endpoint = "http://private.invalid";
  assert.equal(validateAgentWorkerDeclaration(endpoint).valid, false);
});

test("observer combines local CPU memory and explicit private symbolic model declaration", () => {
  const worker = heartbeat();
  assert.equal(worker.resources.cpuCores, 6);
  assert.equal(worker.resources.memoryMiB, 15360);
  assert.equal(worker.observedAt, OBSERVED);
  assert.equal(worker.models[0]?.id, "small-local");
  const output = JSON.stringify(worker);
  assert.doesNotMatch(output, /private-provider-model|18080/);
});

test("observer requires private model config for model-bearing workers and exact symbolic mapping", () => {
  assert.throws(() => observeAgentWorker(declaration(), null, { cpuCores: () => 4, memoryMiB: () => 8192, clock: () => OBSERVED }), /requires explicit private model config/);
  const bad = rawModelConfig(); bad.backends[0].models[0].id = "other-model";
  assert.throws(() => observeAgentWorker(declaration(), modelConfig(bad), { cpuCores: () => 4, memoryMiB: () => 8192, clock: () => OBSERVED }), /absent from private local model config/);
});

test("observer fails closed on invalid local resources and observation clocks", () => {
  assert.throws(() => observeAgentWorker(declaration(), modelConfig(), { cpuCores: () => 0, memoryMiB: () => 8192, clock: () => OBSERVED }), /resources/);
  assert.throws(() => observeAgentWorker(declaration(), modelConfig(), { cpuCores: () => 4, memoryMiB: () => 100, clock: () => OBSERVED }), /resources/);
  assert.throws(() => observeAgentWorker(declaration(), modelConfig(), { cpuCores: () => 4, memoryMiB: () => 8192, clock: () => "today" }), /clock/);
});

test("first heartbeat registers and identical heartbeat is idempotent", () => {
  const fixture = registry();
  try {
    const worker = heartbeat();
    const first = registerAgentWorkerHeartbeat(fixture.db, worker, "2026-09-17T12:30:02Z");
    const second = registerAgentWorkerHeartbeat(fixture.db, worker, "2026-09-17T12:30:05Z");
    assert.equal(first.created, true); assert.equal(first.updated, false);
    assert.equal(second.created, false); assert.equal(second.updated, false);
    assert.equal(first.record?.revision, 0);
    assert.match(first.record?.workerSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(listAgentWorkerHeartbeatEvents(fixture.db, worker.id).length, 1);
  } finally { cleanup(fixture); }
});

test("newer heartbeat updates exact worker truth and appends history", () => {
  const fixture = registry();
  try {
    registerAgentWorkerHeartbeat(fixture.db, heartbeat(), "2026-09-17T12:30:02Z");
    const nextDecl = rawDeclaration(); nextDecl.load.readOnlyTasks = 1;
    const next = heartbeat(nextDecl, "2026-09-17T12:31:00Z");
    const result = registerAgentWorkerHeartbeat(fixture.db, next, "2026-09-17T12:31:02Z");
    assert.equal(result.updated, true); assert.equal(result.record?.revision, 1);
    assert.equal(result.record?.worker.load.readOnlyTasks, 1);
    assert.deepEqual(listAgentWorkerHeartbeatEvents(fixture.db, next.id).map((event) => event.event), ["REGISTERED", "UPDATED"]);
  } finally { cleanup(fixture); }
});

test("older heartbeat and same timestamp conflicting content fail closed", () => {
  const fixture = registry();
  try {
    registerAgentWorkerHeartbeat(fixture.db, heartbeat(), "2026-09-17T12:30:02Z");
    assert.throws(() => registerAgentWorkerHeartbeat(fixture.db, heartbeat(rawDeclaration(), "2026-09-17T12:29:59Z"), "2026-09-17T12:31:00Z"), /older/);
    const conflictDecl = rawDeclaration(); conflictDecl.load.readOnlyTasks = 1;
    assert.throws(() => registerAgentWorkerHeartbeat(fixture.db, heartbeat(conflictDecl, OBSERVED), "2026-09-17T12:31:00Z"), /conflicts/);
  } finally { cleanup(fixture); }
});

test("registeredAt cannot precede observedAt", () => {
  const fixture = registry();
  try { assert.throws(() => registerAgentWorkerHeartbeat(fixture.db, heartbeat(), "2026-09-17T12:29:59Z"), /cannot precede/); }
  finally { cleanup(fixture); }
});

test("discovery reports FRESH STALE FUTURE and respects explicit worker state", () => {
  const fixture = registry();
  try {
    registerAgentWorkerHeartbeat(fixture.db, heartbeat(rawDeclaration("PERSISTENT"), "2026-09-17T12:30:00Z"), "2026-09-17T12:30:01Z");
    const compute = rawDeclaration("COMPUTE"); compute.id = "compute-stale";
    registerAgentWorkerHeartbeat(fixture.db, heartbeat(compute, "2026-09-17T12:20:00Z"), "2026-09-17T12:20:01Z");
    const future = rawDeclaration("COMPUTE"); future.id = "compute-future";
    registerAgentWorkerHeartbeat(fixture.db, heartbeat(future, "2026-09-17T12:31:00Z"), "2026-09-17T12:31:01Z");
    const offline = rawDeclaration("COMPUTE"); offline.id = "compute-offline"; offline.state = "OFFLINE";
    registerAgentWorkerHeartbeat(fixture.db, heartbeat(offline, "2026-09-17T12:30:00Z"), "2026-09-17T12:30:01Z");
    const rows = discoverAgentWorkers(fixture.db, "2026-09-17T12:30:30Z", 120);
    const byId = new Map(rows.map((row) => [row.worker.id, row]));
    assert.equal(byId.get("persistent-worker")?.freshness, "FRESH"); assert.equal(byId.get("persistent-worker")?.routable, true);
    assert.equal(byId.get("compute-stale")?.freshness, "STALE"); assert.equal(byId.get("compute-stale")?.routable, false);
    assert.equal(byId.get("compute-future")?.freshness, "FUTURE"); assert.equal(byId.get("compute-future")?.routable, false);
    assert.equal(byId.get("compute-offline")?.freshness, "FRESH"); assert.equal(byId.get("compute-offline")?.routable, false);
  } finally { cleanup(fixture); }
});

test("registry detects direct latest-row tampering and heartbeat history is append-only", () => {
  const fixture = registry();
  try {
    const worker = heartbeat(); registerAgentWorkerHeartbeat(fixture.db, worker, "2026-09-17T12:30:02Z");
    assert.throws(() => fixture.db.prepare("UPDATE agent_worker_heartbeat_events SET event = 'UPDATED'").run(), /append-only/);
    fixture.db.prepare("UPDATE agent_workers SET worker_json = ? WHERE worker_id = ?").run(JSON.stringify({ hacked: true }), worker.id);
    assert.throws(() => getAgentWorkerRecord(fixture.db, worker.id), /invalid Agent Worker|integrity/);
  } finally { cleanup(fixture); }
});

test("observer CLI reads private declaration and config without emitting provider details", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-worker-observe-cli-"));
  const declarationFile = jsonFile(root, "worker.json", rawDeclaration()), configFile = jsonFile(root, "models.json", rawModelConfig());
  const originalLog = console.log, originalError = console.error; let stdout = "", stderr = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; }; console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    const code = observeMain(["--declaration", declarationFile, "--model-config", configFile, "--json"], { cpuCores: () => 6, memoryMiB: () => 15360, clock: () => OBSERVED });
    assert.equal(code, 0); assert.equal(stderr, "");
    const worker = JSON.parse(stdout); assert.equal(worker.id, "persistent-worker");
    assert.doesNotMatch(stdout, /private-provider-model|18080/);
  } finally { console.log = originalLog; console.error = originalError; fs.rmSync(root, { recursive: true, force: true }); }
});

test("worker registry CLI registers heartbeat and discovers workers without network transport", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-worker-registry-cli-"));
  const db = path.join(root, "registry.sqlite"), heartbeatFile = jsonFile(root, "heartbeat.json", heartbeat());
  const originalLog = console.log, originalError = console.error; let stdout = "", stderr = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; }; console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    assert.equal(registryMain(["register", "--db", db, "--heartbeat", heartbeatFile, "--registered-at", "2026-09-17T12:30:02Z", "--json"]), 0);
    assert.equal(registryMain(["discover", "--db", db, "--evaluated-at", "2026-09-17T12:30:30Z", "--max-age-seconds", "120", "--json"]), 0);
    assert.match(stdout, /persistent-worker/); assert.equal(stderr, "");
  } finally { console.log = originalLog; console.error = originalError; fs.rmSync(root, { recursive: true, force: true }); }
});

test("observer and registry public source contain no SSH transport remote endpoint or private model invocation", () => {
  const observer = fs.readFileSync(new URL("../scripts/agent-worker-observe.js", import.meta.url), "utf8");
  const registrySource = fs.readFileSync(new URL("../scripts/agent-worker-registry.js", import.meta.url), "utf8");
  assert.doesNotMatch(`${observer}\n${registrySource}`, /node:child_process|spawnSync|execFile|\bfetch\s*\(|https?:\/\/|ssh|tailscale|process\.env/);
});
