import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { applySafeRemediation, isSafeAutofixEligible } from "../scripts/apply-remediation.js";

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


test("safe autofix eligibility requires every low-risk toolkit guard", () => {
  const eligible = {
    id: "changed-lint-script",
    remediation: "safe",
    automatic: true,
    risk: "LOW",
    ownership: "toolkit",
    validation: { checks: ["changed-lint-script"], commands: [] },
  };

  assert.equal(isSafeAutofixEligible(eligible), true);
  assert.equal(isSafeAutofixEligible({ ...eligible, automatic: false }), false);
  assert.equal(isSafeAutofixEligible({ ...eligible, risk: "MEDIUM" }), false);
  assert.equal(isSafeAutofixEligible({ ...eligible, ownership: "repository" }), false);
  assert.equal(isSafeAutofixEligible({ ...eligible, id: "ci-build" }), false);
  assert.equal(
    isSafeAutofixEligible({ ...eligible, validation: { checks: [], commands: [] } }),
    false,
  );
});

test("dry-run exposes deterministic low-risk action metadata without writes", () => {
  const root = createBaseRepository();
  const result = applySafeRemediation(root, { dryRun: true });
  const action = result.actions[0];

  assert.equal(result.version, 1);
  assert.ok(action);
  assert.equal(action.relativePath, "scripts/lint-changed.js");
  assert.equal(action.risk, "LOW");
  assert.match(action.sourceSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(action.validationChecks, ["changed-lint-script"]);
  assert.deepEqual(result.validation, { performed: false, passed: true, checks: [] });
  assert.equal(fs.existsSync(path.join(root, action.relativePath)), false);
});

test("applied autofix verifies copied content and clears its canonical finding", () => {
  const root = createBaseRepository();
  const result = applySafeRemediation(root);
  const action = result.actions[0];

  assert.ok(action);
  assert.equal(result.validation.performed, true);
  assert.equal(result.validation.passed, true);
  assert.deepEqual(result.validation.checks, [
    { id: "changed-lint-script", passed: true },
  ]);
  assert.equal(
    fs.readFileSync(path.join(root, action.relativePath), "utf8"),
    fs.readFileSync(path.resolve("scripts/lint-changed.js"), "utf8"),
  );
});

test("safe autofix refuses a symlinked repository root", () => {
  const root = createBaseRepository();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-root-link-"));
  const linkedRoot = path.join(parent, "repository");
  fs.symlinkSync(root, linkedRoot, "dir");

  assert.throws(
    () => applySafeRemediation(linkedRoot),
    /regular directory, not a symlink/,
  );
  assert.equal(fs.existsSync(path.join(root, "scripts", "lint-changed.js")), false);
});

test("safe autofix refuses a symlinked parent and never writes outside the repository", () => {
  const root = createBaseRepository();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-outside-"));
  fs.symlinkSync(outside, path.join(root, "scripts"), "dir");

  assert.throws(
    () => applySafeRemediation(root),
    /symlink parent/,
  );
  assert.equal(fs.existsSync(path.join(outside, "lint-changed.js")), false);
});

test("existing destination remains untouched and produces no autofix action", () => {
  const root = createBaseRepository();
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  const destination = path.join(root, "scripts", "lint-changed.js");
  const existing = "// repository owned implementation\n";
  fs.writeFileSync(destination, existing);

  const result = applySafeRemediation(root);

  assert.equal(result.actions.length, 0);
  assert.equal(fs.readFileSync(destination, "utf8"), existing);
});

test("dry-run refuses dangling symlink destinations instead of reporting a create", () => {
  const root = createBaseRepository();
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  const destination = path.join(root, "scripts", "lint-changed.js");
  const missingTarget = path.join(root, "missing-toolkit-target.js");
  fs.symlinkSync(missingTarget, destination);

  assert.throws(
    () => applySafeRemediation(root, { dryRun: true }),
    /refuses to overwrite an existing destination/,
  );
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
});