#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  readEnvironmentContractFile,
  scanEnvironmentSource,
} from "./audit-environment-contract.js";

const PUBLIC_PREFIXES = [
  "VITE_",
  "NEXT_PUBLIC_",
  "REACT_APP_",
  "PUBLIC_",
  "EXPO_PUBLIC_",
  "GATSBY_",
  "NUXT_PUBLIC_",
];
const STRONG_SECRET_COMPONENT = /(^|_)(SECRET|PASSWORD|PASSWD|TOKEN|CREDENTIAL|CREDENTIALS|PRIVATE)(_|$)/;
const SECRET_KEY_SEQUENCE = /(^|_)(API_KEY|ACCESS_KEY|ADMIN_KEY|MASTER_KEY|ROOT_KEY|SERVICE_ROLE_KEY|SIGNING_KEY)(_|$)/;

/** @param {string} name */
export function isSecretLikePublicEnvironmentName(name) {
  const upper = name.toUpperCase();
  return STRONG_SECRET_COMPONENT.test(upper) || SECRET_KEY_SEQUENCE.test(upper);
}

/** @param {string} name */
function hasRecognizedPublicPrefix(name) {
  return PUBLIC_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * @param {unknown} values
 * @param {import("./audit-environment-contract.js").EnvironmentContract} contract
 */
export function validatePublicExposureAllowlist(values, contract) {
  if (!Array.isArray(values)) {
    return { ok: false, names: [], error: "public exposure allowlist must be an array" };
  }
  /** @type {string[]} */
  const names = [];
  const seen = new Set();
  const variables = new Map(contract.variables.map((item) => [item.name, item]));
  for (const raw of values) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      return { ok: false, names: [], error: "allowed public names must be environment identifiers" };
    }
    if (seen.has(name)) {
      return { ok: false, names: [], error: `duplicate allowed public name ${name}` };
    }
    const variable = variables.get(name);
    if (!variable || variable.exposure !== "public") {
      return {
        ok: false,
        names: [],
        error: `allowed public name ${name} must exist in the contract with public exposure`,
      };
    }
    seen.add(name);
    names.push(name);
  }
  return { ok: true, names, error: null };
}

/**
 * @param {string} root
 * @param {import("./audit-environment-contract.js").EnvironmentContract} contract
 * @param {string[]} allowPublicNames
 */
