import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  adaptStrykerMutationReport,
  buildStrykerMutationConfig,
  buildStrykerMutationEvidence,
  formatStrykerMutationEvidence,
  main,
  validateStrykerMutationPolicy,
} from "../scripts/stryker-mutation-integration.js";

const COLLECTED = "2026-09-18T12:30:00Z";
const STRYKER_BIN = path.resolve("node_modules/.bin/stryker");

/** @param {Buffer|string} value */
function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {string} cwd @param {string[]} args */
function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "stryker-integration-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(
    path.join(root, "src", "calc.js"),
    "export function add(a, b) { return a + b; }\n",
  );
  fs.writeFileSync(
    path.join(root, "test", "calc.test.js"),
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import { add } from "../src/calc.js";',
      'test("add", () => assert.equal(add(1, 2), 3));',
      "",
    ].join("\n"),
  );
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "stryker-fixture", private: true, type: "module" }),
  );
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Toolkit Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "fixture"]);
  return { root, commit: git(root, ["rev-parse", "HEAD"]) };
}

/** @param {string} commit @param {Partial<any>} [overrides] @returns {any} */
function rawPolicy(commit, overrides = {}) {
  return {
    version: 1,
    repository: { id: "demo-repo", commit },
    strykerVersion: "10.0.0",
    mutate: ["src/calc.js"],
    testCommand: "node --test test/calc.test.js",
    concurrency: 1,
    timeoutMs: 5000,
    maxMutants: 100,
    minimumValidMutants: 1,
    minimumMutationScore: 50,
    maxSurvived: 10,
    maxNoCoverage: 10,
    maxInvalidMutants: 10,
    ...overrides,
  };
}

/** @param {any} policy @param {string[]} [statuses] @returns {any} */
function rawReport(policy, statuses = ["Killed", "Survived"]) {
  return {
    schemaVersion: "1.0",
    thresholds: { high: 80, low: 60, break: null },
    framework: {
      name: "StrykerJS",
      version: "10.0.0",
      branding: { homepageUrl: "https://example.invalid/unused" },
    },
    projectRoot: "/private/project/root",
    config: {
      testRunner: "command",
      commandRunner: { command: policy.testCommand },
      coverageAnalysis: "off",
      mutate: [...policy.mutate],
      reporters: ["json"],
      jsonReporter: { fileName: "reports/mutation/mutation.json" },
      concurrency: policy.concurrency,
      timeoutMS: policy.timeoutMs,
      inPlace: false,
      incremental: false,
      thresholds: { high: policy.minimumMutationScore, low: policy.minimumMutationScore, break: null },
    },
    testFiles: {
      "test/calc.test.js": {
        tests: [{ id: "test-1", name: "private test name" }],
      },
    },
    files: {
      "src/calc.js": {
        language: "javascript",
        source: "PRIVATE_SOURCE_MARKER",
        mutants: statuses.map((status, index) => ({
          id: String(index),
          mutatorName: "SyntheticMutator",
          replacement: "PRIVATE_REPLACEMENT_MARKER",
          statusReason: "PRIVATE_FAILURE_STACK_MARKER",
          status,
          location: {
            start: { line: 1, column: 0 },
            end: { line: 1, column: 1 },
          },
        })),
      },
    },
  };
}

test("policy accepts exact source scope and test-only command", () => {
  const result = validateStrykerMutationPolicy(rawPolicy("a".repeat(40)));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.deepEqual(result.policy?.mutate, ["src/calc.js"]);
  assert.equal(result.policy?.testCommand, "node --test test/calc.test.js");
});

test("policy rejects globs traversal duplicates version drift and shell control", () => {
  const base = "a".repeat(40);
  const cases = [
    rawPolicy(base, { mutate: ["src/*.js"] }),
    rawPolicy(base, { mutate: ["../src/calc.js"] }),
    rawPolicy(base, { mutate: ["src/calc.js", "src/calc.js"] }),
    rawPolicy(base, { strykerVersion: "9.0.0" }),
    rawPolicy(base, { testCommand: "node --test test/calc.test.js; rm -rf ." }),
    rawPolicy(base, { testCommand: "bun run deploy" }),
    rawPolicy(base, { testCommand: "node --test /tmp/outside.test.js" }),
    rawPolicy(base, { testCommand: "node --test ../outside.test.js" }),
    rawPolicy(base, { concurrency: 0 }),
    rawPolicy(base, { timeoutMs: 999 }),
    rawPolicy(base, { maxMutants: 0 }),
    rawPolicy(base, { minimumValidMutants: 0 }),
    rawPolicy(base, { minimumValidMutants: 101 }),
    rawPolicy(base, { minimumMutationScore: 101 }),
    rawPolicy(base, { maxSurvived: -1 }),
    rawPolicy(base, { maxNoCoverage: -1 }),
    rawPolicy(base, { maxInvalidMutants: -1 }),
  ];
  for (const candidate of cases) {
    assert.equal(validateStrykerMutationPolicy(candidate).valid, false);
  }
});

