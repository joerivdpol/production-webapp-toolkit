import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildPlan, detectPackageManager, executePlan, parseArguments } from "../scripts/ci-local.js";

/** @type {string[]} */
const roots = [];
/** @param {Record<string, any>} packageJson */
function repo(packageJson) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-ci-local-"));
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(packageJson, null, 2));
  fs.writeFileSync(path.join(root, "bun.lock"), "");
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

test("local CI plan mirrors the standard webapp gates", () => {
  const root = repo({
    packageManager: "bun@1.3.14",
    scripts: { typecheck: "true", test: "true", lint: "true", "lint:changed": "true", build: "true", "ci:database": "true", "test:e2e": "true" },
  });
  assert.equal(detectPackageManager(root, { packageManager: "bun@1.3.14" }), "bun");
  const plan = buildPlan(root, { changedBase: "origin/main", includeDatabase: true, includeE2e: true, e2ePort: 43179 });
  assert.deepEqual(plan.steps.map((step) => [step.name, step.advisory]), [
    ["typecheck", false], ["test", false], ["lint", true], ["lint:changed", false], ["build", false], ["database", false], ["e2e", false],
  ]);
  assert.equal(plan.steps.find((step) => step.name === "lint:changed")?.env.LINT_CHANGED_BASE, "origin/main");
  assert.equal(plan.steps.find((step) => step.name === "e2e")?.env.E2E_BASE_URL, "http://127.0.0.1:43179");
});

test("advisory historical lint can warn without hiding blocking parity", () => {
  const root = repo({
    packageManager: "bun@1.3.14",
    scripts: {
      typecheck: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(0)\"",
      lint: "node -e \"process.exit(7)\"",
      "lint:changed": "node -e \"process.exit(process.env.LINT_CHANGED_BASE ? 0 : 8)\"",
      build: "node -e \"process.exit(0)\"",
    },
  });
  const plan = buildPlan(root, { changedBase: "origin/main" });
  const report = executePlan(plan, root, {});
  assert.equal(report.blockingFailure, null);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.results.find((item) => item.name === "lint")?.classification, "LINT");
  assert.equal(report.results.find((item) => item.name === "lint:changed")?.status, "PASS");
});

test("blocking test failure is classified and stops later gates", () => {
  const root = repo({
    packageManager: "bun@1.3.14",
    scripts: {
      typecheck: "node -e \"process.exit(0)\"",
      test: "node -e \"process.exit(1)\"",
      build: "node -e \"process.exit(99)\"",
    },
  });
  const report = executePlan(buildPlan(root, { fullLint: "skip" }), root, {});
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.blockingFailure?.category, "TEST");
  assert.deepEqual(report.results.map((item) => item.name), ["typecheck", "test"]);
});

test("local CI arguments are explicit and fail closed", () => {
  assert.deepEqual(parseArguments(["./app", "--changed-base", "origin/main", "--full-lint", "blocking", "--include-database", "--e2e-port", "43174"]), {
    root: path.resolve("./app"), changedBase: "origin/main", includeE2e: true, e2ePort: 43174, includeDatabase: true, fullLint: "blocking",
  });
  assert.equal(parseArguments(["--e2e-port", "80"]), null);
  assert.equal(parseArguments(["--full-lint", "maybe"]), null);
});
