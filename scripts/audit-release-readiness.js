#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REQUIRED_SCRIPTS = [
  "typecheck", "test", "lint", "build", "check", "lint:changed",
  "audit:safety", "audit:git-governance", "audit:production-baseline",
  "audit:deployment", "audit:repository-status", "audit:ecosystem-status",
  "audit:release", "runtime:evidence", "release:verify",
];

const REQUIRED_CAPABILITIES = [
  "audit-profiled-repository.js",
  "audit-profiled-ecosystem.js",
  "audit-dependency-drift.js",
  "audit-public-repo-safety.js",
  "audit-architecture-compliance.js",
  "audit-git-governance.js",
  "audit-production-baseline.js",
  "audit-deployment-verification.js",
  "runtime-evidence.js",
  "audit-repository-status.js",
  "audit-ecosystem-status.js",
];
/** @param {string} file */
function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

/** @param {unknown} value */
function pinnedBunVersion(value) {
  if (typeof value !== "string") return null;
  return /^bun@(\d+\.\d+\.\d+)$/.exec(value)?.[1] ?? null;
}

/** @param {string} value */
function exactVersion(value) {
  return /^\d+\.\d+\.\d+$/.test(value);
}

/** @param {string} nodeVersion @param {unknown} engine */
function engineMatchesNodeMajor(nodeVersion, engine) {
  if (!exactVersion(nodeVersion) || typeof engine !== "string") return false;
  const major = Number(nodeVersion.split(".")[0]);
  return engine.trim() === `>=${major} <${major + 1}`;
}

/** @param {string} text @param {string} script */
function ciRuns(text, script) {
  return text.includes(`bun run ${script}`);
}
/**
 * @param {string} root
 * @param {{ expectedVersion?: string | null }} [options]
 */
