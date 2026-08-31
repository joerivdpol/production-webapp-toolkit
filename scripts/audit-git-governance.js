#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const PRODUCTION_BRANCH_PATTERN = /^(?:production|prod)(?:\/|$)/;

/**
 * Run a Git command that reads local metadata only. No command in this module
 * contacts a remote or changes the target worktree, index, configuration, or
 * refs. Disabling optional locks also prevents incidental lock-file writes.
 *
 * @param {string} root
 * @param {string[]} args
 */
function readGit(root, args) {
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
  };
}

/** @param {string} output */
function lines(output) {
  return output ? output.split("\n").filter(Boolean) : [];
}

/**
 * @param {string} root
 * @param {string} id
 * @param {string} detail
 */
function failedReport(root, id, detail) {
  return finalize({
    root,
    head: null,
    currentBranch: null,
    detached: false,
    remotes: [],
    upstream: null,
    ahead: null,
    behind: null,
    fetchRefspecs: {},
    remoteHead: {},
    localBranches: [],
    remoteTrackingBranches: [],
    productionCandidates: [],
    checks: [{ id, severity: "FAIL", detail }],
  });
}

/**
 * @param {any} report
 */
function finalize(report) {
  const summary = {
    pass: report.checks.filter(
      /** @param {any} check */ (check) => check.severity === "PASS",
    ).length,
    warn: report.checks.filter(
      /** @param {any} check */ (check) => check.severity === "WARN",
    ).length,
    fail: report.checks.filter(
      /** @param {any} check */ (check) => check.severity === "FAIL",
    ).length,
  };

  return {
    ...report,
    summary: {
      ...summary,
      status: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS",
      technicallySucceeded: summary.fail === 0,
    },
  };
}

/** @param {string} refspec @param {string} remote */
function isFullBranchFetch(refspec, remote) {
  return (
    refspec.replace(/^\+/, "") ===
    `refs/heads/*:refs/remotes/${remote}/*`
  );
}

/**
 * Inspect the local Git governance metadata for a repository. This function is
 * deliberately offline: it never fetches, queries a hosting provider, or
 * chooses a canonical production branch.
 *
 * @param {string} target
 */
