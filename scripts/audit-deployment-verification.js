#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

import { inspectProductionBaseline } from "./audit-production-baseline.js";

/** @typedef {"PASS" | "WARN" | "FAIL"} Severity */
/** @typedef {{ id: string, severity: Severity, detail: string }} DeploymentCheck */
/**
 * @typedef {{
 *   expectedRef?: string | null,
 *   expectedCommit?: string | null,
 *   deployedCommit?: string | null
 * }} DeploymentOptions
 */
/**
 * @typedef {{
 *   root: string,
 *   expectedRef: string | null,
 *   expectedCommit: string | null,
 *   expectedResolvedCommit: string | null,
 *   baselineStatus: "MATCH" | "MISMATCH" | "UNVERIFIED",
 *   deployedCommit: string | null,
 *   evidence: { type: "explicit-commit", source: "caller-supplied", authenticated: false },
 *   deploymentStatus: "MATCH" | "MISMATCH" | "UNVERIFIED",
 *   technicalStatus: "PASS" | "FAIL",
 *   overallStatus: "PASS" | "WARN" | "FAIL",
 *   checks: DeploymentCheck[]
 * }} DeploymentVerificationReport
 */

/** @param {string} value */
function isFullObjectId(value) {
  return /^[0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?$/.test(value);
}

/** @param {DeploymentVerificationReport} report */
function deriveOverallStatus(report) {
  report.overallStatus =
    report.technicalStatus === "FAIL"
      ? "FAIL"
      : report.deploymentStatus === "MATCH"
        ? "PASS"
        : "WARN";
  return report;
}

/** @param {unknown} error */
function errorDetail(error) {
  return error instanceof Error ? error.message : "production baseline inspection failed";
}

/**
 * Compare caller-supplied runtime evidence with an explicitly supplied,
 * locally inspectable production baseline. This function intentionally does
 * not collect runtime evidence or execute Git commands itself.
 *
 * @param {string} target
 * @param {DeploymentOptions} options
 * @returns {DeploymentVerificationReport}
 */
export function inspectDeploymentVerification(target, options = {}) {
  const suppliedDeployedCommit = options.deployedCommit;
  const hasInvalidDeployedEvidence =
    typeof suppliedDeployedCommit !== "string" || !isFullObjectId(suppliedDeployedCommit);
  const deployedCommit =
    !hasInvalidDeployedEvidence
      ? suppliedDeployedCommit.toLowerCase()
      : null;

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
      evidence: {
        type: "explicit-commit",
        source: "caller-supplied",
        authenticated: false,
      },
      deploymentStatus: "UNVERIFIED",
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
    evidence: {
      type: "explicit-commit",
      source: "caller-supplied",
      authenticated: false,
    },
    deploymentStatus: "UNVERIFIED",
    technicalStatus: baseline.technicalStatus,
    overallStatus: "WARN",
    checks: [...baseline.checks],
  };

  report.checks.push({
    id: "deployment-evidence",
    severity: hasInvalidDeployedEvidence ? "WARN" : "PASS",
    detail: hasInvalidDeployedEvidence
      ? "caller-supplied deployed commit is not a valid full 40- or 64-character hex object ID"
      : "deployed commit is explicit caller-supplied evidence and is not authenticated by this auditor",
  });

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
      detail: "caller-supplied deployed commit matches the locally resolved expected baseline",
    });
  } else {
    report.deploymentStatus = "MISMATCH";
    report.checks.push({
      id: "deployment-baseline",
      severity: "WARN",
      detail: "caller-supplied deployed commit differs from the locally resolved expected baseline",
    });
  }

  return deriveOverallStatus(report);
}

/** @param {DeploymentVerificationReport} report */
export function formatDeploymentVerification(report) {
  const lines = [
    `Deployment verification: ${report.root}`,
    "",
    `Expected baseline: ${report.expectedResolvedCommit ?? "(unavailable)"}`,
    `Expected ref: ${report.expectedRef ?? "(not supplied)"}`,
    `Expected commit: ${report.expectedCommit ?? "(not supplied)"}`,
    `Deployed commit: ${report.deployedCommit ?? "(invalid or unavailable)"}`,
    "Deployed evidence: caller supplied; unauthenticated",
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

/** @typedef {{ expectedRef: string | null, expectedCommit: string | null, deployedCommit: string | null, json: boolean, target: string | null }} CliArguments */
/** @param {string[]} argv @returns {CliArguments | null} */
export function parseArguments(argv) {
  /** @type {CliArguments} */
  const options = {
    expectedRef: null,
    expectedCommit: null,
    deployedCommit: null,
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
      argument === "--deployed-commit"
    ) {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) return null;

      if (argument === "--expected-ref") options.expectedRef = value;
      if (argument === "--expected-commit") options.expectedCommit = value;
      if (argument === "--deployed-commit") options.deployedCommit = value;
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
    !options.deployedCommit ||
    !isFullObjectId(options.deployedCommit)
  ) {
    return null;
  }

  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error(
      "Usage: node scripts/audit-deployment-verification.js [repository] (--expected-ref <git-ref> | --expected-commit <commit>) --deployed-commit <40-or-64-hex-object-id> [--json]",
    );
    return 1;
  }

  const report = inspectDeploymentVerification(
    options.target ?? process.cwd(),
    options,
  );
  console.log(options.json ? JSON.stringify(report) : formatDeploymentVerification(report));
  return report.technicalStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
