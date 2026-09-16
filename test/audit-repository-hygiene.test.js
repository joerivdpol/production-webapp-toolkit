import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  formatRepositoryHygiene,
  inspectRepositoryHygiene,
  main,
  validateRepositoryHygienePolicy,
} from "../scripts/audit-repository-hygiene.js";

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    staleConfigPatterns: ["old/**", "*.legacy.config.js"],
    exclusiveConfigGroups: [{ id: "eslint", paths: ["eslint.config.js", ".eslintrc.json"] }],
    generatedArtifactPatterns: ["dist/**", "coverage/**", "*.generated.js"],
    generatedArtifactAllowlist: ["fixtures/**"],
    workflowRoots: [".github/workflows"],
    maxTrackedFileBytes: 64,
    oversizedAllowlist: ["fixtures/large.bin"],
    severity: {
      staleConfig: "WARN",
      duplicateConfig: "FAIL",
      generatedArtifact: "FAIL",
      duplicateWorkflow: "WARN",
      oversizedFile: "FAIL",
      workflowInspection: "WARN",
    },
  };
}

function policy() {
  const result = validateRepositoryHygienePolicy(rawPolicy());
  assert.equal(result.valid, true);
  if (!result.valid || !result.policy) throw new Error("fixture policy invalid");
  return result.policy;
}

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "repository-hygiene-"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  return root;
}

/** @param {string} root @param {string} file @param {string|Buffer} content */
function tracked(root, file, content = "fixture\n") {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  assert.equal(spawnSync("git", ["add", "--", file], { cwd: root }).status, 0);
}

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `repository-hygiene-policy-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("validates an explicit repository hygiene policy", () => {
  const result = validateRepositoryHygienePolicy(rawPolicy());
  assert.equal(result.valid, true);
  if (!result.valid || !result.policy) return;
  assert.deepEqual(result.policy.workflowRoots, [".github/workflows"]);
  assert.equal(result.policy.maxTrackedFileBytes, 64);
});

test("policy rejects unsafe paths, duplicate groups, invalid severities, and unknown fields", () => {
  const unsafe = rawPolicy();
  unsafe.generatedArtifactPatterns = ["../dist/**"];
  assert.equal(validateRepositoryHygienePolicy(unsafe).valid, false);

  const duplicate = rawPolicy();
  duplicate.exclusiveConfigGroups.push(structuredClone(duplicate.exclusiveConfigGroups[0]));
  assert.equal(validateRepositoryHygienePolicy(duplicate).valid, false);

  const severity = rawPolicy();
  severity.severity.staleConfig = "PASS";
  assert.equal(validateRepositoryHygienePolicy(severity).valid, false);

  const unknown = rawPolicy();
  unknown.autoDelete = true;
  assert.equal(validateRepositoryHygienePolicy(unknown).valid, false);
});

test("clean configured repository passes", () => {
  const root = tempRepo();
  tracked(root, "src/index.ts", "export const value = 1;\n");
  tracked(root, "eslint.config.js", "export default [];\n");
  const report = inspectRepositoryHygiene(root, policy());
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks[0]?.id, "repository-hygiene-clean");
  fs.rmSync(root, { recursive: true, force: true });
});

test("stale configuration follows configured warning severity", () => {
  const root = tempRepo();
  tracked(root, "old/webpack.config.js");
  const report = inspectRepositoryHygiene(root, policy());
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "stale-config" && item.file === "old/webpack.config.js"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("exclusive configuration variants fail when more than one is tracked", () => {
  const root = tempRepo();
  tracked(root, "eslint.config.js");
  tracked(root, ".eslintrc.json", "{}\n");
  const report = inspectRepositoryHygiene(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "duplicate-config" && /eslint/.test(item.detail)), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("generated artifacts are blocking unless explicitly allowlisted", () => {
  const root = tempRepo();
  tracked(root, "dist/app.js");
  tracked(root, "fixtures/output.generated.js");
  const report = inspectRepositoryHygiene(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "generated-artifact-tracked" && item.file === "dist/app.js"), true);
  assert.equal(report.checks.some((item) => item.file === "fixtures/output.generated.js"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("oversized tracked files fail while explicit allowlist stays permitted", () => {
  const root = tempRepo();
  tracked(root, "assets/huge.bin", Buffer.alloc(65, 1));
  tracked(root, "fixtures/large.bin", Buffer.alloc(128, 2));
  const report = inspectRepositoryHygiene(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "oversized-tracked-file" && item.file === "assets/huge.bin"), true);
  assert.equal(report.checks.some((item) => item.file === "fixtures/large.bin"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("duplicate workflow names are visible without parsing arbitrary YAML", () => {
  const root = tempRepo();
  tracked(root, ".github/workflows/a.yml", "name: CI\non: push\n");
  tracked(root, ".github/workflows/b.yaml", "name: CI\non: pull_request\n");
  const report = inspectRepositoryHygiene(root, policy());
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "duplicate-workflow-name" && /CI/.test(item.detail)), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("identical unnamed workflow content is detected by bounded content hash", () => {
  const root = tempRepo();
  const content = "on: workflow_dispatch\njobs: {}\n";
  tracked(root, ".github/workflows/a.yml", content);
  tracked(root, ".github/workflows/b.yml", content);
  const report = inspectRepositoryHygiene(root, policy());
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "duplicate-workflow-content"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("tracked workflow symlinks are never followed and remain explicit warnings", () => {
  const root = tempRepo();
  const outside = path.join(os.tmpdir(), `workflow-outside-${process.pid}.yml`);
  fs.writeFileSync(outside, "name: Outside\n");
  fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, ".github/workflows/link.yml"));
  assert.equal(spawnSync("git", ["add", "--", ".github/workflows/link.yml"], { cwd: root }).status, 0);
  const report = inspectRepositoryHygiene(root, policy());
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "workflow-uninspectable"), true);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

test("formatter exposes paths and findings without file contents", () => {
  const root = tempRepo();
  tracked(root, "dist/secret.generated.js", "DO_NOT_PRINT_THIS_PAYLOAD\n");
  const text = formatRepositoryHygiene(inspectRepositoryHygiene(root, policy()));
  assert.match(text, /dist\/secret\.generated\.js/);
  assert.match(text, /Overall: FAIL/);
  assert.doesNotMatch(text, /DO_NOT_PRINT_THIS_PAYLOAD/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI emits JSON, preserves repository content, and uses FAIL exit semantics", () => {
  const root = tempRepo();
  tracked(root, "dist/app.js", "tracked generated artifact\n");
  const policyFile = tempJson(rawPolicy());
  const before = fs.readFileSync(path.join(root, "dist/app.js"), "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", policyFile, "--json"]), 1); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "FAIL");
  assert.equal(fs.readFileSync(path.join(root, "dist/app.js"), "utf8"), before);
  fs.rmSync(policyFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI rejects malformed policy, missing repositories, and unknown arguments", () => {
  const malformed = tempJson("{");
  const valid = tempJson(rawPolicy());
  assert.equal(main(["--root", "/tmp/missing-repository-hygiene-root", "--policy", valid]), 1);
  assert.equal(main(["--root", ".", "--policy", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  fs.rmSync(valid, { force: true });
});

test("auditor operational surface is local read-only Git inspection", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-repository-hygiene.js", import.meta.url), "utf8");
  assert.match(source, /spawnSync\("git", \["ls-files", "-z"\]/);
  assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\/|process\.env|writeFile|rmSync|unlinkSync|git[^\n]*(checkout|reset|clean|commit|push)/i);
});
