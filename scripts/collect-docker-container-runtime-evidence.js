#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { adaptRuntimeCollectorObservation } from "./runtime-collector-adapter.js";
import { isAbsoluteIsoTimestamp, isFullObjectId, validateRuntimeEvidence } from "./runtime-evidence.js";

const MAX_OUTPUT_BYTES = 1024 * 1024;
const DEFAULT_REVISION_LABEL = "org.opencontainers.image.revision";

/** @param {unknown} value */
function text(value) { return typeof value === "string" && value.trim().length > 0 ? value.trim() : null; }
/** @param {unknown} value */
function validContainer(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value); }
/** @param {unknown} value */
function validLabel(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,191}$/.test(value); }

/** @param {string[]} args */
function runDocker(args) {
  const result = spawnSync("docker", args, { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES });
  if (result.error || result.status !== 0 || typeof result.stdout !== "string") return { ok: false, stdout: "" };
  return { ok: true, stdout: result.stdout };
}

/**
 * @param {{ container:string, runtimeName:string, environment?:string|null, revisionLabel?:string|null }} options
 * @param {{ runDocker?:typeof runDocker, now?:()=>string }} [dependencies]
 */
export function collectDockerContainerRuntimeEvidence(options, dependencies = {}) {
  const container = text(options.container);
  const runtimeName = text(options.runtimeName);
  const environment = options.environment === undefined || options.environment === null ? null : text(options.environment);
  const revisionLabel = options.revisionLabel === undefined || options.revisionLabel === null ? DEFAULT_REVISION_LABEL : text(options.revisionLabel);
  if (!container || !validContainer(container)) return { ok: false, evidence: null, error: "container must be an explicit portable Docker container identifier" };
  if (!runtimeName) return { ok: false, evidence: null, error: "runtimeName must be non-empty" };
  if (options.environment !== undefined && options.environment !== null && !environment) return { ok: false, evidence: null, error: "environment must be non-empty when supplied" };
  if (!revisionLabel || !validLabel(revisionLabel)) return { ok: false, evidence: null, error: "revisionLabel must be a portable label name" };

  const docker = dependencies.runDocker ?? runDocker;
  const running = docker(["inspect", "--type", "container", "--format", "{{.State.Running}}", container]);
  if (!running.ok || running.stdout.trim() !== "true") return { ok: false, evidence: null, error: "container is unavailable or not running" };

  const labelTemplate = `{{ index .Config.Labels "${revisionLabel}" }}`;
  const revision = docker(["inspect", "--type", "container", "--format", labelTemplate, container]);
  const commit = revision.ok ? revision.stdout.trim() : "";
  if (!revision.ok || !isFullObjectId(commit)) return { ok: false, evidence: null, error: "container revision label is missing or is not a full Git object ID" };

  const collectedAt = (dependencies.now ?? (() => new Date().toISOString()))();
  if (!isAbsoluteIsoTimestamp(collectedAt)) return { ok: false, evidence: null, error: "collector clock did not produce an absolute ISO timestamp" };

  const adapted = adaptRuntimeCollectorObservation({
    version: 1,
    collector: { kind: "container", source: `docker-container-label:${revisionLabel}`, authenticated: false, collectedAt },
    runtime: { name: runtimeName, ...(environment ? { environment } : {}) },
    deployment: { commit },
  });
  if (!adapted.valid || !adapted.evidence) return { ok: false, evidence: null, error: "container identity could not be adapted to Runtime Evidence v1" };
  const canonical = validateRuntimeEvidence(adapted.evidence);
  if (!canonical.valid || !canonical.evidence) return { ok: false, evidence: null, error: "container evidence failed canonical Runtime Evidence v1 validation" };
  const collector = /** @type {any} */ (canonical.evidence.metadata?.collector);
  if (collector?.kind !== "container" || collector?.identityScope !== "container") return { ok: false, evidence: null, error: "container evidence lost its container identity scope" };
  return { ok: true, evidence: canonical.evidence, error: null };
}

/** @param {ReturnType<typeof collectDockerContainerRuntimeEvidence>} result */
export function formatDockerContainerRuntimeEvidence(result) {
  if (!result.ok || !result.evidence) return `Docker container runtime evidence\n\nResult: INVALID\nERROR  ${result.error ?? "collection failed"}`;
  return [
    "Docker container runtime evidence", "",
    `Runtime: ${result.evidence.runtime.name}`,
    `Environment: ${result.evidence.runtime.environment ?? "(not supplied)"}`,
    `Container-reported commit: ${result.evidence.deployment.commit}`,
    `Identity scope: ${(/** @type {any} */ (result.evidence.metadata?.collector))?.identityScope ?? "(unknown)"}`,
    `Source: ${result.evidence.evidence.source}`,
    `Authenticated: ${result.evidence.evidence.authenticated}`,
    `Collected at: ${result.evidence.evidence.collectedAt}`,
    "Container state: RUNNING", "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let container = null, runtimeName = null, environment = null, revisionLabel = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--container", "--runtime-name", "--environment", "--revision-label"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--") || value.length === 0) return null;
    index += 1;
    if (argument === "--container") { if (container !== null) return null; container = value; }
    else if (argument === "--runtime-name") { if (runtimeName !== null) return null; runtimeName = value; }
    else if (argument === "--environment") { if (environment !== null) return null; environment = value; }
    else { if (revisionLabel !== null) return null; revisionLabel = value; }
  }
  return container && runtimeName ? { container, runtimeName, environment, revisionLabel, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/collect-docker-container-runtime-evidence.js --container <name-or-id> --runtime-name <name> [--environment <name>] [--revision-label <label>] [--json]");
    return 1;
  }
  const result = collectDockerContainerRuntimeEvidence(options);
  if (!result.ok || !result.evidence) { console.error(result.error ?? "Docker container runtime evidence collection failed"); return 1; }
  console.log(options.json ? JSON.stringify(result.evidence) : formatDockerContainerRuntimeEvidence(result));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
