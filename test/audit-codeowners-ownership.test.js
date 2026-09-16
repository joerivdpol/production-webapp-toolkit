import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  formatCodeownersOwnership,
  inspectCodeownersOwnership,
  main,
  matchesCodeownersPattern,
  parseCodeowners,
  validateOwnershipPolicy,
} from "../scripts/audit-codeowners-ownership.js";

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    codeownersFile: "auto",
    criticalRules: [
      { id: "payments", paths: ["src/payments/**"], requireMatches: true, minimumOwners: 2, requiredOwners: ["@example/backend", "@example/finance"] },
      { id: "migrations", paths: ["db/migrations/**"], requireMatches: false, minimumOwners: 1, requiredOwners: ["@example/db"] },
    ],
    severity: { fileInspection: "FAIL", syntax: "FAIL", criticalPath: "FAIL", requiredOwner: "FAIL" },
  };
}

function policy() {
  const result = validateOwnershipPolicy(rawPolicy());
  assert.equal(result.valid, true);
  if (!result.valid || !result.policy) throw new Error("fixture policy invalid");
  return result.policy;
}

function tempRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codeowners-audit-"));
  assert.equal(spawnSync("git", ["init", "-q"], { cwd: root }).status, 0);
  return root;
}

/** @param {string} root @param {string} file @param {string|Buffer} content */
function tracked(root, file, content = "fixture\n") {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
  assert.equal(spawnSync("git", ["add", "--", file], { cwd: root }).status, 0);
}

