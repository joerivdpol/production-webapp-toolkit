#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateRouteInventory } from "./route-inventory.js";
import { validateSyntheticSmokePolicy } from "./run-synthetic-smoke-tests.js";

const AUTH_MODES = new Set(["public", "policy"]);
const METHOD_PATTERN = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]*$/;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const normalized = value.trim(); return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value */
function expectedPath(value) { if (value === undefined) return null; const v = text(value, 512); return v && v.startsWith("/") && !v.includes("?") && !v.includes("#") && !/\s/.test(v) ? v : false; }
/** @param {unknown} value @param {number} max @param {(item:string)=>boolean} validator @param {number} [minimum] */
function stringList(value, max, validator, minimum = 0) { if (!Array.isArray(value) || value.length < minimum || value.length > max) return null; const list = value.map((item) => text(item, 128)); if (list.some((item) => !item || !validator(/** @type {string} */ (item))) || new Set(list).size !== list.length) return null; return /** @type {string[]} */ (list).sort(); }
/** @param {unknown} value */
function boundedCount(value) { return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 64 ? Number(value) : null; }

/** @param {unknown} value */
export function validateRouteCoveragePolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "route coverage policy must be an object" }] };
  unknown(value, ["version", "requireRulesForAllRoutes", "rules"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (typeof value.requireRulesForAllRoutes !== "boolean") errors.push({ id: "require-rules-invalid", detail: "requireRulesForAllRoutes must be boolean" });
  if (!Array.isArray(value.rules) || value.rules.length === 0 || value.rules.length > 512) {
    errors.push({ id: "rules-invalid", detail: "rules must be a non-empty bounded array" });
    return { valid: false, policy: null, errors };
  }
  /** @type {Array<any>} */ const rules = [];
  const routeIds = new Set();
  for (const [index, raw] of value.rules.entries()) {
    if (!object(raw)) { errors.push({ id: "rule-invalid", detail: `rules[${index}] must be an object` }); continue; }
    unknown(raw, ["routeId", "expectedPath", "requiredMethods", "allowedAuthModes", "allowedAuthPolicies", "minTestFiles", "minSmokeProbes"], "rule", errors);
    const routeId = text(raw.routeId, 128);
    if (!routeId || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(routeId) || routeIds.has(routeId)) { errors.push({ id: "route-id-invalid", detail: `rules[${index}].routeId is invalid or duplicate` }); continue; }
    routeIds.add(routeId);
    const routePath = expectedPath(raw.expectedPath);
    if (routePath === false) errors.push({ id: "expected-path-invalid", detail: `rules[${index}].expectedPath is invalid` });
    const requiredMethods = raw.requiredMethods === undefined ? [] : stringList(raw.requiredMethods, 16, (item) => METHOD_PATTERN.test(item.toUpperCase()));
    if (!requiredMethods) errors.push({ id: "required-methods-invalid", detail: `rules[${index}].requiredMethods must contain unique HTTP method tokens` });
    const normalizedMethods = requiredMethods?.map((item) => item.toUpperCase()) ?? [];
    if (new Set(normalizedMethods).size !== normalizedMethods.length) errors.push({ id: "required-methods-duplicate", detail: `rules[${index}].requiredMethods normalizes to duplicates` });
    const allowedAuthModes = stringList(raw.allowedAuthModes, 2, (item) => AUTH_MODES.has(item), 1);
    if (!allowedAuthModes) errors.push({ id: "auth-modes-invalid", detail: `rules[${index}].allowedAuthModes is invalid` });
    const allowedAuthPolicies = raw.allowedAuthPolicies === undefined ? [] : stringList(raw.allowedAuthPolicies, 64, (item) => /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(item));
    if (!allowedAuthPolicies || (allowedAuthPolicies.length > 0 && !allowedAuthModes?.includes("policy"))) errors.push({ id: "auth-policies-invalid", detail: `rules[${index}].allowedAuthPolicies requires policy auth mode and portable ids` });
    const minTestFiles = boundedCount(raw.minTestFiles), minSmokeProbes = boundedCount(raw.minSmokeProbes);
    if (minTestFiles === null || minSmokeProbes === null) errors.push({ id: "coverage-minimum-invalid", detail: `rules[${index}] coverage minimums must be integers from 0 to 64` });
    if (routePath !== false && requiredMethods && allowedAuthModes && allowedAuthPolicies && minTestFiles !== null && minSmokeProbes !== null) rules.push({ routeId, expectedPath: routePath, requiredMethods: normalizedMethods.sort(), allowedAuthModes, allowedAuthPolicies, minTestFiles, minSmokeProbes });
  }
  if (errors.length || typeof value.requireRulesForAllRoutes !== "boolean") return { valid: false, policy: null, errors };
  rules.sort((a, b) => a.routeId.localeCompare(b.routeId));
  return { valid: true, policy: { version: 1, requireRulesForAllRoutes: value.requireRulesForAllRoutes, rules }, errors: [] };
}

/** @param {string} root @param {string} relative */
function regularBoundFile(root, relative) {
  const base = path.resolve(root), absolute = path.resolve(base, relative), rel = path.relative(base, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  try { const stat = fs.lstatSync(absolute); return stat.isFile() && !stat.isSymbolicLink(); } catch { return false; }
}

/** @param {any} inventory @param {any} policy @param {{root:string,smokePolicy?:any|null}} options */
export function inspectRouteCoverage(inventory, policy, options) {
  /** @type {Array<any>} */ const checks = [];
  const byRoute = new Map(inventory.routes.map((/** @type {any} */ route) => [route.id, route]));
  const rulesByRoute = new Map(policy.rules.map((/** @type {any} */ rule) => [rule.routeId, rule]));
  const smokeIds = options.smokePolicy ? new Set(options.smokePolicy.probes.map((/** @type {any} */ probe) => probe.id)) : null;
  /** @param {string} id @param {"PASS"|"WARN"|"FAIL"} status @param {string} routeId @param {string} detail */
  const add = (id, status, routeId, detail) => checks.push({ id, status, routeId, detail });

  if (policy.requireRulesForAllRoutes) for (const route of inventory.routes) if (!rulesByRoute.has(route.id)) add("route-policy-missing", "FAIL", route.id, "inventory route has no explicit coverage rule");

  for (const rule of policy.rules) {
    const route = byRoute.get(rule.routeId);
    if (!route) { add("route-missing", "FAIL", rule.routeId, "required route id is absent from inventory"); continue; }
    if (rule.expectedPath !== null && route.path !== rule.expectedPath) add("route-path-mismatch", "FAIL", route.id, "inventory path differs from explicit policy path");
    const missingMethods = rule.requiredMethods.filter((/** @type {string} */ method) => !route.methods.includes(method));
    if (missingMethods.length > 0) add("route-method-missing", "FAIL", route.id, `${missingMethods.length} required method(s) are absent from inventory`);
    if (!rule.allowedAuthModes.includes(route.auth.mode)) add("route-auth-mode-disallowed", "FAIL", route.id, `auth mode ${route.auth.mode} is not allowed by policy`);
    else if (route.auth.mode === "policy" && rule.allowedAuthPolicies.length > 0 && !rule.allowedAuthPolicies.includes(route.auth.policy)) add("route-auth-policy-disallowed", "FAIL", route.id, "declared auth policy id is not allowed by route coverage policy");

    const missingTestFiles = route.testFiles.filter((/** @type {string} */ file) => !regularBoundFile(options.root, file));
    if (missingTestFiles.length > 0) add("route-test-file-missing", "FAIL", route.id, `${missingTestFiles.length} declared test file(s) are missing, non-regular, or symlinked`);
    const existingTests = route.testFiles.length - missingTestFiles.length;
    if (existingTests < rule.minTestFiles) add("route-test-coverage-insufficient", "FAIL", route.id, `${existingTests}/${rule.minTestFiles} required bound test file(s) are inspectable`);

    if (rule.minSmokeProbes > 0 && smokeIds === null) add("smoke-policy-required", "FAIL", route.id, "smoke coverage is required but no validated synthetic smoke policy was supplied");
    const unresolvedSmoke = smokeIds === null ? [] : route.smokeProbes.filter((/** @type {string} */ id) => !smokeIds.has(id));
    if (unresolvedSmoke.length > 0) add("route-smoke-probe-missing", "FAIL", route.id, `${unresolvedSmoke.length} bound smoke probe id(s) are absent from the synthetic smoke policy`);
    const resolvedSmoke = smokeIds === null ? 0 : route.smokeProbes.length - unresolvedSmoke.length;
    if (smokeIds !== null && resolvedSmoke < rule.minSmokeProbes) add("route-smoke-coverage-insufficient", "FAIL", route.id, `${resolvedSmoke}/${rule.minSmokeProbes} required smoke probe binding(s) are resolved`);

    const routeFailures = checks.filter((check) => check.routeId === route.id && check.status === "FAIL").length;
    if (routeFailures === 0) add("route-coverage-satisfied", "PASS", route.id, "route identity, auth classification, test bindings, and smoke bindings satisfy explicit policy");
  }

  const summary = { pass: checks.filter((item) => item.status === "PASS").length, warn: checks.filter((item) => item.status === "WARN").length, fail: checks.filter((item) => item.status === "FAIL").length };
  return { repository: inventory.repository, routes: inventory.routes.length, rules: policy.rules.length, smokePolicyConfigured: smokeIds !== null, checks: checks.sort((a, b) => `${a.routeId}:${a.id}`.localeCompare(`${b.routeId}:${b.id}`)), summary, technicalStatus: "PASS", overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS", semantics: { auth: "declaration binding only; authorization implementation correctness is audited separately", tests: "repository file binding only; test execution truth comes from CI evidence", smoke: "probe-id binding to validated synthetic smoke policy only" } };
}

/** @param {ReturnType<typeof inspectRouteCoverage>} report */
export function formatRouteCoverage(report) { const lines = ["Route coverage audit", "", `Repository: ${report.repository}`, `Routes: ${report.routes}`, `Rules: ${report.rules}`, `Smoke policy: ${report.smokePolicyConfigured ? "CONFIGURED" : "NOT_CONFIGURED"}`, "Auth semantics: declaration binding only", "Test semantics: bound-file presence only", "Smoke semantics: validated probe-id binding only", ""]; for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.routeId}  ${check.detail}`); lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`); return lines.join("\n"); }
/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) { let root = null, inventoryFile = null, policyFile = null, smokeFile = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--root", "--inventory", "--policy", "--smoke-policy"].includes(arg ?? "")) return null; const value = argv[i + 1]; if (typeof value !== "string" || value.startsWith("--")) return null; i += 1; if (arg === "--root") { if (root) return null; root = value; } else if (arg === "--inventory") { if (inventoryFile) return null; inventoryFile = value; } else if (arg === "--policy") { if (policyFile) return null; policyFile = value; } else { if (smokeFile) return null; smokeFile = value; } } return root && inventoryFile && policyFile ? { root, inventoryFile, policyFile, smokeFile, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/audit-route-coverage.js --root <repository> --inventory <routes.json> --policy <coverage-policy.json> [--smoke-policy <smoke-policy.json>] [--json]"); return 1; } const rawInventory = readJson(options.inventoryFile), rawPolicy = readJson(options.policyFile); if (!rawInventory || !rawPolicy) { console.error("Route inventory or coverage policy cannot be read or parsed"); return 1; } const inventoryResult = validateRouteInventory(rawInventory), policyResult = validateRouteCoveragePolicy(rawPolicy); if (!inventoryResult.valid || !inventoryResult.inventory || !policyResult.valid || !policyResult.policy) { console.error("Route inventory or coverage policy is invalid"); return 1; } let smokePolicy = null; if (options.smokeFile) { const rawSmoke = readJson(options.smokeFile); if (!rawSmoke) { console.error("Synthetic smoke policy cannot be read or parsed"); return 1; } const validated = validateSyntheticSmokePolicy(rawSmoke); if (!validated.ok || !validated.policy) { console.error("Synthetic smoke policy is invalid"); return 1; } smokePolicy = validated.policy; } const root = path.resolve(options.root); let stat; try { stat = fs.lstatSync(root); } catch { console.error("Route coverage repository is unavailable"); return 1; } if (!stat.isDirectory() || stat.isSymbolicLink()) { console.error("Route coverage repository must be a regular directory"); return 1; } const report = inspectRouteCoverage(inventoryResult.inventory, policyResult.policy, { root, smokePolicy }); console.log(options.json ? JSON.stringify(report) : formatRouteCoverage(report)); return report.overallStatus === "FAIL" ? 1 : 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
