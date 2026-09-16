#!/usr/bin/env node

import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const POLICY_VERSION = 1;
const MAX_API_BYTES = 16 * 1024 * 1024;
const BOOLEAN_REQUIREMENTS = [
  "requireStrictStatusChecks",
  "requirePullRequest",
  "dismissStaleReviews",
  "requireCodeOwnerReview",
  "requireLastPushApproval",
  "requireConversationResolution",
  "requireLinearHistory",
  "enforceAdmins",
  "forbidForcePushes",
  "forbidDeletions",
];

/** @typedef {"AVAILABLE" | "ABSENT" | "UNVERIFIED"} SourceAvailability */
/** @typedef {"PASS" | "FAIL" | "UNVERIFIED"} PolicyCheckStatus */
/** @typedef {{ id: string, status: PolicyCheckStatus, detail: string }} PolicyCheck */
/** @typedef {{ id: number, sourceType: string | null, source: string | null }} ActiveRuleset */
/** @typedef {{ statusChecks: string[], strictStatusChecks: boolean, pullRequestRequired: boolean, minimumApprovals: number, dismissStaleReviews: boolean, requireCodeOwnerReview: boolean, requireLastPushApproval: boolean, requireConversationResolution: boolean, requireLinearHistory: boolean, enforceAdmins: boolean, forcePushesBlocked: boolean, deletionsBlocked: boolean }} ProtectionShape */
/** @typedef {ProtectionShape & { ruleTypes: string[], activeRulesets: ActiveRuleset[] }} RulesProtection */
/** @typedef {ProtectionShape & { activeRuleTypes: string[], activeRulesets: ActiveRuleset[] }} EffectiveProtection */
/** @typedef {{ version: 1, requiredStatusChecks: string[], minimumApprovals: number | null, requireStrictStatusChecks: boolean, requirePullRequest: boolean, dismissStaleReviews: boolean, requireCodeOwnerReview: boolean, requireLastPushApproval: boolean, requireConversationResolution: boolean, requireLinearHistory: boolean, enforceAdmins: boolean, forbidForcePushes: boolean, forbidDeletions: boolean }} GitHubProtectionPolicy */
/** @typedef {{ repository: string, branch: string, branchProtected: boolean, sources: { classic: { availability: SourceAvailability, protection: ProtectionShape | null }, rulesets: { availability: SourceAvailability, active: RulesProtection | null } }, effective: EffectiveProtection, policy: GitHubProtectionPolicy, policyChecks: PolicyCheck[], technicalStatus: "PASS", overallStatus: "PASS" | "WARN" | "FAIL" }} GitHubProtectionReport */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** @param {unknown} value */
function normalizeString(value) {
  return typeof value === "string" ? value.trim() : null;
}

/** @param {unknown} value */
function normalizeRepository(value) {
  const normalized = normalizeString(value);
  if (!normalized || !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]+$/.test(normalized)) return null;
  const [owner, repository] = normalized.split("/");
  return owner && repository ? { slug: normalized, owner, repository } : null;
}

/** @param {unknown} value */
function normalizeBranch(value) {
  const normalized = normalizeString(value);
  if (!normalized || normalized.length > 255 || /[\x00-\x1F\x7F]/.test(normalized)) return null;
  return normalized;
}
/**
 * @param {unknown} value
 * @returns {{ ok: true, policy: GitHubProtectionPolicy } | { ok: false, error: { id: string, detail: string } }}
 */
