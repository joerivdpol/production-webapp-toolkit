#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectRepository } from "./audit-repository.js";

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   remediation: "safe" | "manual",
 *   reason: string
 * }} RemediationItem
 */

/** @param {string} target */
export function planRemediation(target) {
  const report = inspectRepository(target);

  /** @type {RemediationItem[]} */
  const items = [];

  for (const check of report.checks) {
    if (check.passed || !check.required) continue;

    switch (check.id) {
      case "changed-lint-script":
        items.push({
          id: check.id,
          label: check.label,
          remediation: "safe",
          reason: "The toolkit owns a reusable changed-files lint implementation.",
        });
        break;

      case "lint-script":
      case "typecheck-script":
      case "test-script":
      case "check-script":
        items.push({
          id: check.id,
          label: check.label,
          remediation: "manual",
          reason: "The correct command depends on the repository's existing toolchain.",
        });
        break;

      case "github-ci":
      case "ci-typecheck":
      case "ci-tests":
      case "ci-changed-lint":
      case "ci-build":
        items.push({
          id: check.id,
          label: check.label,
          remediation: "manual",
          reason: "Existing workflows and repository-specific CI behavior must be preserved.",
        });
        break;

      default:
        items.push({
          id: check.id,
          label: check.label,
          remediation: "manual",
          reason: "No deterministic automatic remediation is defined.",
        });
    }
  }

  return { report, items };
}

/** @param {ReturnType<typeof planRemediation>} plan */
export function formatRemediationPlan(plan) {
  const lines = [`Remediation plan: ${plan.report.root}`, ""];

  if (plan.items.length === 0) {
    lines.push("No required remediation needed.");
    return lines.join("\n");
  }

  for (const item of plan.items) {
    lines.push(
      `${item.remediation === "safe" ? "SAFE" : "MANUAL"}  ${item.label}`,
      `  ${item.reason}`,
    );
  }

  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const target = argv[0] ?? process.cwd();
  console.log(formatRemediationPlan(planRemediation(resolve(target))));
  return 0;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
