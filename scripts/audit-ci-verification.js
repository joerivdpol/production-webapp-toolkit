#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  validateCiEvidence,
} from "./ci-evidence.js";
import {
  isFullObjectId,
} from "./runtime-evidence.js";

/** @typedef {{ name: string, status: "PASS" | "FAIL" | "SKIPPED" | "MISSING", passed: boolean }} RequiredCheckResult */
/**
 * @typedef {{
 *   expectedCommit: string,
 *   evidenceCommit: string,
 *   commitStatus: "MATCH" | "MISMATCH",
 *   requiredChecks: RequiredCheckResult[],
 *   checksStatus: "PASS" | "FAIL" | "UNVERIFIED",
 *   evidence: { ci: import("./ci-evidence.js").CiEvidence["ci"], trust: import("./ci-evidence.js").CiEvidence["evidence"] },
 *   technicalStatus: "PASS",
 *   overallStatus: "PASS" | "WARN" | "FAIL"
 * }} CiVerificationReport
 */

/** @param {unknown} value */
function normalizeRequiredCheck(value) {
  return typeof value === "string" ? value.trim() : null;
}
/**
 * @param {unknown} expectedCommit
 * @param {unknown} requiredChecks
 * @returns {{ ok: true, policy: { expectedCommit: string, requiredChecks: string[] } } | { ok: false, error: { id: string, detail: string } }}
 */
export function validateCiVerificationPolicy(expectedCommit, requiredChecks) {
  if (typeof expectedCommit !== "string" || !isFullObjectId(expectedCommit)) {
    return { ok: false, error: { id: "expected-commit-invalid", detail: "expectedCommit must be a full 40- or 64-character hexadecimal Git object ID" } };
  }
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    return { ok: false, error: { id: "required-checks-invalid", detail: "at least one required check is required" } };
  }
  const normalizedChecks = [];
  const seen = new Set();
  for (const raw of requiredChecks) {
    const name = normalizeRequiredCheck(raw);
    if (name === null || name === "") {
      return { ok: false, error: { id: "required-check-invalid", detail: "required check names must be non-empty strings" } };
    }
    if (seen.has(name)) {
      return { ok: false, error: { id: "required-check-duplicate", detail: `duplicate required check "${name}"` } };
    }
    seen.add(name);
    normalizedChecks.push(name);
  }
  return {
    ok: true,
    policy: {
      expectedCommit: expectedCommit.toLowerCase(),
      requiredChecks: normalizedChecks,
    },
  };
}

/** @param {import("./ci-evidence.js").CiEvidence} evidence @param {{ expectedCommit: string, requiredChecks: string[] }} policy */
function buildReport(evidence, policy) {
  const checksByName = new Map(evidence.checks.map((check) => [check.name, check.status]));
  const requiredChecks = policy.requiredChecks.map((name) => {
    const status = checksByName.get(name) ?? "MISSING";
    return {
      name,
      status: /** @type {RequiredCheckResult["status"]} */ (status),
      passed: status === "PASS",
    };
  });
  const commitStatus = evidence.commit === policy.expectedCommit ? "MATCH" : "MISMATCH";
  const checksStatus = requiredChecks.some((check) => check.status === "FAIL")
    ? "FAIL"
    : requiredChecks.some((check) => check.status === "SKIPPED" || check.status === "MISSING")
      ? "UNVERIFIED"
      : "PASS";
  const overallStatus = checksStatus === "FAIL"
    ? "FAIL"
    : commitStatus === "MISMATCH" || checksStatus === "UNVERIFIED"
      ? "WARN"
      : "PASS";

  return {
    expectedCommit: policy.expectedCommit,
    evidenceCommit: evidence.commit,
    commitStatus: /** @type {"MATCH" | "MISMATCH"} */ (commitStatus),
    requiredChecks,
    checksStatus: /** @type {"PASS" | "FAIL" | "UNVERIFIED"} */ (checksStatus),
    evidence: {
      ci: evidence.ci,
      trust: evidence.evidence,
    },
    technicalStatus: /** @type {"PASS"} */ ("PASS"),
    overallStatus: /** @type {"PASS" | "WARN" | "FAIL"} */ (overallStatus),
  };
}

