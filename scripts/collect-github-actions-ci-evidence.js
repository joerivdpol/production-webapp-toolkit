#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  buildGitHubActionsCiEvidence,
  formatGitHubActionsCiEvidence,
} from "./github-actions-ci-evidence.js";

const MAX_API_BYTES = 16 * 1024 * 1024;
const JOBS_PER_PAGE = 100;

/** @param {unknown} value */
function normalizeRepository(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/.test(normalized)) return null;
  const [owner, repository] = normalized.split("/");
  return owner && repository ? { slug: normalized, owner, repository } : null;
}

/** @param {unknown} value */
function normalizeRunId(value) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return /^[1-9]\d*$/.test(normalized) ? normalized : null;
}

function githubCliAuthCheck() {
  const result = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], {
    encoding: "utf8",
    maxBuffer: MAX_API_BYTES,
  });
  return result.status === 0;
}
/**
 * @param {string} endpoint
 * @returns {{ ok: true, value: unknown } | { ok: false, error: { id: string, detail: string } }}
 */
function githubCliApiGet(endpoint) {
  const result = spawnSync("gh", ["api", "--method", "GET", endpoint], {
    encoding: "utf8",
    maxBuffer: MAX_API_BYTES,
  });
  if (result.status !== 0) {
    return { ok: false, error: { id: "github-api-request-failed", detail: "GitHub API request failed" } };
  }
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, error: { id: "github-api-json-invalid", detail: "GitHub API returned invalid JSON" } };
  }
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * @param {{ repository: unknown, runId: unknown }} options
 * @param {{ authCheck?: () => boolean, apiGet?: (endpoint: string) => { ok: true, value: unknown } | { ok: false, error: { id: string, detail: string } }, now?: () => string }} [dependencies]
 * @returns {{ ok: true, evidence: import("./ci-evidence.js").CiEvidence, collection: { repository: string, runId: string, pages: number } } | { ok: false, error: { id: string, detail: string } }}
 */
export function collectGitHubActionsCiEvidence(options, dependencies = {}) {
  const repository = normalizeRepository(options.repository);
  if (repository === null) {
    return { ok: false, error: { id: "github-repository-invalid", detail: "repository must be an explicit owner/name slug" } };
  }
  const runId = normalizeRunId(options.runId);
  if (runId === null) {
    return { ok: false, error: { id: "github-run-id-invalid", detail: "runId must be a positive integer identifier" } };
  }

  const authCheck = dependencies.authCheck ?? githubCliAuthCheck;
  if (!authCheck()) {
    return { ok: false, error: { id: "github-auth-required", detail: "GitHub CLI authentication for github.com is required" } };
  }
  const apiGet = dependencies.apiGet ?? githubCliApiGet;
  const owner = encodeURIComponent(repository.owner);
  const name = encodeURIComponent(repository.repository);
  const runEndpoint = `repos/${owner}/${name}/actions/runs/${runId}`;
  const runResult = apiGet(runEndpoint);
  if (!runResult.ok) return runResult;

  /** @type {unknown[]} */
  const jobs = [];
  let expectedTotal = null;
  let pagesFetched = 0;
  for (let page = 1; page <= 1000; page += 1) {
    const jobsEndpoint = `repos/${owner}/${name}/actions/runs/${runId}/jobs?per_page=${JOBS_PER_PAGE}&page=${page}`;
    const pageResult = apiGet(jobsEndpoint);
    if (!pageResult.ok) return pageResult;
    pagesFetched += 1;
    if (!isPlainObject(pageResult.value) || !Array.isArray(pageResult.value.jobs)) {
      return { ok: false, error: { id: "github-jobs-response-invalid", detail: "GitHub jobs API response must contain a jobs array" } };
    }
    if (expectedTotal === null) {
      const total = pageResult.value.total_count;
      if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) {
        return { ok: false, error: { id: "github-jobs-total-invalid", detail: "GitHub jobs API total_count must be a non-negative safe integer" } };
      }
      expectedTotal = total;
    }
    jobs.push(...pageResult.value.jobs);
    if (jobs.length >= expectedTotal) break;
    if (pageResult.value.jobs.length === 0) {
      return { ok: false, error: { id: "github-jobs-pagination-incomplete", detail: "GitHub jobs pagination ended before total_count was reached" } };
    }
  }
  if (expectedTotal === null || jobs.length !== expectedTotal) {
    return { ok: false, error: { id: "github-jobs-pagination-incomplete", detail: "GitHub jobs pagination did not produce exactly total_count jobs" } };
  }

  const now = dependencies.now ?? (() => new Date().toISOString());
  const evidence = buildGitHubActionsCiEvidence(runResult.value, { total_count: expectedTotal, jobs }, {
    collectedAt: now(),
    authenticated: true,
    source: "github-cli-api",
  });
  if (!evidence.ok) return evidence;
  return {
    ok: true,
    evidence: evidence.evidence,
    collection: {
      repository: repository.slug,
      runId,
      pages: pagesFetched,
    },
  };
}

/**
 * @param {string[]} argv
 * @returns {{ repository: string, runId: string, json: boolean } | null}
 */
function parseArguments(argv) {
  const options = /** @type {{ repository: string | null, runId: string | null, json: boolean }} */ ({
    repository: null,
    runId: null,
    json: false,
  });
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--repository" || argument === "--run-id") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) return null;
      if (argument === "--repository") {
        if (options.repository !== null) return null;
        options.repository = value;
      }
      if (argument === "--run-id") {
        if (options.runId !== null) return null;
        options.runId = value;
      }
      index += 1;
    } else {
      return null;
    }
  }
  if (!options.repository || !options.runId) return null;
  return { repository: options.repository, runId: options.runId, json: options.json };
}
/**
 * @param {string[]} argv
 * @param {{ authCheck?: () => boolean, apiGet?: (endpoint: string) => { ok: true, value: unknown } | { ok: false, error: { id: string, detail: string } }, now?: () => string }} [dependencies]
 */
export function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/collect-github-actions-ci-evidence.js --repository <owner/name> --run-id <id> [--json]");
    return 1;
  }
  const result = collectGitHubActionsCiEvidence(options, dependencies);
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
