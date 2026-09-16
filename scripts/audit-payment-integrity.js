#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inspectTypeScriptCalls, sourcePathList, calleeNameList } from "./typescript-call-evidence.js";
import { inspectWebhookSafety, validateWebhookSafetyPolicy } from "./audit-webhook-safety.js";

const CONTROL_NAMES = ["idempotency", "providerBinding", "amountIntegrity", "currencyIntegrity", "refundLinkage", "captureState", "reconciliation"];
const PRE_PROVIDER_CONTROLS = new Set(["idempotency", "providerBinding", "amountIntegrity", "currencyIntegrity"]);
const SEVERITIES = new Set(["FAIL", "WARN", "IGNORE"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const normalized = value.trim(); return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function staticControl(value, scope, errors) {
  if (!object(value)) { errors.push({ id: "control-invalid", detail: `${scope} must be an object` }); return null; }
  unknown(value, ["severity", "evidenceFiles", "callees"], "control", errors);
  const severity = text(value.severity, 16);
  if (!severity || !SEVERITIES.has(severity)) { errors.push({ id: "control-severity-invalid", detail: `${scope}.severity must be FAIL WARN or IGNORE` }); return null; }
  const evidenceFiles = sourcePathList(value.evidenceFiles, { minimum: severity === "IGNORE" ? 0 : 1, maximum: 128 });
  const callees = calleeNameList(value.callees, { minimum: severity === "IGNORE" ? 0 : 1, maximum: 64 });
  if (!evidenceFiles || !callees || ((evidenceFiles.length === 0) !== (callees.length === 0)) || (severity !== "IGNORE" && evidenceFiles.length === 0)) { errors.push({ id: "control-evidence-invalid", detail: `${scope} requires evidence files and callees unless explicitly IGNORE` }); return null; }
  return { severity, evidenceFiles, callees };
}
/** @param {unknown} value @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function webhookControl(value, scope, errors) {
  if (!object(value)) { errors.push({ id: "webhook-control-invalid", detail: `${scope} must be an object` }); return null; }
  unknown(value, ["severity", "webhookIds"], "webhook-verification", errors);
  const severity = text(value.severity, 16);
  if (!severity || !SEVERITIES.has(severity)) { errors.push({ id: "webhook-severity-invalid", detail: `${scope}.severity is invalid` }); return null; }
  if (!Array.isArray(value.webhookIds) || value.webhookIds.length > 64 || (severity !== "IGNORE" && value.webhookIds.length === 0)) { errors.push({ id: "webhook-ids-invalid", detail: `${scope}.webhookIds must be explicitly configured` }); return null; }
  const ids = value.webhookIds.map((item) => text(item, 128));
  if (ids.some((item) => !item || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(/** @type {string} */ (item))) || new Set(ids).size !== ids.length) { errors.push({ id: "webhook-ids-invalid", detail: `${scope}.webhookIds contains invalid or duplicate ids` }); return null; }
  return { severity, webhookIds: /** @type {string[]} */ (ids).sort() };
}