/**
 * @param {unknown} value
 * @param {{ expectedCommit?: unknown, requiredChecks?: unknown }} options
 * @returns {{ ok: true, report: CiVerificationReport } | { ok: false, error: { id: string, detail: string } }}
 */
export function inspectCiVerification(value, options = {}) {
  const validation = validateCiEvidence(value);
  if (!validation.valid || !validation.evidence) {
    return { ok: false, error: { id: "ci-evidence-invalid", detail: "CI evidence does not satisfy CI Evidence Contract v1" } };
  }
  const policy = validateCiVerificationPolicy(options.expectedCommit, options.requiredChecks);
  if (!policy.ok) return policy;
  return { ok: true, report: buildReport(validation.evidence, policy.policy) };
}

/**
 * @param {{ evidenceFile: string, expectedCommit: string, requiredChecks: string[] }} options
 * @returns {{ ok: true, report: CiVerificationReport } | { ok: false, error: { id: string, detail: string } }}
 */
export function inspectCiVerificationFromFile(options) {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(options.evidenceFile, "utf8"));
  } catch (error) {
    return {
      ok: false,
      error: {
        id: error instanceof SyntaxError ? "ci-evidence-json-malformed" : "ci-evidence-file-read-failed",
        detail: error instanceof SyntaxError ? "CI evidence file contains malformed JSON" : "CI evidence file could not be read",
      },
    };
  }
  return inspectCiVerification(input, options);
}
/** @param {CiVerificationReport} report */
export function formatCiVerification(report) {
  const lines = [
    "CI verification",
    "",
    `Expected commit: ${report.expectedCommit}`,
    `Evidence commit: ${report.evidenceCommit}`,
    `Commit: ${report.commitStatus}`,
    `Required checks: ${report.checksStatus}`,
    `Provider: ${report.evidence.ci.provider}`,
    `Workflow: ${report.evidence.ci.workflow ?? "(not supplied)"}`,
    `Run ID: ${report.evidence.ci.runId ?? "(not supplied)"}`,
    `Source: ${report.evidence.trust.source}`,
    `Authenticated: ${report.evidence.trust.authenticated}`,
    `Collected at: ${report.evidence.trust.collectedAt}`,
    "",
  ];
  for (const check of report.requiredChecks) {
    lines.push(`${check.passed ? "PASS" : "WARN"}  ${check.name}  ${check.status}`);
  }
  lines.push(
    "",
    `Technical: ${report.technicalStatus}`,
    `Overall: ${report.overallStatus}`,
  );
  return lines.join("\n");
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  let evidenceFile = null;
  let expectedCommit = null;
  /** @type {string[]} */
  const requiredChecks = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--evidence-file" || argument === "--expected-commit" || argument === "--require-check") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value === "" || value.startsWith("--")) return null;
      if (argument === "--evidence-file") {
        if (evidenceFile !== null) return null;
        evidenceFile = value;
      }
      if (argument === "--expected-commit") {
        if (expectedCommit !== null) return null;
        expectedCommit = value;
      }
      if (argument === "--require-check") requiredChecks.push(value);
      index += 1;
    } else {
      return null;
    }
  }

  if (evidenceFile === null || expectedCommit === null || requiredChecks.length === 0) return null;
  const policy = validateCiVerificationPolicy(expectedCommit, requiredChecks);
  if (!policy.ok) return null;
  return {
    evidenceFile,
    expectedCommit: policy.policy.expectedCommit,
    requiredChecks: policy.policy.requiredChecks,
    json,
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/audit-ci-verification.js --evidence-file <ci-evidence.json> --expected-commit <full-object-id> --require-check <name> [--require-check <name> ...] [--json]");
    return 1;
  }

  const result = inspectCiVerificationFromFile(options);
  if (!result.ok) {
    console.error(result.error.detail);
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.report) : formatCiVerification(result.report));
  return result.report.overallStatus === "FAIL" ? 1 : 0;
}

// This verifier reads only the explicit evidence file. It performs no Git
// command, network request, environment read, runtime probe, or file write.
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
