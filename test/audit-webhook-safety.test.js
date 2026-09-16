import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatWebhookSafety, inspectWebhookSafety, main, validateWebhookSafetyPolicy } from "../scripts/audit-webhook-safety.js";

const CONTROLS = ["signatureVerification", "idempotency", "replayHandling", "eventOrdering", "retrySafety", "unknownEvents"];
/** @returns {Record<string,string>} */
function controlCalls() { return { signatureVerification: "verifyWebhookSignature", idempotency: "claimEvent", replayHandling: "rejectReplay", eventOrdering: "enforceEventOrder", retrySafety: "scheduleRetry", unknownEvents: "handleUnknownEvent" }; }
/** @returns {any} */
function rawPolicy() {
  const calls = controlCalls();
  /** @type {Record<string, any>} */ const controls = {};
  for (const name of CONTROLS) controls[name] = { severity: "FAIL", evidenceFiles: ["src/webhooks/provider.ts"], callees: [calls[name]] };
  return { version: 1, webhooks: [{ id: "provider-events", handlerFiles: ["src/webhooks/provider.ts"], controls }] };
}
/** @param {any} raw */
function policy(raw = rawPolicy()) { const result = validateWebhookSafetyPolicy(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("policy fixture invalid"); return result.policy; }
/** @param {{handler?:string,helper?:string}} [content] */
function repository(content = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "webhook-safety-")); fs.mkdirSync(path.join(root, "src/webhooks"), { recursive: true });
  const calls = controlCalls();
  const normal = `export async function webhook(event) { ${calls.signatureVerification}(event); ${calls.idempotency}(event); ${calls.replayHandling}(event); ${calls.eventOrdering}(event); ${calls.retrySafety}(event); ${calls.unknownEvents}(event); return processEvent(event); }\n`;
  fs.writeFileSync(path.join(root, "src/webhooks/provider.ts"), content.handler ?? normal);
  if (content.helper !== undefined) fs.writeFileSync(path.join(root, "src/webhooks/helper.ts"), content.helper);
  return root;
}
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("policy requires all six generic webhook controls explicitly", () => {
  const result = validateWebhookSafetyPolicy(rawPolicy());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) return;
  assert.deepEqual(Object.keys(result.policy.webhooks[0].controls).sort(), [...CONTROLS].sort());
  const missing = rawPolicy(); delete missing.webhooks[0].controls.replayHandling;
  assert.equal(validateWebhookSafetyPolicy(missing).valid, false);
});

test("non-ignored controls require explicit evidence files and callees", () => {
  const files = rawPolicy(); files.webhooks[0].controls.signatureVerification.evidenceFiles = [];
  assert.equal(validateWebhookSafetyPolicy(files).valid, false);
  const calls = rawPolicy(); calls.webhooks[0].controls.idempotency.callees = [];
  assert.equal(validateWebhookSafetyPolicy(calls).valid, false);
});

