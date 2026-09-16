#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { inspectRepositoryStatus } from "./audit-repository-status.js";
import { isFullObjectId, validateEvidenceFreshnessPolicy, validateRuntimeIdentityPolicy } from "./audit-deployment-verification.js";
import { validateCiVerificationPolicy } from "./audit-ci-verification.js";

const CONFIG_VERSION = 1;
const USAGE =
  "Usage: node scripts/audit-ecosystem-status.js <repository> [repository...] [--json] | --config <file> [--json]";

/** @typedef {{ name?: string, target: string, expectedRef?: string | null, expectedCommit?: string | null, compareRef?: string | null, deployedCommit?: string | null, evidenceFile?: string | null, maxEvidenceAgeSeconds?: number | null, evaluatedAt?: string | null, expectedRuntimeName?: string | null, expectedRuntimeEnvironment?: string | null, ciEvidenceFile?: string | null, ciExpectedCommit?: string | null, requiredCiChecks?: string[] | null }} RepositoryInput */

/** @param {unknown} error */
function errorDetail(error) {
  return error instanceof Error ? error.message : "unknown ecosystem audit error";
}

/** @param {string} target */
function displayName(target) {
  return path.basename(target) || target;
}

/** @param {unknown} value */
function optionalSelector(value) {
  return value === undefined || (typeof value === "string" && value.length > 0);
}

/**
 * Normalize configuration entries without interpreting revision expressions.
 * Their validity is deliberately left to inspectRepositoryStatus and its
 * production-baseline auditor.
 *
 * @param {unknown} value
 * @param {string} baseDirectory
 * @returns {{ repositories: RepositoryInput[] } | { error: string }}
 */
