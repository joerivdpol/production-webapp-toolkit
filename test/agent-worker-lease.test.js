import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  openAgentTaskRegistry,
  registerAgentTask,
  transitionAgentTask,
  getAgentTask,
} from "../scripts/agent-task-registry.js";
import {
  acquireAgentWorkerLease,
  renewAgentWorkerLease,
  releaseAgentWorkerLease,
  expireAgentWorkerLeases,
  getAgentWorkerLease,
  listAgentWorkerLeases,
  listAgentWorkerLeaseEvents,
  main,
} from "../scripts/agent-worker-lease.js";

const BASE = "a".repeat(40);

/** @param {string} id @param {string} repository @param {"READ_ONLY"|"WORKTREE_WRITE"} filesystem @returns {any} */
function rawTask(id, repository = "example-webapp", filesystem = "READ_ONLY") {
  return {
    version: 1,
    id,
    role: filesystem === "WORKTREE_WRITE" ? "repair" : "diagnose",
    repository: { id: repository, baseCommit: BASE },
    createdAt: "2026-09-17T12:00:00Z",
    risk: filesystem === "WORKTREE_WRITE" ? "MEDIUM" : "LOW",
    objective: "exercise deterministic lease fixture",
    authority: { filesystem, shell: "BOUNDED", network: "NONE", merge: false, deploy: false, productionMutation: false },
    scope: { allowedPaths: ["src/**", "test/**"], deniedPaths: [".env"], requiredChecks: ["test", "typecheck"] },
    dependsOn: [],
  };
}

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lease-"));
  const file = path.join(root, "tasks.sqlite");
  return { root, file, db: openAgentTaskRegistry(file) };
}

