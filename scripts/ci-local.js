#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { classifyCiFailure } from "./ci-failure-classifier.js";
import { clearPort, normalizePort } from "./ci-port-guard.js";

/** @typedef {"CODE" | "LINT" | "TEST" | "DATABASE" | "RUNNER/INFRA" | "POLICY"} CiFailureCategory */
/** @typedef {{ name: string, script: string, classification: CiFailureCategory, advisory: boolean, env: Record<string, string> }} CiPlanStep */
/** @typedef {{ packageManager: "bun" | "pnpm" | "npm", steps: CiPlanStep[] }} CiPlan */
/** @typedef {{ category: CiFailureCategory, reason: string }} CiBlockingFailure */
/** @typedef {{ name: string, status: "PASS" | "WARN" | "FAIL", advisory: boolean, classification: CiFailureCategory | null, reason?: string, durationMs?: number }} CiStepResult */

/** @param {string} root @param {Record<string, any>} packageJson @returns {"bun" | "pnpm" | "npm" | null} */
export function detectPackageManager(root, packageJson) {
  const declared = typeof packageJson.packageManager === "string" ? packageJson.packageManager : "";
  if (declared.startsWith("bun@") || fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
  if (declared.startsWith("pnpm@") || fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (declared.startsWith("npm@") || fs.existsSync(path.join(root, "package-lock.json"))) return "npm";
  return null;
}

/**
 * @param {string} root
 * @param {{ changedBase?: string | null, includeE2e?: boolean, e2ePort?: number | null, includeDatabase?: boolean, fullLint?: "advisory" | "blocking" | "skip" }} options
 * @returns {CiPlan}
 */
export function buildPlan(root, options = {}) {
  const packageFile = path.join(root, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageFile, "utf8"));
  const scripts = packageJson.scripts && typeof packageJson.scripts === "object" ? packageJson.scripts : {};
  const packageManager = detectPackageManager(root, packageJson);
  if (!packageManager) throw new Error("could not determine package manager");

  /** @type {CiPlanStep[]} */
  const steps = [];
  /** @param {string} name @param {string} script @param {CiFailureCategory} classification @param {boolean} advisory @param {Record<string, string>} env */
  const add = (name, script, classification, advisory = false, env = {}) => {
    if (typeof scripts[script] === "string") steps.push({ name, script, classification, advisory, env });
  };

  add("typecheck", "typecheck", "CODE");
  add("test", "test", "TEST");
  if ((options.fullLint ?? "advisory") !== "skip") {
    add("lint", "lint", "LINT", (options.fullLint ?? "advisory") === "advisory");
  }
  if (options.changedBase) add("lint:changed", "lint:changed", "LINT", false, { LINT_CHANGED_BASE: options.changedBase });
  add("build", "build", "CODE");
  if (options.includeDatabase) add("database", "ci:database", "DATABASE");
  if (options.includeE2e) {
    /** @type {Record<string, string>} */
    const env = { CI: "true" };
    if (options.e2ePort) env.E2E_BASE_URL = `http://127.0.0.1:${options.e2ePort}`;
    add("e2e", "test:e2e", "TEST", false, env);
  }
  return { packageManager, steps };
}

/** @param {"bun" | "pnpm" | "npm"} packageManager @param {string} script @returns {[string, string[]]} */
function commandFor(packageManager, script) {
  return packageManager === "bun"
    ? ["bun", ["run", script]]
    : packageManager === "pnpm"
      ? ["pnpm", ["run", script]]
      : ["npm", ["run", script]];
}

/**
 * @param {CiPlan} plan
 * @param {string} root
 * @param {{ e2ePort?: number | null }} options
 */
export function executePlan(plan, root, options = {}) {
  /** @type {CiStepResult[]} */
  const results = [];
  /** @type {CiBlockingFailure | null} */
  let blockingFailure = null;

  for (const step of plan.steps) {
    if (blockingFailure) break;
    let preflight = null;
    if (step.name === "e2e" && options.e2ePort) {
      preflight = clearPort(options.e2ePort, { force: false });
      if (!preflight.ok) {
        /** @type {CiBlockingFailure} */
        const failure = { category: "RUNNER/INFRA", reason: preflight.error ?? "E2E port preflight failed" };
        results.push({ name: step.name, status: "FAIL", advisory: false, classification: failure.category, reason: failure.reason });
        blockingFailure = failure;
        break;
      }
    }

    const [command, args] = commandFor(plan.packageManager, step.script);
    const started = Date.now();
    const execution = spawnSync(command, args, {
      cwd: root,
      env: { ...process.env, ...step.env },
      encoding: "utf8",
      maxBuffer: 50 * 1024 * 1024,
    });
    if (execution.stdout) process.stdout.write(execution.stdout);
    if (execution.stderr) process.stderr.write(execution.stderr);
    const durationMs = Date.now() - started;
    const status = execution.status ?? 1;

    if (step.name === "e2e" && options.e2ePort) {
      const cleanup = clearPort(options.e2ePort, { force: true });
      if (!cleanup.ok && status === 0) {
        /** @type {CiBlockingFailure} */
        const failure = { category: "RUNNER/INFRA", reason: cleanup.error ?? "E2E port cleanup failed" };
        results.push({ name: step.name, status: "FAIL", advisory: false, classification: failure.category, reason: failure.reason, durationMs });
        blockingFailure = failure;
        break;
      }
    }

    if (status === 0) {
      results.push({ name: step.name, status: "PASS", advisory: step.advisory, classification: null, durationMs });
      continue;
    }

    const inferred = classifyCiFailure({ step: step.name, output: `${execution.stdout ?? ""}\n${execution.stderr ?? ""}` });
    const classification = inferred.category === "CODE" && step.classification ? step.classification : inferred.category;
    const reason = inferred.category === "CODE" && step.classification !== "CODE" ? `${step.name} gate failed` : inferred.reason;
    results.push({ name: step.name, status: step.advisory ? "WARN" : "FAIL", advisory: step.advisory, classification, reason, durationMs });
    console.error(`CI_FAILURE_CLASS=${classification}`);
    console.error(`CI_FAILURE_STEP=${step.name}`);
    if (!step.advisory) blockingFailure = { category: classification, reason };
  }

  return { results, blockingFailure, overallStatus: blockingFailure ? "FAIL" : results.some((item) => item.status === "WARN") ? "WARN" : "PASS" };
}

/**
 * @param {string[]} argv
 * @returns {{ root: string, changedBase: string | null, includeE2e: boolean, e2ePort: number | null, includeDatabase: boolean, fullLint: "advisory" | "blocking" | "skip" } | null}
 */
export function parseArguments(argv) {
  let root = ".";
  let changedBase = null;
  let includeE2e = false;
  let e2ePort = null;
  let includeDatabase = false;
  /** @type {"advisory" | "blocking" | "skip"} */
  let fullLint = "advisory";
  let rootSet = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (typeof arg !== "string") return null;
    if (!arg.startsWith("--") && !rootSet) {
      root = arg;
      rootSet = true;
      continue;
    }
    if (arg === "--include-e2e") includeE2e = true;
    else if (arg === "--include-database") includeDatabase = true;
    else if (arg === "--changed-base" || arg === "--e2e-port" || arg === "--full-lint") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return null;
      if (arg === "--changed-base") changedBase = value;
      if (arg === "--e2e-port") {
        e2ePort = normalizePort(value);
        if (e2ePort === null) return null;
      }
      if (arg === "--full-lint") {
        if (!["advisory", "blocking", "skip"].includes(value)) return null;
        fullLint = /** @type {"advisory" | "blocking" | "skip"} */ (value);
      }
      index += 1;
    } else return null;
  }
  if (e2ePort !== null) includeE2e = true;
  return { root: path.resolve(root), changedBase, includeE2e, e2ePort, includeDatabase, fullLint };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/ci-local.js [repo] [--changed-base <ref>] [--full-lint advisory|blocking|skip] [--include-database] [--include-e2e] [--e2e-port <port>]");
    return 2;
  }
  let plan;
  try {
    plan = buildPlan(options.root, options);
  } catch (error) {
    console.error(`CI_FAILURE_CLASS=RUNNER/INFRA`);
    console.error(error instanceof Error ? error.message : "local CI plan could not be built");
    return 2;
  }
  const report = executePlan(plan, options.root, options);
  console.log(`CI_LOCAL_STATUS=${report.overallStatus}`);
  for (const result of report.results) {
    const suffix = result.classification ? ` class=${result.classification}` : "";
    console.log(`${result.status} ${result.name}${suffix}`);
  }
  return report.blockingFailure ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