export function parseEcosystemConfig(value, baseDirectory = process.cwd()) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { error: "config must be a JSON object" };
  }

  const config = /** @type {{ version?: unknown, repositories?: unknown }} */ (value);
  if (config.version !== CONFIG_VERSION) {
    return { error: `config version must be ${CONFIG_VERSION}` };
  }
  if (!Array.isArray(config.repositories) || config.repositories.length === 0) {
    return { error: "config repositories must be a non-empty array" };
  }

  /** @type {RepositoryInput[]} */
  const repositories = [];
  const targets = new Set();

  for (const [index, entry] of config.repositories.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: `config repository ${index + 1} must be an object` };
    }

    const repository = /** @type {{ name?: unknown, path?: unknown, expectedRef?: unknown, expectedCommit?: unknown, compareRef?: unknown, deployedCommit?: unknown, evidenceFile?: unknown, maxEvidenceAgeSeconds?: unknown, evaluatedAt?: unknown, expectedRuntimeName?: unknown, expectedRuntimeEnvironment?: unknown, ciEvidenceFile?: unknown, ciExpectedCommit?: unknown, requiredCiChecks?: unknown }} */ (entry);
    if (typeof repository.path !== "string" || repository.path.trim().length === 0) {
      return { error: `config repository ${index + 1} must have a non-empty path` };
    }
    if (repository.name !== undefined && (typeof repository.name !== "string" || repository.name.trim().length === 0)) {
      return { error: `config repository ${index + 1} name must be a non-empty string when supplied` };
    }
    if (!optionalSelector(repository.expectedRef) || !optionalSelector(repository.expectedCommit) || !optionalSelector(repository.compareRef)) {
      return { error: `config repository ${index + 1} baseline selectors must be non-empty strings when supplied` };
    }
    if (!optionalSelector(repository.deployedCommit) || !optionalSelector(repository.evidenceFile)) {
      return { error: `config repository ${index + 1} deployment evidence values must be non-empty strings when supplied` };
    }
    const baselineConfigured = repository.expectedRef !== undefined || repository.expectedCommit !== undefined;
    const deploymentConfigured = repository.deployedCommit !== undefined || repository.evidenceFile !== undefined;
    if (repository.compareRef !== undefined && !baselineConfigured) {
      return { error: `config repository ${index + 1} compareRef requires expectedRef or expectedCommit` };
    }
    if (repository.deployedCommit !== undefined && repository.evidenceFile !== undefined) {
      return { error: `config repository ${index + 1} deployment evidence inputs are mutually exclusive` };
    }
    if (deploymentConfigured && !baselineConfigured) {
      return { error: `config repository ${index + 1} deployment evidence requires expectedRef or expectedCommit` };
    }
    if (typeof repository.deployedCommit === "string" && !isFullObjectId(repository.deployedCommit)) {
      return { error: `config repository ${index + 1} deployedCommit must be a full 40- or 64-character hexadecimal Git object ID` };
    }
    const freshnessPolicy = validateEvidenceFreshnessPolicy(
      repository.maxEvidenceAgeSeconds,
      repository.evaluatedAt,
    );
    if (!freshnessPolicy.ok) {
      return { error: `config repository ${index + 1} ${freshnessPolicy.error.detail}` };
    }
    if (freshnessPolicy.policy !== null && repository.evidenceFile === undefined) {
      return { error: `config repository ${index + 1} freshness policy requires evidenceFile` };
    }
    const runtimeIdentityPolicy = validateRuntimeIdentityPolicy(
      repository.expectedRuntimeName,
      repository.expectedRuntimeEnvironment,
    );
    if (!runtimeIdentityPolicy.ok) {
      return { error: `config repository ${index + 1} ${runtimeIdentityPolicy.error.detail}` };
    }
    if (runtimeIdentityPolicy.policy !== null && repository.evidenceFile === undefined) {
      return { error: `config repository ${index + 1} runtime identity policy requires evidenceFile` };
    }

    const anyCi = repository.ciEvidenceFile !== undefined || repository.ciExpectedCommit !== undefined || repository.requiredCiChecks !== undefined;
    let ciPolicy = null;
    if (anyCi) {
      if (typeof repository.ciEvidenceFile !== "string" || repository.ciEvidenceFile.trim().length === 0) {
        return { error: `config repository ${index + 1} CI verification requires a non-empty ciEvidenceFile` };
      }
      const result = validateCiVerificationPolicy(repository.ciExpectedCommit, repository.requiredCiChecks);
      if (!result.ok) {
        return { error: `config repository ${index + 1} ${result.error.detail}` };
      }
      ciPolicy = result.policy;
    }

    const target = path.resolve(baseDirectory, repository.path);
    if (targets.has(target)) {
      return { error: `config contains duplicate repository target: ${target}` };
    }
    targets.add(target);
    /** @type {RepositoryInput} */
    const normalized = {
      target,
      expectedRef: typeof repository.expectedRef === "string" ? repository.expectedRef : null,
      expectedCommit: typeof repository.expectedCommit === "string" ? repository.expectedCommit : null,
      compareRef: typeof repository.compareRef === "string" ? repository.compareRef : null,
      deployedCommit: typeof repository.deployedCommit === "string" ? repository.deployedCommit : null,
      evidenceFile: typeof repository.evidenceFile === "string" ? path.resolve(baseDirectory, repository.evidenceFile) : null,
      maxEvidenceAgeSeconds: freshnessPolicy.policy?.maxEvidenceAgeSeconds ?? null,
      evaluatedAt: freshnessPolicy.policy?.evaluatedAt ?? null,
      expectedRuntimeName: runtimeIdentityPolicy.policy?.expectedRuntimeName ?? null,
      expectedRuntimeEnvironment: runtimeIdentityPolicy.policy?.expectedRuntimeEnvironment ?? null,
      ciEvidenceFile: typeof repository.ciEvidenceFile === "string" ? path.resolve(baseDirectory, repository.ciEvidenceFile) : null,
      ciExpectedCommit: ciPolicy?.expectedCommit ?? null,
      requiredCiChecks: ciPolicy?.requiredChecks ?? null,
    };
    if (typeof repository.name === "string") normalized.name = repository.name;
    repositories.push(normalized);
  }

  return { repositories };
}

/**
 * @param {string[]} argv
 * @returns {{ json: boolean, positional: string[], configPath: string | null } | { error: string }}
 */
