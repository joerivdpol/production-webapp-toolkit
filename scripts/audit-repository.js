#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_IDS = new Set([
  "package-json", "package-manager", "typescript", "lint-script", "typecheck-script", "test-script",
  "check-script", "changed-lint-script", "github-ci", "ci-typecheck", "ci-tests", "ci-changed-lint", "ci-build",
]);

/** @typedef {{ id: string, label: string, passed: boolean, required: boolean }} AuditCheck */
/** @typedef {{ root: string, checks: AuditCheck[], passed: number, requiredPassed: number, requiredTotal: number, corePassed: boolean }} AuditReport */
/** @typedef {{ packageManager?: unknown, scripts?: Record<string, unknown> }} PackageMetadata */

/** @param {string} path */
function readText(path) {
  try { return readFileSync(path, "utf8"); } catch { return ""; }
}

/** @param {string} root @param {string[]} paths */
function hasAny(root, paths) {
  return paths.some((path) => existsSync(resolve(root, path)));
}

/** @param {string} root */
function workflowText(root) {
  const directory = resolve(root, ".github/workflows");
  if (!existsSync(directory)) return "";
  return readdirSync(directory)
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => readText(resolve(directory, name)))
    .join("\n");
}

/** @param {string} workflows @param {string} script */
function scriptRunsInCi(workflows, script) {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:bun|npm|pnpm|yarn)\\s+(?:run\\s+)?${escaped}(?:\\s|$)`, "m").test(workflows);
}

/** @param {string} target @returns {AuditReport} */
export function inspectRepository(target) {
  const root = resolve(target);
  const packagePath = resolve(root, "package.json");
  /** @type {PackageMetadata} */
  let packageJson = {};
  try { packageJson = JSON.parse(readText(packagePath)); } catch { /* Report invalid JSON as missing package metadata. */ }
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const workflows = workflowText(root);
  const packageManager =
    (typeof packageJson.packageManager === "string" && /^(?:bun|npm|pnpm|yarn)@/.test(packageJson.packageManager)) ||
    hasAny(root, ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);

  /** @type {Array<[string, string, unknown]>} */
  const definitions = [
    ["package-json", "package.json", existsSync(packagePath)],
    ["package-manager", "Recognized package manager", packageManager],
    ["agents", "AGENTS.md", existsSync(resolve(root, "AGENTS.md"))],
    ["development-docs", "docs/development.md", existsSync(resolve(root, "docs/development.md"))],
    ["typescript", "TypeScript configuration", hasAny(root, ["tsconfig.json", "tsconfig.base.json"])],
    ["lint-script", "lint script", typeof scripts.lint === "string"],
    ["typecheck-script", "typecheck script", typeof scripts.typecheck === "string"],
    ["test-script", "test script", typeof scripts.test === "string"],
    ["check-script", "check script", typeof scripts.check === "string"],
    ["changed-lint-script", "Changed-files lint script", existsSync(resolve(root, "scripts/lint-changed.js"))],
    ["github-ci", "GitHub Actions CI", workflows.length > 0],
    ["ci-typecheck", "Blocking typecheck in CI", scriptRunsInCi(workflows, "typecheck")],
    ["ci-tests", "Automated tests in CI", scriptRunsInCi(workflows, "test")],
    ["ci-changed-lint", "Changed-files lint gate in CI", scriptRunsInCi(workflows, "lint:changed")],
    ["ci-build", "Production build in CI", scriptRunsInCi(workflows, "build")],
    ["playwright", "Playwright configuration", hasAny(root, ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"])],
    ["e2e-script", "E2E script", typeof scripts.e2e === "string" || typeof scripts["test:e2e"] === "string"],
    ["ci-e2e", "E2E tests invoked in CI", scriptRunsInCi(workflows, "e2e") || scriptRunsInCi(workflows, "test:e2e")],
  ];
  const checks = definitions.map(([id, label, passed]) => ({ id, label, passed: Boolean(passed), required: REQUIRED_IDS.has(id) }));

  const required = checks.filter((check) => check.required);
  return {
    root,
    checks,
    passed: checks.filter((check) => check.passed).length,
    requiredPassed: required.filter((check) => check.passed).length,
    requiredTotal: required.length,
    corePassed: required.every((check) => check.passed),
  };
}

/** @param {AuditReport} report */
export function formatScorecard(report) {
  const lines = [
    `Repository audit: ${report.root}`,
    "",
    ...report.checks.map((check) => `${check.passed ? "PASS" : "MISS"}  ${check.required ? "required" : "optional"}  ${check.label}`),
    "",
    `Score: ${report.passed}/${report.checks.length} checks; core: ${report.requiredPassed}/${report.requiredTotal}`,
    report.corePassed
      ? "Result: PASS — all required core quality gates are present."
      : "Result: FAIL — one or more required core quality gates are missing.",
    "Required checks establish the install, TypeScript, script, changed-lint, and CI gate baseline; documentation and the three E2E readiness checks are optional.",
  ];
  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const target = argv[0] ?? process.cwd();
  const report = inspectRepository(target);
  console.log(formatScorecard(report));
  return report.corePassed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main();
