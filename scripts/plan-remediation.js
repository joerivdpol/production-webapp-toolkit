#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectRepository } from "./audit-repository.js";

/**
 * @typedef {{
 *   id: string,
 *   label: string,
 *   remediation: "safe" | "manual",
 *   automatic: boolean,
 *   risk: "LOW" | "MEDIUM" | "HIGH",
 *   ownership: "toolkit" | "repository",
 *   files: string[],
 *   validation: { checks: string[], commands: string[] },
 *   reason: string
 * }} RemediationItem
 */
/** @typedef {{ automatic:boolean, risk:"LOW"|"MEDIUM"|"HIGH", ownership:"toolkit"|"repository", files:string[], validation:{checks:string[],commands:string[]} }} RemediationMetadata */

/** @param {string} id @returns {RemediationMetadata} */
function remediationMetadata(id) {
  if (id === "changed-lint-script") {
    return {
      automatic: true,
      risk: "LOW",
      ownership: "toolkit",
      files: ["scripts/lint-changed.js"],
      validation: { checks: [id], commands: [] },
    };
  }

  if (["lint-script", "typecheck-script", "test-script", "check-script"].includes(id)) {
    return {
      automatic: false,
      risk: "MEDIUM",
      ownership: "repository",
      files: ["package.json"],
      validation: { checks: [id], commands: [] },
    };
  }

  if (["github-ci", "ci-typecheck", "ci-tests", "ci-changed-lint", "ci-build"].includes(id)) {
    return {
      automatic: false,
      risk: "MEDIUM",
      ownership: "repository",
      files: [".github/workflows/*.yml", ".github/workflows/*.yaml"],
      validation: { checks: [id], commands: [] },
    };
  }

  return {
    automatic: false,
    risk: "HIGH",
    ownership: "repository",
    files: [],
    validation: { checks: [id], commands: [] },
  };
}

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
          ...remediationMetadata(check.id),
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
          ...remediationMetadata(check.id),
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
          ...remediationMetadata(check.id),
          reason: "Existing workflows and repository-specific CI behavior must be preserved.",
        });
        break;

      default:
        items.push({
          id: check.id,
          label: check.label,
          remediation: "manual",
          ...remediationMetadata(check.id),
          reason: "No deterministic automatic remediation is defined.",
        });
    }
  }

  const safeCount = items.filter((item) => item.remediation === "safe").length;
  const manualCount = items.filter((item) => item.remediation === "manual").length;

  return {
    version: 1,
    report,
    items,
    summary: {
      total: items.length,
      safe: safeCount,
      manual: manualCount,
      risk: {
        low: items.filter((item) => item.risk === "LOW").length,
        medium: items.filter((item) => item.risk === "MEDIUM").length,
        high: items.filter((item) => item.risk === "HIGH").length,
      },
      ownership: {
        toolkit: items.filter((item) => item.ownership === "toolkit").length,
        repository: items.filter((item) => item.ownership === "repository").length,
      },
    },
  };
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
      `${item.remediation === "safe" ? "SAFE" : "MANUAL"}  ${item.risk}  ${item.ownership.toUpperCase()}  ${item.label}`,
      `  Files: ${item.files.join(", ") || "(repository-specific; not inferred)"}`,
      `  Validate: ${item.validation.checks.join(", ")}`,
      `  ${item.reason}`,
    );
  }

  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");
  const target = positional[0] ?? process.cwd();

  const plan = planRemediation(resolve(target));

  console.log(
    json
      ? JSON.stringify(plan)
      : formatRemediationPlan(plan),
  );

  return 0;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