test("explicit IGNORE control may omit evidence but remains visible", () => {
  const raw = rawPolicy(); raw.webhooks[0].controls.eventOrdering = { severity: "IGNORE", evidenceFiles: [], callees: [] };
  const root = repository();
  const report = inspectWebhookSafety(root, policy(raw));
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "webhook-control-ignored" && item.control === "eventOrdering"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("all structurally present webhook controls pass", () => {
  const root = repository();
  const report = inspectWebhookSafety(root, policy());
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.summary.pass, 6);
  assert.equal(report.controlsPerWebhook, 6);
  assert.match(report.semantics, /not proven/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing blocking signature verification fails", () => {
  const calls = controlCalls();
  const root = repository({ handler: `export function webhook(event) { ${calls.idempotency}(event); ${calls.replayHandling}(event); ${calls.eventOrdering}(event); ${calls.retrySafety}(event); ${calls.unknownEvents}(event); }\n` });
  const report = inspectWebhookSafety(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "webhook-control-missing" && item.control === "signatureVerification" && item.status === "FAIL"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("advisory control absence warns without weakening blocking controls", () => {
  const raw = rawPolicy(); raw.webhooks[0].controls.eventOrdering.severity = "WARN";
  const root = repository({ handler: repositorySourceWithout("eventOrdering") });
  const report = inspectWebhookSafety(root, policy(raw));
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.summary.fail, 0);
  assert.equal(report.checks.some((item) => item.control === "eventOrdering" && item.status === "WARN"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

/** @param {string} omitted */
function repositorySourceWithout(omitted) { const calls = controlCalls(); return `export function webhook(event) { ${CONTROLS.filter((name) => name !== omitted).map((name) => `${calls[name]}(event);`).join(" ")} }\n`; }

test("control names in comments and strings do not satisfy AST evidence", () => {
  const calls = controlCalls();
  const root = repository({ handler: `export function webhook(event) { const note = "${calls.signatureVerification}(event)"; /* ${calls.signatureVerification}(event) */ ${CONTROLS.filter((name) => name !== "signatureVerification").map((name) => `${calls[name]}(event);`).join(" ")} }\n` });
  const report = inspectWebhookSafety(root, policy());
  assert.equal(report.checks.some((item) => item.control === "signatureVerification" && item.id === "webhook-control-missing"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("central helper evidence files can satisfy multiple controls explicitly", () => {
  const calls = controlCalls(), root = repository({ handler: "export function webhook(event) { return dispatch(event); }\n", helper: `export function safety(event) { ${calls.signatureVerification}(event); ${calls.idempotency}(event); ${calls.replayHandling}(event); ${calls.eventOrdering}(event); ${calls.retrySafety}(event); ${calls.unknownEvents}(event); }\n` });
  const raw = rawPolicy(); for (const name of CONTROLS) raw.webhooks[0].controls[name].evidenceFiles = ["src/webhooks/helper.ts"];
  assert.equal(inspectWebhookSafety(root, policy(raw)).overallStatus, "PASS");
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing symlinked or malformed handler and evidence files fail closed", () => {
  const root = repository(); fs.rmSync(path.join(root, "src/webhooks/provider.ts")); fs.symlinkSync("/etc/passwd", path.join(root, "src/webhooks/provider.ts"));
  let report = inspectWebhookSafety(root, policy());
  assert.equal(report.checks.some((item) => item.id === "webhook-handler-uninspectable"), true);
  assert.equal(report.checks.some((item) => item.id === "webhook-control-evidence-uninspectable"), true);
  fs.rmSync(path.join(root, "src/webhooks/provider.ts")); fs.writeFileSync(path.join(root, "src/webhooks/provider.ts"), "export function broken( {");
  report = inspectWebhookSafety(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("policy rejects unsafe paths invalid severities duplicate ids and unknown fields", () => {
  const pathPolicy = rawPolicy(); pathPolicy.webhooks[0].handlerFiles = ["../outside.ts"];
  assert.equal(validateWebhookSafetyPolicy(pathPolicy).valid, false);
  const severity = rawPolicy(); severity.webhooks[0].controls.retrySafety.severity = "BLOCK";
  assert.equal(validateWebhookSafetyPolicy(severity).valid, false);
  const duplicate = rawPolicy(); duplicate.webhooks.push(structuredClone(duplicate.webhooks[0]));
  assert.equal(validateWebhookSafetyPolicy(duplicate).valid, false);
  const unknown = rawPolicy(); unknown.webhooks[0].provider = "vendor";
  assert.equal(validateWebhookSafetyPolicy(unknown).valid, false);
});

test("human report exposes structural findings without webhook source payload", () => {
  const marker = "UNIQUE_WEBHOOK_PAYLOAD_732";
  const root = repository({ handler: `export function webhook(event) { const marker = "${marker}"; ${repositorySourceWithout("signatureVerification").match(/\{([\s\S]*)\}/)?.[1] ?? ""} }\n` });
  const output = formatWebhookSafety(inspectWebhookSafety(root, policy()));
  assert.match(output, /signatureVerification/);
  assert.doesNotMatch(output, new RegExp(marker));
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI emits JSON for PASS and blocking exit for unsafe webhook", () => {
  const root = repository(), policyFile = tempJson("webhook-policy", rawPolicy());
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", policyFile, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  fs.writeFileSync(path.join(root, "src/webhooks/provider.ts"), repositorySourceWithout("idempotency"));
  assert.equal(main(["--root", root, "--policy", policyFile]), 1);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(policyFile, { force: true });
});

test("CLI rejects malformed policy missing repository and unknown options", () => {
  const malformed = tempJson("webhook-bad", "{");
  assert.equal(main(["--root", "/tmp/missing-webhook-repo", "--policy", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("webhook safety reuses canonical TypeScript AST call evidence and stays local read only", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-webhook-safety.js", import.meta.url), "utf8");
  const helper = fs.readFileSync(new URL("../scripts/typescript-call-evidence.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /inspectTypeScriptCalls/);
  assert.match(helper, /ts\.isCallExpression/);
});
