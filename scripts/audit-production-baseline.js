#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/** @typedef {"PASS" | "WARN" | "FAIL"} Severity */
/** @typedef {{ id: string, severity: Severity, detail: string }} BaselineCheck */
/**
 * @typedef {{
 *   root: string,
 *   head: string | null,
 *   expectedRef: string | null,
 *   expectedCommit: string | null,
 *   expectedRefResolvedCommit: string | null,
 *   expectedCommitResolvedCommit: string | null,
 *   expectedResolvedCommit: string | null,
 *   compareRef: string | null,
 *   comparisonResolvedCommit: string | null,
 *   exactMatch: boolean | null,
 *   relationship: "same" | "expected-ancestor-of-comparison" | "comparison-ancestor-of-expected" | "diverged" | "unknown",
 *   ahead: number | null,
 *   behind: number | null,
 *   distanceDirection: string,
 *   checks: BaselineCheck[],
 *   technicalStatus: "PASS" | "FAIL",
 *   baselineStatus: "MATCH" | "MISMATCH" | "UNVERIFIED",
 *   overallStatus: "PASS" | "WARN" | "FAIL"
 * }} ProductionBaselineReport
 */
/** @typedef {{ expectedRef?: string | null, expectedCommit?: string | null, compareRef?: string | null }} BaselineOptions */

// This allowlist is intentionally narrow. The auditor must only inspect local
// Git data; no network or repository-mutating Git command can pass this guard.
const READ_ONLY_GIT_COMMANDS = new Set([
  "rev-parse",
  "cat-file",
  "merge-base",
  "rev-list",
]);

/**
 * Execute a local, read-only Git command. Optional locks are disabled so Git
 * cannot create incidental lock files while inspecting the target repository.
 *
 * @param {string} root
 * @param {string[]} args
 */
function readGit(root, args) {
  const command = args[0];
  if (!command || !READ_ONLY_GIT_COMMANDS.has(command)) {
    throw new Error(`Git command is not allowed by this auditor: ${command}`);
  }

  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
  });

  return {
    status: result.status,
    output: result.stdout?.trim() ?? "",
    error: result.error ?? null,
  };
}

/** @param {string} value */
function isCommitObjectName(value) {
  // Git's default minimum abbreviation length is four. The upper bound covers
  // both SHA-1 and SHA-256 object formats without accepting revision syntax.
  return /^[0-9a-fA-F]{4,64}$/.test(value);
}

