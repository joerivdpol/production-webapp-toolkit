#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import { validateRepositoryManifest } from "./repository-manifest.js";
import { isFullObjectId } from "./runtime-evidence.js";

const RULE_TYPES = new Set(["forbid-change", "forbid-import", "require-import"]);
const SEVERITIES = new Set(["WARN", "FAIL"]);
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts"]);
const MAX_SOURCE_BYTES = 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}

/** @param {unknown} value */
function portableId(value) {
  const normalized = text(value, 128);
  return normalized && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(normalized) ? normalized : null;
}

/** @param {unknown} value */
function safeGlob(value) {
  const normalized = text(value, 256);
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\") || normalized.includes("\0")) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

/** @param {unknown} value */
function moduleGlob(value) {
  const normalized = text(value, 256);
  return normalized && !/[\u0000\r\n\s]/.test(normalized) ? normalized : null;
}

/** @param {unknown} value @param {(value:unknown)=>string|null} validator @param {boolean} allowEmpty */
function uniqueList(value, validator, allowEmpty) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 256) return null;
  const normalized = value.map(validator);
  if (normalized.some((item) => item === null)) return null;
  const items = /** @type {string[]} */ (normalized);
  return new Set(items).size === items.length ? items.sort() : null;
}

/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateDiffArchitecturePolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "diff architecture policy must be an object" }] };
  rejectUnknown(value, ["version", "repository", "packs"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const repository = portableId(value.repository);
  if (!repository) errors.push({ id: "repository-invalid", detail: "repository must be a portable identifier" });

  /** @type {Array<any>} */ const packs = [];
  const packIds = new Set();
  const globalRuleIds = new Set();
  if (!Array.isArray(value.packs) || value.packs.length === 0 || value.packs.length > 128) {
    errors.push({ id: "packs-invalid", detail: "packs must be a non-empty bounded array" });
  } else for (const [packIndex, rawPack] of value.packs.entries()) {
    if (!object(rawPack)) { errors.push({ id: "pack-invalid", detail: `packs[${packIndex}] must be an object` }); continue; }
    rejectUnknown(rawPack, ["id", "match", "rules"], "pack", errors);
    const id = portableId(rawPack.id);
    if (!id || packIds.has(id)) { errors.push({ id: "pack-id-invalid", detail: `packs[${packIndex}].id is invalid or duplicate` }); continue; }
    packIds.add(id);

    let match = null;
    if (!object(rawPack.match)) errors.push({ id: "pack-match-invalid", detail: `packs[${packIndex}].match must be an object` });
    else {
      rejectUnknown(rawPack.match, ["profiles", "capabilities"], "pack-match", errors);
      const profiles = rawPack.match.profiles === undefined ? [] : uniqueList(rawPack.match.profiles, portableId, true);
      const capabilities = rawPack.match.capabilities === undefined ? [] : uniqueList(rawPack.match.capabilities, portableId, true);
      if (!profiles || !capabilities || profiles.length + capabilities.length === 0) {
        errors.push({ id: "pack-match-fields-invalid", detail: `packs[${packIndex}].match requires at least one valid profile or capability selector` });
      } else match = { profiles, capabilities };
    }

    /** @type {Array<any>} */ const rules = [];
    if (!Array.isArray(rawPack.rules) || rawPack.rules.length === 0 || rawPack.rules.length > 256) {
      errors.push({ id: "pack-rules-invalid", detail: `packs[${packIndex}].rules must be a non-empty bounded array` });
    } else for (const [ruleIndex, rawRule] of rawPack.rules.entries()) {
      if (!object(rawRule)) { errors.push({ id: "rule-invalid", detail: `packs[${packIndex}].rules[${ruleIndex}] must be an object` }); continue; }
      rejectUnknown(rawRule, ["id", "type", "paths", "modules", "severity"], "rule", errors);
      const ruleId = portableId(rawRule.id), type = text(rawRule.type, 32), severity = text(rawRule.severity, 16);
      const paths = uniqueList(rawRule.paths, safeGlob, false);
      if (!ruleId || globalRuleIds.has(ruleId) || !type || !RULE_TYPES.has(type) || !severity || !SEVERITIES.has(severity) || !paths) {
        errors.push({ id: "rule-fields-invalid", detail: `packs[${packIndex}].rules[${ruleIndex}] has invalid or duplicate id, type, severity, or paths` });
        continue;
      }
      globalRuleIds.add(ruleId);
      /** @type {string[]} */ let modules = [];
      if (type === "forbid-change") {
        if (rawRule.modules !== undefined) { errors.push({ id: "rule-modules-unexpected", detail: `rule ${ruleId} must not declare modules` }); continue; }
      } else {
        const parsedModules = uniqueList(rawRule.modules, moduleGlob, false);
        if (!parsedModules) { errors.push({ id: "rule-modules-invalid", detail: `rule ${ruleId} requires non-empty module patterns` }); continue; }
        modules = parsedModules;
      }
      rules.push({ id: ruleId, type, paths, modules, severity });
    }
    if (id && match && rules.length > 0) packs.push({ id, match, rules: rules.sort((a, b) => a.id.localeCompare(b.id)) });
  }

  if (errors.length > 0 || !repository) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, repository, packs: packs.sort((a, b) => a.id.localeCompare(b.id)) }, errors: [] };
}

