#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateCiEvidence } from "./ci-evidence.js";

const MAX_OBSERVATIONS = 1000;
const SEVERITIES = new Set(["blocking", "advisory"]);

/** @typedef {{ name:string, severity:"blocking"|"advisory" }} FlakyCheckPolicy */
/** @typedef {{ version:1, ci:{provider:string, workflow:string}, minimumObservations:number, minimumPasses:number, minimumFailures:number, checks:FlakyCheckPolicy[] }} FlakyPolicy */
/** @typedef {{ id:string, detail:string }} PolicyError */
/** @typedef {{ name:string, severity:"blocking"|"advisory", pass:number, fail:number, skipped:number, missing:number, observations:number, state:"STABLE"|"FLAKY"|"UNVERIFIED", firstSeen:string|null, lastSeen:string|null }} FlakyCheckResult */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {PolicyError[]} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value @param {string} field @param {PolicyError[]} errors */
function boundedPositiveInteger(value, field, errors) {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > MAX_OBSERVATIONS) {
    errors.push({ id: `${field}-invalid`, detail: `${field} must be an integer between 1 and ${MAX_OBSERVATIONS}` });
    return null;
  }
  return Number(value);
}

/** @param {unknown} value */
export function validateFlakyTestPolicy(value) {
  /** @type {PolicyError[]} */
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, policy: null, errors: [{ id: "policy-invalid", detail: "policy must be an object" }] };
  rejectUnknown(value, ["version", "ci", "minimumObservations", "minimumPasses", "minimumFailures", "checks"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let ci = null;
  if (!isPlainObject(value.ci)) errors.push({ id: "ci-invalid", detail: "ci must be an object" });
  else {
    rejectUnknown(value.ci, ["provider", "workflow"], "ci", errors);
    const provider = nonEmptyString(value.ci.provider);
    const workflow = nonEmptyString(value.ci.workflow);
    if (!provider) errors.push({ id: "ci-provider-invalid", detail: "ci.provider must be a non-empty string" });
    if (!workflow) errors.push({ id: "ci-workflow-invalid", detail: "ci.workflow must be a non-empty string" });
    if (provider && workflow) ci = { provider, workflow };
  }

  const minimumObservations = boundedPositiveInteger(value.minimumObservations, "minimumObservations", errors);
  const minimumPasses = boundedPositiveInteger(value.minimumPasses, "minimumPasses", errors);
  const minimumFailures = boundedPositiveInteger(value.minimumFailures, "minimumFailures", errors);
  if (minimumObservations !== null && minimumPasses !== null && minimumFailures !== null && minimumPasses + minimumFailures > minimumObservations) {
    errors.push({ id: "thresholds-inconsistent", detail: "minimumPasses plus minimumFailures cannot exceed minimumObservations" });
  }

  /** @type {FlakyCheckPolicy[]} */
  const checks = [];
  const names = new Set();
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    errors.push({ id: "checks-invalid", detail: "checks must be a non-empty array" });
  } else {
    for (const [index, raw] of value.checks.entries()) {
      if (!isPlainObject(raw)) { errors.push({ id: "check-invalid", detail: `checks[${index}] must be an object` }); continue; }
      rejectUnknown(raw, ["name", "severity"], "check", errors);
      const name = nonEmptyString(raw.name);
      const severity = nonEmptyString(raw.severity)?.toLowerCase() ?? null;
      if (!name) { errors.push({ id: "check-name-invalid", detail: `checks[${index}].name must be non-empty` }); continue; }
      if (names.has(name)) { errors.push({ id: "check-name-duplicate", detail: `checks contains duplicate name "${name}"` }); continue; }
      names.add(name);
      if (!severity || !SEVERITIES.has(severity)) { errors.push({ id: "check-severity-invalid", detail: `checks[${index}].severity must be blocking or advisory` }); continue; }
      checks.push({ name, severity: /** @type {"blocking"|"advisory"} */ (severity) });
    }
  }

  if (errors.length > 0 || ci === null || minimumObservations === null || minimumPasses === null || minimumFailures === null) {
    return { ok: false, policy: null, errors };
  }
  return {
    ok: true,
    policy: /** @type {FlakyPolicy} */ ({ version: 1, ci, minimumObservations, minimumPasses, minimumFailures, checks: checks.sort((a, b) => a.name.localeCompare(b.name)) }),
    errors: [],
  };
}

