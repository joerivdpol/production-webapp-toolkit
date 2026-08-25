#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { planRemediation } from "./plan-remediation.js";

const toolkitRoot = resolve(path.dirname(new URL(import.meta.url).pathname), "..");

/** @param {string} target @param {{ dryRun?: boolean }} options */
export function applySafeRemediation(target, options = {}) {
  const root = resolve(target);
  const dryRun = Boolean(options.dryRun);
  const plan = planRemediation(root);

  /** @type {Array<{ id: string, action: "create" | "skip", destination: string }>} */
  const actions = [];

  for (const item of plan.items) {
    if (item.remediation !== "safe") continue;

    if (item.id === "changed-lint-script") {
      const source = resolve(toolkitRoot, "scripts", "lint-changed.js");
      const destination = resolve(root, "scripts", "lint-changed.js");

      if (!fs.existsSync(source)) {
        throw new Error(`Toolkit source missing: ${source}`);
      }

      if (fs.existsSync(destination)) {
        actions.push({
          id: item.id,
          action: "skip",
          destination,
        });
        continue;
      }

      actions.push({
        id: item.id,
        action: "create",
        destination,
      });

      if (!dryRun) {
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination);
      }
    }
  }

  return {
    root,
    dryRun,
    actions,
    manualRemaining: plan.summary.manual,
  };
}

/** @param {ReturnType<typeof applySafeRemediation>} result */
export function formatApplyResult(result) {
  const lines = [
    `Safe remediation: ${result.root}`,
    "",
  ];

  if (result.actions.length === 0) {
    lines.push("No safe remediation actions needed.");
  } else {
    for (const action of result.actions) {
      lines.push(
        `${result.dryRun ? "DRY-RUN" : "APPLY"}  ${action.action.toUpperCase()}  ${action.destination}`,
      );
    }
  }

  if (result.manualRemaining > 0) {
    lines.push(
      "",
      `Manual remediation still required: ${result.manualRemaining}`,
    );
  }

  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const dryRun = argv.includes("--dry-run");
  const positional = argv.filter((argument) => argument !== "--dry-run");
  const target = positional[0] ?? process.cwd();

  const result = applySafeRemediation(target, { dryRun });
  console.log(formatApplyResult(result));

  return 0;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
