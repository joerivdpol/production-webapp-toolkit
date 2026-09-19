import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  applyLintDebtRemediation,
  assertLintDebtBaselineCompatible,
  buildLintDebtBaseline,
  collectTrackedLintFiles,
  compareLintDebt,
  isGeneratedLintPath,
  planLintDebtRemediation,
  scanLintDebt,
  validateLintDebtPolicy,
} from "../scripts/lint-debt.js";

const toolkitRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} root @param {...string} args */
function git(root, ...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Toolkit Test",
      GIT_AUTHOR_EMAIL: "toolkit@example.invalid",
      GIT_COMMITTER_NAME: "Toolkit Test",
      GIT_COMMITTER_EMAIL: "toolkit@example.invalid",
    },
  });
}

function createLintFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-debt-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "lint-debt-fixture", private: true, type: "module" }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
  fs.writeFileSync(
    path.join(root, "eslint.config.js"),
    [
      'export default [{',
      '  files: ["**/*.js"],',
      '  rules: { semi: ["error", "always"], "prefer-const": "error" },',
      '}];',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(path.join(root, "src", "app.js"), "let answer = 42\nconsole.log(answer)\n");
  fs.writeFileSync(
    path.join(root, "src", "routeTree.gen.js"),
    "let generated = 1\nconsole.log(generated)\n",
  );
  fs.symlinkSync(path.join(toolkitRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "package.json", ".gitignore", "eslint.config.js", "src");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

describe("lint debt policy and selection", () => {
  it("rejects paths that escape the repository", () => {
    assert.throws(
      () =>
        validateLintDebtPolicy({
          version: 1,
          excludeFiles: ["../outside.js"],
        }),
      /stay inside|repository-relative/,
    );
  });

  it("identifies common generated source paths", () => {
    assert.equal(isGeneratedLintPath("src/routeTree.gen.ts"), true);
    assert.equal(isGeneratedLintPath("src/generated/client.ts"), true);
    assert.equal(isGeneratedLintPath("src/app.ts"), false);
  });

  it("excludes generated files and explicit policy prefixes", () => {
    const root = createLintFixture();
    const policy = validateLintDebtPolicy({
      version: 1,
      excludePrefixes: ["src"],
    });
    const selection = collectTrackedLintFiles(root, policy);
    assert.deepEqual(selection.files, ["eslint.config.js"]);
    assert.equal(selection.selection.excludedGenerated, 1);
    assert.equal(selection.selection.excludedPolicy, 1);
  });
});

describe("lint debt baseline", () => {
  it("detects only debt above the recorded historical multiset", async () => {
    const root = createLintFixture();
    const before = await scanLintDebt(root);
    const baseline = buildLintDebtBaseline(before);
    assert.equal(before.summary.issues, 3);
    assert.equal(before.issueGroups.some((group) => "message" in group), false);

    fs.appendFileSync(path.join(root, "src", "app.js"), 'console.log("new")\n');
    const after = await scanLintDebt(root);
    const comparison = compareLintDebt(after.issueGroups, baseline);
    assert.equal(comparison.newDebt, 1);
    assert.equal(comparison.improvedDebt, 0);
  });

  it("binds the baseline to exact ESLint and policy identity", async () => {
    const root = createLintFixture();
    const report = await scanLintDebt(root);
    const baseline = buildLintDebtBaseline(report);
    assert.doesNotThrow(() => assertLintDebtBaselineCompatible(report, baseline));

    const changedPolicy = { ...baseline, policySha256: "0".repeat(64) };
    assert.throws(
      () => assertLintDebtBaselineCompatible(report, changedPolicy),
      /policy changed/,
    );

    const changedEngine = {
      ...baseline,
      engine: { name: "eslint", version: "0.0.0" },
    };
    assert.throws(
      () => assertLintDebtBaselineCompatible(report, changedEngine),
      /ESLint version differs/,
    );
  });

  it("requires the actual Git repository root", async () => {
    const root = createLintFixture();
    await assert.rejects(() => scanLintDebt(path.join(root, "src")), /Git repository root/);
  });

  it("writes a CLI baseline and exits non-zero when debt grows", () => {
    const root = createLintFixture();
    const script = path.join(toolkitRoot, "scripts", "lint-debt.js");
    const baselineOutput = execFileSync(
      process.execPath,
      [script, "baseline", root, "--json"],
      { encoding: "utf8" },
    );
    const result = JSON.parse(baselineOutput);
    assert.equal(result.summary.issues, 3);
    assert.equal(fs.existsSync(path.join(root, ".toolkit", "lint-debt-baseline.json")), true);

    fs.appendFileSync(path.join(root, "src", "app.js"), 'console.log("new")\n');
    assert.throws(
      () =>
        execFileSync(process.execPath, [script, "check", root, "--json"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      (/** @type {any} */ error) =>
        error && typeof error === "object" && error.status === 1,
    );
  });
});

describe("layout-only automatic lint debt remediation", () => {
  it("plans and applies only layout fixes while leaving semantic suggestions intact", async () => {
    const root = createLintFixture();
    const generatedBefore = fs.readFileSync(path.join(root, "src", "routeTree.gen.js"), "utf8");

    const plan = await planLintDebtRemediation(root);
    assert.equal(plan.summary.selectedFiles, 1);
    assert.deepEqual(plan.selected.map((item) => item.file), ["src/app.js"]);
    assert.equal(plan.summary.plannedResolvedProblems, 2);

    const result = await applyLintDebtRemediation(root);
    assert.equal(result.applied, true);
    assert.equal(result.resolvedProblems, 2);
    assert.equal(result.newDebt, 0);
    assert.deepEqual(result.files, ["src/app.js"]);

    const source = fs.readFileSync(path.join(root, "src", "app.js"), "utf8");
    assert.match(source, /let answer = 42;/);
    assert.doesNotMatch(source, /const answer/);
    assert.equal(
      fs.readFileSync(path.join(root, "src", "routeTree.gen.js"), "utf8"),
      generatedBefore,
    );

    const after = await scanLintDebt(root);
    assert.equal(after.summary.issues, 1);
    assert.equal(after.issueGroups[0].ruleId, "prefer-const");
  });

  it("rolls back the whole batch when post-write diff validation fails", async () => {
    const root = createLintFixture();
    fs.writeFileSync(
      path.join(root, "eslint.config.js"),
      [
        "const badLayoutRule = {",
        '  meta: { type: "layout", fixable: "whitespace", schema: [] },',
        "  create(context) {",
        "    return {",
        "      Program(node) {",
        '        const marker = "/* bad-layout */";',
        "        const index = context.sourceCode.text.indexOf(marker);",
        "        if (index < 0) return;",
        "        context.report({",
        "          node,",
        '          message: "synthetic bad layout fix",',
        '          fix: (fixer) => fixer.replaceTextRange([index, index + marker.length], "   "),',
        "        });",
        "      },",
        "    };",
        "  },",
        "};",
        "export default [{",
        '  files: ["**/*.js"],',
        '  plugins: { local: { rules: { "bad-layout": badLayoutRule } } },',
        '  rules: { "local/bad-layout": "error" },',
        "}];",
        "",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(root, "src", "app.js"), "const answer = 42; /* bad-layout */\n");
    git(root, "add", "eslint.config.js", "src/app.js");
    git(root, "commit", "-q", "-m", "bad layout fixture");

    const before = fs.readFileSync(path.join(root, "src", "app.js"));
    await assert.rejects(() => applyLintDebtRemediation(root), /git diff failed/);
    assert.deepEqual(fs.readFileSync(path.join(root, "src", "app.js")), before);
    assert.equal(git(root, "status", "--porcelain"), "");
  });

  it("refuses to mutate a dirty worktree", async () => {
    const root = createLintFixture();
    fs.writeFileSync(path.join(root, "notes.txt"), "untracked\n");
    await assert.rejects(() => applyLintDebtRemediation(root), /clean Git worktree/);
  });

  it("refuses tracked lint symlinks instead of following them", () => {
    const root = createLintFixture();
    fs.symlinkSync("/etc/hosts", path.join(root, "src", "outside.js"));
    git(root, "add", "src/outside.js");
    git(root, "commit", "-q", "-m", "tracked symlink");
    const policy = validateLintDebtPolicy({ version: 1 });
    assert.throws(() => collectTrackedLintFiles(root, policy), /not a regular file/);
  });
});