/** @param {FlakyPolicy} policy @param {Array<import("./ci-evidence.js").CiEvidence>} evidence */
export function inspectFlakyTests(policy, evidence) {
  const sorted = [...evidence].sort((a, b) => Date.parse(a.evidence.collectedAt) - Date.parse(b.evidence.collectedAt));
  const seenRunIds = new Set();
  const evidenceErrors = [];
  for (const item of sorted) {
    if (item.ci.provider !== policy.ci.provider) evidenceErrors.push(`provider mismatch: expected ${policy.ci.provider}, got ${item.ci.provider}`);
    if (item.ci.workflow !== policy.ci.workflow) evidenceErrors.push(`workflow mismatch: expected ${policy.ci.workflow}, got ${item.ci.workflow ?? "(missing)"}`);
    if (!item.ci.runId) {
      evidenceErrors.push(`CI run id is required for repeated evidence at ${item.evidence.collectedAt}`);
      continue;
    }
    const key = `${item.ci.provider}\u0000${item.ci.workflow ?? ""}\u0000${item.ci.runId}`;
    if (seenRunIds.has(key)) evidenceErrors.push(`duplicate CI run id ${item.ci.runId}`);
    seenRunIds.add(key);
  }

  if (evidenceErrors.length > 0) {
    return {
      checks: [],
      evidenceCount: sorted.length,
      evidenceErrors,
      summary: { stable: 0, flaky: 0, unverified: 0 },
      technicalStatus: "FAIL",
      overallStatus: "FAIL",
    };
  }

  /** @type {FlakyCheckResult[]} */
  const checks = [];
  for (const configured of policy.checks) {
    let pass = 0;
    let fail = 0;
    let skipped = 0;
    let missing = 0;
    /** @type {string[]} */
    const seenAt = [];
    for (const item of sorted) {
      const check = item.checks.find((candidate) => candidate.name === configured.name);
      if (!check) { missing += 1; continue; }
      seenAt.push(item.evidence.collectedAt);
      if (check.status === "PASS") pass += 1;
      else if (check.status === "FAIL") fail += 1;
      else skipped += 1;
    }
    const observations = pass + fail;
    const state = observations < policy.minimumObservations
      ? "UNVERIFIED"
      : pass >= policy.minimumPasses && fail >= policy.minimumFailures
        ? "FLAKY"
        : "STABLE";
    checks.push({
      name: configured.name,
      severity: configured.severity,
      pass,
      fail,
      skipped,
      missing,
      observations,
      state,
      firstSeen: seenAt[0] ?? null,
      lastSeen: seenAt.at(-1) ?? null,
    });
  }

  const flakyBlocking = checks.some((item) => item.state === "FLAKY" && item.severity === "blocking");
  const warn = checks.some((item) => item.state === "UNVERIFIED" || (item.state === "FLAKY" && item.severity === "advisory"));
  return {
    checks,
    evidenceCount: sorted.length,
    evidenceErrors: [],
    summary: {
      stable: checks.filter((item) => item.state === "STABLE").length,
      flaky: checks.filter((item) => item.state === "FLAKY").length,
      unverified: checks.filter((item) => item.state === "UNVERIFIED").length,
    },
    technicalStatus: "PASS",
    overallStatus: flakyBlocking ? "FAIL" : warn ? "WARN" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectFlakyTests>} report */
export function formatFlakyTestAudit(report) {
  const lines = ["Flaky test detection", "", `Evidence runs: ${report.evidenceCount}`];
  if (report.evidenceErrors.length > 0) {
    lines.push("", ...report.evidenceErrors.map((detail) => `FAIL  evidence-cohort  ${detail}`));
  } else {
    lines.push("");
    for (const check of report.checks) {
      const status = check.state === "FLAKY" ? (check.severity === "blocking" ? "FAIL" : "WARN") : check.state === "UNVERIFIED" ? "WARN" : "PASS";
      lines.push(`${status.padEnd(4)}  ${check.name}  ${check.state}  pass=${check.pass} fail=${check.fail} skipped=${check.skipped} missing=${check.missing} observations=${check.observations}`);
    }
  }
  lines.push(
    "",
    `Summary: ${report.summary.stable} stable, ${report.summary.flaky} flaky, ${report.summary.unverified} unverified`,
    `Technical: ${report.technicalStatus}`,
    `Overall: ${report.overallStatus}`,
  );
  return lines.join("\n");
}

/** @param {string} filename */
function readJson(filename) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(filename, "utf8")) }; }
  catch { return { ok: false, value: null }; }
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let policyFile = null;
  /** @type {string[]} */
  const evidenceFiles = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--policy" && argument !== "--evidence-file") return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--policy") {
      if (policyFile !== null) return null;
      policyFile = value;
    } else evidenceFiles.push(value);
  }
  if (policyFile === null || evidenceFiles.length === 0 || new Set(evidenceFiles).size !== evidenceFiles.length) return null;
  return { policyFile, evidenceFiles, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/audit-flaky-tests.js --policy <policy.json> --evidence-file <ci-evidence.json> [--evidence-file <ci-evidence.json> ...] [--json]");
    return 1;
  }
  const rawPolicy = readJson(options.policyFile);
  if (!rawPolicy.ok) { console.error("Flaky test policy cannot be read or parsed"); return 1; }
  const policyResult = validateFlakyTestPolicy(rawPolicy.value);
  if (!policyResult.ok || policyResult.policy === null) { console.error("Flaky test policy is invalid"); return 1; }

  const evidence = [];
  for (const filename of options.evidenceFiles) {
    const raw = readJson(filename);
    if (!raw.ok) { console.error("CI evidence file cannot be read or parsed"); return 1; }
    const result = validateCiEvidence(raw.value);
    if (!result.valid || result.evidence === null) { console.error("CI evidence is invalid"); return 1; }
    evidence.push(result.evidence);
  }

  const report = inspectFlakyTests(policyResult.policy, evidence);
  console.log(options.json ? JSON.stringify(report) : formatFlakyTestAudit(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
