#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import { validateRouteInventory } from "./route-inventory.js";

const KINDS = new Set(["admin-route", "server-endpoint"]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const normalized = value.trim(); return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value */
function safeSourcePath(value) { const v = text(value, 512); if (!v || path.isAbsolute(v) || v.includes("\\")) return null; const normalized = path.posix.normalize(v); const extension = path.posix.extname(normalized).toLowerCase(); return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && normalized === v && SOURCE_EXTENSIONS.has(extension) ? normalized : null; }
/** @param {unknown} value @param {number} [minimum] */
function sourcePaths(value, minimum = 1) { if (!Array.isArray(value) || value.length < minimum || value.length > 128) return null; const paths = value.map(safeSourcePath); if (paths.some((item) => !item) || new Set(paths).size !== paths.length) return null; return /** @type {string[]} */ (paths).sort(); }
/** @param {unknown} value @param {number} [minimum] */
function callees(value, minimum = 1) { if (!Array.isArray(value) || value.length < minimum || value.length > 64) return null; const items = value.map((item) => text(item, 128)); if (items.some((item) => !item || !/^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(/** @type {string} */ (item))) || new Set(items).size !== items.length) return null; return /** @type {string[]} */ (items).sort(); }

/** @param {unknown} value */
export function validateAuthorizationPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "authorization policy must be an object" }] };
  unknown(value, ["version", "surfaces"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (!Array.isArray(value.surfaces) || value.surfaces.length === 0 || value.surfaces.length > 512) {
    errors.push({ id: "surfaces-invalid", detail: "surfaces must be a non-empty bounded array" });
    return { valid: false, policy: null, errors };
  }
  /** @type {Array<any>} */ const surfaces = [];
  const ids = new Set();
  for (const [index, raw] of value.surfaces.entries()) {
    if (!object(raw)) { errors.push({ id: "surface-invalid", detail: `surfaces[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "kind", "routeId", "serverFiles", "guardFiles", "guardCallees", "clientFiles", "clientAuthCallees"], "surface", errors);
    const id = text(raw.id, 128), kind = text(raw.kind, 32);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || ids.has(id)) { errors.push({ id: "surface-id-invalid", detail: `surfaces[${index}].id is invalid or duplicate` }); continue; }
    ids.add(id);
    if (!kind || !KINDS.has(kind)) errors.push({ id: "surface-kind-invalid", detail: `surfaces[${index}].kind is unsupported` });
    const routeId = raw.routeId === undefined ? null : text(raw.routeId, 128);
    if ((kind === "admin-route" && (!routeId || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(routeId))) || (kind === "server-endpoint" && raw.routeId !== undefined && (!routeId || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(routeId)))) errors.push({ id: "surface-route-id-invalid", detail: `surfaces[${index}].routeId is invalid or missing` });
    const serverFiles = sourcePaths(raw.serverFiles), guardFiles = sourcePaths(raw.guardFiles), guardCallees = callees(raw.guardCallees);
    const clientFiles = raw.clientFiles === undefined ? [] : sourcePaths(raw.clientFiles, 0);
    const clientAuthCallees = raw.clientAuthCallees === undefined ? [] : callees(raw.clientAuthCallees, 0);
    if (!serverFiles || !guardFiles || !guardCallees) errors.push({ id: "surface-server-fields-invalid", detail: `surfaces[${index}] requires serverFiles, guardFiles, and guardCallees` });
    if (!clientFiles || !clientAuthCallees || ((clientFiles.length === 0) !== (clientAuthCallees.length === 0))) errors.push({ id: "surface-client-fields-invalid", detail: `surfaces[${index}] clientFiles and clientAuthCallees must both be empty or both configured` });
    if (kind && KINDS.has(kind) && serverFiles && guardFiles && guardCallees && clientFiles && clientAuthCallees && (kind !== "admin-route" || routeId)) surfaces.push({ id, kind, routeId, serverFiles, guardFiles, guardCallees, clientFiles, clientAuthCallees });
  }
  if (errors.length) return { valid: false, policy: null, errors };
  surfaces.sort((a, b) => a.id.localeCompare(b.id));
  return { valid: true, policy: { version: 1, surfaces }, errors: [] };
}

/** @param {string} filename */
function scriptKind(filename) { const extension = path.extname(filename).toLowerCase(); if (extension === ".tsx") return ts.ScriptKind.TSX; if (extension === ".jsx") return ts.ScriptKind.JSX; if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS; return ts.ScriptKind.TS; }
/** @param {any} expression @returns {string|null} */
function calleeName(expression) { if (ts.isIdentifier(expression)) return expression.text; if (ts.isPropertyAccessExpression(expression)) { const left = calleeName(expression.expression); return left ? `${left}.${expression.name.text}` : null; } if (ts.isParenthesizedExpression(expression)) return calleeName(expression.expression); return null; }
/** @param {string} root @param {string} relative */
function inspectFileCalls(root, relative) {
  const base = path.resolve(root), absolute = path.resolve(base, relative), rel = path.relative(base, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { ok: false, calls: new Set(), reason: "path-escape" };
  let stat; try { stat = fs.lstatSync(absolute); } catch { return { ok: false, calls: new Set(), reason: "missing" }; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return { ok: false, calls: new Set(), reason: "uninspectable" };
  const buffer = fs.readFileSync(absolute); if (buffer.includes(0)) return { ok: false, calls: new Set(), reason: "binary" };
  const source = ts.createSourceFile(relative, buffer.toString("utf8"), ts.ScriptTarget.Latest, true, scriptKind(relative));
  const diagnostics = /** @type {any} */ (source).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return { ok: false, calls: new Set(), reason: "parse-error" };
  const calls = new Set();
  /** @param {any} node */
  function visit(node) { if (ts.isCallExpression(node)) { const name = calleeName(node.expression); if (name) calls.add(name); } ts.forEachChild(node, visit); }
  visit(source);
  return { ok: true, calls, reason: null };
}

/** @param {string} root @param {any} policy @param {any} routeInventory */
export function inspectAuthorizationPolicy(root, policy, routeInventory) {
  /** @type {Array<any>} */ const checks = [];
  const routeMap = new Map(routeInventory.routes.map((/** @type {any} */ route) => [route.id, route]));
  /** @param {string} id @param {"PASS"|"WARN"|"FAIL"} status @param {string} surface @param {string} detail */
  const add = (id, status, surface, detail) => checks.push({ id, status, surface, detail });

  for (const surface of policy.surfaces) {
    if (surface.kind === "admin-route") {
      const route = routeMap.get(surface.routeId);
      if (!route) add("admin-route-inventory-missing", "FAIL", surface.id, "admin route is absent from Route Inventory v1");
      else if (route.auth.mode !== "policy") add("admin-route-not-policy-bound", "FAIL", surface.id, "admin route is not explicitly policy-bound in Route Inventory v1");
    }

    let serverInspectable = true;
    for (const file of surface.serverFiles) {
      const result = inspectFileCalls(root, file);
      if (!result.ok) { serverInspectable = false; add("server-file-uninspectable", "FAIL", surface.id, `${file} is missing, symlinked, oversized, binary, or syntactically invalid`); }
    }
    let guardFound = false, guardInspectable = true;
    for (const file of surface.guardFiles) {
      const result = inspectFileCalls(root, file);
      if (!result.ok) { guardInspectable = false; add("guard-file-uninspectable", "FAIL", surface.id, `${file} cannot be safely parsed for guard calls`); continue; }
      if (surface.guardCallees.some((/** @type {string} */ callee) => result.calls.has(callee))) guardFound = true;
    }
    if (guardInspectable && !guardFound) add("authorization-guard-missing", "FAIL", surface.id, "no configured server-side guard call is present in the explicit guard files");

    let clientAuthFound = false;
    for (const file of surface.clientFiles) {
      const result = inspectFileCalls(root, file);
      if (!result.ok) { add("client-file-uninspectable", "FAIL", surface.id, `${file} cannot be safely parsed for client authorization calls`); continue; }
      if (surface.clientAuthCallees.some((/** @type {string} */ callee) => result.calls.has(callee))) clientAuthFound = true;
    }
    if (clientAuthFound && guardInspectable && !guardFound) add("client-only-authorization", "FAIL", surface.id, "client authorization call exists but no configured server-side guard call was found");
    if (serverInspectable && guardInspectable && guardFound) add("authorization-guard-present", "PASS", surface.id, "configured server-side guard call is structurally present");
    if (clientAuthFound && guardFound) add("client-auth-defense-in-depth", "PASS", surface.id, "client authorization call is accompanied by configured server-side guard evidence");
  }
  const summary = { pass: checks.filter((item) => item.status === "PASS").length, warn: checks.filter((item) => item.status === "WARN").length, fail: checks.filter((item) => item.status === "FAIL").length };
  return { repository: routeInventory.repository, surfaces: policy.surfaces.length, checks: checks.sort((a, b) => `${a.surface}:${a.id}`.localeCompare(`${b.surface}:${b.id}`)), summary, technicalStatus: "PASS", overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS", semantics: "AST call-presence evidence only; control-flow dominance and authorization semantics are not proven" };
}

/** @param {ReturnType<typeof inspectAuthorizationPolicy>} report */
export function formatAuthorizationPolicy(report) { const lines = ["Authorization policy audit", "", `Repository: ${report.repository}`, `Surfaces: ${report.surfaces}`, `Semantics: ${report.semantics}`, ""]; for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.surface}  ${check.detail}`); lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`); return lines.join("\n"); }
/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) { let root = null, policyFile = null, inventoryFile = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--root", "--policy", "--route-inventory"].includes(arg ?? "")) return null; const value = argv[i + 1]; if (typeof value !== "string" || value.startsWith("--")) return null; i += 1; if (arg === "--root") { if (root) return null; root = value; } else if (arg === "--policy") { if (policyFile) return null; policyFile = value; } else { if (inventoryFile) return null; inventoryFile = value; } } return root && policyFile && inventoryFile ? { root, policyFile, inventoryFile, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/audit-authorization-policy.js --root <repository> --policy <authorization-policy.json> --route-inventory <routes.json> [--json]"); return 1; } const rawPolicy = readJson(options.policyFile), rawInventory = readJson(options.inventoryFile); if (!rawPolicy || !rawInventory) { console.error("Authorization policy or route inventory cannot be read or parsed"); return 1; } const policyResult = validateAuthorizationPolicy(rawPolicy), inventoryResult = validateRouteInventory(rawInventory); if (!policyResult.valid || !policyResult.policy || !inventoryResult.valid || !inventoryResult.inventory) { console.error("Authorization policy or route inventory is invalid"); return 1; } const root = path.resolve(options.root); let stat; try { stat = fs.lstatSync(root); } catch { console.error("Authorization repository is unavailable"); return 1; } if (!stat.isDirectory() || stat.isSymbolicLink()) { console.error("Authorization repository must be a regular directory"); return 1; } const report = inspectAuthorizationPolicy(root, policyResult.policy, inventoryResult.inventory); console.log(options.json ? JSON.stringify(report) : formatAuthorizationPolicy(report)); return report.overallStatus === "FAIL" ? 1 : 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
