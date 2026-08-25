#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {"require-file" | "forbid-file" | "require-pattern" | "forbid-pattern"} RuleType
 */

/**
 * @typedef {{
 *   id: string,
 *   type: RuleType,
 *   path?: string,
 *   include?: string[],
 *   pattern?: string
 * }} ArchitectureRule
 */

/**
 * @typedef {{
 *   name: string,
 *   path: string,
 *   rules: ArchitectureRule[]
 * }} RepositoryPolicy
 */

/**
 * @typedef {{
 *   version: number,
 *   repositories: RepositoryPolicy[]
 * }} ArchitecturePolicy
 */

/** @param {string} root */
function listTextFiles(root) {
  /** @type {string[]} */
  const files = [];

  const ignoredDirectories = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    ".next",
    ".output",
    "coverage",
    "playwright-report",
    "test-results",
  ]);

  /** @param {string} directory */
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (ignoredDirectories.has(entry.name)) continue;

      const absolute = path.join(directory, entry.name);

      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }

      if (!entry.isFile()) continue;

      const stat = fs.statSync(absolute);
      if (stat.size > 1024 * 1024) continue;

      const buffer = fs.readFileSync(absolute);
      if (buffer.includes(0)) continue;

      files.push(path.relative(root, absolute).replaceAll("\\", "/"));
    }
  }

  walk(root);
  return files;
}

/** @param {string} root @param {ArchitectureRule} rule */
function candidateFiles(root, rule) {
  const files = listTextFiles(root);

  const include = rule.include;

  if (!include || include.length === 0) {
    return files;
  }

  return files.filter((file) =>
    include.some(
      (prefix) =>
        file === prefix ||
        file.startsWith(`${prefix.replace(/\/$/, "")}/`),
    ),
  );
}

/** @param {string} file */
function readText(file) {
  return fs.readFileSync(file, "utf8");
}

/** @param {string} policyPath @returns {ArchitecturePolicy} */
export function loadArchitecturePolicy(policyPath) {
  const absolute = resolve(policyPath);
  const parsed = JSON.parse(fs.readFileSync(absolute, "utf8"));

  if (
    !parsed ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.repositories)
  ) {
    throw new Error("Unsupported or invalid architecture policy");
  }

  return parsed;
}

/**
 * @param {ArchitecturePolicy} policy
 */
export function inspectArchitectureCompliance(policy) {
  /** @type {Array<{
   *   repository: string,
   *   rule: string,
   *   type: RuleType,
   *   passed: boolean,
   *   files: string[]
   * }>} */
  const results = [];

  for (const repository of policy.repositories) {
    const root = resolve(repository.path);

    if (!fs.existsSync(root)) {
      for (const rule of repository.rules) {
        results.push({
          repository: repository.name,
          rule: rule.id,
          type: rule.type,
          passed: false,
          files: [],
        });
      }
      continue;
    }

    for (const rule of repository.rules) {
      if (rule.type === "require-file" || rule.type === "forbid-file") {
        if (!rule.path) {
          throw new Error(`Rule ${rule.id} requires path`);
        }

        const exists = fs.existsSync(path.join(root, rule.path));
        const passed =
          rule.type === "require-file"
            ? exists
            : !exists;

        results.push({
          repository: repository.name,
          rule: rule.id,
          type: rule.type,
          passed,
          files: passed || !exists ? [] : [rule.path],
        });

        continue;
      }

      if (!rule.pattern) {
        throw new Error(`Rule ${rule.id} requires pattern`);
      }

      const regex = new RegExp(rule.pattern, "m");
      const matches = [];

      for (const file of candidateFiles(root, rule)) {
        const text = readText(path.join(root, file));

        if (regex.test(text)) {
          matches.push(file);
        }
      }

      const passed =
        rule.type === "require-pattern"
          ? matches.length > 0
          : matches.length === 0;

      results.push({
        repository: repository.name,
        rule: rule.id,
        type: rule.type,
        passed,
        files:
          rule.type === "forbid-pattern" && !passed
            ? matches
            : [],
      });
    }
  }

  return {
    results,
    summary: {
      rules: results.length,
      passed: results.filter((result) => result.passed).length,
      failed: results.filter((result) => !result.passed).length,
      repositories: new Set(
        results.map((result) => result.repository),
      ).size,
    },
  };
}

/** @param {ReturnType<typeof inspectArchitectureCompliance>} report */
export function formatArchitectureCompliance(report) {
  const lines = [
    "Architecture compliance audit",
    "",
  ];

  for (const result of report.results) {
    lines.push(
      `${result.passed ? "PASS" : "FAIL"}  ${result.repository}  ${result.rule}`,
    );

    if (!result.passed) {
      for (const file of result.files) {
        lines.push(`  ${file}`);
      }
    }
  }

  lines.push(
    "",
    `Repositories: ${report.summary.repositories}`,
    `Rules: ${report.summary.rules}`,
    `Passed: ${report.summary.passed}`,
    `Failed: ${report.summary.failed}`,
  );

  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");

  const policyIndex = positional.indexOf("--policy");

  const policyPath =
    policyIndex === -1
      ? undefined
      : positional[policyIndex + 1];

  if (!policyPath) {
    console.error(
      "Usage: node scripts/audit-architecture-compliance.js --policy <private-policy.json> [--json]",
    );
    return 1;
  }

  const policy = loadArchitecturePolicy(policyPath);

  const report = inspectArchitectureCompliance(policy);

  console.log(
    json
      ? JSON.stringify(report)
      : formatArchitectureCompliance(report),
  );

  return report.summary.failed === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
