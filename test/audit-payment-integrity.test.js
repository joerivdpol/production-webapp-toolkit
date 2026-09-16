import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatPaymentIntegrity, inspectPaymentIntegrity, main, validatePaymentIntegrityPolicy } from "../scripts/audit-payment-integrity.js";
import { validateWebhookSafetyPolicy } from "../scripts/audit-webhook-safety.js";

const NAMES = ["idempotency", "providerBinding", "amountIntegrity", "currencyIntegrity", "refundLinkage", "captureState", "reconciliation"];
/** @returns {Record<string,string>} */
function calls() { return { idempotency: "persistIdempotency", providerBinding: "persistProviderBinding", amountIntegrity: "persistAmount", currencyIntegrity: "persistCurrency", refundLinkage: "linkRefund", captureState: "transitionCapture", reconciliation: "enqueueReconciliation" }; }
/** @returns {any} */
function rawPaymentPolicy() {
  const names = calls();
  /** @type {Record<string,any>} */ const controls = {};
  for (const name of NAMES) controls[name] = { severity: "FAIL", evidenceFiles: ["src/payments/create.ts"], callees: [names[name]] };
  return { version: 1, payments: [{ id: "payment-create", providerRequest: { operationFiles: ["src/payments/create.ts"], callees: ["provider.createPayment"] }, controls, webhookVerification: { severity: "FAIL", webhookIds: ["payment-webhook"] } }] };
}
/** @returns {any} */
function rawWebhookPolicy() {
  const names = { signatureVerification: "verifyWebhookSignature", idempotency: "claimEvent", replayHandling: "rejectReplay", eventOrdering: "enforceEventOrder", retrySafety: "scheduleRetry", unknownEvents: "handleUnknownEvent" };
  /** @type {Record<string,any>} */ const controls = {};
  for (const [name, callee] of Object.entries(names)) controls[name] = { severity: "FAIL", evidenceFiles: ["src/webhooks/payment.ts"], callees: [callee] };
  return { version: 1, webhooks: [{ id: "payment-webhook", handlerFiles: ["src/webhooks/payment.ts"], controls }] };
}
function paymentPolicy(raw = rawPaymentPolicy()) { const result = validatePaymentIntegrityPolicy(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("payment policy invalid"); return result.policy; }
function webhookPolicy(raw = rawWebhookPolicy()) { const result = validateWebhookSafetyPolicy(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("webhook policy invalid"); return result.policy; }
/** @param {{payment?:string,webhook?:string,helper?:string}} [content] */
function repository(content = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "payment-integrity-"));
  fs.mkdirSync(path.join(root, "src/payments"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/webhooks"), { recursive: true });
  const c = calls();
  const normalPayment = `export async function create(input) { ${c.idempotency}(input); ${c.providerBinding}(input); ${c.amountIntegrity}(input); ${c.currencyIntegrity}(input); const remote = await provider.createPayment(input); ${c.refundLinkage}(remote); ${c.captureState}(remote); ${c.reconciliation}(remote); return remote; }\n`;
  const normalWebhook = "export function webhook(event) { verifyWebhookSignature(event); claimEvent(event); rejectReplay(event); enforceEventOrder(event); scheduleRetry(event); handleUnknownEvent(event); return processEvent(event); }\n";
  fs.writeFileSync(path.join(root, "src/payments/create.ts"), content.payment ?? normalPayment);
  fs.writeFileSync(path.join(root, "src/webhooks/payment.ts"), content.webhook ?? normalWebhook);
  if (content.helper !== undefined) fs.writeFileSync(path.join(root, "src/payments/helper.ts"), content.helper);
  return root;
}
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("policy requires every generic payment control and provider request identity", () => {
  const result = validatePaymentIntegrityPolicy(rawPaymentPolicy());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) return;
  assert.deepEqual(Object.keys(result.policy.payments[0].controls).sort(), [...NAMES].sort());
  const missing = rawPaymentPolicy(); delete missing.payments[0].controls.amountIntegrity;
  assert.equal(validatePaymentIntegrityPolicy(missing).valid, false);
});
test("complete payment orchestration and verified webhook pass", () => {
  const root = repository();
  const report = inspectPaymentIntegrity(root, paymentPolicy(), webhookPolicy());
  assert.equal(report.overallStatus, "PASS");
  for (const name of ["idempotency", "providerBinding", "amountIntegrity", "currencyIntegrity"]) assert.equal(report.checks.some((item) => item.id === "payment-control-pre-provider" && item.control === name), true);
  assert.equal(report.checks.some((item) => item.id === "payment-webhook-verification-present"), true);
  assert.match(report.semantics, /atomicity.*not proven/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("amount and currency controls after provider call fail ordering evidence", () => {
  const c = calls();
  const source = `export function create(input) { ${c.idempotency}(input); ${c.providerBinding}(input); provider.createPayment(input); ${c.amountIntegrity}(input); ${c.currencyIntegrity}(input); ${c.refundLinkage}(input); ${c.captureState}(input); ${c.reconciliation}(input); }\n`;
  const root = repository({ payment: source });
  const report = inspectPaymentIntegrity(root, paymentPolicy(), webhookPolicy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "payment-control-ordering-unverified" && item.control === "amountIntegrity"), true);
  assert.equal(report.checks.some((item) => item.id === "payment-control-ordering-unverified" && item.control === "currencyIntegrity"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("disconnected helper presence cannot prove pre-provider ordering", () => {
  const c = calls();
  const payment = `export function create(input) { ${c.idempotency}(input); ${c.providerBinding}(input); ${c.currencyIntegrity}(input); provider.createPayment(input); ${c.refundLinkage}(input); ${c.captureState}(input); ${c.reconciliation}(input); }\n`;
  const root = repository({ payment, helper: `export function persist(input) { ${c.amountIntegrity}(input); }\n` });
  const raw = rawPaymentPolicy(); raw.payments[0].controls.amountIntegrity.evidenceFiles = ["src/payments/helper.ts"];
  const report = inspectPaymentIntegrity(root, paymentPolicy(raw), webhookPolicy());
  assert.equal(report.checks.some((item) => item.id === "payment-control-ordering-unverified" && item.control === "amountIntegrity"), true);
  fs.rmSync(root, { recursive: true, force: true });
});
test("every provider request occurrence needs prior pre-provider controls", () => {
  const c = calls();
  const source = `export function create(input) { provider.createPayment(input); ${c.idempotency}(input); ${c.providerBinding}(input); ${c.amountIntegrity}(input); ${c.currencyIntegrity}(input); provider.createPayment(input); ${c.refundLinkage}(input); ${c.captureState}(input); ${c.reconciliation}(input); }\n`;
  const root = repository({ payment: source });
  const report = inspectPaymentIntegrity(root, paymentPolicy(), webhookPolicy());
  assert.equal(report.checks.some((item) => item.id === "payment-control-ordering-unverified" && item.control === "idempotency"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing provider request is blocking", () => {
  const c = calls();
  const source = `export function create(input) { ${c.idempotency}(input); ${c.providerBinding}(input); ${c.amountIntegrity}(input); ${c.currencyIntegrity}(input); ${c.refundLinkage}(input); ${c.captureState}(input); ${c.reconciliation}(input); }\n`;
  const root = repository({ payment: source });
  const report = inspectPaymentIntegrity(root, paymentPolicy(), webhookPolicy());
  assert.equal(report.checks.some((item) => item.id === "provider-request-missing"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("refund capture and reconciliation remain explicit structural controls", () => {
  const c = calls();
  const source = `export function create(input) { ${c.idempotency}(input); ${c.providerBinding}(input); ${c.amountIntegrity}(input); ${c.currencyIntegrity}(input); provider.createPayment(input); }\n`;
  const root = repository({ payment: source });
  const report = inspectPaymentIntegrity(root, paymentPolicy(), webhookPolicy());
  for (const name of ["refundLinkage", "captureState", "reconciliation"]) assert.equal(report.checks.some((item) => item.id === "payment-control-missing" && item.control === name), true);
  fs.rmSync(root, { recursive: true, force: true });
});
test("webhook verification composes with canonical webhook signature evidence", () => {
  const root = repository();
  const noWebhook = inspectPaymentIntegrity(root, paymentPolicy(), null);
  assert.equal(noWebhook.checks.some((item) => item.id === "payment-webhook-policy-missing"), true);
  const wrong = rawWebhookPolicy(); wrong.webhooks[0].controls.signatureVerification.callees = ["differentVerifier"];
  const report = inspectPaymentIntegrity(root, paymentPolicy(), webhookPolicy(wrong));
  assert.equal(report.checks.some((item) => item.id === "payment-webhook-verification-missing"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("unrelated webhook warning does not erase proven signature evidence", () => {
  const root = repository({ webhook: "export function webhook(event) { verifyWebhookSignature(event); claimEvent(event); rejectReplay(event); scheduleRetry(event); handleUnknownEvent(event); }\n" });
  const raw = rawWebhookPolicy(); raw.webhooks[0].controls.eventOrdering.severity = "WARN";
  const report = inspectPaymentIntegrity(root, paymentPolicy(), webhookPolicy(raw));
  assert.equal(report.checks.some((item) => item.id === "payment-webhook-verification-present"), true);
  assert.equal(report.overallStatus, "PASS");
  fs.rmSync(root, { recursive: true, force: true });
});

test("ignored optional payment control stays visible and unproven", () => {
  const raw = rawPaymentPolicy(); raw.payments[0].controls.refundLinkage = { severity: "IGNORE", evidenceFiles: [], callees: [] };
  const root = repository();
  const report = inspectPaymentIntegrity(root, paymentPolicy(raw), webhookPolicy());
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "payment-control-ignored" && item.control === "refundLinkage"), true);
  fs.rmSync(root, { recursive: true, force: true });
});
test("policy rejects unsafe paths severity duplicates and malformed webhook binding", () => {
  const unsafe = rawPaymentPolicy(); unsafe.payments[0].providerRequest.operationFiles = ["../payment.ts"];
  assert.equal(validatePaymentIntegrityPolicy(unsafe).valid, false);
  const severity = rawPaymentPolicy(); severity.payments[0].controls.captureState.severity = "BLOCK";
  assert.equal(validatePaymentIntegrityPolicy(severity).valid, false);
  const duplicate = rawPaymentPolicy(); duplicate.payments.push(structuredClone(duplicate.payments[0]));
  assert.equal(validatePaymentIntegrityPolicy(duplicate).valid, false);
  const webhook = rawPaymentPolicy(); webhook.payments[0].webhookVerification.webhookIds = [];
  assert.equal(validatePaymentIntegrityPolicy(webhook).valid, false);
});

test("human report never emits payment source payload", () => {
  const marker = "UNIQUE_PAYMENT_PAYLOAD_509";
  const c = calls();
  const source = `export function create(input) { const marker = "${marker}"; ${c.idempotency}(input); ${c.providerBinding}(input); ${c.amountIntegrity}(input); ${c.currencyIntegrity}(input); provider.createPayment(input); }\n`;
  const root = repository({ payment: source });
  const output = formatPaymentIntegrity(inspectPaymentIntegrity(root, paymentPolicy(), webhookPolicy()));
  assert.match(output, /Payment integrity audit/);
  assert.doesNotMatch(output, new RegExp(marker));
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI emits JSON for PASS and fails when webhook policy is absent", () => {
  const root = repository(), paymentFile = tempJson("payment-policy", rawPaymentPolicy()), webhookFile = tempJson("payment-webhook", rawWebhookPolicy());
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", paymentFile, "--webhook-policy", webhookFile, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  assert.equal(main(["--root", root, "--policy", paymentFile]), 1);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(paymentFile, { force: true }); fs.rmSync(webhookFile, { force: true });
});

test("CLI rejects malformed inputs and unknown options", () => {
  const malformed = tempJson("payment-bad", "{");
  assert.equal(main(["--root", "/tmp/missing-payment-repo", "--policy", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("payment audit reuses ordered AST and webhook safety without network or mutation", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-payment-integrity.js", import.meta.url), "utf8");
  const helper = fs.readFileSync(new URL("../scripts/typescript-call-evidence.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /inspectWebhookSafety/);
  assert.match(helper, /orderedCalls/);
});
