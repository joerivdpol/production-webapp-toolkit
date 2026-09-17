import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatOrganizationPolicy,
  inspectOrganizationPolicy,
  main,
  validateOrganizationPolicy,
} from "../scripts/organization-policy.js";
import { validateRepositoryManifest } from "../scripts/repository-manifest.js";

/** @param {object} [overrides] */
function manifest(overrides = {}) {
  const raw = {
    version: 1,
    repository: { id: "example-web" },
    profile: "webapp",
    runtime: { type: "node-service" },
    database: null,
    capabilities: [],
    checks: { required: ["custom-project-check"], advisory: ["custom-project-advisory"] },
    ...overrides,
  };
  const result = validateRepositoryManifest(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.manifest) throw new Error("manifest fixture invalid");
  return result.manifest;
}

/** @returns {any} */
function policy() {
  return {
    version: 1,
    organization: { id: "example-org" },
    global: {
      requirements: { runtime: false, database: false, capabilities: [] },
      checks: { required: ["vulnerabilities"], advisory: ["documentation-drift"] },
    },
    profiles: [
      {
        profile: "webapp",
        policy: {
          requirements: { runtime: false, database: false, capabilities: [] },
          checks: { required: ["authorization"], advisory: ["localization"] },
        },
      },
    ],
    repositories: [
      {
        repository: "example-web",
        policy: {
          requirements: { runtime: false, database: false, capabilities: [] },
          checks: { required: ["backup-readiness"], advisory: ["release-notes"] },
        },
      },
    ],
  };
}

function validatedPolicy(raw = policy()) {
  const result = validateOrganizationPolicy(raw);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.policy) throw new Error("organization policy fixture invalid");
  return result.policy;
}

/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const filename = path.join(
    os.tmpdir(),
    `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`,
  );
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("global profile and repository layers compose monotonically", () => {
  const report = inspectOrganizationPolicy(manifest(), validatedPolicy());
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.layers, [
    "public-pack",
    "organization-global",
    "organization-profile:webapp",
    "organization-repository:example-web",
  ]);
  for (const required of ["vulnerabilities", "authorization", "backup-readiness"]) {
    assert.equal(report.effective?.required.includes(required), true);
    assert.equal(report.effective?.advisory.includes(required), false);
  }
});

test("repository-specific layer applies only to the exact repository", () => {
  const other = manifest({ repository: { id: "other-web" } });
  const report = inspectOrganizationPolicy(other, validatedPolicy());
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.layers.includes("organization-repository:example-web"), false);
  assert.equal(report.effective?.required.includes("backup-readiness"), false);
  assert.equal(report.effective?.required.includes("authorization"), true);
});

test("manifest cannot downgrade organization-required checks to advisory", () => {
  const project = manifest({
    checks: {
      required: ["custom-project-check"],
      advisory: ["custom-project-advisory", "vulnerabilities"],
    },
  });
  const report = inspectOrganizationPolicy(project, validatedPolicy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(
    report.checks.some((item) => item.id === "manifest-organization-monotonicity" && item.status === "FAIL"),
    true,
  );
});

test("organization advisory layer cannot downgrade inherited public required checks", () => {
  const raw = policy();
  raw.global.checks.advisory.push("public-safety");
  const report = inspectOrganizationPolicy(manifest(), validatedPolicy(raw));
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(
    report.checks.some((item) => item.id === "organization-layer-monotonicity" && item.status === "FAIL"),
    true,
  );
});

test("stricter organization layer may promote inherited advisory checks", () => {
  const raw = policy();
  raw.global.checks.required = [];
  raw.global.checks.advisory.push("backup-readiness");
  const report = inspectOrganizationPolicy(manifest(), validatedPolicy(raw));
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.effective?.required.includes("backup-readiness"), true);
  assert.equal(report.effective?.advisory.includes("backup-readiness"), false);
});

