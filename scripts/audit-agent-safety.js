#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_AGENTS_BYTES = 1024 * 1024;
const BOUNDARY_IDS = ["secrets", "migrations", "deployment"];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized)
    ? normalized
    : null;
}

/** @param {unknown} value */
function portableId(value) {
  const normalized = text(value, 128);
  return normalized && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(normalized)
    ? normalized
    : null;
}

/** @param {unknown} value */
function safePath(value) {
  const normalized = text(value, 512);
  if (!normalized || path.isAbsolute(normalized) || normalized.includes("\\")) return null;
  const posix = path.posix.normalize(normalized);
  return posix !== "." && posix !== ".." && !posix.startsWith("../") && posix === normalized
    ? normalized
    : null;
}

/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateAgentSafetyPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "agent safety policy must be an object" }] };
  rejectUnknown(value, ["version", "repository", "agentsFile", "canonicalSources", "testCommands", "boundaries"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  const repository = portableId(value.repository);
  const agentsFile = safePath(value.agentsFile);
  if (!repository) errors.push({ id: "repository-invalid", detail: "repository must be a portable identifier" });
  if (!agentsFile) errors.push({ id: "agents-file-invalid", detail: "agentsFile must be a safe repository-relative path" });

  /** @type {Array<{id:string,path:string}>} */
  const canonicalSources = [];
  const sourceIds = new Set();
  const sourcePaths = new Set();
  if (!Array.isArray(value.canonicalSources) || value.canonicalSources.length === 0 || value.canonicalSources.length > 128) {
    errors.push({ id: "canonical-sources-invalid", detail: "canonicalSources must be a non-empty bounded array" });
  } else {
    for (const [index, raw] of value.canonicalSources.entries()) {
      if (!object(raw)) { errors.push({ id: "canonical-source-invalid", detail: `canonicalSources[${index}] must be an object` }); continue; }
      rejectUnknown(raw, ["id", "path"], "canonical-source", errors);
      const id = portableId(raw.id), sourcePath = safePath(raw.path);
      if (!id || !sourcePath || sourceIds.has(id) || sourcePaths.has(sourcePath)) {
        errors.push({ id: "canonical-source-fields-invalid", detail: `canonicalSources[${index}] requires unique portable id and safe path` });
        continue;
      }
      sourceIds.add(id); sourcePaths.add(sourcePath); canonicalSources.push({ id, path: sourcePath });
    }
  }

  /** @type {Array<{id:string,command:string}>} */
  const testCommands = [];
  const commandIds = new Set();
  const commands = new Set();
  if (!Array.isArray(value.testCommands) || value.testCommands.length === 0 || value.testCommands.length > 128) {
    errors.push({ id: "test-commands-invalid", detail: "testCommands must be a non-empty bounded array" });
  } else {
    for (const [index, raw] of value.testCommands.entries()) {
      if (!object(raw)) { errors.push({ id: "test-command-invalid", detail: `testCommands[${index}] must be an object` }); continue; }
      rejectUnknown(raw, ["id", "command"], "test-command", errors);
      const id = portableId(raw.id), command = text(raw.command, 512);
      if (!id || !command || commandIds.has(id) || commands.has(command)) {
        errors.push({ id: "test-command-fields-invalid", detail: `testCommands[${index}] requires unique portable id and single-line command` });
        continue;
      }
      commandIds.add(id); commands.add(command); testCommands.push({ id, command });
    }
  }

  /** @type {Record<string,{policyPath:string}>} */
  const boundaries = {};
  if (!object(value.boundaries)) errors.push({ id: "boundaries-invalid", detail: "boundaries must be an object" });
  else {
    rejectUnknown(value.boundaries, BOUNDARY_IDS, "boundaries", errors);
    for (const boundary of BOUNDARY_IDS) {
      const raw = value.boundaries[boundary];
      if (!object(raw)) { errors.push({ id: "boundary-missing", detail: `boundary ${boundary} must be explicitly configured` }); continue; }
      rejectUnknown(raw, ["policyPath"], `boundary-${boundary}`, errors);
      const policyPath = safePath(raw.policyPath);
      if (!policyPath) { errors.push({ id: "boundary-path-invalid", detail: `boundary ${boundary} requires a safe policyPath` }); continue; }
      boundaries[boundary] = { policyPath };
    }
  }

  if (errors.length > 0 || !repository || !agentsFile || BOUNDARY_IDS.some((id) => !boundaries[id])) {
    return { valid: false, policy: null, errors };
  }
  return {
    valid: true,
    policy: {
      version: 1,
      repository,
      agentsFile,
      canonicalSources: canonicalSources.sort((a, b) => a.id.localeCompare(b.id)),
      testCommands: testCommands.sort((a, b) => a.id.localeCompare(b.id)),
      boundaries,
    },
    errors: [],
  };
}

/** @param {string} root @param {string} relative @param {number} [maxBytes] */
function inspectRegularFile(root, relative, maxBytes = MAX_AGENTS_BYTES) {
  const absolute = path.resolve(root, ...relative.split("/"));
  const rel = path.relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { ok: false, absolute, reason: "outside-repository" };
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { return { ok: false, absolute, reason: "missing" }; }
  if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, absolute, reason: "not-regular-file" };
  if (stat.size <= 0 || stat.size > maxBytes) return { ok: false, absolute, reason: "empty-or-oversized" };
  return { ok: true, absolute, reason: null };
}

