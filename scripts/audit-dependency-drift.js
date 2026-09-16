#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TRACKED_DEPENDENCIES = [
  "react",
  "react-dom",
  "next",
  "vue",
  "nuxt",
  "svelte",
  "@sveltejs/kit",
  "@angular/core",
  "vite",
  "typescript",
  "eslint",
  "@playwright/test",
  "@tanstack/react-query",
  "@tanstack/react-router",
  "@tanstack/react-start",
  "@supabase/supabase-js",
];

/** @type {Array<[string, string]>} */
const ECOSYSTEM_COLUMNS = [
  ["react", "REACT"],
  ["next", "NEXT"],
  ["vite", "VITE"],
  ["typescript", "TYPESCRIPT"],
  ["@supabase/supabase-js", "SUPABASE"],
  ["@playwright/test", "PLAYWRIGHT"],
];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {string} root */
function readPackage(root) {
  const packagePath = path.join(root, "package.json");
  if (!fs.existsSync(packagePath)) return null;
  const stat = fs.lstatSync(packagePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`package.json must be a regular file: ${root}`);
  const parsed = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  if (!isPlainObject(parsed)) throw new Error(`package.json must contain an object: ${root}`);
  return parsed;
}

/** @param {string} root @param {string} basename */
function readRuntimeVersionFile(root, basename) {
  const filename = path.join(root, basename);
  if (!fs.existsSync(filename)) return null;
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`${basename} must be a regular file: ${root}`);
  if (stat.size > 128) throw new Error(`${basename} is unexpectedly large: ${root}`);
  return nonEmptyString(fs.readFileSync(filename, "utf8"));
}

/** @param {string} root */
function readNodeVersion(root) {
  return readRuntimeVersionFile(root, ".node-version");
}

/** @param {string} root */
function readPythonVersion(root) {
  return readRuntimeVersionFile(root, ".python-version");
}

/** @param {string | null} value */
function exactSemver(value) {
  if (value === null) return null;
  const match = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:[-+][0-9A-Za-z.-]+)?$/.exec(value);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]), text: value };
}

/** @param {string} value */
function dependencyMajor(value) {
  let candidate = value.trim();
  if (candidate.startsWith("workspace:")) candidate = candidate.slice("workspace:".length).trim();
  if (/^(?:file:|link:|git\+|https?:|github:|npm:)/.test(candidate)) return null;
  const match = /(?:^|[^0-9])(0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)/.exec(candidate);
  return match ? Number(match[1]) : null;
}

/** @param {string | null} value */
function parsePackageManager(value) {
  if (value === null) return null;
  const match = /^([a-z0-9][a-z0-9._-]*)@(.+)$/.exec(value.trim());
  if (!match) return { name: value.trim().toLowerCase(), version: null, major: null, pinned: false };
  const name = match[1]?.toLowerCase() ?? "";
  const version = match[2] ?? "";
  const semver = exactSemver(version);
  return { name, version, major: semver?.major ?? null, pinned: semver !== null };
}

