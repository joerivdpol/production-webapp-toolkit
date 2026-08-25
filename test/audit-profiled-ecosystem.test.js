import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  inspectProfiledEcosystem,
  formatProfiledEcosystem,
} from "../scripts/audit-profiled-ecosystem.js";

function createPassingWebapp() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ecosystem-webapp-"));

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "ecosystem-webapp",
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

  return root;
}

function createPassingPythonService() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ecosystem-python-"));

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

  return root;
}

test("aggregates webapp and python-service repositories", () => {
  const webapp = createPassingWebapp();
  const pythonService = createPassingPythonService();

  const report = inspectProfiledEcosystem([
    webapp,
    pythonService,
  ]);

  assert.equal(report.summary.repositories, 2);
  assert.equal(report.summary.webapps, 1);
  assert.equal(report.summary.pythonServices, 1);
  assert.equal(report.summary.unknown, 0);
  assert.equal(report.summary.corePassed, 2);
  assert.equal(report.summary.coreFailed, 0);

  assert.equal(report.summary.requiredPassed, 20);
  assert.equal(report.summary.requiredTotal, 20);

  assert.match(
    formatProfiledEcosystem(report),
    /1 webapp, 1 python-service, 0 unknown/,
  );
});

test("marks unknown repositories as core failures", () => {
  const unsupported = fs.mkdtempSync(
    path.join(os.tmpdir(), "ecosystem-unknown-"),
  );

  fs.writeFileSync(
    path.join(unsupported, "README.md"),
    "# Unsupported\n",
  );

  const report = inspectProfiledEcosystem([unsupported]);

  assert.equal(report.summary.repositories, 1);
  assert.equal(report.summary.unknown, 1);
  assert.equal(report.summary.corePassed, 0);
  assert.equal(report.summary.coreFailed, 1);

  assert.equal(report.repositories[0]?.profile, "unknown");
  assert.equal(report.repositories[0]?.corePassed, false);
});

test("aggregate check totals equal the repository totals", () => {
  const webapp = createPassingWebapp();
  const pythonService = createPassingPythonService();

  const report = inspectProfiledEcosystem([
    webapp,
    pythonService,
  ]);

  assert.equal(
    report.summary.passedChecks,
    report.repositories.reduce((sum, repo) => sum + repo.passed, 0),
  );

  assert.equal(
    report.summary.totalChecks,
    report.repositories.reduce((sum, repo) => sum + repo.total, 0),
  );
});
