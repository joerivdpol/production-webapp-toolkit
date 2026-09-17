#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { validateAgentTask } from "./agent-task.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

export const AGENT_TASK_STATES = [
  "QUEUED",
  "ROUTED",
  "RUNNING",
  "WAITING_REVIEW",
  "BLOCKED",
  "FAILED",
  "COMPLETED",
  "CANCELLED",
  "SUPERSEDED",
];

const STATES = new Set(AGENT_TASK_STATES);
const TERMINAL = new Set(["COMPLETED", "CANCELLED", "SUPERSEDED"]);
const TRANSITIONS = new Map([
  ["QUEUED", new Set(["ROUTED", "BLOCKED", "FAILED", "CANCELLED", "SUPERSEDED"])],
  ["ROUTED", new Set(["QUEUED", "RUNNING", "BLOCKED", "FAILED", "CANCELLED", "SUPERSEDED"])],
  ["RUNNING", new Set(["WAITING_REVIEW", "COMPLETED", "BLOCKED", "FAILED", "CANCELLED"])],
  ["WAITING_REVIEW", new Set(["COMPLETED", "BLOCKED", "FAILED", "CANCELLED"])],
  ["BLOCKED", new Set(["QUEUED", "CANCELLED", "SUPERSEDED"])],
  ["FAILED", new Set(["QUEUED", "CANCELLED", "SUPERSEDED"])],
  ["COMPLETED", new Set()],
  ["CANCELLED", new Set()],
  ["SUPERSEDED", new Set()],
]);

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** @param {unknown} value @param {number} [max] */
function text(value, max = 1024) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}

/** @param {unknown} value */
function portableId(value) {
  const normalized = text(value, 128);
  return normalized && ID.test(normalized) ? normalized : null;
}

/** @param {unknown} value */
function state(value) {
  const normalized = text(value, 32);
  return normalized && STATES.has(normalized) ? normalized : null;
}

/** @param {unknown} value */
function revision(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,14})$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** @param {string} value */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {string} filename */
function databasePath(filename) {
  const requested = path.resolve(filename);
  const parent = path.dirname(requested);
  let parentStat;
  try { parentStat = fs.lstatSync(parent); } catch { throw new Error("agent registry parent directory is unavailable"); }
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error("agent registry parent must be a regular directory");
  let realParent;
  try { realParent = fs.realpathSync(parent); } catch { throw new Error("agent registry parent directory cannot be resolved"); }
  if (realParent !== parent) throw new Error("agent registry parent path must not traverse symlinks");
  if (fs.existsSync(requested)) {
    const stat = fs.lstatSync(requested);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("agent registry database must be a regular non-symlink file");
  }
  return requested;
}

/** @param {DatabaseSync} db */
function configure(db) {
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
}