export function validateGitHubProtectionPolicy(value) {
  if (!isPlainObject(value)) {
    return { ok: false, error: { id: "policy-invalid", detail: "GitHub protection policy must be a JSON object" } };
  }
  const allowed = new Set(["version", "requiredStatusChecks", "minimumApprovals", ...BOOLEAN_REQUIREMENTS]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) return { ok: false, error: { id: "policy-field-unknown", detail: `policy contains unsupported version ${POLICY_VERSION} field "${key}"` } };
  }
  if (value.version !== POLICY_VERSION) {
    return { ok: false, error: { id: "policy-version-invalid", detail: `policy version must be exactly ${POLICY_VERSION}` } };
  }

  /** @type {string[]} */
  const requiredStatusChecks = [];
  if (value.requiredStatusChecks !== undefined) {
    if (!Array.isArray(value.requiredStatusChecks) || value.requiredStatusChecks.length === 0) {
      return { ok: false, error: { id: "policy-status-checks-invalid", detail: "requiredStatusChecks must be a non-empty array when supplied" } };
    }
    const seen = new Set();
    for (const raw of value.requiredStatusChecks) {
      const name = normalizeString(raw);
      if (!name) return { ok: false, error: { id: "policy-status-check-invalid", detail: "required status check names must be non-empty strings" } };
      if (seen.has(name)) return { ok: false, error: { id: "policy-status-check-duplicate", detail: `requiredStatusChecks contains duplicate normalized name "${name}"` } };
      seen.add(name);
      requiredStatusChecks.push(name);
    }
  }

  let minimumApprovals = null;
  if (value.minimumApprovals !== undefined) {
    if (typeof value.minimumApprovals !== "number" || !Number.isSafeInteger(value.minimumApprovals) || value.minimumApprovals < 1 || value.minimumApprovals > 10) {
      return { ok: false, error: { id: "policy-minimum-approvals-invalid", detail: "minimumApprovals must be an integer from 1 through 10" } };
    }
    minimumApprovals = value.minimumApprovals;
  }

  for (const key of BOOLEAN_REQUIREMENTS) {
    const candidate = value[key];
    if (candidate !== undefined && candidate !== true) {
      return { ok: false, error: { id: "policy-requirement-invalid", detail: `${key} may only be supplied as true` } };
    }
  }
  /** @type {GitHubProtectionPolicy} */
  const normalized = {
    version: 1,
    requiredStatusChecks,
    minimumApprovals,
    requireStrictStatusChecks: value.requireStrictStatusChecks === true,
    requirePullRequest: value.requirePullRequest === true,
    dismissStaleReviews: value.dismissStaleReviews === true,
    requireCodeOwnerReview: value.requireCodeOwnerReview === true,
    requireLastPushApproval: value.requireLastPushApproval === true,
    requireConversationResolution: value.requireConversationResolution === true,
    requireLinearHistory: value.requireLinearHistory === true,
    enforceAdmins: value.enforceAdmins === true,
    forbidForcePushes: value.forbidForcePushes === true,
    forbidDeletions: value.forbidDeletions === true,
  };
  const hasRequirement = requiredStatusChecks.length > 0 || minimumApprovals !== null || BOOLEAN_REQUIREMENTS.some((key) => value[key] === true);
  if (!hasRequirement) {
    return { ok: false, error: { id: "policy-empty", detail: "policy must declare at least one protection requirement" } };
  }
  return { ok: true, policy: normalized };
}
function githubCliAuthCheck() {
  const result = spawnSync("gh", ["auth", "status", "--hostname", "github.com"], {
    encoding: "utf8",
    maxBuffer: MAX_API_BYTES,
  });
  return result.status === 0;
}

/**
 * @param {string} output
 * @returns {{ ok: true, status: number, value: unknown } | { ok: false, error: { id: string, detail: string } }}
 */
function parseIncludedApiResponse(output) {
  const normalized = output.replace(/\r\n/g, "\n");
  const separator = normalized.indexOf("\n\n");
  const headers = separator >= 0 ? normalized.slice(0, separator) : normalized;
  const body = separator >= 0 ? normalized.slice(separator + 2) : "";
  const statusMatch = /^HTTP\/\S+\s+(\d{3})\b/m.exec(headers);
  if (!statusMatch) return { ok: false, error: { id: "github-api-status-missing", detail: "GitHub API response did not contain an HTTP status" } };
  const status = Number(statusMatch[1]);
  let value = null;
  if (body.trim().length > 0) {
    try {
      value = JSON.parse(body);
    } catch {
      return { ok: false, error: { id: "github-api-json-invalid", detail: "GitHub API returned invalid JSON" } };
    }
  }
  return { ok: true, status, value };
}

