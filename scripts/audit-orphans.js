#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ORPHAN_KINDS, validateOrphanEvidence } from "./orphan-evidence.js";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value @returns {string|null} */
function text(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
/** @param {unknown} value @returns {string|null} */
function safePath(value) {
  const v = text(value);
  return v && v.length <= 512 && !v.startsWith("/") && !v.includes("\\") &&
    !v.includes("\0") && !v.split("/").includes("..") ? v : null;
}
/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateOrphanPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "orphan policy must be an object" }] };
  unknown(value, ["version", "repository", "rules", "exceptions"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const repository = text(value.repository);
  if (!repository || repository.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)) {
    errors.push({ id: "repository-invalid", detail: "repository must be a portable identifier" });
  }

  const rules = [];
  const ruleKeys = new Set();
  if (!Array.isArray(value.rules) || value.rules.length === 0) {
    errors.push({ id: "rules-invalid", detail: "rules must be a non-empty array" });
  } else for (const [index, raw] of value.rules.entries()) {
    if (!object(raw)) {
      errors.push({ id: "rule-invalid", detail: `rules[${index}] must be an object` });
      continue;
    }
    unknown(raw, ["scanner", "kind", "metric", "minimumReferences", "orphanStatus", "requireItems"], "rule", errors);
    const scanner = text(raw.scanner), kind = text(raw.kind), metric = text(raw.metric), orphanStatus = text(raw.orphanStatus);
    const valid = scanner && scanner.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scanner) &&
      kind && ORPHAN_KINDS.includes(kind) && ["total", "external"].includes(metric ?? "") &&
      Number.isSafeInteger(raw.minimumReferences) && Number(raw.minimumReferences) >= 1 && Number(raw.minimumReferences) <= 100000 &&
      ["WARN", "FAIL"].includes(orphanStatus ?? "") && typeof raw.requireItems === "boolean";
    if (!valid) {
      errors.push({ id: "rule-fields-invalid", detail: `rules[${index}] has invalid fields` });
      continue;
    }
    const key = `${scanner}:${kind}`;
    if (ruleKeys.has(key)) {
      errors.push({ id: "rule-duplicate", detail: `scanner ${scanner} and kind ${kind} are configured more than once` });
      continue;
    }
    ruleKeys.add(key);
    rules.push({ scanner, kind, metric, minimumReferences: Number(raw.minimumReferences), orphanStatus, requireItems: raw.requireItems });
  }

  const exceptions = [];
  const exceptionKeys = new Set();
  if (value.exceptions !== undefined) {
    if (!Array.isArray(value.exceptions)) errors.push({ id: "exceptions-invalid", detail: "exceptions must be an array" });
    else for (const [index, raw] of value.exceptions.entries()) {
      if (!object(raw)) {
        errors.push({ id: "exception-invalid", detail: `exceptions[${index}] must be an object` });
        continue;
      }
      unknown(raw, ["scanner", "kind", "id", "declarationPath", "reason"], "exception", errors);
      const scanner = text(raw.scanner), kind = text(raw.kind), id = text(raw.id);
      const declarationPath = safePath(raw.declarationPath), reason = text(raw.reason);
      const valid = scanner && kind && ORPHAN_KINDS.includes(kind) && id && id.length <= 512 && declarationPath && reason && reason.length <= 512;
      if (!valid) {
        errors.push({ id: "exception-fields-invalid", detail: `exceptions[${index}] has invalid fields` });
        continue;
      }
      const key = `${scanner}:${kind}:${id}:${declarationPath}`;
      if (exceptionKeys.has(key)) {
        errors.push({ id: "exception-duplicate", detail: "exceptions contains a duplicate selector" });
        continue;
      }
      exceptionKeys.add(key);
      exceptions.push({ scanner, kind, id, declarationPath, reason });
    }
  }

  if (errors.length || !repository) return { valid: false, policy: null, errors };
  rules.sort((a, b) => `${a.scanner}:${a.kind}`.localeCompare(`${b.scanner}:${b.kind}`));
  exceptions.sort((a, b) => `${a.scanner}:${a.kind}:${a.id}:${a.declarationPath}`.localeCompare(`${b.scanner}:${b.kind}:${b.id}:${b.declarationPath}`));
  return { valid: true, policy: { version: 1, repository, rules, exceptions }, errors: [] };
}

