import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  formatDeploymentVerification,
  inspectDeploymentVerification,
  main,
} from "../scripts/audit-deployment-verification.js";

/** @type {string[]} */
const fixtures = [];

/** @param {string} prefix */
function temporaryDirectory(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

/** @param {string} root @param {string} name */
function writeCommit(root, name) {
  const filename = `${name}.txt`;
  fs.writeFileSync(path.join(root, filename), `${name}\n`);
  git(root, ["add", filename]);
  git(root, ["commit", "-m", name]);
  return git(root, ["rev-parse", "HEAD"]);
}

/** @param {{ objectFormat?: "sha1" | "sha256" }} [options] */
function createRepository(options = {}) {
  const root = temporaryDirectory("deployment-verification-");
  const initArguments = ["init", "-b", "main"];
  if (options.objectFormat === "sha256") initArguments.push("--object-format=sha256");
  initArguments.push(root);
  execFileSync("git", initArguments, { stdio: "ignore" });
  git(root, ["config", "user.email", "test@example.invalid"]);
  git(root, ["config", "user.name", "Toolkit Test"]);
  return { root, initial: writeCommit(root, "initial") };
}

/** @param {string} commit @returns {{ version: number, runtime: { name: string, environment?: string }, deployment: { commit: string }, evidence: { source: string, authenticated: boolean, collectedAt: string }, metadata?: Record<string, unknown> }} */
function validRuntimeEvidence(commit) {
  return {
    version: 1,
    runtime: { name: "synthetic-runtime", environment: "synthetic-environment" },
    deployment: { commit },
    evidence: {
      source: "synthetic-source",
      authenticated: false,
      collectedAt: "2026-09-01T12:00:00Z",
    },
  };
}

/** @param {string} root @param {unknown} content */
function writeEvidenceFile(root, content) {
  const filename = path.join(root, `runtime-evidence-${fixtures.length}.json`);
  fs.writeFileSync(filename, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return filename;
}

/** @param {...string} args */
function runCli(...args) {
  return spawnSync("node", [path.resolve("scripts/audit-deployment-verification.js"), ...args], {
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const root of fixtures.splice(0).reverse()) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("matches a deployed commit against an explicitly resolved expected ref", () => {
  const { root, initial } = createRepository();
  const report = inspectDeploymentVerification(root, {
    expectedRef: "main",
    deployedCommit: initial,
  });

  assert.equal(report.expectedResolvedCommit, initial);
  assert.equal(report.baselineStatus, "MATCH");
  assert.equal(report.deploymentStatus, "MATCH");
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "PASS");
});

test("matches a deployed commit against an explicitly resolved expected commit", () => {
  const { root, initial } = createRepository();
  const report = inspectDeploymentVerification(root, {
    expectedCommit: initial,
    deployedCommit: initial,
  });

  assert.equal(report.baselineStatus, "MATCH");
  assert.equal(report.deploymentStatus, "MATCH");
  assert.equal(report.overallStatus, "PASS");
});

test("matches when expected ref and expected commit are consistently declared", () => {
  const { root, initial } = createRepository();
  const report = inspectDeploymentVerification(root, {
    expectedRef: "main",
    expectedCommit: initial,
    deployedCommit: initial,
  });

  assert.equal(report.baselineStatus, "MATCH");
  assert.equal(report.deploymentStatus, "MATCH");
});

test("reports a valid differing deployment as non-technical MISMATCH", () => {
  const { root, initial } = createRepository();
  const deployed = writeCommit(root, "deployed-difference");
  git(root, ["branch", "production-baseline", initial]);
  const report = inspectDeploymentVerification(root, {
    expectedRef: "production-baseline",
    deployedCommit: deployed,
  });

  assert.equal(report.deploymentStatus, "MISMATCH");
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "WARN");
  assert.equal(main([root, "--expected-ref", "production-baseline", "--deployed-commit", deployed]), 0);
});

test("keeps an unavailable expected ref unverified without asserting remote absence", () => {
  const { root, initial } = createRepository();
  const report = inspectDeploymentVerification(root, {
    expectedRef: "origin/production/not-locally-fetched",
    deployedCommit: initial,
  });

  assert.equal(report.baselineStatus, "UNVERIFIED");
  assert.equal(report.deploymentStatus, "UNVERIFIED");
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "WARN");
  assert.match(
    report.checks.find((check) => check.id === "expected-ref")?.detail ?? "",
    /does not establish whether a remote ref exists/,
  );
  assert.equal(
    main([
      root,
      "--expected-ref",
      "origin/production/not-locally-fetched",
      "--deployed-commit",
      initial,
    ]),
    0,
  );
});

test("keeps an unavailable expected commit unverified", () => {
  const { root, initial } = createRepository();
  const report = inspectDeploymentVerification(root, {
    expectedCommit: "a".repeat(40),
    deployedCommit: initial,
  });

  assert.equal(report.baselineStatus, "UNVERIFIED");
  assert.equal(report.deploymentStatus, "UNVERIFIED");
  assert.equal(report.overallStatus, "WARN");
});

test("does not choose either side of an inconsistent expected ref and commit contract", () => {
  const { root, initial } = createRepository();
  const current = writeCommit(root, "current");
  const report = inspectDeploymentVerification(root, {
    expectedRef: "main",
    expectedCommit: initial,
    deployedCommit: current,
  });

  assert.equal(report.baselineStatus, "MISMATCH");
  assert.equal(report.expectedResolvedCommit, null);
  assert.equal(report.deploymentStatus, "UNVERIFIED");
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "WARN");
  assert.match(
    report.checks.find((check) => check.id === "deployment-baseline")?.detail ?? "",
    /inconsistent/,
  );
});

