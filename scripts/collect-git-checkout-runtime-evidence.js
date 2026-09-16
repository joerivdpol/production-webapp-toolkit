#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { adaptRuntimeCollectorObservation } from "./runtime-collector-adapter.js";
import { isAbsoluteIsoTimestamp, isFullObjectId, validateRuntimeEvidence } from "./runtime-evidence.js";

const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;
const SOURCE = "local-git-checkout";

/** @param {unknown} value */
function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {string} repository @param {string[]} args */
function runGit(repository, args) {
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "-c", "core.fsmonitor=false", "-C", repository, ...args],
    { encoding: "utf8", maxBuffer: MAX_GIT_OUTPUT_BYTES },
  );
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") {
    return { ok: false, stdout: "" };
  }
  return { ok: true, stdout: result.stdout };
}

/**
 * @param {{ repository:string, runtimeName:string, environment?:string|null }} options
 * @param {{ runGit?: typeof runGit, now?: () => string }} [dependencies]
 */
export function collectGitCheckoutRuntimeEvidence(options, dependencies = {}) {
  const repository = text(options.repository);
  const runtimeName = text(options.runtimeName);
  const environment = options.environment === undefined || options.environment === null ? null : text(options.environment);
  if (!repository) return { ok: false, evidence: null, error: "repository must be explicitly supplied" };
  if (!runtimeName) return { ok: false, evidence: null, error: "runtimeName must be non-empty" };
  if (options.environment !== undefined && options.environment !== null && !environment) {
    return { ok: false, evidence: null, error: "environment must be non-empty when supplied" };
  }

  const git = dependencies.runGit ?? runGit;
  const inside = git(repository, ["rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.stdout.trim() !== "true") {
    return { ok: false, evidence: null, error: "repository is not a readable Git worktree" };
  }

  const head = git(repository, ["rev-parse", "--verify", "HEAD"]);
  const commit = head.ok ? head.stdout.trim() : "";
  if (!head.ok || !isFullObjectId(commit)) {
    return { ok: false, evidence: null, error: "checkout HEAD is not a full Git commit identity" };
  }

  const status = git(repository, ["status", "--porcelain=v1", "--untracked-files=all", "--ignore-submodules=none"]);
  if (!status.ok) return { ok: false, evidence: null, error: "checkout cleanliness could not be established" };
  if (status.stdout.length !== 0) {
    return { ok: false, evidence: null, error: "checkout is dirty; commit identity does not fully describe checkout contents" };
  }

  const collectedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  if (!isAbsoluteIsoTimestamp(collectedAt)) {
    return { ok: false, evidence: null, error: "collector clock did not produce an absolute ISO timestamp" };
  }

  const adapted = adaptRuntimeCollectorObservation({
    version: 1,
    collector: {
      kind: "checkout",
      source: SOURCE,
      authenticated: false,
      collectedAt,
    },
    runtime: {
      name: runtimeName,
      ...(environment ? { environment } : {}),
    },
    deployment: { commit },
  });
  if (!adapted.valid || !adapted.evidence) {
    return { ok: false, evidence: null, error: "checkout observation could not be adapted to Runtime Evidence v1" };
  }
  const canonical = validateRuntimeEvidence(adapted.evidence);
  if (!canonical.valid || !canonical.evidence) {
    return { ok: false, evidence: null, error: "checkout evidence failed canonical Runtime Evidence v1 validation" };
  }
  const collector = /** @type {any} */ (canonical.evidence.metadata?.collector);
  if (collector?.kind !== "checkout" || collector?.identityScope !== "checkout") {
    return { ok: false, evidence: null, error: "checkout evidence lost its checkout identity scope" };
  }
  return { ok: true, evidence: canonical.evidence, error: null };
}

/** @param {ReturnType<typeof collectGitCheckoutRuntimeEvidence>} result */
export function formatGitCheckoutRuntimeEvidence(result) {
  if (!result.ok || !result.evidence) return `Git checkout runtime evidence\n\nResult: INVALID\nERROR  ${result.error ?? "collection failed"}`;
  return [
    "Git checkout runtime evidence",
    "",
    `Runtime: ${result.evidence.runtime.name}`,
    `Environment: ${result.evidence.runtime.environment ?? "(not supplied)"}`,
    `Checkout commit: ${result.evidence.deployment.commit}`,
    `Identity scope: ${(/** @type {any} */ (result.evidence.metadata?.collector))?.identityScope ?? "(unknown)"}`,
    `Authenticated: ${result.evidence.evidence.authenticated}`,
    `Collected at: ${result.evidence.evidence.collectedAt}`,
    "Checkout cleanliness: CLEAN",
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let repository = null;
  let runtimeName = null;
  let environment = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--repository", "--runtime-name", "--environment"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || value.length === 0) return null;
    index += 1;
    if (argument === "--repository") { if (repository !== null) return null; repository = value; }
    else if (argument === "--runtime-name") { if (runtimeName !== null) return null; runtimeName = value; }
    else { if (environment !== null) return null; environment = value; }
  }
  return repository && runtimeName ? { repository, runtimeName, environment, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/collect-git-checkout-runtime-evidence.js --repository <path> --runtime-name <name> [--environment <name>] [--json]");
    return 1;
  }
  const result = collectGitCheckoutRuntimeEvidence(options);
  if (!result.ok || !result.evidence) {
    console.error(result.error ?? "Git checkout runtime evidence collection failed");
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.evidence) : formatGitCheckoutRuntimeEvidence(result));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
