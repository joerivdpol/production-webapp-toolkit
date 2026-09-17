#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateCiEvidence } from "./ci-evidence.js";
import { validateArtifactProvenance } from "./artifact-provenance.js";
import { inspectArtifactProvenance } from "./audit-artifact-provenance.js";
import { validateRuntimeEvidence, isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";
import { validateRuntimeHealthEvidence } from "./runtime-health-evidence.js";
import { validateRuntimeHealthPolicy, inspectRuntimeHealth } from "./audit-runtime-health.js";
import { validateVulnerabilityEvidence } from "./vulnerability-evidence.js";
import { validateVulnerabilityPolicy, inspectVulnerabilities } from "./audit-vulnerabilities.js";
import { inspectProductionBaseline } from "./audit-production-baseline.js";

const SHA256 = /^[a-fA-F0-9]{64}$/;
const MAX_EVIDENCE_BYTES = 32 * 1024 * 1024;
export const REQUIRED_RELEASE_BUNDLE_CHECK_IDS = [
  "artifact-provenance-coherent",
  "baseline-resolvable",
  "ci-evidence-time",
  "ci-source-commit",
  "health-runtime-environment",
  "health-runtime-name",
  "provenance-evidence-time",
  "provenance-source-commit",
  "runtime-evidence-time",
  "runtime-health-evidence-time",
  "runtime-source-commit",
  "sbom-artifact-hash",
  "sbom-evidence-time",
  "sbom-source-commit",
  "source-checkout-binding",
  "vulnerability-evidence-time",
];
const REQUIRED_RELEASE_BUNDLE_CHECK_ID_SET = new Set(REQUIRED_RELEASE_BUNDLE_CHECK_IDS);

const RESERVED_INDEX_IDS = new Set([
  "ci-evidence",
  "dependency-sbom",
  "vulnerability-evidence",
  "vulnerability-policy",
  "artifact-provenance",
  "runtime-evidence",
  "runtime-health-evidence",
  "runtime-health-policy",
]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}
/** @param {unknown} value */
function portableId(value) {
  const normalized = text(value, 128);
  return normalized && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(normalized) ? normalized : null;
}
/** @param {Buffer} value */
function sha256(value) { return crypto.createHash("sha256").update(value).digest("hex"); }

/** @param {string} filename @param {number} [maxBytes] */
function readEvidenceFile(filename, maxBytes = MAX_EVIDENCE_BYTES) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch { throw new Error("release evidence input is missing"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > maxBytes) {
    throw new Error("release evidence input must be a bounded non-empty regular file");
  }
  const bytes = fs.readFileSync(filename);
  if (bytes.includes(0)) throw new Error("release evidence JSON input contains binary NUL content");
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("release evidence JSON input cannot be parsed"); }
  return { bytes, value, sha256: sha256(bytes) };
}

