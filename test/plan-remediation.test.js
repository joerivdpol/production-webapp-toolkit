import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  planRemediation,
  formatRemediationPlan,
} from "../scripts/plan-remediation.js";

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remediation-test-"));

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "remediation-test",
        packageManager: "bun@1.3.14",
        scripts: {
          lint: "eslint .",
          typecheck: "tsc --noEmit",
          test: "node --test",
          check: "bun run typecheck && bun run test && bun run lint",
          build: "vite build",
        },
      },
      null,
      2,
    ),
  );

  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");

  return root;
}

test("classifies the toolkit-owned changed-lint engine as safe remediation", () => {
  const root = createRepository();

  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    `
jobs:
  quality:
    steps:
      - run: bun run typecheck
      - run: bun run test
      - run: bun run lint:changed
      - run: bun run build
`,
  );

  const plan = planRemediation(root);

  assert.deepEqual(
    plan.items.map((item) => ({
      id: item.id,
      remediation: item.remediation,
    })),
    [
      {
        id: "changed-lint-script",
        remediation: "safe",
      },
    ],
  );
});

test("keeps repository-specific scripts and CI as manual remediation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remediation-manual-"));

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "remediation-manual-test",
      packageManager: "bun@1.3.14",
    }),
  );

  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");

  const plan = planRemediation(root);

  assert.equal(
    plan.items.find((item) => item.id === "changed-lint-script")?.remediation,
    "safe",
  );

  for (const id of [
    "lint-script",
    "typecheck-script",
    "test-script",
    "check-script",
    "github-ci",
    "ci-typecheck",
    "ci-tests",
    "ci-changed-lint",
    "ci-build",
  ]) {
    assert.equal(
      plan.items.find((item) => item.id === id)?.remediation,
      "manual",
      `${id} should require manual remediation`,
    );
  }
});

test("formats a clean repository as requiring no remediation", () => {
  const plan = {
    report: {
      root: "/tmp/example",
      checks: [],
      passed: 0,
      requiredPassed: 0,
      requiredTotal: 0,
      corePassed: true,
    },
    items: [],
  };

  assert.equal(
    formatRemediationPlan(plan),
    "Remediation plan: /tmp/example\n\nNo required remediation needed.",
  );
});
