#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateEnvironmentContract } from "./audit-environment-contract.js";

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
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
function safePath(value) {
  const v = text(value);
  if (!v || v.length > 512 || path.isAbsolute(v) || v.includes("\\") || v.includes("\0")) return null;
  const normalized = path.posix.normalize(v);
  return normalized !== ".." && !normalized.startsWith("../") && normalized === v ? v : null;
}
/** @param {unknown} value */
function safePathList(value, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) return null;
  const list = value.map(safePath);
  return list.every(Boolean) && new Set(list).size === list.length ? /** @type {string[]} */ (list).sort() : null;
}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
}

/** @param {unknown} value */
export function validateDocumentationDriftPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "documentation drift policy must be an object" }] };
  rejectUnknown(value, ["version", "documents", "packageScripts", "environmentBindings", "pathReferenceRules", "generatedBindings", "severity"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  const documents = safePathList(value.documents, 1);
  if (!documents) errors.push({ id: "documents-invalid", detail: "documents must contain unique safe relative paths" });
  const documentSet = new Set(documents ?? []);

  /** @type {Array<{manifest:string,documents:string[]}>} */ const packageScripts = [];
  if (!Array.isArray(value.packageScripts)) errors.push({ id: "package-scripts-invalid", detail: "packageScripts must be an array" });
  else for (const [index, raw] of value.packageScripts.entries()) {
    if (!object(raw)) { errors.push({ id: "package-script-invalid", detail: `packageScripts[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["manifest", "documents"], "package-script", errors);
    const manifest = safePath(raw.manifest), docs = safePathList(raw.documents, 1);
    if (!manifest || !docs || docs.some((doc) => !documentSet.has(doc))) {
      errors.push({ id: "package-script-fields-invalid", detail: `packageScripts[${index}] requires a safe manifest and configured documents` });
      continue;
    }
    packageScripts.push({ manifest, documents: docs });
  }

  /** @type {Array<{contract:string,documents:string[]}>} */ const environmentBindings = [];
  if (!Array.isArray(value.environmentBindings)) errors.push({ id: "environment-bindings-invalid", detail: "environmentBindings must be an array" });
  else for (const [index, raw] of value.environmentBindings.entries()) {
    if (!object(raw)) { errors.push({ id: "environment-binding-invalid", detail: `environmentBindings[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["contract", "documents"], "environment-binding", errors);
    const contract = safePath(raw.contract), docs = safePathList(raw.documents, 1);
    if (!contract || !docs || docs.some((doc) => !documentSet.has(doc))) {
      errors.push({ id: "environment-binding-fields-invalid", detail: `environmentBindings[${index}] requires a safe contract and configured documents` });
      continue;
    }
    environmentBindings.push({ contract, documents: docs });
  }

  /** @type {Array<{documents:string[],prefixes:string[]}>} */ const pathReferenceRules = [];
  if (!Array.isArray(value.pathReferenceRules)) errors.push({ id: "path-rules-invalid", detail: "pathReferenceRules must be an array" });
  else for (const [index, raw] of value.pathReferenceRules.entries()) {
    if (!object(raw)) { errors.push({ id: "path-rule-invalid", detail: `pathReferenceRules[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["documents", "prefixes"], "path-rule", errors);
    const docs = safePathList(raw.documents, 1), prefixes = safePathList(raw.prefixes, 1);
    if (!docs || docs.some((doc) => !documentSet.has(doc)) || !prefixes || prefixes.some((prefix) => !prefix.endsWith("/"))) {
      errors.push({ id: "path-rule-fields-invalid", detail: `pathReferenceRules[${index}] requires configured documents and directory prefixes ending in /` });
      continue;
    }
    pathReferenceRules.push({ documents: docs, prefixes });
  }

  /** @type {Array<{document:string,sources:string[],marker:string}>} */ const generatedBindings = [];
  if (!Array.isArray(value.generatedBindings)) errors.push({ id: "generated-bindings-invalid", detail: "generatedBindings must be an array" });
  else for (const [index, raw] of value.generatedBindings.entries()) {
    if (!object(raw)) { errors.push({ id: "generated-binding-invalid", detail: `generatedBindings[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["document", "sources", "marker"], "generated-binding", errors);
    const document = safePath(raw.document), sources = safePathList(raw.sources, 1), marker = text(raw.marker);
    if (!document || !documentSet.has(document) || !sources || !marker || !/^[A-Za-z0-9._:-]{1,64}$/.test(marker)) {
      errors.push({ id: "generated-binding-fields-invalid", detail: `generatedBindings[${index}] requires configured document, source paths, and portable marker` });
      continue;
    }
    generatedBindings.push({ document, sources, marker });
  }

  let severity = null;
  const severityRaw = value.severity;
  if (!object(severityRaw)) errors.push({ id: "severity-invalid", detail: "severity must be an object" });
  else {
    const keys = ["documentInspection", "commandReference", "environmentReference", "pathReference", "generatedDocument"];
    rejectUnknown(severityRaw, keys, "severity", errors);
    if (keys.some((key) => !STATUSES.has(String(severityRaw[key] ?? "")))) errors.push({ id: "severity-fields-invalid", detail: "all documentation drift severities must be WARN or FAIL" });
    else severity = Object.fromEntries(keys.map((key) => [key, severityRaw[key]]));
  }

  if (errors.length || !documents || !severity) return { valid: false, policy: null, errors };
  return {
    valid: true,
    policy: {
      version: 1,
      documents,
      packageScripts,
      environmentBindings,
      pathReferenceRules,
      generatedBindings,
      severity,
    },
    errors: [],
  };
}

/** @param {string} root @param {string} relative */
function resolveInside(root, relative) {
  const absolute = path.resolve(root, relative), base = path.resolve(root), rel = path.relative(base, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("configured documentation path escaped repository root");
  return absolute;
}
/** @param {string} root @param {string} relative */
function readBoundedText(root, relative) {
  const absolute = resolveInside(root, relative);
  let stat;
  try { stat = fs.lstatSync(absolute); } catch { return { ok: false, reason: "missing", text: null }; }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, reason: "not-regular-file", text: null };
  if (stat.size > MAX_TEXT_BYTES) return { ok: false, reason: "too-large", text: null };
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) return { ok: false, reason: "binary", text: null };
  return { ok: true, reason: null, text: buffer.toString("utf8") };
}
/** @param {string} root @param {string} relative */
function regularPathExists(root, relative) {
  const absolute = resolveInside(root, relative);
  try { const stat = fs.lstatSync(absolute); return !stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()); } catch { return false; }
}
/** @param {string} root @param {string} relative */
function readJsonObject(root, relative) {
  const read = readBoundedText(root, relative);
  if (!read.ok || read.text === null) return { ok: false, value: null };
  try { const value = JSON.parse(read.text); return object(value) ? { ok: true, value } : { ok: false, value: null }; } catch { return { ok: false, value: null }; }
}

/** @param {string} markdown */
function documentedRunCommands(markdown) {
  const refs = [];
  const patterns = [
    { manager: "bun", regex: /\bbun\s+run\s+([A-Za-z0-9:_-]+)/g },
    { manager: "npm", regex: /\bnpm\s+run\s+([A-Za-z0-9:_-]+)/g },
    { manager: "pnpm", regex: /\bpnpm\s+run\s+([A-Za-z0-9:_-]+)/g },
    { manager: "yarn", regex: /\byarn\s+run\s+([A-Za-z0-9:_-]+)/g },
  ];
  for (const pattern of patterns) for (const match of markdown.matchAll(pattern.regex)) if (match[1]) refs.push({ manager: pattern.manager, script: match[1] });
  return refs;
}
/** @param {string} markdown @param {string[]} prefixes */
function inlinePathReferences(markdown, prefixes) {
  const found = new Set();
  for (const match of markdown.matchAll(/`([^`\r\n]+)`/g)) {
    const raw = match[1]?.trim();
    if (!raw || /\s/.test(raw)) continue;
    const target = raw.split("#", 1)[0]?.replace(/[),.;:]+$/, "") ?? "";
    if (!target || !prefixes.some((prefix) => target.startsWith(prefix))) continue;
    if (safePath(target)) found.add(target);
  }
  return [...found].sort();
}
/** @param {string} root @param {string[]} sources */
function sourceDigest(root, sources) {
  const hash = crypto.createHash("sha256");
  for (const source of [...sources].sort()) {
    const read = readBoundedText(root, source);
    if (!read.ok || read.text === null) return null;
    hash.update(source, "utf8"); hash.update("\0"); hash.update(read.text, "utf8"); hash.update("\0");
  }
  return hash.digest("hex");
}

/** @param {string} root @param {any} policy */
export function inspectDocumentationDrift(root, policy) {
  /** @type {Array<any>} */ const checks = [];
  const docs = new Map();
  /** @param {string} id @param {string} status @param {string} document @param {string} detail */
  const finding = (id, status, document, detail) => checks.push({ id, status, document, detail });

  for (const document of policy.documents) {
    const read = readBoundedText(root, document);
    if (!read.ok || read.text === null) finding("document-uninspectable", policy.severity.documentInspection, document, `configured documentation is ${read.reason}`);
    else docs.set(document, read.text);
  }

  for (const binding of policy.packageScripts) {
    const manifestResult = readJsonObject(root, binding.manifest);
    if (!manifestResult.ok || !manifestResult.value) {
      for (const document of binding.documents) finding("command-manifest-uninspectable", policy.severity.commandReference, document, `package manifest ${binding.manifest} is unavailable or invalid`);
      continue;
    }
    const scripts = object(manifestResult.value.scripts) ? manifestResult.value.scripts : {};
    for (const document of binding.documents) {
      const markdown = docs.get(document);
      if (markdown === undefined) continue;
      for (const ref of documentedRunCommands(markdown)) {
        if (typeof scripts[ref.script] !== "string") finding("documented-command-missing", policy.severity.commandReference, document, `${ref.manager} run reference ${ref.script} has no matching script in ${binding.manifest}`);
      }
    }
  }

  for (const binding of policy.environmentBindings) {
    const raw = readJsonObject(root, binding.contract);
    if (!raw.ok || !raw.value) {
      for (const document of binding.documents) finding("environment-contract-uninspectable", policy.severity.environmentReference, document, `environment contract ${binding.contract} is unavailable or invalid`);
      continue;
    }
    const validated = validateEnvironmentContract(raw.value);
    if (!validated.ok || !validated.contract) {
      for (const document of binding.documents) finding("environment-contract-invalid", policy.severity.environmentReference, document, `environment contract ${binding.contract} does not validate`);
      continue;
    }
    const searchable = binding.documents.map((/** @type {string} */ document) => docs.get(document) ?? "").join("\n");
    for (const variable of validated.contract.variables.filter((item) => item.documented)) {
      const pattern = new RegExp(`(^|[^A-Za-z0-9_])${variable.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9_]|$)`);
      if (!pattern.test(searchable)) finding("documented-environment-variable-missing", policy.severity.environmentReference, binding.documents.join(", "), `${variable.name} is marked documented but absent from configured documentation`);
    }
  }

  for (const rule of policy.pathReferenceRules) {
    for (const document of rule.documents) {
      const markdown = docs.get(document);
      if (markdown === undefined) continue;
      for (const target of inlinePathReferences(markdown, rule.prefixes)) {
        if (!regularPathExists(root, target)) finding("documented-path-missing", policy.severity.pathReference, document, `documented repository path ${target} does not exist`);
      }
    }
  }

  for (const binding of policy.generatedBindings) {
    const markdown = docs.get(binding.document);
    if (markdown === undefined) continue;
    const expected = sourceDigest(root, binding.sources);
    if (expected === null) {
      finding("generated-source-uninspectable", policy.severity.generatedDocument, binding.document, "one or more generated documentation sources are unavailable or uninspectable");
      continue;
    }
    const escaped = binding.marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`<!--\\s*${escaped}\\s*:\\s*([a-fA-F0-9]{64})\\s*-->`).exec(markdown);
    if (!match) finding("generated-marker-missing", policy.severity.generatedDocument, binding.document, `generated documentation marker ${binding.marker} is missing`);
    else if (match[1]?.toLowerCase() !== expected) finding("generated-document-stale", policy.severity.generatedDocument, binding.document, `generated documentation source digest differs from marker ${binding.marker}`);
  }

  if (checks.length === 0) checks.push({ id: "documentation-current", status: "PASS", document: null, detail: "configured documentation references are current" });
  const summary = {
    pass: checks.filter((item) => item.status === "PASS").length,
    warn: checks.filter((item) => item.status === "WARN").length,
    fail: checks.filter((item) => item.status === "FAIL").length,
  };
  return {
    documentsConfigured: policy.documents.length,
    documentsInspected: docs.size,
    checks,
    summary,
    technicalStatus: "PASS",
    overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectDocumentationDrift>} report */
export function formatDocumentationDrift(report) {
  const lines = ["Documentation drift audit", ""];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.document ?? "(documentation)"}  ${check.detail}`);
  lines.push("", `Documents: ${report.documentsInspected}/${report.documentsConfigured} inspected`, `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
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
  if (!options) { console.error("Usage: node scripts/audit-documentation-drift.js --root <repository> --policy <policy.json> [--json]"); return 1; }
  const raw = readJson(options.policyFile);
  if (!raw) { console.error("Documentation drift policy cannot be read or parsed"); return 1; }
  const validated = validateDocumentationDriftPolicy(raw);
  if (!validated.valid || !validated.policy) { console.error("Documentation drift policy is invalid"); return 1; }
  try {
    const report = inspectDocumentationDrift(path.resolve(options.root), validated.policy);
    console.log(options.json ? JSON.stringify(report) : formatDocumentationDrift(report));
    return report.overallStatus === "FAIL" ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Documentation drift audit failed");
    return 1;
  }
}
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