/** @param {string} pattern */
function glob(pattern) {
  let out = "^";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i];
    if (char === undefined) break;
    if (char === "*" && pattern[i + 1] === "*") { out += ".*"; i += 1; }
    else if (char === "*") out += "[^/]*";
    else if (char === "?") out += "[^/]";
    else out += /[\\^$.*+?()[\]{}|]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${out}$`);
}

/** @param {string} value @param {string[]} patterns */
function matches(value, patterns) { return patterns.some((pattern) => glob(pattern).test(value)); }

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("read-only Git architecture inspection failed");
  return result.stdout;
}

/** @param {string} root @param {string} commit */
function requireCommit(root, commit) { git(root, ["cat-file", "-e", `${commit}^{commit}`]); }

/** @param {string} root @param {string} base @param {string} head */
function changedFiles(root, base, head) {
  const fields = git(root, ["diff", "--name-status", "-z", "--no-renames", base, head, "--"]).split("\0").filter(Boolean);
  if (fields.length % 2 !== 0) throw new Error("Git name-status output is malformed");
  const items = [];
  for (let index = 0; index < fields.length; index += 2) {
    const status = fields[index], file = fields[index + 1];
    if (!status || !file || !/^[AMD]$/.test(status) || path.isAbsolute(file) || file.includes("\\") || file.split("/").includes("..")) {
      throw new Error("Git changed-file evidence is unsupported or unsafe");
    }
    items.push({ status, path: file });
  }
  return items;
}

/** @param {string} root @param {string} commit @param {string} file */
function sourceAtCommit(root, commit, file) {
  const result = spawnSync("git", ["show", `${commit}:${file}`], { cwd: root, encoding: null, maxBuffer: 2 * 1024 * 1024 });
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error("changed source cannot be read from the head commit");
  if (result.stdout.length > MAX_SOURCE_BYTES || result.stdout.includes(0)) throw new Error("changed source is oversized or binary");
  return result.stdout.toString("utf8");
}

/** @param {string} source @param {string} filename */
function importedModules(source, filename) {
  const scriptKind = filename.endsWith("x") ? ts.ScriptKind.TSX : filename.endsWith(".js") || filename.endsWith(".mjs") || filename.endsWith(".cjs") ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const tree = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = /** @type {any} */ (tree).parseDiagnostics;
  if (Array.isArray(parseDiagnostics) && parseDiagnostics.length > 0) throw new Error("changed source cannot be parsed safely for import architecture evidence");
  /** @type {Set<string>} */ const modules = new Set();
  /** @param {import("typescript").Node} node */
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) modules.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments.length === 1) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteral(argument)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) modules.add(argument.text);
        else if (ts.isIdentifier(node.expression) && node.expression.text === "require") modules.add(argument.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return [...modules].sort();
}

/** @param {any} pack @param {any} manifest */
function packMatches(pack, manifest) {
  const profileMatches = pack.match.profiles.length === 0 || pack.match.profiles.includes(manifest.profile);
  const capabilitiesMatch = pack.match.capabilities.every((/** @type {string} */ capability) => manifest.capabilities.includes(capability));
  return profileMatches && capabilitiesMatch;
}

/** @param {string} root @param {any} manifest @param {any} policy @param {string} baseCommit @param {string} headCommit */
export function inspectDiffArchitecture(root, manifest, policy, baseCommit, headCommit) {
  const base = baseCommit.toLowerCase(), head = headCommit.toLowerCase();
  if (!isFullObjectId(base) || !isFullObjectId(head) || base === head) throw new Error("base and head must be distinct full Git object ids");
  if (manifest.repository.id !== policy.repository) throw new Error("architecture policy repository identity does not match manifest");
  const repositoryRoot = path.resolve(root);
  let stat; try { stat = fs.lstatSync(repositoryRoot); } catch { stat = null; }
  if (!stat || !stat.isDirectory() || stat.isSymbolicLink()) throw new Error("architecture repository must be a regular non-symlink directory");
  requireCommit(repositoryRoot, base); requireCommit(repositoryRoot, head);
  const changed = changedFiles(repositoryRoot, base, head);
  const selectedPacks = policy.packs.filter((/** @type {any} */ pack) => packMatches(pack, manifest));
  /** @type {Array<{id:string,status:"PASS"|"WARN"|"FAIL",pack:string,rule:string,file:string|null,detail:string}>} */ const checks = [];
  const sourceCache = new Map();
  const moduleCache = new Map();

  for (const pack of selectedPacks) for (const rule of pack.rules) {
    const applicable = changed.filter((item) => matches(item.path, rule.paths));
    if (applicable.length === 0) {
      checks.push({ id: "architecture-rule-not-applicable", status: "PASS", pack: pack.id, rule: rule.id, file: null, detail: "no changed files match this explicit rule" });
      continue;
    }
    if (rule.type === "forbid-change") {
      for (const item of applicable) checks.push({ id: "architecture-change-forbidden", status: rule.severity, pack: pack.id, rule: rule.id, file: item.path, detail: `changed path status ${item.status} is forbidden by private architecture policy` });
      continue;
    }
    const inspectable = applicable.filter((item) => item.status !== "D");
    if (inspectable.length === 0) {
      checks.push({ id: "architecture-import-rule-deletion-only", status: "PASS", pack: pack.id, rule: rule.id, file: null, detail: "rule matched only deleted files; no head imports can violate the rule" });
      continue;
    }
    for (const item of inspectable) {
      if (!SOURCE_EXTENSIONS.has(path.extname(item.path))) {
        checks.push({ id: "architecture-source-unsupported", status: "FAIL", pack: pack.id, rule: rule.id, file: item.path, detail: "import architecture rule matched a non-JavaScript/TypeScript source file" });
        continue;
      }
      if (!sourceCache.has(item.path)) sourceCache.set(item.path, sourceAtCommit(repositoryRoot, head, item.path));
      if (!moduleCache.has(item.path)) moduleCache.set(item.path, importedModules(sourceCache.get(item.path), item.path));
      const imports = moduleCache.get(item.path);
      const matching = imports.filter((/** @type {string} */ moduleName) => matches(moduleName, rule.modules));
      const passed = rule.type === "forbid-import" ? matching.length === 0 : matching.length > 0;
      checks.push({
        id: passed ? "architecture-import-rule-pass" : rule.type === "forbid-import" ? "architecture-forbidden-import" : "architecture-required-import-missing",
        status: passed ? "PASS" : rule.severity,
        pack: pack.id,
        rule: rule.id,
        file: item.path,
        detail: passed ? "changed file satisfies the explicit import architecture rule" : rule.type === "forbid-import" ? `changed file imports ${matching.join(", ")}` : "changed file lacks every configured required module import",
      });
    }
  }

  if (selectedPacks.length === 0) checks.push({ id: "architecture-no-pack-selected", status: "PASS", pack: "(none)", rule: "(none)", file: null, detail: "no private architecture pack matches this manifest profile and capabilities" });
  const fail = checks.filter((item) => item.status === "FAIL").length, warn = checks.filter((item) => item.status === "WARN").length;
  return {
    repository: manifest.repository.id,
    profile: manifest.profile,
    capabilities: manifest.capabilities,
    source: { baseCommit: base, headCommit: head },
    changedFiles: changed,
    selectedPacks: selectedPacks.map((/** @type {any} */ pack) => pack.id),
    checks: checks.sort((a, b) => `${a.pack}:${a.rule}:${a.file ?? ""}:${a.id}`.localeCompare(`${b.pack}:${b.rule}:${b.file ?? ""}:${b.id}`)),
    summary: { pass: checks.length - fail - warn, warn, fail },
    technicalStatus: "PASS",
    overallStatus: fail > 0 ? "FAIL" : warn > 0 ? "WARN" : "PASS",
    semantics: "diff-bound structural policy only; unchanged legacy files are not evaluated and import presence does not prove runtime behavior",
  };
}

/** @param {ReturnType<typeof inspectDiffArchitecture>} report */
export function formatDiffArchitecture(report) {
  const lines = ["Diff-aware architecture audit", "", `Repository: ${report.repository}`, `Profile: ${report.profile}`, `Base: ${report.source.baseCommit}`, `Head: ${report.source.headCommit}`, `Selected packs: ${report.selectedPacks.join(", ") || "(none)"}`, `Changed files: ${report.changedFiles.length}`, `Semantics: ${report.semantics}`, ""];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.pack}  ${check.rule}${check.file ? `  ${check.file}` : ""}  ${check.id}  ${check.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) {
  let root = null, manifestFile = null, policyFile = null, baseCommit = null, headCommit = null, json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]; if (argument === "--json") { json = true; continue; }
    if (!["--root", "--manifest", "--policy", "--base-commit", "--head-commit"].includes(argument ?? "")) return null;
    const value = argv[index + 1]; if (typeof value !== "string" || value.startsWith("--")) return null; index += 1;
    if (argument === "--root") { if (root) return null; root = value; }
    else if (argument === "--manifest") { if (manifestFile) return null; manifestFile = value; }
    else if (argument === "--policy") { if (policyFile) return null; policyFile = value; }
    else if (argument === "--base-commit") { if (baseCommit) return null; baseCommit = value; }
    else { if (headCommit) return null; headCommit = value; }
  }
  return root && manifestFile && policyFile && baseCommit && headCommit ? { root, manifestFile, policyFile, baseCommit, headCommit, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/audit-diff-architecture.js --root <repository> --manifest <manifest.json> --policy <private-architecture-policy.json> --base-commit <full-sha> --head-commit <full-sha> [--json]"); return 1; }
  const rawManifest = readJson(options.manifestFile), rawPolicy = readJson(options.policyFile);
  if (!rawManifest || !rawPolicy) { console.error("Diff architecture manifest or policy cannot be read or parsed"); return 1; }
  const manifest = validateRepositoryManifest(rawManifest), policy = validateDiffArchitecturePolicy(rawPolicy);
  if (!manifest.valid || !manifest.manifest || !policy.valid || !policy.policy) { console.error("Diff architecture manifest or policy is invalid"); return 1; }
  try {
    const report = inspectDiffArchitecture(options.root, manifest.manifest, policy.policy, options.baseCommit, options.headCommit);
    console.log(options.json ? JSON.stringify(report) : formatDiffArchitecture(report));
    return report.overallStatus === "FAIL" ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Diff architecture audit failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
