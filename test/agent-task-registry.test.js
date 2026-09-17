import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  getAgentTask,
  listAgentTaskEvents,
  listAgentTasks,
  main,
  openAgentTaskRegistry,
  registerAgentTask,
  transitionAgentTask,
} from "../scripts/agent-task-registry.js";

const BASE = "a".repeat(40);

/** @param {string} [taskId] @returns {any} */
function rawTask(taskId = "task:diagnose:one") {
  return {
    version: 1,
    id: taskId,
    role: "diagnose",
    repository: { id: "example-webapp", baseCommit: BASE },
    createdAt: "2026-09-17T12:00:00Z",
    risk: "LOW",
    objective: "diagnose deterministic fixture failure",
    authority: { filesystem: "READ_ONLY", shell: "BOUNDED", network: "NONE", merge: false, deploy: false, productionMutation: false },
    scope: { allowedPaths: ["src/**", "test/**"], deniedPaths: [".env"], requiredChecks: ["test", "typecheck"] },
    dependsOn: [],
  };
}

function registry() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-"));
  const file = path.join(root, "tasks.sqlite");
  return { root, file, db: openAgentTaskRegistry(file) };
}

/** @param {ReturnType<typeof registry>} fixture */
function cleanup(fixture) {
  try { fixture.db.close(); } catch { /* already closed */ }
  fs.rmSync(fixture.root, { recursive: true, force: true });
}

/** @param {string} root @param {string} name @param {any} value */
function jsonFile(root, name, value) {
  const file = path.join(root, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

test("registry initializes schema and idempotently registers immutable Agent Task v1", () => {
  const fixture = registry();
  try {
    const first = registerAgentTask(fixture.db, rawTask(), "2026-09-17T12:00:05Z");
    const second = registerAgentTask(fixture.db, rawTask(), "2026-09-17T12:00:10Z");
    assert.equal(first.created, true);
    assert.equal(second.created, false);
    assert.equal(first.record?.state, "QUEUED");
    assert.equal(first.record?.revision, 0);
    assert.equal(first.record?.attemptCount, 0);
    assert.match(first.record?.taskSha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(listAgentTaskEvents(fixture.db, rawTask().id).length, 1);
    assert.equal(Number(fixture.db.prepare("PRAGMA user_version").get()?.user_version), 2);
  } finally { cleanup(fixture); }
});

test("same task id with different immutable content is rejected", () => {
  const fixture = registry();
  try {
    registerAgentTask(fixture.db, rawTask(), "2026-09-17T12:00:05Z");
    const collision = rawTask(); collision.objective = "different immutable objective";
    assert.throws(() => registerAgentTask(fixture.db, collision, "2026-09-17T12:00:06Z"), /different immutable content/);
    assert.equal(listAgentTaskEvents(fixture.db, rawTask().id).length, 1);
  } finally { cleanup(fixture); }
});

test("canonical task lifecycle increments revisions and attempts deterministically", () => {
  const fixture = registry();
  try {
    registerAgentTask(fixture.db, rawTask(), "2026-09-17T12:00:05Z");
    let record = transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "QUEUED", toState: "ROUTED", expectedRevision: 0, at: "2026-09-17T12:01:00Z" });
    assert.equal(record?.revision, 1); assert.equal(record?.attemptCount, 0);
    record = transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "ROUTED", toState: "RUNNING", expectedRevision: 1, at: "2026-09-17T12:02:00Z" });
    assert.equal(record?.revision, 2); assert.equal(record?.attemptCount, 1);
    record = transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "RUNNING", toState: "WAITING_REVIEW", expectedRevision: 2, at: "2026-09-17T12:03:00Z" });
    record = transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "WAITING_REVIEW", toState: "COMPLETED", expectedRevision: 3, at: "2026-09-17T12:04:00Z" });
    assert.equal(record?.state, "COMPLETED"); assert.equal(record?.revision, 4); assert.equal(record?.attemptCount, 1);
    const events = listAgentTaskEvents(fixture.db, rawTask().id);
    assert.deepEqual(events.map((event) => event.toState), ["QUEUED", "ROUTED", "RUNNING", "WAITING_REVIEW", "COMPLETED"]);
    assert.throws(() => transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "COMPLETED", toState: "QUEUED", expectedRevision: 4, at: "2026-09-17T12:05:00Z" }), /not allowed/);
  } finally { cleanup(fixture); }
});

test("stale expected state and revision cannot overwrite newer task truth", () => {
  const fixture = registry();
  try {
    registerAgentTask(fixture.db, rawTask(), "2026-09-17T12:00:05Z");
    transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "QUEUED", toState: "ROUTED", expectedRevision: 0, at: "2026-09-17T12:01:00Z" });
    assert.throws(() => transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "QUEUED", toState: "FAILED", expectedRevision: 0, at: "2026-09-17T12:02:00Z" }), /state conflict/);
    assert.throws(() => transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "ROUTED", toState: "RUNNING", expectedRevision: 0, at: "2026-09-17T12:02:00Z" }), /revision conflict/);
    assert.equal(getAgentTask(fixture.db, rawTask().id)?.state, "ROUTED");
  } finally { cleanup(fixture); }
});