test("config adapter emits bounded command-runner JSON only", () => {
  const config = buildStrykerMutationConfig(rawPolicy("a".repeat(40)));
  assert.equal(config.testRunner, "command");
  assert.equal(config.commandRunner.command, "node --test test/calc.test.js");
  assert.equal(config.coverageAnalysis, "off");
  assert.deepEqual(config.mutate, ["src/calc.js"]);
  assert.deepEqual(config.reporters, ["json"]);
  assert.equal(config.jsonReporter.fileName, "reports/mutation/mutation.json");
  assert.equal(config.concurrency, 1);
  assert.equal(config.timeoutMS, 5000);
  assert.equal(config.inPlace, false);
  assert.equal(config.incremental, false);
  assert.deepEqual(config.thresholds, { high: 50, low: 50, break: null });
});

test("report adapter computes mutation score and strips private report payloads", () => {
  const policyResult = validateStrykerMutationPolicy(rawPolicy("a".repeat(40)));
  assert.equal(policyResult.valid, true);
  if (!policyResult.valid || !policyResult.policy) throw new Error("policy fixture invalid");
  const raw = rawReport(policyResult.policy, ["Killed", "Survived", "Timeout", "NoCoverage"]);
  const bytes = Buffer.from(JSON.stringify(raw));
  const evidence = adaptStrykerMutationReport(raw, policyResult.policy, COLLECTED, { sha256: digest(bytes), bytes: bytes.length });
  assert.equal(evidence.summary.detected, 2);
  assert.equal(evidence.summary.undetected, 2);
  assert.equal(evidence.summary.valid, 4);
  assert.equal(evidence.summary.mutationScore, 50);
  assert.equal(evidence.assessmentStatus, "PASS");
  assert.equal(evidence.overallStatus, "PASS");
  const serialized = JSON.stringify(evidence);
  assert.doesNotMatch(serialized, /PRIVATE_SOURCE_MARKER|PRIVATE_REPLACEMENT_MARKER|PRIVATE_FAILURE_STACK_MARKER|private test name|private\/project\/root/);
});

test("quality policy fails survived no-coverage invalid pending and insufficient mutant evidence", () => {
  const base = "a".repeat(40);
  const cases = [
    [rawPolicy(base, { maxSurvived: 0 }), ["Killed", "Survived"], "max-survived"],
    [rawPolicy(base, { maxNoCoverage: 0 }), ["Killed", "NoCoverage"], "max-no-coverage"],
    [rawPolicy(base, { maxInvalidMutants: 0 }), ["Killed", "CompileError"], "max-invalid-mutants"],
    [rawPolicy(base), ["Killed", "Pending"], "no-pending-mutants"],
    [rawPolicy(base, { minimumValidMutants: 3 }), ["Killed", "Killed"], "minimum-valid-mutants"],
    [rawPolicy(base, { minimumMutationScore: 75 }), ["Killed", "Survived"], "minimum-mutation-score"],
  ];
  for (const [rawPolicyValue, statuses, failedCheck] of cases) {
    const policyResult = validateStrykerMutationPolicy(rawPolicyValue);
    assert.equal(policyResult.valid, true);
    if (!policyResult.valid || !policyResult.policy) throw new Error("policy fixture invalid");
    const raw = rawReport(policyResult.policy, statuses);
    const bytes = Buffer.from(JSON.stringify(raw));
    const evidence = adaptStrykerMutationReport(raw, policyResult.policy, COLLECTED, { sha256: digest(bytes), bytes: bytes.length });
    assert.equal(evidence.evidenceStatus, "VALID");
    assert.equal(evidence.overallStatus, "FAIL");
    assert.equal(evidence.checks.some((check) => check.id === failedCheck && check.status === "FAIL"), true);
  }
});