test("organization runtime database and capability requirements are additive", () => {
  const raw = policy();
  raw.profiles[0].policy.requirements = {
    runtime: true,
    database: true,
    capabilities: ["localized-content"],
  };
  const missing = inspectOrganizationPolicy(manifest(), validatedPolicy(raw));
  assert.equal(missing.overallStatus, "FAIL");
  assert.equal(missing.checks.some((item) => item.id === "organization-database-requirement" && item.status === "FAIL"), true);
  assert.equal(missing.checks.some((item) => item.id === "organization-capability-requirements" && item.status === "FAIL"), true);

  const complete = inspectOrganizationPolicy(
    manifest({ database: { type: "postgres" }, capabilities: ["localized-content"] }),
    validatedPolicy(raw),
  );
  assert.equal(complete.overallStatus, "PASS");
});

test("unknown public profile cannot be rescued by private organization policy", () => {
  const project = manifest({ profile: "unknown-private-profile" });
  const report = inspectOrganizationPolicy(project, validatedPolicy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.effective, null);
  assert.equal(report.layers[0], "public-pack");
});

test("organization policy validation rejects duplicate targets and local check overlap", () => {
  const duplicateProfile = policy();
  duplicateProfile.profiles.push(structuredClone(duplicateProfile.profiles[0]));
  assert.equal(validateOrganizationPolicy(duplicateProfile).valid, false);

  const duplicateRepository = policy();
  duplicateRepository.repositories.push(structuredClone(duplicateRepository.repositories[0]));
  assert.equal(validateOrganizationPolicy(duplicateRepository).valid, false);

  const overlap = policy();
  overlap.global.checks.advisory.push("vulnerabilities");
  assert.equal(validateOrganizationPolicy(overlap).valid, false);
});

test("organization policy validation rejects unknown fields malformed ids and invalid requirements", () => {
  const unknown = policy();
  unknown.global.secretPolicy = true;
  assert.equal(validateOrganizationPolicy(unknown).valid, false);

  const badId = policy();
  badId.organization.id = "org with spaces";
  assert.equal(validateOrganizationPolicy(badId).valid, false);

  const badRequirements = policy();
  badRequirements.global.requirements.database = "yes";
  assert.equal(validateOrganizationPolicy(badRequirements).valid, false);
});

test("human output exposes selected layers and effective checks", () => {
  const report = inspectOrganizationPolicy(manifest(), validatedPolicy());
  const text = formatOrganizationPolicy(report);
  assert.match(text, /organization-global/);
  assert.match(text, /organization-profile:webapp/);
  assert.match(text, /organization-repository:example-web/);
  assert.match(text, /Overall: PASS/);
});

test("CLI composes explicit manifest and private organization policy files", () => {
  const manifestFile = tempJson("organization-manifest", {
    version: 1,
    repository: { id: "example-web" },
    profile: "webapp",
    runtime: { type: "node-service" },
    database: null,
    capabilities: [],
    checks: { required: ["custom-project-check"], advisory: ["custom-project-advisory"] },
  });
  const policyFile = tempJson("organization-policy", policy());
  const original = console.log; let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["--manifest-file", manifestFile, "--organization-policy-file", policyFile, "--json"]), 0);
  } finally { console.log = original; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.organization, "example-org");
  assert.equal(parsed.effective.required.includes("authorization"), true);
  fs.rmSync(manifestFile, { force: true });
  fs.rmSync(policyFile, { force: true });
});

test("CLI rejects malformed missing and unknown input", () => {
  const malformed = tempJson("organization-bad", "{");
  assert.equal(main(["--manifest-file", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("organization policy engine remains offline read only and delegates public pack resolution", () => {
  const source = fs.readFileSync(
    new URL("../scripts/organization-policy.js", import.meta.url),
    "utf8",
  );
  assert.match(source, /inspectManifestPolicyPack/);
  assert.match(source, /validateRepositoryManifest/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(/);
  assert.doesNotMatch(source, /process\.env|https?:\/\/|writeFile/);
});