export function inspectReleaseReadiness(root, options = {}) {
  const packagePath = path.join(root, "package.json");
  const readmePath = path.join(root, "README.md");
  const roadmapPath = path.join(root, "docs", "roadmap.md");
  const ciPath = path.join(root, ".github", "workflows", "ci.yml");
  const nodeVersionPath = path.join(root, ".node-version");
  const releaseNotesPath = path.join(root, "docs", "releases", "v1.1.0.md");
  const lockfilePath = fs.existsSync(path.join(root, "bun.lock"))
    ? path.join(root, "bun.lock")
    : path.join(root, "bun.lockb");

  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const readme = readText(readmePath);
  const roadmap = readText(roadmapPath);
  const ci = readText(ciPath);
  const releaseNotes = readText(releaseNotesPath);
  const nodeVersion = readText(nodeVersionPath).trim();
  const bunVersion = pinnedBunVersion(pkg.packageManager);
  const expectedVersion = options.expectedVersion ?? null;

  const checks = [
    {
      id: "version-semver",
      passed: /^1\.\d+\.\d+$/.test(pkg.version ?? ""),
      detail: `package version is ${pkg.version ?? "(missing)"}`,
    },
    {
      id: "expected-version",
      passed: expectedVersion === null || pkg.version === expectedVersion,
      detail: expectedVersion === null ? "no exact release version requested" : `package version must equal ${expectedVersion}`,
    },
    { id: "license", passed: pkg.license === "MIT", detail: "MIT license metadata" },
    {
      id: "node-version-pinned",
      passed: exactVersion(nodeVersion),
      detail: `reference Node.js version is ${nodeVersion || "(missing)"}`,
    },
    {
      id: "node-engine-consistent",
      passed: engineMatchesNodeMajor(nodeVersion, pkg.engines?.node),
      detail: `Node.js engine is ${pkg.engines?.node ?? "(missing)"}`,
    },
    {
      id: "bun-version-pinned",
      passed: bunVersion !== null,
      detail: `package manager is ${pkg.packageManager ?? "(missing)"}`,
    },
    {
      id: "standard-scripts",
      passed: REQUIRED_SCRIPTS.every((name) => typeof pkg.scripts?.[name] === "string"),
      detail: "v1.1 quality, evidence, status, and release scripts are present",
    },
    {
      id: "capabilities-present",
      passed: REQUIRED_CAPABILITIES.every((name) => fs.existsSync(path.join(root, "scripts", name))),
      detail: "v1.1 audit and runtime-evidence capabilities are present",
    },
    {
      id: "ci-node-pinned",
      passed: ci.includes("node-version-file: .node-version"),
      detail: "CI uses the repository Node.js version file",
    },
    {
      id: "ci-bun-pinned",
      passed: bunVersion !== null && ci.includes(`bun-version: ${bunVersion}`) && !ci.includes("bun-version: latest"),
      detail: "CI Bun version matches packageManager and does not use latest",
    },
    {
      id: "lockfile-present",
      passed: fs.existsSync(lockfilePath),
      detail: "Bun lockfile is present",
    },
    {
      id: "ci-clean-checkout",
      passed: ci.includes("actions/checkout@v4") && ci.includes("fetch-depth: 0"),
      detail: "CI starts from a full clean GitHub checkout",
    },
    {
      id: "ci-frozen-install",
      passed: ci.includes("bun install --frozen-lockfile"),
      detail: "CI installs from the frozen lockfile",
    },
    {
      id: "ci-quality-gates",
      passed: ["typecheck", "test", "lint", "build"].every((script) => ciRuns(ci, script)),
      detail: "CI runs typecheck, test, lint, and build",
    },
    {
      id: "public-safety-ci",
      passed: ci.includes("audit-public-repo-safety.js"),
      detail: "public repository safety is blocking in CI",
    },
    {
      id: "roadmap-present",
      passed: roadmap.includes("## v1.1") && roadmap.includes("## v2"),
      detail: "public roadmap covers v1.1 through v2",
    },
    {
      id: "release-notes-present",
      passed: releaseNotes.includes("Production Webapp Toolkit v1.1.0") && releaseNotes.includes("## Status semantics") && releaseNotes.includes("## Trust boundaries"),
      detail: "v1.1.0 release notes document status and trust semantics",
    },
    {
      id: "readme-toolchain",
      passed: readme.includes(`Node.js ${nodeVersion}`) && bunVersion !== null && readme.includes(`Bun ${bunVersion}`),
      detail: "README documents the pinned reference toolchain",
    },
    {
      id: "readme-governance",
      passed: readme.includes("Offline Git governance audit"),
      detail: "README documents Git governance",
    },
    {
      id: "readme-baseline",
      passed: readme.includes("Offline production baseline audit"),
      detail: "README documents explicit production baselines",
    },
    {
      id: "readme-deployment",
      passed: readme.includes("Deployment verification") && /freshness/i.test(readme) && /runtime identity/i.test(readme),
      detail: "README documents deployment, freshness, and runtime identity",
    },
    {
      id: "readme-runtime-evidence",
      passed: readme.includes("Runtime evidence contract"),
      detail: "README documents Runtime Evidence Contract v1",
    },
    {
      id: "readme-status-layers",
      passed: readme.includes("Repository status") && readme.includes("Ecosystem status") && readme.includes("DEPLOYMENT"),
      detail: "README documents repository and ecosystem deployment status",
    },
  ];

  return {
    version: pkg.version,
    expectedVersion,
    nodeVersion,
    bunVersion,
    ready: checks.every((check) => check.passed),
    checks,
  };
}

/** @param {ReturnType<typeof inspectReleaseReadiness>} report */
export function formatReleaseReadiness(report) {
  const lines = ["Production Webapp Toolkit v1.1 release readiness", ""];
  for (const check of report.checks) {
    lines.push(`${check.passed ? "PASS" : "MISS"}  ${check.id}  ${check.detail}`);
  }
  lines.push("");
  const target = report.expectedVersion ?? report.version;
  lines.push(report.ready ? `Result: READY FOR v${target}` : `Result: NOT READY FOR v${target}`);
  return lines.join("\n");
}
/** @param {string[]} argv */
function parseArguments(argv) {
  let json = false;
  let expectedVersion = null;
  let target = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (argument === "--expected-version") {
      const value = argv[index + 1];
      if (expectedVersion !== null || typeof value !== "string" || !/^1\.\d+\.\d+$/.test(value)) return null;
      expectedVersion = value;
      index += 1;
    } else if (typeof argument === "string" && !argument.startsWith("-") && target === null) {
      target = argument;
    } else {
      return null;
    }
  }
  return { json, expectedVersion, target };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/audit-release-readiness.js [repository] [--expected-version <1.x.y>] [--json]");
    return 1;
  }
  const root = path.resolve(options.target ?? process.cwd());
  const report = inspectReleaseReadiness(root, { expectedVersion: options.expectedVersion });
  process.stdout.write(`${options.json ? JSON.stringify(report) : formatReleaseReadiness(report)}\n`);
  return report.ready ? 0 : 1;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && fileURLToPath(import.meta.url) === invokedPath) {
  process.exitCode = main();
}
