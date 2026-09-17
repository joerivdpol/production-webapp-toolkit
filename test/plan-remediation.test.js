import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

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

  const item = plan.items[0];
  assert.ok(item);
  assert.equal(plan.version, 1);
  assert.equal(item.automatic, true);
  assert.equal(item.risk, "LOW");
  assert.equal(item.ownership, "toolkit");
  assert.deepEqual(item.files, ["scripts/lint-changed.js"]);
  assert.deepEqual(item.validation, { checks: ["changed-lint-script"], commands: [] });
  assert.deepEqual(plan.summary.risk, { low: 1, medium: 0, high: 0 });
  assert.deepEqual(plan.summary.ownership, { toolkit: 1, repository: 0 });
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
    const item = plan.items.find((candidate) => candidate.id === id);
    assert.equal(item?.remediation, "manual", `${id} should require manual remediation`);
    assert.equal(item?.automatic, false);
    assert.equal(item?.risk, "MEDIUM");
    assert.equal(item?.ownership, "repository");
    assert.deepEqual(item?.validation, { checks: [id], commands: [] });
  }

  assert.deepEqual(
    plan.items.find((item) => item.id === "lint-script")?.files,
    ["package.json"],
  );
  assert.deepEqual(
    plan.items.find((item) => item.id === "ci-build")?.files,
    [".github/workflows/*.yml", ".github/workflows/*.yaml"],
  );
});

test("unknown deterministic remediation stays high risk and does not invent file changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remediation-unknown-"));
  const plan = planRemediation(root);
  const item = plan.items.find((candidate) => candidate.id === "package-json");

  assert.ok(item);
  assert.equal(item.remediation, "manual");
  assert.equal(item.automatic, false);
  assert.equal(item.risk, "HIGH");
  assert.equal(item.ownership, "repository");
  assert.deepEqual(item.files, []);
  assert.deepEqual(item.validation, { checks: ["package-json"], commands: [] });
});

test("formats a clean repository as requiring no remediation", () => {
  const plan = {
    version: 1,
    report: {
      root: "/tmp/example",
      checks: [],
      passed: 0,
      requiredPassed: 0,
      requiredTotal: 0,
      corePassed: true,
    },
    items: [],
    summary: {
      total: 0,
      safe: 0,
      manual: 0,
      risk: { low: 0, medium: 0, high: 0 },
      ownership: { toolkit: 0, repository: 0 },
    },
  };

  assert.equal(
    formatRemediationPlan(plan),
    "Remediation plan: /tmp/example\n\nNo required remediation needed.",
  );
});

test("CLI produces machine-readable JSON output", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "remediation-json-"));

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "remediation-json-test",
      packageManager: "bun@1.3.14",
    }),
  );

  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");

  const output = execFileSync(
    "node",
    [
      path.resolve("scripts/plan-remediation.js"),
      root,
      "--json",
    ],
    { encoding: "utf8" },
  );

  /** @type {ReturnType<typeof planRemediation>} */
  const parsed = JSON.parse(output);

  assert.equal(parsed.version, 1);
  assert.equal(parsed.report.root, root);
  assert.equal(parsed.summary.total, parsed.items.length);
  assert.equal(parsed.summary.risk.low + parsed.summary.risk.medium + parsed.summary.risk.high, parsed.items.length);
  assert.equal(parsed.summary.ownership.toolkit + parsed.summary.ownership.repository, parsed.items.length);
  assert.equal(parsed.items.every((item) => item.automatic === (item.remediation === "safe")), true);
  assert.equal(
    parsed.summary.safe,
    parsed.items.filter((item) => item.remediation === "safe").length,
  );
  assert.equal(
    parsed.summary.manual,
    parsed.items.filter((item) => item.remediation === "manual").length,
  );
});
