#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const MAX_CODEOWNERS_BYTES = 3 * 1024 * 1024;
const STATUSES = new Set(["WARN", "FAIL"]);
const AUTO_LOCATIONS = [".github/CODEOWNERS", "CODEOWNERS", "docs/CODEOWNERS"];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value */
function text(value) { return typeof value === "string" && value.trim().length > 0 ? value.trim() : null; }
/** @param {unknown} value */
function safePath(value) {
  const v = text(value);
  if (!v || path.isAbsolute(v) || v.includes("\\") || v.includes("\0") || v.length > 512) return null;
  const normalized = path.posix.normalize(v);
  return normalized === v && normalized !== ".." && !normalized.startsWith("../") ? v : null;
}
/** @param {unknown} value */
function safeGlob(value) {
  const v = safePath(value);
  return v && !v.startsWith("!") ? v : null;
}
/** @param {string} value */
function validOwner(value) {
  return /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(value) ||
    /^@[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/.test(value) ||
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
/** @param {unknown} value */
function ownerList(value) {
  if (!Array.isArray(value)) return null;
  const list = value.map(text);
  return list.every((item) => item && validOwner(item)) && new Set(list).size === list.length ? /** @type {string[]} */ (list).sort() : null;
}
/** @param {unknown} value @param {number} minimum */
function globList(value, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) return null;
  const list = value.map(safeGlob);
  return list.every(Boolean) && new Set(list).size === list.length ? /** @type {string[]} */ (list).sort() : null;
}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
}

