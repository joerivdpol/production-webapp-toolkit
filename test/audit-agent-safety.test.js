import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatAgentSafety,
  inspectAgentSafety,
  main,
  validateAgentSafetyPolicy,
} from "../scripts/audit-agent-safety.js";

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    repository: "example-webapp",
    agentsFile: "AGENTS.md",
    canonicalSources: [
      { id: "architecture", path: "docs/architecture.md" },
      { id: "business-rules", path: "docs/canonical/business-rules.md" },
    ],
    testCommands: [
      { id: "tests", command: "bun run test" },
      { id: "typecheck", command: "bun run typecheck" },
    ],
    boundaries: {
      secrets: { policyPath: "docs/policies/secrets.md" },
      migrations: { policyPath: "docs/policies/migrations.md" },      deployment: { policyPath: "docs/policies/deployment.md" },
    },
  };
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-safety-"));
  for (const directory of ["docs/canonical", "docs/policies"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "docs/architecture.md"), "architecture truth\n");
  fs.writeFileSync(path.join(root, "docs/canonical/business-rules.md"), "canonical business truth\n");
  fs.writeFileSync(path.join(root, "docs/policies/secrets.md"), "secret handling boundary\n");
  fs.writeFileSync(path.join(root, "docs/policies/migrations.md"), "migration boundary\n");
  fs.writeFileSync(path.join(root, "docs/policies/deployment.md"), "deployment boundary\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), [
    "# Agent contract",
    "",
    "Read `docs/canonical/business-rules.md` before changing business behavior.",
    "Use [architecture](docs/architecture.md) as the architecture source.",
    "Secrets: `docs/policies/secrets.md`.",
    "Migrations: `docs/policies/migrations.md`.",
    "Deployment: `docs/policies/deployment.md`.",
    "",
    "```sh",
    "bun run typecheck",
    "bun run test",
    "```",
  ].join("\n"));
  return root;
}
/** @param {any} value */
function validatedPolicy(value = rawPolicy()) {
  const result = validateAgentSafetyPolicy(value);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) throw new Error("agent safety policy invalid");
  return result.policy;
}

