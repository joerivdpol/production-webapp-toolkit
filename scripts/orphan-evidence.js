#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

export const ORPHAN_KINDS = ["export", "route", "feature-flag", "translation", "handler"];
const ANALYSIS_MODES = ["typescript-symbol", "catalog-call-string"];

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value */
function text(value) { return typeof value === "string" && value.trim().length > 0 ? value.trim() : null; }
/** @param {unknown} value */
function safePath(value) { const v = text(value); return v && v.length <= 512 && !v.startsWith("/") && !v.includes("\\") && !v.includes("\0") && !v.split("/").includes("..") ? v : null; }
/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }

/** @param {unknown} value */
export function validateOrphanEvidence(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, evidence: null, errors: [{ id: "evidence-invalid", detail: "orphan evidence must be an object" }] };
  unknown(value, ["version", "repository", "evidence", "items"], "evidence", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let repository = null;
  if (!object(value.repository)) errors.push({ id: "repository-invalid", detail: "repository must be an object" });
  else {
    unknown(value.repository, ["name"], "repository", errors);
    const name = text(value.repository.name);
    if (!name || name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) errors.push({ id: "repository-name-invalid", detail: "repository.name must be a portable identifier" });
    else repository = { name };
  }

  let evidenceMeta = null;
  if (!object(value.evidence)) errors.push({ id: "source-evidence-invalid", detail: "evidence metadata must be an object" });
  else {
    unknown(value.evidence, ["source", "authenticated", "collectedAt"], "source-evidence", errors);
    const source = text(value.evidence.source), collectedAt = text(value.evidence.collectedAt);
    if (!source || source.length > 256) errors.push({ id: "evidence-source-invalid", detail: "evidence.source must be non-empty and bounded" });
    if (typeof value.evidence.authenticated !== "boolean") errors.push({ id: "evidence-authenticated-invalid", detail: "evidence.authenticated must be boolean" });
    if (!collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) errors.push({ id: "evidence-collected-at-invalid", detail: "evidence.collectedAt must be an absolute ISO timestamp" });
    if (source && typeof value.evidence.authenticated === "boolean" && collectedAt && isAbsoluteIsoTimestamp(collectedAt)) evidenceMeta = { source, authenticated: value.evidence.authenticated, collectedAt };
  }

  /** @type {Array<any>} */ const items = [];
  const keys = new Set();
  if (!Array.isArray(value.items)) errors.push({ id: "items-invalid", detail: "items must be an array" });
  else for (const [index, raw] of value.items.entries()) {
    if (!object(raw)) { errors.push({ id: "item-invalid", detail: `items[${index}] must be an object` }); continue; }
    unknown(raw, ["scanner", "kind", "id", "analysis", "declaration", "references"], "item", errors);
    const scanner = text(raw.scanner), kind = text(raw.kind), id = text(raw.id), analysis = text(raw.analysis);
    if (!scanner || scanner.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(scanner)) errors.push({ id: "item-scanner-invalid", detail: `items[${index}].scanner is invalid` });
    if (!kind || !ORPHAN_KINDS.includes(kind)) errors.push({ id: "item-kind-invalid", detail: `items[${index}].kind is unsupported` });
    if (!id || id.length > 512 || /[\u0000-\u001f]/.test(id)) errors.push({ id: "item-id-invalid", detail: `items[${index}].id must be a bounded printable string` });
    if (!analysis || !ANALYSIS_MODES.includes(analysis)) errors.push({ id: "item-analysis-invalid", detail: `items[${index}].analysis is unsupported` });

    let declaration = null;
    if (!object(raw.declaration)) errors.push({ id: "declaration-invalid", detail: `items[${index}].declaration must be an object` });
    else {
      unknown(raw.declaration, ["path", "line"], "declaration", errors);
      const declarationPath = safePath(raw.declaration.path), line = raw.declaration.line;
      if (!declarationPath || !(line === null || (Number.isSafeInteger(line) && Number(line) >= 1))) errors.push({ id: "declaration-fields-invalid", detail: `items[${index}].declaration path or line is invalid` });
      else declaration = { path: declarationPath, line };
    }

    let references = null;
    if (!object(raw.references)) errors.push({ id: "references-invalid", detail: `items[${index}].references must be an object` });
    else {
      unknown(raw.references, ["total", "external", "files"], "references", errors);
      const total = raw.references.total, external = raw.references.external, files = raw.references.files;
      const validCounts = Number.isSafeInteger(total) && Number(total) >= 0 && Number.isSafeInteger(external) && Number(external) >= 0 && Number(external) <= Number(total);
      const normalizedFiles = Array.isArray(files) ? files.map(safePath) : null;
      const validFiles = normalizedFiles !== null && normalizedFiles.every(Boolean) && new Set(normalizedFiles).size === normalizedFiles.length && normalizedFiles.length <= Number(total);
      if (!validCounts || !validFiles) errors.push({ id: "reference-fields-invalid", detail: `items[${index}].references is inconsistent` });
      else references = { total: Number(total), external: Number(external), files: /** @type {string[]} */ (normalizedFiles).sort() };
    }

    if (!scanner || !kind || !id || !analysis || !declaration || !references) continue;
    const key = `${scanner}\u0000${kind}\u0000${id}\u0000${declaration.path}`;
    if (keys.has(key)) { errors.push({ id: "item-duplicate", detail: `items contains duplicate identity for scanner ${scanner}` }); continue; }
    keys.add(key); items.push({ scanner, kind, id, analysis, declaration, references });
  }

  if (errors.length || !repository || !evidenceMeta) return { valid: false, evidence: null, errors };
  items.sort((a, b) => `${a.scanner}\0${a.kind}\0${a.id}\0${a.declaration.path}`.localeCompare(`${b.scanner}\0${b.kind}\0${b.id}\0${b.declaration.path}`));
  return { valid: true, evidence: { version: 1, repository, evidence: evidenceMeta, items }, errors: [] };
}

/** @param {any} evidence */
export function formatOrphanEvidence(evidence) { return ["Orphan Evidence v1", "", `Repository: ${evidence.repository.name}`, `Items: ${evidence.items.length}`, `Source: ${evidence.evidence.source}`, `Authenticated: ${evidence.evidence.authenticated}`, `Collected at: ${evidence.evidence.collectedAt}`, "Result: VALID"].join("\n"); }
/** @param {string[]} argv */
function parse(argv) { let file = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (arg !== "--file" || file !== null) return null; const value = argv[i + 1]; if (typeof value !== "string" || value.startsWith("--")) return null; file = value; i += 1; } return file ? { file, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/orphan-evidence.js --file <orphan-evidence.json> [--json]"); return 1; } let raw; try { raw = JSON.parse(fs.readFileSync(options.file, "utf8")); } catch { console.error("Orphan evidence file cannot be read or parsed"); return 1; } const result = validateOrphanEvidence(raw); if (!result.valid || !result.evidence) { console.error("Orphan evidence is invalid"); return 1; } console.log(options.json ? JSON.stringify(result.evidence) : formatOrphanEvidence(result.evidence)); return 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