/** @param {unknown} value */
export function validateOwnershipPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "ownership policy must be an object" }] };
  rejectUnknown(value, ["version", "codeownersFile", "criticalRules", "severity"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let codeownersFile = null;
  if (value.codeownersFile === "auto") codeownersFile = "auto";
  else {
    const candidate = safePath(value.codeownersFile);
    if (!candidate || !AUTO_LOCATIONS.includes(candidate)) errors.push({ id: "codeowners-file-invalid", detail: "codeownersFile must be auto or a GitHub-supported CODEOWNERS location" });
    else codeownersFile = candidate;
  }

  /** @type {Array<{id:string,paths:string[],requireMatches:boolean,minimumOwners:number,requiredOwners:string[]}>} */ const criticalRules = [];
  const ids = new Set();
  if (!Array.isArray(value.criticalRules) || value.criticalRules.length === 0) errors.push({ id: "critical-rules-invalid", detail: "criticalRules must be a non-empty array" });
  else for (const [index, raw] of value.criticalRules.entries()) {
    if (!object(raw)) { errors.push({ id: "critical-rule-invalid", detail: `criticalRules[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["id", "paths", "requireMatches", "minimumOwners", "requiredOwners"], "critical-rule", errors);
    const id = text(raw.id), paths = globList(raw.paths, 1), requiredOwners = ownerList(raw.requiredOwners);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || !paths || typeof raw.requireMatches !== "boolean" || !Number.isSafeInteger(raw.minimumOwners) || Number(raw.minimumOwners) < 1 || !requiredOwners) {
      errors.push({ id: "critical-rule-fields-invalid", detail: `criticalRules[${index}] has invalid id paths matching owner count or required owners` });
      continue;
    }
    if (ids.has(id)) { errors.push({ id: "critical-rule-duplicate", detail: `critical rule ${id} is duplicated` }); continue; }
    ids.add(id);
    criticalRules.push({ id, paths, requireMatches: raw.requireMatches, minimumOwners: Number(raw.minimumOwners), requiredOwners });
  }

  let severity = null;
  const severityRaw = value.severity;
  if (!object(severityRaw)) errors.push({ id: "severity-invalid", detail: "severity must be an object" });
  else {
    const keys = ["fileInspection", "syntax", "criticalPath", "requiredOwner"];
    rejectUnknown(severityRaw, keys, "severity", errors);
    if (keys.some((key) => !STATUSES.has(String(severityRaw[key] ?? "")))) errors.push({ id: "severity-fields-invalid", detail: "all ownership severities must be WARN or FAIL" });
    else severity = Object.fromEntries(keys.map((key) => [key, severityRaw[key]]));
  }
  if (errors.length || !codeownersFile || !severity) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, codeownersFile, criticalRules: criticalRules.sort((a, b) => a.id.localeCompare(b.id)), severity }, errors: [] };
}

/** @param {string} pattern */
function wildcardRegex(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === undefined) break;
    if (c === "*") {
      if (pattern[i + 1] === "*" && pattern[i + 2] === "/") { out += "(?:.*/)?"; i += 2; }
      else if (pattern[i + 1] === "*") { out += ".*"; i += 1; }
      else out += "[^/]*";
    } else if (c === "?") out += "[^/]";
    else out += "^$.*+?()[]{}|\\".includes(c) ? `\\${c}` : c;
  }
  return out;
}

/** @param {string} pattern @param {string} file */
export function matchesCodeownersPattern(pattern, file) {
  let raw = pattern;
  const rooted = raw.startsWith("/");
  if (rooted) raw = raw.slice(1);
  if (raw.endsWith("/")) raw += "**";
  if (!raw.includes("/")) return new RegExp(`(?:^|/)${wildcardRegex(raw)}$`).test(file);
  const body = wildcardRegex(raw);
  return rooted ? new RegExp(`^${body}$`).test(file) : new RegExp(`^${body}$`).test(file);
}

/** @param {string} pattern @param {string} file */
function matchesPolicyGlob(pattern, file) {
  let raw = pattern;
  if (raw.startsWith("/")) raw = raw.slice(1);
  if (raw.endsWith("/")) raw += "**";
  const body = wildcardRegex(raw);
  return new RegExp(`^${body}$`).test(file) || (!raw.includes("/") && new RegExp(`(?:^|/)${body}$`).test(file));
}

/** @param {string} content */
export function parseCodeowners(content) {
  /** @type {Array<{line:number,pattern:string,owners:string[]}>} */ const rules = [];
  /** @type {Array<{line:number,id:string,detail:string}>} */ const errors = [];
  for (const [index, rawLine] of content.split(/\r?\n/).entries()) {
    const line = index + 1, trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const tokens = trimmed.split(/\s+/);
    const pattern = tokens[0] ?? "";
    const owners = [];
    for (const token of tokens.slice(1)) {
      if (token.startsWith("#")) break;
      owners.push(token);
    }
    if (!pattern || pattern.startsWith("\\#") || pattern.startsWith("!") || pattern.includes("[") || pattern.includes("]")) {
      errors.push({ line, id: "codeowners-pattern-invalid", detail: "line uses unsupported CODEOWNERS pattern syntax" });
      continue;
    }
    if (owners.length === 0 || owners.some((owner) => !validOwner(owner))) {
      errors.push({ line, id: "codeowners-owner-invalid", detail: "line must name one or more syntactically valid owners" });
      continue;
    }
    rules.push({ line, pattern, owners: [...new Set(owners)] });
  }
  return { rules, errors };
}

/** @param {string} root */
function trackedFiles(root) {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("read-only Git tracked-file inspection failed");
  return result.stdout.split("\0").filter(Boolean).sort();
}
/** @param {string} root @param {string} configured */
function locateCodeowners(root, configured) {
  const candidates = configured === "auto" ? AUTO_LOCATIONS : [configured];
  for (const relative of candidates) {
    const absolute = path.resolve(root, relative), rel = path.relative(path.resolve(root), absolute);
    if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { path: relative, ok: false, reason: "escaped-root", content: null };
    let stat;
    try { stat = fs.lstatSync(absolute); } catch { continue; }
    if (stat.isSymbolicLink() || !stat.isFile()) return { path: relative, ok: false, reason: "not-regular-file", content: null };
    if (stat.size >= MAX_CODEOWNERS_BYTES) return { path: relative, ok: false, reason: "too-large", content: null };
    const buffer = fs.readFileSync(absolute);
    if (buffer.includes(0)) return { path: relative, ok: false, reason: "binary", content: null };
    return { path: relative, ok: true, reason: null, content: buffer.toString("utf8") };
  }
  return { path: candidates[0] ?? "CODEOWNERS", ok: false, reason: "missing", content: null };
}
/** @param {Array<{pattern:string,owners:string[]}>} rules @param {string} file */
function ownersForFile(rules, file) {
  let owners = null;
  for (const rule of rules) if (matchesCodeownersPattern(rule.pattern, file)) owners = rule.owners;
  return owners;
}

/** @param {string} root @param {any} policy */
export function inspectCodeownersOwnership(root, policy) {
  /** @type {Array<any>} */ const checks = [];
  /** @param {string} id @param {string} status @param {string} scope @param {string} detail */
  const finding = (id, status, scope, detail) => checks.push({ id, status, scope, detail });
  const located = locateCodeowners(root, policy.codeownersFile);
  if (!located.ok || located.content === null) {
    finding("codeowners-uninspectable", policy.severity.fileInspection, located.path, `CODEOWNERS is ${located.reason}`);
    return finish(checks, located.path, 0, 0);
  }
  const parsed = parseCodeowners(located.content);
  for (const error of parsed.errors) finding(error.id, policy.severity.syntax, `${located.path}:${error.line}`, error.detail);
  const files = trackedFiles(root);
  for (const rule of policy.criticalRules) {
    const matched = files.filter((file) => rule.paths.some((/** @type {string} */ pattern) => matchesPolicyGlob(pattern, file)));
    if (matched.length === 0 && rule.requireMatches) {
      finding("critical-rule-no-files", policy.severity.criticalPath, rule.id, "critical ownership rule matches no tracked files");
      continue;
    }
    for (const file of matched) {
      const owners = ownersForFile(parsed.rules, file);
      if (!owners || owners.length < rule.minimumOwners) {
        finding("critical-path-insufficient-owners", policy.severity.criticalPath, file, `critical rule ${rule.id} requires at least ${rule.minimumOwners} CODEOWNERS entries`);
        continue;
      }
      const missing = rule.requiredOwners.filter((/** @type {string} */ owner) => !owners.includes(owner));
      if (missing.length > 0) finding("critical-path-required-owner-missing", policy.severity.requiredOwner, file, `critical rule ${rule.id} is missing required owner ${missing.join(", ")}`);
    }
  }
  if (checks.length === 0) checks.push({ id: "ownership-policy-satisfied", status: "PASS", scope: located.path, detail: "configured critical paths have required CODEOWNERS assignments" });
  return finish(checks, located.path, parsed.rules.length, files.length);
}
/** @param {Array<any>} checks @param {string} file @param {number} ruleCount @param {number} trackedCount */
function finish(checks, file, ruleCount, trackedCount) {
  const summary = { pass: checks.filter((item) => item.status === "PASS").length, warn: checks.filter((item) => item.status === "WARN").length, fail: checks.filter((item) => item.status === "FAIL").length };
  return { codeownersFile: file, codeownersRules: ruleCount, trackedFiles: trackedCount, ownerAccessStatus: "UNVERIFIED", checks, summary, technicalStatus: "PASS", overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS" };
}

/** @param {ReturnType<typeof inspectCodeownersOwnership>} report */
export function formatCodeownersOwnership(report) {
  const lines = ["CODEOWNERS ownership audit", "", `File: ${report.codeownersFile}`, `Rules: ${report.codeownersRules}`, `Tracked files: ${report.trackedFiles}`, `Owner access: ${report.ownerAccessStatus}`, ""];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.scope}  ${check.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
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
  if (!options) { console.error("Usage: node scripts/audit-codeowners-ownership.js --root <repository> --policy <policy.json> [--json]"); return 1; }
  const raw = readJson(options.policyFile);
  if (!raw) { console.error("Ownership policy cannot be read or parsed"); return 1; }
  const validated = validateOwnershipPolicy(raw);
  if (!validated.valid || !validated.policy) { console.error("Ownership policy is invalid"); return 1; }
  try {
    const report = inspectCodeownersOwnership(path.resolve(options.root), validated.policy);
    console.log(options.json ? JSON.stringify(report) : formatCodeownersOwnership(report));
    return report.overallStatus === "FAIL" ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "CODEOWNERS ownership audit failed");
    return 1;
  }
}
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