/** @param {string} markdown */
function documentedPaths(markdown) {
  const references = new Set();
  for (const match of markdown.matchAll(/`([^`\r\n]+)`/g)) {
    const value = match[1]?.trim();
    if (value && !/\s/.test(value)) references.add(value);
  }
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const value = match[1]?.trim().split("#", 1)[0];
    if (value) references.add(value);
  }
  return references;
}

/** @param {string} markdown */
function fencedCommandLines(markdown) {
  const commands = new Set();
  const lines = markdown.split(/\r?\n/);
  let fence = null;
  for (const line of lines) {
    const start = /^\s*(```+|~~~+)/.exec(line);
    if (start) {
      const marker = start[1]?.[0] ?? null;
      if (marker !== null) {
        if (fence === null) fence = marker;
        else if (marker === fence) fence = null;
      }
      continue;
    }
    if (fence !== null) {
      const command = line.trim();
      if (command) commands.add(command);
    }
  }
  return commands;
}

/** @param {string} root @param {any} policy */
export function inspectAgentSafety(root, policy) {
  const repositoryRoot = path.resolve(root);
  /** @type {Array<{id:string,status:"PASS"|"FAIL",scope:string,detail:string}>} */
  const checks = [];
  /** @param {string} id @param {boolean} passed @param {string} scope @param {string} detail */
  const add = (id, passed, scope, detail) => checks.push({ id, status: passed ? "PASS" : "FAIL", scope, detail });

  let rootStat;
  try { rootStat = fs.lstatSync(repositoryRoot); } catch { rootStat = null; }
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    add("repository-unavailable", false, policy.repository, "repository root must be a regular non-symlink directory");
    return buildAgentSafetyReport(policy, checks, true);
  }

  const agents = inspectRegularFile(repositoryRoot, policy.agentsFile);
  add("agents-file", agents.ok, policy.agentsFile, agents.ok ? "AGENTS instructions are inspectable" : `AGENTS instructions are ${agents.reason}`);
  if (!agents.ok) return buildAgentSafetyReport(policy, checks, false);

  const markdown = fs.readFileSync(agents.absolute, "utf8");
  if (markdown.includes("\0")) {
    add("agents-text", false, policy.agentsFile, "AGENTS instructions contain binary NUL content");
    return buildAgentSafetyReport(policy, checks, false);
  }
  const paths = documentedPaths(markdown);
  const commands = fencedCommandLines(markdown);

  for (const source of policy.canonicalSources) {
    const file = inspectRegularFile(repositoryRoot, source.path);
    add("canonical-source-present", file.ok, source.id, file.ok ? `canonical source ${source.path} is inspectable` : `canonical source ${source.path} is ${file.reason}`);
    add("canonical-source-referenced", paths.has(source.path), source.id, paths.has(source.path) ? "AGENTS references the canonical source path" : "AGENTS does not reference the canonical source path as inline code or a markdown link");
  }

  for (const command of policy.testCommands) {
    add("test-command-documented", commands.has(command.command), command.id, commands.has(command.command) ? "required test command appears as an exact fenced-code line" : "required test command is absent from fenced code");
  }

  for (const boundary of BOUNDARY_IDS) {
    const config = policy.boundaries[boundary];
    const file = inspectRegularFile(repositoryRoot, config.policyPath);
    add("boundary-policy-present", file.ok, boundary, file.ok ? `${boundary} boundary policy file is inspectable` : `${boundary} boundary policy file is ${file.reason}`);
    add("boundary-policy-referenced", paths.has(config.policyPath), boundary, paths.has(config.policyPath) ? "AGENTS references the boundary policy path" : "AGENTS does not reference the boundary policy path as inline code or a markdown link");
  }

  return buildAgentSafetyReport(policy, checks, false);
}

/** @param {any} policy @param {Array<any>} checks @param {boolean} technicalFailure */
function buildAgentSafetyReport(policy, checks, technicalFailure) {
  const fail = checks.filter((check) => check.status === "FAIL").length;
  return {
    repository: policy.repository,
    agentsFile: policy.agentsFile,
    checks: checks.sort((a, b) => `${a.scope}:${a.id}`.localeCompare(`${b.scope}:${b.id}`)),
    summary: { pass: checks.length - fail, fail },
    technicalStatus: technicalFailure ? "FAIL" : "PASS",
    overallStatus: fail > 0 ? "FAIL" : "PASS",
    semantics: "document binding only; policy-file presence and AGENTS references do not prove that an agent read, understood, or obeyed the referenced instructions",
  };
}

/** @param {ReturnType<typeof inspectAgentSafety>} report */
export function formatAgentSafety(report) {
  const lines = ["AI agent safety profile audit", "", `Repository: ${report.repository}`, `AGENTS: ${report.agentsFile}`, `Semantics: ${report.semantics}`, ""];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.scope}  ${check.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }

/** @param {string[]} argv */
function parse(argv) {
  let root = null, policyFile = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--root", "--policy"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--root") { if (root !== null) return null; root = value; }
    else { if (policyFile !== null) return null; policyFile = value; }
  }
  return root && policyFile ? { root, policyFile, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/audit-agent-safety.js --root <repository> --policy <agent-safety-policy.json> [--json]"); return 1; }
  const raw = readJson(options.policyFile);
  if (!raw) { console.error("Agent safety policy cannot be read or parsed"); return 1; }
  const validated = validateAgentSafetyPolicy(raw);
  if (!validated.valid || !validated.policy) { console.error("Agent safety policy is invalid"); return 1; }
  const report = inspectAgentSafety(path.resolve(options.root), validated.policy);
  console.log(options.json ? JSON.stringify(report) : formatAgentSafety(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