/** @param {DatabaseSync} db */
function installSchema(db) {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version !== 0 && version !== 1) throw new Error(`unsupported agent registry schema version ${version}`);
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_tasks (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      base_commit TEXT NOT NULL,
      task_json TEXT NOT NULL,
      task_sha256 TEXT NOT NULL CHECK(length(task_sha256) = 64),
      state TEXT NOT NULL CHECK(state IN ('QUEUED','ROUTED','RUNNING','WAITING_REVIEW','BLOCKED','FAILED','COMPLETED','CANCELLED','SUPERSEDED')),
      attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
      revision INTEGER NOT NULL DEFAULT 0 CHECK(revision >= 0),
      created_at TEXT NOT NULL,
      registered_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS agent_tasks_state_idx ON agent_tasks(state, updated_at, id);
    CREATE INDEX IF NOT EXISTS agent_tasks_repository_idx ON agent_tasks(repository_id, state, id);
    CREATE TABLE IF NOT EXISTS agent_task_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE RESTRICT,
      at TEXT NOT NULL,
      event TEXT NOT NULL,
      from_state TEXT,
      to_state TEXT NOT NULL,
      attempt_count INTEGER NOT NULL CHECK(attempt_count >= 0),
      revision INTEGER NOT NULL CHECK(revision >= 0),
      detail TEXT
    );
    CREATE INDEX IF NOT EXISTS agent_task_events_task_idx ON agent_task_events(task_id, seq);
    CREATE TRIGGER IF NOT EXISTS agent_tasks_identity_immutable
      BEFORE UPDATE OF id, role, repository_id, base_commit, task_json, task_sha256, created_at, registered_at ON agent_tasks
      BEGIN SELECT RAISE(ABORT, 'agent task identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS agent_tasks_no_delete
      BEFORE DELETE ON agent_tasks
      BEGIN SELECT RAISE(ABORT, 'agent tasks are retained for audit history'); END;
    CREATE TRIGGER IF NOT EXISTS agent_task_events_no_update
      BEFORE UPDATE ON agent_task_events
      BEGIN SELECT RAISE(ABORT, 'agent task events are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS agent_task_events_no_delete
      BEFORE DELETE ON agent_task_events
      BEGIN SELECT RAISE(ABORT, 'agent task events are append-only'); END;
    PRAGMA user_version = 1;
  `);
}

/** @param {string} filename */
export function openAgentTaskRegistry(filename) {
  const resolved = databasePath(filename);
  const db = new DatabaseSync(resolved);
  try {
    configure(db);
    installSchema(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** @param {DatabaseSync} db @param {()=>any} body */
function transaction(db, body) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = body();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original failure */ }
    throw error;
  }
}

/** @param {any} row */
function taskRecord(row) {
  if (!row) return null;
  return {
    task: JSON.parse(String(row.task_json)),
    taskSha256: String(row.task_sha256),
    state: String(row.state),
    attemptCount: Number(row.attempt_count),
    revision: Number(row.revision),
    registeredAt: String(row.registered_at),
    updatedAt: String(row.updated_at),
  };
}

/** @param {any} row */
function eventRecord(row) {
  return {
    seq: Number(row.seq),
    taskId: String(row.task_id),
    at: String(row.at),
    event: String(row.event),
    fromState: row.from_state === null ? null : String(row.from_state),
    toState: String(row.to_state),
    attemptCount: Number(row.attempt_count),
    revision: Number(row.revision),
    detail: row.detail === null ? null : String(row.detail),
  };
}

/** @param {DatabaseSync} db @param {unknown} value @param {string} registeredAt */
export function registerAgentTask(db, value, registeredAt) {
  if (!isAbsoluteIsoTimestamp(registeredAt)) throw new Error("registeredAt must be an absolute ISO timestamp");
  const validated = validateAgentTask(value);
  if (!validated.valid || !validated.task) throw new Error("Agent Task v1 input is invalid");
  const task = validated.task;
  if (Date.parse(registeredAt) < Date.parse(task.createdAt)) throw new Error("registeredAt cannot precede task createdAt");
  const taskJson = JSON.stringify(task);
  const taskHash = sha256(taskJson);
  return transaction(db, () => {
    const existing = db.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(task.id);
    if (existing) {
      if (String(existing.task_sha256) !== taskHash || String(existing.task_json) !== taskJson) throw new Error("agent task id already exists with different immutable content");
      return { created: false, record: taskRecord(existing) };
    }
    db.prepare(`INSERT INTO agent_tasks
      (id, role, repository_id, base_commit, task_json, task_sha256, state, attempt_count, revision, created_at, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'QUEUED', 0, 0, ?, ?, ?)`)
      .run(task.id, task.role, task.repository.id, task.repository.baseCommit, taskJson, taskHash, task.createdAt, registeredAt, registeredAt);
    db.prepare(`INSERT INTO agent_task_events
      (task_id, at, event, from_state, to_state, attempt_count, revision, detail)
      VALUES (?, ?, 'REGISTERED', NULL, 'QUEUED', 0, 0, NULL)`)
      .run(task.id, registeredAt);
    return { created: true, record: taskRecord(db.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(task.id)) };
  });
}

/** @param {DatabaseSync} db @param {string} taskId */
export function getAgentTask(db, taskId) {
  const normalized = portableId(taskId);
  if (!normalized) throw new Error("task id must be a portable identifier");
  return taskRecord(db.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(normalized));
}

/** @param {DatabaseSync} db @param {{state?:string|null,repository?:string|null}} [filters] */
export function listAgentTasks(db, filters = {}) {
  const clauses = [], values = [];
  if (filters.state !== undefined && filters.state !== null) {
    const normalized = state(filters.state); if (!normalized) throw new Error("state filter is invalid");
    clauses.push("state = ?"); values.push(normalized);
  }
  if (filters.repository !== undefined && filters.repository !== null) {
    const normalized = portableId(filters.repository); if (!normalized) throw new Error("repository filter is invalid");
    clauses.push("repository_id = ?"); values.push(normalized);
  }
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM agent_tasks${where} ORDER BY updated_at ASC, id ASC`).all(...values).map(taskRecord);
}