test("reports invalid and missing targets as technical failures", () => {
  const { initial } = createRepository();
  const missing = path.join(os.tmpdir(), "deployment-verification-no-such-target");
  const nonGit = temporaryDirectory("deployment-verification-non-git-");

  for (const target of [missing, nonGit]) {
    const report = inspectDeploymentVerification(target, {
      expectedRef: "main",
      deployedCommit: initial,
    });
    assert.equal(report.deploymentStatus, "UNVERIFIED");
    assert.equal(report.technicalStatus, "FAIL");
    assert.equal(report.overallStatus, "FAIL");
  }

  assert.equal(runCli(missing, "--expected-ref", "main", "--deployed-commit", initial).status, 1);
});

test("CLI rejects absent selectors, deployed evidence, and unknown options", () => {
  const { root, initial } = createRepository();

  for (const result of [
    runCli(root, "--deployed-commit", initial),
    runCli(root, "--expected-ref", "main"),
    runCli(root, "--expected-ref", "main", "--deployed-commit", initial, "--unknown"),
  ]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});

test("CLI rejects abbreviated, symbolic, and revision-expression deployed commits", () => {
  const { root, initial } = createRepository();
  const invalidValues = [initial.slice(0, 12), "HEAD", "main", "HEAD~1", "main^", "abc123"];

  for (const deployedCommit of invalidValues) {
    const result = runCli(root, "--expected-ref", "main", "--deployed-commit", deployedCommit);
    assert.equal(result.status, 1, deployedCommit);
    assert.match(result.stderr, /40-or-64-hex-object-id/, deployedCommit);
  }
});

test("normalizes full uppercase object IDs before comparison", () => {
  const { root, initial } = createRepository();
  const report = inspectDeploymentVerification(root, {
    expectedRef: "main",
    deployedCommit: initial.toUpperCase(),
  });

  assert.equal(report.deployedCommit, initial);
  assert.equal(report.deploymentStatus, "MATCH");
});

test("accepts a validated SHA-1 evidence file and retains its trust metadata", () => {
  const { root, initial } = createRepository();
  const filename = writeEvidenceFile(root, validRuntimeEvidence(initial));
  const result = runCli(root, "--expected-ref", "main", "--evidence-file", filename, "--json");

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.deployedCommit, initial);
  assert.equal(report.deploymentStatus, "MATCH");
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.evidence, {
    type: "runtime-evidence",
    source: "synthetic-source",
    authenticated: false,
    collectedAt: "2026-09-01T12:00:00Z",
    runtime: { name: "synthetic-runtime", environment: "synthetic-environment" },
  });
});

test("accepts a validated SHA-256 evidence file", () => {
  const { root, initial } = createRepository({ objectFormat: "sha256" });
  assert.equal(initial.length, 64);
  const filename = writeEvidenceFile(root, validRuntimeEvidence(initial));
  const result = runCli(root, "--expected-ref", "main", "--evidence-file", filename, "--json");

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.deploymentStatus, "MATCH");
  assert.equal(report.deployedCommit, initial);
});

test("normalizes uppercase evidence commits through the runtime evidence validator", () => {
  const { root, initial } = createRepository();
  const evidence = validRuntimeEvidence(initial.toUpperCase());
  const result = runCli(root, "--expected-ref", "main", "--evidence-file", writeEvidenceFile(root, evidence), "--json");

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.deployedCommit, initial);
  assert.equal(report.deploymentStatus, "MATCH");
});

