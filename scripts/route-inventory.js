#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const AUTH_MODES = new Set(["public", "policy"]);
const METHOD_PATTERN = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const normalized = value.trim(); return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value */
function safePath(value) { const v = text(value, 512); if (!v || path.isAbsolute(v) || v.includes("\\")) return null; const normalized = path.posix.normalize(v); return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && normalized === v ? v : null; }
/** @param {unknown} value */
function routePath(value) { const v = text(value, 512); return v && v.startsWith("/") && !v.includes("?") && !v.includes("#") && !/\s/.test(v) ? v : null; }
/** @param {unknown} value @param {number} max @param {(value:string)=>boolean} validate */
function uniqueStrings(value, max, validate) { if (!Array.isArray(value) || value.length > max) return null; const result = value.map((item) => text(item, 512)); if (result.some((item) => !item || !validate(/** @type {string} */ (item))) || new Set(result).size !== result.length) return null; return /** @type {string[]} */ (result).sort(); }

/** @param {unknown} value */
export function validateRouteInventory(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, inventory: null, errors: [{ id: "inventory-invalid", detail: "route inventory must be an object" }] };
  unknown(value, ["version", "repository", "routes"], "inventory", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const repository = text(value.repository, 128);
  if (!repository || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(repository)) errors.push({ id: "repository-invalid", detail: "repository must be a portable identifier" });
  if (!Array.isArray(value.routes) || value.routes.length === 0 || value.routes.length > 512) {
    errors.push({ id: "routes-invalid", detail: "routes must be a non-empty bounded array" });
    return { valid: false, inventory: null, errors };
  }

  /** @type {Array<any>} */ const routes = [];
  const ids = new Set(), operations = new Set();
  for (const [index, raw] of value.routes.entries()) {
    if (!object(raw)) { errors.push({ id: "route-invalid", detail: `routes[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "path", "methods", "auth", "testFiles", "smokeProbes"], "route", errors);
    const id = text(raw.id, 128), declaredPath = routePath(raw.path);
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) || ids.has(id)) { errors.push({ id: "route-id-invalid", detail: `routes[${index}].id is invalid or duplicate` }); continue; }
    ids.add(id);
    if (!declaredPath) errors.push({ id: "route-path-invalid", detail: `routes[${index}].path is invalid` });
    const methods = uniqueStrings(raw.methods, 16, (item) => METHOD_PATTERN.test(item.toUpperCase()))?.map((item) => item.toUpperCase()) ?? null;
    if (!methods || methods.length === 0 || new Set(methods).size !== methods.length) errors.push({ id: "route-methods-invalid", detail: `routes[${index}].methods must contain unique HTTP method tokens` });

    let auth = null;
    if (!object(raw.auth)) errors.push({ id: "route-auth-invalid", detail: `routes[${index}].auth must explicitly classify the route` });
    else {
      unknown(raw.auth, ["mode", "policy"], "route-auth", errors);
      const mode = text(raw.auth.mode, 32);
      const policy = raw.auth.policy === undefined ? null : text(raw.auth.policy, 128);
      if (!mode || !AUTH_MODES.has(mode) || (mode === "public" && raw.auth.policy !== undefined) || (mode === "policy" && (!policy || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(policy)))) errors.push({ id: "route-auth-fields-invalid", detail: `routes[${index}].auth must be public or bind an explicit policy id` });
      else auth = mode === "public" ? { mode } : { mode, policy };
    }

    const testFiles = uniqueStrings(raw.testFiles, 64, (item) => safePath(item) !== null);
    if (!testFiles) errors.push({ id: "route-test-files-invalid", detail: `routes[${index}].testFiles must be unique safe repository-relative paths` });
    const smokeProbes = uniqueStrings(raw.smokeProbes, 64, (item) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(item));
    if (!smokeProbes) errors.push({ id: "route-smoke-probes-invalid", detail: `routes[${index}].smokeProbes must contain unique portable probe ids` });

    if (declaredPath && methods) for (const method of methods) {
      const operation = `${method} ${declaredPath}`;
      if (operations.has(operation)) errors.push({ id: "route-operation-duplicate", detail: `route inventory declares duplicate operation ${operation}` });
      operations.add(operation);
    }
    if (declaredPath && methods && auth && testFiles && smokeProbes) routes.push({ id, path: declaredPath, methods, auth, testFiles: testFiles.map((item) => /** @type {string} */ (safePath(item))), smokeProbes });
  }
  if (errors.length || !repository) return { valid: false, inventory: null, errors };
  routes.sort((a, b) => a.id.localeCompare(b.id));
  return { valid: true, inventory: { version: 1, repository, routes }, errors: [] };
}

/** @param {any} inventory */
function operationCount(inventory) {
  let count = 0;
  for (const route of inventory.routes) count += route.methods.length;
  return count;
}
/** @param {any} inventory */
export function formatRouteInventory(inventory) { return ["Route Inventory v1", "", `Repository: ${inventory.repository}`, `Routes: ${inventory.routes.length}`, `Operations: ${operationCount(inventory)}`, "Auth: explicit classification only; implementation correctness is not asserted", "Result: VALID"].join("\n"); }
/** @param {string[]} argv */
function parse(argv) { let file = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (arg !== "--file" || file !== null) return null; const value = argv[i + 1]; if (typeof value !== "string" || value.startsWith("--")) return null; file = value; i += 1; } return file ? { file, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/route-inventory.js --file <route-inventory.json> [--json]"); return 1; } let raw; try { raw = JSON.parse(fs.readFileSync(options.file, "utf8")); } catch { console.error("Route inventory file cannot be read or parsed"); return 1; } const result = validateRouteInventory(raw); if (!result.valid || !result.inventory) { console.error("Route inventory is invalid"); return 1; } console.log(options.json ? JSON.stringify(result.inventory) : formatRouteInventory(result.inventory)); return 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