export function parseArguments(argv) {
  /** @type {string[]} */
  const positional = [];
  let json = false;
  let configPath = null;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string") return { error: USAGE };

    if (argument === "--json") {
      json = true;
    } else if (argument === "--config") {
      const value = argv[index + 1];
      if (configPath !== null || typeof value !== "string" || !value || value.startsWith("--")) {
        return { error: USAGE };
      }
      configPath = value;
      index += 1;
    } else if (argument.startsWith("-")) {
      return { error: USAGE };
    } else {
      positional.push(argument);
    }
  }

  if ((configPath && positional.length > 0) || (!configPath && positional.length === 0)) {
    return { error: USAGE };
  }

  const targets = new Set();
  for (const target of positional) {
    if (!target || targets.has(path.resolve(target))) return { error: USAGE };
    targets.add(path.resolve(target));
  }

  return { json, positional, configPath };
}

/** @param {string} configPath */
export function readEcosystemConfig(configPath) {
  let contents;
  try {
    contents = fs.readFileSync(configPath, "utf8");
  } catch {
    return { error: "config file cannot be read" };
  }

  let value;
  try {
    value = JSON.parse(contents);
  } catch {
    return { error: "config file contains invalid JSON" };
  }

  return parseEcosystemConfig(value, path.dirname(path.resolve(configPath)));
}

/** @param {RepositoryInput} repository @param {unknown} error */
function failedRepositoryStatus(repository, error) {
  const baselineConfigured = Boolean(repository.expectedRef || repository.expectedCommit);
  const deploymentConfigured = Boolean(repository.deployedCommit || repository.evidenceFile);
  const ciConfigured = Boolean(repository.ciEvidenceFile || repository.ciExpectedCommit || repository.requiredCiChecks?.length);
  const detail = `repository status inspection could not run reliably: ${errorDetail(error)}`;
  const baseline = baselineConfigured
    ? {
        configured: true,
        status: "FAIL",
        technicalStatus: "FAIL",
        baselineStatus: "UNVERIFIED",
        overallStatus: "FAIL",
        checks: [{ id: "ecosystem-inspection", severity: "FAIL", detail }],
      }
    : {
        configured: false,
        status: "NOT_CONFIGURED",
        technicalStatus: "PASS",
        baselineStatus: null,
        overallStatus: null,
        checks: [],
      };

  const deployment = deploymentConfigured
    ? {
        configured: true,
        status: "FAIL",
        technicalStatus: "FAIL",
        deploymentStatus: "UNVERIFIED",
        overallStatus: "FAIL",
        baselineStatus: baseline.baselineStatus,
        expectedRef: repository.expectedRef ?? null,
        expectedCommit: repository.expectedCommit ?? null,
        expectedResolvedCommit: null,
        deployedCommit: repository.deployedCommit ?? null,
        evidence: null,
        freshness: null,
        runtimeIdentity: null,
        checks: [{ id: "ecosystem-inspection", severity: "FAIL", detail }],
      }
    : {
        configured: false,
        status: "NOT_CONFIGURED",
        technicalStatus: "PASS",
        deploymentStatus: null,
        overallStatus: null,
        baselineStatus: null,
        expectedRef: null,
        expectedCommit: null,
        expectedResolvedCommit: null,
        deployedCommit: null,
        evidence: null,
        freshness: null,
        runtimeIdentity: null,
        checks: [],
      };

  const ci = ciConfigured
    ? {
        configured: true,
        status: "FAIL",
        technicalStatus: "FAIL",
        overallStatus: "FAIL",
        commitStatus: "UNVERIFIED",
        checksStatus: "UNVERIFIED",
        expectedCommit: repository.ciExpectedCommit ?? null,
        evidenceCommit: null,
        requiredChecks: [],
        evidence: null,
      }
    : {
        configured: false,
        status: "NOT_CONFIGURED",
        technicalStatus: "PASS",
        overallStatus: null,
        commitStatus: null,
        checksStatus: null,
        expectedCommit: null,
        evidenceCommit: null,
        requiredChecks: [],
        evidence: null,
      };

  return {
    root: path.resolve(repository.target),
    profile: "unknown",
    baselineConfigured,
    deploymentConfigured,
    ciConfigured,
    dimensions: {
      quality: { status: "FAIL", technicalStatus: "FAIL", profile: "unknown", detail },
      governance: { status: "FAIL", technicalStatus: "FAIL", checks: [{ id: "ecosystem-inspection", severity: "FAIL", detail }] },
      baseline,
      deployment,
      ci,
    },
    technicalStatus: "FAIL",
    overallStatus: "FAIL",
    summary: { quality: "FAIL", governance: "FAIL", baseline: baseline.status, deployment: deployment.status, ci: ci.status },
  };
}