/** @param {string} value */
function isSafeRefInput(value) {
  if (value === "HEAD") return true;

  // This mirrors Git's refname restrictions closely enough to accept both
  // fully-qualified and short refs while excluding revision operators. The
  // latter must never be passed through to rev-parse as input syntax.
  return (
    value.length > 0 &&
    value !== "@" &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !/^[.]|[\s\0~^:?*[\\]/.test(value) &&
    !value.split("/").some((component) =>
      component.startsWith(".") || component.endsWith(".lock"),
    )
  );
}

/** @param {ProductionBaselineReport} report */
function deriveStatuses(report) {
  const hasFailure = report.checks.some((check) => check.severity === "FAIL");
  const hasWarning = report.checks.some((check) => check.severity === "WARN");

  report.technicalStatus = hasFailure ? "FAIL" : "PASS";
  report.overallStatus = hasFailure
    ? "FAIL"
    : report.baselineStatus === "MISMATCH" ||
        report.baselineStatus === "UNVERIFIED" ||
        hasWarning
      ? "WARN"
      : "PASS";

  return report;
}

/**
 * @param {string} root
 * @param {string} id
 * @param {string} detail
 * @param {BaselineOptions} options
 * @returns {ProductionBaselineReport}
 */
function failedReport(root, id, detail, options) {
  return deriveStatuses({
    root,
    head: null,
    expectedRef: options.expectedRef ?? null,
    expectedCommit: options.expectedCommit ?? null,
    expectedRefResolvedCommit: null,
    expectedCommitResolvedCommit: null,
    expectedResolvedCommit: null,
    compareRef: options.compareRef ?? null,
    comparisonResolvedCommit: null,
    exactMatch: null,
    relationship: "unknown",
    ahead: null,
    behind: null,
    distanceDirection:
      "ahead and behind are comparison commits relative to expected: ahead is comparison-only; behind is expected-only",
    checks: [{ id, severity: "FAIL", detail }],
    baselineStatus: "UNVERIFIED",
    technicalStatus: "FAIL",
    overallStatus: "FAIL",
  });
}

/**
 * Resolve a local ref without permitting revision expressions from the input.
 * @param {string} root
 * @param {string} ref
 */
function resolveRef(root, ref) {
  if (!isSafeRefInput(ref)) return null;

  if (ref === "HEAD") {
    const result = readGit(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      "--end-of-options",
      "HEAD^{commit}",
    ]);
    return result.status === 0 && result.output ? result.output : null;
  }

  // Resolve the selector to a refname before peeling it. Besides preventing
  // revision syntax above, this stops a hex object ID from being accepted as
  // a ref through rev-parse's normal disambiguation rules.
  const symbolic = readGit(root, [
    "rev-parse",
    "--symbolic-full-name",
    "--verify",
    "--quiet",
    "--end-of-options",
    ref,
  ]);
  if (symbolic.status !== 0 || !symbolic.output) return null;

  const result = readGit(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${symbolic.output}^{commit}`,
  ]);

  return result.status === 0 && result.output ? result.output : null;
}

/**
 * Resolve a user-supplied object ID only when it is locally present as a
 * commit object. A ref name is deliberately not accepted for this option.
 * @param {string} root
 * @param {string} commit
 */
function resolveCommit(root, commit) {
  if (!isCommitObjectName(commit)) return null;

  const exists = readGit(root, ["cat-file", "-e", `${commit}^{commit}`]);
  if (exists.status !== 0) return null;

  const resolved = readGit(root, [
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    `${commit}^{commit}`,
  ]);

  return resolved.status === 0 && resolved.output ? resolved.output : null;
}

/**
 * Verify an explicitly supplied production baseline using local Git metadata
 * only. It never infers a production branch from ref names.
 *
 * @param {string} target
 * @param {BaselineOptions} options
 * @returns {ProductionBaselineReport}
 */
export function inspectProductionBaseline(target, options = {}) {
  const targetPath = path.resolve(target);

  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return failedReport(
      targetPath,
      "target-exists",
      "target path does not exist or cannot be read",
      options,
    );
  }

  if (!stat.isDirectory()) {
    return failedReport(
      targetPath,
      "target-directory",
      "target path is not a directory",
      options,
    );
  }

  const rootResult = readGit(targetPath, ["rev-parse", "--show-toplevel"]);
  if (rootResult.error || rootResult.status !== 0 || !rootResult.output) {
    return failedReport(
      targetPath,
      "git-repository",
      "target is not a readable non-bare Git repository",
      options,
    );
  }

  const root = rootResult.output;
  /** @type {ProductionBaselineReport} */
  const report = {
    root,
    head: null,
    expectedRef: options.expectedRef ?? null,
    expectedCommit: options.expectedCommit ?? null,
    expectedRefResolvedCommit: null,
    expectedCommitResolvedCommit: null,
    expectedResolvedCommit: null,
    compareRef: options.compareRef ?? null,
    comparisonResolvedCommit: null,
    exactMatch: null,
    relationship: "unknown",
    ahead: null,
    behind: null,
    distanceDirection:
      "ahead and behind are comparison commits relative to expected: ahead is comparison-only; behind is expected-only",
    checks: [
      {
        id: "git-repository",
        severity: "PASS",
        detail: "local Git repository metadata is readable",
      },
    ],
    baselineStatus: "UNVERIFIED",
    technicalStatus: "PASS",
    overallStatus: "WARN",
  };

  const head = readGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head.status === 0 && head.output) {
    report.head = head.output;
    report.checks.push({
      id: "head",
      severity: "PASS",
      detail: "HEAD resolves to a local commit",
    });
  } else {
    report.checks.push({
      id: "head",
      severity: "WARN",
      detail: "HEAD is not locally resolvable as a commit",
    });
  }

  if (report.expectedRef) {
    report.expectedRefResolvedCommit = resolveRef(root, report.expectedRef);
    report.checks.push({
      id: "expected-ref",
      severity: report.expectedRefResolvedCommit ? "PASS" : "WARN",
      detail: report.expectedRefResolvedCommit
        ? `expected ref resolves locally to ${report.expectedRefResolvedCommit}`
        : "expected ref is not locally resolvable; this does not establish whether a remote ref exists",
    });
  }

  if (report.expectedCommit) {
    report.expectedCommitResolvedCommit = resolveCommit(root, report.expectedCommit);
    report.checks.push({
      id: "expected-commit",
      severity: report.expectedCommitResolvedCommit ? "PASS" : "WARN",
      detail: report.expectedCommitResolvedCommit
        ? `expected commit resolves locally to ${report.expectedCommitResolvedCommit}`
        : "expected commit is not locally resolvable as a commit object",
    });
  }

  // A ref is the concrete baseline when supplied. A sole expected commit is a
  // baseline too. If both are supplied, the equality check below is part of
  // the explicit contract and neither side is silently preferred on mismatch.
  report.expectedResolvedCommit =
    report.expectedRefResolvedCommit ?? report.expectedCommitResolvedCommit;

  if (report.expectedRef && report.expectedCommit) {
    if (
      report.expectedRefResolvedCommit &&
      report.expectedCommitResolvedCommit
    ) {
      const matches =
        report.expectedRefResolvedCommit === report.expectedCommitResolvedCommit;
      report.baselineStatus = matches ? "MATCH" : "MISMATCH";
      report.checks.push({
        id: "expected-ref-commit-contract",
        severity: matches ? "PASS" : "WARN",
        detail: matches
          ? "expected ref and expected commit resolve to the same local commit"
          : "expected ref and expected commit resolve to different local commits",
      });
    } else {
      report.checks.push({
        id: "expected-ref-commit-contract",
        severity: "WARN",
        detail: "expected ref and expected commit cannot both be verified from local Git data",
      });
    }
  } else if (report.expectedResolvedCommit) {
    report.baselineStatus = "MATCH";
  }

  if (report.compareRef) {
    report.comparisonResolvedCommit = resolveRef(root, report.compareRef);
    report.checks.push({
      id: "compare-ref",
      severity: report.comparisonResolvedCommit ? "PASS" : "WARN",
      detail: report.comparisonResolvedCommit
        ? `comparison ref resolves locally to ${report.comparisonResolvedCommit}`
        : "comparison ref is not locally resolvable",
    });
  }

  if (report.expectedResolvedCommit && report.comparisonResolvedCommit) {
    report.exactMatch =
      report.expectedResolvedCommit === report.comparisonResolvedCommit;

    if (report.exactMatch) {
      report.relationship = "same";
      report.ahead = 0;
      report.behind = 0;
      report.checks.push({
        id: "comparison",
        severity: "PASS",
        detail: "expected baseline and comparison ref resolve to the same commit",
      });
    } else {
      const expectedAncestor = readGit(root, [
        "merge-base",
        "--is-ancestor",
        report.expectedResolvedCommit,
        report.comparisonResolvedCommit,
      ]);
      const comparisonAncestor =
        expectedAncestor.status === 1
          ? readGit(root, [
              "merge-base",
              "--is-ancestor",
              report.comparisonResolvedCommit,
              report.expectedResolvedCommit,
            ])
          : null;

      if (expectedAncestor.status === 0) {
        report.relationship = "expected-ancestor-of-comparison";
      } else if (comparisonAncestor?.status === 0) {
        report.relationship = "comparison-ancestor-of-expected";
      } else if (
        expectedAncestor.status === 1 &&
        comparisonAncestor?.status === 1
      ) {
        report.relationship = "diverged";
      } else {
        report.checks.push({
          id: "relationship",
          severity: "WARN",
          detail: "commit relationship cannot be determined from local Git metadata",
        });
      }

      const distance = readGit(root, [
        "rev-list",
        "--left-right",
        "--count",
        `${report.expectedResolvedCommit}...${report.comparisonResolvedCommit}`,
      ]);
      const match = /^(\d+)\s+(\d+)$/.exec(distance.output);

      if (distance.status === 0 && match) {
        report.behind = Number(match[1]);
        report.ahead = Number(match[2]);
      } else {
        report.checks.push({
          id: "commit-distance",
          severity: "WARN",
          detail: "commit distance cannot be determined from local Git metadata",
        });
      }

      report.checks.push({
        id: "comparison",
        severity: "WARN",
        detail: `expected baseline and comparison ref differ (${report.relationship})`,
      });
    }
  } else if (report.compareRef && !report.comparisonResolvedCommit) {
    report.checks.push({
      id: "comparison",
      severity: "WARN",
      detail: "comparison cannot be verified because the comparison ref is not locally resolvable",
    });
  } else if (report.compareRef && !report.expectedResolvedCommit) {
    report.checks.push({
      id: "comparison",
      severity: "WARN",
      detail: "comparison cannot be evaluated because the expected baseline is not locally resolvable",
    });
  }

  return deriveStatuses(report);
}

/** @param {ProductionBaselineReport} report */
export function formatProductionBaseline(report) {
  const lines = [
    `Production baseline audit: ${report.root}`,
    "",
    `HEAD: ${report.head ?? "(unavailable)"}`,
    `Expected ref: ${report.expectedRef ?? "(not supplied)"}`,
    `Expected commit: ${report.expectedCommit ?? "(not supplied)"}`,
    `Expected resolved commit: ${report.expectedResolvedCommit ?? "(unavailable)"}`,
    `Comparison ref: ${report.compareRef ?? "(not supplied)"}`,
    `Comparison resolved commit: ${report.comparisonResolvedCommit ?? "(unavailable)"}`,
    `Exact match: ${report.exactMatch === null ? "(unavailable)" : report.exactMatch}`,
    `Relationship: ${report.relationship}`,
    `Distance (comparison relative to expected): ${report.ahead ?? "(unavailable)"} ahead / ${report.behind ?? "(unavailable)"} behind`,
    "",
  ];

  for (const check of report.checks) {
    lines.push(`${check.severity}  ${check.id}  ${check.detail}`);
  }

  lines.push(
    "",
    `Technical status: ${report.technicalStatus}`,
    `Baseline status: ${report.baselineStatus}`,
    `Overall status: ${report.overallStatus}`,
  );

  return lines.join("\n");
}

/** @typedef {{ expectedRef: string | null, expectedCommit: string | null, compareRef: string | null, json: boolean, target: string | null }} CliArguments */
/** @param {string[]} argv @returns {CliArguments | null} */
function parseArguments(argv) {
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

  if (!options.expectedRef && !options.expectedCommit) return null;
  return options;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error(
      "Usage: node scripts/audit-production-baseline.js [repository] (--expected-ref <git-ref> | --expected-commit <commit>) [--compare-ref <git-ref>] [--json]",
    );
    return 1;
  }

  const report = inspectProductionBaseline(options.target ?? process.cwd(), options);
  console.log(options.json ? JSON.stringify(report) : formatProductionBaseline(report));
  return report.technicalStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
