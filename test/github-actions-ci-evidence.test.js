import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildGitHubActionsCiEvidence,
  formatGitHubActionsCiEvidence,
  main,
} from "../scripts/github-actions-ci-evidence.js";
import { validateCiEvidence } from "../scripts/ci-evidence.js";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";
/** @type {string[]} */
const temporaryPaths = [];

/** @param {Record<string, any>} [overrides] @returns {Record<string, any>} */
function runPayload(overrides = {}) {
  return {
    id: 35069093015,
    name: "CI",
    head_sha: SHA1,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

/** @param {Record<string, any>} [overrides] @returns {Record<string, any>} */
function job(overrides = {}) {
  return {
    id: 104706108723,
    run_id: 35069093015,
    name: "quality",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}
/** @param {Array<Record<string, any>>} [jobs] */
function jobsPayload(jobs = [job()]) {
  return { total_count: jobs.length, jobs };
}

/** @param {unknown} value @param {string} suffix */
function jsonFile(value, suffix) {
  const filename = path.join(os.tmpdir(), `github-actions-ci-${process.pid}-${temporaryPaths.length}-${suffix}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  temporaryPaths.push(filename);
  return filename;
}

/** @param {...string} args */
function runCli(...args) {
  let stdout = "";
  let stderr = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    return { status: main(args), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

afterEach(() => {
  for (const filename of temporaryPaths.splice(0)) fs.rmSync(filename, { force: true });
});

test("maps completed GitHub Actions jobs into canonical CI Evidence", () => {
  const result = buildGitHubActionsCiEvidence(
    runPayload(),
    jobsPayload([
      job({ name: "quality", conclusion: "success" }),
      job({ id: 2, name: "optional", conclusion: "failure" }),
      job({ id: 3, name: "docs", conclusion: "skipped" }),
      job({ id: 4, name: "neutral-check", conclusion: "neutral" }),
    ]),
    { collectedAt: "2026-09-16T07:34:00Z" },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(validateCiEvidence(result.evidence).valid, true);
  assert.deepEqual(result.evidence.checks, [
    { name: "quality", status: "PASS" },
    { name: "optional", status: "FAIL" },
    { name: "docs", status: "SKIPPED" },
    { name: "neutral-check", status: "SKIPPED" },
  ]);
});
test("normalizes GitHub identifiers, workflow name, and uppercase commit", () => {
  const result = buildGitHubActionsCiEvidence(
    runPayload({ id: "35069093015", name: " CI ", head_sha: SHA1.toUpperCase() }),
    jobsPayload([job({ run_id: "35069093015", name: " quality " })]),
    { collectedAt: "2026-09-16T14:34:00+07:00", authenticated: true },
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.evidence.commit, SHA1);
  assert.deepEqual(result.evidence.ci, { provider: "github-actions", workflow: "CI", runId: "35069093015" });
  assert.equal(result.evidence.evidence.source, "github-actions-api-payload");
  assert.equal(result.evidence.evidence.authenticated, true);
  assert.deepEqual(result.evidence.checks, [{ name: "quality", status: "PASS" }]);
});

test("rejects incomplete or structurally invalid workflow runs", () => {
  const cases = [
    [runPayload({ id: 0 }), "github-run-id-invalid"],
    [runPayload({ name: " " }), "github-workflow-name-invalid"],
    [runPayload({ head_sha: "HEAD" }), "github-head-sha-invalid"],
    [runPayload({ status: "in_progress", conclusion: null }), "github-run-incomplete"],
    [runPayload({ conclusion: null }), "github-run-conclusion-missing"],
  ];
  for (const [run, id] of cases) {
    const result = buildGitHubActionsCiEvidence(run, jobsPayload(), { collectedAt: "2026-09-16T07:34:00Z" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.id, id);
  }
});

test("rejects empty, mismatched, duplicate, incomplete, or unsupported jobs", () => {
  const cases = [
    [jobsPayload([]), "github-jobs-empty"],
    [jobsPayload([job({ run_id: 1 })]), "github-job-run-mismatch"],
    [jobsPayload([job({ name: "quality" }), job({ id: 2, name: " quality " })]), "github-job-name-duplicate"],
    [jobsPayload([job({ status: "in_progress", conclusion: null })]), "github-job-incomplete"],
    [jobsPayload([job({ conclusion: "unknown-new-state" })]), "github-job-conclusion-unsupported"],
  ];
  for (const [jobs, id] of cases) {
    const result = buildGitHubActionsCiEvidence(runPayload(), jobs, { collectedAt: "2026-09-16T07:34:00Z" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.id, id);
  }
});
test("requires explicit collection time and boolean authentication metadata", () => {
  for (const options of [
    { collectedAt: "" },
    { collectedAt: "2026-09-16T07:34:00" },
    { collectedAt: "not-a-time" },
  ]) {
    const result = buildGitHubActionsCiEvidence(runPayload(), jobsPayload(), options);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.id, "github-collected-at-invalid");
  }
  const invalidAuth = buildGitHubActionsCiEvidence(runPayload(), jobsPayload(), {
    collectedAt: "2026-09-16T07:34:00Z",
    authenticated: "true",
  });
  assert.equal(invalidAuth.ok, false);
  if (!invalidAuth.ok) assert.equal(invalidAuth.error.id, "github-authenticated-invalid");
});

test("CLI emits canonical JSON and does not modify input payloads", () => {
  const runFile = jsonFile(runPayload(), "run");
  const jobsFile = jsonFile(jobsPayload(), "jobs");
  const runBefore = fs.readFileSync(runFile, "utf8");
  const jobsBefore = fs.readFileSync(jobsFile, "utf8");

  const result = runCli(
    "--run-file", runFile,
    "--jobs-file", jobsFile,
    "--collected-at", "2026-09-16T07:34:00Z",
    "--authenticated",
    "--json",
  );
  assert.equal(result.status, 0);
  const evidence = JSON.parse(result.stdout);
  assert.equal(validateCiEvidence(evidence).valid, true);
  assert.equal(evidence.evidence.authenticated, true);
  assert.equal(evidence.checks[0]?.name, "quality");
  assert.equal(fs.readFileSync(runFile, "utf8"), runBefore);
  assert.equal(fs.readFileSync(jobsFile, "utf8"), jobsBefore);
});

test("human output exposes provider evidence without claiming verification", () => {
  const result = buildGitHubActionsCiEvidence(runPayload(), jobsPayload(), { collectedAt: "2026-09-16T07:34:00Z" });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const human = formatGitHubActionsCiEvidence(result.evidence);
  for (const label of ["GitHub Actions CI evidence", "Commit:", "Workflow:", "Run ID:", "Source:", "Authenticated:", "Collected at:", "quality: PASS"]) {
    assert.match(human, new RegExp(label));
  }
  assert.doesNotMatch(human, /verified|verification/i);
});
test("CLI rejects malformed or missing payload files and invalid arguments", () => {
  const runFile = jsonFile(runPayload(), "run");
  const jobsFile = jsonFile(jobsPayload(), "jobs");
  const malformed = jsonFile("{", "malformed");
  const missing = path.join(os.tmpdir(), "github-actions-ci-no-such-file.json");

  for (const result of [
    runCli(),
    runCli("--run-file", runFile, "--jobs-file", jobsFile),
    runCli("--run-file", malformed, "--jobs-file", jobsFile, "--collected-at", "2026-09-16T07:34:00Z"),
    runCli("--run-file", missing, "--jobs-file", jobsFile, "--collected-at", "2026-09-16T07:34:00Z"),
    runCli("--run-file", runFile, "--jobs-file", malformed, "--collected-at", "2026-09-16T07:34:00Z"),
    runCli("--run-file", runFile, "--jobs-file", jobsFile, "--collected-at", "2026-09-16T07:34:00Z", "--unknown"),
  ]) {
    assert.equal(result.status, 1);
  }
});

test("adapter reuses the canonical CI contract and has no collection or mutation surface", () => {
  const source = fs.readFileSync(path.resolve("scripts/github-actions-ci-evidence.js"), "utf8");
  assert.match(source, /validateCiEvidence/);
  assert.match(source, /isAbsoluteIsoTimestamp/);
  assert.match(source, /isFullObjectId/);
  for (const forbidden of ["child_process", "spawnSync", "execFile", "fetch(", "process.env", "https://", "http://", "writeFile"]) {
    assert.equal(source.includes(forbidden), false, `forbidden ${forbidden} surface`);
  }
});
