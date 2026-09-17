import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatControlledAgentWorkflow,
  main,
  planControlledAgentWorkflow,
  validateControlledAgentWorkflowPolicy,
} from "../scripts/controlled-agent-workflow.js";
import { validateAgentSafetyPolicy } from "../scripts/audit-agent-safety.js";

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-workflow-"));
  fs.mkdirSync(path.join(root, ".github/workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs/policies"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs/canonical"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    packageManager: "bun@1.3.14",
    scripts: { lint: "eslint .", typecheck: "tsc --noEmit", test: "node --test", check: "bun run typecheck && bun run test" },
  }));
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");
  fs.writeFileSync(path.join(root, "docs/development.md"), "development\n");
  fs.writeFileSync(path.join(root, "src/index.ts"), "export {};\n");
  fs.writeFileSync(path.join(root, ".github/workflows/ci.yml"), "bun run typecheck\nbun run test\nbun run lint:changed\nbun run build\n");
  return root;
}
/** @param {string} root */
function configureAgentSafety(root) {
  fs.writeFileSync(path.join(root, "docs/canonical/truth.md"), "canonical truth\n");
  for (const name of ["secrets", "migrations", "deployment"]) {
    fs.writeFileSync(path.join(root, `docs/policies/${name}.md`), `${name} boundary\n`);
  }
  fs.writeFileSync(path.join(root, "AGENTS.md"), [
    "Read `docs/canonical/truth.md`.",
    "Secrets: `docs/policies/secrets.md`.",
    "Migrations: `docs/policies/migrations.md`.",
    "Deployment: `docs/policies/deployment.md`.",
    "```sh",
    "bun run test",
    "```",
  ].join("\n"));
}

/** @returns {any} */
function rawAgentPolicy() {
  return {
    version: 1,
    repository: "example-webapp",
    agentsFile: "AGENTS.md",
    canonicalSources: [{ id: "business-truth", path: "docs/canonical/truth.md" }],
    testCommands: [{ id: "tests", command: "bun run test" }],
    boundaries: {
      secrets: { policyPath: "docs/policies/secrets.md" },
      migrations: { policyPath: "docs/policies/migrations.md" },
      deployment: { policyPath: "docs/policies/deployment.md" },
    },
  };
}

function agentPolicy(value = rawAgentPolicy()) {
  const result = validateAgentSafetyPolicy(value);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) throw new Error("agent policy invalid");
  return result.policy;
}
/** @returns {any} */
function rawWorkflowPolicy() {
  return {
    version: 1,
    repository: "example-webapp",
    allowAutofixIds: ["changed-lint-script"],
    boundaries: [
      { id: "business-truth", kind: "business-truth", effect: "HUMAN_REQUIRED", paths: ["src/canonical/**"] },
      { id: "production-deploy", kind: "production", effect: "BLOCKED", paths: ["deploy/**"] },
      { id: "database-migrations", kind: "migrations", effect: "HUMAN_REQUIRED", paths: ["migrations/**"] },
    ],
  };
}

function workflowPolicy(value = rawWorkflowPolicy()) {
  const result = validateControlledAgentWorkflowPolicy(value);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) throw new Error("workflow policy invalid");
  return result.policy;
}

