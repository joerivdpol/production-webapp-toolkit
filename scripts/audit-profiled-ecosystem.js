#!/usr/bin/env node

import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { inspectProfiledRepository } from "./audit-profiled-repository.js";

/**
 * @typedef {{
 *   name: string,
 *   path: string,
 *   profile: "webapp" | "python-service" | "unknown",
 *   corePassed: boolean,
 *   passed: number,
 *   total: number,
 *   requiredPassed: number,
 *   requiredTotal: number
 * }} EcosystemRepositoryResult
 */

/** @param {string[]} targets */
export function inspectProfiledEcosystem(targets) {
  /** @type {EcosystemRepositoryResult[]} */
  const repositories = [];

  for (const target of targets) {
    const root = resolve(target);
    const result = inspectProfiledRepository(root);

    if (!result.report) {
      repositories.push({
        name: path.basename(root),
        path: root,
        profile: "unknown",
        corePassed: false,
        passed: 0,
        total: 0,
        requiredPassed: 0,
        requiredTotal: 0,
      });
      continue;
    }

    repositories.push({
      name: path.basename(root),
      path: root,
      profile: result.profile,
      corePassed: result.report.corePassed,
      passed: result.report.passed,
      total: result.report.checks.length,
      requiredPassed: result.report.requiredPassed,
      requiredTotal: result.report.requiredTotal,
    });
  }

  return {
    repositories,
    summary: {
      repositories: repositories.length,
      corePassed: repositories.filter((repo) => repo.corePassed).length,
      coreFailed: repositories.filter((repo) => !repo.corePassed).length,
      webapps: repositories.filter((repo) => repo.profile === "webapp").length,
      pythonServices: repositories.filter((repo) => repo.profile === "python-service").length,
      unknown: repositories.filter((repo) => repo.profile === "unknown").length,
      passedChecks: repositories.reduce((sum, repo) => sum + repo.passed, 0),
      totalChecks: repositories.reduce((sum, repo) => sum + repo.total, 0),
      requiredPassed: repositories.reduce((sum, repo) => sum + repo.requiredPassed, 0),
      requiredTotal: repositories.reduce((sum, repo) => sum + repo.requiredTotal, 0),
    },
  };
}

/** @param {ReturnType<typeof inspectProfiledEcosystem>} report */
export function formatProfiledEcosystem(report) {
  const lines = ["Profiled ecosystem audit", ""];

  for (const repo of report.repositories) {
    lines.push(
      `${repo.corePassed ? "PASS" : "FAIL"}  ${repo.profile.padEnd(14)}  ${repo.name}  ${repo.passed}/${repo.total}  core ${repo.requiredPassed}/${repo.requiredTotal}`,
    );
  }

  lines.push(
    "",
    `Repositories: ${report.summary.repositories}`,
    `Profiles: ${report.summary.webapps} webapp, ${report.summary.pythonServices} python-service, ${report.summary.unknown} unknown`,
    `Core: ${report.summary.corePassed} pass, ${report.summary.coreFailed} fail`,
    `Checks: ${report.summary.passedChecks}/${report.summary.totalChecks}`,
    `Required: ${report.summary.requiredPassed}/${report.summary.requiredTotal}`,
  );

  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");

  if (positional.length === 0) {
    console.error(
      "Usage: node scripts/audit-profiled-ecosystem.js <repository> [repository...] [--json]",
    );
    return 1;
  }

  const report = inspectProfiledEcosystem(positional);

  console.log(
    json
      ? JSON.stringify(report)
      : formatProfiledEcosystem(report),
  );

  return report.summary.coreFailed === 0 ? 0 : 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
