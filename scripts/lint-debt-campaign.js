import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  assertLintDebtBaselineCompatible,
  compareLintDebt,
  planLintDebtRemediation,
  scanLintDebt,
} from "./lint-debt.js";

const DEFAULT_BASELINE_PATH = ".toolkit/lint-debt-baseline.json";

/** @param {string} root @param {any} scan */
function inspectBaseline(root, scan) {
  const filename = path.join(root, DEFAULT_BASELINE_PATH);
  if (!fs.existsSync(filename)) {
    return {
      status: "MISSING",
      path: DEFAULT_BASELINE_PATH,
      newDebt: null,
      improvedDebt: null,
    };
  }

  try {
    const baseline = JSON.parse(fs.readFileSync(filename, "utf8"));
    assertLintDebtBaselineCompatible(scan, baseline);
    const comparison = compareLintDebt(scan.issueGroups, baseline);
    return {
      status: comparison.newDebt === 0 ? "PASS" : "FAIL",
      path: DEFAULT_BASELINE_PATH,
      newDebt: comparison.newDebt,
      improvedDebt: comparison.improvedDebt,
    };
  } catch (error) {
    return {
      status: "INCOMPATIBLE",
      path: DEFAULT_BASELINE_PATH,
      newDebt: null,
      improvedDebt: null,
      reason: error instanceof Error ? error.message : "baseline validation failed",
    };
  }
}

/** @param {string} target */
export async function analyzeLintDebtRepository(target) {
  const root = path.resolve(target);
  const scan = await scanLintDebt(root);
  const plan = await planLintDebtRemediation(root);
  return {
    repository: root,
    status: "OK",
    lint: {
      issues: scan.summary.issues,
      errors: scan.summary.errors,
      warnings: scan.summary.warnings,
      fixable: scan.summary.fixable,
      filesWithIssues: scan.summary.filesWithIssues,
      lintedFiles: scan.selection.linted,
    },
    baseline: inspectBaseline(root, scan),
    cleanup: {
      candidateFiles: plan.summary.candidateFiles,
      nextBatchFiles: plan.summary.selectedFiles,
      nextBatchBytes: plan.summary.selectedBytes,
      plannedResolvedProblems: plan.summary.plannedResolvedProblems,
      nextBatch: plan.selected.map((item) => ({
        file: item.file,
        resolvedProblems: item.resolvedProblems,
        outputBytes: item.outputBytes,
      })),
      risk: plan.risk,
      automatic: plan.automatic,
    },
  };
}

/** @param {string[]} targets */
export async function buildLintDebtCampaign(targets) {
  const repositories = [...new Set(targets.map((target) => path.resolve(target)))];
  if (repositories.length === 0) {
    throw new Error("At least one repository path is required");
  }

  const successes = [];
  const failures = [];

  for (const repository of repositories) {
    try {
      successes.push(await analyzeLintDebtRepository(repository));
    } catch (error) {
      failures.push({
        repository,
        status: "ERROR",
        error: "Lint debt scan failed: " + (error instanceof Error ? error.message : "unknown error"),
      });
    }
  }

  successes.sort(
    (a, b) =>
      b.cleanup.plannedResolvedProblems - a.cleanup.plannedResolvedProblems ||
      b.lint.issues - a.lint.issues ||
      a.repository.localeCompare(b.repository),
  );

  const ranked = successes.map((result, index) => ({
    ...result,
    priority: index + 1,
  }));
  failures.sort((a, b) => a.repository.localeCompare(b.repository));

  return {
    version: 1,
    mode: "READ_ONLY_CAMPAIGN",
    mutationAuthorized: false,
    summary: {
      repositories: repositories.length,
      scanned: ranked.length,
      failed: failures.length,
      issues: ranked.reduce((sum, item) => sum + item.lint.issues, 0),
      errors: ranked.reduce((sum, item) => sum + item.lint.errors, 0),
      warnings: ranked.reduce((sum, item) => sum + item.lint.warnings, 0),
      candidateFiles: ranked.reduce(
        (sum, item) => sum + item.cleanup.candidateFiles,
        0,
      ),
      nextBatchFiles: ranked.reduce(
        (sum, item) => sum + item.cleanup.nextBatchFiles,
        0,
      ),
      plannedResolvedProblems: ranked.reduce(
        (sum, item) => sum + item.cleanup.plannedResolvedProblems,
        0,
      ),
      baselines: {
        pass: ranked.filter((item) => item.baseline.status === "PASS").length,
        fail: ranked.filter((item) => item.baseline.status === "FAIL").length,
        missing: ranked.filter((item) => item.baseline.status === "MISSING").length,
        incompatible: ranked.filter(
          (item) => item.baseline.status === "INCOMPATIBLE",
        ).length,
      },
    },
    repositories: [...ranked, ...failures],
  };
}

/** @param {string[]} argv */
function parseCli(argv) {
  const repositories = [];
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--repo") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return null;
      repositories.push(value);
      index += 1;
      continue;
    }
    if (argument?.startsWith("--")) return null;
    if (argument) repositories.push(argument);
  }

  if (repositories.length === 0) return null;
  return { repositories, json };
}

/** @param {any} report */
function formatHuman(report) {
  const lines = [
    "Lint debt campaign (read-only)",
    "Repositories: " +
      report.summary.scanned +
      "/" +
      report.summary.repositories +
      " scanned; " +
      report.summary.failed +
      " failed",
    "Historical issues: " + report.summary.issues,
    "Safe next-batch opportunity: " +
      report.summary.plannedResolvedProblems +
      " issue(s) across " +
      report.summary.nextBatchFiles +
      " file(s)",
    "Baselines: " +
      report.summary.baselines.pass +
      " pass, " +
      report.summary.baselines.fail +
      " fail, " +
      report.summary.baselines.missing +
      " missing, " +
      report.summary.baselines.incompatible +
      " incompatible",
    "",
  ];

  for (const item of report.repositories) {
    if (item.status === "ERROR") {
      lines.push("ERROR  " + item.repository + ": " + item.error);
      continue;
    }
    lines.push(
      "#" + item.priority + " " + item.repository,
      "  issues=" +
        item.lint.issues +
        " safe-next=" +
        item.cleanup.plannedResolvedProblems +
        " baseline=" +
        item.baseline.status,
    );
    for (const next of item.cleanup.nextBatch) {
      lines.push(
        "    " +
          next.file +
          " resolve=" +
          next.resolvedProblems +
          " bytes=" +
          next.outputBytes,
      );
    }
  }

  return lines.join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  if (!parsed) {
    console.error(
      "Usage: node scripts/lint-debt-campaign.js <repository> [repository...] [--repo <repository>] [--json]",
    );
    return 1;
  }

  try {
    const report = await buildLintDebtCampaign(parsed.repositories);
    console.log(parsed.json ? JSON.stringify(report) : formatHuman(report));
    return report.summary.failed === 0 ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Lint debt campaign failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = await main();
}
