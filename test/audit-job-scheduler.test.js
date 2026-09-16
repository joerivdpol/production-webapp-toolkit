import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatJobScheduler, inspectJobScheduler, main, validateJobSchedulerPolicy } from "../scripts/audit-job-scheduler.js";

/** @returns {any} */
function rawPolicy() {
  return { version: 1, jobs: [{
    id: "nightly-sync",
    schedule: { expression: "0 2 * * *", timezone: "Asia/Jakarta" },
    handlerFiles: ["src/jobs/nightly.ts"],
    registration: { evidenceFiles: ["src/jobs/register.ts"], callees: ["scheduler.register"] },
    overlap: { mode: "forbid" },
    controls: {
      locking: { severity: "FAIL", evidenceFiles: ["src/jobs/nightly.ts"], callees: ["withJobLock"] },
      timeout: { severity: "FAIL", evidenceFiles: ["src/jobs/nightly.ts"], callees: ["withTimeout"] },
      retries: { severity: "FAIL", evidenceFiles: ["src/jobs/nightly.ts"], callees: ["retryJob"] },
      deadLetter: { severity: "FAIL", evidenceFiles: ["src/jobs/nightly.ts"], callees: ["sendDeadLetter"] },
    },
  }] };
}
function policy(raw = rawPolicy()) { const result = validateJobSchedulerPolicy(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.policy) throw new Error("policy invalid"); return result.policy; }
/** @param {{handler?:string,registration?:string}} [content] */
function repository(content = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "job-scheduler-"));
  fs.mkdirSync(path.join(root, "src/jobs"), { recursive: true });
  fs.writeFileSync(path.join(root, "src/jobs/nightly.ts"), content.handler ?? "export async function run() { return withJobLock(() => withTimeout(() => retryJob(() => sendDeadLetter()))); }\n");
  fs.writeFileSync(path.join(root, "src/jobs/register.ts"), content.registration ?? "export function register() { scheduler.register(\"nightly-sync\"); }\n");
  return root;
}
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("validates explicit schedule timezone registration overlap and controls", () => {
  const result = validateJobSchedulerPolicy(rawPolicy());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) return;
  assert.equal(result.policy.jobs[0].schedule.timezone, "Asia/Jakarta");
  assert.equal(result.policy.jobs[0].overlap.mode, "forbid");
});

