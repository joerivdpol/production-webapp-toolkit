import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatBuildReproducibility,
  inspectBuildReproducibility,
  main,
  validateReproducibilityPolicy,
} from "../scripts/audit-build-reproducibility.js";

/** @param {string|Buffer} value */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "build-repro-"));
  fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
  fs.mkdirSync(path.join(root, "generated"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({
    name: "demo-app",
    version: "1.0.0",
    packageManager: "bun@1.3.14",
    engines: { node: ">=24 <25" },
  }));
  fs.writeFileSync(path.join(root, ".node-version"), "24.21.0\n");
  fs.writeFileSync(path.join(root, "bun.lock"), "lockfile-v1\n");
  fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "steps:\n  - run: bun install --frozen-lockfile\n");
  fs.writeFileSync(path.join(root, "generated", "schema.json"), '{"version":1}\n');
  return root;
}

/** @param {string} root @returns {any} */
function rawPolicy(root) {
  return {
    version: 1,
    packageManager: { name: "bun", expectedVersion: "1.3.14" },
    runtime: { nodeVersionFile: ".node-version", expectedVersion: "24.21.0", requireEngineMajorMatch: true },
    lockfile: { path: "bun.lock", expectedSha256: sha256(fs.readFileSync(path.join(root, "bun.lock"))) },
    frozenInstall: { files: [".github/workflows/ci.yml"], requiredCommands: ["bun install --frozen-lockfile"] },
    generatedInputs: [{ path: "generated/schema.json", sha256: sha256(fs.readFileSync(path.join(root, "generated", "schema.json"))) }],
  };
}

/** @param {string} root */
function policy(root) {
  const result = validateReproducibilityPolicy(rawPolicy(root));
  assert.equal(result.ok, true);
  if (!result.ok || result.policy === null) throw new Error("fixture policy invalid");
  return result.policy;
}

