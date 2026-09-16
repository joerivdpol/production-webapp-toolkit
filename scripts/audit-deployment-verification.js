#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inspectProductionBaseline } from "./audit-production-baseline.js";
import { isAbsoluteIsoTimestamp, validateRuntimeEvidence } from "./runtime-evidence.js";

/** @typedef {"PASS" | "WARN" | "FAIL"} Severity */
/** @typedef {"FRESH" | "STALE" | "FUTURE" | "NOT_CONFIGURED" | "NOT_APPLICABLE"} FreshnessStatus */
/** @typedef {{ id: string, severity: Severity, detail: string }} DeploymentCheck */
/** @typedef {{ configured: boolean, status: FreshnessStatus, collectedAt: string | null, evaluatedAt: string | null, ageSeconds: number | null, maxAgeSeconds: number | null }} EvidenceFreshness */
/** @typedef {{ maxEvidenceAgeSeconds: number, evaluatedAt: string }} EvidenceFreshnessPolicy */
/**
 * @typedef {{
 *   expectedRef?: string | null,
 *   expectedCommit?: string | null,
 *   deployedCommit?: string | null,
 *   evidence?: DeploymentEvidence
 * }} DeploymentOptions
 */
/** @typedef {{ type: "explicit-commit", source: "caller-supplied", authenticated: false } | { type: "runtime-evidence", source: string, authenticated: boolean, collectedAt: string, runtime: { name: string, environment?: string } }} DeploymentEvidence */
/**
 * @typedef {{
 *   root: string,
 *   expectedRef: string | null,
 *   expectedCommit: string | null,
 *   expectedResolvedCommit: string | null,
 *   baselineStatus: "MATCH" | "MISMATCH" | "UNVERIFIED",
 *   deployedCommit: string | null,
 *   evidence: DeploymentEvidence,
 *   deploymentStatus: "MATCH" | "MISMATCH" | "UNVERIFIED",
 *   freshness: EvidenceFreshness,
 *   technicalStatus: "PASS" | "FAIL",
 *   overallStatus: "PASS" | "WARN" | "FAIL",
 *   checks: DeploymentCheck[]
 * }} DeploymentVerificationReport
 */

/** @param {string} value */
export function isFullObjectId(value) {
  return /^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/.test(value);
}

/** @param {DeploymentEvidence} evidence */
function defaultFreshness(evidence) {
  if (evidence.type === "runtime-evidence") {
    return {
      configured: false,
      status: /** @type {FreshnessStatus} */ ("NOT_CONFIGURED"),
      collectedAt: evidence.collectedAt,
      evaluatedAt: null,
      ageSeconds: null,
      maxAgeSeconds: null,
    };
  }
  return {
    configured: false,
    status: /** @type {FreshnessStatus} */ ("NOT_APPLICABLE"),
    collectedAt: null,
    evaluatedAt: null,
    ageSeconds: null,
    maxAgeSeconds: null,
  };
}

/**
 * @param {unknown} maxEvidenceAgeSeconds
 * @param {unknown} evaluatedAt
 * @returns {{ ok: true, policy: EvidenceFreshnessPolicy | null } | { ok: false, error: { id: string, detail: string } }}
 */
export function validateEvidenceFreshnessPolicy(maxEvidenceAgeSeconds, evaluatedAt) {
  const absent = maxEvidenceAgeSeconds === null || maxEvidenceAgeSeconds === undefined;
  const timeAbsent = evaluatedAt === null || evaluatedAt === undefined;
  if (absent && timeAbsent) return { ok: true, policy: null };
  if (absent || timeAbsent) {
    return { ok: false, error: { id: "freshness-policy-incomplete", detail: "freshness policy requires both maxEvidenceAgeSeconds and evaluatedAt" } };
  }
  if (typeof maxEvidenceAgeSeconds !== "number" || !Number.isSafeInteger(maxEvidenceAgeSeconds) || maxEvidenceAgeSeconds <= 0) {
    return { ok: false, error: { id: "freshness-max-age-invalid", detail: "maxEvidenceAgeSeconds must be a positive safe integer" } };
  }
  if (typeof evaluatedAt !== "string" || !isAbsoluteIsoTimestamp(evaluatedAt)) {
    return { ok: false, error: { id: "freshness-evaluated-at-invalid", detail: "evaluatedAt must be a valid absolute ISO 8601 timestamp with timezone" } };
  }
  return {
    ok: true,
    policy: {
      maxEvidenceAgeSeconds,
      evaluatedAt,
    },
  };
}