/** @param {DatabaseSync} db @param {string} taskId @param {number} [afterSeq] */
export function listAgentTaskEvents(db, taskId, afterSeq = 0) {
  const normalized = portableId(taskId); if (!normalized) throw new Error("task id must be a portable identifier");
  const after = revision(afterSeq); if (after === null) throw new Error("afterSeq must be a non-negative integer");
  return db.prepare("SELECT * FROM agent_task_events WHERE task_id = ? AND seq > ? ORDER BY seq ASC").all(normalized, after).map(eventRecord);
}

/** @param {DatabaseSync} db @param {{taskId:string,fromState:string,toState:string,expectedRevision:number,at:string,detail?:string|null}} input */
export function transitionAgentTask(db, input) {
  const taskId = portableId(input.taskId), fromState = state(input.fromState), toState = state(input.toState), expectedRevision = revision(input.expectedRevision);
  if (!taskId || !fromState || !toState || expectedRevision === null) throw new Error("task transition identity, state, or revision is invalid");
  if (!isAbsoluteIsoTimestamp(input.at)) throw new Error("transition time must be an absolute ISO timestamp");
  const detail = input.detail === undefined || input.detail === null ? null : text(input.detail, 1024);
  if (input.detail !== undefined && input.detail !== null && !detail) throw new Error("transition detail must be a bounded single-line string");
  if (!TRANSITIONS.get(fromState)?.has(toState)) throw new Error(`transition ${fromState} -> ${toState} is not allowed`);
  return transaction(db, () => {
    const current = db.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(taskId);
    if (!current) throw new Error("agent task does not exist");
    if (String(current.state) !== fromState) throw new Error(`agent task state conflict: expected ${fromState}, found ${String(current.state)}`);
    if (Number(current.revision) !== expectedRevision) throw new Error(`agent task revision conflict: expected ${expectedRevision}, found ${Number(current.revision)}`);
    if (Date.parse(input.at) < Date.parse(String(current.updated_at))) throw new Error("transition time cannot precede the previous task event");
    if (TERMINAL.has(fromState)) throw new Error("terminal agent task state cannot transition");
    const nextRevision = expectedRevision + 1;
    const nextAttempts = Number(current.attempt_count) + (toState === "RUNNING" ? 1 : 0);
    const event = (fromState === "FAILED" || fromState === "BLOCKED") && toState === "QUEUED" ? "RETRIED" : "TRANSITIONED";
    const result = db.prepare(`UPDATE agent_tasks
      SET state = ?, attempt_count = ?, revision = ?, updated_at = ?
      WHERE id = ? AND state = ? AND revision = ?`)
      .run(toState, nextAttempts, nextRevision, input.at, taskId, fromState, expectedRevision);
    if (Number(result.changes) !== 1) throw new Error("agent task transition lost a concurrent update race");
    db.prepare(`INSERT INTO agent_task_events
      (task_id, at, event, from_state, to_state, attempt_count, revision, detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, input.at, event, fromState, toState, nextAttempts, nextRevision, detail);
    return taskRecord(db.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(taskId));
  });
}

/** @param {any} record */
export function formatAgentTaskRegistryRecord(record) {
  if (!record) return "Agent task: NOT FOUND";
  return [
    "Agent task registry",
    "",
    `Task: ${record.task.id}`,
    `Role: ${record.task.role}`,
    `Repository: ${record.task.repository.id}@${record.task.repository.baseCommit}`,
    `State: ${record.state}`,
    `Attempt count: ${record.attemptCount}`,
    `Revision: ${record.revision}`,
    `Registered at: ${record.registeredAt}`,
    `Updated at: ${record.updatedAt}`,
    `Task SHA256: ${record.taskSha256}`,
  ].join("\n");
}

/** @param {string[]} argv */
function parse(argv) {
  const command = argv[0];
  if (!command || !["init", "register", "get", "list", "events", "transition"].includes(command)) return null;
  const values = new Map(), flags = new Set(), allowed = new Set(["--db", "--task", "--at", "--task-id", "--state", "--repository", "--after-seq", "--from", "--to", "--revision", "--detail"]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { if (flags.has(argument)) return null; flags.add(argument); continue; }
    if (!allowed.has(argument ?? "") || values.has(argument)) return null;
    const value = argv[index + 1]; if (typeof value !== "string" || value.startsWith("--")) return null;
    values.set(argument, value); index += 1;
  }
  const db = values.get("--db"); if (!db) return null;
  return { command, db, json: flags.has("--json"), values };
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) {
    console.error("Usage: node scripts/agent-task-registry.js <init|register|get|list|events|transition> --db <registry.sqlite> [command options] [--json]");
    return 1;
  }
  let db;
  try { db = openAgentTaskRegistry(options.db); }
  catch { console.error("Agent task registry cannot be opened safely"); return 1; }
  try {
    let result;
    if (options.command === "init") result = { version: 1, initialized: true, database: path.basename(path.resolve(options.db)) };
    else if (options.command === "register") {
      const taskFile = options.values.get("--task"), at = options.values.get("--at");
      if (!taskFile || !at) throw new Error("register requires --task and --at");
      let raw; try { raw = JSON.parse(fs.readFileSync(taskFile, "utf8")); } catch { throw new Error("Agent Task v1 file cannot be read or parsed"); }
      result = registerAgentTask(db, raw, at);
    } else if (options.command === "get") {
      const taskId = options.values.get("--task-id"); if (!taskId) throw new Error("get requires --task-id");
      result = getAgentTask(db, taskId);
    } else if (options.command === "list") {
      result = listAgentTasks(db, { state: options.values.get("--state") ?? null, repository: options.values.get("--repository") ?? null });
    } else if (options.command === "events") {
      const taskId = options.values.get("--task-id"); if (!taskId) throw new Error("events requires --task-id");
      const after = options.values.has("--after-seq") ? revision(options.values.get("--after-seq")) : 0;
      if (after === null) throw new Error("events --after-seq is invalid");
      result = listAgentTaskEvents(db, taskId, after);
    } else {
      const taskId = options.values.get("--task-id"), fromState = options.values.get("--from"), toState = options.values.get("--to"), at = options.values.get("--at"), expectedRevision = revision(options.values.get("--revision"));
      if (!taskId || !fromState || !toState || !at || expectedRevision === null) throw new Error("transition requires task id, from/to states, revision, and time");
      result = transitionAgentTask(db, { taskId, fromState, toState, expectedRevision, at, detail: options.values.get("--detail") ?? null });
    }
    if (options.json) console.log(JSON.stringify(result));
    else if (Array.isArray(result)) console.log(result.map((item) => item.task ? formatAgentTaskRegistryRecord(item) : JSON.stringify(item)).join("\n\n") || "(none)");
    else if (result?.record) console.log(formatAgentTaskRegistryRecord(result.record));
    else if (result?.task) console.log(formatAgentTaskRegistryRecord(result));
    else console.log(JSON.stringify(result));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Agent task registry operation failed");
    return 1;
  } finally { db.close(); }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