/** @param {Record<string, number>} counts @param {string} key */
function increment(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * This is intentionally only an aggregation of inspectRepositoryStatus.
 * It neither invokes Git nor derives baseline selectors from any status data.
 *
 * @param {RepositoryInput[]} inputs
 * @param {{ inputMode: "positional" | "config", configVersion?: number }} metadata
 */
export function inspectEcosystemStatus(inputs, metadata) {
  const repositories = inputs.map((input) => {
    let status;
    try {
      status = inspectRepositoryStatus(input.target, {
        expectedRef: input.expectedRef ?? null,
        expectedCommit: input.expectedCommit ?? null,
        compareRef: input.compareRef ?? null,
        deployedCommit: input.deployedCommit ?? null,
        evidenceFile: input.evidenceFile ?? null,
        maxEvidenceAgeSeconds: input.maxEvidenceAgeSeconds ?? null,
        evaluatedAt: input.evaluatedAt ?? null,
        expectedRuntimeName: input.expectedRuntimeName ?? null,
        expectedRuntimeEnvironment: input.expectedRuntimeEnvironment ?? null,
        ciEvidenceFile: input.ciEvidenceFile ?? null,
        ciExpectedCommit: input.ciExpectedCommit ?? null,
        requiredCiChecks: input.requiredCiChecks ?? null,
      });
    } catch (error) {
      status = failedRepositoryStatus(input, error);
    }

    return {
      name: input.name ?? displayName(input.target),
      target: input.target,
      ...status,
    };
  });

  const summary = {
    repositories: { total: repositories.length },
    overall: { pass: 0, warn: 0, fail: 0 },
    technical: { pass: 0, fail: 0 },
    quality: { pass: 0, fail: 0 },
    governance: { pass: 0, warn: 0, fail: 0 },
    baseline: { pass: 0, warn: 0, fail: 0, notConfigured: 0 },
    deployment: { pass: 0, warn: 0, fail: 0, notConfigured: 0 },
    ci: { pass: 0, warn: 0, fail: 0, notConfigured: 0 },
    profiles: { webapp: 0, "python-service": 0, unknown: 0 },
  };

  for (const repository of repositories) {
    increment(summary.overall, repository.overallStatus.toLowerCase());
    increment(summary.technical, repository.technicalStatus.toLowerCase());
    increment(summary.quality, repository.dimensions.quality.status.toLowerCase());
    increment(summary.governance, repository.dimensions.governance.status.toLowerCase());
    const baselineStatus = repository.dimensions.baseline.status;
    increment(summary.baseline, baselineStatus === "NOT_CONFIGURED" ? "notConfigured" : baselineStatus.toLowerCase());
    const deploymentStatus = repository.dimensions.deployment.status;
    increment(summary.deployment, deploymentStatus === "NOT_CONFIGURED" ? "notConfigured" : deploymentStatus.toLowerCase());
    const ciStatus = repository.dimensions.ci.status;
    increment(summary.ci, ciStatus === "NOT_CONFIGURED" ? "notConfigured" : ciStatus.toLowerCase());
    increment(summary.profiles, repository.profile);
  }

  const technicalStatus = summary.technical.fail > 0 ? "FAIL" : "PASS";
  const overallStatus = summary.overall.fail > 0 ? "FAIL" : summary.overall.warn > 0 ? "WARN" : "PASS";

  return {
    inputMode: metadata.inputMode,
    ...(metadata.configVersion === undefined ? {} : { configVersion: metadata.configVersion }),
    repositories,
    summary,
    technicalStatus,
    overallStatus,
  };
}

/** @param {unknown} baseline */
function baselineLabel(baseline) {
  const value = /** @type {{ configured?: boolean, status?: string, baselineStatus?: string | null }} */ (baseline);
  if (!value.configured) return "NOT_CONFIGURED";
  return value.status === "FAIL" ? `FAIL/${value.baselineStatus ?? "UNVERIFIED"}` : value.baselineStatus ?? value.status ?? "UNVERIFIED";
}

/** @param {unknown} deployment */
function deploymentLabel(deployment) {
  const value = /** @type {{ configured?: boolean, status?: string, deploymentStatus?: string | null, freshness?: { configured?: boolean, status?: string } | null, runtimeIdentity?: { configured?: boolean, status?: string } | null }} */ (deployment);
  if (!value.configured) return "NOT_CONFIGURED";
  if (value.status === "FAIL") return `FAIL/${value.deploymentStatus ?? "UNVERIFIED"}`;
  const parts = [value.deploymentStatus ?? value.status ?? "UNVERIFIED"];
  if (value.freshness?.configured) parts.push(value.freshness.status ?? "UNVERIFIED");
  if (value.runtimeIdentity?.configured) parts.push(`IDENTITY_${value.runtimeIdentity.status ?? "UNVERIFIED"}`);
  return parts.join("/");
}

/** @param {unknown} ci */
function ciLabel(ci) {
  const value = /** @type {{ configured?: boolean, status?: string, commitStatus?: string | null, checksStatus?: string | null }} */ (ci);
  if (!value.configured) return "NOT_CONFIGURED";
  const commit = value.commitStatus ?? "UNVERIFIED";
  const checks = value.checksStatus ?? "UNVERIFIED";
  return value.status === "FAIL" ? `FAIL/${commit}/${checks}` : `${commit}/${checks}`;
}

/** @param {ReturnType<typeof inspectEcosystemStatus>} report */
export function formatEcosystemStatus(report) {
  /** @type {string[][]} */
  const rows = report.repositories.map((repository) => [
    repository.name,
    repository.profile,
    repository.dimensions.quality.status,
    repository.dimensions.governance.status,
    baselineLabel(repository.dimensions.baseline),
    deploymentLabel(repository.dimensions.deployment),
    ciLabel(repository.dimensions.ci),
    repository.overallStatus,
  ]);
  const headers = ["REPOSITORY", "PROFILE", "QUALITY", "GOVERNANCE", "BASELINE", "DEPLOYMENT", "CI", "OVERALL"];
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => (row[index] ?? "").length)) + 2);
  /** @param {string[]} row */
  const render = (row) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("").trimEnd();

  return [
    "Ecosystem status",
    "",
    render(headers),
    ...rows.map(render),
    "",
    `Repositories: ${report.summary.repositories.total}`,
    `Overall: ${report.summary.overall.pass} pass, ${report.summary.overall.warn} warn, ${report.summary.overall.fail} fail`,
    `Technical: ${report.summary.technical.pass} pass, ${report.summary.technical.fail} fail (${report.technicalStatus})`,
    `Result: ${report.overallStatus}`,
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const argumentsResult = parseArguments(argv);
  if ("error" in argumentsResult) {
    console.error(argumentsResult.error);
    return 1;
  }

  /** @type {RepositoryInput[]} */
  let inputs;
  /** @type {{ inputMode: "positional" | "config", configVersion?: number }} */
  let metadata;
  if (argumentsResult.configPath) {
    const configResult = readEcosystemConfig(argumentsResult.configPath);
    if ("error" in configResult) {
      console.error(`Ecosystem status configuration error: ${configResult.error}`);
      return 1;
    }
    inputs = configResult.repositories;
    metadata = { inputMode: "config", configVersion: CONFIG_VERSION };
  } else {
    inputs = argumentsResult.positional.map((target) => ({ target: path.resolve(target) }));
    metadata = { inputMode: "positional" };
  }

  const report = inspectEcosystemStatus(inputs, metadata);
  console.log(argumentsResult.json ? JSON.stringify(report) : formatEcosystemStatus(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