/** @param {DeploymentEvidence} evidence @param {EvidenceFreshnessPolicy | null} policy */
function evaluateEvidenceFreshness(evidence, policy) {
  if (policy === null) return defaultFreshness(evidence);
  if (evidence.type !== "runtime-evidence") return defaultFreshness(evidence);
  const collectedMs = Date.parse(evidence.collectedAt);
  const evaluatedMs = Date.parse(policy.evaluatedAt);
  const ageSeconds = (evaluatedMs - collectedMs) / 1000;
  const status = ageSeconds < 0
    ? "FUTURE"
    : ageSeconds <= policy.maxEvidenceAgeSeconds
      ? "FRESH"
      : "STALE";
  return {
    configured: true,
    status: /** @type {FreshnessStatus} */ (status),
    collectedAt: evidence.collectedAt,
    evaluatedAt: policy.evaluatedAt,
    ageSeconds,
    maxAgeSeconds: policy.maxEvidenceAgeSeconds,
  };
}

/** @param {EvidenceFreshness} freshness */
function freshnessCheck(freshness) {
  if (!freshness.configured) return null;
  if (freshness.status === "FRESH") {
    return {
      id: "evidence-freshness",
      severity: /** @type {Severity} */ ("PASS"),
      detail: `runtime evidence age ${freshness.ageSeconds}s is within the ${freshness.maxAgeSeconds}s freshness policy`,
    };
  }
  return {
    id: "evidence-freshness",
    severity: /** @type {Severity} */ ("WARN"),
    detail: freshness.status === "FUTURE"
      ? `runtime evidence collection time is ${Math.abs(freshness.ageSeconds ?? 0)}s after the explicit evaluation time`
      : `runtime evidence age ${freshness.ageSeconds}s exceeds the ${freshness.maxAgeSeconds}s freshness policy`,
  };
}

/** @param {DeploymentVerificationReport} report */
function deriveOverallStatus(report) {
  report.overallStatus =
    report.technicalStatus === "FAIL"
      ? "FAIL"
      : report.deploymentStatus !== "MATCH"
        ? "WARN"
        : report.freshness.configured && report.freshness.status !== "FRESH"
          ? "WARN"
          : "PASS";
  return report;
}

/** @param {unknown} error */
function errorDetail(error) {
  return error instanceof Error ? error.message : "production baseline inspection failed";
}

/** @param {DeploymentOptions} options @returns {DeploymentEvidence} */
function deploymentEvidence(options) {
  return options.evidence ?? {
    type: "explicit-commit",
    source: "caller-supplied",
    authenticated: false,
  };
}

/** @param {import("./runtime-evidence.js").RuntimeEvidence} evidence @returns {DeploymentEvidence} */
function runtimeEvidenceTrustMetadata(evidence) {
  return {
    type: "runtime-evidence",
    source: evidence.evidence.source,
    authenticated: evidence.evidence.authenticated,
    collectedAt: evidence.evidence.collectedAt,
    runtime: {
      name: evidence.runtime.name,
      ...(evidence.runtime.environment === undefined ? {} : { environment: evidence.runtime.environment }),
    },
  };
}

/** @param {DeploymentEvidence} evidence */
function evidenceDescription(evidence) {
  return evidence.type === "runtime-evidence"
    ? "validated Runtime Evidence Contract v1 deployment commit; trust metadata is not authenticated by this auditor"
    : "deployed commit is explicit caller-supplied evidence and is not authenticated by this auditor";
}

/** @param {DeploymentEvidence} evidence */
function evidenceSubject(evidence) {
  return evidence.type === "runtime-evidence"
    ? "validated runtime evidence commit"
    : "caller-supplied deployed commit";
}

/**
 * Compare normalized deployment evidence with an explicitly supplied,
 * locally inspectable production baseline. This function intentionally does
 * not validate evidence, collect runtime evidence, or execute Git commands
 * itself. Its callers must establish the evidence provenance before calling
 * it.
 *
 * @param {string} target
 * @param {{ expectedRef?: string | null, expectedCommit?: string | null, deployedCommit: string | null, evidence: DeploymentEvidence, freshnessPolicy?: EvidenceFreshnessPolicy | null }} options
 * @returns {DeploymentVerificationReport}
 */