/** @param {unknown} value */
export function validateCycloneDxReleaseSnapshot(value) {
  if (!object(value) || value.bomFormat !== "CycloneDX" || value.specVersion !== "1.7" || value.version !== 1) {
    return { valid: false, snapshot: null, error: "dependency snapshot must be CycloneDX 1.7 version 1" };
  }
  if (!object(value.metadata) || !object(value.metadata.component) || !Array.isArray(value.metadata.properties)) {
    return { valid: false, snapshot: null, error: "CycloneDX release metadata is incomplete" };
  }
  const rootName = text(value.metadata.component.name), rootVersion = text(value.metadata.component.version);
  if (!rootName || !rootVersion || !Array.isArray(value.metadata.component.hashes)) {
    return { valid: false, snapshot: null, error: "CycloneDX root component identity is incomplete" };
  }
  const rootHash = value.metadata.component.hashes.find((/** @type {any} */ item) => object(item) && item.alg === "SHA-256" && typeof item.content === "string");
  const artifactSha256 = typeof rootHash?.content === "string" ? rootHash.content.toLowerCase() : null;
  if (!artifactSha256 || !SHA256.test(artifactSha256)) return { valid: false, snapshot: null, error: "CycloneDX root artifact SHA256 is invalid" };
  const properties = new Map();
  for (const raw of value.metadata.properties) {
    if (!object(raw)) return { valid: false, snapshot: null, error: "CycloneDX metadata property is invalid" };
    const name = text(raw.name), propertyValue = text(raw.value, 1024);
    if (!name || !propertyValue || properties.has(name)) return { valid: false, snapshot: null, error: "CycloneDX metadata properties must be unique non-empty strings" };
    properties.set(name, propertyValue);
  }
  const sourceCommit = properties.get("toolkit:sourceCommit")?.toLowerCase() ?? null;
  if (!sourceCommit || !isFullObjectId(sourceCommit)) return { valid: false, snapshot: null, error: "CycloneDX snapshot lacks a valid toolkit source commit" };
  if (!Array.isArray(value.components)) return { valid: false, snapshot: null, error: "CycloneDX components must be an array" };
  const componentRefs = new Set();
  for (const component of value.components) {
    if (!object(component)) return { valid: false, snapshot: null, error: "CycloneDX component is invalid" };
    const name = text(component.name), version = text(component.version), ref = text(component["bom-ref"], 1024);
    if (!name || !version || !ref || ref !== `npm:${name}@${version}` || componentRefs.has(ref)) {
      return { valid: false, snapshot: null, error: "CycloneDX npm component identity is invalid or duplicate" };
    }
    componentRefs.add(ref);
  }
  const createdAt = text(value.metadata.timestamp, 128);
  if (!createdAt || !isAbsoluteIsoTimestamp(createdAt)) return { valid: false, snapshot: null, error: "CycloneDX metadata timestamp must be an absolute ISO timestamp" };
  return {
    valid: true,
    snapshot: { sourceCommit, artifactSha256, root: { name: rootName, version: rootVersion }, componentRefs: [...componentRefs].sort(), createdAt },
    error: null,
  };
}

/** @param {string} id @param {{sha256:string}} file */
function indexEntry(id, file) { return { id, sha256: file.sha256 }; }
/** @param {string|null|undefined} collectedAt @param {string} createdAt */
function isNotFuture(collectedAt, createdAt) { return typeof collectedAt === "string" && Date.parse(collectedAt) <= Date.parse(createdAt); }