/** @param {ReturnType<typeof registry>} fixture */
function cleanup(fixture) {
  try { fixture.db.close(); } catch { /* already closed */ }
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

/** @param {ReturnType<typeof registry>} fixture @param {any} task @param {string} [registeredAt] */
function routedTask(fixture, task, registeredAt = "2026-09-17T12:00:05Z") {
  registerAgentTask(fixture.db, task, registeredAt);
  transitionAgentTask(fixture.db, { taskId: task.id, fromState: "QUEUED", toState: "ROUTED", expectedRevision: 0, at: "2026-09-17T12:00:10Z" });
}

/** @param {string} root @param {string} name @param {any} value */
function jsonFile(root, name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test("registry schema upgrades earlier versions to v3 without losing existing task truth", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lease-upgrade-"));
  const file = path.join(root, "tasks.sqlite");
  const old = new DatabaseSync(file);
  try {
    old.exec(`
      CREATE TABLE agent_tasks (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, repository_id TEXT NOT NULL, base_commit TEXT NOT NULL,
        task_json TEXT NOT NULL, task_sha256 TEXT NOT NULL, state TEXT NOT NULL, attempt_count INTEGER NOT NULL,
        revision INTEGER NOT NULL, created_at TEXT NOT NULL, registered_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const task = rawTask("task:upgrade");
    old.prepare(`INSERT INTO agent_tasks
      (id, role, repository_id, base_commit, task_json, task_sha256, state, attempt_count, revision, created_at, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', 0, 0, ?, ?, ?)`)
      .run(task.id, task.role, task.repository.id, task.repository.baseCommit, JSON.stringify(task), "0".repeat(64), task.createdAt, "2026-09-17T12:00:05Z", "2026-09-17T12:00:05Z");
  } finally { old.close(); }
  const db = openAgentTaskRegistry(file);
  try {
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), 3);
    assert.equal(getAgentTask(db, "task:upgrade")?.task.id, "task:upgrade");
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_worker_leases'").get());
  } finally { db.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("read-only lease mode is derived from task authority and registration is idempotent for same worker", () => {
  const fixture = registry();
  try {
    routedTask(fixture, rawTask("task:read"));
    const first = acquireAgentWorkerLease(fixture.db, { taskId: "task:read", workerId: "worker-a", at: "2026-09-17T12:01:00Z", ttlSeconds: 120 });
    const second = acquireAgentWorkerLease(fixture.db, { taskId: "task:read", workerId: "worker-a", at: "2026-09-17T12:01:30Z", ttlSeconds: 120 });
    assert.equal(first.created, true);
    assert.equal(first.lease?.mode, "READ_ONLY");
    assert.equal(second.created, false);
    assert.equal(second.lease?.leaseId, first.lease?.leaseId);
    assert.equal(listAgentWorkerLeaseEvents(fixture.db, first.lease?.leaseId ?? "").length, 1);
  } finally { cleanup(fixture); }
});

test("new leases require ROUTED task state and one active lease per task", () => {
  const fixture = registry();
  try {
    registerAgentTask(fixture.db, rawTask("task:not-routed"), "2026-09-17T12:00:05Z");
    assert.throws(() => acquireAgentWorkerLease(fixture.db, { taskId: "task:not-routed", workerId: "worker-a", at: "2026-09-17T12:01:00Z", ttlSeconds: 120 }), /must be ROUTED/);
    routedTask(fixture, rawTask("task:leased"));
    acquireAgentWorkerLease(fixture.db, { taskId: "task:leased", workerId: "worker-a", at: "2026-09-17T12:01:00Z", ttlSeconds: 120 });
    assert.throws(() => acquireAgentWorkerLease(fixture.db, { taskId: "task:leased", workerId: "worker-b", at: "2026-09-17T12:01:30Z", ttlSeconds: 120 }), /another worker/);
  } finally { cleanup(fixture); }
});

test("multiple read-only tasks may share a repository while only one write lease may exist", () => {
  const fixture = registry();
  try {
    routedTask(fixture, rawTask("task:read-a"));
    routedTask(fixture, rawTask("task:read-b"), "2026-09-17T12:00:06Z");
    routedTask(fixture, rawTask("task:write-a", "example-webapp", "WORKTREE_WRITE"), "2026-09-17T12:00:07Z");
    routedTask(fixture, rawTask("task:write-b", "example-webapp", "WORKTREE_WRITE"), "2026-09-17T12:00:08Z");
    acquireAgentWorkerLease(fixture.db, { taskId: "task:read-a", workerId: "worker-a", at: "2026-09-17T12:01:00Z", ttlSeconds: 300 });
    acquireAgentWorkerLease(fixture.db, { taskId: "task:read-b", workerId: "worker-b", at: "2026-09-17T12:01:01Z", ttlSeconds: 300 });
    const writer = acquireAgentWorkerLease(fixture.db, { taskId: "task:write-a", workerId: "worker-c", at: "2026-09-17T12:01:02Z", ttlSeconds: 300 });
    assert.equal(writer.lease?.mode, "WRITE");
    assert.throws(() => acquireAgentWorkerLease(fixture.db, { taskId: "task:write-b", workerId: "worker-d", at: "2026-09-17T12:01:03Z", ttlSeconds: 300 }), /active write lease/);
    assert.equal(listAgentWorkerLeases(fixture.db, { repository: "example-webapp", unreleasedOnly: true }).length, 3);
  } finally { cleanup(fixture); }
});

test("write leases for different repositories may coexist", () => {
  const fixture = registry();
  try {
    routedTask(fixture, rawTask("task:write-a", "repo-a", "WORKTREE_WRITE"));
    routedTask(fixture, rawTask("task:write-b", "repo-b", "WORKTREE_WRITE"), "2026-09-17T12:00:06Z");
    const a = acquireAgentWorkerLease(fixture.db, { taskId: "task:write-a", workerId: "worker-a", at: "2026-09-17T12:01:00Z", ttlSeconds: 120 });
    const b = acquireAgentWorkerLease(fixture.db, { taskId: "task:write-b", workerId: "worker-b", at: "2026-09-17T12:01:01Z", ttlSeconds: 120 });
    assert.equal(a.lease?.mode, "WRITE"); assert.equal(b.lease?.mode, "WRITE");
  } finally { cleanup(fixture); }
});

test("renewal extends TTL with owner and revision checks", () => {
  const fixture = registry();
  try {
    routedTask(fixture, rawTask("task:renew"));
    const acquired = acquireAgentWorkerLease(fixture.db, { taskId: "task:renew", workerId: "worker-a", at: "2026-09-17T12:01:00Z", ttlSeconds: 120 });
    const leaseId = acquired.lease?.leaseId ?? "";
    const renewed = renewAgentWorkerLease(fixture.db, { leaseId, workerId: "worker-a", expectedRevision: 0, at: "2026-09-17T12:02:00Z", ttlSeconds: 300 });
    assert.equal(renewed?.revision, 1);
    assert.equal(renewed?.expiresAt, "2026-09-17T12:07:00.000Z");
    assert.throws(() => renewAgentWorkerLease(fixture.db, { leaseId, workerId: "worker-a", expectedRevision: 0, at: "2026-09-17T12:03:00Z", ttlSeconds: 120 }), /revision conflict/);
    assert.throws(() => renewAgentWorkerLease(fixture.db, { leaseId, workerId: "worker-b", expectedRevision: 1, at: "2026-09-17T12:03:00Z", ttlSeconds: 120 }), /different worker/);
  } finally { cleanup(fixture); }
});

test("explicit expiry releases at the exact boundary and permits a later writer", () => {
  const fixture = registry();
  try {
    routedTask(fixture, rawTask("task:write-old", "repo-a", "WORKTREE_WRITE"));
    routedTask(fixture, rawTask("task:write-new", "repo-a", "WORKTREE_WRITE"), "2026-09-17T12:00:06Z");
    const old = acquireAgentWorkerLease(fixture.db, { taskId: "task:write-old", workerId: "worker-a", at: "2026-09-17T12:01:00Z", ttlSeconds: 60 });
    assert.throws(() => acquireAgentWorkerLease(fixture.db, { taskId: "task:write-new", workerId: "worker-b", at: "2026-09-17T12:01:59Z", ttlSeconds: 60 }), /active write lease/);
    const expired = expireAgentWorkerLeases(fixture.db, "2026-09-17T12:02:00Z");
    assert.equal(expired.length, 1);
    assert.equal(expired[0]?.releaseReason, "EXPIRED");
    const newer = acquireAgentWorkerLease(fixture.db, { taskId: "task:write-new", workerId: "worker-b", at: "2026-09-17T12:02:00Z", ttlSeconds: 60 });
    assert.equal(newer.created, true);
    assert.equal(getAgentWorkerLease(fixture.db, old.lease?.leaseId ?? "")?.releasedAt, "2026-09-17T12:02:00Z");
  } finally { cleanup(fixture); }
});

test("release is explicit, ownership-bound, revision-bound, and retained in history", () => {
  const fixture = registry();
  try {
    routedTask(fixture, rawTask("task:release"));
    const acquired = acquireAgentWorkerLease(fixture.db, { taskId: "task:release", workerId: "worker-a", at: "2026-09-17T12:01:00Z", ttlSeconds: 300 });
    const leaseId = acquired.lease?.leaseId ?? "";
    assert.throws(() => releaseAgentWorkerLease(fixture.db, { leaseId, workerId: "worker-b", expectedRevision: 0, at: "2026-09-17T12:02:00Z", reason: "HANDOFF" }), /different worker/);
    const released = releaseAgentWorkerLease(fixture.db, { leaseId, workerId: "worker-a", expectedRevision: 0, at: "2026-09-17T12:02:00Z", reason: "HANDOFF" });
    assert.equal(released?.releaseReason, "HANDOFF");
    assert.equal(released?.revision, 1);
    assert.throws(() => releaseAgentWorkerLease(fixture.db, { leaseId, workerId: "worker-a", expectedRevision: 1, at: "2026-09-17T12:03:00Z", reason: "COMPLETED" }), /no longer active/);
    assert.equal(listAgentWorkerLeaseEvents(fixture.db, leaseId).map((event) => event.event).join(","), "ACQUIRED,RELEASED");
    assert.throws(() => fixture.db.prepare("DELETE FROM agent_worker_leases WHERE lease_id = ?").run(leaseId), /retained for audit history/);
    assert.throws(() => fixture.db.prepare("UPDATE agent_worker_lease_events SET detail = 'tampered'").run(), /append-only/);
  } finally { cleanup(fixture); }
});

test("TTL bounds and lease chronology fail closed", () => {
  const fixture = registry();
  try {
    routedTask(fixture, rawTask("task:bounds"));
    for (const ttlSeconds of [29, 3601]) assert.throws(() => acquireAgentWorkerLease(fixture.db, { taskId: "task:bounds", workerId: "worker-a", at: "2026-09-17T12:01:00Z", ttlSeconds }), /invalid/);
    const acquired = acquireAgentWorkerLease(fixture.db, { taskId: "task:bounds", workerId: "worker-a", at: "2026-09-17T12:01:00Z", ttlSeconds: 120 });
    const leaseId = acquired.lease?.leaseId ?? "";
    assert.throws(() => renewAgentWorkerLease(fixture.db, { leaseId, workerId: "worker-a", expectedRevision: 0, at: "2026-09-17T12:00:59Z", ttlSeconds: 120 }), /no longer active|cannot precede/);
  } finally { cleanup(fixture); }
});

test("lease CLI uses the same local registry and no implicit endpoint", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-lease-cli-"));
  const dbFile = path.join(root, "tasks.sqlite"), taskFile = jsonFile(root, "task.json", rawTask("task:cli"));
  const db = openAgentTaskRegistry(dbFile);
  try {
    registerAgentTask(db, rawTask("task:cli"), "2026-09-17T12:00:05Z");
    transitionAgentTask(db, { taskId: "task:cli", fromState: "QUEUED", toState: "ROUTED", expectedRevision: 0, at: "2026-09-17T12:00:10Z" });
  } finally { db.close(); }
  const originalLog = console.log, originalError = console.error; let stdout = "", stderr = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; }; console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["acquire", "--db", dbFile, "--task-id", "task:cli", "--worker-id", "worker-a", "--at", "2026-09-17T12:01:00Z", "--ttl-seconds", "120", "--json"]), 0);
    const lastLine = stdout.trim().split("\n").at(-1);
    assert.ok(lastLine);
    const created = JSON.parse(lastLine);
    const leaseId = String(created.lease.leaseId);
    assert.equal(main(["events", "--db", dbFile, "--lease-id", leaseId, "--json"]), 0);
    assert.equal(main(["release", "--db", dbFile, "--lease-id", leaseId, "--worker-id", "worker-a", "--revision", "0", "--at", "2026-09-17T12:02:00Z", "--reason", "COMPLETED", "--json"]), 0);
    assert.equal(stderr, "");
  } finally {
    console.log = originalLog; console.error = originalError;
    fs.rmSync(root, { recursive: true, force: true });
    void taskFile;
  }
});

test("lease core has no network, subprocess, environment, or implicit clock surface", () => {
  const source = fs.readFileSync(new URL("../scripts/agent-worker-lease.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|Date\.now/);
  assert.doesNotMatch(source, /https?:\/\//);
  assert.match(source, /BEGIN IMMEDIATE/);
  assert.match(source, /WORKTREE_WRITE/);
});
