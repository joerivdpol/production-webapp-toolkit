import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  auditPlaywrightGeneratedTests,
  inspectPlaywrightAgentWorkspace,
  main,
  validatePlaywrightAgentPlan,
  validatePlaywrightAgentPolicy,
} from "../scripts/playwright-agent-integration.js";

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function plannerDefinition() {
  return 'name = "playwright_test_planner"\nsandbox_mode = "read-only"\n[mcp_servers.playwright-test]\ncommand = "npx"\nargs = ["playwright", "run-test-mcp-server"]\n';
}
function generatorDefinition() {
  return 'name = "playwright_test_generator"\nsandbox_mode = "read-only"\n[mcp_servers.playwright-test]\ncommand = "npx"\nargs = ["playwright", "run-test-mcp-server"]\n';
}
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pw-agent-integration-"));
  const repo = path.join(root, "repo"), worktree = path.join(root, "worktree");
  fs.mkdirSync(repo);
  git(repo, ["init", "-q"]); git(repo, ["config", "user.email", "test@example.invalid"]); git(repo, ["config", "user.name", "Test User"]);
  fs.mkdirSync(path.join(repo, "tests"), { recursive: true });
  fs.mkdirSync(path.join(repo, "generated"), { recursive: true });
  fs.mkdirSync(path.join(repo, "specs"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".codex", "agents"), { recursive: true });
  fs.mkdirSync(path.join(repo, ".codex", "prompts"), { recursive: true });
  fs.mkdirSync(path.join(repo, "node_modules", "@playwright", "test"), { recursive: true });
  fs.writeFileSync(path.join(repo, "playwright.config.ts"), "export default {};\n");
  fs.writeFileSync(path.join(repo, "tests", "seed.spec.ts"), "import { test } from '@playwright/test'; test('seed', async()=>{});\n");
  fs.writeFileSync(path.join(repo, ".codex", "agents", "playwright_test_planner.toml"), plannerDefinition());
  fs.writeFileSync(path.join(repo, ".codex", "agents", "playwright_test_generator.toml"), generatorDefinition());
  fs.writeFileSync(path.join(repo, ".codex", "prompts", "playwright-test-plan.md"), "---\nagent: playwright-test-planner\n---\nPlan tests.\n");
  fs.writeFileSync(path.join(repo, ".codex", "prompts", "playwright-test-generate.md"), "---\nagent: playwright-test-generator\n---\nGenerate tests.\n");
  fs.writeFileSync(path.join(repo, "node_modules", "@playwright", "test", "package.json"), JSON.stringify({ name: "@playwright/test", version: "1.61.1" }));
  fs.writeFileSync(path.join(repo, "specs", "coverage.plan.md"), [
    "# Coverage", "",
    "### 1. Checkout", "**Seed:** `tests/seed.spec.ts`", "",
    "#### 1.1 Submit valid form", "**Steps:**", "1. Open form", "",
    "**Expected Result:**", "Form is submitted", "",
  ].join("\n"));
  fs.writeFileSync(path.join(repo, "generated", "submit-valid.spec.ts"), [
    "// spec: specs/coverage.plan.md",
    "// seed: tests/seed.spec.ts",
    "import { test, expect } from '@playwright/test';",
    "test('Submit valid form', async ({ page }) => {",
    "  await expect(page.locator('body')).toBeVisible();",
    "});", "",
  ].join("\n"));
  git(repo, ["add", "."]); git(repo, ["commit", "-qm", "fixture"]);
  const commit = git(repo, ["rev-parse", "HEAD"]);
  git(repo, ["worktree", "add", "-q", "-b", "pw-agent-test", worktree, commit]);
  return { root, repo, worktree, commit };
}
/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    repository: "demo",
    expectedPlaywrightVersion: "1.61.1",
    loop: "codex",
    configFile: "playwright.config.ts",
    seedFile: "tests/seed.spec.ts",
    planFile: "specs/coverage.plan.md",
    generatedTestRoot: "generated",
    plannerDefinition: ".codex/agents/playwright_test_planner.toml",
    generatorDefinition: ".codex/agents/playwright_test_generator.toml",
    plannerPrompt: ".codex/prompts/playwright-test-plan.md",
    generatorPrompt: ".codex/prompts/playwright-test-generate.md",
    maxPlanBytes: 65536,
    maxTestBytes: 65536,
    maxGeneratedFiles: 32,
  };
}
function policy() {
  const result = validatePlaywrightAgentPolicy(rawPolicy());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) throw new Error("policy fixture invalid");
  return result.policy;
}
test("policy requires exact version safe paths and bounded planner generator configuration", () => {
  assert.equal(validatePlaywrightAgentPolicy(rawPolicy()).valid, true);
  const version = rawPolicy(); version.expectedPlaywrightVersion = "^1.61.0";
  assert.equal(validatePlaywrightAgentPolicy(version).valid, false);
  const traversal = rawPolicy(); traversal.seedFile = "../secret";
  assert.equal(validatePlaywrightAgentPolicy(traversal).valid, false);
  const healer = rawPolicy(); healer.loop = "unknown-loop";
  assert.equal(validatePlaywrightAgentPolicy(healer).valid, false);
});

