import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { inspectEcosystemDashboard, validateEcosystemDashboardConfig } from "../scripts/ecosystem-dashboard.js";
import { validateEcosystemDashboardSnapshot } from "../scripts/compare-ecosystem-history.js";
import { BUILTIN_POLICY_PACKS, inspectManifestPolicyPack } from "../scripts/policy-packs.js";
import { validateRepositoryManifest } from "../scripts/repository-manifest.js";

/** @param {string} id @returns {any} */
function manifest(id = "example-web") {
  return {
    version: 1,
    repository: { id },
    profile: "webapp",
    runtime: { type: "node-service" },
    database: null,
    capabilities: [],
    checks: { required: ["custom-project-check"], advisory: ["custom-project-advisory"] },
  };
}

/** @param {any} raw */
function effective(raw) {
  const checked = validateRepositoryManifest(raw);
  assert.equal(checked.valid, true, JSON.stringify(checked.errors));
  if (!checked.valid || !checked.manifest) throw new Error("manifest invalid");
  const report = inspectManifestPolicyPack(checked.manifest, BUILTIN_POLICY_PACKS);
  assert.equal(report.overallStatus, "PASS");
  if (!report.effective) throw new Error("policy invalid");
  return report.effective;
}

/** @param {any} raw @param {Record<string,string>} [overrides] */
function evidence(raw, overrides = {}) {
  const policy = effective(raw);
  return {
    version: 1,
    repository: { id: raw.repository.id },
    evidence: { source: "synthetic-severity", authenticated: false, collectedAt: "2026-09-17T08:00:00Z" },
    checks: [...policy.required, ...policy.advisory].map((id) => ({ id, status: overrides[id] ?? "PASS" })),
  };
}

function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), "dashboard-severity-")); }
/** @param {string} root @param {string} name @param {any} value */
function writeJson(root, name, value) { fs.writeFileSync(path.join(root, name), JSON.stringify(value)); return name; }
/** @param {string} root @param {any} rawManifest @param {any} rawEvidence @param {any|null} [severity] @returns {{manifestFile:string,evidenceFile:string,severityPolicyFile?:string}} */
function entry(root, rawManifest, rawEvidence, severity = null) {
  /** @type {{manifestFile:string,evidenceFile:string,severityPolicyFile?:string}} */
  const result = {
    manifestFile: writeJson(root, "manifest.json", rawManifest),
    evidenceFile: writeJson(root, "evidence.json", rawEvidence),
  };
  if (severity !== null) result.severityPolicyFile = writeJson(root, "severity.json", severity);
  return result;
}
/** @param {any} repositoryEntry */
function dashboard(repositoryEntry) {
  return { version: 1, generatedAt: "2026-09-17T08:05:00Z", repositories: [repositoryEntry] };
}