/** @param {any} value */
function tempJson(value) {
  const file = path.join(os.tmpdir(), `agent-safety-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

test("complete explicit agent safety profile passes document bindings", () => {
  const root = repository();
  const report = inspectAgentSafety(root, validatedPolicy());

  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.summary.fail, 0);
  assert.equal(report.checks.filter((item) => item.id === "canonical-source-referenced").length, 2);
  assert.equal(report.checks.filter((item) => item.id === "test-command-documented").length, 2);
  assert.equal(report.checks.filter((item) => item.id === "boundary-policy-referenced").length, 3);
  assert.match(report.semantics, /do not prove/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("test commands must appear as exact fenced-code lines", () => {
  const root = repository();
  const agentsFile = path.join(root, "AGENTS.md");
  const markdown = fs.readFileSync(agentsFile, "utf8")
    .replace("bun run test\n", "Run bun run test before review.\n");
  fs.writeFileSync(agentsFile, markdown);

  const report = inspectAgentSafety(root, validatedPolicy());
  const tests = report.checks.find((item) => item.id === "test-command-documented" && item.scope === "tests");
  const typecheck = report.checks.find((item) => item.id === "test-command-documented" && item.scope === "typecheck");
  assert.equal(tests?.status, "FAIL");
  assert.equal(typecheck?.status, "PASS");
  fs.rmSync(root, { recursive: true, force: true });
});

test("canonical source presence and AGENTS reference are independent", () => {
  const root = repository();
  fs.rmSync(path.join(root, "docs/canonical/business-rules.md"));
  const report = inspectAgentSafety(root, validatedPolicy());
  assert.equal(report.checks.some((item) => item.scope === "business-rules" && item.id === "canonical-source-present" && item.status === "FAIL"), true);
  assert.equal(report.checks.some((item) => item.scope === "business-rules" && item.id === "canonical-source-referenced" && item.status === "PASS"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("boundary files must be regular and explicitly referenced", () => {
  const root = repository();
  const secretPolicy = path.join(root, "docs/policies/secrets.md");
  fs.rmSync(secretPolicy);
  fs.symlinkSync("/etc/passwd", secretPolicy);
  const agentsFile = path.join(root, "AGENTS.md");
  fs.writeFileSync(
    agentsFile,
    fs.readFileSync(agentsFile, "utf8").replace("Secrets: `docs/policies/secrets.md`.\n", "Secrets are restricted.\n"),
  );

  const report = inspectAgentSafety(root, validatedPolicy());
  assert.equal(report.checks.some((item) => item.scope === "secrets" && item.id === "boundary-policy-present" && item.status === "FAIL"), true);
  assert.equal(report.checks.some((item) => item.scope === "secrets" && item.id === "boundary-policy-referenced" && item.status === "FAIL"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("AGENTS must be a bounded regular non-symlink file", () => {
  const root = repository();
  fs.rmSync(path.join(root, "AGENTS.md"));
  fs.symlinkSync("/etc/passwd", path.join(root, "AGENTS.md"));
  const report = inspectAgentSafety(root, validatedPolicy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "agents-file" && item.status === "FAIL"), true);
  assert.equal(report.checks.some((item) => item.id === "canonical-source-present"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("policy requires every safety boundary and rejects unsafe or duplicate declarations", () => {
  const missingBoundary = rawPolicy();
  delete missingBoundary.boundaries.migrations;
  assert.equal(validateAgentSafetyPolicy(missingBoundary).valid, false);

  const unsafe = rawPolicy();
  unsafe.canonicalSources[0].path = "../architecture.md";
  assert.equal(validateAgentSafetyPolicy(unsafe).valid, false);

  const duplicateSource = rawPolicy();
  duplicateSource.canonicalSources.push({ id: "another", path: "docs/architecture.md" });
  assert.equal(validateAgentSafetyPolicy(duplicateSource).valid, false);

  const duplicateCommand = rawPolicy();
  duplicateCommand.testCommands.push({ id: "tests-again", command: "bun run test" });
  assert.equal(validateAgentSafetyPolicy(duplicateCommand).valid, false);
});

test("policy rejects unknown fields and malformed identifiers", () => {
  const unknown = rawPolicy();
  unknown.businessRules = true;
  assert.equal(validateAgentSafetyPolicy(unknown).valid, false);

  const repository = rawPolicy();
  repository.repository = "../private";
  assert.equal(validateAgentSafetyPolicy(repository).valid, false);

  const command = rawPolicy();
  command.testCommands[0].command = "bun run test\nrm -rf /";
  assert.equal(validateAgentSafetyPolicy(command).valid, false);
});

test("human output exposes binding ids but never referenced document contents", () => {
  const root = repository();
  const marker = "PRIVATE_CANONICAL_PAYLOAD_771";
  fs.writeFileSync(path.join(root, "docs/canonical/business-rules.md"), marker);
  const output = formatAgentSafety(inspectAgentSafety(root, validatedPolicy()));

  assert.match(output, /business-rules/);
  assert.match(output, /boundary-policy-present/);
  assert.doesNotMatch(output, new RegExp(marker));
  fs.rmSync(root, { recursive: true, force: true });
});

test("symlinked repository root is a technical failure", () => {
  const root = repository();
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "agent-safety-link-"));
  const link = path.join(parent, "repository");
  fs.symlinkSync(root, link, "dir");
  const report = inspectAgentSafety(link, validatedPolicy());
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "repository-unavailable"), true);
  fs.rmSync(parent, { recursive: true, force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI emits stable JSON and uses blocking exit for missing bindings", () => {
  const root = repository();
  const policyFile = tempJson(rawPolicy());
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", policyFile, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  fs.rmSync(path.join(root, "docs/policies/deployment.md"));
  assert.equal(main(["--root", root, "--policy", policyFile]), 1);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(policyFile, { force: true });
});

test("CLI rejects malformed policies and unknown arguments", () => {
  const malformed = tempJson("{");
  assert.equal(main(["--root", "/tmp/example", "--policy", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("agent safety audit remains local read only and does not inspect boundary contents", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-agent-safety.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /fs\.lstatSync/);
  assert.match(source, /fs\.readFileSync\(agents\.absolute/);
  assert.doesNotMatch(source, /readFileSync\([^\n]*policyPath/);
});