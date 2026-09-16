#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const STATUSES = new Set(["WARN", "FAIL"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value */
function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
/** @param {unknown} value */
function safePattern(value) {
  const v = text(value);
  return v && v.length <= 256 && !v.startsWith("/") && !v.includes("\\") &&
    !v.includes("\0") && !v.split("/").includes("..") ? v : null;
}
/** @param {unknown} value */
function patternList(value) {
  if (!Array.isArray(value)) return null;
  const list = value.map(safePattern);
  return list.every(Boolean) && new Set(list).size === list.length ? /** @type {string[]} */ (list).sort() : null;
}

/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateRepositoryHygienePolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "repository hygiene policy must be an object" }] };
  rejectUnknown(value, ["version", "staleConfigPatterns", "exclusiveConfigGroups", "generatedArtifactPatterns", "generatedArtifactAllowlist", "workflowRoots", "maxTrackedFileBytes", "oversizedAllowlist", "severity"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  const staleConfigPatterns = patternList(value.staleConfigPatterns);
  const generatedArtifactPatterns = patternList(value.generatedArtifactPatterns);
  const generatedArtifactAllowlist = patternList(value.generatedArtifactAllowlist);
  const workflowRoots = patternList(value.workflowRoots);
  const oversizedAllowlist = patternList(value.oversizedAllowlist);
  if (staleConfigPatterns === null) errors.push({ id: "stale-patterns-invalid", detail: "staleConfigPatterns must be a unique pattern array" });
  if (generatedArtifactPatterns === null) errors.push({ id: "generated-patterns-invalid", detail: "generatedArtifactPatterns must be a unique pattern array" });
  if (generatedArtifactAllowlist === null) errors.push({ id: "generated-allowlist-invalid", detail: "generatedArtifactAllowlist must be a unique pattern array" });
  if (!workflowRoots?.length || workflowRoots.some((item) => item.includes("*") || item.includes("?"))) errors.push({ id: "workflow-roots-invalid", detail: "workflowRoots must contain explicit directories" });
  if (oversizedAllowlist === null) errors.push({ id: "oversized-allowlist-invalid", detail: "oversizedAllowlist must be a unique pattern array" });
  if (!Number.isSafeInteger(value.maxTrackedFileBytes) || Number(value.maxTrackedFileBytes) < 1) errors.push({ id: "size-limit-invalid", detail: "maxTrackedFileBytes must be a positive safe integer" });

  /** @type {Array<{id:string,paths:string[]}>} */ const exclusiveConfigGroups = [];
  const groupIds = new Set();
  if (!Array.isArray(value.exclusiveConfigGroups)) errors.push({ id: "config-groups-invalid", detail: "exclusiveConfigGroups must be an array" });
  else for (const [index, raw] of value.exclusiveConfigGroups.entries()) {
    if (!object(raw)) { errors.push({ id: "config-group-invalid", detail: `exclusiveConfigGroups[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["id", "paths"], "config-group", errors);
    const id = text(raw.id), paths = patternList(raw.paths);
    const validPaths = paths && paths.length >= 2 && paths.every((item) => !item.includes("*") && !item.includes("?"));
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || !validPaths) {
      errors.push({ id: "config-group-fields-invalid", detail: `exclusiveConfigGroups[${index}] requires id and at least two explicit paths` });
      continue;
    }
    if (groupIds.has(id)) { errors.push({ id: "config-group-duplicate", detail: `exclusive config group ${id} is duplicated` }); continue; }
    groupIds.add(id); exclusiveConfigGroups.push({ id, paths });
  }

  let severity = null;
  const severityRaw = value.severity;
  if (!object(severityRaw)) errors.push({ id: "severity-invalid", detail: "severity must be an object" });
  else {
    const keys = ["staleConfig", "duplicateConfig", "generatedArtifact", "duplicateWorkflow", "oversizedFile", "workflowInspection"];
    rejectUnknown(severityRaw, keys, "severity", errors);
    if (keys.some((key) => !STATUSES.has(String(severityRaw[key] ?? "")))) errors.push({ id: "severity-fields-invalid", detail: "all hygiene severities must be WARN or FAIL" });
    else severity = Object.fromEntries(keys.map((key) => [key, severityRaw[key]]));
  }
  if (errors.length || !staleConfigPatterns || !generatedArtifactPatterns || !generatedArtifactAllowlist || !workflowRoots || !oversizedAllowlist || !severity) return { valid: false, policy: null, errors };
  return {
    valid: true,
    policy: {
      version: 1,
      staleConfigPatterns,
      exclusiveConfigGroups: exclusiveConfigGroups.sort((a, b) => a.id.localeCompare(b.id)),
      generatedArtifactPatterns,
      generatedArtifactAllowlist,
      workflowRoots,
      maxTrackedFileBytes: Number(value.maxTrackedFileBytes),
      oversizedAllowlist,
      severity,
    },
    errors: [],
  };
}

/** @param {string} pattern */
function globToRegExp(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === undefined) break;
    if (c === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") { out += "(?:.*/)?"; i += 2; }
    else if (c === "*") { if (pattern[i + 1] === "*") { out += ".*"; i += 1; } else out += "[^/]*"; }
    else if (c === "?") out += "[^/]";
    else out += "^$.*+?()[]{}|".includes(c) ? `\\${c}` : c;
  }
  return new RegExp(`${out}$`);
}

/** @param {string} file @param {string[]} patterns */
function matches(file, patterns) {
  return patterns.some((pattern) => globToRegExp(pattern).test(file) ||
    (pattern.includes("/**/") && globToRegExp(pattern.replaceAll("/**/", "/")).test(file)));
}
/** @param {string} root */
function trackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("read-only Git tracked-file inspection failed");
  return result.stdout.split("\0").filter(Boolean).sort();
}
/** @param {string} root @param {string} file */
function trackedStat(root, file) {
  const absolute = path.resolve(root, file), prefix = `${path.resolve(root)}${path.sep}`;
  if (!absolute.startsWith(prefix)) throw new Error("tracked path escaped repository root");
  try { return { absolute, stat: fs.lstatSync(absolute) }; }
  catch { return { absolute, stat: null }; }
}
/** @param {string} root @param {string} file */
function workflowEvidence(root, file) {
  const inspected = trackedStat(root, file);
  if (!inspected.stat || !inspected.stat.isFile() || inspected.stat.isSymbolicLink() || inspected.stat.size > 2 * 1024 * 1024) return { inspectable: false, name: null, hash: null };
  const content = fs.readFileSync(inspected.absolute, "utf8");
  if (content.includes("\0")) return { inspectable: false, name: null, hash: null };
  const line = content.split(/\r?\n/).find((value) => /^name\s*:/.test(value));
  const rawName = line ? line.replace(/^name\s*:\s*/, "").replace(/\s+#.*$/, "").trim() : "";
  const name = rawName.replace(/^(["'])(.*)\1$/, "$2").trim() || null;
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  return { inspectable: true, name, hash };
}

/** @param {string} root @param {any} policy */
export function inspectRepositoryHygiene(root, policy) {
  const files = trackedFiles(root), tracked = new Set(files);
  /** @type {Array<any>} */ const checks = [];
  /** @param {string} id @param {string} status @param {string} category @param {string|null} file @param {string} detail */
  const finding = (id, status, category, file, detail) => checks.push({ id, status, category, file, detail });

  for (const file of files) {
    if (matches(file, policy.staleConfigPatterns)) finding("stale-config", policy.severity.staleConfig, "stale-config", file, "tracked path matches explicit stale configuration policy");
  }
  for (const group of policy.exclusiveConfigGroups) {
    const present = group.paths.filter((/** @type {string} */ file) => tracked.has(file));
    if (present.length > 1) finding("duplicate-config", policy.severity.duplicateConfig, "duplicate-config", present.join(", "), `exclusive config group ${group.id} has ${present.length} tracked variants`);
  }
  for (const file of files) {
    if (matches(file, policy.generatedArtifactPatterns) && !matches(file, policy.generatedArtifactAllowlist)) {
      finding("generated-artifact-tracked", policy.severity.generatedArtifact, "generated-artifact", file, "generated artifact pattern is tracked without explicit allowlist match");
    }
  }
  for (const file of files) {
    const inspected = trackedStat(root, file);
    if (!inspected.stat || inspected.stat.isSymbolicLink() || !inspected.stat.isFile()) continue;
    if (inspected.stat.size > policy.maxTrackedFileBytes && !matches(file, policy.oversizedAllowlist)) {
      finding("oversized-tracked-file", policy.severity.oversizedFile, "oversized-file", file, `tracked file size ${inspected.stat.size} exceeds limit ${policy.maxTrackedFileBytes}`);
    }
  }

  const workflows = files.filter((file) => policy.workflowRoots.some((/** @type {string} */ rootDir) =>
    file.startsWith(`${rootDir.replace(/\/$/, "")}/`)) && /\.ya?ml$/i.test(file));
  const names = new Map(), hashes = new Map();
  for (const file of workflows) {
    const evidence = workflowEvidence(root, file);
    if (!evidence.inspectable) {
      finding("workflow-uninspectable", policy.severity.workflowInspection, "workflow", file, "tracked workflow is not a bounded regular text file");
      continue;
    }
    if (evidence.name) {
      const list = names.get(evidence.name) ?? [];
      list.push(file); names.set(evidence.name, list);
    }
    if (evidence.hash) {
      const list = hashes.get(evidence.hash) ?? [];
      list.push(file); hashes.set(evidence.hash, list);
    }
  }
  const duplicateSets = new Set();
  for (const [name, list] of names) {
    if (list.length < 2) continue;
    const filesKey = [...list].sort().join("\0"); duplicateSets.add(filesKey);
    finding("duplicate-workflow-name", policy.severity.duplicateWorkflow, "duplicate-workflow", [...list].sort().join(", "), `workflow name "${name}" is duplicated`);
  }
  for (const [, list] of hashes) {
    if (list.length < 2) continue;
    const filesKey = [...list].sort().join("\0");
    if (!duplicateSets.has(filesKey)) finding("duplicate-workflow-content", policy.severity.duplicateWorkflow, "duplicate-workflow", [...list].sort().join(", "), "workflow files have identical content");
  }

  if (checks.length === 0) checks.push({ id: "repository-hygiene-clean", status: "PASS", category: "repository", file: null, detail: "no configured repository hygiene findings detected" });
  const summary = {
    pass: checks.filter((item) => item.status === "PASS").length,
    warn: checks.filter((item) => item.status === "WARN").length,
    fail: checks.filter((item) => item.status === "FAIL").length,
  };
  return {
    filesTracked: files.length,
    checks,
    summary,
    technicalStatus: "PASS",
    overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectRepositoryHygiene>} report */
export function formatRepositoryHygiene(report) {
  const lines = ["Repository hygiene audit", ""];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.file ?? "(repository)"}  ${check.detail}`);
  }
  lines.push("", `Tracked files: ${report.filesTracked}`, `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string} file */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

/** @param {string[]} argv */
function parse(argv) {
  let root = null, policyFile = null, json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") { json = true; continue; }
    if (!["--root", "--policy"].includes(arg ?? "")) return null;
    const value = argv[i + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    i += 1;
    if (arg === "--root") { if (root) return null; root = value; }
    else { if (policyFile) return null; policyFile = value; }
  }
  return root && policyFile ? { root, policyFile, json } : null;
}
export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/audit-repository-hygiene.js --root <repository> --policy <policy.json> [--json]"); return 1; }
  const raw = readJson(options.policyFile);
  if (!raw) { console.error("Repository hygiene policy cannot be read or parsed"); return 1; }
  const validated = validateRepositoryHygienePolicy(raw);
  if (!validated.valid || !validated.policy) { console.error("Repository hygiene policy is invalid"); return 1; }
  try {
    const report = inspectRepositoryHygiene(path.resolve(options.root), validated.policy);
    console.log(options.json ? JSON.stringify(report) : formatRepositoryHygiene(report));
    return report.overallStatus === "FAIL" ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Repository hygiene audit failed");
    return 1;
  }
}
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