function inspectNormalizedDeploymentVerification(target, options) {
  const hasInvalidDeployedEvidence = options.deployedCommit === null;
  const deployedCommit = options.deployedCommit?.toLowerCase() ?? null;
  const evidence = deploymentEvidence(options);
  const freshness = evaluateEvidenceFreshness(evidence, options.freshnessPolicy ?? null);

  let baseline;
  try {
    baseline = inspectProductionBaseline(target, {
      expectedRef: options.expectedRef ?? null,
      expectedCommit: options.expectedCommit ?? null,
    });
  } catch (error) {
    /** @type {DeploymentVerificationReport} */
    const report = {
      root: path.resolve(target),
      expectedRef: options.expectedRef ?? null,
      expectedCommit: options.expectedCommit ?? null,
      expectedResolvedCommit: null,
      baselineStatus: "UNVERIFIED",
      deployedCommit,
      evidence,
      deploymentStatus: "UNVERIFIED",
      freshness,
      technicalStatus: "FAIL",
      overallStatus: "FAIL",
      checks: [
        {
          id: "baseline-inspection",
          severity: "FAIL",
          detail: errorDetail(error),
        },
      ],
    };
    return deriveOverallStatus(report);
  }

  /** @type {DeploymentVerificationReport} */
  const report = {
    root: baseline.root,
    expectedRef: baseline.expectedRef,
    expectedCommit: baseline.expectedCommit,
    // A baseline contract mismatch has no usable production truth. Although
    // the baseline inspector exposes both individual resolutions, this layer
    // must not surface either one as the expected deployment commit.
    expectedResolvedCommit:
      baseline.baselineStatus === "MATCH"
        ? baseline.expectedResolvedCommit
        : null,
    baselineStatus: baseline.baselineStatus,
    deployedCommit,
    evidence,
    deploymentStatus: "UNVERIFIED",
    freshness,
    technicalStatus: baseline.technicalStatus,
    overallStatus: "WARN",
    checks: [...baseline.checks],
  };

  report.checks.push({
    id: "deployment-evidence",
    severity: hasInvalidDeployedEvidence ? "WARN" : "PASS",
    detail: hasInvalidDeployedEvidence
      ? "caller-supplied deployed commit is not a valid full 40- or 64-character hex object ID"
      : evidenceDescription(report.evidence),
  });
  const evidenceFreshnessCheck = freshnessCheck(report.freshness);
  if (evidenceFreshnessCheck) report.checks.push(evidenceFreshnessCheck);

  if (report.technicalStatus === "FAIL") {
    report.checks.push({
      id: "deployment-baseline",
      severity: "WARN",
      detail: "deployment cannot be verified because production baseline inspection failed technically",
    });
  } else if (hasInvalidDeployedEvidence) {
    report.checks.push({
      id: "deployment-baseline",
      severity: "WARN",
      detail: "deployment cannot be verified because the caller-supplied deployed commit evidence is invalid",
    });
  } else if (report.baselineStatus === "MISMATCH") {
    report.checks.push({
      id: "deployment-baseline",
      severity: "WARN",
      detail: "deployment cannot be verified because the explicit production baseline contract is inconsistent",
    });
  } else if (
    report.baselineStatus !== "MATCH" ||
    !report.expectedResolvedCommit
  ) {
    report.checks.push({
      id: "deployment-baseline",
      severity: "WARN",
      detail: "deployment cannot be verified because the expected baseline is not locally resolvable",
    });
  } else if (report.deployedCommit === report.expectedResolvedCommit.toLowerCase()) {
    report.deploymentStatus = "MATCH";
    report.checks.push({
      id: "deployment-baseline",
      severity: "PASS",
      detail: `${evidenceSubject(report.evidence)} matches the locally resolved expected baseline`,
    });
  } else {
    report.deploymentStatus = "MISMATCH";
    report.checks.push({
      id: "deployment-baseline",
      severity: "WARN",
      detail: `${evidenceSubject(report.evidence)} differs from the locally resolved expected baseline`,
    });
  }

  return deriveOverallStatus(report);
}

/**
 * Compare a directly supplied deployed object ID with the production
 * baseline. Direct callers cannot establish canonical runtime-evidence
 * provenance by supplying a metadata discriminator.
 *
 * @param {string} target
 * @param {DeploymentOptions} options
 * @returns {DeploymentVerificationReport}
 */
