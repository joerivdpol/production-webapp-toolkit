#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  isAbsoluteIsoTimestamp,
  isFullObjectId,
} from "./runtime-evidence.js";
import { validateCiEvidence } from "./ci-evidence.js";

const FAILURE_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);
const SKIPPED_CONCLUSIONS = new Set(["skipped", "neutral"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value */
function normalizedString(value) {
  return typeof value === "string" ? value.trim() : null;
}
/** @param {unknown} value */
function normalizeIdentifier(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  if (typeof value === "string" && /^[1-9]\d*$/.test(value.trim())) return value.trim();
  return null;
}

/** @param {unknown} conclusion */
function mapConclusion(conclusion) {
  if (conclusion === "success") return "PASS";
  if (typeof conclusion === "string" && SKIPPED_CONCLUSIONS.has(conclusion)) return "SKIPPED";
  if (typeof conclusion === "string" && FAILURE_CONCLUSIONS.has(conclusion)) return "FAIL";
  return null;
}

/**
 * @param {unknown} runPayload
 * @param {unknown} jobsPayload
 * @param {{ collectedAt: unknown, authenticated?: unknown, source?: unknown }} options
 * @returns {{ ok: true, evidence: import("./ci-evidence.js").CiEvidence } | { ok: false, error: { id: string, detail: string } }}
 */
export function buildGitHubActionsCiEvidence(runPayload, jobsPayload, options) {
  if (!isPlainObject(runPayload)) {
    return { ok: false, error: { id: "github-run-invalid", detail: "GitHub Actions workflow run payload must be an object" } };
  }
  if (!isPlainObject(jobsPayload) || !Array.isArray(jobsPayload.jobs)) {
    return { ok: false, error: { id: "github-jobs-invalid", detail: "GitHub Actions jobs payload must contain a jobs array" } };
  }

  const runId = normalizeIdentifier(runPayload.id);
  const workflow = normalizedString(runPayload.name);
  const commit = normalizedString(runPayload.head_sha);
  if (runId === null) return { ok: false, error: { id: "github-run-id-invalid", detail: "workflow run id must be a positive integer identifier" } };
  if (!workflow) return { ok: false, error: { id: "github-workflow-name-invalid", detail: "workflow run name must be a non-empty string" } };
  if (commit === null || !isFullObjectId(commit)) return { ok: false, error: { id: "github-head-sha-invalid", detail: "workflow run head_sha must be a full Git object ID" } };
  if (runPayload.status !== "completed") return { ok: false, error: { id: "github-run-incomplete", detail: "workflow run must be completed before evidence can be emitted" } };
  if (!normalizedString(runPayload.conclusion)) return { ok: false, error: { id: "github-run-conclusion-missing", detail: "completed workflow run must have a conclusion" } };

  const collectedAt = normalizedString(options?.collectedAt);
  if (collectedAt === null || !isAbsoluteIsoTimestamp(collectedAt)) {
    return { ok: false, error: { id: "github-collected-at-invalid", detail: "collectedAt must be an explicit absolute ISO 8601 timestamp" } };
  }
  const authenticated = options?.authenticated ?? false;
  if (typeof authenticated !== "boolean") {
    return { ok: false, error: { id: "github-authenticated-invalid", detail: "authenticated must be boolean when supplied" } };
  }
  const source = options?.source === undefined ? "github-actions-api-payload" : normalizedString(options.source);
  if (!source) {
    return { ok: false, error: { id: "github-source-invalid", detail: "source must be a non-empty string when supplied" } };
  }
  if (jobsPayload.jobs.length === 0) {
    return { ok: false, error: { id: "github-jobs-empty", detail: "workflow run must contain at least one job" } };
  }

  /** @type {Array<{ name: string, status: "PASS" | "FAIL" | "SKIPPED" }>} */
  const checks = [];
  const names = new Set();
  for (const [index, rawJob] of jobsPayload.jobs.entries()) {
    if (!isPlainObject(rawJob)) {
      return { ok: false, error: { id: "github-job-invalid", detail: `jobs[${index}] must be an object` } };
    }
    const jobRunId = normalizeIdentifier(rawJob.run_id);
    if (jobRunId !== runId) {
      return { ok: false, error: { id: "github-job-run-mismatch", detail: `jobs[${index}] does not belong to workflow run ${runId}` } };
    }
    const name = normalizedString(rawJob.name);
    if (!name) {
      return { ok: false, error: { id: "github-job-name-invalid", detail: `jobs[${index}].name must be a non-empty string` } };
    }
    if (names.has(name)) {
      return { ok: false, error: { id: "github-job-name-duplicate", detail: `GitHub Actions jobs contain duplicate normalized name "${name}"` } };
    }
    names.add(name);
    if (rawJob.status !== "completed") {
      return { ok: false, error: { id: "github-job-incomplete", detail: `job "${name}" must be completed before evidence can be emitted` } };
    }
    const status = mapConclusion(rawJob.conclusion);
    if (status === null) {
      return { ok: false, error: { id: "github-job-conclusion-unsupported", detail: `job "${name}" has an unsupported or missing conclusion` } };
    }
    checks.push({ name, status });
  }

  const candidate = {
    version: 1,
    commit: commit.toLowerCase(),
    ci: {
      provider: "github-actions",
      workflow,
      runId,
    },
    evidence: {
      source,
      authenticated,
      collectedAt,
    },
    checks,
  };
  const validation = validateCiEvidence(candidate);
  if (!validation.valid || validation.evidence === null) {
    return { ok: false, error: { id: "github-generated-evidence-invalid", detail: "generated GitHub Actions evidence does not satisfy CI Evidence Contract v1" } };
  }
  return { ok: true, evidence: validation.evidence };
}
/**
 * @param {string} filename
 * @param {string} label
 * @returns {{ ok: true, value: unknown } | { ok: false, error: { id: string, detail: string } }}
 */
function readJsonFile(filename, label) {
  let contents;
  try {
    contents = fs.readFileSync(filename, "utf8");
  } catch {
    return { ok: false, error: { id: `${label}-file-read-failed`, detail: `${label} file could not be read` } };
  }
  try {
    return { ok: true, value: JSON.parse(contents) };
  } catch {
    return { ok: false, error: { id: `${label}-json-malformed`, detail: `${label} file contains malformed JSON` } };
  }
}

/** @param {import("./ci-evidence.js").CiEvidence} evidence */
export function formatGitHubActionsCiEvidence(evidence) {
  return [
    "GitHub Actions CI evidence",
    "",
    `Commit: ${evidence.commit}`,
    `Workflow: ${evidence.ci.workflow ?? "(not supplied)"}`,
    `Run ID: ${evidence.ci.runId ?? "(not supplied)"}`,
    `Source: ${evidence.evidence.source}`,
    `Authenticated: ${evidence.evidence.authenticated}`,
    `Collected at: ${evidence.evidence.collectedAt}`,
    "Checks:",
    ...evidence.checks.map((check) => `  ${check.name}: ${check.status}`),
  ].join("\n");
}

/**
 * @param {string[]} argv
 * @returns {{ runFile: string, jobsFile: string, collectedAt: string, authenticated: boolean, json: boolean } | null}
 */
function parseArguments(argv) {
  const options = /** @type {{ runFile: string | null, jobsFile: string | null, collectedAt: string | null, authenticated: boolean, json: boolean }} */ ({
    runFile: null,
    jobsFile: null,
    collectedAt: null,
    authenticated: false,
    json: false,
  });
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--authenticated") {
      options.authenticated = true;
    } else if (argument === "--run-file" || argument === "--jobs-file" || argument === "--collected-at") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) return null;
      if (argument === "--run-file") {
        if (options.runFile !== null) return null;
        options.runFile = value;
      }
      if (argument === "--jobs-file") {
        if (options.jobsFile !== null) return null;
        options.jobsFile = value;
      }
      if (argument === "--collected-at") {
        if (options.collectedAt !== null) return null;
        options.collectedAt = value;
      }
      index += 1;
    } else {
      return null;
    }
  }
  if (!options.runFile || !options.jobsFile || !options.collectedAt) return null;
  return {
    runFile: options.runFile,
    jobsFile: options.jobsFile,
    collectedAt: options.collectedAt,
    authenticated: options.authenticated,
    json: options.json,
  };
}
export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/github-actions-ci-evidence.js --run-file <workflow-run.json> --jobs-file <workflow-jobs.json> --collected-at <absolute-iso-timestamp> [--authenticated] [--json]");
    return 1;
  }

  const run = readJsonFile(options.runFile, "workflow run");
  if (!run.ok) {
    console.error(run.error.detail);
    return 1;
  }
  const jobs = readJsonFile(options.jobsFile, "workflow jobs");
  if (!jobs.ok) {
    console.error(jobs.error.detail);
    return 1;
  }
  const result = buildGitHubActionsCiEvidence(run.value, jobs.value, {
    collectedAt: options.collectedAt,
    authenticated: options.authenticated,
  });
  if (!result.ok) {
    console.error(result.error.detail);
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.evidence) : formatGitHubActionsCiEvidence(result.evidence));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