/** @param {any} evidence @param {any} policy */
export function inspectOrphans(evidence, policy) {
  const checks = [];
  if (evidence.repository.name !== policy.repository) {
    return {
      checks: [{ id: "repository-mismatch", status: "FAIL", scanner: "evidence", kind: "evidence", item: null, detail: "evidence belongs to a different repository identity" }],
      summary: { pass: 0, warn: 0, fail: 1 },
      technicalStatus: "PASS",
      overallStatus: "FAIL",
    };
  }

  const exceptionMap = new Map(policy.exceptions.map((/** @type {any} */ item) => [`${item.scanner}:${item.kind}:${item.id}:${item.declarationPath}`, item]));
  const matchedExceptions = new Set();
  const configuredKeys = new Set(policy.rules.map((/** @type {any} */ rule) => `${rule.scanner}:${rule.kind}`));

  for (const rule of policy.rules) {
    const candidates = evidence.items.filter((/** @type {any} */ item) => item.scanner === rule.scanner && item.kind === rule.kind);
    if (candidates.length === 0) {
      checks.push({ id: "scanner-empty", status: rule.requireItems ? "FAIL" : "WARN", scanner: rule.scanner, kind: rule.kind, item: null, detail: "scanner produced no declaration items" });
      continue;
    }
    for (const item of candidates) {
      const count = item.references[rule.metric];
      const outputItem = { id: item.id, declarationPath: item.declaration.path, references: count };
      if (count >= rule.minimumReferences) {
        checks.push({ id: "item-referenced", status: "PASS", scanner: rule.scanner, kind: rule.kind, item: outputItem, detail: `${rule.metric} references ${count} meet minimum ${rule.minimumReferences}` });
        continue;
      }
      const exceptionKey = `${item.scanner}:${item.kind}:${item.id}:${item.declaration.path}`;
      const exception = exceptionMap.get(exceptionKey);
      if (exception) {
        matchedExceptions.add(exceptionKey);
        checks.push({ id: "orphan-exempted", status: "WARN", scanner: rule.scanner, kind: rule.kind, item: outputItem, detail: `below minimum ${rule.minimumReferences}; explicit exception: ${exception.reason}` });
        continue;
      }
      checks.push({ id: "orphan-detected", status: rule.orphanStatus, scanner: rule.scanner, kind: rule.kind, item: outputItem, detail: `${rule.metric} references ${count} are below minimum ${rule.minimumReferences}` });
    }
  }

  const unconfigured = new Set(evidence.items.map((/** @type {any} */ item) => `${item.scanner}:${item.kind}`).filter((/** @type {string} */ key) => !configuredKeys.has(key)));
  for (const key of [...unconfigured].sort()) {
    const separator = key.lastIndexOf(":");
    const scanner = key.slice(0, separator), kind = key.slice(separator + 1);
    checks.push({ id: "scanner-unconfigured", status: "WARN", scanner, kind, item: null, detail: "evidence scanner has no audit rule" });
  }

  for (const exception of policy.exceptions) {
    const key = `${exception.scanner}:${exception.kind}:${exception.id}:${exception.declarationPath}`;
    if (!matchedExceptions.has(key)) {
      checks.push({ id: "exception-stale", status: "WARN", scanner: exception.scanner, kind: exception.kind, item: { id: exception.id, declarationPath: exception.declarationPath, references: null }, detail: "configured exception did not suppress an orphan in this evidence" });
    }
  }

  const summary = {
    pass: checks.filter((item) => item.status === "PASS").length,
    warn: checks.filter((item) => item.status === "WARN").length,
    fail: checks.filter((item) => item.status === "FAIL").length,
  };
  return { checks, summary, technicalStatus: "PASS", overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS" };
}

/** @param {ReturnType<typeof inspectOrphans>} report */
export function formatOrphanAudit(report) {
  const lines = ["Dead code and orphan audit", ""];
  for (const check of report.checks) {
    const item = check.item ? `${check.item.declarationPath}:${check.item.id}` : "(scanner)";
    lines.push(`${check.status.padEnd(4)}  ${check.kind}  ${check.scanner}  ${item}  ${check.detail}`);
  }
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string} file */
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}
/** @param {string[]} argv */
function parse(argv) {
  let evidenceFile = null, policyFile = null, json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") { json = true; continue; }
    if (!["--evidence-file", "--policy"].includes(arg ?? "")) return null;
    const value = argv[i + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    i += 1;
    if (arg === "--evidence-file") { if (evidenceFile) return null; evidenceFile = value; }
    else { if (policyFile) return null; policyFile = value; }
  }
  return evidenceFile && policyFile ? { evidenceFile, policyFile, json } : null;
}
export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) {
    console.error("Usage: node scripts/audit-orphans.js --evidence-file <orphan-evidence.json> --policy <policy.json> [--json]");
    return 1;
  }
  const rawEvidence = readJson(options.evidenceFile), rawPolicy = readJson(options.policyFile);
  if (!rawEvidence) { console.error("Orphan evidence cannot be read or parsed"); return 1; }
  if (!rawPolicy) { console.error("Orphan policy cannot be read or parsed"); return 1; }
  const evidenceResult = validateOrphanEvidence(rawEvidence), policyResult = validateOrphanPolicy(rawPolicy);
  if (!evidenceResult.valid || !evidenceResult.evidence) { console.error("Orphan evidence is invalid"); return 1; }
  if (!policyResult.valid || !policyResult.policy) { console.error("Orphan policy is invalid"); return 1; }
  const report = inspectOrphans(evidenceResult.evidence, policyResult.policy);
  console.log(options.json ? JSON.stringify(report) : formatOrphanAudit(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
