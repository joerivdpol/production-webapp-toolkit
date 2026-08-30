import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  inspectPythonService,
  main,
} from "../scripts/audit-python-service.js";

/** @type {string[]} */
const fixtures = [];

function createFixture(prefix = "python-service-test-") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

function createPassingService() {
  const root = createFixture();

  fs.writeFileSync(path.join(root, "service.py"), "print('ok')\n");
  fs.mkdirSync(path.join(root, "tests"));
  fs.writeFileSync(
    path.join(root, "tests", "test_service.py"),
    "import unittest\n",
  );
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".github", "workflows", "ci.yml"),
    [
      "jobs:",
      "  quality:",
      "    steps:",
      "      - uses: actions/setup-python@v7",
      '        with: { python-version: "3.12" }',
      "      - run: python -m py_compile *.py",
      "      - run: python -m unittest discover -s tests -v",
    ].join("\n"),
  );

  return root;
}

/** @param {...string} args */
function runCli(...args) {
  /** @type {string[]} */
  const stdout = [];
  /** @type {string[]} */
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;

  console.log = (message) => stdout.push(String(message));
  console.error = (message) => stderr.push(String(message));

  try {
    return {
      status: main(args),
      stdout: stdout.join("\n"),
      stderr: stderr.join("\n"),
    };
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("python service audit", () => {
  it("audits a valid Python service through inspectPythonService", () => {
    const report = inspectPythonService(createPassingService());

    assert.equal(report.profile, "python-service");
    assert.equal(report.corePassed, true);
    assert.equal(report.requiredPassed, report.requiredTotal);
  });

  it("keeps normal CLI output human readable", () => {
    const result = runCli(createPassingService());

    assert.equal(result.status, 0);
    assert.match(result.stdout, /^Python service audit: /);
    assert.match(result.stdout, /Result: PASS/);
    assert.equal(result.stdout.trimStart().startsWith("{"), false);
  });

  it("outputs parseable JSON without a human-readable prefix in either argument order", () => {
    const root = createPassingService();

    for (const args of [["--json", root], [root, "--json"]]) {
      const result = runCli(...args);

      assert.equal(result.status, 0);
      assert.equal(result.stderr, "");
      const report = JSON.parse(result.stdout);
      assert.equal(report.profile, "python-service");
      assert.equal(report.corePassed, true);
      assert.equal(result.stdout.trimStart().startsWith("Python service audit"), false);
    }
  });

  it("returns exit code 1 and a JSON error for a missing target without an ENOENT stacktrace", () => {
    const missing = path.join(
      createFixture("python-service-missing-"),
      "does-not-exist",
    );
    const result = runCli("--json", missing);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    const error = JSON.parse(result.stderr);
    assert.deepEqual(error, {
      error: "target_not_found",
      target: path.resolve(missing),
    });
    assert.doesNotMatch(
      result.stderr,
      /Error:|ENOENT|at .*audit-python-service/,
    );
  });

  it("returns a human-readable error for a missing target without JSON mode", () => {
    const missing = path.join(
      createFixture("python-service-missing-human-"),
      "does-not-exist",
    );
    const result = runCli(missing);

    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(
      result.stderr,
      /Python service audit failed: target does not exist:/,
    );
    assert.ok(result.stderr.includes(path.resolve(missing)));
    assert.doesNotMatch(result.stderr, /ENOENT/);
    assert.doesNotMatch(result.stderr, /Error:|at .*audit-python-service/);
  });

  it("returns exit code 1 for an existing Python repository missing required checks, including JSON mode", () => {
    const root = createFixture("python-service-incomplete-");
    fs.writeFileSync(path.join(root, "service.py"), "print('incomplete')\n");

    const result = runCli(root, "--json");

    assert.equal(result.status, 1);
    assert.equal(result.stderr, "");
    const report = JSON.parse(result.stdout);
    assert.equal(report.profile, "python-service");
    assert.equal(report.corePassed, false);
    assert.ok(
      report.checks.some(
        /** @param {{required: boolean, passed: boolean}} check */
        (check) => check.required && !check.passed,
      ),
    );
  });
});
