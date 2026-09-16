import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatVulnerabilityAudit,
  inspectVulnerabilities,
  main,
  validateVulnerabilityPolicy,
} from "../scripts/audit-vulnerabilities.js";
import { validateVulnerabilityEvidence } from "../scripts/vulnerability-evidence.js";

/** @param {{ severity?:string, relationship?:string, fixedVersions?:string[], collectedAt?:string, authenticated?:boolean }} [options] */
function evidence(options = {}) {
  const raw = {
    version: 1,
    source: {
      provider: "osv",
      authenticated: options.authenticated ?? false,
      collectedAt: options.collectedAt ?? "2026-09-16T14:30:00Z",
    },
    packages: [{
      ecosystem: "npm", name: "example", version: "1.0.0",
      relationship: options.relationship ?? "direct",
      vulnerabilities: [{
        id: "GHSA-test-0001", aliases: ["CVE-2026-0001"],
        severity: options.severity ?? "HIGH",
        fixedVersions: options.fixedVersions ?? ["1.0.1"],
      }],
    }],
  };  const result = validateVulnerabilityEvidence(raw);
  assert.equal(result.ok, true);
  if (!result.ok || result.evidence === null) throw new Error("invalid evidence fixture");
  return result.evidence;
}

/** @param {any} overrides */
function policy(overrides = {}) {
  const raw = {
    version: 1,
    evaluatedAt: "2026-09-16T14:35:00Z",
    maxEvidenceAgeSeconds: 3600,
    blockingSeverities: ["HIGH", "CRITICAL"],
    blockingRelationships: ["direct", "transitive"],
    exceptions: [],
    ...overrides,
  };
  const result = validateVulnerabilityPolicy(raw);
  assert.equal(result.ok, true);
  if (!result.ok || result.policy === null) throw new Error("invalid policy fixture");
  return result.policy;
}

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `vulnerability-audit-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, JSON.stringify(value));
  return filename;
}

test("blocking severity and dependency relationship produce policy FAIL", () => {
  const report = inspectVulnerabilities(evidence(), policy());
  assert.equal(report.overallStatus, "FAIL");
  const check = report.checks.find((item) => item.id === "vulnerability-blocking");
  assert.equal(check?.severity, "HIGH");
  assert.equal(check?.relationship, "direct");
  assert.equal(check?.exploitability, "UNKNOWN");
  assert.equal(check?.fixStatus, "AVAILABLE");
});
test("non-blocking severity or relationship remains visible as WARN", () => {
  const low = inspectVulnerabilities(evidence({ severity: "LOW" }), policy());
  assert.equal(low.overallStatus, "WARN");
  assert.equal(low.checks.some((item) => item.id === "vulnerability-advisory"), true);

  const unknownRelationship = inspectVulnerabilities(
    evidence({ relationship: "unknown" }),
    policy({ blockingRelationships: ["direct", "transitive"] }),
  );
  assert.equal(unknownRelationship.overallStatus, "WARN");
});

test("active exception suppresses blocking but keeps the vulnerability visible", () => {
  const report = inspectVulnerabilities(evidence(), policy({
    exceptions: [{ id: "CVE-2026-0001", reason: "temporary vendor validation", expiresAt: "2026-09-17T00:00:00Z" }],
  }));
  assert.equal(report.overallStatus, "WARN");
  const check = report.checks.find((item) => item.id === "vulnerability-excepted");
  assert.ok(check);
  assert.match(check.detail, /active exception CVE-2026-0001/);
});

test("expired exception no longer suppresses blocking policy", () => {
  const report = inspectVulnerabilities(evidence(), policy({
    exceptions: [{ id: "GHSA-test-0001", reason: "expired test", expiresAt: "2026-09-16T14:34:59Z" }],
  }));
  assert.equal(report.overallStatus, "FAIL");
  const check = report.checks.find((item) => item.id === "vulnerability-blocking");
  assert.match(check?.detail ?? "", /exception GHSA-test-0001 is expired/);
});

test("stale and future evidence fail configured evidence trust policy", () => {
  const stale = inspectVulnerabilities(evidence({ collectedAt: "2026-09-16T12:00:00Z", severity: "LOW" }), policy());
  assert.equal(stale.overallStatus, "FAIL");
  assert.equal(stale.checks.some((item) => item.id === "evidence-stale"), true);

  const future = inspectVulnerabilities(evidence({ collectedAt: "2026-09-16T15:00:00Z", severity: "LOW" }), policy());
  assert.equal(future.overallStatus, "FAIL");
  assert.equal(future.checks.some((item) => item.id === "evidence-future"), true);
});
test("absence of a fixed version is UNKNOWN rather than no-fix", () => {
  const report = inspectVulnerabilities(evidence({ severity: "LOW", fixedVersions: [] }), policy());
  const check = report.checks.find((item) => item.id === "vulnerability-advisory");
  assert.equal(check?.fixStatus, "UNKNOWN");
  assert.doesNotMatch(check?.detail ?? "", /no fix/i);
});

test("no vulnerability records can PASS with fresh evidence", () => {
  const clean = evidence({ severity: "LOW" });
  const cleanPackage = clean.packages[0];
  assert.ok(cleanPackage);
  cleanPackage.vulnerabilities = [];
  const report = inspectVulnerabilities(clean, policy());
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.findingCount, 0);
  assert.equal(report.checks.some((item) => item.id === "no-known-vulnerabilities"), true);
});

test("authentication metadata never changes vulnerability policy truth", () => {
  const unauthenticated = inspectVulnerabilities(evidence({ authenticated: false }), policy());
  const authenticated = inspectVulnerabilities(evidence({ authenticated: true }), policy());
  assert.equal(unauthenticated.overallStatus, authenticated.overallStatus);
});

test("policy validation is explicit and rejects malformed configuration", () => {
  assert.equal(validateVulnerabilityPolicy({ version: 1 }).ok, false);
  assert.equal(validateVulnerabilityPolicy({
    version: 1, evaluatedAt: "2026-09-16T14:35:00Z",
    blockingSeverities: ["HIGH", "HIGH"], blockingRelationships: ["direct"],
  }).ok, false);
  assert.equal(validateVulnerabilityPolicy({
    version: 1, evaluatedAt: "2026-09-16T14:35:00Z",
    blockingSeverities: ["HIGH"], blockingRelationships: ["runtime"],
  }).ok, false);
});
test("CLI returns zero for WARN and one for blocking vulnerability", () => {
  const evidenceFile = tempJson(evidence({ severity: "LOW" }));
  const policyFile = tempJson({
    version: 1, evaluatedAt: "2026-09-16T14:35:00Z", maxEvidenceAgeSeconds: 3600,
    blockingSeverities: ["HIGH", "CRITICAL"], blockingRelationships: ["direct"], exceptions: [],
  });
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--evidence-file", evidenceFile, "--policy", policyFile, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "WARN");

  fs.writeFileSync(evidenceFile, JSON.stringify(evidence()));
  assert.equal(main(["--evidence-file", evidenceFile, "--policy", policyFile]), 1);
  fs.rmSync(evidenceFile, { force: true });
  fs.rmSync(policyFile, { force: true });
});

test("human output distinguishes severity, relationship, fix, and exploitability uncertainty", () => {
  const text = formatVulnerabilityAudit(inspectVulnerabilities(evidence(), policy()));
  assert.match(text, /severity=HIGH/);
  assert.match(text, /relationship=direct/);
  assert.match(text, /fix=AVAILABLE/);
  assert.match(text, /does not establish exploitability/);
});

test("audit core stays offline and delegates canonical evidence validation", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-vulnerabilities.js", import.meta.url), "utf8");
  assert.match(source, /validateVulnerabilityEvidence/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