export function inspectDeploymentVerification(target, options = {}) {
  const suppliedDeployedCommit = options.deployedCommit;
  const hasInvalidDeployedEvidence =
    typeof suppliedDeployedCommit !== "string" || !isFullObjectId(suppliedDeployedCommit);

  if (hasInvalidDeployedEvidence) {
    return inspectNormalizedDeploymentVerification(target, {
      expectedRef: options.expectedRef ?? null,
      expectedCommit: options.expectedCommit ?? null,
      deployedCommit: null,
      evidence: {
        type: "explicit-commit",
        source: "caller-supplied",
        authenticated: false,
      },
    });
  }

  return inspectNormalizedDeploymentVerification(target, {
    expectedRef: options.expectedRef ?? null,
    expectedCommit: options.expectedCommit ?? null,
    deployedCommit: suppliedDeployedCommit,
    evidence: {
      type: "explicit-commit",
      source: "caller-supplied",
      authenticated: false,
    },
  });
}

/**
 * Read and canonically validate an explicit Runtime Evidence Contract file,
 * then compare its normalized deployment commit with the explicit baseline.
 * File and schema failures are returned as input errors rather than deployment
 * mismatches or unverifiable runtime claims.
 *
 * @param {string} target
 * @param {{ expectedRef?: string | null, expectedCommit?: string | null, evidenceFile: string, maxEvidenceAgeSeconds?: number | null, evaluatedAt?: string | null }} options
 * @returns {{ ok: true, report: DeploymentVerificationReport } | { ok: false, error: { id: string, detail: string } }}
 */
export function inspectDeploymentVerificationFromEvidenceFile(target, options) {
  let input;
  try {
    input = JSON.parse(fs.readFileSync(options.evidenceFile, "utf8"));
  } catch (error) {
    return {
      ok: false,
      error: {
        id: error instanceof SyntaxError ? "evidence-json-malformed" : "evidence-file-read-failed",
        detail: error instanceof SyntaxError
          ? "Deployment evidence file contains malformed JSON"
          : "Deployment evidence file could not be read",
      },
    };
  }
  const validation = validateRuntimeEvidence(input);
  if (!validation.valid || !validation.evidence) {
    return {
      ok: false,
      error: {
        id: "evidence-schema-invalid",
        detail: "Deployment evidence file does not satisfy Runtime Evidence Contract v1",
      },
    };
  }

  const freshnessPolicyResult = validateEvidenceFreshnessPolicy(
    options.maxEvidenceAgeSeconds ?? null,
    options.evaluatedAt ?? null,
  );
  if (!freshnessPolicyResult.ok) return freshnessPolicyResult;

  const evidence = runtimeEvidenceTrustMetadata(validation.evidence);
  return {
    ok: true,
    report: inspectNormalizedDeploymentVerification(target, {
      expectedRef: options.expectedRef ?? null,
      expectedCommit: options.expectedCommit ?? null,
      deployedCommit: validation.evidence.deployment.commit,
      evidence,
      freshnessPolicy: freshnessPolicyResult.policy,
    }),
  };
}

/** @param {DeploymentVerificationReport} report */
export function formatDeploymentVerification(report) {
  const evidenceDescription =
    report.evidence.type === "runtime-evidence"
      ? `validated Runtime Evidence Contract v1; source: ${report.evidence.source}; authenticated: ${report.evidence.authenticated}; collected at: ${report.evidence.collectedAt}; runtime: ${report.evidence.runtime.name}${report.evidence.runtime.environment === undefined ? "" : `; environment: ${report.evidence.runtime.environment}`}`
      : "caller supplied; unauthenticated";
  const freshnessDescription = report.freshness.configured
    ? `${report.freshness.status}; age: ${report.freshness.ageSeconds}s; max: ${report.freshness.maxAgeSeconds}s; evaluated at: ${report.freshness.evaluatedAt}`
    : report.freshness.status;
  const lines = [
    `Deployment verification: ${report.root}`,
    "",
    `Expected baseline: ${report.expectedResolvedCommit ?? "(unavailable)"}`,
    `Expected ref: ${report.expectedRef ?? "(not supplied)"}`,
    `Expected commit: ${report.expectedCommit ?? "(not supplied)"}`,
    `Deployed commit: ${report.deployedCommit ?? "(invalid or unavailable)"}`,
    `Deployed evidence: ${evidenceDescription}`,
    `Evidence freshness: ${freshnessDescription}`,
    "",
  ];

  for (const check of report.checks) {
    lines.push(`${check.severity}  ${check.id}  ${check.detail}`);
  }

  lines.push(
    "",
    `Deployment status: ${report.deploymentStatus}`,
    `Technical: ${report.technicalStatus}`,
    `Overall: ${report.overallStatus}`,
  );

  return lines.join("\n");
}

