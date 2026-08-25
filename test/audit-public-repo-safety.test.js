import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  inspectPublicRepoSafety,
  formatPublicRepoSafety,
} from "../scripts/audit-public-repo-safety.js";

function createGitRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-safety-"));

  execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync(
    "git",
    ["-C", root, "config", "user.email", "test@example.invalid"],
    { stdio: "ignore" },
  );
  execFileSync(
    "git",
    ["-C", root, "config", "user.name", "Toolkit Test"],
    { stdio: "ignore" },
  );

  return root;
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @param {string} content
 */
function track(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);

  execFileSync("git", ["-C", root, "add", relativePath], {
    stdio: "ignore",
  });
}

test("allows credential fixtures on reserved local test origins", () => {
  const root = createGitRepository();

  track(
    root,
    "test/example.test.js",
    'const target = "http://user:password@localhost:4173/test";\n',
  );

  const report = inspectPublicRepoSafety(root);

  assert.equal(report.passed, true);
  assert.deepEqual(report.findings, []);
});

test("blocks credentialed URLs to public hosts without exposing credentials", () => {
  const root = createGitRepository();

  const fakeUsername = ["public", "user"].join("-");
  const fakePassword = ["super", "secret", "value"].join("-");
  const credentialedUrl = [
    "https://",
    fakeUsername,
    ":",
    fakePassword,
    "@",
    "example.com/api",
  ].join("");

  track(
    root,
    "config/example.js",
    `const target = ${JSON.stringify(credentialedUrl)};
`,
  );

  const report = inspectPublicRepoSafety(root);

  assert.equal(report.passed, false);

  assert.deepEqual(report.findings, [
    {
      rule: "credentialed-url",
      path: "config/example.js",
    },
  ]);

  const formatted = formatPublicRepoSafety(report);

  assert.equal(formatted.includes(fakePassword), false);
  assert.equal(formatted.includes(fakeUsername), false);
});

test("blocks tracked dotenv files but permits example templates", () => {
  const root = createGitRepository();

  track(root, ".env", "SOME_VALUE=example\n");
  track(root, ".env.example", "SOME_VALUE=\n");

  const report = inspectPublicRepoSafety(root);

  assert.equal(report.passed, false);
  assert.deepEqual(report.findings, [
    {
      rule: "dotenv",
      path: ".env",
    },
  ]);
});

test("blocks private key material without printing the key content", () => {
  const root = createGitRepository();

  track(
    root,
    "fixtures/key.txt",
    [
      "-----BEGIN " + "PRIVATE KEY-----",
      "DO-NOT-PRINT-" + "THIS-TEST-SECRET",
      "-----END " + "PRIVATE KEY-----",
      "",
    ].join("\n"),
  );

  const report = inspectPublicRepoSafety(root);

  assert.equal(report.passed, false);

  assert.deepEqual(report.findings, [
    {
      rule: "private-key-content",
      path: "fixtures/key.txt",
    },
  ]);

  assert.doesNotMatch(
    formatPublicRepoSafety(report),
    new RegExp(["DO-NOT-PRINT", "THIS-TEST-SECRET"].join("-")),
  );
});
