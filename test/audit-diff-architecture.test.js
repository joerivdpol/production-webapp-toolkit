import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  formatDiffArchitecture,
  inspectDiffArchitecture,
  main,
  validateDiffArchitecturePolicy,
} from "../scripts/audit-diff-architecture.js";
import { validateRepositoryManifest } from "../scripts/repository-manifest.js";

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "diff-architecture-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Toolkit Test"]);
  fs.mkdirSync(path.join(root, "src/ui"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/payments"), { recursive: true });
  fs.mkdirSync(path.join(root, "infra"), { recursive: true });
  return root;
}
/** @param {string[]} [capabilities] @returns {any} */
function rawManifest(capabilities = []) {
  return {
    version: 1,
    repository: { id: "example-webapp" },
    profile: "webapp",
    runtime: { type: "node" },
    database: null,
    capabilities,
    checks: { required: ["repository-quality"], advisory: [] },
  };
}

/** @param {string[]} [capabilities] */
function manifest(capabilities = []) {
  const result = validateRepositoryManifest(rawManifest(capabilities));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.manifest) throw new Error("manifest invalid");
  return result.manifest;
}

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    repository: "example-webapp",
    packs: [
      {
        id: "webapp-client-boundaries",
        match: { profiles: ["webapp"] },
        rules: [
          {
            id: "ui-no-database-client",
            type: "forbid-import",
            paths: ["src/ui/**"],
            modules: ["@database/**"],
            severity: "FAIL",
          },
        ],
      },      {
        id: "payment-canonical-imports",
        match: { capabilities: ["payments"] },
        rules: [
          {
            id: "payment-requires-canonical-pricing",
            type: "require-import",
            paths: ["src/payments/**"],
            modules: ["@canonical/pricing"],
            severity: "FAIL",
          },
        ],
      },
      {
        id: "infra-protection",
        match: { capabilities: ["infrastructure"] },
        rules: [
          {
            id: "infra-change-review",
            type: "forbid-change",
            paths: ["infra/**"],
            severity: "WARN",
          },
        ],
      },
    ],
  };
}

function policy(value = rawPolicy()) {
  const result = validateDiffArchitecturePolicy(value);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) throw new Error("policy invalid");
  return result.policy;
}

/** @param {string} root @param {string} message */
function commitAll(root, message) {
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

test("validates private manifest-driven architecture packs", () => {
  const result = validateDiffArchitecturePolicy(rawPolicy());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) return;
  assert.deepEqual(result.policy.packs.map((item) => item.id), [
    "infra-protection",
    "payment-canonical-imports",
    "webapp-client-boundaries",
  ]);
});

test("policy rejects empty selectors duplicate rule ids unsafe paths and malformed module rules", () => {
  const empty = rawPolicy();
  empty.packs[0].match = { profiles: [], capabilities: [] };
  assert.equal(validateDiffArchitecturePolicy(empty).valid, false);

  const duplicate = rawPolicy();
  duplicate.packs[1].rules[0].id = duplicate.packs[0].rules[0].id;
  assert.equal(validateDiffArchitecturePolicy(duplicate).valid, false);

  const unsafe = rawPolicy();
  unsafe.packs[0].rules[0].paths = ["../src/**"];
  assert.equal(validateDiffArchitecturePolicy(unsafe).valid, false);

  const modules = rawPolicy();
  delete modules.packs[0].rules[0].modules;
  assert.equal(validateDiffArchitecturePolicy(modules).valid, false);
});

