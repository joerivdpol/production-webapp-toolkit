#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inspectProductionBaseline } from "./audit-production-baseline.js";
import { validateRuntimeEvidence } from "./runtime-evidence.js";

/** @typedef {"PASS" | "WARN" | "FAIL"} Severity */
/** @typedef {{ id: string, severity: Severity, detail: string }} DeploymentCheck */
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
 * @param {{ expectedRef?: string | null, expectedCommit?: string | null, deployedCommit: string | null, evidence: DeploymentEvidence }} options
 * @returns {DeploymentVerificationReport}
 */
function inspectNormalizedDeploymentVerification(target, options) {
  const hasInvalidDeployedEvidence = options.deployedCommit === null;
  const deployedCommit = options.deployedCommit?.toLowerCase() ?? null;

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
      evidence: deploymentEvidence(options),
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
    evidence: deploymentEvidence(options),
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
      : evidenceDescription(report.evidence),
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

/** @param {DeploymentVerificationReport} report */
export function formatDeploymentVerification(report) {
  const evidenceDescription =
    report.evidence.type === "runtime-evidence"
      ? `validated Runtime Evidence Contract v1; source: ${report.evidence.source}; authenticated: ${report.evidence.authenticated}; collected at: ${report.evidence.collectedAt}; runtime: ${report.evidence.runtime.name}${report.evidence.runtime.environment === undefined ? "" : `; environment: ${report.evidence.runtime.environment}`}`
      : "caller supplied; unauthenticated";
  const lines = [
    `Deployment verification: ${report.root}`,
    "",
    `Expected baseline: ${report.expectedResolvedCommit ?? "(unavailable)"}`,
    `Expected ref: ${report.expectedRef ?? "(not supplied)"}`,
    `Expected commit: ${report.expectedCommit ?? "(not supplied)"}`,
    `Deployed commit: ${report.deployedCommit ?? "(invalid or unavailable)"}`,
    `Deployed evidence: ${evidenceDescription}`,
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

/** @typedef {{ expectedRef: string | null, expectedCommit: string | null, deployedCommit: string | null, evidenceFile: string | null, json: boolean, target: string | null }} CliArguments */
/** @param {string[]} argv @returns {CliArguments | null} */
export function parseArguments(argv) {
  /** @type {CliArguments} */
  const options = {
    expectedRef: null,
    expectedCommit: null,
    deployedCommit: null,
    evidenceFile: null,
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
      argument === "--evidence-file"
    ) {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) return null;

      if (argument === "--expected-ref") options.expectedRef = value;
      if (argument === "--expected-commit") options.expectedCommit = value;
      if (argument === "--deployed-commit") options.deployedCommit = value;
      if (argument === "--evidence-file") options.evidenceFile = value;
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
    (options.deployedCommit !== null && !isFullObjectId(options.deployedCommit))
  ) {
    return null;
  }

  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error(
      "Usage: node scripts/audit-deployment-verification.js [repository] (--expected-ref <git-ref> | --expected-commit <commit>) (--deployed-commit <40-or-64-hex-object-id> | --evidence-file <runtime-evidence.json>) [--json]",
    );
    return 1;
  }

  /** @type {DeploymentOptions} */
  const inspectionOptions = {
    expectedRef: options.expectedRef,
    expectedCommit: options.expectedCommit,
    deployedCommit: options.deployedCommit,
  };
  /** @type {DeploymentVerificationReport} */
  let report;
  if (options.evidenceFile !== null) {
    let input;
    try {
      input = JSON.parse(fs.readFileSync(options.evidenceFile, "utf8"));
    } catch (error) {
      console.error(
        error instanceof SyntaxError
          ? "Deployment evidence file contains malformed JSON"
          : "Deployment evidence file could not be read",
      );
      return 1;
    }

    const validation = validateRuntimeEvidence(input);
    if (!validation.valid || !validation.evidence) {
      console.error("Deployment evidence file does not satisfy Runtime Evidence Contract v1");
      return 1;
    }
    const evidence = runtimeEvidenceTrustMetadata(validation.evidence);
    inspectionOptions.deployedCommit = validation.evidence.deployment.commit;
    inspectionOptions.evidence = evidence;
    report = inspectNormalizedDeploymentVerification(options.target ?? process.cwd(), {
      expectedRef: options.expectedRef,
      expectedCommit: options.expectedCommit,
      deployedCommit: validation.evidence.deployment.commit,
      evidence,
    });
  } else {
    report = inspectDeploymentVerification(options.target ?? process.cwd(), inspectionOptions);
  }
  console.log(options.json ? JSON.stringify(report) : formatDeploymentVerification(report));
  return report.technicalStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
