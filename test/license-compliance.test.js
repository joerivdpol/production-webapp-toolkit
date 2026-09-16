import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { generateSbom } from "../scripts/generate-sbom.js";
import {
  main as evidenceMain,
  normalizeLicenseExpression,
  validateLicenseEvidence,
} from "../scripts/license-evidence.js";
import {
  collectInstalledLicenseEvidence,
  main as collectorMain,
  packageTargetsFromSbom,
  scanInstalledPackageLicenses,
} from "../scripts/collect-installed-license-evidence.js";
import {
  inspectLicensePolicy,
  main as auditMain,
  validateLicensePolicy,
} from "../scripts/audit-licenses.js";

const COMMIT = "a".repeat(40);
const ARTIFACT_SHA = "b".repeat(64);
const COLLECTED_AT = "2026-09-16T15:45:00Z";

/** @param {number} byte */
function sri(byte) {
  return `sha512-${Buffer.alloc(64, byte).toString("base64")}`;
}

function lockText() {
  const value = {
    lockfileVersion: 1,
    configVersion: 1,
    workspaces: { "": { name: "demo-app", dependencies: { prod: "1.0.0" }, devDependencies: { dev: "2.0.0" } } },
    packages: {
      prod: ["prod@1.0.0", "", { dependencies: { transitive: "3.0.0" } }, sri(1)],
      dev: ["dev@2.0.0", "", {}, sri(2)],
      transitive: ["transitive@3.0.0", "", {}, sri(3)],
    },
  };
  return JSON.stringify(value, null, 2);
}

/** @param {string} root @param {string} name @param {string} version @param {unknown} license */
function writePackage(root, name, version, license) {
  const directory = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name, version, license }));
  return directory;
}

/** @param {{ prodLicense?:unknown, devLicense?:unknown, transitiveLicense?:unknown }} [options] */
function tempRelease(options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-license-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "demo-app", version: "1.2.3", packageManager: "bun@1.3.14" }));
  fs.writeFileSync(path.join(root, ".node-version"), "24.21.0\n");
  fs.writeFileSync(path.join(root, "bun.lock"), lockText());
  fs.mkdirSync(path.join(root, "node_modules"));
  writePackage(root, "prod", "1.0.0", options.prodLicense ?? "MIT");
  writePackage(root, "dev", "2.0.0", options.devLicense ?? "Apache-2.0");
  writePackage(root, "transitive", "3.0.0", options.transitiveLicense ?? "BSD-3-Clause");
  const sbom = generateSbom(root, { sourceCommit: COMMIT, artifactSha256: ARTIFACT_SHA, createdAt: COLLECTED_AT }).sbom;
  return { root, sbom };
}

/** @returns {any} */
function rawEvidence() {
  return {
    version: 1,
    artifact: { name: "demo-app", version: "1.2.3", sha256: ARTIFACT_SHA, sourceCommit: COMMIT },
    source: { kind: "installed-package-manifests", authenticated: false, collectedAt: COLLECTED_AT },
    packages: [
      { name: "prod", version: "1.0.0", relationship: "direct-production", licenseExpression: "MIT" },
      { name: "dev", version: "2.0.0", relationship: "direct-development", licenseExpression: "Apache-2.0" },
    ],
  };
}

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    includedRelationships: ["direct-production", "direct-development", "direct-optional", "transitive"],
    allowedExpressions: ["MIT", "Apache-2.0"],
    deniedExpressions: ["GPL-3.0-only"],
    unknownStatus: "WARN",
    unlistedStatus: "WARN",
  };
}

