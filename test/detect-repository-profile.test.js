import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { detectRepositoryProfile } from "../scripts/detect-repository-profile.js";

test("detects a TypeScript package repository as webapp", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-webapp-"));

  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "webapp-test" }),
  );
  fs.writeFileSync(path.join(root, "tsconfig.json"), "{}\n");

  assert.equal(detectRepositoryProfile(root), "webapp");
});

test("detects a Python repository as python-service", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-python-"));

  fs.writeFileSync(
    path.join(root, "service.py"),
    "print('ok')\n",
  );

  assert.equal(detectRepositoryProfile(root), "python-service");
});

test("returns unknown for unsupported repository shapes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "profile-unknown-"));

  fs.writeFileSync(
    path.join(root, "README.md"),
    "# Example\n",
  );

  assert.equal(detectRepositoryProfile(root), "unknown");
});