function completeRepo(codeowners = "/src/payments/** @example/backend @example/finance\n/db/migrations/** @example/db\n") {
  const root = tempRepo();
  tracked(root, "src/payments/capture.ts", "export {};\n");
  tracked(root, "src/payments/refund.ts", "export {};\n");
  tracked(root, "src/app.ts", "export {};\n");
  tracked(root, ".github/CODEOWNERS", codeowners);
  return root;
}

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `ownership-policy-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("validates explicit ownership policy", () => {
  const result = validateOwnershipPolicy(rawPolicy());
  assert.equal(result.valid, true);
  if (!result.valid || !result.policy) return;
  assert.equal(result.policy.codeownersFile, "auto");
  assert.equal(result.policy.criticalRules.length, 2);
});

test("policy rejects traversal duplicate ids invalid owners and invalid severity", () => {
  const traversal = rawPolicy(); traversal.codeownersFile = "../CODEOWNERS";
  assert.equal(validateOwnershipPolicy(traversal).valid, false);
  const unsupportedLocation = rawPolicy(); unsupportedLocation.codeownersFile = "config/CODEOWNERS";
  assert.equal(validateOwnershipPolicy(unsupportedLocation).valid, false);

  const duplicate = rawPolicy(); duplicate.criticalRules.push(structuredClone(duplicate.criticalRules[0]));
  assert.equal(validateOwnershipPolicy(duplicate).valid, false);

  const owner = rawPolicy(); owner.criticalRules[0].requiredOwners = ["not-an-owner"];
  assert.equal(validateOwnershipPolicy(owner).valid, false);

  const severity = rawPolicy(); severity.severity.syntax = "PASS";
  assert.equal(validateOwnershipPolicy(severity).valid, false);
});

test("CODEOWNERS matcher supports root anchoring basename patterns recursive glob and case sensitivity", () => {
  assert.equal(matchesCodeownersPattern("/src/payments/**", "src/payments/capture.ts"), true);
  assert.equal(matchesCodeownersPattern("*.js", "src/nested/file.js"), true);
  assert.equal(matchesCodeownersPattern("docs/", "docs/guide/readme.md"), true);
  assert.equal(matchesCodeownersPattern("**/logs", "app/logs"), true);
  assert.equal(matchesCodeownersPattern("**/logs", "logs"), true);
  assert.equal(matchesCodeownersPattern("/SRC/**", "src/app.ts"), false);
});

test("parser accepts comments inline comments users teams and emails", () => {
  const parsed = parseCodeowners("# header\n*.js @alice @org/team user@example.com # comment\n");
  assert.equal(parsed.errors.length, 0);
  assert.deepEqual(parsed.rules[0]?.owners, ["@alice", "@org/team", "user@example.com"]);
});

test("parser rejects unsupported negation ranges escaped hash and missing owners", () => {
  const parsed = parseCodeowners("!secret/** @owner\nfile[0-9].js @owner\n\\#literal @owner\n/no-owner/**\n");
  assert.equal(parsed.rules.length, 0);
  assert.equal(parsed.errors.length, 4);
});

test("automatic location priority uses github before root and docs", () => {
  const root = completeRepo();
  tracked(root, "CODEOWNERS", "/src/payments/** @wrong/owner @wrong/second\n");
  tracked(root, "docs/CODEOWNERS", "/src/payments/** @wrong/docs @wrong/second\n");
  const report = inspectCodeownersOwnership(root, policy());
  assert.equal(report.codeownersFile, ".github/CODEOWNERS");
  assert.equal(report.overallStatus, "PASS");
  fs.rmSync(root, { recursive: true, force: true });
});

test("last matching CODEOWNERS pattern wins for critical path ownership", () => {
  const root = completeRepo("/src/payments/** @example/backend @example/finance\n/src/payments/refund.ts @example/backend\n");
  const report = inspectCodeownersOwnership(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "critical-path-insufficient-owners" && item.scope === "src/payments/refund.ts"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("required owners are checked independently of minimum count", () => {
  const root = completeRepo("/src/payments/** @example/backend @example/security\n");
  const report = inspectCodeownersOwnership(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "critical-path-required-owner-missing" && /@example\/finance/.test(item.detail)), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("required critical rule with no tracked files fails while optional empty rule does not", () => {
  const root = completeRepo();
  const raw = rawPolicy();
  raw.criticalRules.push({ id: "auth", paths: ["src/auth/**"], requireMatches: true, minimumOwners: 1, requiredOwners: [] });
  const result = validateOwnershipPolicy(raw);
  assert.equal(result.valid, true);
  if (!result.valid || !result.policy) return;
  const report = inspectCodeownersOwnership(root, result.policy);
  assert.equal(report.checks.some((item) => item.id === "critical-rule-no-files" && item.scope === "auth"), true);
  assert.equal(report.checks.some((item) => item.scope === "migrations"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("invalid CODEOWNERS lines remain explicit syntax findings", () => {
  const root = completeRepo("/src/payments/** @example/backend @example/finance\n!src/** @bad\n");
  const report = inspectCodeownersOwnership(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "codeowners-pattern-invalid"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing CODEOWNERS is blocking and owner access remains unverified", () => {
  const root = tempRepo();
  tracked(root, "src/payments/capture.ts");
  const report = inspectCodeownersOwnership(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks[0]?.id, "codeowners-uninspectable");
  assert.equal(report.ownerAccessStatus, "UNVERIFIED");
  fs.rmSync(root, { recursive: true, force: true });
});

test("CODEOWNERS symlink is never followed", () => {
  const root = tempRepo();
  tracked(root, "src/payments/capture.ts");
  const outside = path.join(os.tmpdir(), `codeowners-outside-${process.pid}`);
  fs.writeFileSync(outside, "/src/payments/** @example/backend @example/finance\n");
  fs.mkdirSync(path.join(root, ".github"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, ".github/CODEOWNERS"));
  assert.equal(spawnSync("git", ["add", "--", ".github/CODEOWNERS"], { cwd: root }).status, 0);
  const report = inspectCodeownersOwnership(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.match(report.checks[0]?.detail ?? "", /not-regular-file/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

test("formatter exposes ownership assignment gaps but never CODEOWNERS contents", () => {
  const root = completeRepo("/src/payments/** @example/backend @secret-team\n");
  const output = formatCodeownersOwnership(inspectCodeownersOwnership(root, policy()));
  assert.match(output, /critical-path-required-owner-missing/);
  assert.match(output, /Owner access: UNVERIFIED/);
  assert.doesNotMatch(output, /@secret-team/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI emits JSON preserves repository and uses FAIL exit semantics", () => {
  const root = completeRepo("/src/payments/** @example/backend\n");
  const policyFile = tempJson(rawPolicy());
  const before = fs.readFileSync(path.join(root, ".github/CODEOWNERS"), "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", policyFile, "--json"]), 1); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "FAIL");
  assert.equal(fs.readFileSync(path.join(root, ".github/CODEOWNERS"), "utf8"), before);
  fs.rmSync(policyFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI rejects malformed policy missing repository and unknown arguments", () => {
  const malformed = tempJson("{");
  const valid = tempJson(rawPolicy());
  assert.equal(main(["--root", "/tmp/missing-codeowners-root", "--policy", valid]), 1);
  assert.equal(main(["--root", ".", "--policy", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  fs.rmSync(valid, { force: true });
});

test("audit operational surface is local read only Git and filesystem inspection", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-codeowners-ownership.js", import.meta.url), "utf8");
  assert.match(source, /spawnSync\("git", \["ls-files", "-z"\]/);
  assert.doesNotMatch(source, /\bfetch\s*\(|https?:\/\/|process\.env|writeFile|rmSync|unlinkSync|git[^\n]*(checkout|reset|clean|commit|push)/i);
});
