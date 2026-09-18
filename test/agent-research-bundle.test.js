import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildAgentResearchBundle,
  formatAgentResearchBundle,
  main,
  validateAgentResearchBundleInput,
  validateAgentResearchBundleManifest,
  verifyAgentResearchBundle,
} from "../scripts/agent-research-bundle.js";

const T0 = "2026-09-18T02:00:00Z";
const TRUN = "2026-09-18T02:03:00Z";
const T1 = "2026-09-18T02:05:00Z";
const COMMIT = "a".repeat(40);
const TEST_HASH = "b".repeat(64);

/** @param {Buffer|string} value */
function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
function syntheticBearer() { return ["Bear", "er ", "abcdefghijklmnopqrstuvwxyz012345"].join(""); }
function syntheticPrivateKeyBlock() { return ["-----BEGIN ", "PRIVATE ", "KEY-----\nabc\n-----END ", "PRIVATE ", "KEY-----"].join(""); }
function syntheticGithubToken() { return ["gh", "p_", "abcdefghijklmnopqrstuvwxyz1234567890"].join(""); }
function syntheticProviderKey() { return ["s", "k-", "abcdefghijklmnopqrstuvwxyz123456"].join(""); }

/** @param {string} [commit] */
function rawTask(commit = COMMIT) {
  return {
    version: 1,
    id: "task:research",
    role: "reproduce",
    repository: { id: "demo-repo", baseCommit: commit },
    createdAt: T0,
    risk: "LOW",
    objective: "Capture bounded research evidence for a known synthetic failure",
    authority: {
      filesystem: "WORKTREE_WRITE",
      shell: "NONE",
      network: "NONE",
      merge: false,
      deploy: false,
      productionMutation: false,
    },
    scope: {
      allowedPaths: ["test/**"],
      deniedPaths: ["src/private/**"],
      requiredChecks: ["test"],
    },
    dependsOn: ["task:diagnose"],
  };
}

/** @param {string} [commit] */
function runEvidence(commit = COMMIT) {
  return {
    version: 1,
    taskId: "task:research",
    repository: { id: "demo-repo", commit },
    testPath: "test/regression.test.js",
    testSha256: TEST_HASH,
    collectedAt: TRUN,
    runner: "sandbox-runner",
    outcome: "FAIL",
    exitCode: 1,
    trust: { source: "sandbox", authenticated: false },
  };
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agent-research-bundle-"));
  const evidenceFile = path.join(root, "sanitized-evidence.json");
  const output = path.join(root, "bundle");
  fs.writeFileSync(evidenceFile, JSON.stringify({
    status: "FAIL",
    summary: "Synthetic assertion mismatch",
    paths: ["src/value.js", "test/regression.test.js"],
    metrics: { failures: 1, attempts: 1 },
  }));
  return { root, evidenceFile, output };
}

/** @param {ReturnType<typeof fixture>} f @param {{reproduction?:boolean,createdAt?:string}} [overrides] */
function rawInput(f, overrides = {}) {
  const reproduction = overrides.reproduction ?? true;
  return {
    version: 1,
    bundleId: "research:synthetic-1",
    createdAt: overrides.createdAt ?? T1,
    tools: [
      { id: "bun", version: "1.3.14" },
      { id: "node", version: "24.21.0" },
    ],
    evidence: [{
      id: "failure-evidence",
      kind: "test-failure",
      file: f.evidenceFile,
      sanitization: "CALLER_SANITIZED",
    }],
    commands: [
      { id: "inspect-runtime", toolId: "node", cwd: ".", args: ["--version"], purpose: "INSPECT" },
      { id: "reproduce-test", toolId: "bun", cwd: ".", args: ["test", "test/regression.test.js"], purpose: "REPRODUCE" },
    ],
    reproduction: reproduction
      ? { commandId: "reproduce-test", runEvidence: runEvidence() }
      : { commandId: null, runEvidence: null },
  };
}

