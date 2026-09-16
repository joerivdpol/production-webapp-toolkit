import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatGitHubProtection,
  inspectGitHubProtection,
  main,
  validateGitHubProtectionPolicy,
} from "../scripts/audit-github-protection.js";

/** @type {string[]} */
const temporaryPaths = [];

/** @typedef {{ ok: true, status: number, value: unknown } | { ok: false, status: number, value: unknown, error: { id: string, detail: string } }} FakeApiResponse */
/** @typedef {{ authCheck: () => boolean, apiGet: (endpoint: string) => FakeApiResponse }} FakeDependencies */

/** @param {Record<string, any>} [overrides] */
function policy(overrides = {}) {
  return {
    version: 1,
    requiredStatusChecks: ["quality"],
    requireStrictStatusChecks: true,
    requirePullRequest: true,
    requireConversationResolution: true,
    requireLinearHistory: true,
    enforceAdmins: true,
    forbidForcePushes: true,
    forbidDeletions: true,
    ...overrides,
  };
}

/** @param {Record<string, any>} [overrides] */
function classicProtection(overrides = {}) {
  return {
    required_status_checks: { strict: true, contexts: ["quality"], checks: [{ context: "quality", app_id: 1 }] },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: {
      dismiss_stale_reviews: false,
      require_code_owner_reviews: false,
      require_last_push_approval: false,
      required_approving_review_count: 0,
    },
    required_linear_history: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false },
    required_conversation_resolution: { enabled: true },
    ...overrides,
  };
}
/** @param {Record<string, any>} [overrides] */
function activeRules(overrides = {}) {
  const rules = [
    {
      type: "required_status_checks",
      ruleset_id: 42,
      ruleset_source_type: "Repository",
      ruleset_source: "owner/repo",
      parameters: {
        strict_required_status_checks_policy: true,
        required_status_checks: [{ context: "quality" }],
      },
    },
    {
      type: "pull_request",
      ruleset_id: 42,
      ruleset_source_type: "Repository",
      ruleset_source: "owner/repo",
      parameters: {
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_approving_review_count: 1,
        required_review_thread_resolution: true,
      },
    },
    { type: "required_linear_history", ruleset_id: 42, ruleset_source_type: "Repository", ruleset_source: "owner/repo" },
    { type: "non_fast_forward", ruleset_id: 42, ruleset_source_type: "Repository", ruleset_source: "owner/repo" },
    { type: "deletion", ruleset_id: 42, ruleset_source_type: "Repository", ruleset_source: "owner/repo" },
  ];
  return overrides.rules ?? rules;
}

/** @param {number} status @param {unknown} value @returns {FakeApiResponse} */
function response(status, value) {
  return status >= 200 && status < 300
    ? { ok: true, status, value }
    : { ok: false, status, value, error: { id: "github-api-request-failed", detail: `HTTP ${status}` } };
}