/** @param {any} value */
function tempJson(value) {
  const file = path.join(os.tmpdir(), `agent-workflow-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

test("complete safety profile makes allowlisted low-risk toolkit action autofix eligible", () => {
  const root = repository();
  configureAgentSafety(root);
  const report = planControlledAgentWorkflow(root, agentPolicy(), workflowPolicy());
  const changedLint = report.actions.find((item) => item.id === "changed-lint-script");

  assert.equal(report.executionAuthorized, false);
  assert.equal(changedLint?.disposition, "AUTO_FIX_ELIGIBLE");
  assert.equal(changedLint?.risk, "LOW");
  assert.equal(report.summary.autoFixEligible, 1);
  assert.match(report.semantics, /never writes files/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("safe item becomes propose-only when workflow policy does not allow autofix", () => {
  const root = repository();
  configureAgentSafety(root);
  const raw = rawWorkflowPolicy();
  raw.allowAutofixIds = [];
  const report = planControlledAgentWorkflow(root, agentPolicy(), workflowPolicy(raw));
  const action = report.actions.find((item) => item.id === "changed-lint-script");
  assert.equal(action?.disposition, "PROPOSE_ONLY");
  assert.equal(report.executionAuthorized, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("incomplete agent safety blocks every remediation proposal", () => {
  const root = repository();
  configureAgentSafety(root);
  fs.rmSync(path.join(root, "docs/policies/deployment.md"));
  const report = planControlledAgentWorkflow(root, agentPolicy(), workflowPolicy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.agentSafety.overallStatus, "FAIL");
  assert.equal(report.actions.every((item) => item.disposition === "BLOCKED"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("private BLOCKED boundary overrides otherwise safe autofix eligibility", () => {
  const root = repository();
  configureAgentSafety(root);
  const raw = rawWorkflowPolicy();
  raw.boundaries.push({ id: "toolkit-script-lock", kind: "production", effect: "BLOCKED", paths: ["scripts/**"] });
  const report = planControlledAgentWorkflow(root, agentPolicy(), workflowPolicy(raw));
  const action = report.actions.find((item) => item.id === "changed-lint-script");
  assert.equal(action?.disposition, "BLOCKED");
  assert.equal(action?.boundaryHits.some((hit) => hit.id === "toolkit-script-lock"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("protected HUMAN_REQUIRED boundary prevents silent autofix without fully blocking planning", () => {
  const root = repository();
  configureAgentSafety(root);
  const raw = rawWorkflowPolicy();
  raw.boundaries.push({ id: "review-toolkit-scripts", kind: "business-truth", effect: "HUMAN_REQUIRED", paths: ["scripts/**"] });
  const report = planControlledAgentWorkflow(root, agentPolicy(), workflowPolicy(raw));
  const action = report.actions.find((item) => item.id === "changed-lint-script");
  assert.equal(action?.disposition, "HUMAN_REQUIRED");
  assert.equal(report.overallStatus, "WARN");
  fs.rmSync(root, { recursive: true, force: true });
});

test("wildcard repository-owned CI targets require human review", () => {
  const root = repository();
  configureAgentSafety(root);
  fs.rmSync(path.join(root, ".github/workflows/ci.yml"));
  const report = planControlledAgentWorkflow(root, agentPolicy(), workflowPolicy());
  const ci = report.actions.find((item) => item.id === "github-ci");
  assert.equal(ci?.disposition, "HUMAN_REQUIRED");
  assert.equal(ci?.files.some((file) => file.includes("*")), true);
  assert.match(ci?.reason ?? "", /not concrete enough/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("high-risk unmapped findings require human review and invent no targets", () => {
  const root = repository();
  configureAgentSafety(root);
  fs.rmSync(path.join(root, "package.json"));
  const report = planControlledAgentWorkflow(root, agentPolicy(), workflowPolicy());
  const item = report.actions.find((action) => action.id === "package-json");
  assert.equal(item?.risk, "HIGH");
  assert.equal(item?.disposition, "HUMAN_REQUIRED");
  assert.deepEqual(item?.files, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test("workflow policy requires explicit private boundaries and rejects unsafe declarations", () => {
  const empty = rawWorkflowPolicy();
  empty.boundaries = [];
  assert.equal(validateControlledAgentWorkflowPolicy(empty).valid, false);

  const duplicate = rawWorkflowPolicy();
  duplicate.boundaries.push(structuredClone(duplicate.boundaries[0]));
  assert.equal(validateControlledAgentWorkflowPolicy(duplicate).valid, false);

  const unsafe = rawWorkflowPolicy();
  unsafe.boundaries[0].paths = ["../canonical/**"];
  assert.equal(validateControlledAgentWorkflowPolicy(unsafe).valid, false);

  const effect = rawWorkflowPolicy();
  effect.boundaries[0].effect = "AUTO";
  assert.equal(validateControlledAgentWorkflowPolicy(effect).valid, false);
});

test("agent safety and workflow repository identities must match", () => {
  const root = repository();
  configureAgentSafety(root);
  const raw = rawWorkflowPolicy();
  raw.repository = "different-repository";
  assert.throws(
    () => planControlledAgentWorkflow(root, agentPolicy(), workflowPolicy(raw)),
    /repository identities differ/,
  );
  fs.rmSync(root, { recursive: true, force: true });
});

test("human output never implies execution authorization", () => {
  const root = repository();
  configureAgentSafety(root);
  const output = formatControlledAgentWorkflow(
    planControlledAgentWorkflow(root, agentPolicy(), workflowPolicy()),
  );
  assert.match(output, /Execution authorized: false/);
  assert.match(output, /AUTO_FIX_ELIGIBLE/);
  assert.match(output, /never writes files/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI emits proposal-only workflow JSON and never mutates repository", () => {
  const root = repository();
  configureAgentSafety(root);
  const agentFile = tempJson(rawAgentPolicy());
  const workflowFile = tempJson(rawWorkflowPolicy());
  const before = fs.readdirSync(root, { recursive: true }).map(String).sort();
  const original = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["--root", root, "--agent-safety-policy", agentFile, "--workflow-policy", workflowFile, "--json"]), 0);
  } finally { console.log = original; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.executionAuthorized, false);
  assert.equal(parsed.actions.some((/** @type {any} */ item) => item.id === "changed-lint-script"), true);
  assert.deepEqual(fs.readdirSync(root, { recursive: true }).map(String).sort(), before);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(agentFile, { force: true });
  fs.rmSync(workflowFile, { force: true });
});

test("CLI rejects malformed inputs and workflow planner has no mutation or network surface", () => {
  const malformed = tempJson("{");
  assert.equal(main(["--unknown"]), 1);
  assert.equal(main(["--root", "/tmp/example", "--agent-safety-policy", malformed, "--workflow-policy", malformed]), 1);
  fs.rmSync(malformed, { force: true });

  const source = fs.readFileSync(new URL("../scripts/controlled-agent-workflow.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|node:child_process|spawnSync|execFile|writeFile|copyFile|renameSync|rmSync|unlinkSync|process\.env/);
  assert.match(source, /planRemediation/);
  assert.match(source, /inspectAgentSafety/);
  assert.match(source, /isSafeAutofixEligible/);
});