/** @param {unknown} raw */
export function validateDependencyDriftPolicy(raw) {
  const errors = [];
  if (!isPlainObject(raw)) return { ok: false, policy: null, errors: [{ id: "policy-invalid", detail: "policy must be an object" }] };
  const allowed = ["version", "supportedNodeMajors", "packageManagers", "requireNodeVersionFile", "requirePackageManagerPin", "requireNodeEngine"];
  for (const key of Object.keys(raw)) if (!allowed.includes(key)) errors.push({ id: "policy-field-unknown", detail: `unsupported policy field ${key}` });
  if (raw.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  /** @type {number[]} */
  let supportedNodeMajors = [];
  if (raw.supportedNodeMajors !== undefined) {
    if (!Array.isArray(raw.supportedNodeMajors) || raw.supportedNodeMajors.length === 0 || raw.supportedNodeMajors.some((item) => !Number.isInteger(item) || item <= 0)) {
      errors.push({ id: "supported-node-majors-invalid", detail: "supportedNodeMajors must be a non-empty array of positive integers" });
    } else {
      supportedNodeMajors = [...raw.supportedNodeMajors];
      if (new Set(supportedNodeMajors).size !== supportedNodeMajors.length) errors.push({ id: "supported-node-majors-duplicate", detail: "supportedNodeMajors must be unique" });
      supportedNodeMajors.sort((a, b) => a - b);
    }
  }

  /** @type {Array<{name:string,supportedMajors:number[]}>} */
  const packageManagers = [];
  if (raw.packageManagers !== undefined) {
    if (!Array.isArray(raw.packageManagers) || raw.packageManagers.length === 0) {
      errors.push({ id: "package-managers-invalid", detail: "packageManagers must be a non-empty array" });
    } else {
      const names = new Set();
      for (const [index, item] of raw.packageManagers.entries()) {
        if (!isPlainObject(item)) { errors.push({ id: "package-manager-invalid", detail: `packageManagers[${index}] must be an object` }); continue; }
        for (const key of Object.keys(item)) if (!["name", "supportedMajors"].includes(key)) errors.push({ id: "package-manager-field-unknown", detail: `packageManagers[${index}] contains unsupported field ${key}` });
        const name = nonEmptyString(item.name)?.toLowerCase() ?? null;
        if (!name || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) { errors.push({ id: "package-manager-name-invalid", detail: `packageManagers[${index}].name is invalid` }); continue; }
        if (names.has(name)) { errors.push({ id: "package-manager-duplicate", detail: `package manager ${name} is declared more than once` }); continue; }
        names.add(name);
        if (!Array.isArray(item.supportedMajors) || item.supportedMajors.length === 0 || item.supportedMajors.some((major) => !Number.isInteger(major) || major < 0)) {
          errors.push({ id: "package-manager-majors-invalid", detail: `packageManagers[${index}].supportedMajors must be positive integer majors` });
          continue;
        }
        const majors = /** @type {number[]} */ ([...item.supportedMajors]);
        if (new Set(majors).size !== majors.length) { errors.push({ id: "package-manager-majors-duplicate", detail: `packageManagers[${index}].supportedMajors must be unique` }); continue; }
        packageManagers.push({ name, supportedMajors: majors.sort((a, b) => a - b) });
      }
    }
  }

  /** @type {Record<string, boolean>} */
  const flags = {};
  for (const key of ["requireNodeVersionFile", "requirePackageManagerPin", "requireNodeEngine"]) {
    const value = raw[key];
    if (value !== undefined && typeof value !== "boolean") errors.push({ id: `${key}-invalid`, detail: `${key} must be boolean` });
    flags[key] = value === true;
  }

  if (supportedNodeMajors.length === 0 && packageManagers.length === 0 && !flags.requireNodeVersionFile && !flags.requirePackageManagerPin && !flags.requireNodeEngine) {
    errors.push({ id: "policy-empty", detail: "policy must configure at least one runtime support or reproducibility rule" });
  }
  if (errors.length > 0) return { ok: false, policy: null, errors };
  return {
    ok: true,
    policy: {
      version: 1,
      supportedNodeMajors,
      packageManagers,
      requireNodeVersionFile: flags.requireNodeVersionFile,
      requirePackageManagerPin: flags.requirePackageManagerPin,
      requireNodeEngine: flags.requireNodeEngine,
    },
    errors: [],
  };
}

/** @param {Array<any>} repositories @param {ReturnType<typeof validateDependencyDriftPolicy>["policy"]} policy */
function evaluateRuntimePolicy(repositories, policy) {
  if (policy === null) return { configured: false, status: "NOT_CONFIGURED", checks: [], summary: { pass: 0, warn: 0, fail: 0 } };
  const checks = [];
  for (const repository of repositories) {
    if (!repository.hasPackageJson) continue;
    const node = exactSemver(repository.nodeVersion);
    if (policy.requireNodeVersionFile) {
      checks.push({ id: "node-version-file", repository: repository.name, status: node ? "PASS" : "FAIL", detail: node ? `reference Node.js version is ${repository.nodeVersion}` : "exact .node-version is required" });
    }
    if (policy.supportedNodeMajors.length > 0) {
      if (!node) checks.push({ id: "node-runtime-support", repository: repository.name, status: "WARN", detail: "Node.js support cannot be verified without an exact .node-version" });
      else checks.push({ id: "node-runtime-support", repository: repository.name, status: policy.supportedNodeMajors.includes(node.major) ? "PASS" : "FAIL", detail: policy.supportedNodeMajors.includes(node.major) ? `Node.js ${node.major} is supported` : `Node.js ${node.major} is outside supported majors ${policy.supportedNodeMajors.join(", ")}` });
    }
    if (policy.requireNodeEngine) {
      const present = typeof repository.engines.node === "string" && repository.engines.node.trim().length > 0;
      checks.push({ id: "node-engine", repository: repository.name, status: present ? "PASS" : "FAIL", detail: present ? `Node engine is ${repository.engines.node}` : "package.json engines.node is required" });
    }

    const manager = repository.packageManagerParsed;
    if (policy.requirePackageManagerPin) {
      checks.push({ id: "package-manager-pin", repository: repository.name, status: manager?.pinned ? "PASS" : "FAIL", detail: manager?.pinned ? `package manager is pinned to ${repository.packageManager}` : "an exact packageManager name@x.y.z pin is required" });
    }
    if (policy.packageManagers.length > 0) {
      if (!manager) {
        checks.push({ id: "package-manager-support", repository: repository.name, status: "WARN", detail: "package manager support cannot be verified because packageManager is missing" });
      } else {
        const allowed = policy.packageManagers.find((item) => item.name === manager.name);
        if (!allowed) checks.push({ id: "package-manager-support", repository: repository.name, status: "FAIL", detail: `package manager ${manager.name} is not allowed by policy` });
        else if (manager.major === null) checks.push({ id: "package-manager-support", repository: repository.name, status: "WARN", detail: `package manager ${manager.name} version major cannot be verified` });
        else checks.push({ id: "package-manager-support", repository: repository.name, status: allowed.supportedMajors.includes(manager.major) ? "PASS" : "FAIL", detail: allowed.supportedMajors.includes(manager.major) ? `${manager.name} ${manager.major} is supported` : `${manager.name} ${manager.major} is outside supported majors ${allowed.supportedMajors.join(", ")}` });
      }
    }
  }
  const summary = {
    pass: checks.filter((check) => check.status === "PASS").length,
    warn: checks.filter((check) => check.status === "WARN").length,
    fail: checks.filter((check) => check.status === "FAIL").length,
  };
  return { configured: true, status: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS", checks, summary };
}

/** @param {Array<any>} repositories @param {string} field @param {string} dimension */
function collectRuntimeDrift(repositories, field, dimension) {
  const versions = new Map();
  for (const repository of repositories) {
    const value = repository[field];
    if (typeof value !== "string" || !value) continue;
    if (!versions.has(value)) versions.set(value, []);
    versions.get(value).push(repository.name);
  }
  if (versions.size <= 1) return null;
  return {
    dimension,
    variants: [...versions.entries()].map(([value, names]) => ({ value, repositories: names.sort() })),
  };
}

/** @param {string[]} targets @param {{ policy?: any }} [options] */
export function inspectDependencyDrift(targets, options = {}) {
  const repositories = targets.map((target) => {
    const root = resolve(target);
    const pkg = readPackage(root);
    const nodeVersion = readNodeVersion(root);
    const pythonVersion = readPythonVersion(root);
    if (!pkg) {
      return {
        name: path.basename(root), path: root, hasPackageJson: false, packageManager: null, packageManagerParsed: null,
        nodeVersion, pythonVersion, engines: {}, dependencies: {},
      };
    }
    const allDependencies = { ...(isPlainObject(pkg.dependencies) ? pkg.dependencies : {}), ...(isPlainObject(pkg.devDependencies) ? pkg.devDependencies : {}) };
    /** @type {Record<string, string>} */
    const dependencies = {};
    for (const dependency of TRACKED_DEPENDENCIES) if (typeof allDependencies[dependency] === "string") dependencies[dependency] = allDependencies[dependency];
    const packageManager = nonEmptyString(pkg.packageManager);
    return {
      name: path.basename(root),
      path: root,
      hasPackageJson: true,
      packageManager,
      packageManagerParsed: parsePackageManager(packageManager),
      nodeVersion,
      pythonVersion,
      engines: isPlainObject(pkg.engines) ? pkg.engines : {},
      dependencies,
    };
  });

  const drift = [];
  const majorVersionConflicts = [];
  for (const dependency of TRACKED_DEPENDENCIES) {
    const versions = new Map();
    const majors = new Map();
    for (const repository of repositories) {
      const version = repository.dependencies[dependency];
      if (!version) continue;
      if (!versions.has(version)) versions.set(version, []);
      versions.get(version).push(repository.name);
      const major = dependencyMajor(version);
      if (major !== null) {
        if (!majors.has(major)) majors.set(major, { versions: new Set(), repositories: [] });
        majors.get(major).versions.add(version);
        majors.get(major).repositories.push(repository.name);
      }
    }
    if (versions.size > 1) drift.push({ dependency, variants: [...versions.entries()].map(([version, repositoryNames]) => ({ version, repositories: repositoryNames.sort() })) });
    if (majors.size > 1) majorVersionConflicts.push({
      dependency,
      majors: [...majors.entries()].sort((a, b) => a[0] - b[0]).map(([major, data]) => ({ major, versions: [...data.versions].sort(), repositories: data.repositories.sort() })),
    });
  }

  const runtimeDrift = [];
  const nodeVersionDrift = collectRuntimeDrift(repositories, "nodeVersion", "node-version");
  const pythonVersionDrift = collectRuntimeDrift(repositories, "pythonVersion", "python-version");
  const packageManagerDrift = collectRuntimeDrift(repositories, "packageManager", "package-manager");
  if (nodeVersionDrift) runtimeDrift.push(nodeVersionDrift);
  if (pythonVersionDrift) runtimeDrift.push(pythonVersionDrift);
  if (packageManagerDrift) runtimeDrift.push(packageManagerDrift);
  const nodeEngineVariants = new Map();
  for (const repository of repositories) {
    const engine = typeof repository.engines.node === "string" ? repository.engines.node.trim() : "";
    if (!engine) continue;
    if (!nodeEngineVariants.has(engine)) nodeEngineVariants.set(engine, []);
    nodeEngineVariants.get(engine).push(repository.name);
  }
  if (nodeEngineVariants.size > 1) runtimeDrift.push({ dimension: "node-engine", variants: [...nodeEngineVariants.entries()].map(([value, names]) => ({ value, repositories: names.sort() })) });

  const nodeRepositories = repositories.filter((repository) => repository.hasPackageJson);
  const missingPackageManager = nodeRepositories.filter((repository) => !repository.packageManager).map((repository) => repository.name);
  const unpinnedPackageManager = nodeRepositories.filter((repository) => repository.packageManager && !repository.packageManagerParsed?.pinned).map((repository) => repository.name);
  const missingEngines = nodeRepositories.filter((repository) => !repository.engines || Object.keys(repository.engines).length === 0).map((repository) => repository.name);
  const missingNodeVersion = nodeRepositories.filter((repository) => !exactSemver(repository.nodeVersion)).map((repository) => repository.name);

  let policy = null;
  if (options.policy !== undefined) {
    const validated = validateDependencyDriftPolicy(options.policy);
    if (!validated.ok || validated.policy === null) throw new Error(`invalid dependency drift policy: ${validated.errors.map((item) => item.id).join(", ")}`);
    policy = validated.policy;
  }
  const runtimePolicy = evaluateRuntimePolicy(repositories, policy);

  const warningCount = drift.length + runtimeDrift.length + majorVersionConflicts.length + missingPackageManager.length + unpinnedPackageManager.length + missingEngines.length + missingNodeVersion.length;
  const overallStatus = runtimePolicy.status === "FAIL" ? "FAIL" : runtimePolicy.status === "WARN" || warningCount > 0 ? "WARN" : "PASS";

  return {
    repositories,
    drift,
    runtimeDrift,
    majorVersionConflicts,
    runtimePolicy,
    summary: {
      repositories: repositories.length,
      trackedDependencies: TRACKED_DEPENDENCIES.length,
      driftedDependencies: drift.length,
      runtimeDriftDimensions: runtimeDrift.length,
      majorVersionConflicts: majorVersionConflicts.length,
      missingPackageManager: missingPackageManager.length,
      unpinnedPackageManager: unpinnedPackageManager.length,
      missingEngines: missingEngines.length,
      missingNodeVersion: missingNodeVersion.length,
    },
    reproducibility: { missingPackageManager, unpinnedPackageManager, missingEngines, missingNodeVersion },
    technicalStatus: "PASS",
    overallStatus,
  };
}

/** @param {ReturnType<typeof inspectDependencyDrift>} report */
export function formatDependencyDrift(report) {
  const lines = ["Dependency and runtime drift audit", ""];
  if (report.drift.length === 0) lines.push("No tracked dependency drift detected.");
  else for (const item of report.drift) {
    lines.push(`DRIFT  ${item.dependency}`);
    for (const variant of item.variants) lines.push(`  ${variant.version}  ${variant.repositories.join(", ")}`);
  }
  for (const item of report.majorVersionConflicts) {
    lines.push(`MAJOR  ${item.dependency}`);
    for (const major of item.majors) lines.push(`  ${major.major}  ${major.repositories.join(", ")}  ${major.versions.join(" | ")}`);
  }
  for (const item of report.runtimeDrift) {
    lines.push(`RUNTIME DRIFT  ${item.dimension}`);
    for (const variant of item.variants) lines.push(`  ${variant.value}  ${variant.repositories.join(", ")}`);
  }

  lines.push("", "Ecosystem versions");
  const headers = ["REPOSITORY", "NODE", "PYTHON", "PACKAGE_MANAGER", ...ECOSYSTEM_COLUMNS.map(([, label]) => label)];
  const rows = report.repositories.map((repository) => [
    repository.name,
    repository.nodeVersion ?? "-",
    repository.pythonVersion ?? "-",
    repository.packageManager ?? "-",
    ...ECOSYSTEM_COLUMNS.map(([dependency]) => repository.dependencies[dependency] ?? "-"),
  ]);
  const widths = headers.map((header, index) => Math.max(header.length, ...rows.map((row) => String(row[index] ?? "").length)));
  lines.push(headers.map((header, index) => header.padEnd(widths[index] ?? header.length)).join("  "));
  for (const row of rows) lines.push(row.map((value, index) => String(value).padEnd(widths[index] ?? String(value).length)).join("  "));

  if (report.runtimePolicy.configured) {
    lines.push("", `Runtime policy: ${report.runtimePolicy.status}`);
    for (const check of report.runtimePolicy.checks) lines.push(`${check.status.padEnd(4)}  ${check.repository}  ${check.id}  ${check.detail}`);
  } else lines.push("", "Runtime policy: NOT_CONFIGURED");

  lines.push(
    "",
    `Repositories: ${report.summary.repositories}`,
    `Tracked dependencies: ${report.summary.trackedDependencies}`,
    `Drifted dependencies: ${report.summary.driftedDependencies}`,
    `Runtime drift dimensions: ${report.summary.runtimeDriftDimensions}`,
    `Major-version conflicts: ${report.summary.majorVersionConflicts}`,
    `Missing packageManager: ${report.summary.missingPackageManager}`,
    `Unpinned packageManager: ${report.summary.unpinnedPackageManager}`,
    `Missing engines: ${report.summary.missingEngines}`,
    `Missing exact .node-version: ${report.summary.missingNodeVersion}`,
    `Technical: ${report.technicalStatus}`,
    `Overall: ${report.overallStatus}`,
  );
  return lines.join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  const targets = [];
  let policyFile = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument === "--policy") {
      const value = argv[index + 1];
      if (policyFile !== null || typeof value !== "string" || value.startsWith("--")) return null;
      policyFile = value;
      index += 1;
      continue;
    }
    if (typeof argument !== "string" || argument.startsWith("--")) return null;
    targets.push(argument);
  }
  return targets.length > 0 ? { targets, policyFile, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/audit-dependency-drift.js <repository> [repository...] [--policy <policy.json>] [--json]");
    return 1;
  }
  let policy;
  if (options.policyFile !== null) {
    try { policy = JSON.parse(fs.readFileSync(options.policyFile, "utf8")); }
    catch { console.error("Dependency drift policy cannot be read or parsed"); return 1; }
    const validated = validateDependencyDriftPolicy(policy);
    if (!validated.ok) { console.error("Dependency drift policy is invalid"); return 1; }
  }
  try {
    const report = inspectDependencyDrift(options.targets, { ...(policy !== undefined ? { policy } : {}) });
    console.log(options.json ? JSON.stringify(report) : formatDependencyDrift(report));
    return report.overallStatus === "FAIL" ? 1 : 0;
  } catch {
    console.error("Dependency drift audit input is invalid or unreadable");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) process.exitCode = main();