test("report adapter rejects config drift file scope drift duplicate mutant ids and excessive mutants", () => {
  const base = "a".repeat(40);
  const policyResult = validateStrykerMutationPolicy(rawPolicy(base));
  assert.equal(policyResult.valid, true);
  if (!policyResult.valid || !policyResult.policy) throw new Error("policy fixture invalid");
  const policy = policyResult.policy;

  const inPlace = rawReport(policy); inPlace.config.inPlace = true;
  assert.throws(() => adaptStrykerMutationReport(inPlace, policy, COLLECTED, { sha256: "a".repeat(64), bytes: 1 }), /bounded non-in-place/);

  const wrongFile = rawReport(policy); wrongFile.files["src/other.js"] = wrongFile.files["src/calc.js"];
  assert.throws(() => adaptStrykerMutationReport(wrongFile, policy, COLLECTED, { sha256: "a".repeat(64), bytes: 1 }), /file set/);

  const duplicate = rawReport(policy, ["Killed", "Killed"]);
  duplicate.files["src/calc.js"].mutants[1].id = "0";
  assert.throws(() => adaptStrykerMutationReport(duplicate, policy, COLLECTED, { sha256: "a".repeat(64), bytes: 1 }), /identity or status/);

  const limited = validateStrykerMutationPolicy(rawPolicy(base, { maxMutants: 1 }));
  assert.equal(limited.valid, true);
  if (!limited.valid || !limited.policy) throw new Error("limited policy invalid");
  assert.throws(() => adaptStrykerMutationReport(rawReport(limited.policy, ["Killed", "Killed"]), limited.policy, COLLECTED, { sha256: "a".repeat(64), bytes: 1 }), /exceeds policy maxMutants/);
});