test("evidence files preserve non-technical mismatch and unavailable-baseline semantics", () => {
  const { root, initial } = createRepository();
  const different = writeCommit(root, "deployment-difference");
  git(root, ["branch", "production-baseline", initial]);
  const mismatch = runCli(
    root,
    "--expected-ref",
    "production-baseline",
    "--evidence-file",
    writeEvidenceFile(root, validRuntimeEvidence(different)),
    "--json",
  );
  assert.equal(mismatch.status, 0);
  assert.equal(JSON.parse(mismatch.stdout).deploymentStatus, "MISMATCH");
  assert.equal(JSON.parse(mismatch.stdout).overallStatus, "WARN");

  const unavailable = runCli(
    root,
    "--expected-ref",
    "origin/production/not-locally-fetched",
    "--evidence-file",
    writeEvidenceFile(root, validRuntimeEvidence(initial)),
    "--json",
  );
  assert.equal(unavailable.status, 0);
  assert.equal(JSON.parse(unavailable.stdout).deploymentStatus, "UNVERIFIED");
  assert.equal(JSON.parse(unavailable.stdout).overallStatus, "WARN");
});

test("authenticated runtime evidence remains trust metadata, not deployment truth", () => {
  const { root, initial } = createRepository();
  const different = writeCommit(root, "authenticated-difference");
  git(root, ["branch", "production-baseline", initial]);
  const evidence = validRuntimeEvidence(different);
  evidence.evidence.authenticated = true;
  delete evidence.runtime.environment;
  const result = runCli(
    root,
    "--expected-ref",
    "production-baseline",
    "--evidence-file",
    writeEvidenceFile(root, evidence),
    "--json",
  );

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.deploymentStatus, "MISMATCH");
  assert.equal(report.overallStatus, "WARN");
  assert.deepEqual(report.evidence, {
    type: "runtime-evidence",
    source: "synthetic-source",
    authenticated: true,
    collectedAt: "2026-09-01T12:00:00Z",
    runtime: { name: "synthetic-runtime" },
  });
});

test("rejects invalid, malformed, and inaccessible evidence files as CLI input failures", () => {
  const { root, initial } = createRepository();
  /** @type {[string, (evidence: ReturnType<typeof validRuntimeEvidence>) => void][]} */
  const invalidEvidence = [
    ["HEAD", (evidence) => { evidence.deployment.commit = "HEAD"; }],
    ["abbreviated", (evidence) => { evidence.deployment.commit = initial.slice(0, 12); }],
    ["unknown-field", (evidence) => { /** @type {Record<string, unknown>} */ (evidence).unexpected = true; }],
    ["timestamp", (evidence) => { evidence.evidence.collectedAt = "not-a-timestamp"; }],
    ["metadata", (evidence) => { evidence.metadata = { apiToken: "synthetic" }; }],
  ];

  for (const [name, mutate] of invalidEvidence) {
    const evidence = validRuntimeEvidence(initial);
    mutate(evidence);
    const result = runCli(root, "--expected-ref", "main", "--evidence-file", writeEvidenceFile(root, evidence));
    assert.equal(result.status, 1, name);
    assert.match(result.stderr, /Runtime Evidence Contract v1/, name);
  }

  for (const invalidFile of [
    { name: "malformed", filename: writeEvidenceFile(root, "{"), expected: /malformed JSON/ },
    { name: "missing", filename: path.join(root, "missing-runtime-evidence.json"), expected: /could not be read/ },
  ]) {
    const result = runCli(root, "--expected-ref", "main", "--evidence-file", invalidFile.filename);
    assert.equal(result.status, 1, invalidFile.name);
    assert.match(result.stderr, invalidFile.expected, invalidFile.name);
  }
});

test("evidence-file CLI mode is exclusive, stable, clear, and does not change input", () => {
  const { root, initial } = createRepository();
  const filename = writeEvidenceFile(root, validRuntimeEvidence(initial));
  const original = fs.readFileSync(filename, "utf8");

  for (const result of [
    runCli(root, "--expected-ref", "main", "--deployed-commit", initial, "--evidence-file", filename),
    runCli(root, "--expected-ref", "main"),
    runCli(root, "--expected-ref", "main", "--unknown", "--evidence-file", filename),
    runCli(root, "--expected-ref", "main", "--evidence-file"),
  ]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }

  const json = runCli(root, "--expected-ref", "main", "--evidence-file", filename, "--json");
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).evidence.type, "runtime-evidence");
  const human = runCli(root, "--expected-ref", "main", "--evidence-file", filename);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /validated Runtime Evidence Contract v1/);
  assert.equal(fs.readFileSync(filename, "utf8"), original);
});

