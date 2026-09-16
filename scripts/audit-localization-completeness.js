#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;
const SEVERITIES = new Set(["IGNORE", "WARN", "FAIL"]);
const CATALOG_MODES = new Set(["flat", "nested"]);
const PLACEHOLDER_SYNTAXES = new Set(["brace", "double-brace", "percent-brace"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value */
function text(value) { return typeof value === "string" && value.trim().length > 0 ? value.trim() : null; }
/** @param {unknown} value */
function portableId(value) { const v = text(value); return v && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(v) ? v : null; }
/** @param {unknown} value */
function safePath(value) {
  const v = text(value);
  if (!v || v.length > 512 || path.isAbsolute(v) || v.includes("\\") || v.includes("\0")) return null;
  const normalized = path.posix.normalize(v);
  return normalized !== ".." && !normalized.startsWith("../") && normalized === v ? v : null;
}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
}
/** @param {unknown} value @param {number} [minimum] */
function stringList(value, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum) return null;
  const list = value.map(text);
  if (!list.every(Boolean)) return null;
  const normalized = /** @type {string[]} */ (list);
  return new Set(normalized).size === normalized.length ? [...normalized].sort() : null;
}
/** @param {unknown} value @param {number} [minimum] */
function keyList(value, minimum = 0) {
  const list = stringList(value, minimum);
  return list && list.every((item) => item.length <= 512 && !/[\u0000-\u001f]/.test(item)) ? list : null;
}

