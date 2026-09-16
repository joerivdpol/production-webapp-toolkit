#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const CONTRACT_VERSION = 1;
const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts", ".vue", ".svelte"]);
const PUBLIC_PROCESS_PREFIXES = ["NEXT_PUBLIC_", "REACT_APP_", "PUBLIC_"];
const VITE_BUILT_INS = new Set(["MODE", "BASE_URL", "PROD", "DEV", "SSR"]);

/** @typedef {"server" | "public"} Exposure */
/** @typedef {{ name: string, required: boolean, exposure: Exposure, documented: boolean }} ContractVariable */
/** @typedef {{ version: 1, scanRoots: string[], exampleFiles: string[], variables: ContractVariable[] }} EnvironmentContract */
/** @typedef {{ file: string, line: number, accessor: string, channel: Exposure }} EnvironmentReference */
/** @typedef {{ id: string, severity: "PASS" | "WARN" | "FAIL", detail: string, variable?: string }} AuditCheck */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function normalizedString(value) {
  return typeof value === "string" ? value.trim() : null;
}

/** @param {string} value */
function isSafeRelativePath(value) {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

/** @param {string} value */
function isSafeExamplePath(value) {
  if (!isSafeRelativePath(value)) return false;
  const base = path.basename(value).toLowerCase();
  return base.includes("example") || base.includes("sample") || base.includes("template");
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {{ id: string, detail: string }[]} errors */
function rejectUnknownFields(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateEnvironmentContract(value) {
  /** @type {{ id: string, detail: string }[]} */
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, contract: null, errors: [{ id: "contract-invalid", detail: "environment contract must be a JSON object" }] };
  rejectUnknownFields(value, ["version", "scanRoots", "exampleFiles", "variables"], "contract", errors);
  if (value.version !== CONTRACT_VERSION) errors.push({ id: "version-invalid", detail: `version must be exactly ${CONTRACT_VERSION}` });

  /** @type {string[]} */
  const scanRoots = [];
  if (!Array.isArray(value.scanRoots) || value.scanRoots.length === 0) {
    errors.push({ id: "scan-roots-invalid", detail: "scanRoots must be a non-empty array" });
  } else {
    const seen = new Set();
    for (const raw of value.scanRoots) {
      const item = normalizedString(raw);
      if (item === null || !isSafeRelativePath(item)) errors.push({ id: "scan-root-invalid", detail: "scanRoots must contain safe relative paths" });
      else if (seen.has(item)) errors.push({ id: "scan-root-duplicate", detail: `duplicate scan root "${item}"` });
      else { seen.add(item); scanRoots.push(item); }
    }
  }

  /** @type {string[]} */
  const exampleFiles = [];
  if (!Array.isArray(value.exampleFiles)) {
    errors.push({ id: "example-files-invalid", detail: "exampleFiles must be an array" });
  } else {
    const seen = new Set();
    for (const raw of value.exampleFiles) {
      const item = normalizedString(raw);
      if (item === null || !isSafeExamplePath(item)) errors.push({ id: "example-file-invalid", detail: "exampleFiles may only contain safe example/sample/template paths" });
      else if (seen.has(item)) errors.push({ id: "example-file-duplicate", detail: `duplicate example file "${item}"` });
      else { seen.add(item); exampleFiles.push(item); }
    }
  }

  /** @type {ContractVariable[]} */
  const variables = [];
  if (!Array.isArray(value.variables) || value.variables.length === 0) {
    errors.push({ id: "variables-invalid", detail: "variables must be a non-empty array" });
  } else {
    const seen = new Set();
    for (const [index, raw] of value.variables.entries()) {
      if (!isPlainObject(raw)) { errors.push({ id: "variable-invalid", detail: `variables[${index}] must be an object` }); continue; }
      rejectUnknownFields(raw, ["name", "required", "exposure", "documented"], "variable", errors);
      const name = normalizedString(raw.name);
      if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) errors.push({ id: "variable-name-invalid", detail: `variables[${index}].name must be an environment identifier` });
      else if (seen.has(name)) errors.push({ id: "variable-name-duplicate", detail: `duplicate environment variable "${name}"` });
      else seen.add(name);
      if (typeof raw.required !== "boolean") errors.push({ id: "variable-required-invalid", detail: `variables[${index}].required must be boolean` });
      if (raw.exposure !== "server" && raw.exposure !== "public") errors.push({ id: "variable-exposure-invalid", detail: `variables[${index}].exposure must be server or public` });
      if (typeof raw.documented !== "boolean") errors.push({ id: "variable-documented-invalid", detail: `variables[${index}].documented must be boolean` });
      if (name && typeof raw.required === "boolean" && (raw.exposure === "server" || raw.exposure === "public") && typeof raw.documented === "boolean") {
        variables.push({ name, required: raw.required, exposure: raw.exposure, documented: raw.documented });
      }
    }
  }
  if (variables.some((item) => item.documented) && exampleFiles.length === 0) errors.push({ id: "documented-without-example", detail: "documented variables require at least one example file" });
  if (errors.length > 0) return { ok: false, contract: null, errors };
  return { ok: true, contract: /** @type {EnvironmentContract} */ ({ version: 1, scanRoots, exampleFiles, variables }), errors: [] };
}

/** @param {string} root @param {string} candidate */
function resolveInsideRoot(root, candidate) {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

/** @param {string} text @param {number} index */
function lineNumber(text, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (text.charCodeAt(cursor) === 10) line += 1;
  return line;
}

/** @param {string} name */
function processChannel(name) {
  return PUBLIC_PROCESS_PREFIXES.some((prefix) => name.startsWith(prefix)) ? "public" : "server";
}

/** @param {string} text @param {string} relativeFile */
function extractReferences(text, relativeFile) {
  /** @type {Map<string, EnvironmentReference[]>} */
  const references = new Map();
  /** @type {{ file: string, line: number, accessor: string }[]} */
  const dynamic = [];
  /** @param {string} name @param {number} index @param {string} accessor @param {Exposure} channel */
  const add = (name, index, accessor, channel) => {
    if (accessor === "import.meta.env" && VITE_BUILT_INS.has(name)) return;
    const items = references.get(name) ?? [];
    items.push({ file: relativeFile, line: lineNumber(text, index), accessor, channel });
    references.set(name, items);
  };

  /** @type {Array<{ regex: RegExp, accessor: string, channel: (name: string) => Exposure }>} */
  const patterns = [
    { regex: /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, accessor: "process.env", channel: (name) => processChannel(name) },
    { regex: /\bprocess\.env\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g, accessor: "process.env", channel: (name) => processChannel(name) },
    { regex: /\bBun\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, accessor: "Bun.env", channel: () => "server" },
    { regex: /\bBun\.env\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g, accessor: "Bun.env", channel: () => "server" },
    { regex: /\bDeno\.env\.get\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\)/g, accessor: "Deno.env.get", channel: () => "server" },
    { regex: /\bimport\.meta\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, accessor: "import.meta.env", channel: () => "public" },
    { regex: /\bimport\.meta\.env\s*\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]/g, accessor: "import.meta.env", channel: () => "public" },
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern.regex)) {
      const name = match[1];
      if (name && match.index !== undefined) add(name, match.index, pattern.accessor, /** @type {Exposure} */ (pattern.channel(name)));
    }
  }

  const sveltePattern = /import\s*\{([^}]+)\}\s*from\s*["']\$env\/(static|dynamic)\/(public|private)["']/g;
  for (const match of text.matchAll(sveltePattern)) {
    if (match.index === undefined) continue;
    const channel = match[3] === "public" ? "public" : "server";
    for (const token of (match[1] ?? "").split(",")) {
      const original = token.trim().split(/\s+as\s+/i)[0]?.trim();
      if (original && /^[A-Za-z_][A-Za-z0-9_]*$/.test(original)) add(original, match.index, `$env/${match[2]}/${match[3]}`, channel);
    }
  }

  const dynamicPatterns = [
    { regex: /\bprocess\.env\s*\[\s*(?!["'])/g, accessor: "process.env" },
    { regex: /\bBun\.env\s*\[\s*(?!["'])/g, accessor: "Bun.env" },
    { regex: /\bimport\.meta\.env\s*\[\s*(?!["'])/g, accessor: "import.meta.env" },
    { regex: /\bDeno\.env\.get\(\s*(?!["'])/g, accessor: "Deno.env.get" },
  ];
  for (const pattern of dynamicPatterns) {
    for (const match of text.matchAll(pattern.regex)) if (match.index !== undefined) dynamic.push({ file: relativeFile, line: lineNumber(text, match.index), accessor: pattern.accessor });
  }
  return { references, dynamic };
}

/** @param {string} root @param {string[]} scanRoots */
function scanSource(root, scanRoots) {
  /** @type {Map<string, EnvironmentReference[]>} */
  const references = new Map();
  /** @type {{ file: string, line: number, accessor: string }[]} */
  const dynamic = [];
  /** @type {string[]} */
  const missingRoots = [];
  /** @type {string[]} */
  const skippedLargeFiles = [];
  let filesScanned = 0;

  /** @param {string} filename */
  const visit = (filename) => {
    const stats = fs.lstatSync(filename);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      const base = path.basename(filename);
      if ([".git", "node_modules", "dist", "build", ".next", ".output", "coverage"].includes(base)) return;
      for (const entry of fs.readdirSync(filename)) visit(path.join(filename, entry));
      return;
    }
    if (!stats.isFile() || !SOURCE_EXTENSIONS.has(path.extname(filename))) return;
    const relativeFile = path.relative(root, filename);
    if (stats.size > MAX_SOURCE_BYTES) { skippedLargeFiles.push(relativeFile); return; }
    const text = fs.readFileSync(filename, "utf8");
    filesScanned += 1;
    const extracted = extractReferences(text, relativeFile);
    for (const [name, items] of extracted.references) references.set(name, [...(references.get(name) ?? []), ...items]);
    dynamic.push(...extracted.dynamic);
  };

  for (const scanRoot of scanRoots) {
    const resolved = path.resolve(root, scanRoot);
    if (!resolveInsideRoot(root, scanRoot) || !fs.existsSync(resolved)) { missingRoots.push(scanRoot); continue; }
    visit(resolved);
  }
  return { references, dynamic, missingRoots, skippedLargeFiles, filesScanned };
}

/** @param {string} root @param {string[]} exampleFiles */
function scanExamples(root, exampleFiles) {
  const declared = new Set();
  /** @type {string[]} */
  const missingFiles = [];
  /** @type {string[]} */
  const duplicates = [];
  for (const item of exampleFiles) {
    const resolved = path.resolve(root, item);
    if (!resolveInsideRoot(root, item) || !fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) { missingFiles.push(item); continue; }
    const text = fs.readFileSync(resolved, "utf8");
    const local = new Set();
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
      if (!match?.[1]) continue;
      const name = match[1];
      if (local.has(name)) duplicates.push(`${item}:${name}`);
      local.add(name);
      declared.add(name);
    }
  }
  return { declared, missingFiles, duplicates };
}

/** @param {string} root @param {EnvironmentContract} contract */
export function inspectEnvironmentContract(root, contract) {
  const repository = path.resolve(root);
  if (!fs.existsSync(repository) || !fs.statSync(repository).isDirectory()) {
    return { technicalStatus: "FAIL", overallStatus: "FAIL", root: repository, contract, checks: [{ id: "repository-unreadable", severity: "FAIL", detail: "repository path is not a readable directory" }], variables: [], unknownReferences: [], dynamicAccess: [], filesScanned: 0 };
  }

  let source;
  let examples;
  try {
    source = scanSource(repository, contract.scanRoots);
    examples = scanExamples(repository, contract.exampleFiles);
  } catch {
    return { technicalStatus: "FAIL", overallStatus: "FAIL", root: repository, contract, checks: [{ id: "inspection-failed", severity: "FAIL", detail: "environment contract inspection could not read the declared repository inputs" }], variables: [], unknownReferences: [], dynamicAccess: [], filesScanned: 0 };
  }

  /** @type {AuditCheck[]} */
  const checks = [];
  for (const missing of source.missingRoots) checks.push({ id: "scan-root-missing", severity: "FAIL", detail: `declared scan root is missing: ${missing}` });
  for (const missing of examples.missingFiles) checks.push({ id: "example-file-missing", severity: "FAIL", detail: `declared example file is missing: ${missing}` });
  for (const duplicate of examples.duplicates) checks.push({ id: "example-key-duplicate", severity: "FAIL", detail: `duplicate example key: ${duplicate}` });
  for (const file of source.skippedLargeFiles) checks.push({ id: "source-file-too-large", severity: "WARN", detail: `source file exceeded scan limit and was skipped: ${file}` });
  for (const access of source.dynamic) checks.push({ id: "dynamic-environment-access", severity: "WARN", detail: `dynamic environment access cannot be mapped to the contract: ${access.file}:${access.line} (${access.accessor})` });

  const declaredNames = new Set(contract.variables.map((item) => item.name));
  const unknownReferences = [...source.references.keys()].filter((name) => !declaredNames.has(name)).sort();
  for (const name of unknownReferences) checks.push({ id: "undeclared-environment-reference", severity: "FAIL", variable: name, detail: `source references undeclared environment variable ${name}` });
  const unknownExampleKeys = [...examples.declared].filter((name) => !declaredNames.has(name)).sort();
  for (const name of unknownExampleKeys) checks.push({ id: "undeclared-example-key", severity: "FAIL", variable: name, detail: `example file declares environment variable not present in the contract: ${name}` });

  const variables = contract.variables.map((variable) => {
    const references = source.references.get(variable.name) ?? [];
    const publicReferences = references.filter((reference) => reference.channel === "public");
    const documented = examples.declared.has(variable.name);
    if (variable.required) checks.push({ id: "required-variable-usage", severity: references.length > 0 ? "PASS" : "FAIL", variable: variable.name, detail: references.length > 0 ? `required variable ${variable.name} is referenced` : `required variable ${variable.name} is not referenced in declared scan roots` });
    if (variable.exposure === "server") checks.push({ id: "server-variable-exposure", severity: publicReferences.length === 0 ? "PASS" : "FAIL", variable: variable.name, detail: publicReferences.length === 0 ? `server variable ${variable.name} has no public accessor reference` : `server variable ${variable.name} is referenced through a public accessor` });
    if (variable.documented) checks.push({ id: "variable-documentation", severity: documented ? "PASS" : "FAIL", variable: variable.name, detail: documented ? `variable ${variable.name} is documented in an example file` : `variable ${variable.name} is missing from declared example files` });
    return { ...variable, references, documented };
  });

  const failCount = checks.filter((check) => check.severity === "FAIL").length;
  const warnCount = checks.filter((check) => check.severity === "WARN").length;
  const overallStatus = failCount > 0 ? "FAIL" : warnCount > 0 ? "WARN" : "PASS";
  return {
    root: repository,
    contract,
    variables,
    unknownReferences,
    unknownExampleKeys,
    dynamicAccess: source.dynamic,
    filesScanned: source.filesScanned,
    checks,
    summary: { pass: checks.filter((check) => check.severity === "PASS").length, warn: warnCount, fail: failCount },
    technicalStatus: "PASS",
    overallStatus,
  };
}

/** @param {ReturnType<typeof inspectEnvironmentContract>} report */
export function formatEnvironmentContract(report) {
  const lines = [
    "Environment contract audit",
    "",
    `Repository: ${report.root}`,
    `Variables: ${report.contract.variables.length}`,
    `Source files scanned: ${report.filesScanned}`,
    `Example files: ${report.contract.exampleFiles.length}`,
    "",
  ];
  for (const check of report.checks.filter((item) => item.severity !== "PASS")) lines.push(`${check.severity}  ${check.id}  ${check.detail}`);
  if (report.checks.every((item) => item.severity === "PASS")) lines.push("PASS  contract  environment usage matches the explicit contract");
  lines.push("", `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  let target = null;
  let contractFile = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string") return null;
    if (argument === "--json") json = true;
    else if (argument === "--contract") {
      const value = argv[index + 1];
      if (contractFile !== null || typeof value !== "string" || !value || value.startsWith("--")) return null;
      contractFile = value;
      index += 1;
    } else if (argument.startsWith("-")) return null;
    else if (target === null) target = argument;
    else return null;
  }
  if (contractFile === null) return null;
  return { target, contractFile, json };
}

/** @param {string} filename @returns {{ ok: true, contract: EnvironmentContract } | { ok: false, error: { id: string, detail: string } }} */
function readContractFile(filename) {
  let value;
  try { value = JSON.parse(fs.readFileSync(filename, "utf8")); }
  catch (error) { return { ok: false, error: { id: error instanceof SyntaxError ? "contract-json-invalid" : "contract-file-unreadable", detail: error instanceof SyntaxError ? "environment contract contains invalid JSON" : "environment contract file cannot be read" } }; }
  const validation = validateEnvironmentContract(value);
  if (!validation.ok || validation.contract === null) return { ok: false, error: { id: "contract-schema-invalid", detail: validation.errors.map((item) => item.detail).join("; ") } };
  return { ok: true, contract: validation.contract };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/audit-environment-contract.js [repository] --contract <environment-contract.json> [--json]");
    return 1;
  }
  const loaded = readContractFile(options.contractFile);
  if (!loaded.ok) { console.error(loaded.error.detail); return 1; }
  const report = inspectEnvironmentContract(options.target ?? process.cwd(), loaded.contract);
  console.log(options.json ? JSON.stringify(report) : formatEnvironmentContract(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

// The auditor reads only the explicit contract, declared source roots, and safe
// example/sample/template files. It never reads process environment state, .env
// runtime files, network resources, Git metadata, or repository-external paths.
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
