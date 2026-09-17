#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { openAgentTaskRegistry } from "./agent-task-registry.js";
import { validateAgentWorker } from "./agent-worker.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const MAX_HEARTBEAT_BYTES = 2 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v) ? v : null; }
/** @param {unknown} value */
function id(value) { const v = text(value, 128); return v && ID.test(v) ? v : null; }
/** @param {unknown} value */
function integer(value) { if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value; if (typeof value === "string" && /^(?:0|[1-9][0-9]{0,14})$/.test(value)) { const n = Number(value); return Number.isSafeInteger(n) ? n : null; } return null; }
/** @param {string} value */
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

/** @param {import("node:sqlite").DatabaseSync} db @param {()=>any} body */
function transaction(db, body) { db.exec("BEGIN IMMEDIATE"); try { const result = body(); db.exec("COMMIT"); return result; } catch (error) { try { db.exec("ROLLBACK"); } catch {} throw error; } }

/** @param {any} row */
function workerRecord(row) {
  if (!row) return null;
  const workerJson = String(row.worker_json), storedHash = String(row.worker_sha256);
  let raw; try { raw = JSON.parse(workerJson); } catch { throw new Error("worker registry contains malformed canonical JSON"); }
  const validated = validateAgentWorker(raw);
  if (!validated.valid || !validated.worker) throw new Error("worker registry contains invalid Agent Worker v1 truth");
  const canonical = JSON.stringify(validated.worker), computedHash = sha256(canonical);
  if (canonical !== workerJson || computedHash !== storedHash) throw new Error("worker registry canonical JSON or SHA256 integrity check failed");
  return { worker: validated.worker, workerSha256: storedHash, observedAt: String(row.observed_at), registeredAt: String(row.registered_at), revision: Number(row.revision) };
}
/** @param {any} row */
function eventRecord(row) { return { seq: Number(row.seq), workerId: String(row.worker_id), observedAt: String(row.observed_at), registeredAt: String(row.registered_at), revision: Number(row.revision), workerSha256: String(row.worker_sha256), event: String(row.event) }; }

