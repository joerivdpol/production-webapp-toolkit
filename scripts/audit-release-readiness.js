#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const V1_REQUIRED_SCRIPTS = [
  "typecheck", "test", "lint", "build", "check", "lint:changed",
  "audit:safety", "audit:git-governance", "audit:production-baseline",
  "audit:deployment", "audit:repository-status", "audit:ecosystem-status",
  "audit:release", "runtime:evidence", "release:verify",
];

export const V1_REQUIRED_CAPABILITIES = [
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

export const V2_REQUIRED_SCRIPTS = [
  "audit", "audit:all", "audit:profiled", "audit:ecosystem", "audit:python", "audit:drift", "audit:architecture",
  "bootstrap", "remediation:plan", "remediation:apply",
  "audit:ci", "ci:evidence", "ci:evidence:github-actions", "ci:evidence:github-actions:collect",
  "audit:github-protection", "audit:env-contract", "audit:env-exposure", "audit:migration-safety",
  "schema:snapshot", "schema:snapshot:postgres:collect", "audit:schema-drift",
  "security:snapshot", "security:snapshot:postgres:collect", "audit:postgres-security",
  "api:contract", "api:contract:openapi", "audit:api-contract", "contract:inventory", "audit:cross-contracts",
  "vulnerability:evidence", "vulnerability:osv:collect", "vulnerability:github:collect", "audit:vulnerabilities",
  "sbom:generate", "license:evidence", "license:collect:installed", "audit:licenses", "audit:reproducibility",
  "artifact:provenance", "audit:artifact-provenance", "change:evidence", "audit:release-risk", "change:analyze",
  "test:select", "audit:flaky-tests", "coverage:evidence", "audit:coverage", "orphan:evidence",
  "orphan:collect:static", "audit:orphans", "audit:hygiene", "audit:docs", "audit:ownership",
  "runtime:collector:adapt", "runtime:checkout:collect", "runtime:application:collect", "runtime:container:collect",
  "runtime:process:collect", "runtime:health:evidence", "audit:runtime-health", "runtime:smoke", "runtime:frontend",
  "performance:evidence", "audit:performance", "runtime:accessibility", "runtime:seo", "audit:localization",
  "route:inventory", "audit:route-coverage", "audit:authorization", "audit:webhook-safety", "audit:payment-integrity",
  "booking:integrity:evidence", "audit:booking-integrity", "audit:jobs", "backup:evidence", "audit:backup-readiness",
  "dr:contract", "audit:dr-readiness", "rollback:contract", "audit:rollback-readiness",
  "manifest:validate", "policy:resolve", "policy:organization", "check:evidence", "ecosystem:dashboard",
  "ecosystem:history", "report:plan", "policy:severity", "audit:agent-safety", "audit:diff-architecture",
  "agent:workflow:plan", "release:evidence:bundle", "release:evidence:export", "deployment:gate",
];

export const V2_REQUIRED_CAPABILITIES = [
  "audit-repository.js", "audit-all-repositories.js", "audit-python-service.js", "detect-repository-profile.js",
  "bootstrap-repository.js", "plan-remediation.js", "apply-remediation.js", "lint-changed.js", "audit-release-readiness.js",
  "audit-ci-verification.js", "ci-evidence.js", "github-actions-ci-evidence.js", "collect-github-actions-ci-evidence.js",
  "audit-github-protection.js", "audit-environment-contract.js", "audit-client-env-exposure.js", "audit-migration-safety.js",
  "database-schema-snapshot.js", "collect-postgres-schema-snapshot.js", "audit-database-schema-drift.js",
  "postgres-security-snapshot.js", "collect-postgres-security-snapshot.js", "audit-postgres-security.js",
  "api-contract-snapshot.js", "openapi-api-contract.js", "audit-api-contract.js", "contract-inventory.js",
  "audit-cross-repository-contracts.js", "vulnerability-evidence.js", "collect-osv-vulnerability-evidence.js",
  "collect-github-dependabot-evidence.js", "audit-vulnerabilities.js", "generate-sbom.js", "license-evidence.js",
  "collect-installed-license-evidence.js", "audit-licenses.js", "audit-build-reproducibility.js", "artifact-provenance.js",
  "audit-artifact-provenance.js", "change-surface-evidence.js", "audit-release-risk.js", "analyze-changed-surface.js",
  "select-tests.js", "audit-flaky-tests.js", "coverage-comparison-evidence.js", "audit-coverage-regression.js",
  "orphan-evidence.js", "collect-static-orphan-evidence.js", "audit-orphans.js", "audit-repository-hygiene.js",
  "audit-documentation-drift.js", "audit-codeowners-ownership.js", "runtime-collector-adapter.js",
  "collect-git-checkout-runtime-evidence.js", "collect-application-runtime-evidence.js",
  "collect-docker-container-runtime-evidence.js", "collect-process-runtime-evidence.js", "runtime-health-evidence.js",
  "audit-runtime-health.js", "run-synthetic-smoke-tests.js", "run-frontend-runtime-checks.js", "performance-evidence.js",
  "audit-performance-budgets.js", "run-accessibility-gates.js", "run-seo-production-checks.js",
  "audit-localization-completeness.js", "route-inventory.js", "audit-route-coverage.js", "audit-authorization-policy.js",
  "audit-webhook-safety.js", "audit-payment-integrity.js", "booking-integrity-evidence.js", "audit-booking-integrity.js",
  "audit-job-scheduler.js", "backup-readiness-evidence.js", "audit-backup-readiness.js", "disaster-recovery-contract.js",
  "audit-disaster-recovery.js", "rollback-readiness-contract.js", "audit-rollback-readiness.js", "repository-manifest.js",
  "policy-packs.js", "organization-policy.js", "repository-check-evidence.js", "ecosystem-dashboard.js",
  "compare-ecosystem-history.js", "scheduled-reporting.js", "severity-policy.js", "audit-agent-safety.js",
  "audit-diff-architecture.js", "controlled-agent-workflow.js", "release-evidence-bundle.js",
  "export-compliance-evidence.js", "deployment-gate.js",
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
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value);
}

