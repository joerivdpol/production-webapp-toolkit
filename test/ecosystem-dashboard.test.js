import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatEcosystemDashboard,
  inspectEcosystemDashboard,
  main,
  validateEcosystemDashboardConfig,
} from "../scripts/ecosystem-dashboard.js";
import { BUILTIN_POLICY_PACKS, inspectManifestPolicyPack } from "../scripts/policy-packs.js";
import { validateRepositoryManifest } from "../scripts/repository-manifest.js";

/** @param {string} id @param {string} [profile] @param {any} [database] @param {string[]} [capabilities] @returns {any} */
function rawManifest(id, profile = "webapp", database = null, capabilities = []) {
  return {
    version: 1,
    repository: { id },
    profile,
    runtime: { type: "node-service" },
    database,
    capabilities,
    checks: { required: ["custom-project-check"], advisory: ["custom-project-advisory"] },
  };
}

/** @param {any} raw */
function effective(raw) {
  const validated = validateRepositoryManifest(raw);
  assert.equal(validated.valid, true, JSON.stringify(validated.errors));
  if (!validated.valid || !validated.manifest) throw new Error("manifest fixture invalid");
  const report = inspectManifestPolicyPack(validated.manifest, BUILTIN_POLICY_PACKS);
  assert.equal(report.overallStatus, "PASS");
  if (!report.effective) throw new Error("policy fixture invalid");
  return report.effective;
}

/** @param {any} rawManifestValue @param {Record<string,string>} [overrides] @param {string[]} [omit] @param {string} [collectedAt] @returns {any} */
function evidenceFor(rawManifestValue, overrides = {}, omit = [], collectedAt = "2026-09-17T07:00:00Z") {
  const policy = effective(rawManifestValue);
  const ids = [...policy.required, ...policy.advisory];
  return {
    version: 1,
    repository: { id: rawManifestValue.repository.id },
    evidence: { source: "synthetic-dashboard", authenticated: false, collectedAt },
    checks: ids.filter((id) => !omit.includes(id)).map((id) => ({ id, status: overrides[id] ?? "PASS" })),
  };
}

function workspace() { return fs.mkdtempSync(path.join(os.tmpdir(), "ecosystem-dashboard-")); }
/** @param {string} root @param {string} name @param {any} value */
function writeJson(root, name, value) { fs.writeFileSync(path.join(root, name), JSON.stringify(value)); return name; }
/** @param {string} root @param {string} id @param {any} manifest @param {any} evidence @param {any} [organizationPolicy] */
function addRepository(root, id, manifest, evidence, organizationPolicy = null) {
  const manifestFile = writeJson(root, `${id}-manifest.json`, manifest);
  const evidenceFile = writeJson(root, `${id}-evidence.json`, evidence);
  if (organizationPolicy === null) return { manifestFile, evidenceFile };
  const organizationPolicyFile = writeJson(root, `${id}-organization.json`, organizationPolicy);
  return { manifestFile, evidenceFile, organizationPolicyFile };
}

/** @returns {any} */
function organizationPolicy() {
  return {
    version: 1,
    organization: { id: "example-org" },
    global: { requirements: { runtime: false, database: false, capabilities: [] }, checks: { required: ["organization-gate"], advisory: [] } },
    profiles: [],
    repositories: [],
  };
}

test("dashboard config validates explicit generation time and repository inputs", () => {
  const result = validateEcosystemDashboardConfig({ version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [{ manifestFile: "a.json", evidenceFile: "b.json" }] });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(validateEcosystemDashboardConfig({ version: 1, generatedAt: "today", repositories: [] }).valid, false);
});

test("all scoped required and advisory checks passing yields ecosystem PASS", () => {
  const root = workspace();
  const first = rawManifest("a-web"), second = rawManifest("b-web");
  const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "b", second, evidenceFor(second)), addRepository(root, "a", first, evidenceFor(first))] };
  const report = inspectEcosystemDashboard(config, root);
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.repositories.map((/** @type {any} */ item) => item.repository), ["a-web", "b-web"]);
  assert.equal(report.summary.pass, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("required FAIL blocks while required WARN UNVERIFIED or missing produce WARN", () => {
  const cases = [
    { status: "FAIL", expected: "FAIL" },
    { status: "WARN", expected: "WARN" },
    { status: "UNVERIFIED", expected: "WARN" },
  ];
  for (const item of cases) {
    const root = workspace(), manifest = rawManifest("example-web");
    const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "repo", manifest, evidenceFor(manifest, { "public-safety": item.status }))] };
    assert.equal(inspectEcosystemDashboard(config, root).overallStatus, item.expected);
    fs.rmSync(root, { recursive: true, force: true });
  }
  const root = workspace(), manifest = rawManifest("missing-web");
  const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "repo", manifest, evidenceFor(manifest, {}, ["public-safety"]))] };
  const report = inspectEcosystemDashboard(config, root);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.repositories[0]?.required.missing, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("advisory non-pass status is visible but cannot block the ecosystem", () => {
  const root = workspace(), manifest = rawManifest("example-web");
  const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "repo", manifest, evidenceFor(manifest, { seo: "FAIL" }))] };
  const report = inspectEcosystemDashboard(config, root);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.repositories[0]?.advisory.fail, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("unscoped observed checks remain visible without changing policy truth", () => {
  const root = workspace(), manifest = rawManifest("example-web"), evidence = evidenceFor(manifest);
  evidence.checks.push({ id: "experimental-check", status: "FAIL" });
  const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "repo", manifest, evidence)] };
  const report = inspectEcosystemDashboard(config, root);
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.repositories[0]?.unscopedChecks, [{ id: "experimental-check", status: "FAIL" }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test("future-dated check evidence warns without rewriting observed check states", () => {
  const root = workspace(), manifest = rawManifest("example-web");
  const evidence = evidenceFor(manifest, {}, [], "2026-09-17T08:00:00Z");
  const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "repo", manifest, evidence)] };
  const report = inspectEcosystemDashboard(config, root);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(Reflect.get(report.repositories[0] ?? {}, "evidenceTimeStatus"), "FUTURE");
  fs.rmSync(root, { recursive: true, force: true });
});

