#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateReleaseEvidenceBundle } from "./release-evidence-bundle.js";

const RESULT_KEYS = new Set(["artifactProvenance", "runtimeHealth", "vulnerabilities"]);

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
/** @param {unknown} value @param {boolean} allowEmpty */
function idList(value, allowEmpty) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 256) return null;
  const normalized = value.map(portableId);
  if (normalized.some((item) => item === null)) return null;
  const items = /** @type {string[]} */ (normalized);
  return new Set(items).size === items.length ? items.sort() : null;
}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
}

/** @param {unknown} value */
export function validateComplianceExportMapping(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, mapping: null, errors: [{ id: "mapping-invalid", detail: "compliance export mapping must be an object" }] };
  rejectUnknown(value, ["version", "name", "controls"], "mapping", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const name = portableId(value.name);
  if (!name) errors.push({ id: "mapping-name-invalid", detail: "mapping name must be a portable identifier" });

  /** @type {Array<{id:string,evidenceIds:string[],resultKeys:string[]}>} */ const controls = [];
  const ids = new Set();
  if (!Array.isArray(value.controls) || value.controls.length === 0 || value.controls.length > 512) {
    errors.push({ id: "controls-invalid", detail: "controls must be a non-empty bounded array" });
  } else for (const [index, raw] of value.controls.entries()) {
    if (!object(raw)) { errors.push({ id: "control-invalid", detail: `controls[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["id", "evidenceIds", "resultKeys"], "control", errors);
    const id = portableId(raw.id), evidenceIds = idList(raw.evidenceIds, false), resultKeys = raw.resultKeys === undefined ? [] : idList(raw.resultKeys, true);
    if (!id || ids.has(id) || !evidenceIds || !resultKeys || resultKeys.some((key) => !RESULT_KEYS.has(key))) {
      errors.push({ id: "control-fields-invalid", detail: `controls[${index}] requires unique id, evidenceIds, and supported resultKeys` });
      continue;
    }
    ids.add(id); controls.push({ id, evidenceIds, resultKeys });
  }
  if (errors.length > 0 || !name) return { valid: false, mapping: null, errors };
  return { valid: true, mapping: { version: 1, name, controls: controls.sort((a, b) => a.id.localeCompare(b.id)) }, errors: [] };
}

/** @param {any} bundle @param {any} mapping */
export function buildComplianceEvidenceExport(bundle, mapping) {
  const evidence = new Map(bundle.evidenceIndex.map((/** @type {any} */ item) => [item.id, item]));
  const controls = mapping.controls.map((/** @type {any} */ control) => {
    const missingEvidence = control.evidenceIds.filter((/** @type {string} */ id) => !evidence.has(id));
    const selectedEvidence = control.evidenceIds.filter((/** @type {string} */ id) => evidence.has(id)).map((/** @type {string} */ id) => evidence.get(id));
    const missingResults = control.resultKeys.filter((/** @type {string} */ key) => !(key in bundle.results));
    const results = control.resultKeys.map((/** @type {string} */ key) => ({ key, value: bundle.results[key] }));
    const coverage = missingEvidence.length === 0 && missingResults.length === 0 ? "PRESENT" : "MISSING";
    return { id: control.id, coverage, evidence: selectedEvidence, missingEvidence, results, missingResults };
  });
  const present = controls.filter((/** @type {any} */ control) => control.coverage === "PRESENT").length;
  const missing = controls.length - present;
  return {
    version: 1,
    format: "generic-control-evidence-v1",
    mapping: { name: mapping.name },
    release: { sourceCommit: bundle.source.commit, createdAt: bundle.createdAt, bundleStatus: bundle.bundleStatus },
    complianceClaim: false,
    attestation: false,
    controls,
    summary: { controls: controls.length, evidencePresent: present, evidenceMissing: missing },
    evidenceCoverageStatus: bundle.bundleStatus === "VALID" && missing === 0 ? "COMPLETE" : "INCOMPLETE",
    semantics: "evidence coverage export only; PRESENT does not mean compliant and this export is not an attestation, certification, or standards assessment",
  };
}

/** @param {unknown} value */
function csvCell(value) {
  const string = String(value ?? "");
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

/** @param {ReturnType<typeof buildComplianceEvidenceExport>} report */
export function formatComplianceEvidenceCsv(report) {
  const rows = [["mapping", "control_id", "coverage", "evidence_ids", "missing_evidence", "results", "source_bundle_status", "compliance_claim", "attestation"]];
  for (const control of report.controls) {
    rows.push([
      report.mapping.name,
      control.id,
      control.coverage,
      control.evidence.map((/** @type {any} */ item) => item.id).join(";"),
      control.missingEvidence.join(";"),
      control.results.map((/** @type {any} */ item) => `${item.key}=${String(item.value)}`).join(";"),
      report.release.bundleStatus,
      String(report.complianceClaim),
      String(report.attestation),
    ]);
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) {
  let bundleFile = null, mappingFile = null, format = null;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!["--bundle", "--mapping", "--format"].includes(argument ?? "")) return null;
    const value = argv[index + 1]; if (typeof value !== "string" || value.startsWith("--")) return null; index += 1;
    if (argument === "--bundle") { if (bundleFile) return null; bundleFile = value; }
    else if (argument === "--mapping") { if (mappingFile) return null; mappingFile = value; }
    else { if (format) return null; format = value; }
  }
  return bundleFile && mappingFile && (format === "json" || format === "csv") ? { bundleFile, mappingFile, format } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/export-compliance-evidence.js --bundle <release-bundle.json> --mapping <control-mapping.json> --format <json|csv>"); return 1; }
  const rawBundle = readJson(options.bundleFile), rawMapping = readJson(options.mappingFile);
  if (!rawBundle || !rawMapping) { console.error("Compliance export input cannot be read or parsed"); return 1; }
  const bundle = validateReleaseEvidenceBundle(rawBundle), mapping = validateComplianceExportMapping(rawMapping);
  if (!bundle.valid || !bundle.bundle || !mapping.valid || !mapping.mapping) { console.error("Compliance export input is invalid"); return 1; }
  const report = buildComplianceEvidenceExport(bundle.bundle, mapping.mapping);
  console.log(options.format === "json" ? JSON.stringify(report) : formatComplianceEvidenceCsv(report));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
