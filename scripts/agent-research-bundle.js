#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateAgentTask } from "./agent-task.js";
import { validateAgentReproductionRunEvidence } from "./agent-reproduction.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HASH = /^[a-f0-9]{64}$/;
const PURPOSES = new Set(["INSPECT", "TEST", "REPRODUCE"]);
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_EVIDENCE_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 20;
const SENSITIVE_KEY_PARTS = new Set(["token","tokens","password","passwords","secret","secrets","credential","credentials","authorization","cookie","cookies","privatekey","apikey","clientsecret","accesskey"]);

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
/** @param {unknown} value */
function safeRelative(value) {
  if (value === ".") return ".";
  const normalized = text(value, 512);
  if (!normalized || path.isAbsolute(normalized) || normalized.includes("\\")) return null;
  const posix = path.posix.normalize(normalized);
  return posix !== ".." && !posix.startsWith("../") && posix === normalized ? normalized : null;
}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
}
/** @param {Buffer|string} value */
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
/** @param {string} value */
function sensitiveKey(value) {
  const parts = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => part.toLowerCase());
  return parts.some((part) => SENSITIVE_KEY_PARTS.has(part)) || SENSITIVE_KEY_PARTS.has(parts.join(""));
}
/** @param {string} value */
function sensitiveValue(value) {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(value)
    || /\bAKIA[0-9A-Z]{16}\b/.test(value)
    || /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value);
}
/** @param {unknown} value @param {number} depth @param {Array<{id:string,detail:string}>} errors @param {string} scope */
function inspectSanitizedJson(value, depth, errors, scope) {
  if (depth > MAX_JSON_DEPTH) { errors.push({ id: "evidence-depth-invalid", detail: `${scope} exceeds maximum JSON depth` }); return; }
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return;
  if (typeof value === "string") {
    if (value.length > 64 * 1024) errors.push({ id: "evidence-string-too-large", detail: `${scope} contains an oversized string` });
    if (sensitiveValue(value)) errors.push({ id: "evidence-sensitive-value", detail: `${scope} contains a secret-like value pattern` });
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 4096) { errors.push({ id: "evidence-array-too-large", detail: `${scope} contains an oversized array` }); return; }
    value.forEach((item, index) => inspectSanitizedJson(item, depth + 1, errors, `${scope}[${index}]`)); return;
  }
  if (object(value)) {
    const entries = Object.entries(value);
    if (entries.length > 4096) { errors.push({ id: "evidence-object-too-large", detail: `${scope} contains too many keys` }); return; }
    for (const [key, item] of entries) {
      if (sensitiveKey(key)) errors.push({ id: "evidence-sensitive-key", detail: `${scope} contains sensitive key "${key}"` });
      inspectSanitizedJson(item, depth + 1, errors, `${scope}.${key}`);
    }
    return;
  }
  errors.push({ id: "evidence-json-invalid", detail: `${scope} contains a non-JSON value` });
}