/** @param {string} root @param {any} options */
export function buildReleaseEvidenceBundle(root, options) {
  const sourceCommit = text(options.sourceCommit, 128)?.toLowerCase() ?? null;
  const baselineCommit = text(options.baselineCommit, 128)?.toLowerCase() ?? null;
  const createdAt = text(options.createdAt, 128);
  if (!sourceCommit || !isFullObjectId(sourceCommit) || !baselineCommit || !isFullObjectId(baselineCommit) || !createdAt || !isAbsoluteIsoTimestamp(createdAt)) {
    throw new Error("release bundle requires full source/baseline commits and an absolute createdAt timestamp");
  }
  const repositoryRoot = path.resolve(root);
  let rootStat; try { rootStat = fs.lstatSync(repositoryRoot); } catch { rootStat = null; }
  if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("release bundle repository must be a regular non-symlink directory");

  const files = {
    ci: readEvidenceFile(options.ciEvidenceFile),
    sbom: readEvidenceFile(options.sbomFile),
    vulnerabilities: readEvidenceFile(options.vulnerabilityEvidenceFile),
    vulnerabilityPolicy: readEvidenceFile(options.vulnerabilityPolicyFile),
    provenance: readEvidenceFile(options.artifactProvenanceFile),
    runtime: readEvidenceFile(options.runtimeEvidenceFile),
    health: readEvidenceFile(options.runtimeHealthEvidenceFile),
    healthPolicy: readEvidenceFile(options.runtimeHealthPolicyFile),
  };

  const ciResult = validateCiEvidence(files.ci.value);
  const provenanceResult = validateArtifactProvenance(files.provenance.value);
  const runtimeResult = validateRuntimeEvidence(files.runtime.value);
  const healthResult = validateRuntimeHealthEvidence(files.health.value);
  const healthPolicyResult = validateRuntimeHealthPolicy(files.healthPolicy.value);
  const vulnerabilityResult = validateVulnerabilityEvidence(files.vulnerabilities.value);
  const vulnerabilityPolicyResult = validateVulnerabilityPolicy(files.vulnerabilityPolicy.value);
  const sbomResult = validateCycloneDxReleaseSnapshot(files.sbom.value);
  if (!ciResult.valid || !ciResult.evidence || !provenanceResult.valid || !provenanceResult.provenance || !runtimeResult.valid || !runtimeResult.evidence ||
      !healthResult.valid || !healthResult.evidence || !healthPolicyResult.ok || !healthPolicyResult.policy ||
      !vulnerabilityResult.ok || !vulnerabilityResult.evidence || !vulnerabilityPolicyResult.ok || !vulnerabilityPolicyResult.policy ||
      !sbomResult.valid || !sbomResult.snapshot) {
    throw new Error("one or more release evidence contracts are invalid");
  }
  if (healthPolicyResult.policy.evaluatedAt !== createdAt || vulnerabilityPolicyResult.policy.evaluatedAt !== createdAt) {
    throw new Error("release bundle audit policies must use the exact bundle createdAt evaluation time");
  }

  /** @type {Array<{id:string,status:"PASS"|"FAIL",detail:string}>} */ const checks = [];
  /** @param {string} id @param {boolean} passed @param {string} detail */
  const add = (id, passed, detail) => checks.push({ id, status: passed ? "PASS" : "FAIL", detail });
  add("ci-source-commit", ciResult.evidence.commit === sourceCommit, "CI evidence commit must equal the release source commit");
  add("provenance-source-commit", provenanceResult.provenance.source.commit === sourceCommit, "artifact provenance source must equal the release source commit");
  add("runtime-source-commit", runtimeResult.evidence.deployment.commit === sourceCommit, "runtime deployment commit must equal the release source commit");
  add("sbom-source-commit", sbomResult.snapshot.sourceCommit === sourceCommit, "dependency snapshot source must equal the release source commit");
  add("sbom-artifact-hash", sbomResult.snapshot.artifactSha256 === provenanceResult.provenance.build.artifact.sha256, "dependency snapshot artifact hash must equal artifact provenance build hash");
  add("health-runtime-name", healthResult.evidence.runtime.name === runtimeResult.evidence.runtime.name, "runtime health identity name must equal runtime deployment identity");
  add("health-runtime-environment", (healthResult.evidence.runtime.environment ?? null) === (runtimeResult.evidence.runtime.environment ?? null), "runtime health environment must equal runtime deployment environment exactly");

  const provenanceAudit = inspectArtifactProvenance(provenanceResult.provenance, ciResult.evidence, runtimeResult.evidence);
  add("artifact-provenance-coherent", provenanceAudit.overallStatus === "PASS", "canonical artifact provenance audit must match across CI, artifact, deployment and runtime evidence");

  const healthAudit = inspectRuntimeHealth(healthResult.evidence, healthPolicyResult.policy);
  const vulnerabilityAudit = inspectVulnerabilities(vulnerabilityResult.evidence, vulnerabilityPolicyResult.policy);

  for (const pkg of vulnerabilityResult.evidence.packages) {
    const ref = pkg.ecosystem.toLowerCase() === "npm" ? `npm:${pkg.name}@${pkg.version}` : null;
    add(`vulnerability-package:${pkg.ecosystem}:${pkg.name}@${pkg.version}`, ref !== null && sbomResult.snapshot.componentRefs.includes(ref), "every vulnerability evidence package must be present in the dependency snapshot at the exact version");
  }

  /** @type {Array<[string,string]>} */
  const times = [
    ["ci-evidence-time", ciResult.evidence.evidence.collectedAt],
    ["provenance-evidence-time", provenanceResult.provenance.evidence.collectedAt],
    ["runtime-evidence-time", runtimeResult.evidence.evidence.collectedAt],
    ["runtime-health-evidence-time", healthResult.evidence.evidence.collectedAt],
    ["vulnerability-evidence-time", vulnerabilityResult.evidence.source.collectedAt],
  ];
  for (const [id, timestamp] of times) add(id, isNotFuture(timestamp, createdAt), "evidence collection time must not be later than bundle creation time");
  add("sbom-evidence-time", isNotFuture(sbomResult.snapshot.createdAt, createdAt), "dependency snapshot timestamp must not be later than bundle creation time");

  const baseline = inspectProductionBaseline(repositoryRoot, { expectedCommit: baselineCommit, compareRef: "HEAD" });
  add("source-checkout-binding", baseline.head === sourceCommit, "repository HEAD must equal the release source commit when the bundle is created");
  add("baseline-resolvable", baseline.technicalStatus === "PASS" && baseline.expectedResolvedCommit === baselineCommit && baseline.comparisonResolvedCommit === sourceCommit, "baseline commit and HEAD-bound release commit must both resolve locally through the canonical baseline audit");

  /** @type {Array<{id:string,sha256:string}>} */ const evidenceIndex = [
    indexEntry("ci-evidence", files.ci),
    indexEntry("dependency-sbom", files.sbom),
    indexEntry("vulnerability-evidence", files.vulnerabilities),
    indexEntry("vulnerability-policy", files.vulnerabilityPolicy),
    indexEntry("artifact-provenance", files.provenance),
    indexEntry("runtime-evidence", files.runtime),
    indexEntry("runtime-health-evidence", files.health),
    indexEntry("runtime-health-policy", files.healthPolicy),
  ];
  const extraPolicyIds = new Set();
  for (const policyFile of options.policyFiles ?? []) {
    const id = portableId(policyFile.id);
    if (!id || RESERVED_INDEX_IDS.has(id) || extraPolicyIds.has(id)) throw new Error("release bundle extra policy ids must be unique portable non-reserved identifiers");
    extraPolicyIds.add(id);
    const file = readEvidenceFile(policyFile.file, 8 * 1024 * 1024);
    evidenceIndex.push(indexEntry(id, file));
  }
  evidenceIndex.sort((a, b) => a.id.localeCompare(b.id));

  const fail = checks.filter((item) => item.status === "FAIL").length;
  return {
    version: 1,
    source: { commit: sourceCommit },
    createdAt,
    baseline: {
      commit: baselineCommit,
      status: baseline.baselineStatus,
      relationship: baseline.relationship,
      ahead: baseline.ahead,
      behind: baseline.behind,
    },
    artifact: { name: provenanceResult.provenance.build.artifact.name, sha256: provenanceResult.provenance.build.artifact.sha256 },
    runtime: { ...runtimeResult.evidence.runtime },
    trust: {
      ciAuthenticated: ciResult.evidence.evidence.authenticated,
      provenanceAuthenticated: provenanceResult.provenance.evidence.authenticated,
      runtimeAuthenticated: runtimeResult.evidence.evidence.authenticated,
      runtimeHealthAuthenticated: healthResult.evidence.evidence.authenticated,
      vulnerabilityAuthenticated: vulnerabilityResult.evidence.source.authenticated,
    },
    results: {
      ciChecks: ciResult.evidence.checks.map((item) => ({ name: item.name, status: item.status })),
      artifactProvenance: provenanceAudit.overallStatus,
      runtimeHealth: healthAudit.overallStatus,
      vulnerabilities: vulnerabilityAudit.overallStatus,
      vulnerabilityFindings: vulnerabilityAudit.findingCount,
    },
    evidenceIndex,
    checks: checks.sort((a, b) => a.id.localeCompare(b.id)),
    summary: { pass: checks.length - fail, fail },
    technicalStatus: "PASS",
    bundleStatus: fail > 0 ? "INVALID" : "VALID",
    semantics: "evidence-index validity and cross-contract coherence only; embedded audit FAIL/WARN results are preserved and do not make the bundle itself invalid",
  };
}

