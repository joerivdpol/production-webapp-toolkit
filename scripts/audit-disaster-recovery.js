#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { DR_AREAS, validateDisasterRecoveryContract } from "./disaster-recovery-contract.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

/** @param {string} root @param {string} relative */
function runbookFile(root, relative) {
  const base = path.resolve(root), absolute = path.resolve(base, relative), rel = path.relative(base, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return false;
  try { const stat = fs.lstatSync(absolute); return stat.isFile() && !stat.isSymbolicLink() && stat.size > 0; } catch { return false; }
}
/** @param {string} older @param {string} newer */
function ageMinutes(older, newer) { return (Date.parse(newer) - Date.parse(older)) / 60_000; }

/** @param {string} root @param {any} contract @param {string} evaluatedAt */
export function inspectDisasterRecovery(root, contract, evaluatedAt) {
  /** @type {Array<any>} */ const checks = [];
  /** @param {string} id @param {"PASS"|"WARN"|"FAIL"} status @param {string} plan @param {string} area @param {string} detail */
  const add = (id, status, plan, area, detail) => checks.push({ id, status, plan, area, detail });
  for (const plan of contract.plans) {
    const age = ageMinutes(plan.reviewedAt, evaluatedAt);
    if (age < 0) add("dr-review-time-future", "FAIL", plan.id, "plan", "reviewedAt is after evaluation time");
    else if (age > plan.maxReviewAgeMinutes) add("dr-review-stale", "FAIL", plan.id, "plan", `review age ${age.toFixed(1)} minutes exceeds maximum ${plan.maxReviewAgeMinutes}`);
    else add("dr-review-fresh", "PASS", plan.id, "plan", `review age ${age.toFixed(1)} minutes is within maximum ${plan.maxReviewAgeMinutes}`);

    for (const area of DR_AREAS) {
      const cfg = plan.areas[area];
      if (runbookFile(root, cfg.runbookPath)) add("dr-runbook-present", "PASS", plan.id, area, `runbook file is present for owner ${cfg.owner}`);
      else add("dr-runbook-missing", "FAIL", plan.id, area, "runbook file is missing, empty, symlinked, or outside repository");
    }
    const areaFailures = checks.filter((item) => item.plan === plan.id && item.area !== "plan" && item.status === "FAIL").length;
    if (areaFailures === 0) add("dr-area-coverage-complete", "PASS", plan.id, "plan", `all ${DR_AREAS.length} required recovery areas have inspectable runbook bindings`);
  }
  const summary = { pass: checks.filter((item) => item.status === "PASS").length, warn: checks.filter((item) => item.status === "WARN").length, fail: checks.filter((item) => item.status === "FAIL").length };
  return { plans: contract.plans.length, requiredAreas: [...DR_AREAS], evaluatedAt, checks: checks.sort((a, b) => `${a.plan}:${a.area}:${a.id}`.localeCompare(`${b.plan}:${b.area}:${b.id}`)), summary, technicalStatus: "PASS", overallStatus: summary.fail > 0 ? "FAIL" : summary.warn > 0 ? "WARN" : "PASS", semantics: "machine-readable ownership and runbook-file presence only; infrastructure access, secret availability, DNS authority, deployment capability, rollback correctness, restore completeness, and operator competence are not independently proven" };
}

/** @param {ReturnType<typeof inspectDisasterRecovery>} report */
export function formatDisasterRecovery(report) { const lines = ["Disaster recovery readiness audit", "", `Plans: ${report.plans}`, `Required areas: ${report.requiredAreas.join(", ")}`, `Evaluated at: ${report.evaluatedAt}`, `Semantics: ${report.semantics}`, ""]; for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.plan}  ${check.area}  ${check.id}  ${check.detail}`); lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`); return lines.join("\n"); }
/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) { let root = null, contractFile = null, evaluatedAt = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--root", "--contract", "--evaluated-at"].includes(arg ?? "")) return null; const next = argv[i + 1]; if (typeof next !== "string" || next.startsWith("--")) return null; i += 1; if (arg === "--root") { if (root) return null; root = next; } else if (arg === "--contract") { if (contractFile) return null; contractFile = next; } else { if (evaluatedAt) return null; evaluatedAt = next; } } return root && contractFile && evaluatedAt ? { root, contractFile, evaluatedAt, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/audit-disaster-recovery.js --root <repository> --contract <dr-contract.json> --evaluated-at <absolute-ISO> [--json]"); return 1; } if (!isAbsoluteIsoTimestamp(options.evaluatedAt)) { console.error("evaluated-at must be an absolute ISO timestamp"); return 1; } const raw = readJson(options.contractFile); if (!raw) { console.error("Disaster recovery contract cannot be read or parsed"); return 1; } const validated = validateDisasterRecoveryContract(raw); if (!validated.valid || !validated.contract) { console.error("Disaster recovery contract is invalid"); return 1; } const root = path.resolve(options.root); let stat; try { stat = fs.lstatSync(root); } catch { console.error("Disaster recovery repository is unavailable"); return 1; } if (!stat.isDirectory() || stat.isSymbolicLink()) { console.error("Disaster recovery repository must be a regular directory"); return 1; } const report = inspectDisasterRecovery(root, validated.contract, options.evaluatedAt); console.log(options.json ? JSON.stringify(report) : formatDisasterRecovery(report)); return report.overallStatus === "FAIL" ? 1 : 0; }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
