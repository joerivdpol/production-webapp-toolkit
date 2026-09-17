#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateAgentSafetyPolicy, inspectAgentSafety } from "./audit-agent-safety.js";
import { isSafeAutofixEligible } from "./apply-remediation.js";
import { planRemediation } from "./plan-remediation.js";

const EFFECTS = new Set(["HUMAN_REQUIRED", "BLOCKED"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value @param {number} [max] */
function text(value, max = 256) { if (typeof value !== "string") return null; const v = value.trim(); return v.length > 0 && v.length <= max && !/[\u0000\r\n]/.test(v) ? v : null; }
/** @param {unknown} value */
function portableId(value) { const v = text(value, 128); return v && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v) ? v : null; }
/** @param {unknown} value */
function safeGlob(value) { const v = text(value, 256); return v && !v.startsWith("/") && !v.includes("\\") && !v.split("/").includes("..") ? v : null; }
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value @param {(value:unknown)=>string|null} validator @param {boolean} allowEmpty */
function list(value, validator, allowEmpty) { if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 256) return null; const values = value.map(validator); if (values.some((item) => item === null)) return null; const items = /** @type {string[]} */ (values); return new Set(items).size === items.length ? items.sort() : null; }

/** @param {unknown} value */
export function validateControlledAgentWorkflowPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "controlled agent workflow policy must be an object" }] };
  unknown(value, ["version", "repository", "allowAutofixIds", "boundaries"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const repository = portableId(value.repository);
  if (!repository) errors.push({ id: "repository-invalid", detail: "repository must be a portable identifier" });
  const allowAutofixIds = list(value.allowAutofixIds, portableId, true);
  if (!allowAutofixIds) errors.push({ id: "allow-autofix-invalid", detail: "allowAutofixIds must be a bounded unique array of portable ids" });

  /** @type {Array<{id:string,kind:string,effect:"HUMAN_REQUIRED"|"BLOCKED",paths:string[]}>} */ const boundaries = [];
  const ids = new Set();
  if (!Array.isArray(value.boundaries) || value.boundaries.length === 0 || value.boundaries.length > 128) errors.push({ id: "boundaries-invalid", detail: "boundaries must be a non-empty bounded array" });
  else for (const [index, raw] of value.boundaries.entries()) {
    if (!object(raw)) { errors.push({ id: "boundary-invalid", detail: `boundaries[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "kind", "effect", "paths"], "boundary", errors);
    const id = portableId(raw.id), kind = portableId(raw.kind), effect = text(raw.effect, 32), paths = list(raw.paths, safeGlob, false);
    if (!id || ids.has(id) || !kind || !effect || !EFFECTS.has(effect) || !paths) { errors.push({ id: "boundary-fields-invalid", detail: `boundaries[${index}] has invalid or duplicate fields` }); continue; }
    ids.add(id); boundaries.push({ id, kind, effect: /** @type {"HUMAN_REQUIRED"|"BLOCKED"} */ (effect), paths });
  }
  if (errors.length > 0 || !repository || !allowAutofixIds) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, repository, allowAutofixIds, boundaries: boundaries.sort((a, b) => a.id.localeCompare(b.id)) }, errors: [] };
}

/** @param {string} pattern */
function glob(pattern) { let out = "^"; for (let i = 0; i < pattern.length; i += 1) { const c = pattern[i]; if (c === undefined) break; if (c === "*" && pattern[i + 1] === "*") { out += ".*"; i += 1; } else if (c === "*") out += "[^/]*"; else if (c === "?") out += "[^/]"; else out += /[\\^$.*+?()[\]{}|]/.test(c) ? `\\${c}` : c; } return new RegExp(`${out}$`); }
/** @param {string} file @param {string[]} patterns */
function matches(file, patterns) { return patterns.some((pattern) => glob(pattern).test(file)); }
/** @param {string} value */
function hasGlob(value) { return ["*", "?", "[", "]", "{", "}"].some((marker) => value.includes(marker)); }

/** @param {string} root @param {any} agentPolicy @param {any} workflowPolicy */
export function planControlledAgentWorkflow(root, agentPolicy, workflowPolicy) {
  const repositoryRoot = path.resolve(root);
  if (agentPolicy.repository !== workflowPolicy.repository) throw new Error("agent safety and workflow policy repository identities differ");
  const safety = inspectAgentSafety(repositoryRoot, agentPolicy);
  const remediation = planRemediation(repositoryRoot);
  /** @type {Array<{id:string,disposition:"AUTO_FIX_ELIGIBLE"|"PROPOSE_ONLY"|"HUMAN_REQUIRED"|"BLOCKED",risk:string,ownership:string,files:string[],boundaryHits:Array<{id:string,kind:string,effect:string}>,reason:string}>} */ const actions = [];

  const implicit = [
    ...agentPolicy.canonicalSources.map((/** @type {any} */ source) => ({ id: `canonical:${source.id}`, kind: "canonical-source", effect: "HUMAN_REQUIRED", paths: [source.path] })),
    ...Object.entries(agentPolicy.boundaries).map(([id, config]) => ({ id: `agent-boundary:${id}`, kind: id, effect: "HUMAN_REQUIRED", paths: [config.policyPath] })),
  ];
  const allBoundaries = [...workflowPolicy.boundaries, ...implicit];

  for (const item of remediation.items) {
    /** @type {Array<{id:string,kind:string,effect:string}>} */ const boundaryHits = [];
    let ambiguousTargets = item.files.length === 0;
    for (const file of item.files) {
      if (hasGlob(file)) { ambiguousTargets = true; continue; }
      for (const boundary of allBoundaries) if (matches(file, boundary.paths)) boundaryHits.push({ id: boundary.id, kind: boundary.kind, effect: boundary.effect });
    }
    const uniqueHits = [...new Map(boundaryHits.map((hit) => [hit.id, hit])).values()].sort((a, b) => a.id.localeCompare(b.id));
    let disposition = "PROPOSE_ONLY";
    let reason = "manual remediation may be proposed but is not authorized for automatic execution";
    if (safety.overallStatus !== "PASS") {
      disposition = "BLOCKED"; reason = "agent safety profile is incomplete; controlled workflow is blocked";
    } else if (uniqueHits.some((hit) => hit.effect === "BLOCKED")) {
      disposition = "BLOCKED"; reason = "remediation target crosses an explicitly blocked private boundary";
    } else if (uniqueHits.length > 0 || ambiguousTargets || item.risk === "HIGH") {
      disposition = "HUMAN_REQUIRED"; reason = uniqueHits.length > 0 ? "remediation target crosses a protected boundary and requires human review" : ambiguousTargets ? "remediation target scope is not concrete enough for controlled automation" : "high-risk remediation requires human review";
    } else if (isSafeAutofixEligible(item) && workflowPolicy.allowAutofixIds.includes(item.id)) {
      disposition = "AUTO_FIX_ELIGIBLE"; reason = "existing Safe Autofix v1 may execute this explicit low-risk toolkit-owned action separately";
    }
    actions.push({ id: item.id, disposition: /** @type {any} */ (disposition), risk: item.risk, ownership: item.ownership, files: [...item.files], boundaryHits: uniqueHits, reason });
  }

  const counts = { autoFixEligible: actions.filter((item) => item.disposition === "AUTO_FIX_ELIGIBLE").length, proposeOnly: actions.filter((item) => item.disposition === "PROPOSE_ONLY").length, humanRequired: actions.filter((item) => item.disposition === "HUMAN_REQUIRED").length, blocked: actions.filter((item) => item.disposition === "BLOCKED").length };
  return {
    version: 1,
    repository: workflowPolicy.repository,
    executionAuthorized: false,
    agentSafety: { overallStatus: safety.overallStatus, technicalStatus: safety.technicalStatus, failedChecks: safety.summary.fail },
    actions: actions.sort((a, b) => a.id.localeCompare(b.id)),
    summary: counts,
    overallStatus: safety.overallStatus !== "PASS" || counts.blocked > 0 ? "FAIL" : counts.humanRequired > 0 ? "WARN" : "PASS",
    semantics: "proposal planning only; this workflow never writes files, runs autofixes, changes business truth, or mutates production systems",
  };
}

/** @param {ReturnType<typeof planControlledAgentWorkflow>} report */
export function formatControlledAgentWorkflow(report) { const lines = ["Controlled agent workflow plan", "", `Repository: ${report.repository}`, `Execution authorized: ${report.executionAuthorized}`, `Agent safety: ${report.agentSafety.overallStatus}`, `Semantics: ${report.semantics}`, ""]; for (const action of report.actions) lines.push(`${action.disposition.padEnd(17)}  ${action.risk.padEnd(6)}  ${action.id}  ${action.files.join(", ") || "(no concrete targets)"}  ${action.reason}`); lines.push("", `Actions: ${report.summary.autoFixEligible} autofix-eligible, ${report.summary.proposeOnly} propose-only, ${report.summary.humanRequired} human-required, ${report.summary.blocked} blocked`, `Overall: ${report.overallStatus}`); return lines.join("\n"); }
/** @param {string} file */ function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */ function parse(argv) { let root = null, agentFile = null, workflowFile = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--root", "--agent-safety-policy", "--workflow-policy"].includes(arg ?? "")) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; i += 1; if (arg === "--root") { if (root) return null; root = next; } else if (arg === "--agent-safety-policy") { if (agentFile) return null; agentFile = next; } else { if (workflowFile) return null; workflowFile = next; } } return root && agentFile && workflowFile ? { root, agentFile, workflowFile, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/controlled-agent-workflow.js --root <repository> --agent-safety-policy <agent-policy.json> --workflow-policy <workflow-policy.json> [--json]"); return 1; } const rawAgent = readJson(options.agentFile), rawWorkflow = readJson(options.workflowFile); if (!rawAgent || !rawWorkflow) { console.error("Controlled agent workflow input cannot be read or parsed"); return 1; } const agent = validateAgentSafetyPolicy(rawAgent), workflow = validateControlledAgentWorkflowPolicy(rawWorkflow); if (!agent.valid || !agent.policy || !workflow.valid || !workflow.policy) { console.error("Controlled agent workflow policy input is invalid"); return 1; } try { const report = planControlledAgentWorkflow(options.root, agent.policy, workflow.policy); console.log(options.json ? JSON.stringify(report) : formatControlledAgentWorkflow(report)); return report.overallStatus === "FAIL" ? 1 : 0; } catch (error) { console.error(error instanceof Error ? error.message : "Controlled agent workflow planning failed"); return 1; } }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
