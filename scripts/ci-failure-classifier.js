#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {"CODE" | "LINT" | "TEST" | "DATABASE" | "RUNNER/INFRA" | "POLICY"} CiFailureCategory */

/** @type {readonly CiFailureCategory[]} */
export const CI_FAILURE_CATEGORIES = Object.freeze([
  "CODE",
  "LINT",
  "TEST",
  "DATABASE",
  "RUNNER/INFRA",
  "POLICY",
]);

const patterns = {
  policyStep: /(?:policy|toolkit|security|secret|audit)/i,
  policyOutput: /(?:hardcoded-secret-assignment|policy pack|public repo safety|security gate|repository policy)/i,
  databaseStep: /(?:database|supabase|postgres|migration|schema)/i,
  databaseOutput: /(?:supabase|postgres|postgresql|migration|schema drift|database)/i,
  infraStep: /(?:runner|infra|checkout|setup|install|environment|port|artifact)/i,
  infraOutput: /(?:address already in use|already used|runner connect error|resource temporarily unavailable|broker\.actions|pipelinesghub|self-hosted|no space left|disk full|econnreset|enotfound|etimedout|timed out|timeout|task was canceled|task was cancelled|job was canceled|job was cancelled|network is unreachable|cannot connect)/i,
  lintStep: /(?:lint|prettier|eslint)/i,
  lintOutput: /(?:prettier\/prettier|eslint|linting .*file|problems? \([0-9]+ errors?)/i,
  testStep: /(?:test|e2e|playwright|vitest|jest)/i,
  testOutput: /(?:playwright|vitest|jest|assertionerror|tests? failed|[0-9]+ fail\b)/i,
  codeStep: /(?:typecheck|type check|build|compile|tsc|typescript)/i,
  codeOutput: /(?:typescript|tsc|type error|build failed|compile error|cannot find module)/i,
};

/**
 * @param {{ step?: unknown, output?: unknown }} input
 * @returns {{ category: CiFailureCategory, reason: string }}
 */
export function classifyCiFailure(input = {}) {
  const step = typeof input.step === "string" ? input.step : "";
  const output = typeof input.output === "string" ? input.output : "";

  if (patterns.policyStep.test(step) || patterns.policyOutput.test(output)) {
    return { category: "POLICY", reason: "policy or security gate" };
  }
  if (patterns.databaseStep.test(step) || patterns.databaseOutput.test(output)) {
    return { category: "DATABASE", reason: "database, schema, or migration gate" };
  }
  if (patterns.infraOutput.test(output)) {
    return { category: "RUNNER/INFRA", reason: "runner, network, timeout, or port infrastructure" };
  }
  if (patterns.lintStep.test(step) || patterns.lintOutput.test(output)) {
    return { category: "LINT", reason: "lint or formatting gate" };
  }
  if (patterns.testStep.test(step) || patterns.testOutput.test(output)) {
    return { category: "TEST", reason: "automated test gate" };
  }
  if (patterns.codeStep.test(step) || patterns.codeOutput.test(output)) {
    return { category: "CODE", reason: "typecheck, compilation, or build gate" };
  }
  if (patterns.infraStep.test(step)) {
    return { category: "RUNNER/INFRA", reason: "runner or environment setup gate" };
  }
  return { category: "CODE", reason: "unclassified blocking repository command" };
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  let step = "";
  let outputFile = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg !== "--step" && arg !== "--output-file") return null;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) return null;
    if (arg === "--step") step = value;
    if (arg === "--output-file") outputFile = value;
    index += 1;
  }
  if (!step) return null;
  return { step, outputFile, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/ci-failure-classifier.js --step <name> [--output-file <path>] [--json]");
    return 2;
  }
  let output = "";
  if (options.outputFile) {
    try {
      output = fs.readFileSync(options.outputFile, "utf8");
    } catch {
      console.error("CI failure output file could not be read");
      return 2;
    }
  }
  const result = classifyCiFailure({ step: options.step, output });
  if (options.json) console.log(JSON.stringify(result));
  else {
    console.log(`CI_FAILURE_CLASS=${result.category}`);
    console.log(`CI_FAILURE_REASON=${result.reason}`);
  }
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
