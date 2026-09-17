#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { planRemediation } from "./plan-remediation.js";

const toolkitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_AUTOFIX_IDS = new Set(["changed-lint-script"]);

/** @param {Buffer} value */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {any} item */
export function isSafeAutofixEligible(item) {
  return item?.remediation === "safe" &&
    item?.automatic === true &&
    item?.risk === "LOW" &&
    item?.ownership === "toolkit" &&
    SAFE_AUTOFIX_IDS.has(item?.id) &&
    Array.isArray(item?.validation?.checks) &&
    item.validation.checks.includes(item.id) &&
    Array.isArray(item?.validation?.commands) &&
    item.validation.commands.length === 0;
}

/** @param {string} root */
function assertRepositoryRoot(root) {
  let stat;
  try { stat = fs.lstatSync(root); } catch { throw new Error("Safe remediation target is unavailable"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Safe remediation target must be a regular directory, not a symlink");
  }
  return fs.realpathSync(root);
}

/** @param {string} root @param {string} relative */
function resolveSafeDestination(root, relative) {
  if (!relative || path.isAbsolute(relative) || relative.includes("\0") || relative.includes("\\")) {
    throw new Error("Safe remediation destination must be repository-relative");
  }
  const normalized = path.posix.normalize(relative);
  if (normalized !== relative || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("Safe remediation destination must stay inside the repository");
  }
  const absolute = path.resolve(root, ...relative.split("/"));
  const rel = path.relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("Safe remediation destination escaped repository root");
  }
  return absolute;
}

/** @param {string} filename */
function lstatIfPresent(filename) {
  try { return fs.lstatSync(filename); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

/** @param {string} root @param {string} destination */
function assertExistingParentsSafe(root, destination) {
  const relativeParent = path.relative(root, path.dirname(destination));
  if (!relativeParent || relativeParent === ".") return;
  let current = root;
  for (const segment of relativeParent.split(path.sep)) {
    current = path.join(current, segment);
    const stat = lstatIfPresent(current);
    if (stat === null) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Safe remediation refuses non-directory or symlink parent: ${path.relative(root, current)}`);
    }
  }
}

/** @param {string} source */
function readToolkitSource(source) {
  const stat = fs.lstatSync(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error("Toolkit autofix source must be a non-empty regular file");
  }
  return fs.readFileSync(source);
}

/** @param {string} root @param {{ dryRun?: boolean }} options */
export function applySafeRemediation(root, options = {}) {
  const target = path.resolve(root);
  const realRoot = assertRepositoryRoot(target);
  const dryRun = Boolean(options.dryRun);
  const plan = planRemediation(realRoot);

  /** @type {Array<{ id: string, action: "create", destination: string, relativePath:string, risk:"LOW", sourceSha256:string, validationChecks:string[] }>} */
  const actions = [];

  for (const item of plan.items) {
    if (item.remediation !== "safe") continue;
    if (!isSafeAutofixEligible(item)) {
      throw new Error(`Safe remediation metadata is not eligible for automatic execution: ${item.id}`);
    }

    if (item.id !== "changed-lint-script") {
      throw new Error(`No deterministic safe autofix implementation exists for ${item.id}`);
    }

    const relativePath = "scripts/lint-changed.js";
    if (!item.files.includes(relativePath)) {
      throw new Error("Safe remediation plan does not bind the expected toolkit-owned destination");
    }
    const source = path.resolve(toolkitRoot, "scripts", "lint-changed.js");
    const sourceBytes = readToolkitSource(source);
    const sourceSha256 = sha256(sourceBytes);
    const destination = resolveSafeDestination(realRoot, relativePath);
    assertExistingParentsSafe(realRoot, destination);

    if (lstatIfPresent(destination) !== null) {
      throw new Error("Safe remediation refuses to overwrite an existing destination");
    }

    actions.push({
      id: item.id,
      action: "create",
      destination,
      relativePath,
      risk: "LOW",
      sourceSha256,
      validationChecks: [...item.validation.checks],
    });

    if (!dryRun) {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      assertExistingParentsSafe(realRoot, destination);
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      const copied = fs.readFileSync(destination);
      if (sha256(copied) !== sourceSha256) {
        throw new Error("Safe remediation copy verification failed");
      }
    }
  }

  const initialValidationChecks = actions.slice(0, 0).map((action) => ({ id: action.id, passed: true }));
  let validation = { performed: false, passed: true, checks: initialValidationChecks };
  if (!dryRun && actions.length > 0) {
    const postPlan = planRemediation(realRoot);
    const checks = actions.map((action) => ({
      id: action.id,
      passed: !postPlan.items.some((item) => item.id === action.id),
    }));
    validation = { performed: true, passed: checks.every((check) => check.passed), checks };
    if (!validation.passed) throw new Error("Safe remediation post-apply validation failed");
  }

  return {
    version: 1,
    root: realRoot,
    dryRun,
    actions,
    validation,
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
        `${result.dryRun ? "DRY-RUN" : "APPLY"}  ${action.action.toUpperCase()}  ${action.relativePath}  risk=${action.risk}`,
      );
    }
  }

  if (result.validation.performed) {
    lines.push("", `Post-apply validation: ${result.validation.passed ? "PASS" : "FAIL"}`);
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
  if (positional.length > 1 || positional.some((argument) => argument.startsWith("--"))) {
    console.error("Usage: node scripts/apply-remediation.js [repository] [--dry-run]");
    return 1;
  }
  const target = positional[0] ?? process.cwd();
  try {
    const result = applySafeRemediation(target, { dryRun });
    console.log(formatApplyResult(result));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Safe remediation failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