test("FAILED tasks can be explicitly retried and attempts count actual RUNNING entries", () => {
  const fixture = registry();
  try {
    registerAgentTask(fixture.db, rawTask(), "2026-09-17T12:00:05Z");
    transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "QUEUED", toState: "ROUTED", expectedRevision: 0, at: "2026-09-17T12:01:00Z" });
    transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "ROUTED", toState: "RUNNING", expectedRevision: 1, at: "2026-09-17T12:02:00Z" });
    transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "RUNNING", toState: "FAILED", expectedRevision: 2, at: "2026-09-17T12:03:00Z", detail: "bounded synthetic failure" });
    let record = transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "FAILED", toState: "QUEUED", expectedRevision: 3, at: "2026-09-17T12:04:00Z" });
    assert.equal(record?.attemptCount, 1);
    transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "QUEUED", toState: "ROUTED", expectedRevision: 4, at: "2026-09-17T12:05:00Z" });
    record = transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "ROUTED", toState: "RUNNING", expectedRevision: 5, at: "2026-09-17T12:06:00Z" });
    assert.equal(record?.attemptCount, 2);
    assert.equal(listAgentTaskEvents(fixture.db, rawTask().id).some((event) => event.event === "RETRIED"), true);
  } finally { cleanup(fixture); }
});

test("event chronology is monotone and event history is append-only", () => {
  const fixture = registry();
  try {
    registerAgentTask(fixture.db, rawTask(), "2026-09-17T12:00:05Z");
    assert.throws(() => transitionAgentTask(fixture.db, { taskId: rawTask().id, fromState: "QUEUED", toState: "ROUTED", expectedRevision: 0, at: "2026-09-17T12:00:04Z" }), /cannot precede/);
    assert.throws(() => fixture.db.prepare("UPDATE agent_task_events SET detail = 'tampered'").run(), /append-only/);
    assert.throws(() => fixture.db.prepare("DELETE FROM agent_task_events").run(), /append-only/);
    assert.throws(() => fixture.db.prepare("UPDATE agent_tasks SET task_json = '{}' WHERE id = ?").run(rawTask().id), /identity is immutable/);
    assert.throws(() => fixture.db.prepare("DELETE FROM agent_tasks WHERE id = ?").run(rawTask().id), /retained for audit history/);
    assert.equal(listAgentTaskEvents(fixture.db, rawTask().id).length, 1);
  } finally { cleanup(fixture); }
});

test("list and event cursors remain explicit and deterministic", () => {
  const fixture = registry();
  try {
    registerAgentTask(fixture.db, rawTask("task:one"), "2026-09-17T12:00:05Z");
    const second = rawTask("task:two"); second.repository.id = "other-service";
    registerAgentTask(fixture.db, second, "2026-09-17T12:00:06Z");
    transitionAgentTask(fixture.db, { taskId: "task:one", fromState: "QUEUED", toState: "ROUTED", expectedRevision: 0, at: "2026-09-17T12:01:00Z" });
    assert.deepEqual(listAgentTasks(fixture.db, { state: "ROUTED" }).map((item) => item?.task.id), ["task:one"]);
    assert.deepEqual(listAgentTasks(fixture.db, { repository: "other-service" }).map((item) => item?.task.id), ["task:two"]);
    const allEvents = listAgentTaskEvents(fixture.db, "task:one");
    assert.equal(allEvents.length, 2);
    assert.deepEqual(listAgentTaskEvents(fixture.db, "task:one", allEvents[0]?.seq ?? 0).map((event) => event.event), ["TRANSITIONED"]);
  } finally { cleanup(fixture); }
});

test("registry rejects symlink database paths and symlink parent directories", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-symlink-"));
  try {
    const target = path.join(root, "target.sqlite"); fs.writeFileSync(target, "not-a-database");
    const link = path.join(root, "link.sqlite"); fs.symlinkSync(target, link);
    assert.throws(() => openAgentTaskRegistry(link), /non-symlink/);
    const real = path.join(root, "real"); fs.mkdirSync(real);
    const parentLink = path.join(root, "parent-link"); fs.symlinkSync(real, parentLink);
    assert.throws(() => openAgentTaskRegistry(path.join(parentLink, "tasks.sqlite")), /must not traverse symlinks|regular directory/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("registry CLI composes explicit task files, transitions, reads, and event history", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-registry-cli-"));
  const db = path.join(root, "tasks.sqlite"), taskFile = jsonFile(root, "task.json", rawTask("task:cli"));
  const originalLog = console.log, originalError = console.error; let stdout = "", stderr = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; }; console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["init", "--db", db, "--json"]), 0);
    assert.equal(main(["register", "--db", db, "--task", taskFile, "--at", "2026-09-17T12:00:05Z", "--json"]), 0);
    assert.equal(main(["transition", "--db", db, "--task-id", "task:cli", "--from", "QUEUED", "--to", "ROUTED", "--revision", "0", "--at", "2026-09-17T12:01:00Z", "--json"]), 0);
    assert.equal(main(["get", "--db", db, "--task-id", "task:cli", "--json"]), 0);
    assert.equal(main(["events", "--db", db, "--task-id", "task:cli", "--json"]), 0);
    assert.match(stdout, /task:cli/); assert.equal(stderr, "");
  } finally {
    console.log = originalLog; console.error = originalError;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("registry has no network, subprocess, environment, or implicit clock surface", () => {
  const source = fs.readFileSync(new URL("../scripts/agent-task-registry.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|Date\.now|new Date\s*\(/);
  assert.match(source, /BEGIN IMMEDIATE/);
  assert.match(source, /append-only/);
});