test("private organization policy controls dashboard severity and missing required evidence", () => {
  const root = workspace(), manifest = rawManifest("example-web"), evidence = evidenceFor(manifest);
  let config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "repo", manifest, evidence, organizationPolicy())] };
  let report = inspectEcosystemDashboard(config, root);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.repositories[0]?.required.missing, 1);
  evidence.checks.push({ id: "organization-gate", status: "PASS" });
  config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "repo2", manifest, evidence, organizationPolicy())] };
  report = inspectEcosystemDashboard(config, root);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.repositories[0]?.policySource, "organization");
  fs.rmSync(root, { recursive: true, force: true });
});

test("policy resolution failure is blocking without becoming a technical read failure", () => {
  const root = workspace(), manifest = rawManifest("db-web", "database-backed-webapp"), evidence = { version: 1, repository: { id: "db-web" }, evidence: { source: "synthetic", authenticated: false, collectedAt: "2026-09-17T07:00:00Z" }, checks: [] };
  const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "repo", manifest, evidence)] };
  const report = inspectEcosystemDashboard(config, root);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.repositories[0]?.technicalStatus, "PASS");
  assert.equal(report.repositories[0]?.policyStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("evidence repository identity mismatch is isolated as technical FAIL", () => {
  const root = workspace(), manifest = rawManifest("example-web"), evidence = evidenceFor(manifest);
  evidence.repository.id = "other-web";
  const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "repo", manifest, evidence)] };
  const report = inspectEcosystemDashboard(config, root);
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.repositories[0]?.overallStatus, "FAIL");
  fs.rmSync(root, { recursive: true, force: true });
});

test("duplicate repository identities fail both rows instead of double-counting one project", () => {
  const root = workspace(), manifest = rawManifest("example-web"), evidence = evidenceFor(manifest);
  const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "one", manifest, evidence), addRepository(root, "two", manifest, evidence)] };
  const report = inspectEcosystemDashboard(config, root);
  assert.equal(report.summary.fail, 2);
  assert.equal(report.summary.technicalFail, 2);
  fs.rmSync(root, { recursive: true, force: true });
});

test("malformed repository input is isolated while later repositories still evaluate", () => {
  const root = workspace(), good = rawManifest("good-web");
  fs.writeFileSync(path.join(root, "bad-manifest.json"), "{");
  fs.writeFileSync(path.join(root, "bad-evidence.json"), "{}");
  const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [{ manifestFile: "bad-manifest.json", evidenceFile: "bad-evidence.json" }, addRepository(root, "good", good, evidenceFor(good))] };
  const report = inspectEcosystemDashboard(config, root);
  assert.equal(report.summary.fail, 1);
  assert.equal(report.summary.pass, 1);
  fs.rmSync(root, { recursive: true, force: true });
});

test("human output is compact and omits private file paths", () => {
  const root = workspace(), manifest = rawManifest("example-web");
  const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "private-file-name", manifest, evidenceFor(manifest))] };
  const text = formatEcosystemDashboard(inspectEcosystemDashboard(config, root));
  assert.match(text, /Ecosystem dashboard/);
  assert.match(text, /example-web/);
  assert.doesNotMatch(text, /private-file-name/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI resolves config-relative files and emits stable machine-readable dashboard", () => {
  const root = workspace(), manifest = rawManifest("example-web");
  const config = { version: 1, generatedAt: "2026-09-17T07:10:00Z", repositories: [addRepository(root, "repo", manifest, evidenceFor(manifest))] };
  const configFile = path.join(root, "dashboard.json"); fs.writeFileSync(configFile, JSON.stringify(config));
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--config", configFile, "--json"]), 0); } finally { console.log = original; }
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.version, 1);
  assert.equal(parsed.overallStatus, "PASS");
  assert.equal(parsed.repositories[0].repository, "example-web");
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI rejects malformed config and dashboard engine has no network or mutation surface", () => {
  const root = workspace(), configFile = path.join(root, "bad.json"); fs.writeFileSync(configFile, "{");
  assert.equal(main(["--config", configFile]), 1);
  assert.equal(main(["--unknown"]), 1);
  const source = fs.readFileSync(new URL("../scripts/ecosystem-dashboard.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  fs.rmSync(root, { recursive: true, force: true });
});
