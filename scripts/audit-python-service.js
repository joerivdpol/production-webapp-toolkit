#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{ id: string, label: string, passed: boolean, required: boolean }} PythonAuditCheck */

/** @param {string} root */
function readWorkflowText(root) {
  const directory = path.join(root, ".github", "workflows");

  if (!fs.existsSync(directory)) return "";

  return fs
    .readdirSync(directory)
    .filter((name) => /\.ya?ml$/i.test(name))
    .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
    .join("\n");
}

/** @param {string} root */
function pythonFiles(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".py"))
    .map((entry) => entry.name);
}

/** @param {string} root */
function shellFiles(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sh"))
    .map((entry) => entry.name);
}

/** @param {string} target */
export function inspectPythonService(target) {
  const root = resolve(target);
  const workflows = readWorkflowText(root);
  const pyFiles = pythonFiles(root);
  const shFiles = shellFiles(root);

  const hasTests =
    fs.existsSync(path.join(root, "tests")) &&
    fs
      .readdirSync(path.join(root, "tests"))
      .some((name) => /^test_.*\.py$/.test(name));

  const pythonSetup =
    /actions\/setup-python@/i.test(workflows) &&
    /python-version:\s*["']?3\./i.test(workflows);

  const syntaxInCi =
    /python(?:3)?\s+-m\s+py_compile\b/i.test(workflows);

  const testsInCi =
    /python(?:3)?\s+-m\s+(?:unittest|pytest)\b/i.test(workflows);

  const shellSyntaxInCi =
    shFiles.length === 0 ||
    /bash\s+-n\b/i.test(workflows);

  /** @type {PythonAuditCheck[]} */
  const checks = [
    {
      id: "python-source",
      label: "Python source files",
      passed: pyFiles.length > 0,
      required: true,
    },
    {
      id: "python-version-ci",
      label: "Explicit Python version in CI",
      passed: pythonSetup,
      required: true,
    },
    {
      id: "python-syntax-ci",
      label: "Python syntax check in CI",
      passed: syntaxInCi,
      required: true,
    },
    {
      id: "offline-tests",
      label: "Offline automated tests",
      passed: hasTests,
      required: true,
    },
    {
      id: "offline-tests-ci",
      label: "Offline tests invoked in CI",
      passed: testsInCi,
      required: true,
    },
    {
      id: "shell-syntax-ci",
      label: "Shell syntax checked when shell scripts exist",
      passed: shellSyntaxInCi,
      required: true,
    },
    {
      id: "github-ci",
      label: "GitHub Actions CI",
      passed: workflows.length > 0,
      required: true,
    },
    {
      id: "readme",
      label: "README.md",
      passed: fs.existsSync(path.join(root, "README.md")),
      required: false,
    },
    {
      id: "agents",
      label: "AGENTS.md",
      passed: fs.existsSync(path.join(root, "AGENTS.md")),
      required: false,
    },
    {
      id: "dependency-manifest",
      label: "Python dependency manifest",
      passed: [
        "pyproject.toml",
        "requirements.txt",
        "requirements-dev.txt",
        "setup.cfg",
      ].some((name) => fs.existsSync(path.join(root, name))),
      required: false,
    },
  ];

  const required = checks.filter((check) => check.required);

  return {
    root,
    profile: "python-service",
    checks,
    passed: checks.filter((check) => check.passed).length,
    requiredPassed: required.filter((check) => check.passed).length,
    requiredTotal: required.length,
    corePassed: required.every((check) => check.passed),
  };
}

/** @param {ReturnType<typeof inspectPythonService>} report */
export function formatPythonServiceAudit(report) {
  return [
    `Python service audit: ${report.root}`,
    "",
    ...report.checks.map(
      (check) =>
        `${check.passed ? "PASS" : "MISS"}  ${check.required ? "required" : "optional"}  ${check.label}`,
    ),
    "",
    `Score: ${report.passed}/${report.checks.length}; core: ${report.requiredPassed}/${report.requiredTotal}`,
    report.corePassed
      ? "Result: PASS — all required Python service quality gates are present."
      : "Result: FAIL — one or more required Python service quality gates are missing.",
  ].join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");
  const target = resolve(positional[0] ?? process.cwd());

  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
    const error = {
      error: "target_not_found",
      target,
    };

    console.error(
      json
        ? JSON.stringify(error)
        : `Python service audit failed: target does not exist: ${target}`,
    );

    return 1;
  }

  const report = inspectPythonService(target);

  console.log(
    json
      ? JSON.stringify(report)
      : formatPythonServiceAudit(report),
  );

  return report.corePassed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