/** @param {string} value */
function releasableVersion(value) {
  return /^[1-9]\d*\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value);
}

/** @param {string} value */
function versionMajor(value) {
  return releasableVersion(value) ? Number(value.split(".")[0]) : null;
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
  const lockfilePath = fs.existsSync(path.join(root, "bun.lock"))
    ? path.join(root, "bun.lock")
    : path.join(root, "bun.lockb");

  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  const readme = readText(readmePath);
  const roadmap = readText(roadmapPath);
  const ci = readText(ciPath);
  const nodeVersion = readText(nodeVersionPath).trim();
  const bunVersion = pinnedBunVersion(pkg.packageManager);
  const expectedVersion = options.expectedVersion ?? null;
  const targetVersion = expectedVersion ?? pkg.version ?? "";
  const targetMajor = versionMajor(targetVersion);
  const releaseNotesPath = releasableVersion(targetVersion)
    ? path.join(root, "docs", "releases", `v${targetVersion}.md`)
    : path.join(root, "docs", "releases", "invalid-version.md");
  const releaseNotes = readText(releaseNotesPath);
  const isV2 = targetMajor !== null && targetMajor >= 2;
  const requiredScripts = isV2 ? [...V1_REQUIRED_SCRIPTS, ...V2_REQUIRED_SCRIPTS] : V1_REQUIRED_SCRIPTS;
  const requiredCapabilities = isV2 ? [...V1_REQUIRED_CAPABILITIES, ...V2_REQUIRED_CAPABILITIES] : V1_REQUIRED_CAPABILITIES;

  const checks = [
    {
      id: "version-semver",
      passed: typeof pkg.version === "string" && releasableVersion(pkg.version),
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
      passed: requiredScripts.every((name) => typeof pkg.scripts?.[name] === "string"),
      detail: isV2 ? "v2.0 quality, evidence, runtime, policy, and controlled-automation scripts are present" : "v1.1 quality, evidence, status, and release scripts are present",
    },
    {
      id: "capabilities-present",
      passed: requiredCapabilities.every((name) => fs.existsSync(path.join(root, "scripts", name))),
      detail: isV2 ? "v2.0 production-readiness control-plane capabilities are present" : "v1.1 audit and runtime-evidence capabilities are present",
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
      passed: roadmap.includes("## v1.1") && roadmap.includes("## v2.0 Controlled automation") && (!isV2 || /v2\.0 controlled-automation roadmap capabilities are complete/i.test(roadmap)),
      detail: isV2 ? "public roadmap marks the v2.0 controlled-automation capability plan complete" : "public roadmap covers v1.1 through v2",
    },
    {
      id: "release-notes-present",
      passed: releaseNotes.includes(`Production Webapp Toolkit v${targetVersion}`) && releaseNotes.includes("## Status semantics") && releaseNotes.includes("## Trust boundaries") && (!isV2 || releaseNotes.includes("## Upgrade notes")),
      detail: isV2 ? `v${targetVersion} release notes document status, trust boundaries, and upgrade notes` : `v${targetVersion} release notes document status and trust semantics`,
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
    {
      id: "readme-current-release",
      passed: !isV2 || (readme.includes("## v2.0 capability surface") && readme.includes("deployment:gate") && readme.includes("release:evidence:bundle")),
      detail: isV2 ? "README documents the v2.0 capability surface and final release/deployment evidence entrypoints" : "v2.0 README release surface is not required for this target",
    },
  ];

  return {
    version: pkg.version,
    expectedVersion,
    targetVersion,
    targetMajor,
    nodeVersion,
    bunVersion,
    ready: checks.every((check) => check.passed),
    checks,
  };
}

/** @param {ReturnType<typeof inspectReleaseReadiness>} report */
export function formatReleaseReadiness(report) {
  const target = report.expectedVersion ?? report.version;
  const lines = [`Production Webapp Toolkit v${target} release readiness`, ""];
  for (const check of report.checks) {
    lines.push(`${check.passed ? "PASS" : "MISS"}  ${check.id}  ${check.detail}`);
  }
  lines.push("");
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
      if (expectedVersion !== null || typeof value !== "string" || !releasableVersion(value)) return null;
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
    console.error("Usage: node scripts/audit-release-readiness.js [repository] [--expected-version <x.y.z>] [--json]");
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
