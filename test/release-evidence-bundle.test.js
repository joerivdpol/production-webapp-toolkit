import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  buildReleaseEvidenceBundle,
  formatReleaseEvidenceBundle,
  main,
  validateCycloneDxReleaseSnapshot,
} from "../scripts/release-evidence-bundle.js";

const CREATED = "2026-09-17T10:00:00Z";
const ARTIFACT_HASH = "b".repeat(64);

/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function repository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "release-bundle-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Toolkit Test"]);
  fs.writeFileSync(path.join(root, "app.txt"), "baseline\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "baseline"]);
  const baseline = git(root, ["rev-parse", "HEAD"]);
  fs.writeFileSync(path.join(root, "app.txt"), "release\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "release"]);
  const source = git(root, ["rev-parse", "HEAD"]);
  fs.mkdirSync(path.join(root, "evidence"));
  return { root, baseline, source };
}
/** @param {string} root @param {string} name @param {any} value */
function writeJson(root, name, value) {
  const file = path.join(root, "evidence", name);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

/** @param {string} source */
/** @param {string} source @returns {any} */
function ciRaw(source) {
  return {
    version: 1,
    commit: source,
    ci: { provider: "github-actions", workflow: "CI", runId: "123" },
    evidence: { source: "github", authenticated: true, collectedAt: "2026-09-17T09:45:00Z" },
    checks: [{ name: "quality", status: "PASS" }],
  };
}

/** @param {string} source */
/** @param {string} source @returns {any} */
function provenanceRaw(source) {
  return {
    version: 1,
    source: { commit: source },
    build: {
      ci: { provider: "github-actions", workflow: "CI", runId: "123" },
      artifact: { name: "dist.tgz", sha256: ARTIFACT_HASH },
    },
    deployment: {
      target: "production",
      artifactSha256: ARTIFACT_HASH,
      runtime: { name: "web", environment: "production" },
    },
    evidence: { source: "deploy-manifest", authenticated: true, collectedAt: "2026-09-17T09:50:00Z" },
  };
}
/** @param {string} source */
/** @param {string} source @returns {any} */
function runtimeRaw(source) {
  return {
    version: 1,
    runtime: { name: "web", environment: "production" },
    deployment: { commit: source },
    evidence: { source: "runtime", authenticated: false, collectedAt: "2026-09-17T09:52:00Z" },
  };
}

/** @param {string} [status] @returns {any} */
function healthRaw(status = "HEALTHY") {
  return {
    version: 1,
    runtime: { name: "web", environment: "production" },
    evidence: { source: "health", authenticated: true, collectedAt: "2026-09-17T09:55:00Z" },
    checks: [{ id: "database", category: "database", status, latencyMs: 10 }],
  };
}

/** @returns {any} */
function healthPolicyRaw() {
  return {
    version: 1,
    evaluatedAt: CREATED,
    runtime: { name: "web", environment: "production" },
    maxEvidenceAgeSeconds: 3600,
    freshnessSeverity: "blocking",
    checks: [{ id: "database", severity: "blocking", allowDegraded: false }],
  };
}

/** @param {boolean} [withFinding] @returns {any} */
function vulnerabilityRaw(withFinding = false) {
  return {
    version: 1,
    source: { provider: "osv", authenticated: false, collectedAt: "2026-09-17T09:54:00Z" },
    packages: [{
      ecosystem: "npm",
      name: "react",
      version: "19.2.0",
      relationship: "direct",
      vulnerabilities: withFinding ? [{ id: "GHSA-test-1", aliases: [], severity: "HIGH", fixedVersions: ["19.2.1"] }] : [],
    }],
  };
}
/** @returns {any} */
function vulnerabilityPolicyRaw() {
  return {
    version: 1,
    evaluatedAt: CREATED,
    maxEvidenceAgeSeconds: 3600,
    blockingSeverities: ["HIGH", "CRITICAL"],
    blockingRelationships: ["direct"],
    exceptions: [],
  };
}

/** @param {string} source */
/** @param {string} source @returns {any} */
function sbomRaw(source) {
  return {
    "$schema": "https://cyclonedx.org/schema/bom-1.7.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    metadata: {
      timestamp: "2026-09-17T09:56:00Z",
      component: {
        type: "application",
        name: "example-app",
        version: "1.0.0",
        "bom-ref": "application:example-app@1.0.0",
        hashes: [{ alg: "SHA-256", content: ARTIFACT_HASH }],
      },
      properties: [
        { name: "toolkit:sourceCommit", value: source },
        { name: "toolkit:lockfileSha256", value: "c".repeat(64) },
        { name: "toolkit:nodeVersion", value: "24.18.1" },
        { name: "toolkit:packageManager", value: "bun@1.3.14" },
      ],
    },
    components: [{
      type: "library",
      name: "react",
      version: "19.2.0",
      "bom-ref": "npm:react@19.2.0",
      properties: [{ name: "toolkit:dependencyRelationship", value: "direct" }],
    }],
    dependencies: [],
  };
}
/** @param {{root:string,baseline:string,source:string}} repo @param {{finding?:boolean,healthStatus?:string}} [overrides] @returns {any} */
function bundleOptions(repo, overrides = {}) {
  const files = {
    ciEvidenceFile: writeJson(repo.root, "ci.json", ciRaw(repo.source)),
    sbomFile: writeJson(repo.root, "sbom.json", sbomRaw(repo.source)),
    vulnerabilityEvidenceFile: writeJson(repo.root, "vulnerability.json", vulnerabilityRaw(Boolean(overrides.finding))),
    vulnerabilityPolicyFile: writeJson(repo.root, "vulnerability-policy.json", vulnerabilityPolicyRaw()),
    artifactProvenanceFile: writeJson(repo.root, "provenance.json", provenanceRaw(repo.source)),
    runtimeEvidenceFile: writeJson(repo.root, "runtime.json", runtimeRaw(repo.source)),
    runtimeHealthEvidenceFile: writeJson(repo.root, "health.json", healthRaw(overrides.healthStatus ?? "HEALTHY")),
    runtimeHealthPolicyFile: writeJson(repo.root, "health-policy.json", healthPolicyRaw()),
  };
  return {
    root: repo.root,
    sourceCommit: repo.source,
    baselineCommit: repo.baseline,
    createdAt: CREATED,
    ...files,
    policyFiles: [],
  };
}

/** @param {string} file */
function hashFile(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

test("validates a bounded CycloneDX release dependency snapshot", () => {
  const result = validateCycloneDxReleaseSnapshot(sbomRaw("a".repeat(40)));
  assert.equal(result.valid, true, result.error ?? undefined);
  if (!result.valid || !result.snapshot) return;
  assert.equal(result.snapshot.sourceCommit, "a".repeat(40));
  assert.equal(result.snapshot.artifactSha256, ARTIFACT_HASH);
  assert.deepEqual(result.snapshot.componentRefs, ["npm:react@19.2.0"]);
});

test("CycloneDX release snapshot rejects missing timestamp duplicate components and invalid source binding", () => {
  const missingTime = sbomRaw("a".repeat(40));
  delete missingTime.metadata.timestamp;
  assert.equal(validateCycloneDxReleaseSnapshot(missingTime).valid, false);
  const duplicate = sbomRaw("a".repeat(40));
  duplicate.components.push(structuredClone(duplicate.components[0]));
  assert.equal(validateCycloneDxReleaseSnapshot(duplicate).valid, false);
  const source = sbomRaw("a".repeat(40));
  source.metadata.properties[0].value = "not-a-commit";
  assert.equal(validateCycloneDxReleaseSnapshot(source).valid, false);
});

test("coherent release evidence produces a VALID hash-bound bundle", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  const bundle = buildReleaseEvidenceBundle(repo.root, options);

  assert.equal(bundle.bundleStatus, "VALID");
  assert.equal(bundle.summary.fail, 0);
  assert.equal(bundle.source.commit, repo.source);
  assert.equal(bundle.baseline.commit, repo.baseline);
  assert.equal(bundle.baseline.relationship, "expected-ancestor-of-comparison");
  assert.equal(bundle.results.artifactProvenance, "PASS");
  assert.equal(bundle.results.runtimeHealth, "PASS");
  assert.equal(bundle.results.vulnerabilities, "PASS");
  assert.equal(bundle.evidenceIndex.length, 8);
  const ciIndex = bundle.evidenceIndex.find((item) => item.id === "ci-evidence");
  assert.equal(ciIndex?.sha256, hashFile(options.ciEvidenceFile));
  assert.equal("file" in (ciIndex ?? {}), false);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("security FAIL remains visible without making a coherent bundle invalid", () => {
  const repo = repository();
  const bundle = buildReleaseEvidenceBundle(repo.root, bundleOptions(repo, { finding: true }));
  assert.equal(bundle.bundleStatus, "VALID");
  assert.equal(bundle.results.vulnerabilities, "FAIL");
  assert.equal(bundle.results.vulnerabilityFindings, 1);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("runtime health FAIL remains visible without changing bundle coherence", () => {
  const repo = repository();
  const bundle = buildReleaseEvidenceBundle(repo.root, bundleOptions(repo, { healthStatus: "UNHEALTHY" }));
  assert.equal(bundle.bundleStatus, "VALID");
  assert.equal(bundle.results.runtimeHealth, "FAIL");
  assert.match(bundle.semantics, /preserved/);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("commit identity mismatch makes the bundle itself INVALID", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  const wrong = ciRaw(repo.baseline);
  fs.writeFileSync(options.ciEvidenceFile, JSON.stringify(wrong));
  const bundle = buildReleaseEvidenceBundle(repo.root, options);
  assert.equal(bundle.bundleStatus, "INVALID");
  assert.equal(bundle.checks.some((item) => item.id === "ci-source-commit" && item.status === "FAIL"), true);
  assert.equal(bundle.checks.some((item) => item.id === "artifact-provenance-coherent" && item.status === "FAIL"), true);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("SBOM artifact hash mismatch makes bundle INVALID", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  const bad = sbomRaw(repo.source);
  bad.metadata.component.hashes[0].content = "d".repeat(64);
  fs.writeFileSync(options.sbomFile, JSON.stringify(bad));
  const bundle = buildReleaseEvidenceBundle(repo.root, options);
  assert.equal(bundle.bundleStatus, "INVALID");
  assert.equal(bundle.checks.some((item) => item.id === "sbom-artifact-hash" && item.status === "FAIL"), true);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("runtime health identity mismatch makes bundle INVALID even though health audit also fails", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  const bad = healthRaw();
  bad.runtime.name = "other-runtime";
  fs.writeFileSync(options.runtimeHealthEvidenceFile, JSON.stringify(bad));
  const bundle = buildReleaseEvidenceBundle(repo.root, options);
  assert.equal(bundle.bundleStatus, "INVALID");
  assert.equal(bundle.results.runtimeHealth, "FAIL");
  assert.equal(bundle.checks.some((item) => item.id === "health-runtime-name" && item.status === "FAIL"), true);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("vulnerability package not present in dependency snapshot makes bundle INVALID", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  const bad = vulnerabilityRaw();
  bad.packages[0].name = "missing-package";
  fs.writeFileSync(options.vulnerabilityEvidenceFile, JSON.stringify(bad));
  const bundle = buildReleaseEvidenceBundle(repo.root, options);
  assert.equal(bundle.bundleStatus, "INVALID");
  assert.equal(bundle.checks.some((item) => item.id.includes("missing-package") && item.status === "FAIL"), true);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("future-dated canonical evidence makes bundle INVALID", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  const bad = runtimeRaw(repo.source);
  bad.evidence.collectedAt = "2026-09-17T10:01:00Z";
  fs.writeFileSync(options.runtimeEvidenceFile, JSON.stringify(bad));
  const bundle = buildReleaseEvidenceBundle(repo.root, options);
  assert.equal(bundle.bundleStatus, "INVALID");
  assert.equal(bundle.checks.some((item) => item.id === "runtime-evidence-time" && item.status === "FAIL"), true);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("audit policies must share the exact bundle evaluation clock", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  const bad = vulnerabilityPolicyRaw();
  bad.evaluatedAt = "2026-09-17T09:59:59Z";
  fs.writeFileSync(options.vulnerabilityPolicyFile, JSON.stringify(bad));
  assert.throws(
    () => buildReleaseEvidenceBundle(repo.root, options),
    /exact bundle createdAt evaluation time/,
  );
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("unresolvable baseline commit makes bundle INVALID but preserves other evidence", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  options.baselineCommit = "f".repeat(40);
  const bundle = buildReleaseEvidenceBundle(repo.root, options);
  assert.equal(bundle.bundleStatus, "INVALID");
  assert.equal(bundle.results.artifactProvenance, "PASS");
  assert.equal(bundle.checks.some((item) => item.id === "baseline-resolvable" && item.status === "FAIL"), true);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("extra private policy files are hashed without exposing paths or contents", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  const marker = "PRIVATE_POLICY_PAYLOAD_883";
  const policyFile = writeJson(repo.root, "private-policy.json", { marker, required: true });
  options.policyFiles = [{ id: "organization-policy", file: policyFile }];
  const bundle = buildReleaseEvidenceBundle(repo.root, options);
  const entry = bundle.evidenceIndex.find((item) => item.id === "organization-policy");
  assert.equal(entry?.sha256, hashFile(policyFile));
  assert.equal(JSON.stringify(bundle).includes(marker), false);
  assert.equal(JSON.stringify(bundle).includes(policyFile), false);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("extra policy ids must be unique portable and cannot collide with reserved evidence ids", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  const policyFile = writeJson(repo.root, "extra-policy.json", { version: 1 });
  options.policyFiles = [
    { id: "organization-policy", file: policyFile },
    { id: "organization-policy", file: policyFile },
  ];
  assert.throws(() => buildReleaseEvidenceBundle(repo.root, options), /unique portable non-reserved/);
  options.policyFiles = [{ id: "ci-evidence", file: policyFile }];
  assert.throws(() => buildReleaseEvidenceBundle(repo.root, options), /unique portable non-reserved/);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("symlinked evidence input is rejected before bundling", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  const original = options.ciEvidenceFile;
  const link = path.join(repo.root, "evidence", "ci-link.json");
  fs.symlinkSync(original, link);
  options.ciEvidenceFile = link;
  assert.throws(
    () => buildReleaseEvidenceBundle(repo.root, options),
    /bounded non-empty regular file/,
  );
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("human summary exposes statuses and hashes but no evidence payloads", () => {
  const repo = repository();
  const options = bundleOptions(repo, { finding: true });
  const marker = "SENSITIVE_EVIDENCE_MARKER_551";
  const vulnerability = vulnerabilityRaw(true);
  vulnerability.packages[0].vulnerabilities[0].aliases = [marker];
  fs.writeFileSync(options.vulnerabilityEvidenceFile, JSON.stringify(vulnerability));
  const output = formatReleaseEvidenceBundle(buildReleaseEvidenceBundle(repo.root, options));
  assert.match(output, /Release Evidence Bundle v1/);
  assert.match(output, /Vulnerabilities: FAIL/);
  assert.doesNotMatch(output, new RegExp(marker));
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("CLI emits a stable VALID bundle for coherent evidence", () => {
  const repo = repository();
  const options = bundleOptions(repo);
  const args = [
    "--root", repo.root,
    "--source-commit", repo.source,
    "--baseline-commit", repo.baseline,
    "--created-at", CREATED,
    "--ci-evidence-file", options.ciEvidenceFile,
    "--sbom-file", options.sbomFile,
    "--vulnerability-evidence-file", options.vulnerabilityEvidenceFile,
    "--vulnerability-policy-file", options.vulnerabilityPolicyFile,
    "--artifact-provenance-file", options.artifactProvenanceFile,
    "--runtime-evidence-file", options.runtimeEvidenceFile,
    "--runtime-health-evidence-file", options.runtimeHealthEvidenceFile,
    "--runtime-health-policy-file", options.runtimeHealthPolicyFile,
    "--json",
  ];  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(args), 0); }
  finally { console.log = originalLog; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.bundleStatus, "VALID");
  assert.equal(parsed.source.commit, repo.source);
  fs.rmSync(repo.root, { recursive: true, force: true });
});

test("CLI rejects incomplete input and source remains local/read-only apart from reading evidence", () => {
  assert.equal(main(["--unknown"]), 1);
  const source = fs.readFileSync(new URL("../scripts/release-evidence-bundle.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|writeFile|copyFile|renameSync|rmSync|unlinkSync|process\.env/);
  assert.match(source, /validateCiEvidence/);
  assert.match(source, /validateArtifactProvenance/);
  assert.match(source, /validateRuntimeEvidence/);
  assert.match(source, /validateRuntimeHealthEvidence/);
  assert.match(source, /validateVulnerabilityEvidence/);
  assert.match(source, /inspectProductionBaseline/);
});