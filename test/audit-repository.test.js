import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { inspectRepository } from "../scripts/audit-repository.js";

/** @type {string[]} */
const fixtures = [];

/** @param {string} root @param {string} path @param {string} contents */
function write(root, path, contents = "") {
  const destination = join(root, path);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, contents);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "repository-audit-"));
  fixtures.push(root);
  return root;
}

afterEach(async () => Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("repository audit", () => {
  it("reports missing core requirements", async () => {
    const root = await fixture();
    write(root, "package.json", JSON.stringify({ scripts: { lint: "eslint ." } }));
    const report = inspectRepository(root);
    assert.equal(report.corePassed, false);
    assert.equal(report.checks.find((check) => check.id === "lint-script")?.passed, true);
    assert.equal(report.checks.find((check) => check.id === "ci-tests")?.passed, false);
  });

  it("recognizes a complete core repository and optional E2E readiness", async () => {
    const root = await fixture();
    write(root, "package.json", JSON.stringify({
      packageManager: "bun@1.2.0",
      scripts: { lint: "eslint .", typecheck: "tsc", test: "node --test", check: "bun run test", build: "vite build", e2e: "playwright test" },
    }));
    for (const path of ["AGENTS.md", "docs/development.md", "tsconfig.json", "scripts/lint-changed.js", "playwright.config.ts"]) write(root, path);
    write(root, ".github/workflows/ci.yml", [
      "steps:",
      "  - run: bun run typecheck",
      "  - run: bun run test",
      "  - run: bun run lint:changed origin/main",
      "  - run: bun run build",
    ].join("\n"));
    const report = inspectRepository(root);
    assert.equal(report.corePassed, true);
    assert.equal(report.checks.every((check) => check.passed), true);
  });
});
