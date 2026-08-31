#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { inspectProfiledRepository } from "./audit-profiled-repository.js";
import { inspectGitGovernance } from "./audit-git-governance.js";
import { inspectProductionBaseline } from "./audit-production-baseline.js";

/** @typedef {{ expectedRef?: string | null, expectedCommit?: string | null, compareRef?: string | null }} BaselineOptions */

/** @param {unknown} error */
function errorDetail(error) {
  return error instanceof Error ? error.message : "unknown audit error";
}

/**
 * The profiled audit has no technical-status field: an unsupported profile is
 * a quality failure, not an inspection failure. Preserve that distinction
 * while making an unexpected inspector exception visible as technical.
 *
 * @param {string} target
 */
function inspectQuality(target) {
  try {
    const result = inspectProfiledRepository(target);
    const report = result.report;

    return {
      status: report?.corePassed ? "PASS" : "FAIL",
      technicalStatus: "PASS",
      profile: result.profile,
      requiredPassed: report?.requiredPassed ?? null,
      requiredTotal: report?.requiredTotal ?? null,
      corePassed: report?.corePassed ?? false,
    };
  } catch (error) {
    return {
      status: "FAIL",
      technicalStatus: "FAIL",
      profile: "unknown",
      requiredPassed: null,
      requiredTotal: null,
      corePassed: false,
      detail: `profiled quality audit could not run reliably: ${errorDetail(error)}`,
    };
  }
}

/** @param {string} target */
function inspectGovernance(target) {
  try {
    const report = inspectGitGovernance(target);
    return {
      status: report.summary.status,
      technicalStatus: report.summary.technicallySucceeded ? "PASS" : "FAIL",
      summary: report.summary,
      head: report.head,
      currentBranch: report.currentBranch,
      detached: report.detached,
      upstream: report.upstream,
      ahead: report.ahead,
      behind: report.behind,
      productionCandidates: report.productionCandidates,
      checks: report.checks,
    };
  } catch (error) {
    return {
      status: "FAIL",
      technicalStatus: "FAIL",
      summary: { pass: 0, warn: 0, fail: 1, status: "FAIL", technicallySucceeded: false },
      head: null,
      currentBranch: null,
      detached: false,
      upstream: null,
      ahead: null,
      behind: null,
      productionCandidates: [],
      checks: [{ id: "governance-inspection", severity: "FAIL", detail: errorDetail(error) }],
    };
  }
}

/** @param {string} target @param {BaselineOptions} options */
function inspectBaseline(target, options) {
  try {
    const report = inspectProductionBaseline(target, options);
    return {
      configured: true,
      status: report.overallStatus,
      technicalStatus: report.technicalStatus,
      baselineStatus: report.baselineStatus,
      overallStatus: report.overallStatus,
      expectedRef: report.expectedRef,
      expectedCommit: report.expectedCommit,
      expectedResolvedCommit: report.expectedResolvedCommit,
      compareRef: report.compareRef,
      comparisonResolvedCommit: report.comparisonResolvedCommit,
      exactMatch: report.exactMatch,
      relationship: report.relationship,
      ahead: report.ahead,
      behind: report.behind,
      checks: report.checks,
    };
  } catch (error) {
    return {
      configured: true,
      status: "FAIL",
      technicalStatus: "FAIL",
      baselineStatus: "UNVERIFIED",
      overallStatus: "FAIL",
      expectedRef: options.expectedRef ?? null,
      expectedCommit: options.expectedCommit ?? null,
      expectedResolvedCommit: null,
      compareRef: options.compareRef ?? null,
      comparisonResolvedCommit: null,
      exactMatch: null,
      relationship: "unknown",
      ahead: null,
      behind: null,
      checks: [{ id: "baseline-inspection", severity: "FAIL", detail: errorDetail(error) }],
    };
  }
}

function notConfiguredBaseline() {
  return {
    configured: false,
    status: "NOT_CONFIGURED",
    technicalStatus: "PASS",
    baselineStatus: null,
    overallStatus: null,
    expectedRef: null,
    expectedCommit: null,
    expectedResolvedCommit: null,
    compareRef: null,
    comparisonResolvedCommit: null,
    exactMatch: null,
    relationship: null,
    ahead: null,
    behind: null,
    checks: [],
  };
}

/**
 * Compose existing read-only repository auditors. This layer deliberately
 * never uses governance productionCandidates to choose a baseline.
 *
 * @param {string} target
 * @param {BaselineOptions} options
 */
export function inspectRepositoryStatus(target, options = {}) {
  const root = resolve(target);
  const quality = inspectQuality(root);
  const governance = inspectGovernance(root);
  const baselineConfigured = Boolean(options.expectedRef || options.expectedCommit);
  const baseline = baselineConfigured
    ? inspectBaseline(root, options)
    : notConfiguredBaseline();

  const technicalStatus =
    quality.technicalStatus === "FAIL" ||
    governance.technicalStatus === "FAIL" ||
    (baseline.configured && baseline.technicalStatus === "FAIL")
      ? "FAIL"
      : "PASS";

  const overallStatus =
    quality.status === "FAIL" ||
    governance.status === "FAIL" ||
    (baseline.configured && baseline.technicalStatus === "FAIL")
      ? "FAIL"
      : governance.status === "WARN" ||
          !baseline.configured ||
          baseline.overallStatus === "WARN"
        ? "WARN"
        : "PASS";

  return {
    root,
    profile: quality.profile,
    baselineConfigured: baseline.configured,
    dimensions: { quality, governance, baseline },
    technicalStatus,
    overallStatus,
    summary: {
      quality: quality.status,
      governance: governance.status,
      baseline: baseline.status,
    },
  };
}

/** @param {ReturnType<typeof inspectRepositoryStatus>} report */
export function formatRepositoryStatus(report) {
  const { quality, governance, baseline } = report.dimensions;
  const baselineLabel = baseline.configured
    ? `${baseline.status} (${baseline.baselineStatus})`
    : baseline.status;

  return [
    `Repository status: ${report.root}`,
    "",
    `QUALITY     ${quality.status} (${quality.profile}; core ${quality.requiredPassed ?? 0}/${quality.requiredTotal ?? 0})`,
    `GOVERNANCE  ${governance.status}`,
    `BASELINE    ${baselineLabel}`,
    "",
    `Technical: ${report.technicalStatus}`,
    `Overall: ${report.overallStatus}`,
  ].join("\n");
}

/** @typedef {{ expectedRef: string | null, expectedCommit: string | null, compareRef: string | null, json: boolean, target: string | null }} CliArguments */
/** @param {string[]} argv @returns {CliArguments | null} */
export function parseArguments(argv) {
  /** @type {CliArguments} */
  const options = {
    expectedRef: null,
    expectedCommit: null,
    compareRef: null,
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
      argument === "--compare-ref"
    ) {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) return null;

      if (argument === "--expected-ref") options.expectedRef = value;
      if (argument === "--expected-commit") options.expectedCommit = value;
      if (argument === "--compare-ref") options.compareRef = value;
      index += 1;
    } else if (argument.startsWith("-")) {
      return null;
    } else if (options.target === null) {
      options.target = argument;
    } else {
      return null;
    }
  }

  if (options.compareRef && !options.expectedRef && !options.expectedCommit) return null;
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error(
      "Usage: node scripts/audit-repository-status.js [repository] [--expected-ref <git-ref> | --expected-commit <commit>] [--compare-ref <git-ref>] [--json]",
    );
    return 1;
  }

  const report = inspectRepositoryStatus(options.target ?? process.cwd(), options);
  console.log(options.json ? JSON.stringify(report) : formatRepositoryStatus(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