/**
 * @param {string} endpoint
 * @returns {{ ok: true, status: number, value: unknown } | { ok: false, status: number | null, value?: unknown, error: { id: string, detail: string } }}
 */
function githubCliApiGet(endpoint) {
  const result = spawnSync("gh", ["api", "--include", "--method", "GET", endpoint], {
    encoding: "utf8",
    maxBuffer: MAX_API_BYTES,
  });
  const parsed = parseIncludedApiResponse(result.stdout ?? "");
  if (!parsed.ok) {
    return { ok: false, status: null, error: parsed.error };
  }
  if (parsed.status >= 200 && parsed.status < 300) {
    return { ok: true, status: parsed.status, value: parsed.value };
  }
  return {
    ok: false,
    status: parsed.status,
    value: parsed.value,
    error: { id: "github-api-request-failed", detail: `GitHub API request returned HTTP ${parsed.status}` },
  };
}

/** @param {unknown} value */
function enabled(value) {
  return isPlainObject(value) && value.enabled === true;
}

/** @param {unknown} value */
function disabled(value) {
  return isPlainObject(value) && value.enabled === false;
}

/** @param {unknown} payload @returns {ProtectionShape | null} */
function inspectClassicProtection(payload) {
  if (!isPlainObject(payload)) return null;
  const requiredStatusChecks = isPlainObject(payload.required_status_checks) ? payload.required_status_checks : null;
  const statusContexts = /** @type {Set<string>} */ (new Set());
  if (requiredStatusChecks) {
    if (Array.isArray(requiredStatusChecks.contexts)) {
      for (const raw of requiredStatusChecks.contexts) {
        const context = normalizeString(raw);
        if (context) statusContexts.add(context);
      }
    }
    if (Array.isArray(requiredStatusChecks.checks)) {
      for (const raw of requiredStatusChecks.checks) {
        if (!isPlainObject(raw)) continue;
        const context = normalizeString(raw.context);
        if (context) statusContexts.add(context);
      }
    }
  }

  const reviews = isPlainObject(payload.required_pull_request_reviews)
    ? payload.required_pull_request_reviews
    : null;
  return {
    statusChecks: [...statusContexts],
    strictStatusChecks: requiredStatusChecks?.strict === true,
    pullRequestRequired: reviews !== null,
    minimumApprovals: reviews && typeof reviews.required_approving_review_count === "number"
      ? reviews.required_approving_review_count
      : 0,
    dismissStaleReviews: reviews?.dismiss_stale_reviews === true,
    requireCodeOwnerReview: reviews?.require_code_owner_reviews === true,
    requireLastPushApproval: reviews?.require_last_push_approval === true,
    requireConversationResolution: enabled(payload.required_conversation_resolution),
    requireLinearHistory: enabled(payload.required_linear_history),
    enforceAdmins: enabled(payload.enforce_admins),
    forcePushesBlocked: disabled(payload.allow_force_pushes),
    deletionsBlocked: disabled(payload.allow_deletions),
  };
}

