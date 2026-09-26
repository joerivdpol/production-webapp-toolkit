import test from "node:test";
import assert from "node:assert/strict";

import { classifyCiFailure, parseArguments } from "../scripts/ci-failure-classifier.js";

test("CI failure classifier assigns stable operational categories", () => {
  assert.equal(classifyCiFailure({ step: "e2e", output: "Error: http://127.0.0.1:4173/ is already used" }).category, "RUNNER/INFRA");
  assert.equal(classifyCiFailure({ step: "Full lint", output: "prettier/prettier" }).category, "LINT");
  assert.equal(classifyCiFailure({ step: "database", output: "Supabase local verify failed" }).category, "DATABASE");
  assert.equal(classifyCiFailure({ step: "toolkit-policy", output: "hardcoded-secret-assignment" }).category, "POLICY");
  assert.equal(classifyCiFailure({ step: "unit tests", output: "AssertionError" }).category, "TEST");
  assert.equal(classifyCiFailure({ step: "typecheck", output: "TypeScript error" }).category, "CODE");
});

test("infrastructure evidence wins over an E2E step label", () => {
  const result = classifyCiFailure({ step: "playwright e2e", output: "Runner connect error: Resource temporarily unavailable" });
  assert.deepEqual(result, { category: "RUNNER/INFRA", reason: "runner, network, timeout, or port infrastructure" });
});

test("classifier arguments fail closed", () => {
  assert.deepEqual(parseArguments(["--step", "lint", "--json"]), { step: "lint", outputFile: null, json: true });
  assert.equal(parseArguments([]), null);
  assert.equal(parseArguments(["--step"]), null);
  assert.equal(parseArguments(["--wat", "lint"]), null);
});
