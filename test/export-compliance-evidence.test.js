import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildComplianceEvidenceExport,
  formatComplianceEvidenceCsv,
  main,
  validateComplianceExportMapping,
} from "../scripts/export-compliance-evidence.js";
import { REQUIRED_RELEASE_BUNDLE_CHECK_IDS, validateReleaseEvidenceBundle } from "../scripts/release-evidence-bundle.js";

const REQUIRED_EVIDENCE = [
  "ci-evidence",
  "dependency-sbom",
  "vulnerability-evidence",
  "vulnerability-policy",
  "artifact-provenance",
  "runtime-evidence",
  "runtime-health-evidence",
  "runtime-health-policy",
];

/** @returns {any} */
function rawBundle() {
  return {
    version: 1,
    source: { commit: "a".repeat(40) },
    createdAt: "2026-09-17T10:00:00Z",
    baseline: {
      commit: "b".repeat(40),
      status: "MATCH",
      relationship: "expected-ancestor-of-comparison",
      ahead: 1,
      behind: 0,
    },
    artifact: { name: "dist.tgz", sha256: "c".repeat(64) },
    runtime: { name: "web", environment: "production" },
    trust: {
      ciAuthenticated: true,
      provenanceAuthenticated: true,
      runtimeAuthenticated: false,
      runtimeHealthAuthenticated: true,
      vulnerabilityAuthenticated: false,
    },
    results: {
      ciChecks: [{ name: "quality", status: "PASS" }],
      artifactProvenance: "PASS",
      runtimeHealth: "FAIL",
      vulnerabilities: "WARN",
      vulnerabilityFindings: 2,
    },    evidenceIndex: REQUIRED_EVIDENCE.map((id, index) => ({
      id,
      sha256: String(index + 1).repeat(64).slice(0, 64),
    })),
    checks: REQUIRED_RELEASE_BUNDLE_CHECK_IDS.map((id) => ({ id, status: "PASS", detail: `synthetic ${id} passes` })),
    summary: { pass: REQUIRED_RELEASE_BUNDLE_CHECK_IDS.length, fail: 0 },
    technicalStatus: "PASS",
    bundleStatus: "VALID",
    semantics: "coherent evidence index only",
  };
}

function bundle(value = rawBundle()) {
  const result = validateReleaseEvidenceBundle(value);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.bundle) throw new Error("bundle fixture invalid");
  return result.bundle;
}

/** @returns {any} */
function rawMapping() {
  return {
    version: 1,
    name: "internal-control-map",
    controls: [
      {
        id: "release-integrity",
        evidenceIds: ["ci-evidence", "artifact-provenance"],
        resultKeys: ["artifactProvenance"],
      },
      {
        id: "runtime-observation",
        evidenceIds: ["runtime-evidence", "runtime-health-evidence"],
        resultKeys: ["runtimeHealth"],
      },
    ],
  };
}

function mapping(value = rawMapping()) {
  const result = validateComplianceExportMapping(value);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.mapping) throw new Error("mapping fixture invalid");
  return result.mapping;
}
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

test("standalone Release Evidence Bundle validator accepts canonical export input", () => {
  const result = validateReleaseEvidenceBundle(rawBundle());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.bundle) return;
  assert.equal(result.bundle.bundleStatus, "VALID");
  assert.deepEqual(result.bundle.evidenceIndex.map((item) => item.id), [...REQUIRED_EVIDENCE].sort());
});

test("bundle validator rejects summary/status tampering and missing canonical evidence", () => {
  const summary = rawBundle();
  summary.summary.fail = 1;
  assert.equal(validateReleaseEvidenceBundle(summary).valid, false);

  const status = rawBundle();
  status.bundleStatus = "INVALID";
  assert.equal(validateReleaseEvidenceBundle(status).valid, false);

  const missing = rawBundle();
  missing.evidenceIndex = missing.evidenceIndex.filter((/** @type {any} */ item) => item.id !== "ci-evidence");
  assert.equal(validateReleaseEvidenceBundle(missing).valid, false);
});

test("bundle validator rejects unknown fields and malformed evidence hashes", () => {
  const unknown = rawBundle();
  unknown.compliant = true;
  assert.equal(validateReleaseEvidenceBundle(unknown).valid, false);

  const hash = rawBundle();
  hash.evidenceIndex[0].sha256 = "bad";
  assert.equal(validateReleaseEvidenceBundle(hash).valid, false);
});

test("control mapping validates portable evidence coverage requirements", () => {
  const result = validateComplianceExportMapping(rawMapping());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.mapping) return;
  assert.deepEqual(result.mapping.controls.map((/** @type {any} */ control) => control.id), [
    "release-integrity",
    "runtime-observation",
  ]);
});