/** @param {unknown} payload @returns {RulesProtection | null} */
function inspectActiveRules(payload) {
  if (!Array.isArray(payload)) return null;
  const statusContexts = /** @type {Set<string>} */ (new Set());
  let strictStatusChecks = false;
  let pullRequestRequired = false;
  let minimumApprovals = 0;
  let dismissStaleReviews = false;
  let requireCodeOwnerReview = false;
  let requireLastPushApproval = false;
  let requireConversationResolution = false;
  let requireLinearHistory = false;
  let forcePushesBlocked = false;
  let deletionsBlocked = false;
  const ruleTypes = /** @type {Set<string>} */ (new Set());
  const rulesets = /** @type {Map<number, ActiveRuleset>} */ (new Map());

  for (const rawRule of payload) {
    if (!isPlainObject(rawRule)) continue;
    const type = normalizeString(rawRule.type);
    if (!type) continue;
    ruleTypes.add(type);
    const rulesetId = typeof rawRule.ruleset_id === "number" && Number.isSafeInteger(rawRule.ruleset_id)
      ? rawRule.ruleset_id
      : null;
    if (rulesetId !== null && !rulesets.has(rulesetId)) {
      rulesets.set(rulesetId, {
        id: rulesetId,
        sourceType: normalizeString(rawRule.ruleset_source_type),
        source: normalizeString(rawRule.ruleset_source),
      });
    }
    const parameters = isPlainObject(rawRule.parameters) ? rawRule.parameters : {};
    if (type === "required_status_checks") {
      strictStatusChecks ||= parameters.strict_required_status_checks_policy === true;
      if (Array.isArray(parameters.required_status_checks)) {
        for (const rawCheck of parameters.required_status_checks) {
          if (!isPlainObject(rawCheck)) continue;
          const context = normalizeString(rawCheck.context);
          if (context) statusContexts.add(context);
        }
      }
    }
    if (type === "pull_request") {
      pullRequestRequired = true;
      if (typeof parameters.required_approving_review_count === "number" && Number.isSafeInteger(parameters.required_approving_review_count)) {
        minimumApprovals = Math.max(minimumApprovals, parameters.required_approving_review_count);
      }
      dismissStaleReviews ||= parameters.dismiss_stale_reviews_on_push === true;
      requireCodeOwnerReview ||= parameters.require_code_owner_review === true;
      requireLastPushApproval ||= parameters.require_last_push_approval === true;
      requireConversationResolution ||= parameters.required_review_thread_resolution === true;
    }
    if (type === "required_review_thread_resolution") requireConversationResolution = true;
    if (type === "required_linear_history") requireLinearHistory = true;
    if (type === "non_fast_forward") forcePushesBlocked = true;
    if (type === "deletion") deletionsBlocked = true;
  }

  return {
    statusChecks: [...statusContexts],
    strictStatusChecks,
    pullRequestRequired,
    minimumApprovals,
    dismissStaleReviews,
    requireCodeOwnerReview,
    requireLastPushApproval,
    requireConversationResolution,
    requireLinearHistory,
    enforceAdmins: false,
    forcePushesBlocked,
    deletionsBlocked,
    ruleTypes: [...ruleTypes],
    activeRulesets: [...rulesets.values()],
  };
}

/** @returns {ProtectionShape} */
function emptyProtectionShape() {
  return {
    statusChecks: [],
    strictStatusChecks: false,
    pullRequestRequired: false,
    minimumApprovals: 0,
    dismissStaleReviews: false,
    requireCodeOwnerReview: false,
    requireLastPushApproval: false,
    requireConversationResolution: false,
    requireLinearHistory: false,
    enforceAdmins: false,
    forcePushesBlocked: false,
    deletionsBlocked: false,
  };
}

/** @param {ProtectionShape | null} classic @param {RulesProtection | null} rules @returns {EffectiveProtection} */
function deriveEffectiveProtection(classic, rules) {
  const classicValue = classic ?? emptyProtectionShape();
  const rulesValue = rules ?? { ...emptyProtectionShape(), ruleTypes: [], activeRulesets: [] };
  return {
    statusChecks: [...new Set([...classicValue.statusChecks, ...rulesValue.statusChecks])].sort(),
    strictStatusChecks: classicValue.strictStatusChecks || rulesValue.strictStatusChecks,
    pullRequestRequired: classicValue.pullRequestRequired || rulesValue.pullRequestRequired,
    minimumApprovals: Math.max(classicValue.minimumApprovals, rulesValue.minimumApprovals),
    dismissStaleReviews: classicValue.dismissStaleReviews || rulesValue.dismissStaleReviews,
    requireCodeOwnerReview: classicValue.requireCodeOwnerReview || rulesValue.requireCodeOwnerReview,
    requireLastPushApproval: classicValue.requireLastPushApproval || rulesValue.requireLastPushApproval,
    requireConversationResolution: classicValue.requireConversationResolution || rulesValue.requireConversationResolution,
    requireLinearHistory: classicValue.requireLinearHistory || rulesValue.requireLinearHistory,
    enforceAdmins: classicValue.enforceAdmins,
    forcePushesBlocked: classicValue.forcePushesBlocked || rulesValue.forcePushesBlocked,
    deletionsBlocked: classicValue.deletionsBlocked || rulesValue.deletionsBlocked,
    activeRuleTypes: rulesValue.ruleTypes ?? [],
    activeRulesets: rulesValue.activeRulesets ?? [],
  };
}

