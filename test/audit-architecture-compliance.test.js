import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  loadArchitecturePolicy,
  inspectArchitectureCompliance,
  formatArchitectureCompliance,
} from "../scripts/audit-architecture-compliance.js";

function createRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "architecture-policy-"));

  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "src", "client.js"),
    'export const source = "central-contract";\n',
  );
  fs.writeFileSync(
    path.join(root, "README.md"),
    "# Example repository\n",
  );

  return root;
}

test("require-file passes when the required file exists", () => {
  const root = createRepository();

  const report = inspectArchitectureCompliance({
    version: 1,
    repositories: [
      {
        name: "example",
        path: root,
        rules: [
          {
            id: "require-readme",
            type: "require-file",
            path: "README.md",
          },
        ],
      },
    ],
  });

  assert.equal(report.summary.failed, 0);
  assert.equal(report.results[0]?.passed, true);
});

test("forbid-file reports only the violating file path", () => {
  const root = createRepository();

  fs.writeFileSync(
    path.join(root, "local-truth.json"),
    "{}\n",
  );

  const report = inspectArchitectureCompliance({
    version: 1,
    repositories: [
      {
        name: "example",
        path: root,
        rules: [
          {
            id: "forbid-local-truth",
            type: "forbid-file",
            path: "local-truth.json",
          },
        ],
      },
    ],
  });

  assert.equal(report.summary.failed, 1);
  assert.deepEqual(report.results[0]?.files, ["local-truth.json"]);
});

test("require-pattern checks scoped source files", () => {
  const root = createRepository();

  const report = inspectArchitectureCompliance({
    version: 1,
    repositories: [
      {
        name: "example",
        path: root,
        rules: [
          {
            id: "require-central-contract",
            type: "require-pattern",
            include: ["src"],
            pattern: "central-contract",
          },
        ],
      },
    ],
  });

  assert.equal(report.summary.failed, 0);
  assert.equal(report.results[0]?.passed, true);
});

test("forbid-pattern reports filenames but not matching content", () => {
  const root = createRepository();

  const forbiddenValue = ["local", "business", "truth"].join("-");
  fs.writeFileSync(
    path.join(root, "src", "legacy.js"),
    `export const source = ${JSON.stringify(forbiddenValue)};\n`,
  );

  const report = inspectArchitectureCompliance({
    version: 1,
    repositories: [
      {
        name: "example",
        path: root,
        rules: [
          {
            id: "forbid-local-source",
            type: "forbid-pattern",
            include: ["src"],
            pattern: forbiddenValue,
          },
        ],
      },
    ],
  });

  assert.equal(report.summary.failed, 1);
  assert.deepEqual(report.results[0]?.files, ["src/legacy.js"]);

  const formatted = formatArchitectureCompliance(report);

  assert.equal(formatted.includes(forbiddenValue), false);
});

test("loads a version 1 policy and rejects unsupported policies", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "architecture-policy-file-"),
  );

  const validPath = path.join(directory, "policy.json");
  fs.writeFileSync(
    validPath,
    JSON.stringify({
      version: 1,
      repositories: [],
    }),
  );

  assert.equal(loadArchitecturePolicy(validPath).version, 1);

  const invalidPath = path.join(directory, "invalid.json");
  fs.writeFileSync(
    invalidPath,
    JSON.stringify({
      version: 2,
      repositories: [],
    }),
  );

  assert.throws(
    () => loadArchitecturePolicy(invalidPath),
    /Unsupported or invalid architecture policy/,
  );
});

test("CLI supports private policy files and JSON output", () => {
  const root = createRepository();
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "architecture-cli-"),
  );

  const policyPath = path.join(directory, "policy.json");

  fs.writeFileSync(
    policyPath,
    JSON.stringify({
      version: 1,
      repositories: [
        {
          name: "example",
          path: root,
          rules: [
            {
              id: "require-readme",
              type: "require-file",
              path: "README.md",
            },
          ],
        },
      ],
    }),
  );

  const output = execFileSync(
    "node",
    [
      path.resolve("scripts/audit-architecture-compliance.js"),
      "--policy",
      policyPath,
      "--json",
    ],
    { encoding: "utf8" },
  );

  const parsed = JSON.parse(output);

  assert.equal(parsed.summary.repositories, 1);
  assert.equal(parsed.summary.rules, 1);
  assert.equal(parsed.summary.failed, 0);
});