test("input validates tools sanitized evidence commands and reproduction", () => {
  const f = fixture();
  try {
    const result = validateAgentResearchBundleInput(rawInput(f));
    assert.equal(result.valid, true, JSON.stringify(result.errors));
    assert.equal(result.input?.tools.length, 2);
    assert.equal(result.input?.evidence[0]?.sanitization, "CALLER_SANITIZED");
    assert.equal(result.input?.reproduction.runEvidence?.outcome, "FAIL");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("input rejects ids tool drift unsafe cwd and secret-like args", () => {
  const f = fixture();
  try {
    const duplicate = /** @type {any} */ (rawInput(f));
    duplicate.tools.push({ ...duplicate.tools[0] });
    assert.equal(validateAgentResearchBundleInput(duplicate).valid, false);
    const tool = /** @type {any} */ (rawInput(f));
    tool.commands[0].toolId = "missing-tool";
    assert.equal(validateAgentResearchBundleInput(tool).valid, false);
    const cwd = /** @type {any} */ (rawInput(f));
    cwd.commands[0].cwd = "../outside";
    assert.equal(validateAgentResearchBundleInput(cwd).valid, false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("input rejects secret-like command arguments", () => {
  const f = fixture();
  try {
    const input = /** @type {any} */ (rawInput(f));
    input.commands[0].args = [syntheticBearer()];
    assert.equal(validateAgentResearchBundleInput(input).valid, false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("build copies exact evidence without persisting source paths or objective", () => {
  const f = fixture();
  try {
    const sourceBytes = fs.readFileSync(f.evidenceFile);
    const report = buildAgentResearchBundle(rawTask(), rawInput(f), f.output);
    assert.equal(report.overallStatus, "PASS");
    assert.equal(report.executionPerformed, false);
    assert.equal(report.manifest.repository.commit, COMMIT);
    const entry = /** @type {any} */ (report.manifest.evidence[0]);
    assert.equal(entry.sha256, digest(sourceBytes));
    assert.equal(entry.bytes, sourceBytes.length);
    const copied = fs.readFileSync(path.join(f.output, ...entry.relativePath.split("/")));
    assert.deepEqual(copied, sourceBytes);
    const serialized = JSON.stringify(report.manifest);
    assert.equal(serialized.includes(f.evidenceFile), false);
    assert.equal(serialized.includes("Capture bounded research evidence"), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("bundle output uses private directory and file permissions", () => {
  if (process.platform !== "linux") return;
  const f = fixture();
  try {
    const report = buildAgentResearchBundle(rawTask(), rawInput(f), f.output);
    const entry = /** @type {any} */ (report.manifest.evidence[0]);
    assert.equal(fs.statSync(f.output).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(f.output, "evidence")).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(f.output, "research-bundle.json")).mode & 0o777, 0o600);
    assert.equal(
      fs.statSync(path.join(f.output, ...entry.relativePath.split("/"))).mode & 0o777,
      0o600,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("verification detects exact evidence tampering", () => {
  const f = fixture();
  try {
    const built = buildAgentResearchBundle(rawTask(), rawInput(f), f.output);
    const entry = /** @type {any} */ (built.manifest.evidence[0]);
    const copied = path.join(f.output, ...entry.relativePath.split("/"));
    fs.writeFileSync(copied, JSON.stringify({ status: "PASS", summary: "tampered" }));
    const report = verifyAgentResearchBundle(f.output);
    assert.equal(report.overallStatus, "FAIL");
    assert.equal(report.checks.some((check) => check.id === "hash:failure-evidence" && check.status === "FAIL"), true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("verification rejects undeclared extra files and symlinks", () => {
  const f = fixture();
  try {
    buildAgentResearchBundle(rawTask(), rawInput(f), f.output);
    fs.writeFileSync(path.join(f.output, "extra.txt"), "unexpected\n");
    let report = verifyAgentResearchBundle(f.output);
    assert.equal(report.overallStatus, "FAIL");
    assert.equal(
      report.checks.some((check) => check.id === "declared:extra.txt" && check.status === "FAIL"),
      true,
    );
    fs.rmSync(path.join(f.output, "extra.txt"));
    fs.mkdirSync(path.join(f.output, "unexpected-directory"));
    report = verifyAgentResearchBundle(f.output);
    assert.equal(report.overallStatus, "FAIL");
    assert.equal(report.checks.some((check) => check.id === "directory:unexpected-directory" && check.status === "FAIL"), true);
    fs.rmdirSync(path.join(f.output, "unexpected-directory"));
    fs.symlinkSync(path.join(f.output, "research-bundle.json"), path.join(f.output, "alias.json"));
    report = verifyAgentResearchBundle(f.output);
    assert.equal(report.overallStatus, "FAIL");
    assert.equal(
      report.checks.some((check) => check.id === "symlink:alias.json" && check.status === "FAIL"),
      true,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("structural hygiene rejects sensitive evidence keys", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.evidenceFile, JSON.stringify({ api_key: "synthetic", status: "FAIL" }));
    assert.throws(() => buildAgentResearchBundle(rawTask(), rawInput(f), f.output), /sensitive-key/);
    assert.equal(fs.existsSync(f.output), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("structural hygiene catches split private key names", () => {
  const f = fixture();
  try {
    fs.writeFileSync(f.evidenceFile, JSON.stringify({ private_key: "synthetic", status: "FAIL" }));
    assert.throws(() => buildAgentResearchBundle(rawTask(), rawInput(f), f.output), /sensitive-key/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("structural hygiene rejects common secret value patterns", () => {
  const samples = [
    { value: syntheticPrivateKeyBlock() },
    { value: syntheticBearer() },
    { value: syntheticGithubToken() },
    { value: syntheticProviderKey() },
  ];
  for (const sample of samples) {
    const f = fixture();
    try {
      fs.writeFileSync(f.evidenceFile, JSON.stringify(sample));
      assert.throws(() => buildAgentResearchBundle(rawTask(), rawInput(f), f.output), /sensitive-value/);
    } finally {
      fs.rmSync(f.root, { recursive: true, force: true });
    }
  }
});

test("symlinked evidence fails before bundle creation", () => {
  const f = fixture();
  try {
    const link = path.join(f.root, "evidence-link.json");
    fs.symlinkSync(f.evidenceFile, link);
    const input = /** @type {any} */ (rawInput(f));
    input.evidence[0].file = link;
    assert.throws(() => buildAgentResearchBundle(rawTask(), input, f.output), /symlinks/);
    assert.equal(fs.existsSync(f.output), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("task repository binding and reproduction chronology fail closed", () => {
  const f = fixture();
  try {
    const mismatch = /** @type {any} */ (rawInput(f));
    mismatch.reproduction.runEvidence.repository.commit = "c".repeat(40);
    assert.throws(
      () => buildAgentResearchBundle(rawTask(), mismatch, f.output),
      /exact Agent Task repository commit/,
    );
    const future = rawInput(f, { createdAt: "2026-09-18T02:02:00Z" });
    assert.throws(
      () => buildAgentResearchBundle(rawTask(), future, f.output),
      /cannot precede reproduction run evidence/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("canonical reproduction evidence stays metadata rather than authentication proof", () => {
  const f = fixture();
  try {
    const report = buildAgentResearchBundle(rawTask(), rawInput(f), f.output);
    assert.equal(report.manifest.reproduction.commandId, "reproduce-test");
    assert.equal(report.manifest.reproduction.runEvidence?.outcome, "FAIL");
    assert.equal(report.manifest.reproduction.runEvidence?.trust.authenticated, false);
    assert.match(report.manifest.reproduction.semantics, /metadata unless separately cryptographically verified/);
    assert.equal(report.manifest.summary.reproductionReported, true);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("research bundle stores declarative commands but never executes them", () => {
  const f = fixture();
  const marker = path.join(f.root, "should-not-exist.marker");
  try {
    const input = rawInput(f, { reproduction: false });
    input.commands.push({
      id: "would-write",
      toolId: "node",
      cwd: ".",
      args: ["-e", "require('fs').writeFileSync('should-not-exist.marker','x')"],
      purpose: "TEST",
    });
    const report = buildAgentResearchBundle(rawTask(), input, f.output);
    assert.equal(report.overallStatus, "PASS");
    assert.equal(fs.existsSync(marker), false);
    assert.equal(verifyAgentResearchBundle(f.output).executionPerformed, false);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("manifest rejects traversal secret command args and summary drift", () => {
  const f = fixture();
  try {
    const report = buildAgentResearchBundle(rawTask(), rawInput(f), f.output);
    const traversal = structuredClone(report.manifest);
    traversal.evidence[0].relativePath = "../outside.json";
    assert.equal(validateAgentResearchBundleManifest(traversal).valid, false);
    const secret = structuredClone(report.manifest);
    secret.commands[0].args = [syntheticBearer()];
    assert.equal(validateAgentResearchBundleManifest(secret).valid, false);
    const summary = structuredClone(report.manifest);
    summary.summary.evidence = 99;
    assert.equal(validateAgentResearchBundleManifest(summary).valid, false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("bundle output refuses paths inside git metadata", () => {
  const f = fixture();
  try {
    const gitDir = path.join(f.root, ".git");
    fs.mkdirSync(gitDir);
    assert.throws(
      () => buildAgentResearchBundle(rawTask(), rawInput(f), path.join(gitDir, "research")),
      /must not be inside .git/,
    );
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("CLI builds and verifies the same bounded bundle", () => {
  const f = fixture();
  const taskFile = path.join(f.root, "task.json");
  const inputFile = path.join(f.root, "input.json");
  fs.writeFileSync(taskFile, JSON.stringify(rawTask()));
  fs.writeFileSync(inputFile, JSON.stringify(rawInput(f)));
  const originalLog = console.log;
  const originalError = console.error;
  let output = "";
  console.log = (...values) => { output += values.join(" ") + "\n"; };
  console.error = () => {};
  try {
    assert.equal(main(["build", "--task", taskFile, "--input", inputFile, "--output", f.output, "--json"]), 0);
    assert.equal(JSON.parse(output.trim()).overallStatus, "PASS");
    output = "";
    assert.equal(main(["verify", "--bundle", f.output, "--json"]), 0);
    assert.equal(JSON.parse(output.trim()).overallStatus, "PASS");
    assert.equal(main(["build", "--unknown", "x"]), 1);
  } finally {
    console.log = originalLog;
    console.error = originalError;
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("human format states bounded semantics without raw evidence content", () => {
  const f = fixture();
  try {
    const report = buildAgentResearchBundle(rawTask(), rawInput(f), f.output);
    const output = formatAgentResearchBundle(report);
    assert.match(output, /Agent Research Bundle v1/);
    assert.match(output, /Overall: PASS/);
    assert.doesNotMatch(output, /Synthetic assertion mismatch/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("evidence paths are content independent and source paths never persist", () => {
  const f = fixture();
  try {
    const report = buildAgentResearchBundle(rawTask(), rawInput(f), f.output);
    const entry = /** @type {any} */ (report.manifest.evidence[0]);
    assert.match(entry.relativePath, /^evidence\/001-[0-9a-f]{16}\.json$/);
    assert.equal("file" in entry, false);
    assert.equal(JSON.stringify(report).includes(f.root), false);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("research bundle source has no execution network environment or implicit clock surface", () => {
  const source = fs.readFileSync(new URL("../scripts/agent-research-bundle.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execSync|fetch\(|https?:\/\//);
  assert.doesNotMatch(source, /process\.env|Date\.now\(\)/);
  assert.doesNotMatch(source, /shell\s*:\s*true/);
  assert.match(source, /validateAgentTask/);
  assert.match(source, /validateAgentReproductionRunEvidence/);
});

test("public research bundle template is valid and contains no maintainer infrastructure", () => {
  const file = new URL("../templates/agent-research-bundle-input.v1.json", import.meta.url);
  const rawText = fs.readFileSync(file, "utf8");
  const raw = JSON.parse(rawText);
  const result = validateAgentResearchBundleInput(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.doesNotMatch(rawText, /endpoint|hostname|ssh|privateInfrastructure|maintainerService/i);
});