test("keeps invalid in-process deployed evidence unverified", () => {
  const invalidValues = ["HEAD", "abc123", "HEAD~1"];

  for (const deployedCommit of invalidValues) {
    const { root } = createRepository();
    const report = inspectDeploymentVerification(root, {
      expectedRef: "main",
      deployedCommit,
    });

    assert.equal(report.deploymentStatus, "UNVERIFIED", deployedCommit);
    assert.notEqual(report.deploymentStatus, "MISMATCH", deployedCommit);
    assert.equal(report.technicalStatus, "PASS", deployedCommit);
    assert.equal(report.overallStatus, "WARN", deployedCommit);
    assert.equal(
      report.checks.find((check) => check.id === "deployment-evidence")?.severity,
      "WARN",
      deployedCommit,
    );
    assert.match(
      report.checks.find((check) => check.id === "deployment-evidence")?.detail ?? "",
      /valid full 40- or 64-character hex object ID/,
    );
  }
});

test("does not let direct callers forge runtime-evidence provenance or bypass commit validation", () => {
  const { root } = createRepository();
  /** @type {{ type: "runtime-evidence", source: string, authenticated: boolean, collectedAt: string, runtime: { name: string } }} */
  const forgedEvidence = {
    type: "runtime-evidence",
    source: "forged-source",
    authenticated: true,
    collectedAt: "2026-09-01T12:00:00Z",
    runtime: { name: "forged-runtime" },
  };

  for (const deployedCommit of ["HEAD", "abc123", "HEAD~1"]) {
    const report = inspectDeploymentVerification(root, {
      expectedRef: "main",
      deployedCommit,
      evidence: forgedEvidence,
    });

    assert.equal(report.deploymentStatus, "UNVERIFIED", deployedCommit);
    assert.notEqual(report.deploymentStatus, "MISMATCH", deployedCommit);
    assert.equal(report.technicalStatus, "PASS", deployedCommit);
    assert.equal(report.overallStatus, "WARN", deployedCommit);
    assert.deepEqual(report.evidence, {
      type: "explicit-commit",
      source: "caller-supplied",
      authenticated: false,
    });
    assert.doesNotMatch(
      formatDeploymentVerification(report),
      /validated Runtime Evidence Contract v1/,
      deployedCommit,
    );
  }
});

test("delegates baseline revision-expression restrictions unchanged", () => {
  const { root, initial } = createRepository();
  const result = runCli(root, "--expected-ref", "HEAD~1", "--deployed-commit", initial, "--json");

  assert.equal(result.status, 0);
  const report = JSON.parse(result.stdout);
  assert.equal(report.baselineStatus, "UNVERIFIED");
  assert.equal(report.deploymentStatus, "UNVERIFIED");
});

test("does not infer a baseline from production-like local branches", () => {
  const { root, initial } = createRepository();
  git(root, ["branch", "production/blue", initial]);
  const report = inspectDeploymentVerification(root, { deployedCommit: initial });

  assert.equal(report.expectedRef, null);
  assert.equal(report.expectedCommit, null);
  assert.equal(report.expectedResolvedCommit, null);
  assert.equal(report.baselineStatus, "UNVERIFIED");
  assert.equal(report.deploymentStatus, "UNVERIFIED");
});

test("JSON and human output expose the stable deployment and trust contract", () => {
  const { root, initial } = createRepository();
  const jsonResult = runCli(root, "--expected-ref", "main", "--deployed-commit", initial, "--json");

  assert.equal(jsonResult.status, 0);
  const report = JSON.parse(jsonResult.stdout);
  for (const field of [
    "root",
    "expectedRef",
    "expectedCommit",
    "expectedResolvedCommit",
    "baselineStatus",
    "deployedCommit",
    "deploymentStatus",
    "technicalStatus",
    "overallStatus",
    "checks",
    "evidence",
  ]) {
    assert.ok(field in report, `expected ${field} JSON field`);
  }
  assert.deepEqual(report.evidence, {
    type: "explicit-commit",
    source: "caller-supplied",
    authenticated: false,
  });

  const human = formatDeploymentVerification(
    inspectDeploymentVerification(root, { expectedRef: "main", deployedCommit: initial }),
  );
  for (const label of ["Expected baseline", "Deployed commit", "Deployment status", "Technical", "Overall"]) {
    assert.match(human, new RegExp(label));
  }
});

test("the deployment layer reuses the canonical validator and adds no runtime or network command surface", () => {
  const source = fs.readFileSync(path.resolve("scripts/audit-deployment-verification.js"), "utf8");

  assert.match(source, /inspectProductionBaseline/);
  assert.match(source, /import \{ validateRuntimeEvidence \} from "\.\/runtime-evidence\.js"/);
  assert.match(source, /validateRuntimeEvidence\(input\)/);
  for (const forbidden of ["child_process", "spawnSync", "execFile", "readGit", "fetch", "process.env", "https://", "http://"]) {
    assert.equal(source.includes(forbidden), false, `forbidden ${forbidden} surface`);
  }
});
