import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import {
  collectGitHubActionsCiEvidence,
  main,
} from "../scripts/collect-github-actions-ci-evidence.js";
import { validateCiEvidence } from "../scripts/ci-evidence.js";

const SHA1 = "0123456789abcdef0123456789abcdef01234567";

/** @param {Record<string, any>} [overrides] */
function runPayload(overrides = {}) {
  return {
    id: 123,
    name: "CI",
    head_sha: SHA1,
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

/** @param {Record<string, any>} [overrides] */
function job(overrides = {}) {
  return {
    id: 1,
    run_id: 123,
    name: "quality",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}
/**
 * @param {{ pages?: Array<Record<string, any>>, run?: Record<string, any>, auth?: boolean, now?: string }} [options]
 * @returns {{ calls: string[], dependencies: { authCheck: () => boolean, apiGet: (endpoint: string) => { ok: true, value: unknown } | { ok: false, error: { id: string, detail: string } }, now: () => string } }}
 */
function fakeDependencies(options = {}) {
  const calls = /** @type {string[]} */ ([]);
  const pages = options.pages ?? [{ total_count: 1, jobs: [job()] }];
  const dependencies = /** @type {{ authCheck: () => boolean, apiGet: (endpoint: string) => { ok: true, value: unknown } | { ok: false, error: { id: string, detail: string } }, now: () => string }} */ ({
    authCheck: () => options.auth ?? true,
    apiGet: (endpoint) => {
      calls.push(endpoint);
      if (!endpoint.includes("/jobs?")) return { ok: true, value: options.run ?? runPayload() };
      const page = Number(new URL(`https://example.invalid/${endpoint}`).searchParams.get("page"));
      return { ok: true, value: pages[page - 1] ?? { total_count: pages[0]?.total_count ?? 0, jobs: [] } };
    },
    now: () => options.now ?? "2026-09-16T08:00:00Z",
  });
  return { calls, dependencies };
}

/**
 * @param {{ authCheck?: () => boolean, apiGet?: (endpoint: string) => { ok: true, value: unknown } | { ok: false, error: { id: string, detail: string } }, now?: () => string }} dependencies
 * @param {...string} args
 */
function runMainWith(dependencies, ...args) {
  let stdout = "";
  let stderr = "";
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    return { status: main(args, dependencies), stdout, stderr };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

test("collects an explicit authenticated GitHub Actions run", () => {
  const fake = fakeDependencies();
  const result = collectGitHubActionsCiEvidence(
    { repository: "owner/repo", runId: "123" },
    fake.dependencies,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(validateCiEvidence(result.evidence).valid, true);
  assert.equal(result.evidence.commit, SHA1);
  assert.equal(result.evidence.evidence.source, "github-cli-api");
  assert.equal(result.evidence.evidence.authenticated, true);
  assert.equal(result.evidence.evidence.collectedAt, "2026-09-16T08:00:00Z");
  assert.deepEqual(result.evidence.checks, [{ name: "quality", status: "PASS" }]);
  assert.deepEqual(fake.calls, [
    "repos/owner/repo/actions/runs/123",
    "repos/owner/repo/actions/runs/123/jobs?per_page=100&page=1",
  ]);
});
test("paginates jobs until GitHub total_count is reached", () => {
  const fake = fakeDependencies({
    pages: [
      { total_count: 2, jobs: [job({ name: "quality" })] },
      { total_count: 2, jobs: [job({ id: 2, name: "security" })] },
    ],
  });
  const result = collectGitHubActionsCiEvidence({ repository: "owner/repo", runId: "123" }, fake.dependencies);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.collection.pages, 2);
  assert.deepEqual(result.evidence.checks.map((check) => check.name), ["quality", "security"]);
  assert.equal(fake.calls.at(-1), "repos/owner/repo/actions/runs/123/jobs?per_page=100&page=2");
});

test("requires GitHub CLI authentication before API collection", () => {
  let called = false;
  const result = collectGitHubActionsCiEvidence(
    { repository: "owner/repo", runId: "123" },
    {
      authCheck: () => false,
      apiGet: () => {
        called = true;
        return { ok: true, value: {} };
      },
    },
  );
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.id, "github-auth-required");
  assert.equal(called, false);
});

test("rejects invalid repository slugs and run identifiers before collection", () => {
  for (const options of [
    { repository: "repo-only", runId: "123" },
    { repository: "owner/repo/extra", runId: "123" },
    { repository: "owner/repo", runId: "0" },
    { repository: "owner/repo", runId: "HEAD" },
  ]) {
    const result = collectGitHubActionsCiEvidence(options, {
      authCheck: () => { throw new Error("auth should not run"); },
    });
    assert.equal(result.ok, false);
  }
});
test("propagates API failures without exposing provider stderr", () => {
  const runFailure = collectGitHubActionsCiEvidence(
    { repository: "owner/repo", runId: "123" },
    {
      authCheck: () => true,
      apiGet: () => ({ ok: false, error: { id: "github-api-request-failed", detail: "GitHub API request failed" } }),
    },
  );
  assert.equal(runFailure.ok, false);
  if (!runFailure.ok) assert.deepEqual(runFailure.error, { id: "github-api-request-failed", detail: "GitHub API request failed" });

  let calls = 0;
  const jobsFailure = collectGitHubActionsCiEvidence(
    { repository: "owner/repo", runId: "123" },
    {
      authCheck: () => true,
      apiGet: () => {
        calls += 1;
        return calls === 1
          ? { ok: true, value: runPayload() }
          : { ok: false, error: { id: "github-api-request-failed", detail: "GitHub API request failed" } };
      },
    },
  );
  assert.equal(jobsFailure.ok, false);
  if (!jobsFailure.ok) assert.equal(jobsFailure.error.id, "github-api-request-failed");
});

test("rejects malformed jobs API responses and incomplete pagination", () => {
  const malformed = collectGitHubActionsCiEvidence(
    { repository: "owner/repo", runId: "123" },
    {
      authCheck: () => true,
      apiGet: (endpoint) => endpoint.includes("/jobs?")
        ? { ok: true, value: { total_count: 1 } }
        : { ok: true, value: runPayload() },
    },
  );
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.id, "github-jobs-response-invalid");

  const incomplete = fakeDependencies({ pages: [{ total_count: 2, jobs: [] }] });
  const result = collectGitHubActionsCiEvidence({ repository: "owner/repo", runId: "123" }, incomplete.dependencies);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.id, "github-jobs-pagination-incomplete");
});
test("CLI emits canonical JSON with injected collector dependencies", () => {
  const fake = fakeDependencies();
  const result = runMainWith(
    fake.dependencies,
    "--repository", "owner/repo",
    "--run-id", "123",
    "--json",
  );
  assert.equal(result.status, 0);
  const evidence = JSON.parse(result.stdout);
  assert.equal(validateCiEvidence(evidence).valid, true);
  assert.equal(evidence.evidence.source, "github-cli-api");
  assert.equal(evidence.evidence.authenticated, true);
});

test("CLI rejects incomplete arguments and reports collection failures generically", () => {
  const fake = fakeDependencies();
  for (const args of [
    [],
    ["--repository", "owner/repo"],
    ["--run-id", "123"],
    ["--repository", "owner/repo", "--run-id", "123", "--unknown"],
  ]) {
    assert.equal(runMainWith(fake.dependencies, ...args).status, 1);
  }

  const failed = runMainWith(
    {
      authCheck: () => true,
      apiGet: () => ({ ok: false, error: { id: "github-api-request-failed", detail: "GitHub API request failed" } }),
    },
    "--repository", "owner/repo",
    "--run-id", "123",
  );
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /GitHub API request failed/);
  assert.doesNotMatch(failed.stderr, /token|authorization|secret/i);
});

test("collector limits its operational surface to authenticated GitHub CLI GET requests", () => {
  const source = fs.readFileSync(path.resolve("scripts/collect-github-actions-ci-evidence.js"), "utf8");
  assert.match(source, /spawnSync\("gh"/);
  assert.match(source, /\["auth", "status", "--hostname", "github\.com"\]/);
  assert.match(source, /\["api", "--method", "GET", endpoint\]/);
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.doesNotMatch(source, /process\.env|auth\s+token|writeFile|unlink|rmSync|git\s/);
});
