#!/usr/bin/env node

import crypto from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { openAgentTaskRegistry } from "./agent-task-registry.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MODES = new Set(["READ_ONLY", "WRITE"]);
const RELEASE_REASONS = new Set(["COMPLETED", "FAILED", "BLOCKED", "CANCELLED", "HANDOFF", "ROUTE_LOST"]);

/** @param {unknown} value @param {number} [max] */
function text(value, max = 512) {
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
function revision(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,14})$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

/** @param {unknown} value */
function ttl(value) {
  const parsed = revision(value);
  return parsed !== null && parsed >= 30 && parsed <= 3600 ? parsed : null;
}

/** @param {string} value */
function timestamp(value) {
  if (!isAbsoluteIsoTimestamp(value)) throw new Error("lease time must be an absolute ISO timestamp");
  return value;
}

/** @param {string} at @param {number} seconds */
function addSeconds(at, seconds) {
  return new Date(Date.parse(at) + seconds * 1000).toISOString();
}

/** @param {string} value */
function hash(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {import("node:sqlite").DatabaseSync} db @param {()=>any} body */
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
function leaseRecord(row) {
  if (!row) return null;
  return {
    leaseId: String(row.lease_id),
    taskId: String(row.task_id),
    workerId: String(row.worker_id),
    repositoryId: String(row.repository_id),
    mode: String(row.mode),
    acquiredAt: String(row.acquired_at),
    renewedAt: String(row.renewed_at),
    expiresAt: String(row.expires_at),
    revision: Number(row.revision),
    releasedAt: row.released_at === null ? null : String(row.released_at),
    releaseReason: row.release_reason === null ? null : String(row.release_reason),
  };
}

/** @param {any} row */
function eventRecord(row) {
  return {
    seq: Number(row.seq),
    leaseId: String(row.lease_id),
    taskId: String(row.task_id),
    workerId: String(row.worker_id),
    repositoryId: String(row.repository_id),
    at: String(row.at),
    event: String(row.event),
    revision: Number(row.revision),
    expiresAt: String(row.expires_at),
    detail: row.detail === null ? null : String(row.detail),
  };
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} evaluatedAt */
function expireWithinTransaction(db, evaluatedAt) {
  timestamp(evaluatedAt);
  const rows = db.prepare(`SELECT * FROM agent_worker_leases
    WHERE released_at IS NULL AND julianday(expires_at) <= julianday(?)
    ORDER BY lease_id ASC`).all(evaluatedAt);
  const expired = [];
  for (const row of rows) {
    const leaseId = String(row.lease_id), taskId = String(row.task_id), workerId = String(row.worker_id), repositoryId = String(row.repository_id), expiresAt = String(row.expires_at);
    const currentRevision = Number(row.revision), nextRevision = currentRevision + 1;
    const result = db.prepare(`UPDATE agent_worker_leases
      SET released_at = ?, release_reason = 'EXPIRED', revision = ?
      WHERE lease_id = ? AND released_at IS NULL AND revision = ?`)
      .run(evaluatedAt, nextRevision, leaseId, currentRevision);
    if (Number(result.changes) !== 1) throw new Error("worker lease expiration lost a concurrent update race");
    db.prepare(`INSERT INTO agent_worker_lease_events
      (lease_id, task_id, worker_id, repository_id, at, event, revision, expires_at, detail)
      VALUES (?, ?, ?, ?, ?, 'EXPIRED', ?, ?, NULL)`)
      .run(leaseId, taskId, workerId, repositoryId, evaluatedAt, nextRevision, expiresAt);
    expired.push(leaseRecord(db.prepare("SELECT * FROM agent_worker_leases WHERE lease_id = ?").get(leaseId)));
  }
  return expired;
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} evaluatedAt */
export function expireAgentWorkerLeases(db, evaluatedAt) {
  return transaction(db, () => expireWithinTransaction(db, evaluatedAt));
}

/** @param {import("node:sqlite").DatabaseSync} db @param {{taskId:string,workerId:string,at:string,ttlSeconds:number}} input */
export function acquireAgentWorkerLease(db, input) {
  const taskId = portableId(input.taskId), workerId = portableId(input.workerId), seconds = ttl(input.ttlSeconds);
  if (!taskId || !workerId || seconds === null) throw new Error("lease acquisition task, worker, or TTL is invalid");
  timestamp(input.at);
  return transaction(db, () => {
    expireWithinTransaction(db, input.at);
    const existing = db.prepare("SELECT * FROM agent_worker_leases WHERE task_id = ? AND released_at IS NULL").get(taskId);
    if (existing) {
      if (String(existing.worker_id) !== workerId) throw new Error("agent task already has an active lease owned by another worker");
      return { created: false, lease: leaseRecord(existing) };
    }
    const taskRow = db.prepare("SELECT task_json, state, repository_id FROM agent_tasks WHERE id = ?").get(taskId);
    if (!taskRow) throw new Error("agent task does not exist");
    if (String(taskRow.state) !== "ROUTED") throw new Error("agent task must be ROUTED before lease acquisition");
    const task = JSON.parse(String(taskRow.task_json));
    const mode = task.authority?.filesystem === "WORKTREE_WRITE" ? "WRITE" : "READ_ONLY";
    const repositoryId = String(taskRow.repository_id);
    if (mode === "WRITE") {
      const writer = db.prepare("SELECT lease_id, worker_id, task_id FROM agent_worker_leases WHERE repository_id = ? AND mode = 'WRITE' AND released_at IS NULL").get(repositoryId);
      if (writer) throw new Error("repository already has an active write lease");
    }
    const expiresAt = addSeconds(input.at, seconds);
    const leaseId = `lease:${hash(`${taskId}\u0000${workerId}\u0000${input.at}`).slice(0, 32)}`;
    db.prepare(`INSERT INTO agent_worker_leases
      (lease_id, task_id, worker_id, repository_id, mode, acquired_at, renewed_at, expires_at, revision, released_at, release_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL)`)
      .run(leaseId, taskId, workerId, repositoryId, mode, input.at, input.at, expiresAt);
    db.prepare(`INSERT INTO agent_worker_lease_events
      (lease_id, task_id, worker_id, repository_id, at, event, revision, expires_at, detail)
      VALUES (?, ?, ?, ?, ?, 'ACQUIRED', 0, ?, NULL)`)
      .run(leaseId, taskId, workerId, repositoryId, input.at, expiresAt);
    return { created: true, lease: leaseRecord(db.prepare("SELECT * FROM agent_worker_leases WHERE lease_id = ?").get(leaseId)) };
  });
}

/** @param {import("node:sqlite").DatabaseSync} db @param {{leaseId:string,workerId:string,expectedRevision:number,at:string,ttlSeconds:number}} input */
export function renewAgentWorkerLease(db, input) {
  const leaseId = portableId(input.leaseId), workerId = portableId(input.workerId), expectedRevision = revision(input.expectedRevision), seconds = ttl(input.ttlSeconds);
  if (!leaseId || !workerId || expectedRevision === null || seconds === null) throw new Error("lease renewal identity, revision, or TTL is invalid");
  timestamp(input.at);
  return transaction(db, () => {
    expireWithinTransaction(db, input.at);
    const current = db.prepare("SELECT * FROM agent_worker_leases WHERE lease_id = ?").get(leaseId);
    if (!current) throw new Error("agent worker lease does not exist");
    if (current.released_at !== null) throw new Error("agent worker lease is no longer active");
    if (String(current.worker_id) !== workerId) throw new Error("agent worker lease is owned by a different worker");
    if (Number(current.revision) !== expectedRevision) throw new Error(`agent worker lease revision conflict: expected ${expectedRevision}, found ${Number(current.revision)}`);
    if (Date.parse(input.at) < Date.parse(String(current.renewed_at))) throw new Error("lease renewal time cannot precede prior lease activity");
    const taskId = String(current.task_id), repositoryId = String(current.repository_id);
    const nextRevision = expectedRevision + 1, expiresAt = addSeconds(input.at, seconds);
    const result = db.prepare(`UPDATE agent_worker_leases
      SET renewed_at = ?, expires_at = ?, revision = ?
      WHERE lease_id = ? AND worker_id = ? AND released_at IS NULL AND revision = ?`)
      .run(input.at, expiresAt, nextRevision, leaseId, workerId, expectedRevision);
    if (Number(result.changes) !== 1) throw new Error("agent worker lease renewal lost a concurrent update race");
    db.prepare(`INSERT INTO agent_worker_lease_events
      (lease_id, task_id, worker_id, repository_id, at, event, revision, expires_at, detail)
      VALUES (?, ?, ?, ?, ?, 'RENEWED', ?, ?, NULL)`)
      .run(leaseId, taskId, workerId, repositoryId, input.at, nextRevision, expiresAt);
    return leaseRecord(db.prepare("SELECT * FROM agent_worker_leases WHERE lease_id = ?").get(leaseId));
  });
}

/** @param {import("node:sqlite").DatabaseSync} db @param {{leaseId:string,workerId:string,expectedRevision:number,at:string,reason:string}} input */
export function releaseAgentWorkerLease(db, input) {
  const leaseId = portableId(input.leaseId), workerId = portableId(input.workerId), expectedRevision = revision(input.expectedRevision), reason = text(input.reason, 32);
  if (!leaseId || !workerId || expectedRevision === null || !reason || !RELEASE_REASONS.has(reason)) throw new Error("lease release identity, revision, or reason is invalid");
  timestamp(input.at);
  return transaction(db, () => {
    expireWithinTransaction(db, input.at);
    const current = db.prepare("SELECT * FROM agent_worker_leases WHERE lease_id = ?").get(leaseId);
    if (!current) throw new Error("agent worker lease does not exist");
    if (current.released_at !== null) throw new Error("agent worker lease is no longer active");
    if (String(current.worker_id) !== workerId) throw new Error("agent worker lease is owned by a different worker");
    if (Number(current.revision) !== expectedRevision) throw new Error(`agent worker lease revision conflict: expected ${expectedRevision}, found ${Number(current.revision)}`);
    if (Date.parse(input.at) < Date.parse(String(current.renewed_at))) throw new Error("lease release time cannot precede prior lease activity");
    const taskId = String(current.task_id), repositoryId = String(current.repository_id), currentExpiresAt = String(current.expires_at);
    const nextRevision = expectedRevision + 1;
    const result = db.prepare(`UPDATE agent_worker_leases
      SET released_at = ?, release_reason = ?, revision = ?
      WHERE lease_id = ? AND worker_id = ? AND released_at IS NULL AND revision = ?`)
      .run(input.at, reason, nextRevision, leaseId, workerId, expectedRevision);
    if (Number(result.changes) !== 1) throw new Error("agent worker lease release lost a concurrent update race");
    db.prepare(`INSERT INTO agent_worker_lease_events
      (lease_id, task_id, worker_id, repository_id, at, event, revision, expires_at, detail)
      VALUES (?, ?, ?, ?, ?, 'RELEASED', ?, ?, ?)`)
      .run(leaseId, taskId, workerId, repositoryId, input.at, nextRevision, currentExpiresAt, reason);
    return leaseRecord(db.prepare("SELECT * FROM agent_worker_leases WHERE lease_id = ?").get(leaseId));
  });
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} leaseId */
export function getAgentWorkerLease(db, leaseId) {
  const normalized = portableId(leaseId); if (!normalized) throw new Error("lease id must be a portable identifier");
  return leaseRecord(db.prepare("SELECT * FROM agent_worker_leases WHERE lease_id = ?").get(normalized));
}

/** @param {import("node:sqlite").DatabaseSync} db @param {{repository?:string|null,worker?:string|null,mode?:string|null,unreleasedOnly?:boolean}} [filters] */
export function listAgentWorkerLeases(db, filters = {}) {
  const clauses = [], values = [];
  if (filters.repository) { const value = portableId(filters.repository); if (!value) throw new Error("repository lease filter is invalid"); clauses.push("repository_id = ?"); values.push(value); }
  if (filters.worker) { const value = portableId(filters.worker); if (!value) throw new Error("worker lease filter is invalid"); clauses.push("worker_id = ?"); values.push(value); }
  if (filters.mode) { const value = text(filters.mode, 32); if (!value || !MODES.has(value)) throw new Error("lease mode filter is invalid"); clauses.push("mode = ?"); values.push(value); }
  if (filters.unreleasedOnly) clauses.push("released_at IS NULL");
  const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
  return db.prepare(`SELECT * FROM agent_worker_leases${where} ORDER BY acquired_at ASC, lease_id ASC`).all(...values).map(leaseRecord);
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} leaseId @param {number} [afterSeq] */
export function listAgentWorkerLeaseEvents(db, leaseId, afterSeq = 0) {
  const normalized = portableId(leaseId), after = revision(afterSeq);
  if (!normalized || after === null) throw new Error("lease event cursor is invalid");
  return db.prepare("SELECT * FROM agent_worker_lease_events WHERE lease_id = ? AND seq > ? ORDER BY seq ASC").all(normalized, after).map(eventRecord);
}

/** @param {any} lease */
export function formatAgentWorkerLease(lease) {
  if (!lease) return "Agent worker lease: NOT FOUND";
  return ["Agent worker lease", "", `Lease: ${lease.leaseId}`, `Task: ${lease.taskId}`, `Worker: ${lease.workerId}`, `Repository: ${lease.repositoryId}`, `Mode: ${lease.mode}`, `Acquired at: ${lease.acquiredAt}`, `Renewed at: ${lease.renewedAt}`, `Expires at: ${lease.expiresAt}`, `Revision: ${lease.revision}`, `Released at: ${lease.releasedAt ?? "(unreleased)"}`, `Release reason: ${lease.releaseReason ?? "(none)"}`].join("\n");
}

/** @param {string[]} argv */
function parse(argv) {
  const command = argv[0];
  if (!command || !["acquire", "renew", "release", "expire", "get", "list", "events"].includes(command)) return null;
  const values = new Map(), flags = new Set(), allowed = new Set(["--db", "--task-id", "--worker-id", "--at", "--ttl-seconds", "--lease-id", "--revision", "--reason", "--repository", "--worker", "--mode", "--after-seq"]);
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json" || argument === "--unreleased-only") { if (flags.has(argument)) return null; flags.add(argument); continue; }
    if (!allowed.has(argument ?? "") || values.has(argument)) return null;
    const value = argv[index + 1]; if (typeof value !== "string" || value.startsWith("--")) return null;
    values.set(argument, value); index += 1;
  }
  const db = values.get("--db"); if (!db) return null;
  return { command, db, json: flags.has("--json"), unreleasedOnly: flags.has("--unreleased-only"), values };
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/agent-worker-lease.js <acquire|renew|release|expire|get|list|events> --db <registry.sqlite> [command options] [--json]"); return 1; }
  let db; try { db = openAgentTaskRegistry(options.db); } catch { console.error("Agent task registry cannot be opened safely"); return 1; }
  try {
    let result;
    if (options.command === "acquire") {
      const taskId = options.values.get("--task-id"), workerId = options.values.get("--worker-id"), at = options.values.get("--at"), ttlSeconds = ttl(options.values.get("--ttl-seconds"));
      if (!taskId || !workerId || !at || ttlSeconds === null) throw new Error("acquire requires task, worker, time, and bounded TTL");
      result = acquireAgentWorkerLease(db, { taskId, workerId, at, ttlSeconds });
    } else if (options.command === "renew") {
      const leaseId = options.values.get("--lease-id"), workerId = options.values.get("--worker-id"), at = options.values.get("--at"), expectedRevision = revision(options.values.get("--revision")), ttlSeconds = ttl(options.values.get("--ttl-seconds"));
      if (!leaseId || !workerId || !at || expectedRevision === null || ttlSeconds === null) throw new Error("renew requires lease, worker, revision, time, and bounded TTL");
      result = renewAgentWorkerLease(db, { leaseId, workerId, expectedRevision, at, ttlSeconds });
    } else if (options.command === "release") {
      const leaseId = options.values.get("--lease-id"), workerId = options.values.get("--worker-id"), at = options.values.get("--at"), expectedRevision = revision(options.values.get("--revision")), reason = options.values.get("--reason");
      if (!leaseId || !workerId || !at || expectedRevision === null || !reason) throw new Error("release requires lease, worker, revision, time, and reason");
      result = releaseAgentWorkerLease(db, { leaseId, workerId, expectedRevision, at, reason });
    } else if (options.command === "expire") {
      const at = options.values.get("--at"); if (!at) throw new Error("expire requires explicit --at");
      result = expireAgentWorkerLeases(db, at);
    } else if (options.command === "get") {
      const leaseId = options.values.get("--lease-id"); if (!leaseId) throw new Error("get requires --lease-id");
      result = getAgentWorkerLease(db, leaseId);
    } else if (options.command === "events") {
      const leaseId = options.values.get("--lease-id"); if (!leaseId) throw new Error("events requires --lease-id");
      const after = options.values.has("--after-seq") ? revision(options.values.get("--after-seq")) : 0; if (after === null) throw new Error("events cursor is invalid");
      result = listAgentWorkerLeaseEvents(db, leaseId, after);
    } else {
      result = listAgentWorkerLeases(db, { repository: options.values.get("--repository") ?? null, worker: options.values.get("--worker") ?? null, mode: options.values.get("--mode") ?? null, unreleasedOnly: options.unreleasedOnly });
    }
    if (options.json) console.log(JSON.stringify(result));
    else if (Array.isArray(result)) console.log(result.map((item) => item?.leaseId ? formatAgentWorkerLease(item) : JSON.stringify(item)).join("\n\n") || "(none)");
    else if (result?.lease) console.log(formatAgentWorkerLease(result.lease));
    else console.log(formatAgentWorkerLease(result));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Agent worker lease operation failed");
    return 1;
  } finally { db.close(); }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