/** @param {any} value */
function writeJson(value) {
  const filename = path.join(os.tmpdir(), `repro-policy-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("complete explicit reproducibility policy passes", () => {
  const root = fixture();
  const report = inspectBuildReproducibility(root, policy(root));
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.summary.fail, 0);
  assert.match(formatBuildReproducibility(report), /Overall: PASS/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("package manager must be exactly pinned and match explicit policy", () => {
  const root = fixture();
  const expected = policy(root);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  pkg.packageManager = "bun@latest";
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  let report = inspectBuildReproducibility(root, expected);
  assert.equal(report.checks.some((item) => item.id === "package-manager-pin" && item.status === "FAIL"), true);

  pkg.packageManager = "npm@11.0.0";
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  report = inspectBuildReproducibility(root, expected);
  assert.equal(report.checks.some((item) => item.id === "package-manager-name" && item.status === "FAIL"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("runtime pin must be exact and engine major must agree", () => {
  const root = fixture();
  const expected = policy(root);
  fs.writeFileSync(path.join(root, ".node-version"), "24\n");
  let report = inspectBuildReproducibility(root, expected);
  assert.equal(report.checks.some((item) => item.id === "runtime-pin" && item.status === "FAIL"), true);

  fs.writeFileSync(path.join(root, ".node-version"), "24.21.0\n");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  pkg.engines.node = ">=23 <24";
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify(pkg));
  report = inspectBuildReproducibility(root, expected);
  assert.equal(report.checks.some((item) => item.id === "runtime-engine-major" && item.status === "FAIL"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("lockfile is regular, non-empty, and can be explicitly hash-bound", () => {
  const root = fixture();
  const expected = policy(root);
  fs.writeFileSync(path.join(root, "bun.lock"), "changed\n");
  let report = inspectBuildReproducibility(root, expected);
  assert.equal(report.checks.some((item) => item.id === "lockfile-hash" && item.status === "FAIL"), true);

  fs.rmSync(path.join(root, "bun.lock"));
  fs.symlinkSync(path.join(root, "package.json"), path.join(root, "bun.lock"));
  report = inspectBuildReproducibility(root, expected);
  assert.equal(report.checks.some((item) => item.id === "lockfile" && item.status === "FAIL"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("frozen install command must appear in an explicit regular CI file", () => {
  const root = fixture();
  const expected = policy(root);
  fs.writeFileSync(path.join(root, ".github", "workflows", "ci.yml"), "# bun install --frozen-lockfile\n- run: bun install\n");
  const report = inspectBuildReproducibility(root, expected);
  assert.equal(report.checks.some((item) => item.id === "frozen-install-command" && item.status === "FAIL"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("generated build inputs are bound only by explicit SHA256 policy", () => {
  const root = fixture();
  const expected = policy(root);
  fs.writeFileSync(path.join(root, "generated", "schema.json"), '{"version":2}\n');
  let report = inspectBuildReproducibility(root, expected);
  assert.equal(report.checks.some((item) => item.id === "generated-input" && item.status === "FAIL"), true);

  const withoutGenerated = rawPolicy(root);
  withoutGenerated.generatedInputs = [];
  withoutGenerated.lockfile.expectedSha256 = sha256(fs.readFileSync(path.join(root, "bun.lock")));
  const validated = validateReproducibilityPolicy(withoutGenerated);
  assert.equal(validated.ok, true);
  if (!validated.ok || validated.policy === null) return;
  report = inspectBuildReproducibility(root, validated.policy);
  assert.equal(report.checks.some((item) => item.id === "generated-input"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("policy rejects traversal, duplicate files, malformed hashes, and unknown fields", () => {
  const root = fixture();
  const traversal = rawPolicy(root);
  traversal.lockfile.path = "../bun.lock";
  assert.equal(validateReproducibilityPolicy(traversal).ok, false);

  const duplicate = rawPolicy(root);
  duplicate.frozenInstall.files.push(duplicate.frozenInstall.files[0] ?? "");
  assert.equal(validateReproducibilityPolicy(duplicate).ok, false);

  const badHash = rawPolicy(root);
  badHash.generatedInputs[0].sha256 = "bad";
  assert.equal(validateReproducibilityPolicy(badHash).ok, false);

  const unknown = rawPolicy(root);
  unknown.executeGenerators = true;
  assert.equal(validateReproducibilityPolicy(unknown).ok, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("expected versions are optional but exact pins remain required", () => {
  const root = fixture();
  const raw = rawPolicy(root);
  delete raw.packageManager.expectedVersion;
  delete raw.runtime.expectedVersion;
  delete raw.lockfile.expectedSha256;
  const validated = validateReproducibilityPolicy(raw);
  assert.equal(validated.ok, true);
  if (!validated.ok || validated.policy === null) return;
  assert.equal(inspectBuildReproducibility(root, validated.policy).overallStatus, "PASS");
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing or malformed repository metadata fails policy without leaking content", () => {
  const root = fixture();
  const expected = policy(root);
  fs.writeFileSync(path.join(root, "package.json"), "{");
  const report = inspectBuildReproducibility(root, expected);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "package-json" && item.status === "FAIL"), true);
  assert.doesNotMatch(formatBuildReproducibility(report), /lockfile-v1|schema.json.*version/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing repository is a technical failure", () => {
  const root = fixture();
  const expected = policy(root);
  fs.rmSync(root, { recursive: true, force: true });
  const report = inspectBuildReproducibility(root, expected);
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.overallStatus, "FAIL");
});

test("CLI emits stable JSON and PASS or FAIL exit semantics", () => {
  const root = fixture();
  const policyFile = writeJson(rawPolicy(root));
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", policyFile, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");

  fs.writeFileSync(path.join(root, "generated", "schema.json"), "changed\n");
  assert.equal(main(["--root", root, "--policy", policyFile]), 1);
  fs.rmSync(policyFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI rejects malformed policy and incomplete arguments", () => {
  const malformed = writeJson("{");
  assert.equal(main(["--root", ".", "--policy", malformed]), 1);
  assert.equal(main(["--root", "."]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("audit stays local, read only, and never executes generators or builds", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-build-reproducibility.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|https?:\/\/|process\.env|writeFile|rmSync|unlinkSync/);
  assert.match(source, /generated input matches explicit SHA256 binding/);
});