/** @param {string} id @param {string} detail @param {boolean} satisfied @param {boolean} uncertain @returns {PolicyCheck} */
function requirementResult(id, detail, satisfied, uncertain) {
  return {
    id,
    status: satisfied ? "PASS" : uncertain ? "UNVERIFIED" : "FAIL",
    detail,
  };
}

/** @param {EffectiveProtection} effective @param {GitHubProtectionPolicy} policy @param {{ classic: SourceAvailability, rules: SourceAvailability }} availability @returns {PolicyCheck[]} */
function evaluateProtectionPolicy(effective, policy, availability) {
  const sourceUncertain = availability.classic === "UNVERIFIED" || availability.rules === "UNVERIFIED";
  const checks = [];

  if (policy.requiredStatusChecks.length > 0) {
    const missing = policy.requiredStatusChecks.filter((name) => !effective.statusChecks.includes(name));
    checks.push(requirementResult(
      "required-status-checks",
      missing.length === 0 ? "all explicitly required status checks are enforced" : `missing required status checks: ${missing.join(", ")}`,
      missing.length === 0,
      sourceUncertain,
    ));
  }

  const booleanRequirements = [
    { required: policy.requireStrictStatusChecks, id: "strict-status-checks", label: "strict required status checks", satisfied: effective.strictStatusChecks },
    { required: policy.requirePullRequest, id: "pull-request", label: "pull request before merge", satisfied: effective.pullRequestRequired },
    { required: policy.dismissStaleReviews, id: "dismiss-stale-reviews", label: "dismiss stale approvals on push", satisfied: effective.dismissStaleReviews },
    { required: policy.requireCodeOwnerReview, id: "code-owner-review", label: "code owner review", satisfied: effective.requireCodeOwnerReview },
    { required: policy.requireLastPushApproval, id: "last-push-approval", label: "approval of the latest push", satisfied: effective.requireLastPushApproval },
    { required: policy.requireConversationResolution, id: "conversation-resolution", label: "conversation resolution", satisfied: effective.requireConversationResolution },
    { required: policy.requireLinearHistory, id: "linear-history", label: "linear history", satisfied: effective.requireLinearHistory },
    { required: policy.forbidForcePushes, id: "force-pushes-blocked", label: "force pushes blocked", satisfied: effective.forcePushesBlocked },
    { required: policy.forbidDeletions, id: "deletions-blocked", label: "branch deletions blocked", satisfied: effective.deletionsBlocked },
  ];
  for (const item of booleanRequirements) {
    if (!item.required) continue;
    checks.push(requirementResult(item.id, item.satisfied ? `${item.label} is enforced` : `${item.label} is not established`, item.satisfied, sourceUncertain));
  }

  if (policy.minimumApprovals !== null) {
    const satisfied = effective.minimumApprovals >= policy.minimumApprovals;
    checks.push(requirementResult(
      "minimum-approvals",
      satisfied
        ? `effective minimum approvals ${effective.minimumApprovals} satisfies required ${policy.minimumApprovals}`
        : `effective minimum approvals ${effective.minimumApprovals} is below required ${policy.minimumApprovals}`,
      satisfied,
      sourceUncertain,
    ));
  }

  if (policy.enforceAdmins === true) {
    const satisfied = effective.enforceAdmins === true;
    const rulesetBypassUnknown = effective.activeRulesets.length > 0;
    const uncertain = availability.classic === "UNVERIFIED" || (!satisfied && rulesetBypassUnknown);
    checks.push(requirementResult(
      "enforce-admins",
      satisfied
        ? "classic branch protection explicitly applies to administrators"
        : rulesetBypassUnknown
          ? "administrator enforcement cannot be established because active ruleset bypass actors are not part of the effective-rules response"
          : "administrator enforcement is not established",
      satisfied,
      uncertain,
    ));
  }

  return checks;
}

