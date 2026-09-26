import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { buildLintDebtCampaign } from "../scripts/lint-debt-campaign.js";
import {
  buildLintDebtBaseline,
  scanLintDebt,
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

/** @param {string} name @param {number} missingSemicolons */
function createFixture(name, missingSemicolons) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lint-campaign-" + name + "-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name, private: true, type: "module" }, null, 2) + "\n",
  );
  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules\n");
  fs.writeFileSync(
    path.join(root, "eslint.config.js"),
    [
      "export default [{",
      "  files: [\"**/*.js\"],",
      "  rules: { semi: [\"error\", \"always\"] },",
      "}];",
      "",
    ].join("\n"),
  );
  const lines = Array.from(
    { length: missingSemicolons },
    (_, index) => "console.log(" + (index + 1) + ")",
  );
  fs.writeFileSync(path.join(root, "src", "app.js"), lines.join("\n") + "\n");
  fs.symlinkSync(path.join(toolkitRoot, "node_modules"), path.join(root, "node_modules"), "dir");
  git(root, "init", "-q", "-b", "main");
  git(root, "add", "package.json", ".gitignore", "eslint.config.js", "src");
  git(root, "commit", "-q", "-m", "fixture");
  return root;
}

/** @param {string} root */
async function writeBaseline(root) {
  const report = await scanLintDebt(root);
  const baseline = buildLintDebtBaseline(report);
  fs.mkdirSync(path.join(root, ".toolkit"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".toolkit", "lint-debt-baseline.json"),
    JSON.stringify(baseline, null, 2) + "\n",
  );
}

describe("lint debt campaign", () => {
  it("prioritizes repositories by safe bounded cleanup opportunity", async () => {
    const small = createFixture("small", 1);
    const large = createFixture("large", 4);

    const report = /** @type {any} */ (await buildLintDebtCampaign([small, large]));

    assert.equal(report.mode, "READ_ONLY_CAMPAIGN");
    assert.equal(report.mutationAuthorized, false);
    assert.equal(report.summary.repositories, 2);
    assert.equal(report.summary.scanned, 2);
    assert.equal(report.summary.failed, 0);
    assert.equal(report.summary.issues, 5);
    assert.equal(report.summary.plannedResolvedProblems, 5);
    assert.equal(report.repositories[0].repository, large);
    assert.equal(report.repositories[0].priority, 1);
    assert.equal(report.repositories[1].repository, small);
    assert.equal(report.repositories[1].priority, 2);
  });

  it("reports compatible baselines without mutating either repository", async () => {
    const baselined = createFixture("baselined", 2);
    const missing = createFixture("missing", 1);
    await writeBaseline(baselined);

    const beforeBaselined = git(baselined, "status", "--short");
    const beforeMissing = git(missing, "status", "--short");
    const report = /** @type {any} */ (await buildLintDebtCampaign([baselined, missing]));
    const byPath = new Map(report.repositories.map((/** @type {any} */ item) => [item.repository, item]));

    assert.equal(byPath.get(baselined).baseline.status, "PASS");
    assert.equal(byPath.get(baselined).baseline.newDebt, 0);
    assert.equal(byPath.get(missing).baseline.status, "MISSING");
    assert.equal(report.summary.baselines.pass, 1);
    assert.equal(report.summary.baselines.missing, 1);
    assert.equal(git(baselined, "status", "--short"), beforeBaselined);
    assert.equal(git(missing, "status", "--short"), beforeMissing);
  });

  it("keeps healthy repository results when another repository cannot be scanned", async () => {
    const healthy = createFixture("healthy", 1);
    const missingPath = path.join(os.tmpdir(), "does-not-exist-" + process.pid);

    const report = /** @type {any} */ (await buildLintDebtCampaign([missingPath, healthy]));

    assert.equal(report.summary.repositories, 2);
    assert.equal(report.summary.scanned, 1);
    assert.equal(report.summary.failed, 1);
    assert.equal(report.repositories[0].repository, healthy);
    assert.equal(report.repositories[1].status, "ERROR");
    assert.match(report.repositories[1].error, /^Lint debt scan failed:/);
  });

  it("deduplicates repeated repository arguments", async () => {
    const root = createFixture("duplicate", 1);

    const report = /** @type {any} */ (await buildLintDebtCampaign([root, root, path.resolve(root)]));

    assert.equal(report.summary.repositories, 1);
    assert.equal(report.summary.scanned, 1);
    assert.equal(report.repositories.length, 1);
  });
});
