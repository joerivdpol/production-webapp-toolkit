import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  compareEcosystemHistory,
  formatEcosystemHistory,
  main,
  validateEcosystemDashboardSnapshot,
} from "../scripts/compare-ecosystem-history.js";
import { inspectEcosystemDashboard } from "../scripts/ecosystem-dashboard.js";
import { BUILTIN_POLICY_PACKS, inspectManifestPolicyPack } from "../scripts/policy-packs.js";
import { validateRepositoryManifest } from "../scripts/repository-manifest.js";

/** @param {string} id @returns {any} */
function rawManifest(id) {
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
  const manifest = validateRepositoryManifest(raw);
  assert.equal(manifest.valid, true, JSON.stringify(manifest.errors));
  if (!manifest.valid || !manifest.manifest) throw new Error("manifest invalid");
  const report = inspectManifestPolicyPack(manifest.manifest, BUILTIN_POLICY_PACKS);
  assert.equal(report.overallStatus, "PASS");
  if (!report.effective) throw new Error("policy invalid");
  return report.effective;
}

/** @param {any} raw @param {Record<string,string>} [overrides] @returns {any} */
function evidence(raw, overrides = {}) {
  const policy = effective(raw);
  return {
    version: 1,
    repository: { id: raw.repository.id },
    evidence: { source: "synthetic-history", authenticated: false, collectedAt: "2026-09-17T07:00:00Z" },
    checks: [...policy.required, ...policy.advisory].map((id) => ({ id, status: overrides[id] ?? "PASS" })),
  };
}

function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), "ecosystem-history-")); }
/** @param {string} root @param {string} name @param {any} value */
function writeJson(root, name, value) { fs.writeFileSync(path.join(root, name), JSON.stringify(value)); return name; }
/** @param {string} root @param {string} prefix @param {any} manifest @param {any} checkEvidence @param {any} [organizationPolicy] */
function entry(root, prefix, manifest, checkEvidence, organizationPolicy = null) {
  const manifestFile = writeJson(root, `${prefix}-manifest.json`, manifest), evidenceFile = writeJson(root, `${prefix}-evidence.json`, checkEvidence);
  if (!organizationPolicy) return { manifestFile, evidenceFile };
  return { manifestFile, evidenceFile, organizationPolicyFile: writeJson(root, `${prefix}-organization.json`, organizationPolicy) };
}
/** @param {string} root @param {string} generatedAt @param {any[]} entries */
function dashboard(root, generatedAt, entries) { return inspectEcosystemDashboard({ version: 1, generatedAt, repositories: entries }, root); }
/** @returns {any} */
function orgPolicy() {
  return {
    version: 1,
    organization: { id: "example-org" },
    global: { requirements: { runtime: false, database: false, capabilities: [] }, checks: { required: [], advisory: [] } },
    profiles: [{ profile: "webapp", policy: { requirements: { runtime: false, database: false, capabilities: [] }, checks: { required: ["seo"], advisory: [] } } }],
    repositories: [],
  };
}

test("validator accepts a real Ecosystem Dashboard v1 snapshot", () => {
  const root = workspace(), manifest = rawManifest("example-web");
  const snapshot = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "repo", manifest, evidence(manifest))]);
  const result = validateEcosystemDashboardSnapshot(snapshot);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  fs.rmSync(root, { recursive: true, force: true });
});

test("validator rejects tampered summary impact and overall truth", () => {
  const root = workspace(), manifest = rawManifest("example-web"), original = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "repo", manifest, evidence(manifest))]);
  const summary = structuredClone(original); summary.summary.pass = 99;
  const impact = structuredClone(original); assert.ok(impact.repositories[0]?.checks[0]); impact.repositories[0].checks[0].impact = "FAIL";
  const overall = structuredClone(original); assert.ok(overall.repositories[0]); overall.repositories[0].overallStatus = "FAIL";
  assert.equal(validateEcosystemDashboardSnapshot(summary).valid, false);
  assert.equal(validateEcosystemDashboardSnapshot(impact).valid, false);
  assert.equal(validateEcosystemDashboardSnapshot(overall).valid, false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("identical repository truth compares as UNCHANGED without recomputation", () => {
  const root = workspace(), manifest = rawManifest("example-web"), first = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "one", manifest, evidence(manifest))]), second = dashboard(root, "2026-09-17T08:10:00Z", [entry(root, "two", manifest, evidence(manifest))]);
  const report = compareEcosystemHistory(first, second);
  assert.equal(report.comparisonStatus, "UNCHANGED");
  assert.equal(report.summary.unchanged, 1);
  assert.deepEqual(report.truth, { previousOverallStatus: "PASS", currentOverallStatus: "PASS", previousTechnicalStatus: "PASS", currentTechnicalStatus: "PASS" });
  fs.rmSync(root, { recursive: true, force: true });
});