/**
 * @param {{ repository: unknown, branch: unknown, policy: unknown }} options
 * @param {{ authCheck?: () => boolean, apiGet?: (endpoint: string) => { ok: true, status: number, value: unknown } | { ok: false, status: number | null, value?: unknown, error: { id: string, detail: string } } }} [dependencies]
 * @returns {{ ok: true, report: GitHubProtectionReport } | { ok: false, error: { id: string, detail: string } }}
 */
export function inspectGitHubProtection(options, dependencies = {}) {
  const repository = normalizeRepository(options.repository);
  if (repository === null) return { ok: false, error: { id: "repository-invalid", detail: "repository must be an explicit owner/name slug" } };
  const branch = normalizeBranch(options.branch);
  if (branch === null) return { ok: false, error: { id: "branch-invalid", detail: "branch must be a non-empty explicit branch name" } };
  const policyResult = validateGitHubProtectionPolicy(options.policy);
  if (!policyResult.ok) return policyResult;

  const authCheck = dependencies.authCheck ?? githubCliAuthCheck;
  if (!authCheck()) return { ok: false, error: { id: "github-auth-required", detail: "GitHub CLI authentication for github.com is required" } };
  const apiGet = dependencies.apiGet ?? githubCliApiGet;
  const owner = encodeURIComponent(repository.owner);
  const name = encodeURIComponent(repository.repository);
  const encodedBranch = encodeURIComponent(branch);

  const branchResult = apiGet(`repos/${owner}/${name}/branches/${encodedBranch}`);
  if (!branchResult.ok || branchResult.status !== 200 || !isPlainObject(branchResult.value)) {
    return { ok: false, error: { id: "branch-inspection-failed", detail: "GitHub branch metadata could not be inspected" } };
  }
  if (branchResult.value.name !== branch || typeof branchResult.value.protected !== "boolean") {
    return { ok: false, error: { id: "branch-metadata-invalid", detail: "GitHub branch metadata did not match the requested branch" } };
  }
  const branchProtected = branchResult.value.protected;

  const classicResult = apiGet(`repos/${owner}/${name}/branches/${encodedBranch}/protection`);
  /** @type {SourceAvailability} */
  let classicAvailability;
  /** @type {ProtectionShape | null} */
  let classic = null;
  if (classicResult.ok && classicResult.status === 200) {
    classic = inspectClassicProtection(classicResult.value);
    if (classic === null) return { ok: false, error: { id: "classic-protection-invalid", detail: "GitHub classic branch protection response was invalid" } };
    classicAvailability = "AVAILABLE";
  } else if (classicResult.status === 404 && branchProtected === false) {
    classicAvailability = "ABSENT";
  } else if (classicResult.status === 401 || classicResult.status === 403 || classicResult.status === 404) {
    classicAvailability = "UNVERIFIED";
  } else {
    return { ok: false, error: { id: "classic-protection-inspection-failed", detail: "GitHub classic branch protection could not be inspected reliably" } };
  }

  const rulesResult = apiGet(`repos/${owner}/${name}/rules/branches/${encodedBranch}`);
  /** @type {SourceAvailability} */
  let rulesAvailability;
  /** @type {RulesProtection | null} */
  let rules = null;
  if (rulesResult.ok && rulesResult.status === 200) {
    rules = inspectActiveRules(rulesResult.value);
    if (rules === null) return { ok: false, error: { id: "active-rules-invalid", detail: "GitHub active rules response was invalid" } };
    rulesAvailability = "AVAILABLE";
  } else if (rulesResult.status === 401 || rulesResult.status === 403 || rulesResult.status === 404) {
    rulesAvailability = "UNVERIFIED";
  } else {
    return { ok: false, error: { id: "active-rules-inspection-failed", detail: "GitHub active rules could not be inspected reliably" } };
  }

  const effective = deriveEffectiveProtection(classic, rules);
  const policyChecks = evaluateProtectionPolicy(effective, policyResult.policy, {
    classic: classicAvailability,
    rules: rulesAvailability,
  });
  /** @type {"PASS" | "WARN" | "FAIL"} */
  const policyStatus = policyChecks.some((check) => check.status === "FAIL")
    ? "FAIL"
    : policyChecks.some((check) => check.status === "UNVERIFIED")
      ? "WARN"
      : "PASS";

  return {
    ok: true,
    report: {
      repository: repository.slug,
      branch,
      branchProtected,
      sources: {
        classic: { availability: classicAvailability, protection: classic },
        rulesets: { availability: rulesAvailability, active: rules },
      },
      effective,
      policy: policyResult.policy,
      policyChecks,
      technicalStatus: "PASS",
      overallStatus: policyStatus,
    },
  };
}