test("evidence builder binds exact repository HEAD and report bytes", () => {
  const repo = repository();
  try {
    const policy = rawPolicy(repo.commit);
    const policyResult = validateStrykerMutationPolicy(policy);
    assert.equal(policyResult.valid, true);
    if (!policyResult.valid || !policyResult.policy) throw new Error("policy fixture invalid");
    const raw = rawReport(policyResult.policy, ["Killed", "Survived"]);
    const reportFile = path.join(repo.root, "mutation.json");
    fs.writeFileSync(reportFile, JSON.stringify(raw));
    const bytes = fs.readFileSync(reportFile);
    const evidence = buildStrykerMutationEvidence(repo.root, policy, reportFile, COLLECTED);
    assert.equal(evidence.repository.commit, repo.commit);
    assert.equal(evidence.report.sha256, digest(bytes));
    assert.equal(evidence.report.bytes, bytes.length);
    const wrong = rawPolicy("c".repeat(40));
    assert.throws(() => buildStrykerMutationEvidence(repo.root, wrong, reportFile, COLLECTED), /HEAD does not match/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("evidence builder rejects dirty tracked source and untracked mutation targets", () => {
  const repo = repository();
  try {
    const policy = rawPolicy(repo.commit);
    const policyResult = validateStrykerMutationPolicy(policy);
    assert.equal(policyResult.valid, true);
    if (!policyResult.valid || !policyResult.policy) throw new Error("policy fixture invalid");
    const reportFile = path.join(repo.root, "mutation.json");
    fs.writeFileSync(reportFile, JSON.stringify(rawReport(policyResult.policy, ["Killed"])));
    fs.writeFileSync(path.join(repo.root, "src", "calc.js"), "export function add(a,b){ return a - b; }\n");
    assert.throws(() => buildStrykerMutationEvidence(repo.root, policy, reportFile, COLLECTED), /tracked files must match/);
    git(repo.root, ["checkout", "--", "src/calc.js"]);
    fs.writeFileSync(path.join(repo.root, "src", "extra.js"), "export const extra = 1;\n");
    const untrackedPolicy = rawPolicy(repo.commit, { mutate: ["src/extra.js"] });
    const untrackedResult = validateStrykerMutationPolicy(untrackedPolicy);
    assert.equal(untrackedResult.valid, true);
    if (!untrackedResult.valid || !untrackedResult.policy) throw new Error("untracked policy invalid");
    fs.writeFileSync(reportFile, JSON.stringify(rawReport(untrackedResult.policy, ["Killed"])));
    assert.throws(() => buildStrykerMutationEvidence(repo.root, untrackedPolicy, reportFile, COLLECTED), /must be tracked/);
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("CLI emits config and uses mutation assessment for evidence exit status", () => {
  const repo = repository();
  const policyFile = path.join(repo.root, "policy.json");
  const reportFile = path.join(repo.root, "mutation.json");
  const passPolicy = rawPolicy(repo.commit);
  fs.writeFileSync(policyFile, JSON.stringify(passPolicy));
  const policyResult = validateStrykerMutationPolicy(passPolicy);
  assert.equal(policyResult.valid, true);
  if (!policyResult.valid || !policyResult.policy) throw new Error("policy fixture invalid");
  fs.writeFileSync(reportFile, JSON.stringify(rawReport(policyResult.policy, ["Killed", "Survived"])));
  const originalLog = console.log, originalError = console.error; console.log = () => {}; console.error = () => {};
  try {
    assert.equal(main(["config", "--policy", policyFile, "--json"]), 0);
    assert.equal(main(["evidence", "--policy", policyFile, "--report", reportFile, "--repository-root", repo.root, "--collected-at", COLLECTED, "--json"]), 0);
    const failPolicy = rawPolicy(repo.commit, { minimumMutationScore: 100, maxSurvived: 0 });
    fs.writeFileSync(policyFile, JSON.stringify(failPolicy));
    assert.equal(main(["evidence", "--policy", policyFile, "--report", reportFile, "--repository-root", repo.root, "--collected-at", COLLECTED, "--json"]), 1);
    assert.equal(main([]), 1);
  } finally {
    console.log = originalLog; console.error = originalError;
    fs.rmSync(repo.root, { recursive: true, force: true });
  }
});

test("real Stryker 10 command-runner report adapts to PASS evidence", () => {
  const repo = repository();
  try {
    const policy = rawPolicy(repo.commit, {
      minimumMutationScore: 100,
      maxSurvived: 0,
      maxNoCoverage: 0,
      maxInvalidMutants: 0,
    });
    const config = buildStrykerMutationConfig(policy);
    fs.writeFileSync(path.join(repo.root, "stryker.conf.json"), JSON.stringify(config, null, 2));
    const run = spawnSync(STRYKER_BIN, ["run", "stryker.conf.json"], {
      cwd: repo.root,
      encoding: "utf8",
      timeout: 20000,
      maxBuffer: 8 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "" },
    });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    const reportFile = path.join(repo.root, "reports", "mutation", "mutation.json");
    assert.equal(fs.existsSync(reportFile), true);
    const evidence = buildStrykerMutationEvidence(repo.root, policy, reportFile, COLLECTED);
    assert.equal(evidence.source.version, "10.0.0");
    assert.equal(evidence.summary.valid >= 1, true);
    assert.equal(evidence.summary.survived, 0);
    assert.equal(evidence.summary.noCoverage, 0);
    assert.equal(evidence.summary.mutationScore, 100);
    assert.equal(evidence.overallStatus, "PASS");
  } finally { fs.rmSync(repo.root, { recursive: true, force: true }); }
});

test("human evidence format reports score without private Stryker payloads", () => {
  const policyResult = validateStrykerMutationPolicy(rawPolicy("a".repeat(40)));
  assert.equal(policyResult.valid, true);
  if (!policyResult.valid || !policyResult.policy) throw new Error("policy fixture invalid");
  const raw = rawReport(policyResult.policy, ["Killed", "Survived"]);
  const bytes = Buffer.from(JSON.stringify(raw));
  const evidence = adaptStrykerMutationReport(raw, policyResult.policy, COLLECTED, { sha256: digest(bytes), bytes: bytes.length });
  const output = formatStrykerMutationEvidence(evidence);
  assert.match(output, /Mutation score: 50/);
  assert.match(output, /Assessment: PASS/);
  assert.doesNotMatch(output, /PRIVATE_|private test name|private\/project/);
});

test("public Stryker policy template is valid and contains no private infrastructure", () => {
  const file = new URL("../templates/stryker-mutation-policy.v1.json", import.meta.url);
  const rawText = fs.readFileSync(file, "utf8");
  const result = validateStrykerMutationPolicy(JSON.parse(rawText));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.doesNotMatch(rawText, /endpoint|hostname|ssh|token|password|privateInfrastructure/i);
});

test("integration adapter never executes Stryker or package managers itself", () => {
  const source = fs.readFileSync(new URL("../scripts/stryker-mutation-integration.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node_modules\/\.bin\/stryker|@stryker-mutator\/core|spawnSync\(["'](?:bun|npm|pnpm|yarn|node)/);
  assert.equal((source.match(/spawnSync\(/g) ?? []).length, 2);
  assert.equal((source.match(/spawnSync\("git"/g) ?? []).length, 2);
  assert.doesNotMatch(source, /fetch\(|https?:\/\//);
});