/** @param {unknown} value */
export function validatePaymentIntegrityPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "payment integrity policy must be an object" }] };
  unknown(value, ["version", "payments"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (!Array.isArray(value.payments) || value.payments.length === 0 || value.payments.length > 256) { errors.push({ id: "payments-invalid", detail: "payments must be a non-empty bounded array" }); return { valid: false, policy: null, errors }; }
  /** @type {Array<any>} */ const payments = [];
  const ids = new Set();
  for (const [index, raw] of value.payments.entries()) {
    if (!object(raw)) { errors.push({ id: "payment-invalid", detail: `payments[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "providerRequest", "controls", "webhookVerification"], "payment", errors);
    const id = text(raw.id, 128);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || ids.has(id)) { errors.push({ id: "payment-id-invalid", detail: `payments[${index}].id is invalid or duplicate` }); continue; }
    ids.add(id);
    let providerRequest = null;
    if (!object(raw.providerRequest)) errors.push({ id: "provider-request-invalid", detail: `payments[${index}].providerRequest must be an object` });
    else {
      unknown(raw.providerRequest, ["operationFiles", "callees"], "provider-request", errors);
      const operationFiles = sourcePathList(raw.providerRequest.operationFiles, { minimum: 1, maximum: 128 });
      const callees = calleeNameList(raw.providerRequest.callees, { minimum: 1, maximum: 64 });
      if (!operationFiles || !callees) errors.push({ id: "provider-request-fields-invalid", detail: `payments[${index}].providerRequest requires operationFiles and callees` });
      else providerRequest = { operationFiles, callees };
    }
    if (!object(raw.controls)) { errors.push({ id: "controls-invalid", detail: `payments[${index}].controls must be an object` }); continue; }
    unknown(raw.controls, CONTROL_NAMES, "controls", errors);
    /** @type {Record<string,any>} */ const controls = {};
    for (const name of CONTROL_NAMES) {
      if (!(name in raw.controls)) { errors.push({ id: "control-missing", detail: `payments[${index}].controls.${name} must be explicitly configured` }); continue; }
      const control = staticControl(raw.controls[name], `payments[${index}].controls.${name}`, errors); if (control) controls[name] = control;
    }
    const verification = webhookControl(raw.webhookVerification, `payments[${index}].webhookVerification`, errors);
    if (providerRequest && verification && CONTROL_NAMES.every((name) => controls[name])) payments.push({ id, providerRequest, controls, webhookVerification: verification });
  }
  if (errors.length) return { valid: false, policy: null, errors };
  payments.sort((a, b) => a.id.localeCompare(b.id));
  return { valid: true, policy: { version: 1, payments }, errors: [] };
}

/** @param {string} root @param {any} policy @param {any|null} webhookPolicy */
export function inspectPaymentIntegrity(root, policy, webhookPolicy) {
  /** @type {Array<any>} */ const checks = [];
  /** @param {string} id @param {"PASS"|"WARN"|"FAIL"} status @param {string} payment @param {string} control @param {string} detail */
  const add = (id, status, payment, control, detail) => checks.push({ id, status, payment, control, detail });
  const cache = new Map();
  /** @param {string} file */
  function inspect(file) { if (!cache.has(file)) cache.set(file, inspectTypeScriptCalls(root, file)); return cache.get(file); }
  const webhookReport = webhookPolicy ? inspectWebhookSafety(root, webhookPolicy) : null;

  for (const payment of policy.payments) {
    /** @type {Array<{file:string,position:number}>} */ const providerCalls = [];
    for (const file of payment.providerRequest.operationFiles) {
      const result = inspect(file);
      if (!result.ok) { add("provider-request-file-uninspectable", "FAIL", payment.id, "providerRequest", `${file} cannot be safely parsed`); continue; }
      for (const call of result.orderedCalls) if (payment.providerRequest.callees.includes(call.name)) providerCalls.push({ file, position: call.position });
    }
    if (providerCalls.length === 0) add("provider-request-missing", "FAIL", payment.id, "providerRequest", "no configured provider request call is structurally present");
    else add("provider-request-present", "PASS", payment.id, "providerRequest", `${providerCalls.length} provider request call occurrence(s) are structurally present`);

    for (const name of CONTROL_NAMES) {
      const control = payment.controls[name];
      if (control.severity === "IGNORE") { add("payment-control-ignored", "WARN", payment.id, name, "control is explicitly not required by policy; no integrity claim is made"); continue; }
      let inspectable = true, found = false;
      for (const file of control.evidenceFiles) {
        const result = inspect(file);
        if (!result.ok) { inspectable = false; add("payment-control-evidence-uninspectable", control.severity, payment.id, name, `${file} cannot be safely parsed`); continue; }
        if (control.callees.some((/** @type {string} */ callee) => result.calls.has(callee))) found = true;
      }
      if (inspectable && !found) { add("payment-control-missing", control.severity, payment.id, name, "no configured control call is structurally present"); continue; }
      if (!inspectable || !found) continue;
      if (PRE_PROVIDER_CONTROLS.has(name)) {
        let allOrdered = providerCalls.length > 0;
        for (const provider of providerCalls) {
          const result = inspect(provider.file);
          const prior = result.ok && result.orderedCalls.some((/** @type {{name:string,position:number}} */ call) => control.callees.includes(call.name) && call.position < provider.position);
          if (!prior) { allOrdered = false; break; }
        }
        if (allOrdered) add("payment-control-pre-provider", "PASS", payment.id, name, "configured control call precedes every provider request occurrence in the explicit operation files");
        else add("payment-control-ordering-unverified", control.severity, payment.id, name, "control presence exists but pre-provider ordering is not proven for every provider request occurrence");
      } else add("payment-control-present", "PASS", payment.id, name, "configured control call is structurally present");
    }

    const verification = payment.webhookVerification;
    if (verification.severity === "IGNORE") add("payment-webhook-verification-ignored", "WARN", payment.id, "webhookVerification", "webhook verification is explicitly not required; no integrity claim is made");
    else if (!webhookReport) add("payment-webhook-policy-missing", verification.severity, payment.id, "webhookVerification", "webhook verification requires a validated Webhook Safety Policy v1");
    else {
      const verifiedIds = new Set(webhookReport.checks.filter((/** @type {any} */ check) => check.control === "signatureVerification" && check.id === "webhook-control-present" && check.status === "PASS").map((/** @type {any} */ check) => check.webhook));
      const missing = verification.webhookIds.filter((/** @type {string} */ id) => !verifiedIds.has(id));
      if (missing.length > 0) add("payment-webhook-verification-missing", verification.severity, payment.id, "webhookVerification", `${missing.length} required payment webhook signature verification binding(s) are not proven`);
      else add("payment-webhook-verification-present", "PASS", payment.id, "webhookVerification", "all required payment webhook ids have structural signature-verification evidence");
    }
  }
  const summary = { pass: checks.filter((item) => item.status === "PASS").length, warn: checks.filter((item) => item.status === "WARN").length, fail: checks.filter((item) => item.status === "FAIL").length };
  return { payments: policy.payments.length, checks: checks.sort((a, b) => `${a.payment}:${a.control}:${a.id}`.localeCompare(`${b.payment}:${b.control}:${b.id}`)), summary, technicalStatus: "PASS", overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS", semantics: "structural call and same-file source-order evidence only; atomicity, immutability, persisted values, provider behavior, database constraints, and runtime state transitions are not proven" };
}

/** @param {ReturnType<typeof inspectPaymentIntegrity>} report */
export function formatPaymentIntegrity(report) { const lines = ["Payment integrity audit", "", `Payments: ${report.payments}`, `Semantics: ${report.semantics}`, ""]; for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.payment}  ${check.control}  ${check.id}  ${check.detail}`); lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`); return lines.join("\n"); }
/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) { let root = null, policyFile = null, webhookFile = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--root", "--policy", "--webhook-policy"].includes(arg ?? "")) return null; const value = argv[i + 1]; if (typeof value !== "string" || value.startsWith("--")) return null; i += 1; if (arg === "--root") { if (root) return null; root = value; } else if (arg === "--policy") { if (policyFile) return null; policyFile = value; } else { if (webhookFile) return null; webhookFile = value; } } return root && policyFile ? { root, policyFile, webhookFile, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/audit-payment-integrity.js --root <repository> --policy <payment-policy.json> [--webhook-policy <webhook-policy.json>] [--json]"); return 1; } const rawPolicy = readJson(options.policyFile); if (!rawPolicy) { console.error("Payment integrity policy cannot be read or parsed"); return 1; } const validated = validatePaymentIntegrityPolicy(rawPolicy); if (!validated.valid || !validated.policy) { console.error("Payment integrity policy is invalid"); return 1; } let webhookPolicy = null; if (options.webhookFile) { const rawWebhook = readJson(options.webhookFile); if (!rawWebhook) { console.error("Webhook safety policy cannot be read or parsed"); return 1; } const webhookValidated = validateWebhookSafetyPolicy(rawWebhook); if (!webhookValidated.valid || !webhookValidated.policy) { console.error("Webhook safety policy is invalid"); return 1; } webhookPolicy = webhookValidated.policy; } const root = path.resolve(options.root); let stat; try { stat = fs.lstatSync(root); } catch { console.error("Payment repository is unavailable"); return 1; } if (!stat.isDirectory() || stat.isSymbolicLink()) { console.error("Payment repository must be a regular directory"); return 1; } const report = inspectPaymentIntegrity(root, validated.policy, webhookPolicy); console.log(options.json ? JSON.stringify(report) : formatPaymentIntegrity(report)); return report.overallStatus === "FAIL" ? 1 : 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
