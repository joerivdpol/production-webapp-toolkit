#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { GenericContainer, Wait } from "testcontainers";
import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

export const TESTCONTAINERS_INTEGRATION_VERSION = "12.1.0";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ENV_KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const DIGEST_IMAGE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*@sha256:[a-f0-9]{64}$/;
const MAX_INPUT_BYTES = 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value @param {number} [max] */
function text(value, max = 512) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}
/** @param {unknown} value */
function id(value) {
  const normalized = text(value, 128);
  return normalized && ID.test(normalized) ? normalized : null;
}
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
}
/** @param {unknown} value */
function immutableImage(value) {
  const image = text(value, 256);
  if (!image || /\s/.test(image) || image.includes("://")) return null;
  if (DIGEST_IMAGE.test(image)) return image;
  const lastSlash = image.lastIndexOf("/"), colon = image.lastIndexOf(":");
  if (colon <= lastSlash || colon === image.length - 1) return null;
  const tag = image.slice(colon + 1);
  if (tag.toLowerCase() === "latest" || !/[0-9]/.test(tag) || !/^[A-Za-z0-9_.-]+$/.test(tag)) return null;
  return image;
}
/** @param {string} value */
function syntheticValue(value) {
  return /^synthetic(?:[_-]|$)/.test(value);
}
/** @param {unknown} value */
export function validateTestcontainersScenarioPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "Testcontainers scenario policy must be an object" }] };
  rejectUnknown(value, ["version","repository","testcontainersVersion","scenarioId","dataClassification","startupTimeoutMs","containers"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "policy version must be exactly 1" });

  let repository = null;
  if (!object(value.repository)) errors.push({ id: "repository-invalid", detail: "repository must be an object" });
  else {
    rejectUnknown(value.repository, ["id","commit"], "repository", errors);
    const repositoryId = id(value.repository.id), commit = text(value.repository.commit, 128)?.toLowerCase() ?? null;
    if (!repositoryId || !commit || !isFullObjectId(commit)) errors.push({ id: "repository-fields-invalid", detail: "repository requires portable id and full commit" });
    else repository = { id: repositoryId, commit };
  }

  const version = text(value.testcontainersVersion, 32), scenarioId = id(value.scenarioId);
  const startupTimeoutMs = integer(value.startupTimeoutMs, 1000, 120000);
  if (version !== TESTCONTAINERS_INTEGRATION_VERSION) errors.push({ id: "testcontainers-version-invalid", detail: "testcontainersVersion must match the pinned integration version" });
  if (!scenarioId) errors.push({ id: "scenario-id-invalid", detail: "scenarioId must be a portable identifier" });
  if (value.dataClassification !== "SYNTHETIC_ONLY") errors.push({ id: "data-classification-invalid", detail: "v1 authorizes synthetic data only" });
  if (startupTimeoutMs === null) errors.push({ id: "startup-timeout-invalid", detail: "startupTimeoutMs must be between 1000 and 120000" });
  /** @type {Array<any>} */ const containers = [];
  const containerIds = new Set();
  if (!Array.isArray(value.containers) || value.containers.length === 0 || value.containers.length > 8) errors.push({ id: "containers-invalid", detail: "containers must be a non-empty bounded array" });
  else for (const [index, raw] of value.containers.entries()) {
    if (!object(raw)) { errors.push({ id: "container-invalid", detail: `containers[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["id","image","exposedPorts","environment"], "container", errors);
    const containerId = id(raw.id), image = immutableImage(raw.image);
    if (!containerId || containerIds.has(containerId) || !image) {
      errors.push({ id: "container-identity-invalid", detail: `containers[${index}] id or immutable image is invalid` });
      continue;
    }

    const ports = [];
    if (!Array.isArray(raw.exposedPorts) || raw.exposedPorts.length === 0 || raw.exposedPorts.length > 16) errors.push({ id: "ports-invalid", detail: `containers[${index}] exposedPorts must be a non-empty bounded numeric array` });
    else {
      const seen = new Set();
      for (const rawPort of raw.exposedPorts) {
        const port = integer(rawPort, 1, 65535);
        if (port === null || seen.has(port)) errors.push({ id: "port-invalid", detail: `containers[${index}] contains invalid or duplicate ports` });
        else { seen.add(port); ports.push(port); }
      }
    }
    const environment = [];
    if (!Array.isArray(raw.environment) || raw.environment.length > 32) errors.push({ id: "environment-invalid", detail: `containers[${index}] environment must be a bounded array` });
    else {
      const keys = new Set();
      for (const [envIndex, env] of raw.environment.entries()) {
        if (!object(env)) { errors.push({ id: "environment-entry-invalid", detail: `containers[${index}].environment[${envIndex}] must be an object` }); continue; }
        rejectUnknown(env, ["key","value","classification"], "environment-entry", errors);
        const key = text(env.key, 64), envValue = text(env.value, 256);
        if (!key || !ENV_KEY.test(key) || keys.has(key) || !envValue || !syntheticValue(envValue) || env.classification !== "SYNTHETIC") {
          errors.push({ id: "environment-fields-invalid", detail: `containers[${index}] environment must contain unique synthetic-only values` });
        } else {
          keys.add(key); environment.push({ key, value: envValue, classification: "SYNTHETIC" });
        }
      }
    }
    containerIds.add(containerId);
    containers.push({ id: containerId, image, exposedPorts: ports.sort((a,b)=>a-b), environment: environment.sort((a,b)=>a.key.localeCompare(b.key)) });
  }

  if (errors.length || !repository || !version || !scenarioId || startupTimeoutMs === null) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, repository, testcontainersVersion: version, scenarioId, dataClassification: "SYNTHETIC_ONLY", startupTimeoutMs, containers: containers.sort((a,b)=>a.id.localeCompare(b.id)) }, errors: [] };
}
/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, env: { PATH: "/usr/bin:/bin", LANG: "C" } });
  if (result.status !== 0) throw new Error("read-only Git inspection failed");
  return result.stdout.trim();
}
/** @param {string} root @param {string} expectedCommit */
function inspectRepository(root, expectedCommit) {
  const resolved = path.resolve(root); let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error("integration repository is unavailable"); }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) throw new Error("integration repository must be a regular non-symlink directory");
  if (path.resolve(git(resolved, ["rev-parse","--show-toplevel"])) !== resolved) throw new Error("integration repository root does not match Git top-level");
  if (git(resolved, ["rev-parse","HEAD"]).toLowerCase() !== expectedCommit) throw new Error("integration repository HEAD does not match policy commit");
  if (git(resolved, ["status","--porcelain=v1","--untracked-files=all"]) !== "") throw new Error("integration repository must be clean");
  return resolved;
}
/** @param {any} policy */
function evidenceServices(policy) {
  return policy.containers.map((/** @type {any} */ container) => ({ id: container.id, image: container.image, exposedPorts: container.exposedPorts, syntheticEnvironmentVariables: container.environment.length }));
}
/** @param {any[]} started */
async function cleanupContainers(started) {
  let stopped = 0, failed = 0;
  for (const entry of [...started].reverse()) {
    try {
      await entry.container.stop({ timeout: 10, remove: true, removeVolumes: true });
      stopped += 1;
    } catch { failed += 1; }
  }
  return { attempted: started.length, stopped, failed, status: failed === 0 ? "PASS" : "FAIL" };
}

/**
 * @template T
 * @param {string} repositoryRoot
 * @param {unknown} rawPolicy
 * @param {string} collectedAt
 * @param {(runtime:any)=>Promise<T>} callback
 * @param {{GenericContainer?:any,Wait?:any}} [dependencies]
 */
export async function withSyntheticTestcontainers(repositoryRoot, rawPolicy, collectedAt, callback, dependencies = {}) {
  if (!isAbsoluteIsoTimestamp(collectedAt)) throw new Error("collectedAt must be an absolute ISO timestamp");
  if (typeof callback !== "function") throw new Error("an explicit callback is required");
  const result = validateTestcontainersScenarioPolicy(rawPolicy);
  if (!result.valid || !result.policy) throw new Error("Testcontainers Scenario Policy v1 is invalid");
  const policy = result.policy;
  inspectRepository(repositoryRoot, policy.repository.commit);

  const Generic = dependencies.GenericContainer ?? GenericContainer;
  const WaitApi = dependencies.Wait ?? Wait;
  /** @type {Array<{id:string,container:any,runtime:any}>} */ const started = [];
  for (const service of policy.containers) {
      let builder = new Generic(service.image)
        .withExposedPorts(...service.exposedPorts)
        .withStartupTimeout(policy.startupTimeoutMs)
        .withWaitStrategy(WaitApi.forListeningPorts());
      if (service.environment.length > 0) builder = builder.withEnvironment(Object.fromEntries(service.environment.map((/** @type {any} */ entry) => [entry.key, entry.value])));
      let container;
      try { container = await builder.start(); }
      catch {
        const cleanup = await cleanupContainers(started);
        if (cleanup.failed > 0) throw new Error("service failed to start and cleanup failed");
        throw new Error("service failed to start after cleanup");
      }
      const runtime = {
        id: service.id,
        image: service.image,
        host: container.getHost(),
        ports: service.exposedPorts.map((/** @type {number} */ containerPort) => ({ containerPort, mappedPort: container.getMappedPort(containerPort) })),
      };
      started.push({ id: service.id, container, runtime });
    }

    let callbackResult;
    try { callbackResult = await callback({ scenarioId: policy.scenarioId, containers: started.map((entry) => entry.runtime) }); }
    catch {
      const cleanup = await cleanupContainers(started);
      if (cleanup.failed > 0) throw new Error("callback failed and cleanup failed");
      throw new Error("callback failed after cleanup");
    }
    const cleanup = await cleanupContainers(started);
    if (cleanup.failed > 0) throw new Error("cleanup failed");
    const evidence = {
      version: 1,
      repository: policy.repository,
      scenarioId: policy.scenarioId,
      collectedAt,
      integration: { library: "testcontainers", version: policy.testcontainersVersion },
      dataClassification: "SYNTHETIC_ONLY",
      services: evidenceServices(policy),
      cleanup,
      executionPerformed: true,
      fixedHostPortsConfigured: false,
      hostNetworkConfigured: false,
      privilegedModeConfigured: false,
      bindMountsConfigured: false,
      productionDataAuthorized: false,
      technicalStatus: "PASS",
      overallStatus: "PASS",
      semantics: "disposable synthetic integration environment only; callback runtime connection data is private and omitted from evidence; image acquisition/runtime details are controlled by the operator Docker environment",
    };
  return { result: callbackResult, evidence };
}

/** @param {string} repositoryRoot @param {unknown} rawPolicy @param {string} collectedAt @param {{GenericContainer?:any,Wait?:any}} [dependencies] */
export async function smokeTestcontainersScenario(repositoryRoot, rawPolicy, collectedAt, dependencies = {}) {
  const output = await withSyntheticTestcontainers(repositoryRoot, rawPolicy, collectedAt, async () => null, dependencies);
  return output.evidence;
}
/** @param {any} evidence */
export function formatTestcontainersEvidence(evidence) {
  const lines = [
    "Testcontainers Integration Evidence v1", "",
    `Repository: ${evidence.repository.id}@${evidence.repository.commit}`,
    `Scenario: ${evidence.scenarioId}`,
    `Testcontainers: ${evidence.integration.version}`,
    `Collected at: ${evidence.collectedAt}`,
    `Data: ${evidence.dataClassification}`,
  ];
  for (const service of evidence.services) lines.push(`Service: ${service.id} ${service.image} ports=${service.exposedPorts.join(",")}`);
  lines.push(`Cleanup: ${evidence.cleanup.status} (${evidence.cleanup.stopped}/${evidence.cleanup.attempted} stopped)`);
  lines.push(`Overall: ${evidence.overallStatus}`, `Semantics: ${evidence.semantics}`);
  return lines.join("\n");
}

/** @param {string} filename */
function readPolicy(filename) {
  const resolved = path.resolve(filename); let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error("Testcontainers policy is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_INPUT_BYTES) throw new Error("Testcontainers policy must be a bounded regular non-symlink file");
  try { return JSON.parse(fs.readFileSync(resolved, "utf8")); } catch { throw new Error("Testcontainers policy JSON cannot be parsed"); }
}
/** @param {string[]} argv */
function parse(argv) {
  const mode = argv[0]; if (!["validate","smoke"].includes(mode ?? "")) return null;
  const values = new Map(); let json = false;
  const allowed = mode === "validate" ? new Set(["--policy"]) : new Set(["--policy","--root","--collected-at"]);
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]; if (arg === "--json") { if (json) return null; json = true; continue; }
    if (!allowed.has(arg ?? "") || values.has(arg)) return null;
    const next = argv[index + 1]; if (typeof next !== "string" || next.startsWith("--")) return null;
    values.set(arg, next); index += 1;
  }
  for (const arg of allowed) if (!values.has(arg)) return null;
  return { mode, values, json };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/testcontainers-integration.js validate --policy <policy.json> [--json] | smoke --policy <policy.json> --root <repository> --collected-at <ISO> [--json]"); return 1; }
  try {
    const policy = readPolicy(options.values.get("--policy"));
    if (options.mode === "validate") {
      const result = validateTestcontainersScenarioPolicy(policy);
      if (!result.valid || !result.policy) throw new Error("Testcontainers Scenario Policy v1 is invalid");
      console.log(options.json ? JSON.stringify(result.policy) : `Testcontainers Scenario Policy v1\n\nScenario: ${result.policy.scenarioId}\nServices: ${result.policy.containers.length}\nResult: VALID`);
      return 0;
    }
    const evidence = await smokeTestcontainersScenario(options.values.get("--root"), policy, options.values.get("--collected-at"));
    console.log(options.json ? JSON.stringify(evidence) : formatTestcontainersEvidence(evidence));
    return evidence.overallStatus === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Testcontainers integration failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) main().then((code) => { process.exitCode = code; });
