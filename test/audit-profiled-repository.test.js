import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  inspectProfiledRepository,
  formatProfiledAudit,
} from "../scripts/audit-profiled-repository.js";

test("routes TypeScript repositories through the webapp audit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profiled-webapp-"));

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "profiled-webapp",
      packageManager: "bun@1.3.14",
      scripts: {
        lint: "eslint .",
        typecheck: "tsc --noEmit",
        test: "node --test",
        check: "bun run typecheck && bun run test && bun run lint",
        build: "vite build",
      },
    }),
  );

  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");

  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "scripts", "lint-changed.js"), "// test\n");

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

  const result = inspectProfiledRepository(root);

  assert.equal(result.profile, "webapp");
  assert.ok(result.report);
  assert.equal(result.report.corePassed, true);
  assert.match(formatProfiledAudit(result), /Profile: webapp/);
});

test("routes Python repositories through the python-service audit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profiled-python-"));

  fs.writeFileSync(path.join(root, "service.py"), "print('ok')\n");

  fs.mkdirSync(path.join(root, "tests"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "tests", "test_service.py"),
    "import unittest\n",
  );

  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    `
jobs:
  syntax:
    steps:
      - uses: actions/setup-python@v7
        with:
          python-version: "3.12"
      - run: python -m py_compile *.py
      - run: python -m unittest discover -s tests -v
`,
  );

  const result = inspectProfiledRepository(root);

  assert.equal(result.profile, "python-service");
  assert.ok(result.report);
  assert.equal(result.report.corePassed, true);
  assert.match(formatProfiledAudit(result), /Profile: python-service/);
});

test("reports unsupported repository shapes as unknown", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profiled-unknown-"));

  fs.writeFileSync(path.join(root, "README.md"), "# Unsupported\n");

  const result = inspectProfiledRepository(root);

  assert.equal(result.profile, "unknown");
  assert.equal(result.report, null);
  assert.match(
    formatProfiledAudit(result),
    /unsupported repository profile/i,
  );
});