/** @param {unknown} value */
export function validateReleaseEvidenceBundle(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, bundle: null, errors: [{ id: "bundle-invalid", detail: "release evidence bundle must be an object" }] };
  const allowed = ["version", "source", "createdAt", "baseline", "artifact", "runtime", "trust", "results", "evidenceIndex", "checks", "summary", "technicalStatus", "bundleStatus", "semantics"];
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: "bundle-field-unknown", detail: `bundle contains unsupported field "${key}"` });
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let source = null;
  if (!object(value.source)) errors.push({ id: "source-invalid", detail: "source must be an object" });
  else {
    if (Object.keys(value.source).some((key) => key !== "commit")) errors.push({ id: "source-field-unknown", detail: "source contains unsupported fields" });
    const commit = text(value.source.commit, 128)?.toLowerCase() ?? null;
    if (!commit || !isFullObjectId(commit)) errors.push({ id: "source-commit-invalid", detail: "source.commit must be a full Git object id" });
    else source = { commit };
  }
  const createdAt = text(value.createdAt, 128);
  if (!createdAt || !isAbsoluteIsoTimestamp(createdAt)) errors.push({ id: "created-at-invalid", detail: "createdAt must be an absolute ISO timestamp" });

  let baseline = null;
  if (!object(value.baseline)) errors.push({ id: "baseline-invalid", detail: "baseline must be an object" });
  else {
    const allowedBaseline = ["commit", "status", "relationship", "ahead", "behind"];
    if (Object.keys(value.baseline).some((key) => !allowedBaseline.includes(key))) errors.push({ id: "baseline-field-unknown", detail: "baseline contains unsupported fields" });
    const commit = text(value.baseline.commit, 128)?.toLowerCase() ?? null;
    const status = text(value.baseline.status, 32), relationship = text(value.baseline.relationship, 64);
    /** @param {unknown} input */
    const distance = (input) => input === null || (Number.isSafeInteger(input) && Number(input) >= 0) ? input : undefined;
    const ahead = distance(value.baseline.ahead), behind = distance(value.baseline.behind);
    if (!commit || !isFullObjectId(commit) || !status || !relationship || ahead === undefined || behind === undefined) errors.push({ id: "baseline-fields-invalid", detail: "baseline identity or relationship fields are invalid" });
    else baseline = { commit, status, relationship, ahead, behind };
  }

  let artifact = null;
  if (!object(value.artifact)) errors.push({ id: "artifact-invalid", detail: "artifact must be an object" });
  else {
    if (Object.keys(value.artifact).some((key) => !["name", "sha256"].includes(key))) errors.push({ id: "artifact-field-unknown", detail: "artifact contains unsupported fields" });
    const name = text(value.artifact.name), hash = text(value.artifact.sha256, 64)?.toLowerCase() ?? null;
    if (!name || !hash || !SHA256.test(hash)) errors.push({ id: "artifact-fields-invalid", detail: "artifact requires name and SHA256" });
    else artifact = { name, sha256: hash };
  }

  let runtime = null;
  if (!object(value.runtime)) errors.push({ id: "runtime-invalid", detail: "runtime must be an object" });
  else {
    if (Object.keys(value.runtime).some((key) => !["name", "environment"].includes(key))) errors.push({ id: "runtime-field-unknown", detail: "runtime contains unsupported fields" });
    const name = text(value.runtime.name), environment = value.runtime.environment === undefined ? null : text(value.runtime.environment);
    if (!name || (value.runtime.environment !== undefined && !environment)) errors.push({ id: "runtime-fields-invalid", detail: "runtime requires name and non-empty optional environment" });
    else runtime = { name, ...(environment ? { environment } : {}) };
  }

  let trust = null;
  const trustKeys = ["ciAuthenticated", "provenanceAuthenticated", "runtimeAuthenticated", "runtimeHealthAuthenticated", "vulnerabilityAuthenticated"];
  const rawTrust = value.trust;
  if (!object(rawTrust) || Object.keys(rawTrust).some((key) => !trustKeys.includes(key)) || trustKeys.some((key) => typeof rawTrust[key] !== "boolean")) errors.push({ id: "trust-invalid", detail: "trust must contain the five explicit authentication booleans" });
  else trust = Object.fromEntries(trustKeys.map((key) => [key, rawTrust[key]]));

  let results = null;
  const allowedResultStatus = new Set(["PASS", "WARN", "FAIL"]);
  if (!object(value.results)) errors.push({ id: "results-invalid", detail: "results must be an object" });
  else {
    const resultKeys = ["ciChecks", "artifactProvenance", "runtimeHealth", "vulnerabilities", "vulnerabilityFindings"];
    if (Object.keys(value.results).some((key) => !resultKeys.includes(key)) || !Array.isArray(value.results.ciChecks)) errors.push({ id: "results-fields-invalid", detail: "results contains unsupported or missing fields" });
    else {
      const names = new Set();
      const ciChecks = [];
      for (const raw of value.results.ciChecks) {
        if (!object(raw) || Object.keys(raw).some((key) => !["name", "status"].includes(key))) { errors.push({ id: "ci-result-invalid", detail: "ciChecks entries must contain only name and status" }); continue; }
        const name = text(raw.name), status = text(raw.status, 16);
        if (!name || names.has(name) || !status || !new Set(["PASS", "FAIL", "SKIPPED", "MISSING"]).has(status)) { errors.push({ id: "ci-result-fields-invalid", detail: "ciChecks entries must be unique canonical statuses" }); continue; }
        names.add(name); ciChecks.push({ name, status });
      }
      const artifactProvenance = text(value.results.artifactProvenance, 16), runtimeHealth = text(value.results.runtimeHealth, 16), vulnerabilities = text(value.results.vulnerabilities, 16);
      const vulnerabilityFindings = Number.isSafeInteger(value.results.vulnerabilityFindings) && Number(value.results.vulnerabilityFindings) >= 0 ? Number(value.results.vulnerabilityFindings) : null;
      if (!artifactProvenance || !new Set(["PASS", "FAIL"]).has(artifactProvenance) || !runtimeHealth || !allowedResultStatus.has(runtimeHealth) || !vulnerabilities || !allowedResultStatus.has(vulnerabilities) || vulnerabilityFindings === null) errors.push({ id: "results-status-invalid", detail: "results statuses or finding count are invalid" });
      else results = { ciChecks: ciChecks.sort((a, b) => a.name.localeCompare(b.name)), artifactProvenance, runtimeHealth, vulnerabilities, vulnerabilityFindings };
    }
  }

  const evidenceIndex = [];
  if (!Array.isArray(value.evidenceIndex) || value.evidenceIndex.length < RESERVED_INDEX_IDS.size || value.evidenceIndex.length > 512) errors.push({ id: "evidence-index-invalid", detail: "evidenceIndex must contain the canonical evidence set" });
  else {
    const ids = new Set();
    for (const raw of value.evidenceIndex) {
      if (!object(raw) || Object.keys(raw).some((key) => !["id", "sha256"].includes(key))) { errors.push({ id: "evidence-index-entry-invalid", detail: "evidenceIndex entry must contain id and SHA256 only" }); continue; }
      const id = portableId(raw.id), hash = text(raw.sha256, 64)?.toLowerCase() ?? null;
      if (!id || ids.has(id) || !hash || !SHA256.test(hash)) { errors.push({ id: "evidence-index-entry-fields-invalid", detail: "evidenceIndex ids and hashes must be unique and valid" }); continue; }
      ids.add(id); evidenceIndex.push({ id, sha256: hash });
    }
    for (const required of RESERVED_INDEX_IDS) if (!ids.has(required)) errors.push({ id: "evidence-index-required-missing", detail: `evidenceIndex is missing ${required}` });
  }

  const checks = [];
  if (!Array.isArray(value.checks) || value.checks.length === 0) errors.push({ id: "checks-invalid", detail: "checks must be a non-empty array" });
  else {
    const ids = new Set();
    for (const raw of value.checks) {
      if (!object(raw) || Object.keys(raw).some((key) => !["id", "status", "detail"].includes(key))) { errors.push({ id: "check-invalid", detail: "bundle checks must contain id status and detail only" }); continue; }
      const id = text(raw.id, 512), status = text(raw.status, 16), detail = text(raw.detail, 1024);
      if (!id || ids.has(id) || !status || !["PASS", "FAIL"].includes(status) || !detail) { errors.push({ id: "check-fields-invalid", detail: "bundle checks must be unique PASS/FAIL findings" }); continue; }
      ids.add(id); checks.push({ id, status, detail });
    }
  }

  const checkIds = new Set(checks.map((item) => item.id));
  for (const required of REQUIRED_RELEASE_BUNDLE_CHECK_ID_SET) {
    if (!checkIds.has(required)) errors.push({ id: "required-coherence-check-missing", detail: `release bundle is missing canonical coherence check ${required}` });
  }

  const pass = checks.filter((item) => item.status === "PASS").length, fail = checks.filter((item) => item.status === "FAIL").length;
  if (!object(value.summary) || Object.keys(value.summary).some((key) => !["pass", "fail"].includes(key)) || value.summary.pass !== pass || value.summary.fail !== fail) errors.push({ id: "summary-invalid", detail: "summary must exactly match bundle check counts" });
  const expectedBundleStatus = fail > 0 ? "INVALID" : "VALID";
  if (value.technicalStatus !== "PASS" || value.bundleStatus !== expectedBundleStatus) errors.push({ id: "bundle-status-invalid", detail: "technicalStatus or bundleStatus does not match bundle checks" });
  const semantics = text(value.semantics, 2048);
  if (!semantics) errors.push({ id: "semantics-invalid", detail: "bundle semantics must be explicit" });

  if (errors.length > 0 || !source || !createdAt || !baseline || !artifact || !runtime || !trust || !results || !semantics) return { valid: false, bundle: null, errors };
  return { valid: true, bundle: { version: 1, source, createdAt, baseline, artifact, runtime, trust, results, evidenceIndex: evidenceIndex.sort((a, b) => a.id.localeCompare(b.id)), checks: checks.sort((a, b) => a.id.localeCompare(b.id)), summary: { pass, fail }, technicalStatus: "PASS", bundleStatus: expectedBundleStatus, semantics }, errors: [] };
}