test("rejects missing ambiguous or invalid timezone without parsing scheduler expression", () => {
  const local = rawPolicy(); local.jobs[0].schedule.timezone = "local";
  assert.equal(validateJobSchedulerPolicy(local).valid, false);
  const invalid = rawPolicy(); invalid.jobs[0].schedule.timezone = "Mars/Olympus";
  assert.equal(validateJobSchedulerPolicy(invalid).valid, false);
  const opaque = rawPolicy(); opaque.jobs[0].schedule.expression = "scheduler-specific-expression";
  assert.equal(validateJobSchedulerPolicy(opaque).valid, true);
});
test("complete scheduled job profile passes structurally", () => {
  const root = repository(), report = inspectJobScheduler(root, policy());
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks.some((item) => item.id === "job-registration-present"), true);
  assert.equal(report.checks.some((item) => item.id === "job-overlap-guarded"), true);
  assert.match(report.semantics, /not independently proven/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("forbid overlap requires structural locking evidence", () => {
  const root = repository({ handler: "export async function run() { return withTimeout(() => retryJob(() => sendDeadLetter())); }\n" });
  const report = inspectJobScheduler(root, policy());
  assert.equal(report.checks.some((item) => item.id === "job-control-missing" && item.control === "locking"), true);
  assert.equal(report.checks.some((item) => item.id === "job-overlap-unguarded"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("explicit overlap allow remains a warning rather than a non-overlap claim", () => {
  const raw = rawPolicy(); raw.jobs[0].overlap.mode = "allow"; raw.jobs[0].controls.locking = { severity: "IGNORE", evidenceFiles: [], callees: [] };
  const root = repository({ handler: "export async function run() { return withTimeout(() => retryJob(() => sendDeadLetter())); }\n" });
  const report = inspectJobScheduler(root, policy(raw));
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "job-overlap-explicitly-allowed"), true);
  fs.rmSync(root, { recursive: true, force: true });
});
test("timeout retry and dead-letter absence remain separate findings", () => {
  const root = repository({ handler: "export async function run() { return withJobLock(() => work()); }\n" });
  const report = inspectJobScheduler(root, policy());
  for (const name of ["timeout", "retries", "deadLetter"]) assert.equal(report.checks.some((item) => item.id === "job-control-missing" && item.control === name), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("ignored dead-letter policy stays visible without inventing durability", () => {
  const raw = rawPolicy(); raw.jobs[0].controls.deadLetter = { severity: "IGNORE", evidenceFiles: [], callees: [] };
  const root = repository({ handler: "export async function run() { return withJobLock(() => withTimeout(() => retryJob(() => work()))); }\n" });
  const report = inspectJobScheduler(root, policy(raw));
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "job-control-ignored" && item.control === "deadLetter"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing registration call is blocking even when handler controls exist", () => {
  const root = repository({ registration: "export function register() { return true; }\n" });
  const report = inspectJobScheduler(root, policy());
  assert.equal(report.checks.some((item) => item.id === "job-registration-missing"), true);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});
test("control names in comments and strings do not satisfy AST evidence", () => {
  const root = repository({ handler: "export async function run() { const note = \"withTimeout() retryJob() sendDeadLetter()\"; /* withJobLock() */ return work(); }\n" });
  const report = inspectJobScheduler(root, policy());
  assert.equal(report.checks.some((item) => item.id === "job-control-present"), false);
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("symlinked or malformed job evidence fails closed", () => {
  const root = repository();
  fs.rmSync(path.join(root, "src/jobs/nightly.ts")); fs.symlinkSync("/etc/passwd", path.join(root, "src/jobs/nightly.ts"));
  let report = inspectJobScheduler(root, policy());
  assert.equal(report.checks.some((item) => item.id === "job-handler-uninspectable"), true);
  fs.rmSync(path.join(root, "src/jobs/nightly.ts")); fs.writeFileSync(path.join(root, "src/jobs/nightly.ts"), "export function broken( {");
  report = inspectJobScheduler(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("policy rejects unsafe paths duplicate ids invalid overlap and unknown fields", () => {
  const unsafe = rawPolicy(); unsafe.jobs[0].handlerFiles = ["../job.ts"];
  assert.equal(validateJobSchedulerPolicy(unsafe).valid, false);
  const duplicate = rawPolicy(); duplicate.jobs.push(structuredClone(duplicate.jobs[0]));
  assert.equal(validateJobSchedulerPolicy(duplicate).valid, false);
  const overlap = rawPolicy(); overlap.jobs[0].overlap.mode = "maybe";
  assert.equal(validateJobSchedulerPolicy(overlap).valid, false);
  const unknown = rawPolicy(); unknown.jobs[0].queue = "jobs";
  assert.equal(validateJobSchedulerPolicy(unknown).valid, false);
});
test("human report exposes structural findings without source payloads", () => {
  const marker = "UNIQUE_JOB_PAYLOAD_904";
  const root = repository({ handler: `export async function run() { const marker = "${marker}"; return work(); }\n` });
  const output = formatJobScheduler(inspectJobScheduler(root, policy()));
  assert.match(output, /Job and scheduler audit/);
  assert.doesNotMatch(output, new RegExp(marker));
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI emits JSON for PASS and blocking exit for unsafe job", () => {
  const root = repository(), policyFile = tempJson("job-policy", rawPolicy());
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", policyFile, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  fs.writeFileSync(path.join(root, "src/jobs/register.ts"), "export function register() { return false; }\n");
  assert.equal(main(["--root", root, "--policy", policyFile]), 1);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(policyFile, { force: true });
});

test("CLI rejects malformed policy missing repository and unknown options", () => {
  const malformed = tempJson("job-bad", "{");
  assert.equal(main(["--root", "/tmp/missing-job-repo", "--policy", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("job scheduler audit is local read only and reuses canonical AST call evidence", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-job-scheduler.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /inspectTypeScriptCalls/);
});
