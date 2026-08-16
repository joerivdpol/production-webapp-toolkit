import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { aggregateResults, auditRepository, runAll } from "../scripts/audit-all-repositories.js";
import { inspectRepository } from "../scripts/audit-repository.js";

/** @type {string[]} */
const fixtures = [];

/** @param {string} root @param {string} path @param {string=} contents */
function write(root, path, contents = "") {
  const destination = join(root, path);
  mkdirSync(join(destination, ".."), { recursive: true });
  writeFileSync(destination, contents);
}

/** @param {string} cwd @param {...string} args */
function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || result.error?.message || `git ${args[0]} failed`);
  return result.stdout.trim();
}

/** @param {string} worktree */
function inProcessAudit(worktree) {
  const report = inspectRepository(worktree);
  return { status: report.corePassed ? 0 : 1, stdout: JSON.stringify(report), stderr: "" };
}

async function directory(prefix = "audit-all-test-") {
  const root = await mkdtemp(join(tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

/** @param {string} root @param {{e2e?: boolean, core?: boolean}=} options */
function populate(root, { e2e = true, core = true } = {}) {
  /** @type {Record<string, string>} */
  const scripts = {
    lint: "eslint .", typecheck: "tsc", test: "node --test", check: "bun run test", build: "vite build",
    ...(e2e ? { "test:e2e": "playwright test" } : {}),
  };
  if (!core) delete scripts.typecheck;
  write(root, "package.json", JSON.stringify({ packageManager: "bun@1.3.0", scripts }));
  for (const path of ["AGENTS.md", "docs/development.md", "tsconfig.json", "scripts/lint-changed.js"]) write(root, path);
  if (e2e) write(root, "playwright.config.ts");
  write(root, ".github/workflows/ci.yml", [
    "steps:", "  - run: bun run typecheck", "  - run: bun run test", "  - run: bun run lint:changed origin/main", "  - run: bun run build",
    ...(e2e ? ["  - run: bun run test:e2e"] : []),
  ].join("\n"));
}

/** @param {string} projectsRoot @param {string} name @param {{e2e?: boolean, core?: boolean}=} options */
async function repository(projectsRoot, name, options = {}) {
  const remote = join(projectsRoot, `${name}-origin.git`);
  const seed = join(projectsRoot, `${name}-seed`);
  const active = join(projectsRoot, name);
  git(projectsRoot, "init", "--bare", "--initial-branch=main", remote);
  mkdirSync(seed);
  git(seed, "init", "-b", "main");
  git(seed, "config", "user.email", "audit@example.test");
  git(seed, "config", "user.name", "Audit Test");
  populate(seed, options);
  git(seed, "add", ".");
  git(seed, "commit", "-m", "fixture");
  git(seed, "remote", "add", "origin", remote);
  git(seed, "push", "-u", "origin", "main");
  git(projectsRoot, "clone", remote, active);
  git(active, "config", "user.email", "audit@example.test");
  git(active, "config", "user.name", "Audit Test");
  return active;
}

afterEach(async () => Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

describe("multi-repository audit", () => {
  it("aggregates repositories when all pass", async () => {
    const root = await directory();
    await repository(root, "one");
    await repository(root, "two");
    const result = await runAll(["--projects-root", root, "--repo", "one,two", "--no-fetch"], { auditRunner: inProcessAudit });
    assert.equal(result.aggregate.passed, true);
    assert.deepEqual(result.aggregate, { totalScore: 36, totalChecks: 36, coreScore: 26, coreChecks: 26, passed: true });
  });

  it("fails for a missing core check", async () => {
    const root = await directory();
    await repository(root, "broken", { core: false });
    const result = await runAll(["--projects-root", root, "--repo", "broken", "--no-fetch"], { auditRunner: inProcessAudit });
    const audited = result.repositories[0];
    assert.ok(audited);
    assert.equal(audited.coreScore, 12);
    assert.equal(audited.passed, false);
    assert.equal(audited.errors.length, 0);
    assert.equal(result.aggregate.passed, false);
  });

  it("keeps optional E2E score loss non-blocking", async () => {
    const root = await directory();
    await repository(root, "core-only", { e2e: false });
    const result = await runAll(["--projects-root", root, "--repo", "core-only", "--no-fetch"], { auditRunner: inProcessAudit });
    const audited = result.repositories[0];
    assert.ok(audited);
    assert.equal(audited.totalScore, 15);
    assert.equal(audited.coreScore, 13);
    assert.equal(audited.passed, true);
  });

  it("reports missing repositories and missing origin/main", async () => {
    const root = await directory();
    mkdirSync(join(root, "no-origin"));
    git(join(root, "no-origin"), "init");
    const result = await runAll(["--projects-root", root, "--repo", "missing,no-origin", "--no-fetch"]);
    const missingError = result.repositories[0]?.errors[0];
    const originError = result.repositories[1]?.errors[0];
    assert.ok(missingError);
    assert.ok(originError);
    assert.match(missingError, /missing/i);
    assert.match(originError, /origin\/main is missing/i);
    assert.equal(result.aggregate.passed, false);
  });

  it("reports an audit subprocess failure", async () => {
    const root = await directory();
    const temporaryRoot = await directory("audit-all-owned-");
    await repository(root, "one");
    const badScript = join(root, "bad-audit.js");
    write(root, "bad-audit.js", "process.stderr.write('deliberate audit failure'); process.exit(7);\n");
    const result = await auditRepository("one", { projectsRoot: root, fetch: false, temporaryRoot, auditScript: badScript, auditRunner: () => ({ status: 7, stdout: "", stderr: "deliberate audit failure" }) });
    const error = result.errors[0];
    assert.ok(error);
    assert.match(error, /Audit execution failed: deliberate audit failure/);
    assert.equal(result.passed, false);
  });

  it("computes aggregate scores independently", () => {
    const aggregate = aggregateResults([
      { totalScore: 18, totalChecks: 18, coreScore: 13, coreChecks: 13, passed: true, errors: [] },
      { totalScore: 17, totalChecks: 18, coreScore: 13, coreChecks: 13, passed: true, errors: [] },
    ]);
    assert.deepEqual(aggregate, { totalScore: 35, totalChecks: 36, coreScore: 26, coreChecks: 26, passed: true });
  });

  it("produces machine-readable JSON output", async () => {
    const root = await directory();
    await repository(root, "one");
    const result = await runAll(["--projects-root", root, "--repo", "one", "--no-fetch", "--json"], { auditRunner: inProcessAudit });
    const output = JSON.parse(JSON.stringify({ repositories: result.repositories, aggregate: result.aggregate }));
    assert.equal(output.repositories[0].repository, "one");
    assert.match(output.repositories[0].commit, /^[0-9a-f]{40}$/);
    assert.deepEqual(output.aggregate, { totalScore: 18, totalChecks: 18, coreScore: 13, coreChecks: 13, passed: true });
  });

  it("cleans temporary worktrees after success and failure", async () => {
    const root = await directory();
    const temporaryRoot = await directory("audit-all-owned-");
    const active = await repository(root, "one");
    await auditRepository("one", { projectsRoot: root, fetch: false, temporaryRoot, auditRunner: inProcessAudit });
    assert.deepEqual(readdirSync(temporaryRoot), []);
    assert.doesNotMatch(git(active, "worktree", "list", "--porcelain"), /production-webapp-toolkit-audit|audit-all-owned/);

    const badScript = join(root, "bad-audit.js");
    write(root, "bad-audit.js", "process.exit(9);\n");
    await auditRepository("one", { projectsRoot: root, fetch: false, temporaryRoot, auditScript: badScript, auditRunner: () => ({ status: 9, stdout: "", stderr: "failure" }) });
    assert.deepEqual(readdirSync(temporaryRoot), []);
    assert.doesNotMatch(git(active, "worktree", "list", "--porcelain"), /production-webapp-toolkit-audit|audit-all-owned/);
  });

  it("does not modify the active branch or dirty worktree", async () => {
    const root = await directory();
    const active = await repository(root, "one");
    git(active, "switch", "-c", "feature/active-work");
    write(active, "AGENTS.md", "local tracked change\n");
    write(active, "local-uncommitted.txt", "keep me\n");
    const beforeBranch = git(active, "branch", "--show-current");
    const beforeStatus = git(active, "status", "--short");
    const beforeHead = git(active, "rev-parse", "HEAD");

    const result = await runAll(["--projects-root", root, "--repo", "one", "--no-fetch"], { auditRunner: inProcessAudit });
    assert.equal(result.aggregate.passed, true);
    assert.equal(git(active, "branch", "--show-current"), beforeBranch);
    assert.equal(git(active, "status", "--short"), beforeStatus);
    assert.equal(git(active, "rev-parse", "HEAD"), beforeHead);
  });
});
