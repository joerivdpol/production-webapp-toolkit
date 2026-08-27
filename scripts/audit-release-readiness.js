#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * @param {string} root
 */
export function inspectReleaseReadiness(root) {
  const packagePath = path.join(root, "package.json");
  const readmePath = path.join(root, "README.md");
  const ciPath = path.join(root, ".github", "workflows", "ci.yml");

  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const readme = fs.readFileSync(readmePath, "utf8");
  const ci = fs.readFileSync(ciPath, "utf8");

  const requiredScripts = [
    "typecheck",
    "test",
    "lint",
    "build",
    "check",
    "lint:changed",
  ];

  const requiredCapabilities = [
    "audit-profiled-repository.js",
    "audit-profiled-ecosystem.js",
    "audit-dependency-drift.js",
    "audit-public-repo-safety.js",
    "audit-architecture-compliance.js",
  ];

  const checks = [
    {
      id: "version",
      passed: /^1\.\d+\.\d+$/.test(pkg.version ?? ""),
      detail: `package version is ${pkg.version ?? "(missing)"}`,
    },
    {
      id: "license",
      passed: pkg.license === "MIT",
      detail: "MIT license metadata",
    },
    {
      id: "node-engine",
      passed: typeof pkg.engines?.node === "string",
      detail: "explicit Node.js engine",
    },
    {
      id: "package-manager",
      passed: typeof pkg.packageManager === "string",
      detail: "explicit package manager",
    },
    {
      id: "standard-scripts",
      passed: requiredScripts.every(
        (name) => typeof pkg.scripts?.[name] === "string",
      ),
      detail: "standard quality scripts",
    },
    {
      id: "capabilities-present",
      passed: requiredCapabilities.every((name) =>
        fs.existsSync(path.join(root, "scripts", name))
      ),
      detail: "v1 audit capabilities present",
    },
    {
      id: "public-safety-ci",
      passed: ci.includes("audit-public-repo-safety.js"),
      detail: "public repository safety is blocking in CI",
    },
    {
      id: "readme-profiled-audit",
      passed:
        readme.includes("profiled") ||
        readme.includes("repository profiles"),
      detail: "README documents repository profiles",
    },
    {
      id: "readme-dependency-drift",
      passed: readme.includes("dependency drift"),
      detail: "README documents dependency drift",
    },
    {
      id: "readme-public-safety",
      passed:
        readme.includes("public repository safety") ||
        readme.includes("public-repo"),
      detail: "README documents public repository safety",
    },
    {
      id: "readme-architecture-compliance",
      passed: readme.includes("architecture compliance"),
      detail: "README documents architecture compliance",
    },
  ];

  return {
    version: pkg.version,
    ready: checks.every((check) => check.passed),
    checks,
  };
}

/**
 * @param {{version?: string, ready: boolean, checks: Array<{id:string, passed:boolean, detail:string}>}} report
 */
export function formatReleaseReadiness(report) {
  const lines = [
    "Production Webapp Toolkit v1 release readiness",
    "",
  ];

  for (const check of report.checks) {
    lines.push(
      `${check.passed ? "PASS" : "MISS"}  ${check.id}  ${check.detail}`,
    );
  }

  lines.push("");
  lines.push(
    report.ready
      ? `Result: READY FOR v${report.version}`
      : "Result: NOT READY FOR v1.0",
  );

  return lines.join("\n");
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const positional = args.filter((arg) => arg !== "--json");
  const root = path.resolve(positional[0] ?? process.cwd());

  const report = inspectReleaseReadiness(root);

  if (json) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    process.stdout.write(`${formatReleaseReadiness(report)}\n`);
  }

  process.exitCode = report.ready ? 0 : 1;
}

const invokedPath = process.argv[1]
  ? path.resolve(process.argv[1])
  : null;

if (
  invokedPath &&
  fileURLToPath(import.meta.url) === invokedPath
) {
  main();
}
