import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import {
  adaptGitHubDependabotAlerts,
  collectGitHubDependabotEvidence,
  main,
} from "../scripts/collect-github-dependabot-evidence.js";
import { validateVulnerabilityQueryManifest } from "../scripts/vulnerability-evidence.js";

function manifest() {
  const result = validateVulnerabilityQueryManifest({
    version: 1,
    packages: [
      { ecosystem: "pip", name: "django", version: "2.0.1", relationship: "direct" },
      { ecosystem: "npm", name: "transitive-lib", version: "4.0.0", relationship: "transitive" },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok || result.manifest === null) throw new Error("invalid manifest fixture");
  return result.manifest;
}

/** @returns {any} */
function alert(overrides = {}) {
  return {
    number: 2,
    state: "open",
    dependency: {
      package: { ecosystem: "pip", name: "django" },
      relationship: "direct",
      scope: "runtime",
    },
    security_advisory: {
      ghsa_id: "GHSA-rf4j-j272-fj86",
      cve_id: "CVE-2018-6188",
      severity: "high",
      updated_at: "2026-09-15T12:00:00Z",
      identifiers: [
        { type: "GHSA", value: "GHSA-rf4j-j272-fj86" },
        { type: "CVE", value: "CVE-2018-6188" },
      ],
    },    security_vulnerability: {
      package: { ecosystem: "pip", name: "django" },
      severity: "high",
      vulnerable_version_range: ">= 2.0.0, < 2.0.2",
      first_patched_version: { identifier: "2.0.2" },
    },
    ...overrides,
  };
}

test("Dependabot adapter binds open alert to exact manifest version", () => {
  const evidence = adaptGitHubDependabotAlerts(manifest(), [alert()], "2026-09-16T14:45:00Z");
  assert.equal(evidence.source.provider, "github-dependabot");
  assert.equal(evidence.source.authenticated, true);
  const django = evidence.packages.find((item) => item.name === "django");
  assert.equal(django?.version, "2.0.1");
  assert.equal(django?.relationship, "direct");
  const finding = django?.vulnerabilities[0];
  assert.equal(finding?.id, "GHSA-rf4j-j272-fj86");
  assert.deepEqual(finding?.aliases, ["CVE-2018-6188"]);
  assert.equal(finding?.severity, "HIGH");
  assert.deepEqual(finding?.fixedVersions, ["2.0.2"]);
});

test("closed alerts are not current vulnerability evidence", () => {
  const evidence = adaptGitHubDependabotAlerts(manifest(), [alert({ state: "fixed" })], "2026-09-16T14:45:00Z");
  assert.equal(evidence.packages.every((item) => item.vulnerabilities.length === 0), true);
});

test("known GitHub relationship must agree with explicit manifest", () => {
  assert.throws(
    () => adaptGitHubDependabotAlerts(manifest(), [alert({ dependency: { package: { ecosystem: "pip", name: "django" }, relationship: "indirect" } })], "2026-09-16T14:45:00Z"),
    /relationship disagrees/,
  );
});
test("unknown GitHub relationship keeps explicit manifest relationship", () => {
  const value = alert();
  value.dependency.relationship = "unknown";
  const evidence = adaptGitHubDependabotAlerts(manifest(), [value], "2026-09-16T14:45:00Z");
  assert.equal(evidence.packages.find((item) => item.name === "django")?.relationship, "direct");
});

test("open alert for a package missing from manifest fails closed", () => {
  const value = alert();
  value.dependency.package = { ecosystem: "pip", name: "flask" };
  assert.throws(
    () => adaptGitHubDependabotAlerts(manifest(), [value], "2026-09-16T14:45:00Z"),
    /missing from explicit manifest/,
  );
});

test("duplicate alerts for one advisory merge aliases and fixes without duplicating finding", () => {
  const first = alert();
  const second = alert();
  second.security_advisory.identifiers.push({ type: "CVE", value: "CVE-ALT-0001" });
  second.security_vulnerability.first_patched_version.identifier = "2.0.3";
  second.security_advisory.updated_at = "2026-09-16T12:00:00Z";
  const evidence = adaptGitHubDependabotAlerts(manifest(), [first, second], "2026-09-16T14:45:00Z");
  const findings = evidence.packages.find((item) => item.name === "django")?.vulnerabilities ?? [];
  assert.equal(findings.length, 1);
  assert.deepEqual(findings[0]?.aliases, ["CVE-2018-6188", "CVE-ALT-0001"]);
  assert.deepEqual(findings[0]?.fixedVersions, ["2.0.2", "2.0.3"]);
  assert.equal(findings[0]?.modified, "2026-09-16T12:00:00Z");
});
test("collector requires auth and uses only open read-only Dependabot endpoints", () => {
  assert.equal(collectGitHubDependabotEvidence(
    { repository: "owner/repo", manifest: manifest() },
    { authCheck: () => false },
  ).ok, false);

  /** @type {string[]} */
  const endpoints = [];
  const result = collectGitHubDependabotEvidence(
    { repository: "owner/repo", manifest: manifest() },
    {
      authCheck: () => true,
      apiGet: (endpoint) => { endpoints.push(endpoint); return { ok: true, value: [alert()] }; },
      now: () => "2026-09-16T14:46:00Z",
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(endpoints, ["repos/owner/repo/dependabot/alerts?state=open&per_page=100&page=1"]);
  if (result.ok) assert.equal(result.evidence.source.authenticated, true);
});

test("collector rejects ambiguous manifests and malformed API responses", () => {
  const ambiguous = {
    version: 1,
    packages: [
      { ecosystem: "npm", name: "same", version: "1.0.0", relationship: "direct" },
      { ecosystem: "npm", name: "same", version: "2.0.0", relationship: "transitive" },
    ],
  };
  assert.equal(collectGitHubDependabotEvidence(
    { repository: "owner/repo", manifest: ambiguous },
    { authCheck: () => true },
  ).ok, false);
  assert.equal(collectGitHubDependabotEvidence(
    { repository: "owner/repo", manifest: manifest() },
    { authCheck: () => true, apiGet: () => ({ ok: true, value: { alerts: [] } }) },
  ).ok, false);
});
test("CLI emits canonical JSON with injected read-only GitHub dependencies", () => {
  const manifestFile = `/tmp/dependabot-manifest-${process.pid}.json`;
  fs.writeFileSync(manifestFile, JSON.stringify({
    version: 1,
    packages: [
      { ecosystem: "pip", name: "django", version: "2.0.1", relationship: "direct" },
    ],
  }));
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["--repository", "owner/repo", "--manifest-file", manifestFile, "--json"], {
      authCheck: () => true,
      apiGet: () => ({ ok: true, value: [alert()] }),
      now: () => "2026-09-16T14:46:00Z",
    }), 0);
  } finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).source.provider, "github-dependabot");
  fs.rmSync(manifestFile, { force: true });
});

test("collector source is constrained to authenticated gh CLI GET requests", () => {
  const source = fs.readFileSync(new URL("../scripts/collect-github-dependabot-evidence.js", import.meta.url), "utf8");
  assert.match(source, /spawnSync\("gh", \["auth", "status"/);
  assert.match(source, /spawnSync\("gh", \["api", "--method", "GET"/);
  assert.match(source, /dependabot\/alerts\?state=open/);
  assert.doesNotMatch(source, /\bPATCH\b|\bPOST\b|\bDELETE\b|process\.env|writeFile/);
});