test("repository PASS to WARN is descriptive regression while current truth remains WARN", () => {
  const root = workspace(), manifest = rawManifest("example-web");
  const previous = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "previous", manifest, evidence(manifest))]);
  const current = dashboard(root, "2026-09-17T08:10:00Z", [entry(root, "current", manifest, evidence(manifest, { seo: "FAIL" }))]);
  const report = compareEcosystemHistory(previous, current);
  assert.equal(report.summary.regressed, 1);
  assert.equal(report.repositories[0]?.change, "REGRESSED");
  assert.equal(report.truth.currentOverallStatus, "WARN");
  assert.equal(report.technicalStatus, "PASS");
  fs.rmSync(root, { recursive: true, force: true });
});

test("repository WARN to PASS is descriptive improvement", () => {
  const root = workspace(), manifest = rawManifest("example-web");
  const previous = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "previous", manifest, evidence(manifest, { seo: "FAIL" }))]);
  const current = dashboard(root, "2026-09-17T08:10:00Z", [entry(root, "current", manifest, evidence(manifest))]);
  const report = compareEcosystemHistory(previous, current);
  assert.equal(report.summary.improved, 1);
  assert.equal(report.repositories[0]?.change, "IMPROVED");
  fs.rmSync(root, { recursive: true, force: true });
});