/** @typedef {{ expectedRef: string | null, expectedCommit: string | null, deployedCommit: string | null, evidenceFile: string | null, maxEvidenceAgeSeconds: number | null, evaluatedAt: string | null, json: boolean, target: string | null }} CliArguments */
/** @param {string[]} argv @returns {CliArguments | null} */
export function parseArguments(argv) {
  /** @type {CliArguments} */
  const options = {
    expectedRef: null,
    expectedCommit: null,
    deployedCommit: null,
    evidenceFile: null,
    maxEvidenceAgeSeconds: null,
    evaluatedAt: null,
    json: false,
    target: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string") return null;

    if (argument === "--json") {
      options.json = true;
    } else if (
      argument === "--expected-ref" ||
      argument === "--expected-commit" ||
      argument === "--deployed-commit" ||
      argument === "--evidence-file" ||
      argument === "--max-evidence-age-seconds" ||
      argument === "--evaluated-at"
    ) {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) return null;

      if (argument === "--expected-ref") options.expectedRef = value;
      if (argument === "--expected-commit") options.expectedCommit = value;
      if (argument === "--deployed-commit") options.deployedCommit = value;
      if (argument === "--evidence-file") options.evidenceFile = value;
      if (argument === "--max-evidence-age-seconds") {
        if (!/^[1-9]\d*$/.test(value)) return null;
        const maxEvidenceAgeSeconds = Number(value);
        if (!Number.isSafeInteger(maxEvidenceAgeSeconds)) return null;
        options.maxEvidenceAgeSeconds = maxEvidenceAgeSeconds;
      }
      if (argument === "--evaluated-at") options.evaluatedAt = value;
      index += 1;
    } else if (argument.startsWith("-")) {
      return null;
    } else if (options.target === null) {
      options.target = argument;
    } else {
      return null;
    }
  }

  if (
    (!options.expectedRef && !options.expectedCommit) ||
    (options.deployedCommit === null && options.evidenceFile === null) ||
    (options.deployedCommit !== null && options.evidenceFile !== null) ||
    (options.deployedCommit !== null && !isFullObjectId(options.deployedCommit)) ||
    (options.maxEvidenceAgeSeconds !== null && options.evidenceFile === null)
  ) {
    return null;
  }
  const freshnessPolicy = validateEvidenceFreshnessPolicy(
    options.maxEvidenceAgeSeconds,
    options.evaluatedAt,
  );
  if (!freshnessPolicy.ok) return null;

  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error(
      "Usage: node scripts/audit-deployment-verification.js [repository] (--expected-ref <git-ref> | --expected-commit <commit>) (--deployed-commit <40-or-64-hex-object-id> | --evidence-file <runtime-evidence.json> [--max-evidence-age-seconds <seconds> --evaluated-at <absolute-iso-timestamp>]) [--json]",
    );
    return 1;
  }

  /** @type {DeploymentVerificationReport} */
  let report;
  if (options.evidenceFile !== null) {
    const result = inspectDeploymentVerificationFromEvidenceFile(
      options.target ?? process.cwd(),
      {
        expectedRef: options.expectedRef,
        expectedCommit: options.expectedCommit,
        evidenceFile: options.evidenceFile,
        maxEvidenceAgeSeconds: options.maxEvidenceAgeSeconds,
        evaluatedAt: options.evaluatedAt,
      },
    );
    if (!result.ok) {
      console.error(result.error.detail);
      return 1;
    }
    report = result.report;
  } else {
    report = inspectDeploymentVerification(options.target ?? process.cwd(), {
      expectedRef: options.expectedRef,
      expectedCommit: options.expectedCommit,
      deployedCommit: options.deployedCommit,
    });
  }
  console.log(options.json ? JSON.stringify(report) : formatDeploymentVerification(report));
  return report.technicalStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