export function inspectClientEnvironmentExposure(root, contract, allowPublicNames = []) {
  const repository = path.resolve(root);
  if (!fs.existsSync(repository) || !fs.statSync(repository).isDirectory()) {
    return {
      root: repository,
      technicalStatus: "FAIL",
      overallStatus: "FAIL",
      checks: [{ id: "repository-unreadable", severity: "FAIL", detail: "repository path is not a readable directory" }],
      exposures: [],
      dynamicAccess: [],
    };
  }
  const allowlist = validatePublicExposureAllowlist(allowPublicNames, contract);
  if (!allowlist.ok) throw new Error(allowlist.error ?? "invalid public exposure allowlist");
  const allowed = new Set(allowlist.names);

  let source;
  try {
    source = scanEnvironmentSource(repository, contract.scanRoots);
  } catch {
    return {
      root: repository,
      technicalStatus: "FAIL",
      overallStatus: "FAIL",
      checks: [{ id: "inspection-failed", severity: "FAIL", detail: "client environment exposure inspection could not read declared source roots" }],
      exposures: [],
      dynamicAccess: [],
    };
  }

  /** @type {Array<{ id: string, severity: "PASS" | "WARN" | "FAIL", detail: string, variable?: string }>} */
  const checks = [];
  for (const missing of source.missingRoots) {
    checks.push({ id: "scan-root-missing", severity: "FAIL", detail: `declared scan root is missing: ${missing}` });
  }
  for (const file of source.skippedLargeFiles) {
    checks.push({ id: "source-file-too-large", severity: "WARN", detail: `source file exceeded scan limit and was skipped: ${file}` });
  }
  for (const item of source.dynamic) {
    checks.push({
      id: "dynamic-environment-access",
      severity: "WARN",
      detail: `dynamic environment access prevents complete exposure analysis: ${item.file}:${item.line} (${item.accessor})`,
    });
  }

  const variables = new Map(contract.variables.map((item) => [item.name, item]));
  /** @type {Array<{ name: string, declaredExposure: "server" | "public" | null, secretLikeName: boolean, allowlisted: boolean, references: import("./audit-environment-contract.js").EnvironmentReference[] }>} */
  const exposures = [];
  const publicReferencedNames = new Set();

  for (const [name, references] of source.references) {
    const publicReferences = references.filter((reference) => reference.channel === "public");
    if (publicReferences.length === 0) continue;
    publicReferencedNames.add(name);
    const variable = variables.get(name) ?? null;
    const secretLikeName = isSecretLikePublicEnvironmentName(name);
    const allowlisted = allowed.has(name);
    exposures.push({
      name,
      declaredExposure: variable?.exposure ?? null,
      secretLikeName,
      allowlisted,
      references: publicReferences,
    });
    if (variable?.exposure === "server") {
      checks.push({
        id: "server-variable-public-access",
        severity: "FAIL",
        variable: name,
        detail: `server-only variable ${name} is referenced through a public environment accessor`,
      });
    }
    if (secretLikeName && !allowlisted) {
      checks.push({
        id: "secret-like-public-name",
        severity: "FAIL",
        variable: name,
        detail: `public environment name ${name} contains a secret-like component`,
      });
    }
    if (variable === null) {
      checks.push({
        id: "undeclared-public-variable",
        severity: secretLikeName ? "FAIL" : "WARN",
        variable: name,
        detail: `public environment reference ${name} is not declared in the environment contract`,
      });
    }
  }

  for (const variable of contract.variables) {
    if (variable.exposure !== "public") continue;
    const secretLikeName = isSecretLikePublicEnvironmentName(variable.name);
    const allowlisted = allowed.has(variable.name);
    if (secretLikeName && !allowlisted && !publicReferencedNames.has(variable.name)) {
      checks.push({
        id: "secret-like-public-contract-name",
        severity: "FAIL",
        variable: variable.name,
        detail: `public contract variable ${variable.name} contains a secret-like component even though it is not currently referenced publicly`,
      });
    }
    if (!hasRecognizedPublicPrefix(variable.name)) {
      checks.push({
        id: "unconventional-public-name",
        severity: "WARN",
        variable: variable.name,
        detail: `public contract variable ${variable.name} has no recognized public environment prefix`,
      });
    }
  }

  for (const name of allowlist.names) {
    checks.push({ id: "public-name-exception", severity: "PASS", variable: name, detail: `explicit public naming exception accepted for ${name}` });
  }
  const failCount = checks.filter((check) => check.severity === "FAIL").length;
  const warnCount = checks.filter((check) => check.severity === "WARN").length;
  return {
    root: repository,
    contractVersion: contract.version,
    allowPublicNames: allowlist.names,
    exposures,
    dynamicAccess: source.dynamic,
    filesScanned: source.filesScanned,
    checks,
    summary: {
      pass: checks.filter((check) => check.severity === "PASS").length,
      warn: warnCount,
      fail: failCount,
    },
    technicalStatus: "PASS",
    overallStatus: failCount > 0 ? "FAIL" : warnCount > 0 ? "WARN" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectClientEnvironmentExposure>} report */
export function formatClientEnvironmentExposure(report) {
  const lines = [
    "Client environment exposure audit",
    "",
    `Repository: ${report.root}`,
    `Source files scanned: ${report.filesScanned ?? 0}`,
    `Public environment references: ${report.exposures.length}`,
    "",
  ];
  const relevant = report.checks.filter((check) => check.severity !== "PASS");
  if (relevant.length === 0) {
    lines.push("PASS  exposure  no unsafe public environment exposure detected");
  } else {
    for (const check of relevant) lines.push(`${check.severity}  ${check.id}  ${check.detail}`);
  }
  lines.push("", `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  let target = null;
  let contractFile = null;
  /** @type {string[]} */
  const allowPublicNames = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string") return null;
    if (argument === "--json") {
      json = true;
    } else if (argument === "--contract" || argument === "--allow-public-name") {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) return null;
      if (argument === "--contract") {
        if (contractFile !== null) return null;
        contractFile = value;
      } else {
        allowPublicNames.push(value);
      }
      index += 1;
    } else if (argument.startsWith("-")) {
      return null;
    } else if (target === null) {
      target = argument;
    } else {
      return null;
    }
  }
  if (contractFile === null) return null;
  return { target, contractFile, allowPublicNames, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error(
      "Usage: node scripts/audit-client-env-exposure.js [repository] --contract <environment-contract.json> [--allow-public-name <name> ...] [--json]",
    );
    return 1;
  }
  const loaded = readEnvironmentContractFile(options.contractFile);
  if (!loaded.ok) {
    console.error(loaded.error.detail);
    return 1;
  }
  let report;
  try {
    report = inspectClientEnvironmentExposure(
      options.target ?? process.cwd(),
      loaded.contract,
      options.allowPublicNames,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid client environment exposure input");
    return 1;
  }
  console.log(options.json ? JSON.stringify(report) : formatClientEnvironmentExposure(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

// This audit reuses the canonical Environment Contract source scanner. It does
// not read runtime environment values, .env runtime files, network resources,
// Git metadata, secret stores, or write to the inspected repository.
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
