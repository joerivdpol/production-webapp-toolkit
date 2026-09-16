#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { calleeNameList, inspectTypeScriptCalls, sourcePathList } from "./typescript-call-evidence.js";

const CONTROLS = ["locking", "timeout", "retries", "deadLetter"];
const SEVERITIES = new Set(["FAIL", "WARN", "IGNORE"]);
const OVERLAP_MODES = new Set(["forbid", "allow"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v) ? v : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {string} value */
function validTimeZone(value) { try { new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date(0)); return !["local", "system"].includes(value.toLowerCase()); } catch { return false; } }
/** @param {unknown} raw @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function control(raw, scope, errors) {
  if (!object(raw)) { errors.push({ id: "control-invalid", detail: `${scope} must be an object` }); return null; }
  unknown(raw, ["severity", "evidenceFiles", "callees"], "control", errors);
  const severity = text(raw.severity, 16);
  if (!severity || !SEVERITIES.has(severity)) { errors.push({ id: "control-severity-invalid", detail: `${scope}.severity must be FAIL WARN or IGNORE` }); return null; }
  const evidenceFiles = sourcePathList(raw.evidenceFiles, { minimum: severity === "IGNORE" ? 0 : 1, maximum: 128 });
  const callees = calleeNameList(raw.callees, { minimum: severity === "IGNORE" ? 0 : 1, maximum: 64 });
  if (!evidenceFiles || !callees || ((evidenceFiles.length === 0) !== (callees.length === 0)) || (severity !== "IGNORE" && evidenceFiles.length === 0)) { errors.push({ id: "control-evidence-invalid", detail: `${scope} requires evidence files and callees unless IGNORE` }); return null; }
  return { severity, evidenceFiles, callees };
}

/** @param {unknown} value */
export function validateJobSchedulerPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "job scheduler policy must be an object" }] };
  unknown(value, ["version", "jobs"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (!Array.isArray(value.jobs) || value.jobs.length === 0 || value.jobs.length > 256) { errors.push({ id: "jobs-invalid", detail: "jobs must be a non-empty bounded array" }); return { valid: false, policy: null, errors }; }
  /** @type {Array<any>} */ const jobs = [];
  const ids = new Set();
  for (const [index, raw] of value.jobs.entries()) {
    if (!object(raw)) { errors.push({ id: "job-invalid", detail: `jobs[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "schedule", "handlerFiles", "registration", "overlap", "controls"], "job", errors);
    const id = text(raw.id, 128);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || ids.has(id)) { errors.push({ id: "job-id-invalid", detail: `jobs[${index}].id is invalid or duplicate` }); continue; }
    ids.add(id);
    let schedule = null;
    if (!object(raw.schedule)) errors.push({ id: "schedule-invalid", detail: `jobs[${index}].schedule must be an object` });
    else {
      unknown(raw.schedule, ["expression", "timezone"], "schedule", errors);
      const expression = text(raw.schedule.expression, 512), timezone = text(raw.schedule.timezone, 128);
      if (!expression || !timezone || !validTimeZone(timezone)) errors.push({ id: "schedule-fields-invalid", detail: `jobs[${index}].schedule requires opaque expression and explicit valid IANA timezone` });
      else schedule = { expression, timezone };
    }
    const handlerFiles = sourcePathList(raw.handlerFiles, { minimum: 1, maximum: 128 });
    if (!handlerFiles) errors.push({ id: "handler-files-invalid", detail: `jobs[${index}].handlerFiles is invalid` });
    let registration = null;
    if (!object(raw.registration)) errors.push({ id: "registration-invalid", detail: `jobs[${index}].registration must be an object` });
    else {
      unknown(raw.registration, ["evidenceFiles", "callees"], "registration", errors);
      const evidenceFiles = sourcePathList(raw.registration.evidenceFiles, { minimum: 1, maximum: 128 });
      const callees = calleeNameList(raw.registration.callees, { minimum: 1, maximum: 64 });
      if (!evidenceFiles || !callees) errors.push({ id: "registration-fields-invalid", detail: `jobs[${index}].registration requires evidence files and callees` });
      else registration = { evidenceFiles, callees };
    }
    let overlap = null;
    if (!object(raw.overlap)) errors.push({ id: "overlap-invalid", detail: `jobs[${index}].overlap must be an object` });
    else {
      unknown(raw.overlap, ["mode"], "overlap", errors);
      const mode = text(raw.overlap.mode, 16);
      if (!mode || !OVERLAP_MODES.has(mode)) errors.push({ id: "overlap-mode-invalid", detail: `jobs[${index}].overlap.mode must be forbid or allow` });
      else overlap = { mode };
    }
    if (!object(raw.controls)) { errors.push({ id: "controls-invalid", detail: `jobs[${index}].controls must be an object` }); continue; }
    unknown(raw.controls, CONTROLS, "controls", errors);
    /** @type {Record<string,any>} */ const controls = {};
    for (const name of CONTROLS) {
      if (!(name in raw.controls)) { errors.push({ id: "control-missing", detail: `jobs[${index}].controls.${name} must be explicitly configured` }); continue; }
      const parsed = control(raw.controls[name], `jobs[${index}].controls.${name}`, errors); if (parsed) controls[name] = parsed;
    }
    if (schedule && handlerFiles && registration && overlap && CONTROLS.every((name) => controls[name])) jobs.push({ id, schedule, handlerFiles, registration, overlap, controls });
  }
  if (errors.length) return { valid: false, policy: null, errors };
  jobs.sort((a, b) => a.id.localeCompare(b.id));
  return { valid: true, policy: { version: 1, jobs }, errors: [] };
}

/** @param {string} root @param {any} policy */
export function inspectJobScheduler(root, policy) {
  /** @type {Array<any>} */ const checks = [];
  /** @param {string} id @param {"PASS"|"WARN"|"FAIL"} status @param {string} job @param {string} controlName @param {string} detail */
  const add = (id, status, job, controlName, detail) => checks.push({ id, status, job, control: controlName, detail });
  const cache = new Map();
  /** @param {string} file */
  function inspect(file) { if (!cache.has(file)) cache.set(file, inspectTypeScriptCalls(root, file)); return cache.get(file); }
  for (const job of policy.jobs) {
    let handlersInspectable = true;
    for (const file of job.handlerFiles) { const result = inspect(file); if (!result.ok) { handlersInspectable = false; add("job-handler-uninspectable", "FAIL", job.id, "handler", `${file} cannot be safely parsed`); } }
    let registrationFound = false, registrationInspectable = true;
    for (const file of job.registration.evidenceFiles) { const result = inspect(file); if (!result.ok) { registrationInspectable = false; add("job-registration-uninspectable", "FAIL", job.id, "registration", `${file} cannot be safely parsed`); continue; } if (job.registration.callees.some((/** @type {string} */ callee) => result.calls.has(callee))) registrationFound = true; }
    if (registrationInspectable && registrationFound) add("job-registration-present", "PASS", job.id, "registration", "configured scheduler registration call is structurally present");
    else if (registrationInspectable) add("job-registration-missing", "FAIL", job.id, "registration", "no configured scheduler registration call is structurally present");
    add("job-timezone-explicit", "PASS", job.id, "schedule", `schedule has explicit timezone ${job.schedule.timezone}; expression syntax remains scheduler-specific`);

    /** @type {Record<string,boolean>} */ const present = {};
    for (const name of CONTROLS) {
      const cfg = job.controls[name];
      if (cfg.severity === "IGNORE") { present[name] = false; add("job-control-ignored", "WARN", job.id, name, "control is explicitly not required; no operational safety claim is made"); continue; }
      let inspectable = true, found = false;
      for (const file of cfg.evidenceFiles) { const result = inspect(file); if (!result.ok) { inspectable = false; add("job-control-evidence-uninspectable", cfg.severity, job.id, name, `${file} cannot be safely parsed`); continue; } if (cfg.callees.some((/** @type {string} */ callee) => result.calls.has(callee))) found = true; }
      present[name] = inspectable && found;
      if (inspectable && found) add("job-control-present", "PASS", job.id, name, "configured control call is structurally present");
      else if (inspectable) add("job-control-missing", cfg.severity, job.id, name, "no configured control call is structurally present");
    }
    if (job.overlap.mode === "allow") add("job-overlap-explicitly-allowed", "WARN", job.id, "overlap", "overlapping executions are explicitly allowed; no non-overlap guarantee is made");
    else if (present.locking) add("job-overlap-guarded", "PASS", job.id, "overlap", "overlap is forbidden by policy and structural locking evidence is present");
    else add("job-overlap-unguarded", "FAIL", job.id, "overlap", "overlap is forbidden but structural locking evidence is absent");
    if (handlersInspectable && registrationFound && present.timeout && present.retries && (present.deadLetter || job.controls.deadLetter.severity === "IGNORE")) add("job-operational-profile-present", "PASS", job.id, "job", "handler, registration, timeout, retry, and configured dead-letter posture are structurally inspectable");
  }
  const summary = { pass: checks.filter((item) => item.status === "PASS").length, warn: checks.filter((item) => item.status === "WARN").length, fail: checks.filter((item) => item.status === "FAIL").length };
  return { jobs: policy.jobs.length, checks: checks.sort((a, b) => `${a.job}:${a.control}:${a.id}`.localeCompare(`${b.job}:${b.control}:${b.id}`)), summary, technicalStatus: "PASS", overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS", semantics: "explicit schedule metadata and AST call-presence evidence only; scheduler delivery, distributed locking semantics, timeout enforcement, retry backoff, dead-letter durability, and runtime overlap are not independently proven" };
}

/** @param {ReturnType<typeof inspectJobScheduler>} report */
export function formatJobScheduler(report) { const lines = ["Job and scheduler audit", "", `Jobs: ${report.jobs}`, `Semantics: ${report.semantics}`, ""]; for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.job}  ${check.control}  ${check.id}  ${check.detail}`); lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`); return lines.join("\n"); }
/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) { let root = null, policyFile = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--root", "--policy"].includes(arg ?? "")) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; i += 1; if (arg === "--root") { if (root) return null; root = next; } else { if (policyFile) return null; policyFile = next; } } return root && policyFile ? { root, policyFile, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/audit-job-scheduler.js --root <repository> --policy <job-scheduler-policy.json> [--json]"); return 1; } const raw = readJson(options.policyFile); if (!raw) { console.error("Job scheduler policy cannot be read or parsed"); return 1; } const validated = validateJobSchedulerPolicy(raw); if (!validated.valid || !validated.policy) { console.error("Job scheduler policy is invalid"); return 1; } const root = path.resolve(options.root); let stat; try { stat = fs.lstatSync(root); } catch { console.error("Job repository is unavailable"); return 1; } if (!stat.isDirectory() || stat.isSymbolicLink()) { console.error("Job repository must be a regular directory"); return 1; } const report = inspectJobScheduler(root, validated.policy); console.log(options.json ? JSON.stringify(report) : formatJobScheduler(report)); return report.overallStatus === "FAIL" ? 1 : 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
