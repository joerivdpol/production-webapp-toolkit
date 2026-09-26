#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{ pid: number, command: string | null, uid: string | null }} PortListener */
/** @typedef {{ ok: true, listeners: PortListener[], cleaned?: boolean } | { ok: false, error: string, listeners: PortListener[], cleaned?: false }} PortResult */

/** @param {unknown} value */
export function normalizePort(value) {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

/** @param {string} stdout */
export function parseLsof(stdout) {
  /** @type {PortListener[]} */
  const listeners = [];
  /** @type {PortListener | null} */
  let current = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1);
    if (field === "p") {
      const pid = Number(value);
      if (!Number.isInteger(pid) || pid <= 0) continue;
      current = { pid, command: null, uid: null };
      listeners.push(current);
    } else if (field === "c" && current) {
      current.command = value || null;
    } else if (field === "u" && current) {
      current.uid = value || null;
    }
  }
  return listeners;
}

/** @param {number} port @returns {PortResult} */
export function inspectPort(port) {
  const result = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpcu"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const spawnError = /** @type {NodeJS.ErrnoException | undefined} */ (result.error);
  if (spawnError?.code === "ENOENT") {
    return { ok: false, error: "lsof is required for CI port inspection", listeners: [] };
  }
  if (result.status === 1 && !result.stdout) return { ok: true, listeners: [] };
  if (result.status !== 0) {
    return { ok: false, error: "CI port inspection failed", listeners: [] };
  }
  return { ok: true, listeners: parseLsof(result.stdout ?? "") };
}

/** @param {number} milliseconds */
function pause(milliseconds) {
  spawnSync("sleep", [(milliseconds / 1000).toFixed(2)], { stdio: "ignore" });
}

/**
 * @param {number} port
 * @param {{ force?: boolean }} options
 * @returns {PortResult}
 */
export function clearPort(port, options = {}) {
  const initial = inspectPort(port);
  if (!initial.ok) return initial;
  if (initial.listeners.length === 0) return { ok: true, cleaned: false, listeners: [] };

  const uid = typeof process.getuid === "function" ? String(process.getuid()) : null;
  for (const listener of initial.listeners) {
    if (uid !== null && listener.uid !== null && listener.uid !== uid) {
      return { ok: false, error: `port ${port} is owned by another user`, listeners: initial.listeners };
    }
    try {
      process.kill(listener.pid, "SIGTERM");
    } catch {
      return { ok: false, error: `could not terminate stale listener on port ${port}`, listeners: initial.listeners };
    }
  }

  pause(750);
  let remaining = inspectPort(port);
  if (!remaining.ok) return remaining;
  if (remaining.listeners.length === 0) return { ok: true, cleaned: true, listeners: initial.listeners };

  if (!options.force) {
    return { ok: false, error: `port ${port} remains occupied after SIGTERM`, listeners: remaining.listeners };
  }
  for (const listener of remaining.listeners) {
    if (uid !== null && listener.uid !== null && listener.uid !== uid) {
      return { ok: false, error: `port ${port} is owned by another user`, listeners: remaining.listeners };
    }
    try {
      process.kill(listener.pid, "SIGKILL");
    } catch {
      return { ok: false, error: `could not force-terminate stale listener on port ${port}`, listeners: remaining.listeners };
    }
  }
  pause(250);
  remaining = inspectPort(port);
  if (!remaining.ok) return remaining;
  return remaining.listeners.length === 0
    ? { ok: true, cleaned: true, listeners: initial.listeners }
    : { ok: false, error: `port ${port} remains occupied`, listeners: remaining.listeners };
}

/** @param {string[]} argv @returns {{ port: number, cleanup: boolean, force: boolean, json: boolean } | null} */
export function parseArguments(argv) {
  let port = null;
  let cleanup = false;
  let force = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--cleanup") cleanup = true;
    else if (arg === "--force") force = true;
    else if (arg === "--json") json = true;
    else if (arg === "--port") {
      if (port !== null) return null;
      const value = argv[index + 1];
      port = normalizePort(value);
      if (port === null) return null;
      index += 1;
    } else return null;
  }
  if (port === null || (force && !cleanup)) return null;
  return { port, cleanup, force, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/ci-port-guard.js --port <1024-65535> [--cleanup] [--force] [--json]");
    return 2;
  }
  const result = options.cleanup ? clearPort(options.port, { force: options.force }) : inspectPort(options.port);
  const cleaned = "cleaned" in result ? result.cleaned : false;
  const payload = {
    port: options.port,
    status: !result.ok ? "FAIL" : cleaned ? "CLEANED" : result.listeners.length === 0 ? "FREE" : "OCCUPIED",
    classification: !result.ok || (!cleaned && result.listeners.length > 0) ? "RUNNER/INFRA" : null,
    cleaned,
    listenerCount: cleaned ? 0 : result.listeners.length,
    ...(result.ok ? {} : { error: result.error }),
  };
  if (options.json) console.log(JSON.stringify(payload));
  else if (!result.ok) {
    console.error(`CI_FAILURE_CLASS=RUNNER/INFRA`);
    console.error(result.error);
  } else if (result.listeners.length > 0 && !options.cleanup) {
    console.error(`CI_FAILURE_CLASS=RUNNER/INFRA`);
    console.error(`port ${options.port} is occupied by ${result.listeners.length} listener(s)`);
  } else {
    console.log(payload.cleaned ? `CLEANED port ${options.port}` : `FREE port ${options.port}`);
  }
  if (!result.ok) return 2;
  return result.listeners.length > 0 && !options.cleanup ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