/** @param {any} value */
function tempJson(value) {
  const file = path.join(os.tmpdir(), `toolkit-license-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

test("license expression normalization is bounded and whitespace-stable", () => {
  assert.equal(normalizeLicenseExpression(" MIT   OR  Apache-2.0 "), "MIT OR Apache-2.0");
  assert.equal(normalizeLicenseExpression(""), null);
  assert.equal(normalizeLicenseExpression("MIT; rm"), null);
  assert.equal(normalizeLicenseExpression(null), null);
});

test("canonical license evidence validates and sorts packages", () => {
  const value = rawEvidence();
  value.packages.reverse();
  const result = validateLicenseEvidence(value);
  assert.equal(result.ok, true);
  if (!result.ok || result.evidence === null) return;
  assert.deepEqual(result.evidence.packages.map((item) => item.name), ["dev", "prod"]);
});

test("license evidence rejects duplicate package identity, bad trust metadata, and unknown fields", () => {
  const duplicate = rawEvidence();
  duplicate.packages.push(structuredClone(duplicate.packages[0]));
  assert.equal(validateLicenseEvidence(duplicate).ok, false);

  const badTime = rawEvidence();
  badTime.source.collectedAt = "today";
  assert.equal(validateLicenseEvidence(badTime).ok, false);

  const unknown = rawEvidence();
  unknown.artifact.environment = "production";
  assert.equal(validateLicenseEvidence(unknown).ok, false);
});

test("null license is valid unknown evidence but malformed expression is rejected", () => {
  const unknown = rawEvidence();
  unknown.packages[0].licenseExpression = null;
  assert.equal(validateLicenseEvidence(unknown).ok, true);
  unknown.packages[0].licenseExpression = "MIT;GPL";
  assert.equal(validateLicenseEvidence(unknown).ok, false);
});

test("collector binds exact SBOM package identities to installed manifest licenses", () => {
  const { root, sbom } = tempRelease();
  const result = collectInstalledLicenseEvidence(root, sbom, COLLECTED_AT);
  assert.equal(result.evidence.artifact.sha256, ARTIFACT_SHA);
  assert.equal(result.evidence.artifact.sourceCommit, COMMIT);
  assert.equal(result.summary.known, 3);
  const byName = new Map(result.evidence.packages.map((item) => [item.name, item]));
  assert.equal(byName.get("prod")?.licenseExpression, "MIT");
  assert.equal(byName.get("dev")?.licenseExpression, "Apache-2.0");
  assert.equal(byName.get("transitive")?.licenseExpression, "BSD-3-Clause");
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing exact installed version remains UNKNOWN instead of borrowing another version", () => {
  const { root, sbom } = tempRelease();
  fs.rmSync(path.join(root, "node_modules", "transitive"), { recursive: true, force: true });
  writePackage(root, "transitive", "4.0.0", "MIT");
  const result = collectInstalledLicenseEvidence(root, sbom, COLLECTED_AT);
  const item = result.evidence.packages.find((entry) => entry.name === "transitive");
  assert.equal(item?.licenseExpression, null);
  assert.equal(result.summary.unknown, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("nested node_modules are scanned without following symlink package directories", () => {
  const { root } = tempRelease();
  const nestedRoot = path.join(root, "node_modules", "prod");
  writePackage(nestedRoot, "nested", "9.0.0", "MIT");
  const scan = scanInstalledPackageLicenses(root);
  assert.equal(scan.found.get("nested@9.0.0")?.has("MIT"), true);

  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-license-outside-"));
  fs.writeFileSync(path.join(outside, "package.json"), JSON.stringify({ name: "outside", version: "1.0.0", license: "GPL-3.0-only" }));
  fs.symlinkSync(outside, path.join(root, "node_modules", "outside"));
  const rescanned = scanInstalledPackageLicenses(root);
  assert.equal(rescanned.found.has("outside@1.0.0"), false);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test("conflicting exact installed manifests fail closed", () => {
  const { root, sbom } = tempRelease();
  const nested = path.join(root, "node_modules", "prod");
  writePackage(nested, "transitive", "3.0.0", "GPL-3.0-only");
  assert.throws(() => collectInstalledLicenseEvidence(root, sbom, COLLECTED_AT), /disagree about license/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("collector rejects symlink node_modules and invalid collection timestamps", () => {
  const { root, sbom } = tempRelease();
  const target = fs.mkdtempSync(path.join(os.tmpdir(), "toolkit-license-modules-"));
  fs.rmSync(path.join(root, "node_modules"), { recursive: true, force: true });
  fs.symlinkSync(target, path.join(root, "node_modules"));
  assert.throws(() => scanInstalledPackageLicenses(root), /real directory/);
  assert.throws(() => collectInstalledLicenseEvidence(root, sbom, "today"), /absolute ISO/);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(target, { recursive: true, force: true });
});

test("SBOM extraction requires artifact hash, source commit, and component relationship", () => {
  const { root, sbom } = tempRelease();
  const missingHash = structuredClone(sbom);
  missingHash.metadata.component.hashes = [];
  assert.throws(() => packageTargetsFromSbom(missingHash), /artifact SHA256/);

  const missingCommit = structuredClone(sbom);
  missingCommit.metadata.properties = missingCommit.metadata.properties.filter((item) => item.name !== "toolkit:sourceCommit");
  assert.throws(() => packageTargetsFromSbom(missingCommit), /sourceCommit/);

  const missingRelationship = structuredClone(sbom);
  missingRelationship.components[0].properties = [];
  assert.throws(() => packageTargetsFromSbom(missingRelationship), /dependency relationship/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("license policy validates exact expression sets and rejects overlap", () => {
  assert.equal(validateLicensePolicy(rawPolicy()).ok, true);
  const overlap = rawPolicy();
  overlap.deniedExpressions.push("MIT");
  assert.equal(validateLicensePolicy(overlap).ok, false);
  const badStatus = rawPolicy();
  badStatus.unknownStatus = "IGNORE";
  assert.equal(validateLicensePolicy(badStatus).ok, false);
});

test("allowed exact expressions PASS while denied exact expressions FAIL", () => {
  const evidenceResult = validateLicenseEvidence(rawEvidence());
  const policyResult = validateLicensePolicy(rawPolicy());
  assert.equal(evidenceResult.ok && policyResult.ok, true);
  if (!evidenceResult.ok || !evidenceResult.evidence || !policyResult.ok || !policyResult.policy) return;
  let report = inspectLicensePolicy(evidenceResult.evidence, policyResult.policy);
  assert.equal(report.overallStatus, "PASS");

  const denied = structuredClone(evidenceResult.evidence);
  const deniedFirst = denied.packages[0];
  assert.ok(deniedFirst);
  deniedFirst.licenseExpression = "GPL-3.0-only";
  report = inspectLicensePolicy(denied, policyResult.policy);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "license-denied"), true);
});

test("unknown and unlisted expressions follow explicit WARN or FAIL policy", () => {
  const evidence = rawEvidence();
  evidence.packages[0].licenseExpression = null;
  evidence.packages[1].licenseExpression = "BSD-3-Clause";
  const ev = validateLicenseEvidence(evidence);
  const policy = validateLicensePolicy(rawPolicy());
  assert.equal(ev.ok && policy.ok, true);
  if (!ev.ok || !ev.evidence || !policy.ok || !policy.policy) return;
  assert.equal(inspectLicensePolicy(ev.evidence, policy.policy).overallStatus, "WARN");

  const strictRaw = rawPolicy();
  strictRaw.unknownStatus = "FAIL";
  strictRaw.unlistedStatus = "FAIL";
  const strict = validateLicensePolicy(strictRaw);
  assert.equal(strict.ok, true);
  if (!strict.ok || !strict.policy) return;
  assert.equal(inspectLicensePolicy(ev.evidence, strict.policy).overallStatus, "FAIL");
});

test("complex expressions are exact policy values rather than inferred legal choices", () => {
  const evidence = rawEvidence();
  evidence.packages[0].licenseExpression = "MIT OR Apache-2.0";
  const ev = validateLicenseEvidence(evidence);
  const policy = validateLicensePolicy(rawPolicy());
  assert.equal(ev.ok && policy.ok, true);
  if (!ev.ok || !ev.evidence || !policy.ok || !policy.policy) return;
  const report = inspectLicensePolicy(ev.evidence, policy.policy);
  assert.equal(report.checks.find((item) => item.subject.startsWith("prod@"))?.id, "license-unlisted");
});

test("out-of-scope relationships do not affect policy result", () => {
  const evidence = rawEvidence();
  evidence.packages[1].licenseExpression = "GPL-3.0-only";
  const policyRaw = rawPolicy();
  policyRaw.includedRelationships = ["direct-production"];
  const ev = validateLicenseEvidence(evidence);
  const policy = validateLicensePolicy(policyRaw);
  assert.equal(ev.ok && policy.ok, true);
  if (!ev.ok || !ev.evidence || !policy.ok || !policy.policy) return;
  const report = inspectLicensePolicy(ev.evidence, policy.policy);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks.some((item) => item.id === "relationship-out-of-scope"), true);
});

test("source authentication metadata does not change exact license policy truth", () => {
  const one = rawEvidence();
  const two = rawEvidence();
  two.source.authenticated = true;
  const policy = validateLicensePolicy(rawPolicy());
  const a = validateLicenseEvidence(one);
  const b = validateLicenseEvidence(two);
  assert.equal(policy.ok && a.ok && b.ok, true);
  if (!policy.ok || !policy.policy || !a.ok || !a.evidence || !b.ok || !b.evidence) return;
  assert.equal(inspectLicensePolicy(a.evidence, policy.policy).overallStatus, inspectLicensePolicy(b.evidence, policy.policy).overallStatus);
});

test("evidence CLI validates files and emits canonical JSON", () => {
  const file = tempJson(rawEvidence());
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(evidenceMain(["--file", file, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).artifact.name, "demo-app");
  assert.equal(evidenceMain(["--file", "/tmp/missing-license-evidence.json"]), 1);
  fs.rmSync(file, { force: true });
});

test("audit CLI exposes PASS WARN FAIL exit semantics", () => {
  const evidenceFile = tempJson(rawEvidence());
  const policyFile = tempJson(rawPolicy());
  const originalLog = console.log;
  console.log = () => {};
  try { assert.equal(auditMain(["--evidence-file", evidenceFile, "--policy", policyFile]), 0); }
  finally { console.log = originalLog; }

  const denied = rawEvidence();
  denied.packages[0].licenseExpression = "GPL-3.0-only";
  fs.writeFileSync(evidenceFile, JSON.stringify(denied));
  assert.equal(auditMain(["--evidence-file", evidenceFile, "--policy", policyFile]), 1);
  fs.rmSync(evidenceFile, { force: true });
  fs.rmSync(policyFile, { force: true });
});

test("collector CLI emits canonical evidence without modifying SBOM input", () => {
  const { root, sbom } = tempRelease();
  const sbomFile = tempJson(sbom);
  const before = fs.readFileSync(sbomFile, "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(collectorMain(["--root", root, "--sbom-file", sbomFile, "--collected-at", COLLECTED_AT, "--json"]), 0);
  } finally { console.log = originalLog; }
  const evidence = JSON.parse(stdout);
  assert.equal(evidence.packages.length, 3);
  assert.equal(fs.readFileSync(sbomFile, "utf8"), before);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sbomFile, { force: true });
});

test("license tooling stays local, read only, and free of provider mutation surfaces", () => {
  for (const file of ["license-evidence.js", "collect-installed-license-evidence.js", "audit-licenses.js"]) {
    const source = fs.readFileSync(new URL(`../scripts/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\//);
    assert.doesNotMatch(source, /writeFile|appendFile|rmSync|unlinkSync|renameSync/);
  }
});