test("control mapping rejects duplicate controls empty evidence and unsupported result keys", () => {
  const duplicate = rawMapping();
  duplicate.controls.push(structuredClone(duplicate.controls[0]));
  assert.equal(validateComplianceExportMapping(duplicate).valid, false);

  const empty = rawMapping();
  empty.controls[0].evidenceIds = [];
  assert.equal(validateComplianceExportMapping(empty).valid, false);

  const resultKey = rawMapping();
  resultKey.controls[0].resultKeys = ["madeUpComplianceScore"];
  assert.equal(validateComplianceExportMapping(resultKey).valid, false);
});

test("complete export reports evidence coverage without making a compliance claim", () => {
  const report = buildComplianceEvidenceExport(bundle(), mapping());
  assert.equal(report.evidenceCoverageStatus, "COMPLETE");
  assert.equal(report.complianceClaim, false);
  assert.equal(report.attestation, false);
  assert.equal(report.summary.evidenceMissing, 0);
  assert.equal(report.controls.every((/** @type {any} */ control) => control.coverage === "PRESENT"), true);
  assert.equal(
    report.controls.find((/** @type {any} */ control) => control.id === "runtime-observation")?.results[0]?.value,
    "FAIL",
  );
  assert.match(report.semantics, /PRESENT does not mean compliant/);
});

test("missing mapped evidence yields INCOMPLETE coverage without inventing control failure", () => {
  const raw = rawMapping();
  raw.controls[0].evidenceIds.push("private-change-approval");
  const report = buildComplianceEvidenceExport(bundle(), mapping(raw));
  const control = report.controls.find((/** @type {any} */ item) => item.id === "release-integrity");
  assert.equal(report.evidenceCoverageStatus, "INCOMPLETE");
  assert.equal(control?.coverage, "MISSING");
  assert.deepEqual(control?.missingEvidence, ["private-change-approval"]);
  assert.equal(report.complianceClaim, false);
});

test("INVALID source bundle always produces INCOMPLETE export coverage", () => {
  const raw = rawBundle();
  raw.checks.push({ id: "identity-mismatch", status: "FAIL", detail: "identity mismatch" });
  raw.summary = { pass: REQUIRED_RELEASE_BUNDLE_CHECK_IDS.length, fail: 1 };
  raw.bundleStatus = "INVALID";
  const report = buildComplianceEvidenceExport(bundle(raw), mapping());
  assert.equal(report.release.bundleStatus, "INVALID");
  assert.equal(report.evidenceCoverageStatus, "INCOMPLETE");
  assert.equal(report.controls.every((/** @type {any} */ control) => control.coverage === "PRESENT"), true);
});

test("CSV export is generic evidence coverage and carries explicit false claims", () => {
  const report = buildComplianceEvidenceExport(bundle(), mapping());
  const csv = formatComplianceEvidenceCsv(report);
  const lines = csv.split("\n");
  assert.equal(lines.length, 3);
  assert.match(lines[0] ?? "", /compliance_claim,attestation/);
  assert.match(csv, /release-integrity,PRESENT/);
  assert.match(csv, /runtimeHealth=FAIL/);
  assert.match(csv, /,false,false/);
  assert.doesNotMatch(csv, /COMPLIANT|CERTIFIED|ATTESTED/);
});

test("CLI emits generic JSON and CSV formats from validated artifacts", () => {
  const bundleFile = tempJson("release-bundle", rawBundle());
  const mappingFile = tempJson("control-mapping", rawMapping());
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["--bundle", bundleFile, "--mapping", mappingFile, "--format", "json"]), 0);
  } finally { console.log = originalLog; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.format, "generic-control-evidence-v1");
  assert.equal(parsed.complianceClaim, false);

  stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["--bundle", bundleFile, "--mapping", mappingFile, "--format", "csv"]), 0);
  } finally { console.log = originalLog; }
  assert.match(stdout, /^mapping,control_id,coverage,/);
  fs.rmSync(bundleFile, { force: true });
  fs.rmSync(mappingFile, { force: true });
});

test("CLI rejects malformed inputs unknown formats and exporter remains local/read-only", () => {
  const malformed = tempJson("compliance-bad", "{");
  assert.equal(main(["--bundle", malformed, "--mapping", malformed, "--format", "json"]), 1);
  assert.equal(main(["--bundle", malformed, "--mapping", malformed, "--format", "soc2"]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });

  const source = fs.readFileSync(new URL("../scripts/export-compliance-evidence.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\bfetch\s*\(|node:child_process|spawnSync|execFile|writeFile|copyFile|process\.env/);
  assert.match(source, /validateReleaseEvidenceBundle/);
  assert.doesNotMatch(source, /SOC\s*2|ISO\s*27001|PCI\s*DSS|HIPAA/);
});