/** @param {Record<string, any>} [options] */
function fakeDependencies(options = {}) {
  /** @type {string[]} */
  const calls = [];
  return {
    calls,
    dependencies: {
      authCheck: () => options.auth ?? true,
      /** @param {string} endpoint @returns {FakeApiResponse} */
      apiGet: (endpoint) => {
        calls.push(endpoint);
        if (endpoint.endsWith("/protection")) return response(options.classicStatus ?? 200, options.classic ?? classicProtection());
        if (endpoint.includes("/rules/branches/")) return response(options.rulesStatus ?? 200, options.rules ?? []);
        return response(options.branchStatus ?? 200, options.branch ?? { name: "main", protected: options.protected ?? true });
      },
    },
  };
}
/** @param {unknown} value */
function policyFile(value) {
  const filename = path.join(os.tmpdir(), `github-protection-policy-${process.pid}-${temporaryPaths.length}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  temporaryPaths.push(filename);
  return filename;
}

/** @param {FakeDependencies} dependencies @param {...string} args */
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

afterEach(() => {
  for (const filename of temporaryPaths.splice(0)) fs.rmSync(filename, { force: true });
});

test("validates and normalizes explicit protection policies", () => {
  const valid = validateGitHubProtectionPolicy({
    version: 1,
    requiredStatusChecks: [" quality ", "security"],
    minimumApprovals: 2,
    requirePullRequest: true,
    forbidForcePushes: true,
  });
  assert.equal(valid.ok, true);
  if (!valid.ok) return;
  assert.deepEqual(valid.policy.requiredStatusChecks, ["quality", "security"]);
  assert.equal(valid.policy.minimumApprovals, 2);
  assert.equal(valid.policy.requirePullRequest, true);
  assert.equal(valid.policy.enforceAdmins, false);
});

test("rejects empty, ambiguous, duplicate, and unsupported policy fields", () => {
  const invalid = [
    {},
    { version: 2, requirePullRequest: true },
    { version: 1 },
    { version: 1, requirePullRequest: false },
    { version: 1, minimumApprovals: 0 },
    { version: 1, minimumApprovals: 11 },
    { version: 1, requiredStatusChecks: [] },
    { version: 1, requiredStatusChecks: ["quality", " quality "] },
    { version: 1, requirePullRequest: true, surprise: true },
  ];
  for (const candidate of invalid) assert.equal(validateGitHubProtectionPolicy(candidate).ok, false);
});
test("classic branch protection can satisfy an explicit policy", () => {
  const fake = fakeDependencies();
  const result = inspectGitHubProtection({ repository: "owner/repo", branch: "main", policy: policy() }, fake.dependencies);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.sources.classic.availability, "AVAILABLE");
  assert.equal(result.report.sources.rulesets.availability, "AVAILABLE");
  assert.equal(result.report.effective.statusChecks.includes("quality"), true);
  assert.equal(result.report.effective.pullRequestRequired, true);
  assert.equal(result.report.effective.requireConversationResolution, true);
  assert.equal(result.report.effective.requireLinearHistory, true);
  assert.equal(result.report.effective.enforceAdmins, true);
  assert.equal(result.report.effective.forcePushesBlocked, true);
  assert.equal(result.report.effective.deletionsBlocked, true);
  assert.equal(result.report.overallStatus, "PASS");
  assert.ok(result.report.policyChecks.every((check) => check.status === "PASS"));
});

test("active rulesets satisfy branch requirements and layer with classic protection", () => {
  const classic = classicProtection({
    required_status_checks: { strict: false, contexts: ["classic-check"] },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 2 },
    required_linear_history: { enabled: false },
    allow_force_pushes: { enabled: true },
    allow_deletions: { enabled: true },
    required_conversation_resolution: { enabled: false },
  });
  const rules = activeRules({ rules: [
    ...activeRules(),
    {
      type: "required_status_checks",
      ruleset_id: 73,
      ruleset_source_type: "Organization",
      ruleset_source: "org",
      parameters: {
        strict_required_status_checks_policy: false,
        required_status_checks: [{ context: "ruleset-check" }],
      },
    },
    {
      type: "pull_request",
      ruleset_id: 73,
      ruleset_source_type: "Organization",
      ruleset_source: "org",
      parameters: { required_approving_review_count: 3 },
    },
  ] });
  const required = policy({
    requiredStatusChecks: ["classic-check", "quality", "ruleset-check"],
    minimumApprovals: 3,
    enforceAdmins: true,
  });
  const result = inspectGitHubProtection(
    { repository: "owner/repo", branch: "main", policy: required },
    fakeDependencies({ classic, rules }).dependencies,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.report.effective.statusChecks, ["classic-check", "quality", "ruleset-check"]);
  assert.equal(result.report.effective.minimumApprovals, 3);
  assert.equal(result.report.effective.strictStatusChecks, true);
  assert.equal(result.report.effective.activeRulesets.length, 2);
  assert.equal(result.report.overallStatus, "PASS");
});
test("ruleset-only protections can satisfy requirements without claiming admin enforcement", () => {
  const rulesetPolicy = {
    version: 1,
    requiredStatusChecks: ["quality"],
    requireStrictStatusChecks: true,
    requirePullRequest: true,
    minimumApprovals: 1,
    requireConversationResolution: true,
    requireLinearHistory: true,
    forbidForcePushes: true,
    forbidDeletions: true,
  };
  const result = inspectGitHubProtection(
    { repository: "owner/repo", branch: "main", policy: rulesetPolicy },
    fakeDependencies({ protected: true, classicStatus: 404, classic: { message: "not found" }, rules: activeRules() }).dependencies,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.sources.classic.availability, "UNVERIFIED");
  assert.equal(result.report.effective.activeRulesets.length, 1);
  assert.equal(result.report.effective.minimumApprovals, 1);
  assert.equal(result.report.overallStatus, "PASS");
});

test("known absent protections fail policy requirements", () => {
  const result = inspectGitHubProtection(
    { repository: "owner/repo", branch: "main", policy: { version: 1, requiredStatusChecks: ["quality"], requirePullRequest: true } },
    fakeDependencies({ protected: false, classicStatus: 404, classic: { message: "not found" }, rules: [] }).dependencies,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.sources.classic.availability, "ABSENT");
  assert.equal(result.report.sources.rulesets.availability, "AVAILABLE");
  assert.equal(result.report.branchProtected, false);
  assert.equal(result.report.overallStatus, "FAIL");
  assert.ok(result.report.policyChecks.every((check) => check.status === "FAIL"));
});

test("inaccessible protection sources produce UNVERIFIED warnings rather than false failures", () => {
  const result = inspectGitHubProtection(
    { repository: "owner/repo", branch: "main", policy: { version: 1, requiredStatusChecks: ["quality"], requirePullRequest: true } },
    fakeDependencies({ protected: true, classicStatus: 403, rulesStatus: 403 }).dependencies,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.sources.classic.availability, "UNVERIFIED");
  assert.equal(result.report.sources.rulesets.availability, "UNVERIFIED");
  assert.equal(result.report.overallStatus, "WARN");
  assert.ok(result.report.policyChecks.every((check) => check.status === "UNVERIFIED"));
});

test("a known source can prove a requirement even when the other source is unavailable", () => {
  const result = inspectGitHubProtection(
    { repository: "owner/repo", branch: "main", policy: { version: 1, requiredStatusChecks: ["quality"], requireLinearHistory: true } },
    fakeDependencies({ classic: classicProtection(), rulesStatus: 403 }).dependencies,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.report.sources.rulesets.availability, "UNVERIFIED");
  assert.equal(result.report.overallStatus, "PASS");
  assert.ok(result.report.policyChecks.every((check) => check.status === "PASS"));
});
test("admin enforcement remains unverified when only ruleset enforcement is visible", () => {
  const result = inspectGitHubProtection(
    { repository: "owner/repo", branch: "main", policy: { version: 1, enforceAdmins: true } },
    fakeDependencies({ protected: true, classicStatus: 403, rules: activeRules() }).dependencies,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const check = result.report.policyChecks.find((item) => item.id === "enforce-admins");
  assert.equal(check?.status, "UNVERIFIED");
  assert.equal(result.report.overallStatus, "WARN");
});

test("authentication and branch metadata failures stop before policy conclusions", () => {
  let called = false;
  const authFailure = inspectGitHubProtection(
    { repository: "owner/repo", branch: "main", policy: { version: 1, requirePullRequest: true } },
    { authCheck: () => false, apiGet: () => { called = true; return response(200, {}); } },
  );
  assert.equal(authFailure.ok, false);
  if (!authFailure.ok) assert.equal(authFailure.error.id, "github-auth-required");
  assert.equal(called, false);

  const missingBranch = inspectGitHubProtection(
    { repository: "owner/repo", branch: "main", policy: { version: 1, requirePullRequest: true } },
    fakeDependencies({ branchStatus: 404 }).dependencies,
  );
  assert.equal(missingBranch.ok, false);
  if (!missingBranch.ok) assert.equal(missingBranch.error.id, "branch-inspection-failed");
});

test("unexpected provider failures are technical input failures rather than policy FAIL", () => {
  const classicFailure = inspectGitHubProtection(
    { repository: "owner/repo", branch: "main", policy: { version: 1, requirePullRequest: true } },
    fakeDependencies({ classicStatus: 500 }).dependencies,
  );
  assert.equal(classicFailure.ok, false);
  if (!classicFailure.ok) assert.equal(classicFailure.error.id, "classic-protection-inspection-failed");

  const rulesFailure = inspectGitHubProtection(
    { repository: "owner/repo", branch: "main", policy: { version: 1, requirePullRequest: true } },
    fakeDependencies({ rulesStatus: 500 }).dependencies,
  );
  assert.equal(rulesFailure.ok, false);
  if (!rulesFailure.ok) assert.equal(rulesFailure.error.id, "active-rules-inspection-failed");
});

test("branch and repository inputs are explicit and safely encoded", () => {
  const fake = fakeDependencies({ branch: { name: "release/v1", protected: true } });
  const result = inspectGitHubProtection(
    { repository: "owner/repo", branch: "release/v1", policy: { version: 1, requirePullRequest: true } },
    fake.dependencies,
  );
  assert.equal(result.ok, true);
  assert.equal(fake.calls[0], "repos/owner/repo/branches/release%2Fv1");

  for (const options of [
    { repository: "repo-only", branch: "main" },
    { repository: "owner/repo/extra", branch: "main" },
    { repository: "owner/repo", branch: "" },
  ]) {
    const invalid = inspectGitHubProtection({ ...options, policy: { version: 1, requirePullRequest: true } }, { authCheck: () => { throw new Error("must not auth"); } });
    assert.equal(invalid.ok, false);
  }
});
test("CLI emits stable JSON and human output with PASS, WARN, and FAIL exits", () => {
  const passPolicy = policyFile(policy());
  const passFake = fakeDependencies();
  const pass = runMainWith(passFake.dependencies, "--repository", "owner/repo", "--branch", "main", "--policy", passPolicy, "--json");
  assert.equal(pass.status, 0);
  const parsed = JSON.parse(pass.stdout);
  assert.equal(parsed.overallStatus, "PASS");
  assert.equal(parsed.repository, "owner/repo");
  assert.equal(parsed.branch, "main");

  const warnPolicy = policyFile({ version: 1, enforceAdmins: true });
  const warnFake = fakeDependencies({ protected: true, classicStatus: 403, rules: activeRules() });
  const warn = runMainWith(warnFake.dependencies, "--repository", "owner/repo", "--branch", "main", "--policy", warnPolicy);
  assert.equal(warn.status, 0);
  assert.match(warn.stdout, /Overall: WARN/);
  assert.match(warn.stdout, /UNVERIFIED\s+enforce-admins/);

  const failPolicy = policyFile({ version: 1, requirePullRequest: true });
  const failFake = fakeDependencies({ protected: false, classicStatus: 404, rules: [] });
  const fail = runMainWith(failFake.dependencies, "--repository", "owner/repo", "--branch", "main", "--policy", failPolicy);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /Overall: FAIL/);
});

test("CLI rejects unreadable, malformed, invalid, and incomplete policy input", () => {
  const valid = policyFile({ version: 1, requirePullRequest: true });
  const malformed = policyFile("{");
  const invalid = policyFile({ version: 1 });
  const missing = path.join(os.tmpdir(), "github-protection-no-such-policy.json");
  const fake = fakeDependencies();

  for (const args of [
    [],
    ["--repository", "owner/repo", "--branch", "main"],
    ["--repository", "owner/repo", "--branch", "main", "--policy", missing],
    ["--repository", "owner/repo", "--branch", "main", "--policy", malformed],
    ["--repository", "owner/repo", "--branch", "main", "--policy", invalid],
    ["--repository", "owner/repo", "--branch", "main", "--policy", valid, "--unknown"],
  ]) {
    assert.equal(runMainWith(fake.dependencies, ...args).status, 1, args.join(" "));
  }
});

test("human report distinguishes source availability and effective policy state", () => {
  const result = inspectGitHubProtection(
    { repository: "owner/repo", branch: "main", policy: policy() },
    fakeDependencies().dependencies,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const human = formatGitHubProtection(result.report);
  for (const label of [
    "GitHub protection audit",
    "Classic protection: AVAILABLE",
    "Active rules: AVAILABLE",
    "Required status checks: quality",
    "Strict status checks: true",
    "Technical: PASS",
    "Overall: PASS",
  ]) assert.match(human, new RegExp(label));
});

test("online audit operational surface is authenticated GitHub CLI GET only", () => {
  const source = fs.readFileSync(path.resolve("scripts/audit-github-protection.js"), "utf8");
  assert.match(source, /spawnSync\("gh"/);
  assert.match(source, /\["auth", "status", "--hostname", "github\.com"\]/);
  assert.match(source, /\["api", "--include", "--method", "GET", endpoint\]/);
  assert.doesNotMatch(source, /shell:\s*true/);
  assert.doesNotMatch(source, /process\.env|auth\s+token|--method["', ]+(POST|PUT|PATCH|DELETE)|writeFile|rmSync|unlink/);
});
