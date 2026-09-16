#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { calleeNameList, inspectTypeScriptCalls, sourcePathList } from "./typescript-call-evidence.js";

const CONTROL_NAMES = ["signatureVerification", "idempotency", "replayHandling", "eventOrdering", "retrySafety", "unknownEvents"];
const SEVERITIES = new Set(["FAIL", "WARN", "IGNORE"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const normalized = value.trim(); return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }

/** @param {unknown} raw @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function validateControl(raw, scope, errors) {
  if (!object(raw)) { errors.push({ id: "control-invalid", detail: `${scope} must be an object` }); return null; }
  unknown(raw, ["severity", "evidenceFiles", "callees"], "control", errors);
  const severity = text(raw.severity, 16);
  if (!severity || !SEVERITIES.has(severity)) { errors.push({ id: "control-severity-invalid", detail: `${scope}.severity must be FAIL WARN or IGNORE` }); return null; }
  const evidenceFiles = sourcePathList(raw.evidenceFiles, { minimum: severity === "IGNORE" ? 0 : 1, maximum: 128 });
  const callees = calleeNameList(raw.callees, { minimum: severity === "IGNORE" ? 0 : 1, maximum: 64 });
  if (!evidenceFiles || !callees || ((evidenceFiles.length === 0) !== (callees.length === 0)) || (severity !== "IGNORE" && (evidenceFiles.length === 0 || callees.length === 0))) {
    errors.push({ id: "control-evidence-invalid", detail: `${scope} must bind evidence files and callees unless explicitly IGNORE` });
    return null;
  }
  return { severity, evidenceFiles, callees };
}

/** @param {unknown} value */
export function validateWebhookSafetyPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "webhook safety policy must be an object" }] };
  unknown(value, ["version", "webhooks"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (!Array.isArray(value.webhooks) || value.webhooks.length === 0 || value.webhooks.length > 256) {
    errors.push({ id: "webhooks-invalid", detail: "webhooks must be a non-empty bounded array" });
    return { valid: false, policy: null, errors };
  }
  /** @type {Array<any>} */ const webhooks = [];
  const ids = new Set();
  for (const [index, raw] of value.webhooks.entries()) {
    if (!object(raw)) { errors.push({ id: "webhook-invalid", detail: `webhooks[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "handlerFiles", "controls"], "webhook", errors);
    const id = text(raw.id, 128);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || ids.has(id)) { errors.push({ id: "webhook-id-invalid", detail: `webhooks[${index}].id is invalid or duplicate` }); continue; }
    ids.add(id);
    const handlerFiles = sourcePathList(raw.handlerFiles, { minimum: 1, maximum: 128 });
    if (!handlerFiles) errors.push({ id: "handler-files-invalid", detail: `webhooks[${index}].handlerFiles is invalid` });
    if (!object(raw.controls)) { errors.push({ id: "controls-invalid", detail: `webhooks[${index}].controls must be an object` }); continue; }
    unknown(raw.controls, CONTROL_NAMES, "controls", errors);
    /** @type {Record<string, any>} */ const controls = {};
    for (const name of CONTROL_NAMES) {
      if (!(name in raw.controls)) { errors.push({ id: "control-missing", detail: `webhooks[${index}].controls.${name} must be explicitly configured` }); continue; }
      const control = validateControl(raw.controls[name], `webhooks[${index}].controls.${name}`, errors);
      if (control) controls[name] = control;
    }
    if (handlerFiles && CONTROL_NAMES.every((name) => controls[name])) webhooks.push({ id, handlerFiles, controls });
  }
  if (errors.length) return { valid: false, policy: null, errors };
  webhooks.sort((a, b) => a.id.localeCompare(b.id));
  return { valid: true, policy: { version: 1, webhooks }, errors: [] };
}

/** @param {string} root @param {any} policy */
export function inspectWebhookSafety(root, policy) {
  /** @type {Array<any>} */ const checks = [];
  /** @param {string} id @param {"PASS"|"WARN"|"FAIL"} status @param {string} webhook @param {string} control @param {string} detail */
  const add = (id, status, webhook, control, detail) => checks.push({ id, status, webhook, control, detail });
  for (const webhook of policy.webhooks) {
    let handlerInspectable = true;
    for (const file of webhook.handlerFiles) {
      const result = inspectTypeScriptCalls(root, file);
      if (!result.ok) { handlerInspectable = false; add("webhook-handler-uninspectable", "FAIL", webhook.id, "handler", `${file} is missing, symlinked, oversized, binary, or syntactically invalid`); }
    }
    for (const name of CONTROL_NAMES) {
      const control = webhook.controls[name];
      if (control.severity === "IGNORE") { add("webhook-control-ignored", "WARN", webhook.id, name, "control is explicitly not required by policy; no safety claim is made"); continue; }
      let inspectable = true, found = false;
      for (const file of control.evidenceFiles) {
        const result = inspectTypeScriptCalls(root, file);
        if (!result.ok) { inspectable = false; add("webhook-control-evidence-uninspectable", control.severity, webhook.id, name, `${file} cannot be safely parsed for control evidence`); continue; }
        if (control.callees.some((/** @type {string} */ callee) => result.calls.has(callee))) found = true;
      }
      if (inspectable && !found) add("webhook-control-missing", control.severity, webhook.id, name, "no configured control call is structurally present in the explicit evidence files");
      if (inspectable && found && handlerInspectable) add("webhook-control-present", "PASS", webhook.id, name, "configured control call is structurally present");
    }
  }
  const summary = { pass: checks.filter((item) => item.status === "PASS").length, warn: checks.filter((item) => item.status === "WARN").length, fail: checks.filter((item) => item.status === "FAIL").length };
  return { webhooks: policy.webhooks.length, controlsPerWebhook: CONTROL_NAMES.length, checks: checks.sort((a, b) => `${a.webhook}:${a.control}:${a.id}`.localeCompare(`${b.webhook}:${b.control}:${b.id}`)), summary, technicalStatus: "PASS", overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS", semantics: "AST call-presence evidence only; execution order, control-flow dominance, provider semantics, persistence guarantees, and retry behavior are not proven" };
}

/** @param {ReturnType<typeof inspectWebhookSafety>} report */
export function formatWebhookSafety(report) { const lines = ["Webhook safety audit", "", `Webhooks: ${report.webhooks}`, `Controls per webhook: ${report.controlsPerWebhook}`, `Semantics: ${report.semantics}`, ""]; for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.webhook}  ${check.control}  ${check.id}  ${check.detail}`); lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`); return lines.join("\n"); }
/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) { let root = null, policyFile = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--root", "--policy"].includes(arg ?? "")) return null; const value = argv[i + 1]; if (typeof value !== "string" || value.startsWith("--")) return null; i += 1; if (arg === "--root") { if (root) return null; root = value; } else { if (policyFile) return null; policyFile = value; } } return root && policyFile ? { root, policyFile, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/audit-webhook-safety.js --root <repository> --policy <webhook-safety-policy.json> [--json]"); return 1; } const rawPolicy = readJson(options.policyFile); if (!rawPolicy) { console.error("Webhook safety policy cannot be read or parsed"); return 1; } const validated = validateWebhookSafetyPolicy(rawPolicy); if (!validated.valid || !validated.policy) { console.error("Webhook safety policy is invalid"); return 1; } const root = path.resolve(options.root); let stat; try { stat = fs.lstatSync(root); } catch { console.error("Webhook repository is unavailable"); return 1; } if (!stat.isDirectory() || stat.isSymbolicLink()) { console.error("Webhook repository must be a regular directory"); return 1; } const report = inspectWebhookSafety(root, validated.policy); console.log(options.json ? JSON.stringify(report) : formatWebhookSafety(report)); return report.overallStatus === "FAIL" ? 1 : 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