/** @param {unknown} value */
export function validateLocalizationPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "localization policy must be an object" }] };
  rejectUnknown(value, ["version", "referenceLocale", "catalogMode", "locales", "placeholderSyntaxes", "extraKeys", "fallback", "html", "currencyRules"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const referenceLocale = portableId(value.referenceLocale);
  if (!referenceLocale) errors.push({ id: "reference-locale-invalid", detail: "referenceLocale must be a portable locale id" });
  const catalogMode = text(value.catalogMode);
  if (!catalogMode || !CATALOG_MODES.has(catalogMode)) errors.push({ id: "catalog-mode-invalid", detail: "catalogMode must be flat or nested" });

  /** @type {Array<{id:string,file:string}>} */ const locales = [];
  if (!Array.isArray(value.locales) || value.locales.length < 2) errors.push({ id: "locales-invalid", detail: "locales must contain at least two configured locales" });
  else {
    const ids = new Set(), files = new Set();
    for (const [index, raw] of value.locales.entries()) {
      if (!object(raw)) { errors.push({ id: "locale-invalid", detail: `locales[${index}] must be an object` }); continue; }
      rejectUnknown(raw, ["id", "file"], "locale", errors);
      const id = portableId(raw.id), file = safePath(raw.file);
      if (!id || !file) { errors.push({ id: "locale-fields-invalid", detail: `locales[${index}] requires portable id and safe relative file` }); continue; }
      if (ids.has(id) || files.has(file)) { errors.push({ id: "locale-duplicate", detail: `locales[${index}] duplicates a locale id or file` }); continue; }
      ids.add(id); files.add(file); locales.push({ id, file });
    }
  }
  if (referenceLocale && !locales.some((locale) => locale.id === referenceLocale)) errors.push({ id: "reference-locale-missing", detail: "referenceLocale must be present in locales" });

  const placeholderSyntaxes = stringList(value.placeholderSyntaxes, 1);
  if (!placeholderSyntaxes || placeholderSyntaxes.some((item) => !PLACEHOLDER_SYNTAXES.has(item))) errors.push({ id: "placeholder-syntax-invalid", detail: "placeholderSyntaxes must contain supported unique syntaxes" });

  let extraKeys = null;
  if (!object(value.extraKeys)) errors.push({ id: "extra-keys-invalid", detail: "extraKeys must be an object" });
  else {
    rejectUnknown(value.extraKeys, ["severity"], "extra-keys", errors);
    const severity = text(value.extraKeys.severity);
    if (!severity || !SEVERITIES.has(severity)) errors.push({ id: "extra-keys-severity-invalid", detail: "extraKeys.severity must be IGNORE, WARN, or FAIL" });
    else extraKeys = { severity };
  }

  let fallback = null;
  if (!object(value.fallback)) errors.push({ id: "fallback-invalid", detail: "fallback must be an object" });
  else {
    rejectUnknown(value.fallback, ["severity", "minimumLength", "allowKeys"], "fallback", errors);
    const severity = text(value.fallback.severity), allowKeys = keyList(value.fallback.allowKeys ?? []), minimumLength = value.fallback.minimumLength;
    if (!severity || !SEVERITIES.has(severity) || !Number.isSafeInteger(minimumLength) || Number(minimumLength) < 1 || Number(minimumLength) > 1024 || !allowKeys) errors.push({ id: "fallback-fields-invalid", detail: "fallback requires severity, bounded minimumLength, and unique allowKeys" });
    else fallback = { severity, minimumLength: Number(minimumLength), allowKeys };
  }

  let html = null;
  if (!object(value.html)) errors.push({ id: "html-invalid", detail: "html must be an object" });
  else {
    rejectUnknown(value.html, ["severity", "allowKeys"], "html", errors);
    const severity = text(value.html.severity), allowKeys = keyList(value.html.allowKeys ?? []);
    if (!severity || !SEVERITIES.has(severity) || !allowKeys) errors.push({ id: "html-fields-invalid", detail: "html requires severity and unique allowKeys" });
    else html = { severity, allowKeys };
  }

  /** @type {Array<{key:string,requiredPlaceholders:string[],forbiddenLiterals:string[]}>} */ const currencyRules = [];
  if (!Array.isArray(value.currencyRules)) errors.push({ id: "currency-rules-invalid", detail: "currencyRules must be an array" });
  else {
    const keys = new Set();
    for (const [index, raw] of value.currencyRules.entries()) {
      if (!object(raw)) { errors.push({ id: "currency-rule-invalid", detail: `currencyRules[${index}] must be an object` }); continue; }
      rejectUnknown(raw, ["key", "requiredPlaceholders", "forbiddenLiterals"], "currency-rule", errors);
      const key = text(raw.key), requiredPlaceholders = stringList(raw.requiredPlaceholders, 1), forbiddenLiterals = stringList(raw.forbiddenLiterals ?? []);
      const placeholdersValid = requiredPlaceholders && requiredPlaceholders.every((item) => /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/.test(item));
      const literalsValid = forbiddenLiterals && forbiddenLiterals.every((item) => item.length <= 32 && !/[\u0000-\u001f]/.test(item));
      if (!key || key.length > 512 || !requiredPlaceholders || !placeholdersValid || !forbiddenLiterals || !literalsValid) { errors.push({ id: "currency-rule-fields-invalid", detail: `currencyRules[${index}] has invalid key, placeholders, or literals` }); continue; }
      if (keys.has(key)) { errors.push({ id: "currency-rule-duplicate", detail: `currency rule for ${key} is duplicated` }); continue; }
      keys.add(key); currencyRules.push({ key, requiredPlaceholders, forbiddenLiterals });
    }
  }

  if (errors.length || !referenceLocale || !catalogMode || !placeholderSyntaxes || !extraKeys || !fallback || !html) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, referenceLocale, catalogMode, locales: locales.sort((a, b) => a.id.localeCompare(b.id)), placeholderSyntaxes, extraKeys, fallback, html, currencyRules: currencyRules.sort((a, b) => a.key.localeCompare(b.key)) }, errors: [] };
}