/** @param {ReturnType<typeof buildReleaseEvidenceBundle>} bundle */
export function formatReleaseEvidenceBundle(bundle) {
  const lines = ["Release Evidence Bundle v1", "", `Source commit: ${bundle.source.commit}`, `Created at: ${bundle.createdAt}`, `Baseline: ${bundle.baseline.commit} (${bundle.baseline.relationship})`, `Artifact: ${bundle.artifact.name} ${bundle.artifact.sha256}`, `Runtime: ${bundle.runtime.name}${bundle.runtime.environment ? ` / ${bundle.runtime.environment}` : ""}`, `Evidence entries: ${bundle.evidenceIndex.length}`, `CI checks: ${bundle.results.ciChecks.length}`, `Artifact provenance: ${bundle.results.artifactProvenance}`, `Runtime health: ${bundle.results.runtimeHealth}`, `Vulnerabilities: ${bundle.results.vulnerabilities} (${bundle.results.vulnerabilityFindings} findings)`, `Semantics: ${bundle.semantics}`, ""];
  for (const check of bundle.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.detail}`);
  lines.push("", `Coherence checks: ${bundle.summary.pass} pass, ${bundle.summary.fail} fail`, `Bundle: ${bundle.bundleStatus}`);
  return lines.join("\n");
}

/** @param {string} value */
function policyFileArgument(value) {
  const index = value.indexOf("=");
  if (index <= 0 || index === value.length - 1) return null;
  return { id: value.slice(0, index), file: value.slice(index + 1) };
}

/** @param {string[]} argv */
function parse(argv) {
  const values = new Map();
  /** @type {Array<{id:string,file:string}>} */ const policyFiles = [];
  let json = false;
  const scalarArgs = new Set(["--root", "--source-commit", "--baseline-commit", "--created-at", "--ci-evidence-file", "--sbom-file", "--vulnerability-evidence-file", "--vulnerability-policy-file", "--artifact-provenance-file", "--runtime-evidence-file", "--runtime-health-evidence-file", "--runtime-health-policy-file"]);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") { json = true; continue; }
    const next = argv[i + 1];
    if (typeof next !== "string" || next.startsWith("--")) return null;
    i += 1;
    if (arg === "--policy-file") {
      const parsed = policyFileArgument(next); if (!parsed) return null; policyFiles.push(parsed); continue;
    }
    if (!scalarArgs.has(arg ?? "") || values.has(arg)) return null;
    values.set(arg, next);
  }
  for (const arg of scalarArgs) if (!values.has(arg)) return null;
  return {
    root: values.get("--root"), sourceCommit: values.get("--source-commit"), baselineCommit: values.get("--baseline-commit"), createdAt: values.get("--created-at"),
    ciEvidenceFile: values.get("--ci-evidence-file"), sbomFile: values.get("--sbom-file"), vulnerabilityEvidenceFile: values.get("--vulnerability-evidence-file"), vulnerabilityPolicyFile: values.get("--vulnerability-policy-file"), artifactProvenanceFile: values.get("--artifact-provenance-file"), runtimeEvidenceFile: values.get("--runtime-evidence-file"), runtimeHealthEvidenceFile: values.get("--runtime-health-evidence-file"), runtimeHealthPolicyFile: values.get("--runtime-health-policy-file"), policyFiles, json,
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/release-evidence-bundle.js --root <repository> --source-commit <full-sha> --baseline-commit <full-sha> --created-at <ISO> --ci-evidence-file <ci.json> --sbom-file <sbom.json> --vulnerability-evidence-file <vuln.json> --vulnerability-policy-file <policy.json> --artifact-provenance-file <provenance.json> --runtime-evidence-file <runtime.json> --runtime-health-evidence-file <health.json> --runtime-health-policy-file <health-policy.json> [--policy-file <id>=<file> ...] [--json]"); return 1; }
  try {
    const bundle = buildReleaseEvidenceBundle(options.root, options);
    console.log(options.json ? JSON.stringify(bundle) : formatReleaseEvidenceBundle(bundle));
    return bundle.bundleStatus === "INVALID" ? 1 : 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Release evidence bundle creation failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