test("dashboard config accepts an optional severityPolicyFile", () => {
  const result = validateEcosystemDashboardConfig(dashboard({ manifestFile: "manifest.json", evidenceFile: "evidence.json", severityPolicyFile: "severity.json" }));
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test("without severity policy existing advisory FAIL remains dashboard WARN", () => {
  const root = workspace(), rawManifest = manifest();
  const report = inspectEcosystemDashboard(dashboard(entry(root, rawManifest, evidence(rawManifest, { seo: "FAIL" }))), root);
  assert.equal(report.overallStatus, "WARN");
  const seo = report.repositories[0]?.checks.find((item) => item.id === "seo");
  assert.equal(seo?.requirement, "advisory");
  assert.equal(seo?.impact, "WARN");
  fs.rmSync(root, { recursive: true, force: true });
});

test("severity policy can make an advisory FAIL blocking without relabeling requirement", () => {
  const root = workspace(), rawManifest = manifest();
  const severity = { version: 1, rules: [{ check: "seo", requirement: "advisory", impacts: { fail: "FAIL" } }] };
  const report = inspectEcosystemDashboard(dashboard(entry(root, rawManifest, evidence(rawManifest, { seo: "FAIL" }), severity)), root);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.repositories[0]?.policyStatus, "PASS");
  const seo = report.repositories[0]?.checks.find((item) => item.id === "seo");
  assert.equal(seo?.requirement, "advisory");
  assert.equal(seo?.impact, "FAIL");
  assert.equal(report.repositories[0]?.advisory.fail, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("severity policy can promote advisory check to required", () => {
  const root = workspace(), rawManifest = manifest();
  const severity = { version: 1, rules: [{ check: "seo", requirement: "required", impacts: {} }] };
  const report = inspectEcosystemDashboard(dashboard(entry(root, rawManifest, evidence(rawManifest, { seo: "FAIL" }), severity)), root);
  assert.equal(report.overallStatus, "FAIL");
  const seo = report.repositories[0]?.checks.find((item) => item.id === "seo");
  assert.equal(seo?.requirement, "required");
  assert.equal(seo?.impact, "FAIL");
  assert.equal(report.repositories[0]?.required.fail, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("attempted required-to-advisory downgrade fails policy and retains stricter requirement", () => {
  const root = workspace(), rawManifest = manifest();
  const severity = { version: 1, rules: [{ check: "public-safety", requirement: "advisory", impacts: {} }] };
  const report = inspectEcosystemDashboard(dashboard(entry(root, rawManifest, evidence(rawManifest), severity)), root);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.repositories[0]?.policyStatus, "FAIL");
  assert.equal(report.repositories[0]?.checks.find((item) => item.id === "public-safety")?.requirement, "required");
  fs.rmSync(root, { recursive: true, force: true });
});

test("new required check can explicitly make missing evidence blocking", () => {
  const root = workspace(), rawManifest = manifest();
  const severity = { version: 1, rules: [{ check: "release-approval", requirement: "required", impacts: { missing: "FAIL" } }] };
  const report = inspectEcosystemDashboard(dashboard(entry(root, rawManifest, evidence(rawManifest), severity)), root);
  assert.equal(report.overallStatus, "FAIL");
  const added = report.repositories[0]?.checks.find((item) => item.id === "release-approval");
  assert.deepEqual(added, { id: "release-approval", requirement: "required", status: "MISSING", impact: "FAIL" });
  assert.equal(report.repositories[0]?.required.missing, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("invalid severity policy is isolated as technical failure", () => {
  const root = workspace(), rawManifest = manifest(), repositoryEntry = entry(root, rawManifest, evidence(rawManifest));
  repositoryEntry.severityPolicyFile = writeJson(root, "severity-invalid.json", { version: 1, rules: [{ check: "seo", requirement: "required", impacts: { fail: "PASS" } }] });
  const report = inspectEcosystemDashboard(dashboard(repositoryEntry), root);
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.overallStatus, "FAIL");
  assert.match(report.repositories[0]?.technicalDetail ?? "", /severity policy/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("dashboard snapshot validator accepts monotone impact escalation", () => {
  const root = workspace(), rawManifest = manifest();
  const severity = { version: 1, rules: [{ check: "seo", requirement: "advisory", impacts: { fail: "FAIL" } }] };
  const report = inspectEcosystemDashboard(dashboard(entry(root, rawManifest, evidence(rawManifest, { seo: "FAIL" }), severity)), root);
  const checked = validateEcosystemDashboardSnapshot(report);
  assert.equal(checked.valid, true, JSON.stringify(checked.errors));
  fs.rmSync(root, { recursive: true, force: true });
});

test("dashboard snapshot validator still rejects weakened required FAIL impact", () => {
  const root = workspace(), rawManifest = manifest();
  const report = inspectEcosystemDashboard(dashboard(entry(root, rawManifest, evidence(rawManifest, { "public-safety": "FAIL" }))), root);
  const tampered = structuredClone(report);
  const check = tampered.repositories[0]?.checks.find((item) => item.id === "public-safety");
  assert.ok(check); check.impact = "WARN";
  assert.equal(validateEcosystemDashboardSnapshot(tampered).valid, false);
  fs.rmSync(root, { recursive: true, force: true });
});