export function inspectGitGovernance(target) {
  const targetPath = path.resolve(target);

  let stat;
  try {
    stat = fs.statSync(targetPath);
  } catch {
    return failedReport(targetPath, "target-exists", "target path does not exist or cannot be read");
  }

  if (!stat.isDirectory()) {
    return failedReport(targetPath, "target-directory", "target path is not a directory");
  }

  const rootResult = readGit(targetPath, ["rev-parse", "--show-toplevel"]);

  if (rootResult.status !== 0 || !rootResult.output) {
    return failedReport(targetPath, "git-repository", "target is not a readable Git repository");
  }

  const root = rootResult.output;
  /** @type {any} */
  const report = {
    root,
    head: null,
    currentBranch: null,
    detached: false,
    remotes: [],
    upstream: null,
    ahead: null,
    behind: null,
    fetchRefspecs: {},
    remoteHead: {},
    localBranches: [],
    remoteTrackingBranches: [],
    productionCandidates: [],
    checks: [
      {
        id: "git-repository",
        severity: "PASS",
        detail: "local Git repository metadata is readable",
      },
    ],
  };

  const headResult = readGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);

  if (headResult.status !== 0 || !headResult.output) {
    return failedReport(root, "head", "HEAD commit cannot be read reliably");
  }

  report.head = headResult.output;

  const branchResult = readGit(root, ["symbolic-ref", "-q", "--short", "HEAD"]);

  if (branchResult.status === 0) {
    report.currentBranch = branchResult.output;
  } else if (branchResult.status === 1) {
    report.detached = true;
  } else {
    return failedReport(root, "current-branch", "current branch state cannot be read reliably");
  }

  const localBranches = readGit(root, [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);

  if (localBranches.status !== 0) {
    return failedReport(root, "local-branches", "local branches cannot be read reliably");
  }

  report.localBranches = lines(localBranches.output);

  const remoteTrackingBranches = readGit(root, [
    "for-each-ref",
    "--format=%(refname)%09%(symref)",
    "refs/remotes",
  ]);

  if (remoteTrackingBranches.status !== 0) {
    return failedReport(root, "remote-tracking-branches", "remote-tracking branches cannot be read reliably");
  }

  report.remoteTrackingBranches = lines(remoteTrackingBranches.output).flatMap(
    (line) => {
      const [ref, symbolicTarget] = line.split("\t");

      // Remote HEADs are symbolic metadata aliases, not remote-tracking
      // branches. Use the full refname here: Git abbreviates
      // refs/remotes/origin/HEAD to "origin", which otherwise makes the
      // alias indistinguishable from a branch in short-name output.
      if (!ref || symbolicTarget || !ref.startsWith("refs/remotes/")) {
        return [];
      }

      return [ref.slice("refs/remotes/".length)];
    },
  );

  const remotes = readGit(root, ["remote"]);

  if (remotes.status !== 0) {
    return failedReport(root, "remotes", "remotes cannot be read reliably");
  }

  report.remotes = lines(remotes.output);

  for (const remote of report.remotes) {
    const fetch = readGit(root, [
      "config",
      "--get-all",
      `remote.${remote}.fetch`,
    ]);

    if (fetch.status !== 0 && fetch.status !== 1) {
      return failedReport(root, "fetch-refspecs", "remote fetch refspecs cannot be read reliably");
    }

    report.fetchRefspecs[remote] = lines(fetch.output);

    /** @type {{available: boolean, ref: string | null, commit: string | null}} */
    const remoteHead = {
      available: false,
      ref: null,
      commit: null,
    };
    const symbolicHead = readGit(root, [
      "symbolic-ref",
      "-q",
      "--short",
      `refs/remotes/${remote}/HEAD`,
    ]);

    if (symbolicHead.status !== 0 && symbolicHead.status !== 1) {
      return failedReport(root, "remote-head", "local remote HEAD cannot be read reliably");
    }

    if (symbolicHead.status === 0 && symbolicHead.output) {
      remoteHead.ref = symbolicHead.output;
      const resolvedHead = readGit(root, [
        "rev-parse",
        "--verify",
        `refs/remotes/${remote}/HEAD^{commit}`,
      ]);

      if (resolvedHead.status === 0 && resolvedHead.output) {
        remoteHead.available = true;
        remoteHead.commit = resolvedHead.output;
      }
    } else if (symbolicHead.status === 1) {
      const resolvedHead = readGit(root, [
        "rev-parse",
        "--verify",
        `refs/remotes/${remote}/HEAD^{commit}`,
      ]);

      if (resolvedHead.status === 0 && resolvedHead.output) {
        remoteHead.available = true;
        remoteHead.ref = `${remote}/HEAD`;
        remoteHead.commit = resolvedHead.output;
      }
    }

    report.remoteHead[remote] = remoteHead;
  }

  for (const branch of report.localBranches) {
    if (PRODUCTION_BRANCH_PATTERN.test(branch)) {
      report.productionCandidates.push({
        branch,
        ref: `refs/heads/${branch}`,
        source: "local",
      });
    }
  }

  for (const trackingBranch of report.remoteTrackingBranches) {
    const slashIndex = trackingBranch.indexOf("/");
    const remote = trackingBranch.slice(0, slashIndex);
    const branch = trackingBranch.slice(slashIndex + 1);

    if (PRODUCTION_BRANCH_PATTERN.test(branch)) {
      report.productionCandidates.push({
        branch,
        ref: `refs/remotes/${trackingBranch}`,
        source: "remote-tracking",
        remote,
      });
    }
  }

  if (report.remotes.includes("origin")) {
    const originFetches = report.fetchRefspecs.origin;

    if (originFetches.length === 0) {
      report.checks.push({
        id: "origin-fetch-refspec",
        severity: "WARN",
        detail: "origin has no configured fetch refspec",
      });
    } else if (originFetches.some(
      /** @param {string} refspec */ (refspec) =>
        isFullBranchFetch(refspec, "origin"),
    )) {
      report.checks.push({
        id: "origin-fetch-refspec",
        severity: "PASS",
        detail: "origin fetch refspec includes all branch namespaces",
      });
    } else {
      report.checks.push({
        id: "origin-fetch-refspec",
        severity: "WARN",
        detail: "origin fetch refspec is restricted to selected namespaces",
      });
    }
  } else {
    report.checks.push({
      id: "origin-fetch-refspec",
      severity: "PASS",
      detail: "origin remote is not configured",
    });
  }

  for (const remote of report.remotes) {
    const remoteHead = report.remoteHead[remote];

    report.checks.push({
      id: `remote-head-${remote}`,
      severity: remoteHead.available ? "PASS" : "WARN",
      detail: remoteHead.available
        ? `local ${remote}/HEAD resolves to ${remoteHead.ref}`
        : `local ${remote}/HEAD is missing or cannot be resolved`,
    });
  }

  if (report.currentBranch) {
    const upstreamResult = readGit(root, [
      "for-each-ref",
      "--format=%(upstream:short)",
      `refs/heads/${report.currentBranch}`,
    ]);

    if (upstreamResult.status !== 0) {
      return failedReport(root, "upstream", "branch upstream cannot be read reliably");
    }

    report.upstream = upstreamResult.output || null;
  }

  if (!report.upstream) {
    report.checks.push({
      id: "upstream",
      severity: "WARN",
      detail: report.detached
        ? "HEAD is detached, so no current branch upstream is available"
        : "current branch has no upstream",
    });
  } else {
    report.checks.push({
      id: "upstream",
      severity: "PASS",
      detail: `current branch tracks ${report.upstream}`,
    });

    const divergence = readGit(root, [
      "rev-list",
      "--left-right",
      "--count",
      `HEAD...${report.upstream}`,
    ]);
    const match = /^(\d+)\s+(\d+)$/.exec(divergence.output);

    if (divergence.status === 0 && match) {
      report.ahead = Number(match[1]);
      report.behind = Number(match[2]);
      const diverged = report.ahead > 0 || report.behind > 0;

      report.checks.push({
        id: "branch-divergence",
        severity: diverged ? "WARN" : "PASS",
        detail: diverged
          ? `current branch is ${report.ahead} ahead and ${report.behind} behind its upstream`
          : "current branch and upstream have no divergence",
      });
    } else {
      report.checks.push({
        id: "branch-divergence",
        severity: "WARN",
        detail: "upstream exists but is not locally resolvable for ahead/behind comparison",
      });
    }
  }

  report.checks.push({
    id: "production-candidates",
    severity: "PASS",
    detail:
      report.productionCandidates.length > 0
        ? `${report.productionCandidates.length} production-like branch candidate(s) found; no production truth is inferred`
        : "no production-like branch candidates found; no production truth is inferred",
  });

  return finalize(report);
}

/** @param {any} report */
export function formatGitGovernance(report) {
  const lines = [
    `Git governance audit: ${report.root}`,
    "",
    `HEAD: ${report.head ?? "(unavailable)"}`,
    `Current branch: ${report.detached ? "(detached HEAD)" : (report.currentBranch ?? "(unavailable)")}`,
    `Remotes: ${report.remotes.length ? report.remotes.join(", ") : "(none)"}`,
    `Upstream: ${report.upstream ?? "(none)"}`,
    `Ahead / behind: ${report.ahead ?? "(unavailable)"} / ${report.behind ?? "(unavailable)"}`,
    "",
  ];

  for (const check of report.checks) {
    lines.push(`${check.severity}  ${check.id}  ${check.detail}`);
  }

  lines.push(
    "",
    `Production-like candidates: ${report.productionCandidates.length}`,
    `Result: ${report.summary.status} (${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail)`,
  );

  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");

  if (positional.length > 1) {
    console.error("Usage: node scripts/audit-git-governance.js [repository] [--json]");
    return 1;
  }

  const report = inspectGitGovernance(positional[0] ?? process.cwd());

  console.log(json ? JSON.stringify(report) : formatGitGovernance(report));

  return report.summary.technicallySucceeded ? 0 : 1;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
