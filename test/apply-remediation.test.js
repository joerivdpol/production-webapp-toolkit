import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applySafeRemediation } from "../scripts/apply-remediation.js";

function createBaseRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-remediation-"));

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        name: "apply-remediation-test",
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

  return root;
}

test("dry-run reports safe remediation without writing files", () => {
  const root = createBaseRepository();

  const destination = path.join(root, "scripts", "lint-changed.js");
  const result = applySafeRemediation(root, { dryRun: true });

  assert.equal(fs.existsSync(destination), false);
  assert.deepEqual(
    result.actions.map((action) => ({
      id: action.id,
      action: action.action,
    })),
    [
      {
        id: "changed-lint-script",
        action: "create",
      },
    ],
  );
});

test("apply creates the toolkit-owned changed-files lint engine", () => {
  const root = createBaseRepository();

  const destination = path.join(root, "scripts", "lint-changed.js");

  const result = applySafeRemediation(root);

  assert.equal(fs.existsSync(destination), true);
  assert.equal(result.actions.length, 1);

  const action = result.actions[0];
  assert.ok(action);
  assert.equal(action.id, "changed-lint-script");
  assert.equal(action.action, "create");

  const toolkitSource = fs.readFileSync(
    path.resolve("scripts/lint-changed.js"),
    "utf8",
  );

  assert.equal(
    fs.readFileSync(destination, "utf8"),
    toolkitSource,
  );
});

test("apply never overwrites an existing changed-files lint engine", () => {
  const root = createBaseRepository();

  const scriptsDir = path.join(root, "scripts");
  const destination = path.join(scriptsDir, "lint-changed.js");

  fs.mkdirSync(scriptsDir, { recursive: true });

  const existing = "// repository-specific lint-changed implementation\n";
  fs.writeFileSync(destination, existing);

  const result = applySafeRemediation(root);

  assert.equal(
    fs.readFileSync(destination, "utf8"),
    existing,
  );

  assert.equal(
    result.actions.find((action) => action.id === "changed-lint-script"),
    undefined,
  );
});

test("manual remediation is reported but never applied", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "apply-manual-"));

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "apply-manual-test",
      packageManager: "bun@1.3.14",
    }),
  );

  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");

  const packageBefore = fs.readFileSync(path.join(root, "package.json"), "utf8");

  const result = applySafeRemediation(root);

  assert.ok(result.manualRemaining > 0);

  assert.equal(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
    packageBefore,
  );

  assert.equal(
    fs.existsSync(path.join(root, ".github", "workflows")),
    false,
  );
});

test("safe remediation is idempotent after the first apply", () => {
  const root = createBaseRepository();

  const first = applySafeRemediation(root);

  assert.equal(first.actions.length, 1);

  const destination = path.join(root, "scripts", "lint-changed.js");
  const firstContent = fs.readFileSync(destination, "utf8");

  const second = applySafeRemediation(root);

  assert.equal(second.actions.length, 0);
  assert.equal(
    fs.readFileSync(destination, "utf8"),
    firstContent,
  );
});