/** @param {string} root @param {string} relative */
function readCatalog(root, relative) {
  const base = path.resolve(root), absolute = path.resolve(base, relative), rel = path.relative(base, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error("configured locale path escaped repository root");
  let stat; try { stat = fs.lstatSync(absolute); } catch { throw new Error(`locale file is missing: ${relative}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`locale file must be a regular non-symlink file: ${relative}`);
  if (stat.size > MAX_CATALOG_BYTES) throw new Error(`locale file exceeds bounded size: ${relative}`);
  const buffer = fs.readFileSync(absolute);
  if (buffer.includes(0)) throw new Error(`locale file must be UTF-8 JSON text: ${relative}`);
  let value; try { value = JSON.parse(buffer.toString("utf8")); } catch { throw new Error(`locale file cannot be parsed as JSON: ${relative}`); }
  if (!object(value)) throw new Error(`locale root must be a JSON object: ${relative}`);
  return value;
}

/** @param {Record<string,unknown>} value @param {"flat"|"nested"} mode */
function flattenCatalog(value, mode) {
  /** @type {Map<string,string>} */ const out = new Map();
  if (mode === "flat") {
    for (const key of Object.keys(value).sort()) {
      if (!key || key.length > 512 || /[\u0000-\u001f]/.test(key) || typeof value[key] !== "string") throw new Error("flat locale catalogs require bounded top-level string keys and values");
      out.set(key, /** @type {string} */ (value[key]));
    }
    return out;
  }
  /** @param {unknown} current @param {string[]} parts */
  function visit(current, parts) {
    if (typeof current === "string") { if (parts.length === 0) throw new Error("nested locale catalog cannot have a string root"); out.set(parts.join("."), current); return; }
    if (!object(current)) throw new Error("nested locale catalogs require object nodes and string leaves");
    const keys = Object.keys(current).sort();
    if (keys.length === 0) throw new Error("nested locale catalogs cannot contain empty objects");
    for (const key of keys) {
      if (!key || key.includes(".") || key.length > 128 || /[\u0000-\u001f]/.test(key)) throw new Error("nested locale key segments must be bounded and cannot contain dots");
      visit(current[key], [...parts, key]);
    }
  }
  visit(value, []);
  return out;
}

/** @param {string} value @param {string[]} syntaxes */
function placeholders(value, syntaxes) {
  const found = [];
  if (syntaxes.includes("double-brace")) for (const match of value.matchAll(/[{][{][ ]*([A-Za-z_][A-Za-z0-9_.-]{0,63})[ ]*[}][}]/g)) if (match[1]) found.push(`double-brace:${match[1]}`);
  if (syntaxes.includes("percent-brace")) for (const match of value.matchAll(/[%][{][ ]*([A-Za-z_][A-Za-z0-9_.-]{0,63})[ ]*[}]/g)) if (match[1]) found.push(`percent-brace:${match[1]}`);
  if (syntaxes.includes("brace")) for (const match of value.replace(/[{][{][^}]*[}][}]/g, "").replace(/[%][{][^}]*[}]/g, "").matchAll(/[{][ ]*([A-Za-z_][A-Za-z0-9_.-]{0,63})[ ]*[}]/g)) if (match[1]) found.push(`brace:${match[1]}`);
  return found.sort();
}
/** @param {string[]} a @param {string[]} b */
function sameStrings(a, b) { return a.length === b.length && a.every((value, index) => value === b[index]); }
/** @param {string} value */
function hasHtml(value) { return /<\/?[A-Za-z][^>]*>/.test(value); }

/** @param {string} root @param {any} policy */
export function inspectLocalizationCompleteness(root, policy) {
  const catalogs = new Map();
  for (const locale of policy.locales) catalogs.set(locale.id, flattenCatalog(readCatalog(root, locale.file), policy.catalogMode));
  const reference = catalogs.get(policy.referenceLocale);
  if (!reference) throw new Error("reference locale catalog is unavailable");
  /** @type {Array<any>} */ const checks = [];
  /** @param {string} id @param {string} status @param {string|null} locale @param {string|null} key @param {string} detail */
  const finding = (id, status, locale, key, detail) => { if (status !== "IGNORE") checks.push({ id, status, locale, key, detail }); };
  const referenceKeys = [...reference.keys()].sort();
  const referenceSet = new Set(referenceKeys);

  for (const [localeId, catalog] of catalogs) {
    const localeKeys = [...catalog.keys()].sort(), localeSet = new Set(localeKeys);
    for (const key of referenceKeys) if (!localeSet.has(key)) finding("translation-key-missing", "FAIL", localeId, key, "reference key is missing from locale catalog");
    for (const key of localeKeys) if (!referenceSet.has(key)) finding("translation-key-extra", policy.extraKeys.severity, localeId, key, "locale contains a key absent from the reference catalog; code-level usage is audited separately by orphan detection");
    for (const key of localeKeys) {
      const value = catalog.get(key);
      if (value === undefined) continue;
      if (value.trim().length === 0) finding("translation-empty", "FAIL", localeId, key, "translation value is empty");
      if (hasHtml(value) && !policy.html.allowKeys.includes(key)) finding("translation-html-present", policy.html.severity, localeId, key, "translation contains an HTML-like tag outside the configured allowlist");
      const referenceValue = reference.get(key);
      if (referenceValue !== undefined) {
        const expected = placeholders(referenceValue, policy.placeholderSyntaxes), actual = placeholders(value, policy.placeholderSyntaxes);
        if (!sameStrings(expected, actual)) finding("placeholder-mismatch", "FAIL", localeId, key, `placeholder set differs from reference (${expected.length} expected, ${actual.length} present)`);
        if (localeId !== policy.referenceLocale && policy.fallback.severity !== "IGNORE" && !policy.fallback.allowKeys.includes(key) && referenceValue.trim().length >= policy.fallback.minimumLength && value.trim() === referenceValue.trim()) finding("fallback-identical-to-reference", policy.fallback.severity, localeId, key, "translation is identical to reference locale text and may be fallback leakage");
      }
    }
  }

  for (const rule of policy.currencyRules) {
    if (!referenceSet.has(rule.key)) { finding("currency-rule-key-missing", "FAIL", policy.referenceLocale, rule.key, "currency rule references a key absent from the reference catalog"); continue; }
    for (const [localeId, catalog] of catalogs) {
      const value = catalog.get(rule.key);
      if (value === undefined) continue;
      const actual = placeholders(value, policy.placeholderSyntaxes);
      const actualNames = actual.map((token) => token.slice(token.indexOf(":") + 1));
      const missing = rule.requiredPlaceholders.filter((/** @type {string} */ placeholder) => !actualNames.includes(placeholder));
      if (missing.length > 0) finding("currency-placeholder-missing", "FAIL", localeId, rule.key, `${missing.length} required currency formatting placeholder(s) are absent`);
      if (rule.forbiddenLiterals.some((/** @type {string} */ literal) => value.includes(literal))) finding("currency-literal-present", "FAIL", localeId, rule.key, "translation contains a configured literal currency token instead of runtime formatting");
    }
  }

  if (checks.length === 0) checks.push({ id: "localization-complete", status: "PASS", locale: null, key: null, detail: "configured locale catalogs are structurally aligned" });
  const summary = { pass: checks.filter((item) => item.status === "PASS").length, warn: checks.filter((item) => item.status === "WARN").length, fail: checks.filter((item) => item.status === "FAIL").length };
  return { referenceLocale: policy.referenceLocale, catalogMode: policy.catalogMode, locales: [...catalogs.keys()].sort(), referenceKeys: referenceKeys.length, checks, summary, technicalStatus: "PASS", overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS" };
}

/** @param {ReturnType<typeof inspectLocalizationCompleteness>} report */
export function formatLocalizationCompleteness(report) {
  const lines = ["Localization completeness audit", "", `Reference locale: ${report.referenceLocale}`, `Catalog mode: ${report.catalogMode}`, `Locales: ${report.locales.join(", ")}`, `Reference keys: ${report.referenceKeys}`, ""];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.locale ?? "(all)"}  ${check.key ?? "(catalog)"}  ${check.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
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
  if (!options) { console.error("Usage: node scripts/audit-localization-completeness.js --root <repository> --policy <policy.json> [--json]"); return 1; }
  const rawPolicy = readJson(options.policyFile);
  if (!rawPolicy) { console.error("Localization policy cannot be read or parsed"); return 1; }
  const validated = validateLocalizationPolicy(rawPolicy);
  if (!validated.valid || !validated.policy) { console.error("Localization policy is invalid"); return 1; }
  try {
    const report = inspectLocalizationCompleteness(path.resolve(options.root), validated.policy);
    console.log(options.json ? JSON.stringify(report) : formatLocalizationCompleteness(report));
    return report.overallStatus === "FAIL" ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Localization completeness audit failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