/** @param {GitHubProtectionReport} report */
export function formatGitHubProtection(report) {
  const lines = [
    "GitHub protection audit",
    "",
    `Repository: ${report.repository}`,
    `Branch: ${report.branch}`,
    `GitHub protected flag: ${report.branchProtected}`,
    `Classic protection: ${report.sources.classic.availability}`,
    `Active rules: ${report.sources.rulesets.availability}`,
    `Active rulesets: ${report.effective.activeRulesets.length}`,
    "",
    `Required status checks: ${report.effective.statusChecks.length > 0 ? report.effective.statusChecks.join(", ") : "(none observed)"}`,
    `Strict status checks: ${report.effective.strictStatusChecks}`,
    `Pull request required: ${report.effective.pullRequestRequired}`,
    `Minimum approvals: ${report.effective.minimumApprovals}`,
    `Conversation resolution: ${report.effective.requireConversationResolution}`,
    `Linear history: ${report.effective.requireLinearHistory}`,
    `Classic admin enforcement: ${report.effective.enforceAdmins}`,
    `Force pushes blocked: ${report.effective.forcePushesBlocked}`,
    `Deletions blocked: ${report.effective.deletionsBlocked}`,
    "",
    "Policy checks:",
  ];
  for (const check of report.policyChecks) lines.push(`  ${check.status}  ${check.id}  ${check.detail}`);
  lines.push("", `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string} filename @returns {{ ok: true, value: unknown } | { ok: false, error: { id: string, detail: string } }} */
function readPolicyFile(filename) {
  let contents;
  try {
    contents = fs.readFileSync(filename, "utf8");
  } catch {
    return { ok: false, error: { id: "policy-file-read-failed", detail: "GitHub protection policy file could not be read" } };
  }
  try {
    return { ok: true, value: JSON.parse(contents) };
  } catch {
    return { ok: false, error: { id: "policy-json-malformed", detail: "GitHub protection policy file contains malformed JSON" } };
  }
}

/** @param {string[]} argv */
function parseArguments(argv) {
  const options = /** @type {{ repository: string | null, branch: string | null, policyFile: string | null, json: boolean }} */ ({
    repository: null,
    branch: null,
    policyFile: null,
    json: false,
  });
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      options.json = true;
    } else if (argument === "--repository" || argument === "--branch" || argument === "--policy") {
      const value = argv[index + 1];
      if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) return null;
      if (argument === "--repository") {
        if (options.repository !== null) return null;
        options.repository = value;
      }
      if (argument === "--branch") {
        if (options.branch !== null) return null;
        options.branch = value;
      }
      if (argument === "--policy") {
        if (options.policyFile !== null) return null;
        options.policyFile = value;
      }
      index += 1;
    } else {
      return null;
    }
  }
  if (!options.repository || !options.branch || !options.policyFile) return null;
  return { repository: options.repository, branch: options.branch, policyFile: options.policyFile, json: options.json };
}

/** @param {string[]} argv @param {{ authCheck?: () => boolean, apiGet?: (endpoint: string) => any }} [dependencies] */
export function main(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/audit-github-protection.js --repository <owner/name> --branch <name> --policy <policy.json> [--json]");
    return 1;
  }
  const policyFile = readPolicyFile(options.policyFile);
  if (!policyFile.ok) {
    console.error(policyFile.error.detail);
    return 1;
  }
  const result = inspectGitHubProtection({
    repository: options.repository,
    branch: options.branch,
    policy: policyFile.value,
  }, dependencies);
  if (!result.ok) {
    console.error(result.error.detail);
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.report) : formatGitHubProtection(result.report));
  return result.report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
