import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const root = path.resolve(".");
const script = path.join(root, "scripts", "bootstrap-repository.js");

test("bootstrap dry-run succeeds", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-test-"));

  fs.writeFileSync(
    path.join(temp, "package.json"),
    JSON.stringify({ name: "bootstrap-test" }),
  );

  execFileSync("git", ["init", temp], { stdio: "ignore" });

  const output = execFileSync(
    "node",
    [script, temp, "--dry-run"],
    { encoding: "utf8" },
  );

  assert.match(output, /create AGENTS\.md/);
  assert.match(output, /create docs\/development\.md/);
  assert.match(output, /create \.github\/workflows\/bun-webapp-ci-with-e2e\.yml/);
  assert.match(output, /Bootstrap complete/);
});

test("bootstrap rejects a target without package.json", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-no-package-"));

  assert.throws(
    () =>
      execFileSync(
        "node",
        [script, temp, "--dry-run"],
        { encoding: "utf8", stdio: "pipe" },
      ),
    /STOP: target is missing package\.json/,
  );
});

test("bootstrap rejects a non-git repository", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-no-git-"));

  fs.writeFileSync(
    path.join(temp, "package.json"),
    JSON.stringify({ name: "bootstrap-test" }),
  );

  assert.throws(
    () =>
      execFileSync(
        "node",
        [script, temp, "--dry-run"],
        { encoding: "utf8", stdio: "pipe" },
      ),
    /STOP: target is not a git repository/,
  );
});

test("bootstrap writes standard files without overwriting existing files", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-write-"));

  fs.writeFileSync(
    path.join(temp, "package.json"),
    JSON.stringify({ name: "bootstrap-write-test" }),
  );

  execFileSync("git", ["init", temp], { stdio: "ignore" });

  // Existing repository-specific content must never be overwritten.
  const existingAgents = "# Existing repository instructions\n";
  fs.writeFileSync(path.join(temp, "AGENTS.md"), existingAgents);

  const output = execFileSync(
    "node",
    [script, temp],
    { encoding: "utf8" },
  );

  assert.match(output, /skip existing AGENTS\.md/);
  assert.match(output, /create docs\/development\.md/);
  assert.match(
    output,
    /create \.github\/workflows\/bun-webapp-ci-with-e2e\.yml/,
  );
  assert.match(output, /Bootstrap complete/);

  assert.equal(
    fs.readFileSync(path.join(temp, "AGENTS.md"), "utf8"),
    existingAgents,
  );

  assert.ok(
    fs.existsSync(path.join(temp, "docs", "development.md")),
  );

  assert.ok(
    fs.existsSync(
      path.join(
        temp,
        ".github",
        "workflows",
        "bun-webapp-ci-with-e2e.yml",
      ),
    ),
  );
});



test("bootstrap is idempotent on a second run", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "bootstrap-idempotent-"));

  fs.writeFileSync(
    path.join(temp, "package.json"),
    JSON.stringify({ name: "bootstrap-idempotent-test" }),
  );

  execFileSync("git", ["init", temp], { stdio: "ignore" });

  execFileSync("node", [script, temp], { encoding: "utf8" });

  const agentsBefore = fs.readFileSync(path.join(temp, "AGENTS.md"), "utf8");
  const developmentBefore = fs.readFileSync(
    path.join(temp, "docs", "development.md"),
    "utf8",
  );
  const workflowBefore = fs.readFileSync(
    path.join(
      temp,
      ".github",
      "workflows",
      "bun-webapp-ci-with-e2e.yml",
    ),
    "utf8",
  );

  const secondOutput = execFileSync(
    "node",
    [script, temp],
    { encoding: "utf8" },
  );

  assert.match(secondOutput, /skip existing AGENTS\.md/);
  assert.match(secondOutput, /skip existing docs\/development\.md/);
  assert.match(
    secondOutput,
    /skip existing .*bun-webapp-ci-with-e2e\.yml/,
  );

  assert.equal(
    fs.readFileSync(path.join(temp, "AGENTS.md"), "utf8"),
    agentsBefore,
  );
  assert.equal(
    fs.readFileSync(path.join(temp, "docs", "development.md"), "utf8"),
    developmentBefore,
  );
  assert.equal(
    fs.readFileSync(
      path.join(
        temp,
        ".github",
        "workflows",
        "bun-webapp-ci-with-e2e.yml",
      ),
      "utf8",
    ),
    workflowBefore,
  );
});