/** @param {string} filename */
function readHeartbeat(filename) {
  const resolved = path.resolve(filename); let stat; try { stat = fs.lstatSync(resolved); } catch { throw new Error("worker heartbeat file is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_HEARTBEAT_BYTES) throw new Error("worker heartbeat must be a bounded regular non-symlink file");
  let raw; try { raw = JSON.parse(fs.readFileSync(resolved, "utf8")); } catch { throw new Error("worker heartbeat cannot be parsed"); }
  const validated = validateAgentWorker(raw); if (!validated.valid || !validated.worker) throw new Error("worker heartbeat is invalid");
  return validated.worker;
}

/** @param {import("node:sqlite").DatabaseSync} db @param {unknown} value @param {string} registeredAt */
export function registerAgentWorkerHeartbeat(db, value, registeredAt) {
  if (!isAbsoluteIsoTimestamp(registeredAt)) throw new Error("registeredAt must be an absolute ISO timestamp");
  const validated = validateAgentWorker(value); if (!validated.valid || !validated.worker) throw new Error("Agent Worker v1 heartbeat is invalid");
  const worker = validated.worker;
  if (Date.parse(registeredAt) < Date.parse(worker.observedAt)) throw new Error("registeredAt cannot precede worker observedAt");
  const workerJson = JSON.stringify(worker), workerHash = sha256(workerJson);
  return transaction(db, () => {
    const current = db.prepare("SELECT * FROM agent_workers WHERE worker_id = ?").get(worker.id);
    if (!current) {
      db.prepare(`INSERT INTO agent_workers (worker_id, worker_json, worker_sha256, observed_at, registered_at, revision) VALUES (?, ?, ?, ?, ?, 0)`)
        .run(worker.id, workerJson, workerHash, worker.observedAt, registeredAt);
      db.prepare(`INSERT INTO agent_worker_heartbeat_events (worker_id, observed_at, registered_at, revision, worker_sha256, event) VALUES (?, ?, ?, 0, ?, 'REGISTERED')`)
        .run(worker.id, worker.observedAt, registeredAt, workerHash);
      return { created: true, updated: false, record: workerRecord(db.prepare("SELECT * FROM agent_workers WHERE worker_id = ?").get(worker.id)) };
    }
    const currentObserved = String(current.observed_at), currentHash = String(current.worker_sha256);
    const cmp = Date.parse(worker.observedAt) - Date.parse(currentObserved);
    if (cmp < 0) throw new Error("worker heartbeat is older than registered worker truth");
    if (cmp === 0) {
      if (currentHash !== workerHash || String(current.worker_json) !== workerJson) throw new Error("same worker observedAt conflicts with different heartbeat content");
      return { created: false, updated: false, record: workerRecord(current) };
    }
    const currentRevision = Number(current.revision), nextRevision = currentRevision + 1;
    const result = db.prepare(`UPDATE agent_workers SET worker_json = ?, worker_sha256 = ?, observed_at = ?, registered_at = ?, revision = ? WHERE worker_id = ? AND revision = ?`)
      .run(workerJson, workerHash, worker.observedAt, registeredAt, nextRevision, worker.id, currentRevision);
    if (Number(result.changes) !== 1) throw new Error("worker heartbeat registration lost a concurrent update race");
    db.prepare(`INSERT INTO agent_worker_heartbeat_events (worker_id, observed_at, registered_at, revision, worker_sha256, event) VALUES (?, ?, ?, ?, ?, 'UPDATED')`)
      .run(worker.id, worker.observedAt, registeredAt, nextRevision, workerHash);
    return { created: false, updated: true, record: workerRecord(db.prepare("SELECT * FROM agent_workers WHERE worker_id = ?").get(worker.id)) };
  });
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} workerId */
export function getAgentWorkerRecord(db, workerId) { const normalized = id(workerId); if (!normalized) throw new Error("worker id must be portable"); return workerRecord(db.prepare("SELECT * FROM agent_workers WHERE worker_id = ?").get(normalized)); }

/** @param {import("node:sqlite").DatabaseSync} db @param {string} workerId @param {number} [afterSeq] */
export function listAgentWorkerHeartbeatEvents(db, workerId, afterSeq = 0) {
  const normalized = id(workerId), after = integer(afterSeq); if (!normalized || after === null) throw new Error("worker event cursor is invalid");
  return db.prepare("SELECT * FROM agent_worker_heartbeat_events WHERE worker_id = ? AND seq > ? ORDER BY seq ASC").all(normalized, after).map(eventRecord);
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} evaluatedAt @param {number} maxAgeSeconds */
export function discoverAgentWorkers(db, evaluatedAt, maxAgeSeconds) {
  if (!isAbsoluteIsoTimestamp(evaluatedAt)) throw new Error("evaluatedAt must be an absolute ISO timestamp");
  if (!Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 1 || maxAgeSeconds > 86400) throw new Error("maxAgeSeconds must be a positive bounded integer");
  return db.prepare("SELECT * FROM agent_workers ORDER BY worker_id ASC").all().map((row) => {
    const record = workerRecord(row); if (!record) throw new Error("worker registry contains an invalid row");
    const ageSeconds = (Date.parse(evaluatedAt) - Date.parse(record.observedAt)) / 1000;
    const freshness = ageSeconds < 0 ? "FUTURE" : ageSeconds > maxAgeSeconds ? "STALE" : "FRESH";
    return { ...record, ageSeconds, freshness, routable: freshness === "FRESH" && record.worker.state === "ONLINE" };
  });
}

/** @param {any} record */
export function formatAgentWorkerRecord(record) {
  if (!record) return "Agent worker: NOT FOUND";
  return ["Agent worker registry", "", `Worker: ${record.worker.id}`, `Class: ${record.worker.class}`, `State: ${record.worker.state}`, `Observed at: ${record.observedAt}`, `Registered at: ${record.registeredAt}`, `Revision: ${record.revision}`, `Worker SHA256: ${record.workerSha256}`].join("\n");
}

/** @param {string[]} argv */
function parse(argv) {
  const command = argv[0]; if (!command || !["register", "get", "events", "discover"].includes(command)) return null;
  const values = new Map(), flags = new Set(), allowed = new Set(["--db", "--heartbeat", "--registered-at", "--worker-id", "--after-seq", "--evaluated-at", "--max-age-seconds"]);
  for (let i = 1; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { if (flags.has(arg)) return null; flags.add(arg); continue; } if (!allowed.has(arg ?? "") || values.has(arg)) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; values.set(arg, next); i += 1; }
  const db = values.get("--db"); return db ? { command, db, json: flags.has("--json"), values } : null;
}

/** @param {string[]} argv */
export function main(argv = process.argv.slice(2)) {
  const options = parse(argv); if (!options) { console.error("Usage: node scripts/agent-worker-registry.js <register|get|events|discover> --db <registry.sqlite> [command options] [--json]"); return 1; }
  let db; try { db = openAgentTaskRegistry(options.db); } catch { console.error("Agent task registry cannot be opened safely"); return 1; }
  try {
    let result;
    if (options.command === "register") { const heartbeat = options.values.get("--heartbeat"), registeredAt = options.values.get("--registered-at"); if (!heartbeat || !registeredAt) throw new Error("register requires heartbeat and registered-at"); result = registerAgentWorkerHeartbeat(db, readHeartbeat(heartbeat), registeredAt); }
    else if (options.command === "get") { const workerId = options.values.get("--worker-id"); if (!workerId) throw new Error("get requires worker-id"); result = getAgentWorkerRecord(db, workerId); }
    else if (options.command === "events") { const workerId = options.values.get("--worker-id"); if (!workerId) throw new Error("events requires worker-id"); const after = options.values.has("--after-seq") ? integer(options.values.get("--after-seq")) : 0; if (after === null) throw new Error("after-seq is invalid"); result = listAgentWorkerHeartbeatEvents(db, workerId, after); }
    else { const evaluatedAt = options.values.get("--evaluated-at"), maxAge = integer(options.values.get("--max-age-seconds")); if (!evaluatedAt || maxAge === null) throw new Error("discover requires evaluated-at and max-age-seconds"); result = discoverAgentWorkers(db, evaluatedAt, maxAge); }
    if (options.json) console.log(JSON.stringify(result)); else if (Array.isArray(result)) console.log(result.map((item) => item.worker ? formatAgentWorkerRecord(item) : JSON.stringify(item)).join("\n\n") || "(none)"); else if (result?.record) console.log(formatAgentWorkerRecord(result.record)); else console.log(formatAgentWorkerRecord(result));
    return 0;
  } catch (error) { console.error(error instanceof Error ? error.message : "worker registry operation failed"); return 1; } finally { db.close(); }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