test("workspace inspection binds exact linked worktree commit and local Playwright version", () => {
  const f = fixture();
  try {
    const report = inspectPlaywrightAgentWorkspace(f.worktree, policy(), f.commit);
    assert.equal(report.status, "PASS");
    assert.equal(report.playwright.versionMatches, true);
    assert.equal(report.agents.planner.valid, true);
    assert.equal(report.agents.generator.valid, true);
    assert.equal(report.healerAuthorized, false);
    assert.equal(report.prompts.coveragePromptAuthorized, false);
    assert.equal(report.initPlan.executionPerformed, false);
    assert.throws(() => inspectPlaywrightAgentWorkspace(f.repo, policy(), f.commit), /linked Git worktree/);
    assert.throws(() => inspectPlaywrightAgentWorkspace(f.worktree, policy(), "b".repeat(40)), /identity/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("workspace fails when installed Playwright version drifts", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.worktree, "node_modules", "@playwright", "test", "package.json"), JSON.stringify({ version: "1.60.0" }));
    const report = inspectPlaywrightAgentWorkspace(f.worktree, policy(), f.commit);
    assert.equal(report.status, "FAIL");
    assert.equal(report.playwright.versionMatches, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("planner and generator definitions reject healer references or write-capable sandbox", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.worktree, ".codex", "agents", "playwright_test_generator.toml"), generatorDefinition() + "\n# playwright_test_healer\n");
    let report = inspectPlaywrightAgentWorkspace(f.worktree, policy(), f.commit);
    assert.equal(report.status, "FAIL");
    assert.equal(report.agents.generator.forbidden, true);
    fs.writeFileSync(path.join(f.worktree, ".codex", "agents", "playwright_test_generator.toml"), generatorDefinition().replace('read-only', 'workspace-write'));
    report = inspectPlaywrightAgentWorkspace(f.worktree, policy(), f.commit);
    assert.equal(report.status, "FAIL");
    assert.equal(report.agents.generator.readOnly, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("test plan requires exact seed numbered scenario steps and expected result", () => {
  const f = fixture();
  try {
    const plan = fs.readFileSync(path.join(f.worktree, "specs", "coverage.plan.md"), "utf8");
    const valid = validatePlaywrightAgentPlan(plan, policy());
    assert.equal(valid.valid, true, JSON.stringify(valid.errors));
    assert.equal(valid.scenarios, 1);
    assert.equal(validatePlaywrightAgentPlan(plan.replace("tests/seed.spec.ts", "tests/other.spec.ts"), policy()).valid, false);
    assert.equal(validatePlaywrightAgentPlan(plan.replace("**Expected Result:**", "**Outcome:**"), policy()).valid, false);
    assert.equal(validatePlaywrightAgentPlan(plan + "\nThis scenario is skipped.\n", policy()).valid, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("generated Playwright test passes when spec seed test and expect bindings are explicit", () => {
  const f = fixture();
  try {
    const report = auditPlaywrightGeneratedTests(f.worktree, policy(), f.commit);
    assert.equal(report.status, "PASS");
    assert.equal(report.plan.valid, true);
    assert.equal(report.generated.files.length, 1);
    const audited = report.generated.files[0];
    assert.ok(audited);
    assert.equal(audited.valid, true);
    assert.equal(audited.testCalls, 1);
    assert.equal(audited.expectCalls, 1);
    assert.equal(report.healerAuthorized, false);
    assert.equal(report.executionPerformed, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("generated tests cannot skip fixme focus or expected-fail broken functionality", () => {
  for (const call of ["test.skip", "test.fixme", "test.only", "test.fail", "test.describe.skip", "test.step.skip"]) {
    const f = fixture();
    try {
      const file = path.join(f.worktree, "generated", "submit-valid.spec.ts");
      const source = [
        "// spec: specs/coverage.plan.md",
        "// seed: tests/seed.spec.ts",
        "import { test, expect } from '@playwright/test';",
        call + "('broken flow', async ({ page }) => {",
        "  await expect(page.locator('body')).toBeVisible();",
        "});", "",
      ].join("\n");
      fs.writeFileSync(file, source);
      const report = auditPlaywrightGeneratedTests(f.worktree, policy(), f.commit);
      assert.equal(report.status, "FAIL", call);
      const audited = report.generated.files[0];
      assert.ok(audited);
      assert.equal(audited.valid, false);
      assert.ok(audited.forbiddenCalls.length >= 1);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("generated test without assertion is blocking instead of silently passing", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.worktree, "generated", "submit-valid.spec.ts"), [
      "// spec: specs/coverage.plan.md",
      "// seed: tests/seed.spec.ts",
      "import { test } from '@playwright/test';",
      "test('broken flow', async ({ page }) => { await page.goto('about:blank'); });", "",
    ].join("\n"));
    const report = auditPlaywrightGeneratedTests(f.worktree, policy(), f.commit);
    assert.equal(report.status, "FAIL");
    const audited = report.generated.files[0];
    assert.ok(audited);
    assert.match(audited.errors.join(" "), /no expect/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
test("generated test must bind exact plan and seed comments", () => {
  const f = fixture();
  try {
    const file = path.join(f.worktree, "generated", "submit-valid.spec.ts");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("specs/coverage.plan.md", "specs/other.md"));
    let report = auditPlaywrightGeneratedTests(f.worktree, policy(), f.commit);
    assert.equal(report.status, "FAIL");
    const audited = report.generated.files[0];
    assert.ok(audited);
    assert.match(audited.errors.join(" "), /spec file/);
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("tests/seed.spec.ts", "tests/other.spec.ts"));
    report = auditPlaywrightGeneratedTests(f.worktree, policy(), f.commit);
    assert.equal(report.status, "FAIL");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("generated test root rejects symlinks and excessive generated files", () => {
  const f = fixture();
  try {
    const link = path.join(f.worktree, "generated", "alias.spec.ts");
    fs.symlinkSync(path.join(f.worktree, "generated", "submit-valid.spec.ts"), link);
    assert.throws(() => auditPlaywrightGeneratedTests(f.worktree, policy(), f.commit), /symlinks/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }

  const f2 = fixture();
  try {
    const p = rawPolicy(); p.maxGeneratedFiles = 1;
    fs.copyFileSync(path.join(f2.worktree, "generated", "submit-valid.spec.ts"), path.join(f2.worktree, "generated", "second.spec.ts"));
    const validated = validatePlaywrightAgentPolicy(p);
    assert.equal(validated.valid, true);
    assert.throws(() => auditPlaywrightGeneratedTests(f2.worktree, validated.policy, f2.commit), /count exceeds/);
  } finally { fs.rmSync(f2.root, { recursive: true, force: true }); }
});
test("CLI inspect and audit remain read-only over explicit files", () => {
  const f = fixture();
  const policyFile = path.join(f.root, "policy.json");
  fs.writeFileSync(policyFile, JSON.stringify(rawPolicy()));
  const originalLog = console.log, originalError = console.error;
  let stdout = "";
  console.log = (...values) => { stdout += values.join(" ") + "\n"; };
  console.error = () => {};
  try {
    assert.equal(main(["inspect", "--root", f.worktree, "--policy", policyFile, "--expected-commit", f.commit, "--json"]), 0);
    assert.equal(JSON.parse(stdout.trim()).healerAuthorized, false);
    stdout = "";
    assert.equal(main(["audit", "--root", f.worktree, "--policy", policyFile, "--expected-commit", f.commit, "--json"]), 0);
    assert.equal(JSON.parse(stdout.trim()).generatedTestsApproved, true);
    assert.equal(main(["audit", "--unknown", "x"]), 1);
  } finally {
    console.log = originalLog; console.error = originalError;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("public Playwright agent policy template is valid and has no private infrastructure", () => {
  const file = new URL("../templates/playwright-agent-integration-policy.v1.json", import.meta.url);
  const rawText = fs.readFileSync(file, "utf8"), raw = JSON.parse(rawText);
  assert.equal(validatePlaywrightAgentPolicy(raw).valid, true);
  assert.doesNotMatch(rawText, /endpoint|hostname|ssh|tailscale|maintainerService|privateInfrastructure/i);
});

test("integration source exposes no healer execution browser execution or mutation surface", () => {
  const source = fs.readFileSync(new URL("../scripts/playwright-agent-integration.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /run-test-mcp-server.*spawn|init-agents.*spawn|browser_navigate|generator_write_test/);
  assert.doesNotMatch(source, /writeFileSync|appendFileSync|renameSync|unlinkSync|fetch\(/);
  assert.match(source, /healerAuthorized: false/);
  assert.match(source, /executionPerformed: false/);
  assert.match(source, /const GIT = "\/usr\/bin\/git"/);
});
test("adapter does not authorize Playwright coverage workflow that invokes healer", () => {
  const f = fixture();
  try {
    fs.writeFileSync(path.join(f.worktree, ".codex", "prompts", "playwright-test-generate.md"), [
      "---", "agent: playwright-test-generator", "---",
      "Generate test and then call playwright-test-healer.", "",
    ].join("\n"));
    const report = inspectPlaywrightAgentWorkspace(f.worktree, policy(), f.commit);
    assert.equal(report.status, "FAIL");
    assert.equal(report.prompts.generator.forbidden, true);
    assert.equal(report.prompts.coveragePromptAuthorized, false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