test("check status changes are reported even when repository overall stays PASS", () => {
  const root = workspace(), manifest = rawManifest("example-web");
  const previousEvidence = evidence(manifest); previousEvidence.checks = previousEvidence.checks.filter((/** @type {any} */ item) => item.id !== "experimental"); previousEvidence.checks.push({ id: "experimental", status: "PASS" });
  const currentEvidence = evidence(manifest); currentEvidence.checks.push({ id: "experimental", status: "FAIL" });
  const previous = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "previous", manifest, previousEvidence)]), current = dashboard(root, "2026-09-17T08:10:00Z", [entry(root, "current", manifest, currentEvidence)]);
  const report = compareEcosystemHistory(previous, current);
  assert.equal(report.truth.currentOverallStatus, "PASS");
  assert.equal(report.summary.unchanged, 1);
  assert.equal(report.summary.checkChanges, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("policy change from advisory to required is reported without changing PASS truth", () => {
  const root = workspace(), manifest = rawManifest("example-web"), checkEvidence = evidence(manifest);
  const previous = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "previous", manifest, checkEvidence)]);
  const current = dashboard(root, "2026-09-17T08:10:00Z", [entry(root, "current", manifest, checkEvidence, orgPolicy())]);
  const report = compareEcosystemHistory(previous, current);
  assert.equal(report.truth.currentOverallStatus, "PASS");
  assert.equal(report.summary.policySourceChanged, 1);
  const first = report.repositories[0];
  assert.ok(first?.checkChanges);
  assert.equal(first.checkChanges.summary.requirementChanged, 1);
  assert.equal(first.checkChanges.changes.some((/** @type {any} */ item) => item.id === "seo" && item.change === "REQUIREMENT_CHANGED"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("repository additions and removals are separate from improvement regression", () => {
  const root = workspace(), a = rawManifest("a-web"), b = rawManifest("b-web"), c = rawManifest("c-web");
  const previous = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "a1", a, evidence(a)), entry(root, "b1", b, evidence(b))]);
  const current = dashboard(root, "2026-09-17T08:10:00Z", [entry(root, "b2", b, evidence(b)), entry(root, "c2", c, evidence(c))]);
  const report = compareEcosystemHistory(previous, current);
  assert.equal(report.summary.added, 1); assert.equal(report.summary.removed, 1); assert.equal(report.summary.unchanged, 1); assert.equal(report.summary.regressed, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("duplicate and unidentified dashboard rows are reported as anomalies not silently compared", () => {
  const root = workspace(), manifest = rawManifest("dup-web"), checkEvidence = evidence(manifest);
  const previous = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "one", manifest, checkEvidence), entry(root, "two", manifest, checkEvidence)]);
  fs.writeFileSync(path.join(root, "bad-manifest.json"), "{"); fs.writeFileSync(path.join(root, "bad-evidence.json"), "{}");
  const current = dashboard(root, "2026-09-17T08:10:00Z", [{ manifestFile: "bad-manifest.json", evidenceFile: "bad-evidence.json" }]);
  const report = compareEcosystemHistory(previous, current);
  assert.deepEqual(report.anomalies.previousDuplicateRepositoryIds, ["dup-web"]);
  assert.equal(report.anomalies.currentUnidentifiedRows, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("comparison rejects equal or reversed dashboard chronology", () => {
  const root = workspace(), manifest = rawManifest("example-web"), first = dashboard(root, "2026-09-17T08:10:00Z", [entry(root, "one", manifest, evidence(manifest))]), second = dashboard(root, "2026-09-17T08:10:00Z", [entry(root, "two", manifest, evidence(manifest))]);
  assert.throws(() => compareEcosystemHistory(first, second), /newer/);
  const older = structuredClone(second); older.generatedAt = "2026-09-17T07:10:00Z";
  assert.throws(() => compareEcosystemHistory(first, older), /newer/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("human output states comparison semantics and current truth", () => {
  const root = workspace(), manifest = rawManifest("example-web"), previous = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "p", manifest, evidence(manifest))]), current = dashboard(root, "2026-09-17T08:10:00Z", [entry(root, "c", manifest, evidence(manifest, { seo: "FAIL" }))]);
  const text = formatEcosystemHistory(compareEcosystemHistory(previous, current));
  assert.match(text, /reports differences only/); assert.match(text, /Current truth: WARN/); assert.match(text, /REGRESSED/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI returns zero for valid regression because comparison is not a gate", () => {
  const root = workspace(), manifest = rawManifest("example-web"), previous = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "p", manifest, evidence(manifest))]), current = dashboard(root, "2026-09-17T08:10:00Z", [entry(root, "c", manifest, evidence(manifest, { seo: "FAIL" }))]);
  const previousFile = path.join(root, "previous.json"), currentFile = path.join(root, "current.json"); fs.writeFileSync(previousFile, JSON.stringify(previous)); fs.writeFileSync(currentFile, JSON.stringify(current));
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--previous", previousFile, "--current", currentFile, "--json"]), 0); } finally { console.log = original; }
  const parsed = JSON.parse(stdout); assert.equal(parsed.summary.regressed, 1); assert.equal(parsed.truth.currentOverallStatus, "WARN");
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI rejects tampered snapshots malformed JSON and invalid order", () => {
  const root = workspace(), manifest = rawManifest("example-web"), previous = dashboard(root, "2026-09-17T08:10:00Z", [entry(root, "p", manifest, evidence(manifest))]), current = dashboard(root, "2026-09-17T07:10:00Z", [entry(root, "c", manifest, evidence(manifest))]);
  const previousFile = path.join(root, "previous.json"), currentFile = path.join(root, "current.json"); fs.writeFileSync(previousFile, JSON.stringify(previous)); fs.writeFileSync(currentFile, JSON.stringify(current));
  assert.equal(main(["--previous", previousFile, "--current", currentFile]), 1);
  previous.summary.pass = 999; fs.writeFileSync(previousFile, JSON.stringify(previous));
  assert.equal(main(["--previous", previousFile, "--current", currentFile]), 1);
  fs.writeFileSync(previousFile, "{"); assert.equal(main(["--previous", previousFile, "--current", currentFile]), 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("history comparator remains offline read only", () => {
  const source = fs.readFileSync(new URL("../scripts/compare-ecosystem-history.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