test("unchanged legacy forbidden imports do not block a clean changed file", () => {
  const root = repository();
  fs.writeFileSync(path.join(root, "src/ui/legacy.ts"), 'import db from "@database/client";\nexport { db };\n');
  fs.writeFileSync(path.join(root, "src/ui/page.ts"), 'import React from "react";\nexport const page = React;\n');
  const base = commitAll(root, "base");
  fs.writeFileSync(path.join(root, "src/ui/page.ts"), 'import React from "react";\nexport const page = { React };\n');
  const head = commitAll(root, "safe UI change");

  const report = inspectDiffArchitecture(root, manifest(), policy(), base, head);
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.selectedPacks, ["webapp-client-boundaries"]);
  assert.equal(report.checks.some((item) => item.file === "src/ui/legacy.ts"), false);
  assert.equal(report.checks.some((item) => item.file === "src/ui/page.ts" && item.id === "architecture-import-rule-pass"), true);
  assert.match(report.semantics, /unchanged legacy files are not evaluated/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("new forbidden import in a changed file is blocking", () => {
  const root = repository();
  fs.writeFileSync(path.join(root, "src/ui/page.ts"), 'import React from "react";\n');
  const base = commitAll(root, "base");
  fs.writeFileSync(path.join(root, "src/ui/page.ts"), 'import db from "@database/client";\nexport default db;\n');
  const head = commitAll(root, "forbidden import");

  const report = inspectDiffArchitecture(root, manifest(), policy(), base, head);
  assert.equal(report.overallStatus, "FAIL");
  const finding = report.checks.find((item) => item.id === "architecture-forbidden-import");
  assert.equal(finding?.file, "src/ui/page.ts");
  assert.match(finding?.detail ?? "", /@database\/client/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("payment capability selects private pack and requires canonical import", () => {
  const root = repository();
  fs.writeFileSync(path.join(root, "src/payments/create.ts"), 'export function createPayment() { return true; }\n');
  const base = commitAll(root, "base");
  fs.writeFileSync(path.join(root, "src/payments/create.ts"), 'export function createPayment() { return false; }\n');
  const head = commitAll(root, "payment change");

  const report = inspectDiffArchitecture(root, manifest(["payments"]), policy(), base, head);
  assert.equal(report.selectedPacks.includes("payment-canonical-imports"), true);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "architecture-required-import-missing"), true);

  fs.writeFileSync(path.join(root, "src/payments/create.ts"), 'import { price } from "@canonical/pricing";\nexport const createPayment = () => price;\n');
  const passingHead = commitAll(root, "canonical payment import");
  const passing = inspectDiffArchitecture(root, manifest(["payments"]), policy(), head, passingHead);
  assert.equal(passing.overallStatus, "PASS");
  fs.rmSync(root, { recursive: true, force: true });
});

test("forbid-change evaluates deletions while import rules treat deletion as non-violating", () => {
  const root = repository();
  fs.writeFileSync(path.join(root, "src/ui/old.ts"), 'import db from "@database/client";\n');
  fs.writeFileSync(path.join(root, "infra/worker.yml"), "name: worker\n");
  const base = commitAll(root, "base");
  fs.rmSync(path.join(root, "src/ui/old.ts"));
  fs.rmSync(path.join(root, "infra/worker.yml"));
  const head = commitAll(root, "delete files");

  const report = inspectDiffArchitecture(root, manifest(["infrastructure"]), policy(), base, head);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "architecture-import-rule-deletion-only"), true);
  assert.equal(report.checks.some((item) => item.id === "architecture-change-forbidden" && item.file === "infra/worker.yml" && item.status === "WARN"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("dynamic import export-from and require calls are structural import evidence", () => {
  const root = repository();
  fs.writeFileSync(path.join(root, "src/ui/module.ts"), "export const x = 1;\n");
  const base = commitAll(root, "base");
  fs.writeFileSync(path.join(root, "src/ui/module.ts"), [
    'export { thing } from "@database/exported";',
    'const lazy = import("@database/dynamic");',
    'const common = require("@database/common");',
    "export { lazy, common };",
  ].join("\n"));
  const head = commitAll(root, "multiple import forms");
  const report = inspectDiffArchitecture(root, manifest(), policy(), base, head);
  const finding = report.checks.find((item) => item.id === "architecture-forbidden-import");
  assert.ok(finding);
  assert.match(finding.detail, /@database\/common/);
  assert.match(finding.detail, /@database\/dynamic/);
  assert.match(finding.detail, /@database\/exported/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("selected rule with no matching changed files reports not applicable PASS", () => {
  const root = repository();
  fs.writeFileSync(path.join(root, "README.md"), "one\n");
  const base = commitAll(root, "base");
  fs.writeFileSync(path.join(root, "README.md"), "two\n");
  const head = commitAll(root, "docs only");
  const report = inspectDiffArchitecture(root, manifest(), policy(), base, head);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks.some((item) => item.id === "architecture-rule-not-applicable"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("policy repository identity and commit identity fail closed", () => {
  const root = repository();
  fs.writeFileSync(path.join(root, "README.md"), "base\n");
  const base = commitAll(root, "base");
  fs.writeFileSync(path.join(root, "README.md"), "head\n");
  const head = commitAll(root, "head");

  const wrongPolicy = rawPolicy();
  wrongPolicy.repository = "other-repository";
  assert.throws(
    () => inspectDiffArchitecture(root, manifest(), policy(wrongPolicy), base, head),
    /repository identity/,
  );
  assert.throws(
    () => inspectDiffArchitecture(root, manifest(), policy(), "abc", head),
    /distinct full Git object ids/,
  );
  assert.throws(
    () => inspectDiffArchitecture(root, manifest(), policy(), head, head),
    /distinct full Git object ids/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("import rules fail closed when private policy targets non-source files", () => {
  const root = repository();
  fs.writeFileSync(path.join(root, "src/ui/config.json"), "{}\n");
  const base = commitAll(root, "base");
  fs.writeFileSync(path.join(root, "src/ui/config.json"), '{"changed":true}\n');
  const head = commitAll(root, "config change");
  const report = inspectDiffArchitecture(root, manifest(), policy(), base, head);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "architecture-source-unsupported"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("human output reports private rule ids without source payloads", () => {
  const root = repository();
  const marker = "PRIVATE_ARCH_PAYLOAD_991";
  fs.writeFileSync(path.join(root, "src/ui/page.ts"), "export const x = 1;\n");
  const base = commitAll(root, "base");
  fs.writeFileSync(path.join(root, "src/ui/page.ts"), `import value from "@database/${marker}";\nexport default value;\n`);
  const head = commitAll(root, "architecture violation");
  const output = formatDiffArchitecture(inspectDiffArchitecture(root, manifest(), policy(), base, head));
  assert.match(output, /ui-no-database-client/);
  assert.match(output, /architecture-forbidden-import/);
  assert.doesNotMatch(output, new RegExp(`export default value`));
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI composes explicit manifest private policy and commit-bound Git evidence", () => {
  const root = repository();
  fs.writeFileSync(path.join(root, "src/ui/page.ts"), "export const x = 1;\n");
  const base = commitAll(root, "base");
  fs.writeFileSync(path.join(root, "src/ui/page.ts"), "export const x = 2;\n");
  const head = commitAll(root, "head");
  const manifestFile = tempJson("diff-architecture-manifest", rawManifest());
  const policyFile = tempJson("diff-architecture-policy", rawPolicy());
  const original = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["--root", root, "--manifest", manifestFile, "--policy", policyFile, "--base-commit", base, "--head-commit", head, "--json"]), 0);
  } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).source.headCommit, head);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(manifestFile, { force: true });
  fs.rmSync(policyFile, { force: true });
});

test("CLI rejects malformed inputs and audit operational surface is read-only Git", () => {
  const malformed = tempJson("diff-architecture-bad", "{");
  assert.equal(main(["--unknown"]), 1);
  assert.equal(main(["--root", "/tmp/missing", "--manifest", malformed, "--policy", malformed, "--base-commit", "a".repeat(40), "--head-commit", "b".repeat(40)]), 1);
  fs.rmSync(malformed, { force: true });

  const source = fs.readFileSync(new URL("../scripts/audit-diff-architecture.js", import.meta.url), "utf8");
  assert.match(source, /spawnSync\("git"/);
  assert.doesNotMatch(source, /\bfetch\s*\(|process\.env|writeFile|copyFile|rmSync|unlinkSync/);
  assert.match(source, /\["diff", "--name-status"/);
  assert.match(source, /\["show", `\$\{commit\}:\$\{file\}`\]/);
});

test("malformed changed source fails closed instead of appearing import-safe", () => {
  const root = repository();
  fs.writeFileSync(path.join(root, "src/ui/page.ts"), "export const x = 1;\n");
  const base = commitAll(root, "base");
  fs.writeFileSync(path.join(root, "src/ui/page.ts"), 'import value from "@database/client";\nexport const broken = {\n');
  const head = commitAll(root, "malformed source");
  assert.throws(
    () => inspectDiffArchitecture(root, manifest(), policy(), base, head),
    /cannot be parsed safely/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});