/** @param {unknown} value */
export function validateAgentResearchBundleInput(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, input: null, errors: [{ id: "input-invalid", detail: "research bundle input must be an object" }] };
  rejectUnknown(value, ["version","bundleId","createdAt","tools","evidence","commands","reproduction"], "input", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "research bundle input version must be exactly 1" });
  const bundleId = id(value.bundleId), createdAt = text(value.createdAt, 64);
  if (!bundleId) errors.push({ id: "bundle-id-invalid", detail: "bundleId must be a portable identifier" });
  if (!createdAt || !isAbsoluteIsoTimestamp(createdAt)) errors.push({ id: "created-at-invalid", detail: "createdAt must be an absolute ISO timestamp" });

  /** @type {Array<{id:string,version:string}>} */ const tools = []; const toolIds = new Set();
  if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > 64) errors.push({ id: "tools-invalid", detail: "tools must be a non-empty bounded array" });
  else for (const [index, raw] of value.tools.entries()) {
    if (!object(raw)) { errors.push({ id: "tool-invalid", detail: `tools[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["id","version"], "tool", errors);
    const toolId = id(raw.id), version = text(raw.version, 128);
    if (!toolId || toolIds.has(toolId) || !version || sensitiveValue(version)) { errors.push({ id: "tool-fields-invalid", detail: `tools[${index}] has invalid or duplicate fields` }); continue; }
    toolIds.add(toolId); tools.push({ id: toolId, version });
  }

  /** @type {Array<{id:string,kind:string,file:string,sanitization:"CALLER_SANITIZED"}>} */ const evidence = []; const evidenceIds = new Set();
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > 64) errors.push({ id: "evidence-invalid", detail: "evidence must be a non-empty bounded array" });
  else for (const [index, raw] of value.evidence.entries()) {
    if (!object(raw)) { errors.push({ id: "evidence-entry-invalid", detail: `evidence[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["id","kind","file","sanitization"], "evidence-entry", errors);
    const evidenceId = id(raw.id), kind = id(raw.kind), file = text(raw.file, 4096);
    if (!evidenceId || evidenceIds.has(evidenceId) || !kind || !file || raw.sanitization !== "CALLER_SANITIZED") { errors.push({ id: "evidence-fields-invalid", detail: `evidence[${index}] must have unique ids, kind, file, and CALLER_SANITIZED mode` }); continue; }
    evidenceIds.add(evidenceId); evidence.push({ id: evidenceId, kind, file, sanitization: "CALLER_SANITIZED" });
  }
  /** @type {Array<{id:string,toolId:string,cwd:string,args:string[],purpose:string}>} */ const commands = []; const commandIds = new Set();
  if (!Array.isArray(value.commands) || value.commands.length === 0 || value.commands.length > 64) errors.push({ id: "commands-invalid", detail: "commands must be a non-empty bounded array" });
  else for (const [index, raw] of value.commands.entries()) {
    if (!object(raw)) { errors.push({ id: "command-invalid", detail: `commands[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["id","toolId","cwd","args","purpose"], "command", errors);
    const commandId = id(raw.id), toolId = id(raw.toolId), cwd = safeRelative(raw.cwd), purpose = text(raw.purpose, 32);
    const args = Array.isArray(raw.args) && raw.args.length <= 64 ? raw.args.map((arg) => text(arg, 512)) : null;
    if (!commandId || commandIds.has(commandId) || !toolId || !toolIds.has(toolId) || !cwd || !purpose || !PURPOSES.has(purpose) || !args || args.some((arg) => arg === null || sensitiveValue(arg))) {
      errors.push({ id: "command-fields-invalid", detail: `commands[${index}] has invalid identity, tool, cwd, args, or purpose` }); continue;
    }
    commandIds.add(commandId); commands.push({ id: commandId, toolId, cwd, args: /** @type {string[]} */ (args), purpose });
  }

  let reproduction = null;
  if (!object(value.reproduction)) errors.push({ id: "reproduction-invalid", detail: "reproduction must be an object" });
  else {
    rejectUnknown(value.reproduction, ["commandId","runEvidence"], "reproduction", errors);
    const commandId = value.reproduction.commandId === null ? null : id(value.reproduction.commandId);
    const rawRun = value.reproduction.runEvidence;
    let runEvidence = null;
    if (rawRun !== null) {
      const result = validateAgentReproductionRunEvidence(rawRun);
      if (!result.valid || !result.evidence) errors.push({ id: "reproduction-run-invalid", detail: "runEvidence must satisfy Reproduction Run Evidence v1" });
      else runEvidence = result.evidence;
    }
    if ((commandId === null) !== (runEvidence === null)) errors.push({ id: "reproduction-binding-invalid", detail: "commandId and runEvidence must both be null or both present" });
    if (commandId && (!commandIds.has(commandId) || commands.find((item) => item.id === commandId)?.purpose !== "REPRODUCE")) errors.push({ id: "reproduction-command-invalid", detail: "reproduction commandId must reference a REPRODUCE command" });
    reproduction = { commandId, runEvidence };
  }
  if (errors.length || !bundleId || !createdAt || !reproduction) return { valid: false, input: null, errors };
  return {
    valid: true,
    input: {
      version: 1, bundleId, createdAt,
      tools: tools.sort((a, b) => a.id.localeCompare(b.id)),
      evidence: evidence.sort((a, b) => a.id.localeCompare(b.id)),
      commands: commands.sort((a, b) => a.id.localeCompare(b.id)),
      reproduction,
    },
    errors: [],
  };
}

/** @param {string} absolute */
function assertNoSymlinkAncestors(absolute) {
  const resolved = path.resolve(absolute), parsed = path.parse(resolved);
  const parts = resolved.slice(parsed.root.length).split(path.sep).filter(Boolean); let current = parsed.root;
  for (const part of parts) {
    current = path.join(current, part); let stat;
    try { stat = fs.lstatSync(current); } catch { throw new Error(`required path does not exist: ${current}`); }
    if (stat.isSymbolicLink()) throw new Error("research bundle paths must not traverse symlinks");
  }
  return resolved;
}
/** @param {string} filename */
function readSanitizedEvidence(filename) {
  const resolved = assertNoSymlinkAncestors(filename), stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_EVIDENCE_FILE_BYTES) throw new Error("sanitized evidence must be a bounded regular non-symlink JSON file");
  const bytes = fs.readFileSync(resolved); let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("sanitized evidence must contain valid JSON"); }
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  inspectSanitizedJson(value, 0, errors, "evidence");
  if (errors.length) throw new Error(`sanitized evidence hygiene failed: ${errors[0]?.id ?? "invalid"}`);
  return { bytes, sha256: sha256(bytes), value };
}
/** @param {string} filename @param {number} maxBytes */
function readJsonFile(filename, maxBytes) {
  const resolved = assertNoSymlinkAncestors(filename), stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) throw new Error("research bundle input must be a bounded regular file");
  try { return JSON.parse(fs.readFileSync(resolved, "utf8")); } catch { throw new Error("research bundle input JSON cannot be parsed"); }
}
/** @param {any} task @param {any} input */
function bindTask(task, input) {
  const taskResult = validateAgentTask(task);
  if (!taskResult.valid || !taskResult.task) throw new Error("research bundle task must satisfy Agent Task v1");
  const normalizedTask = taskResult.task;
  if (Date.parse(input.createdAt) < Date.parse(normalizedTask.createdAt)) throw new Error("research bundle createdAt cannot precede Agent Task creation");
  const run = input.reproduction.runEvidence;
  if (run && (run.taskId !== normalizedTask.id || run.repository.id !== normalizedTask.repository.id || run.repository.commit !== normalizedTask.repository.baseCommit)) throw new Error("reproduction run evidence does not bind the exact Agent Task repository commit");
  if (run && Date.parse(run.collectedAt) > Date.parse(input.createdAt)) throw new Error("research bundle createdAt cannot precede reproduction run evidence");
  return normalizedTask;
}
/** @param {string} parent @param {string} child */
function within(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** @param {string} idValue @param {number} index */
function evidenceRelativePath(idValue, index) {
  return `evidence/${String(index + 1).padStart(3, "0")}-${sha256(idValue).slice(0, 16)}.json`;
}
/** @param {unknown} value */
export function validateAgentResearchBundleManifest(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, manifest: null, errors: [{ id: "manifest-invalid", detail: "research bundle manifest must be an object" }] };
  rejectUnknown(value, ["version","bundleId","task","repository","createdAt","tools","evidence","commands","reproduction","summary","semantics"], "manifest", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "manifest version must be exactly 1" });
  const bundleId = id(value.bundleId), createdAt = text(value.createdAt, 64), semantics = text(value.semantics, 2048);
  if (!bundleId || !createdAt || !isAbsoluteIsoTimestamp(createdAt) || !semantics) errors.push({ id: "manifest-fields-invalid", detail: "manifest identity, time, or semantics is invalid" });

  let task = null;
  if (object(value.task)) {
    rejectUnknown(value.task, ["id","role","risk"], "task", errors);
    const taskId = id(value.task.id), role = id(value.task.role), risk = text(value.task.risk, 32);
    if (taskId && role && risk) task = { id: taskId, role, risk }; else errors.push({ id: "task-invalid", detail: "manifest task binding is invalid" });
  } else errors.push({ id: "task-invalid", detail: "manifest task must be an object" });

  let repository = null;
  if (object(value.repository)) {
    rejectUnknown(value.repository, ["id","commit"], "repository", errors);
    const repositoryId = id(value.repository.id), commit = text(value.repository.commit, 128)?.toLowerCase() ?? null;
    if (repositoryId && commit && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) repository = { id: repositoryId, commit }; else errors.push({ id: "repository-invalid", detail: "manifest repository binding is invalid" });
  } else errors.push({ id: "repository-invalid", detail: "manifest repository must be an object" });
  /** @type {Array<any>} */ const tools = []; const toolIds = new Set();
  if (!Array.isArray(value.tools) || value.tools.length === 0 || value.tools.length > 64) errors.push({ id: "tools-invalid", detail: "manifest tools must be non-empty and bounded" });
  else for (const raw of value.tools) {
    if (!object(raw)) { errors.push({ id: "tool-invalid", detail: "manifest tool must be an object" }); continue; }
    rejectUnknown(raw, ["id","version"], "tool", errors); const toolId = id(raw.id), version = text(raw.version, 128);
    if (!toolId || toolIds.has(toolId) || !version) errors.push({ id: "tool-fields-invalid", detail: "manifest tools must be unique and versioned" }); else { toolIds.add(toolId); tools.push({ id: toolId, version }); }
  }

  /** @type {Array<any>} */ const evidence = []; const evidenceIds = new Set(), paths = new Set();
  if (!Array.isArray(value.evidence) || value.evidence.length === 0 || value.evidence.length > 64) errors.push({ id: "evidence-invalid", detail: "manifest evidence must be non-empty and bounded" });
  else for (const raw of value.evidence) {
    if (!object(raw)) { errors.push({ id: "evidence-entry-invalid", detail: "manifest evidence entry must be an object" }); continue; }
    rejectUnknown(raw, ["id","kind","relativePath","sha256","bytes","sanitization"], "evidence-entry", errors);
    const evidenceId = id(raw.id), kind = id(raw.kind), relativePath = safeRelative(raw.relativePath), hash = text(raw.sha256, 64)?.toLowerCase() ?? null;
    const bytes = Number.isSafeInteger(raw.bytes) && Number(raw.bytes) > 0 && Number(raw.bytes) <= MAX_EVIDENCE_FILE_BYTES ? Number(raw.bytes) : null;
    if (!evidenceId || evidenceIds.has(evidenceId) || !kind || !relativePath || !relativePath.startsWith("evidence/") || paths.has(relativePath) || !hash || !HASH.test(hash) || bytes === null || raw.sanitization !== "CALLER_SANITIZED+STRUCTURAL_HYGIENE") {
      errors.push({ id: "evidence-fields-invalid", detail: "manifest evidence binding is invalid or duplicate" }); continue;
    }
    evidenceIds.add(evidenceId); paths.add(relativePath); evidence.push({ id: evidenceId, kind, relativePath, sha256: hash, bytes, sanitization: "CALLER_SANITIZED+STRUCTURAL_HYGIENE" });
  }
  /** @type {Array<any>} */ const commands = []; const commandIds = new Set();
  if (!Array.isArray(value.commands) || value.commands.length === 0 || value.commands.length > 64) errors.push({ id: "commands-invalid", detail: "manifest commands must be non-empty and bounded" });
  else for (const raw of value.commands) {
    if (!object(raw)) { errors.push({ id: "command-invalid", detail: "manifest command must be an object" }); continue; }
    rejectUnknown(raw, ["id","toolId","cwd","args","purpose"], "command", errors);
    const commandId = id(raw.id), toolId = id(raw.toolId), cwd = safeRelative(raw.cwd), purpose = text(raw.purpose, 32);
    const args = Array.isArray(raw.args) && raw.args.length <= 64 ? raw.args.map((arg) => text(arg, 512)) : null;
    if (!commandId || commandIds.has(commandId) || !toolId || !toolIds.has(toolId) || !cwd || !purpose || !PURPOSES.has(purpose) || !args || args.some((arg) => arg === null || sensitiveValue(arg))) errors.push({ id: "command-fields-invalid", detail: "manifest command binding is invalid" });
    else { commandIds.add(commandId); commands.push({ id: commandId, toolId, cwd, args: /** @type {string[]} */ (args), purpose }); }
  }

  let reproduction = null;
  if (!object(value.reproduction)) errors.push({ id: "reproduction-invalid", detail: "manifest reproduction must be an object" });
  else {
    rejectUnknown(value.reproduction, ["commandId","runEvidence","semantics"], "reproduction", errors);
    const commandId = value.reproduction.commandId === null ? null : id(value.reproduction.commandId), repSemantics = text(value.reproduction.semantics, 512);
    let runEvidence = null;
    if (value.reproduction.runEvidence !== null) {
      const result = validateAgentReproductionRunEvidence(value.reproduction.runEvidence);
      if (!result.valid || !result.evidence) errors.push({ id: "reproduction-run-invalid", detail: "manifest reproduction run evidence is invalid" }); else runEvidence = result.evidence;
    }
    if ((commandId === null) !== (runEvidence === null) || (commandId && !commandIds.has(commandId)) || !repSemantics) errors.push({ id: "reproduction-binding-invalid", detail: "manifest reproduction binding is inconsistent" });
    else reproduction = { commandId, runEvidence, semantics: repSemantics };
  }
  const expectedSummary = { tools: tools.length, evidence: evidence.length, commands: commands.length, reproductionReported: reproduction?.runEvidence !== null };
  if (!object(value.summary) || Object.keys(value.summary).some((key) => !["tools","evidence","commands","reproductionReported"].includes(key))
      || value.summary.tools !== expectedSummary.tools || value.summary.evidence !== expectedSummary.evidence || value.summary.commands !== expectedSummary.commands || value.summary.reproductionReported !== expectedSummary.reproductionReported) {
    errors.push({ id: "summary-invalid", detail: "manifest summary must exactly match bundle contents" });
  }
  if (errors.length || !bundleId || !createdAt || !task || !repository || !reproduction || !semantics) return { valid: false, manifest: null, errors };
  return { valid: true, manifest: { version: 1, bundleId, task, repository, createdAt, tools: tools.sort((a,b)=>a.id.localeCompare(b.id)), evidence: evidence.sort((a,b)=>a.id.localeCompare(b.id)), commands: commands.sort((a,b)=>a.id.localeCompare(b.id)), reproduction, summary: expectedSummary, semantics }, errors: [] };
}

/** @param {any} taskValue @param {any} inputValue @param {string} outputDirectory */
export function buildAgentResearchBundle(taskValue, inputValue, outputDirectory) {
  const inputResult = validateAgentResearchBundleInput(inputValue);
  if (!inputResult.valid || !inputResult.input) throw new Error("Research Bundle Input v1 is invalid");
  const input = inputResult.input, task = bindTask(taskValue, input);
  const output = path.resolve(outputDirectory), parent = assertNoSymlinkAncestors(path.dirname(output));
  if (!fs.lstatSync(parent).isDirectory() || fs.existsSync(output)) throw new Error("research bundle output directory must not already exist");
  if (output.split(path.sep).includes(".git")) throw new Error("research bundle output path must not be inside .git metadata");

  const prepared = []; let totalBytes = 0;
  for (const item of input.evidence) {
    const file = readSanitizedEvidence(item.file); totalBytes += file.bytes.length;
    if (totalBytes > MAX_TOTAL_EVIDENCE_BYTES) throw new Error("research bundle evidence exceeds total byte limit");
    prepared.push({ item, file });
  }

  fs.mkdirSync(output, { mode: 0o700 }); fs.mkdirSync(path.join(output, "evidence"), { mode: 0o700 });
  try {
    const manifestEvidence = [];
    for (const [index, preparedItem] of prepared.entries()) {
      const relativePath = evidenceRelativePath(preparedItem.item.id, index), destination = path.join(output, ...relativePath.split("/"));
      fs.writeFileSync(destination, preparedItem.file.bytes, { flag: "wx", mode: 0o600 });
      manifestEvidence.push({ id: preparedItem.item.id, kind: preparedItem.item.kind, relativePath, sha256: preparedItem.file.sha256, bytes: preparedItem.file.bytes.length, sanitization: "CALLER_SANITIZED+STRUCTURAL_HYGIENE" });
    }
    const manifest = {
      version: 1, bundleId: input.bundleId,
      task: { id: task.id, role: task.role, risk: task.risk },
      repository: { id: task.repository.id, commit: task.repository.baseCommit },
      createdAt: input.createdAt,
      tools: input.tools,
      evidence: manifestEvidence.sort((a,b)=>a.id.localeCompare(b.id)),
      commands: input.commands,
      reproduction: {
        commandId: input.reproduction.commandId,
        runEvidence: input.reproduction.runEvidence,
        semantics: "reproduction metadata is caller-supplied Reproduction Run Evidence v1; trust.authenticated remains metadata unless separately cryptographically verified",
      },
      summary: { tools: input.tools.length, evidence: manifestEvidence.length, commands: input.commands.length, reproductionReported: input.reproduction.runEvidence !== null },
      semantics: "research bundle records exact repository commit, explicit tool versions, caller-sanitized structurally checked JSON evidence, declarative non-executed commands, and optional canonical reproduction metadata; sanitization hygiene is bounded evidence, not proof that every sensitive value was removed",
    };
    const validated = validateAgentResearchBundleManifest(manifest);
    if (!validated.valid || !validated.manifest) throw new Error("generated research bundle manifest is invalid");
    fs.writeFileSync(path.join(output, "research-bundle.json"), `${JSON.stringify(validated.manifest, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    const verification = verifyAgentResearchBundle(output);
    if (verification.overallStatus !== "PASS") throw new Error("generated research bundle failed self-verification");
    return verification;
  } catch (error) {
    fs.rmSync(output, { recursive: true, force: true }); throw error;
  }
}

/** @param {string} directory */
export function verifyAgentResearchBundle(directory) {
  const root = assertNoSymlinkAncestors(directory), stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("research bundle root must be a regular directory");
  const rawManifest = readJsonFile(path.join(root, "research-bundle.json"), MAX_INPUT_BYTES);
  const result = validateAgentResearchBundleManifest(rawManifest);
  if (!result.valid || !result.manifest) throw new Error("research bundle manifest is invalid");
  const manifest = result.manifest;
  /** @type {Array<{id:string,status:"PASS"|"FAIL",detail:string}>} */ const checks = [];
  /** @param {string} idValue @param {boolean} passed @param {string} detail */
  const add = (idValue, passed, detail) => checks.push({ id: idValue, status: passed ? "PASS" : "FAIL", detail });
  const expectedFiles = new Set(["research-bundle.json", ...manifest.evidence.map((item) => item.relativePath)]);
  const actualFiles = [];
  const allowedDirectories = new Set(["evidence"]);
  const stack = [root];
  while (stack.length) {
    const current = stack.pop(); if (!current) continue;
    for (const name of fs.readdirSync(current)) {
      const absolute = path.join(current, name), relative = path.relative(root, absolute).split(path.sep).join("/"), child = fs.lstatSync(absolute);
      if (child.isSymbolicLink()) { add(`symlink:${relative}`, false, "research bundle must not contain symlinks"); continue; }
      if (child.isDirectory()) { add(`directory:${relative}`, allowedDirectories.has(relative), "research bundle directory must be explicitly allowed"); stack.push(absolute); continue; }
      if (!child.isFile()) { add(`special:${relative}`, false, "research bundle must contain only regular files and directories"); continue; }
      actualFiles.push(relative);
    }
  }
  for (const file of actualFiles) add(`declared:${file}`, expectedFiles.has(file), "every research bundle file must be declared by the manifest");
  for (const file of expectedFiles) add(`present:${file}`, actualFiles.includes(file), "every manifest file must exist exactly once");

  for (const entry of manifest.evidence) {
    const absolute = path.resolve(root, ...entry.relativePath.split("/"));
    if (!within(root, absolute)) { add(`path:${entry.id}`, false, "evidence path must remain inside bundle root"); continue; }
    try {
      const file = readSanitizedEvidence(absolute);
      add(`hash:${entry.id}`, file.sha256 === entry.sha256, "evidence SHA256 must match manifest");
      add(`bytes:${entry.id}`, file.bytes.length === entry.bytes, "evidence byte count must match manifest");
    } catch { add(`hygiene:${entry.id}`, false, "evidence file must remain structurally sanitized JSON"); }
  }
  const fail = checks.filter((check) => check.status === "FAIL").length;
  return { version: 1, bundleId: manifest.bundleId, repository: manifest.repository, manifest, checks: checks.sort((a,b)=>a.id.localeCompare(b.id)), summary: { pass: checks.length - fail, fail }, technicalStatus: "PASS", overallStatus: fail === 0 ? "PASS" : "FAIL", executionPerformed: false, semantics: "verification checks manifest/file integrity and bounded structural sanitization only; no stored command is executed" };
}
/** @param {any} report */
/** @param {any} report */
export function formatAgentResearchBundle(report) {
  const lines = ["Agent Research Bundle v1", "", `Bundle: ${report.bundleId}`, `Repository: ${report.repository.id} @ ${report.repository.commit}`, `Evidence: ${report.manifest.evidence.length}`, `Commands: ${report.manifest.commands.length}`, `Reproduction reported: ${report.manifest.summary.reproductionReported}`, ""];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.fail} fail`, `Overall: ${report.overallStatus}`, `Semantics: ${report.semantics}`);
  return lines.join("\n");
}
/** @param {string[]} argv */
function parse(argv) {
  const mode = argv[0]; if (!["build","verify"].includes(mode ?? "")) return null;
  const values = new Map(), flags = new Set(), allowed = mode === "build" ? new Set(["--task","--input","--output"]) : new Set(["--bundle"]);
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]; if (arg === "--json") { if (flags.has(arg)) return null; flags.add(arg); continue; }
    if (!allowed.has(arg ?? "") || values.has(arg)) return null;
    const next = argv[index + 1]; if (typeof next !== "string" || next.startsWith("--")) return null;
    values.set(arg, next); index += 1;
  }
  for (const arg of allowed) if (!values.has(arg)) return null;
  return { mode, values, json: flags.has("--json") };
}
export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/agent-research-bundle.js build --task <task.json> --input <research-input.json> --output <directory> [--json] | verify --bundle <directory> [--json]"); return 1; }
  try {
    const report = options.mode === "build"
      ? buildAgentResearchBundle(readJsonFile(options.values.get("--task"), MAX_INPUT_BYTES), readJsonFile(options.values.get("--input"), MAX_INPUT_BYTES), options.values.get("--output"))
      : verifyAgentResearchBundle(options.values.get("--bundle"));
    console.log(options.json ? JSON.stringify(report) : formatAgentResearchBundle(report));
    return report.overallStatus === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "agent research bundle operation failed"); return 1;
  }
}
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
