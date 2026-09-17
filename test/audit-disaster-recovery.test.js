import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatDisasterRecovery, inspectDisasterRecovery, main } from "../scripts/audit-disaster-recovery.js";
import { DR_AREAS, validateDisasterRecoveryContract } from "../scripts/disaster-recovery-contract.js";

const EVALUATED = "2026-09-17T00:00:00Z";
/** @returns {any} */
function rawContract() {
  /** @type {Record<string, {owner:string,runbookPath:string}>} */
  const areas = {};
  for (const area of DR_AREAS) areas[area] = { owner: `owner-${area}`, runbookPath: `docs/dr/${area}.md` };
  return { version: 1, plans: [{ id: "production", reviewedAt: "2026-09-16T00:00:00Z", maxReviewAgeMinutes: 43200, areas }] };
}
function contract(raw = rawContract()) { const result = validateDisasterRecoveryContract(raw); assert.equal(result.valid, true, JSON.stringify(result.errors)); if (!result.valid || !result.contract) throw new Error("contract invalid"); return result.contract; }
function repository() { const root = fs.mkdtempSync(path.join(os.tmpdir(), "dr-readiness-")); fs.mkdirSync(path.join(root, "docs/dr"), { recursive: true }); for (const area of DR_AREAS) fs.writeFileSync(path.join(root, `docs/dr/${area}.md`), `${area} recovery procedure\n`); return root; }
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) { const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }
test("fresh complete DR contract passes all seven runbook bindings", () => {
  const root = repository(), report = inspectDisasterRecovery(root, contract(), EVALUATED);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks.filter((item) => item.id === "dr-runbook-present").length, 7);
  assert.equal(report.checks.some((item) => item.id === "dr-area-coverage-complete"), true);
  assert.match(report.semantics, /not independently proven/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("stale and future plan reviews fail deterministically", () => {
  const stale = rawContract(); stale.plans[0].maxReviewAgeMinutes = 60;
  let root = repository(), report = inspectDisasterRecovery(root, contract(stale), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "dr-review-stale"), true);
  fs.rmSync(root, { recursive: true, force: true });
  const future = rawContract(); future.plans[0].reviewedAt = "2026-09-18T00:00:00Z";
  root = repository(); report = inspectDisasterRecovery(root, contract(future), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "dr-review-time-future"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing empty or symlinked runbook fails only its explicit area", () => {
  let root = repository(); fs.rmSync(path.join(root, "docs/dr/dns.md"));
  let report = inspectDisasterRecovery(root, contract(), EVALUATED);
  assert.equal(report.checks.some((item) => item.id === "dr-runbook-missing" && item.area === "dns"), true);
  assert.equal(report.checks.some((item) => item.id === "dr-runbook-present" && item.area === "source"), true);
  fs.rmSync(root, { recursive: true, force: true });
  root = repository(); fs.rmSync(path.join(root, "docs/dr/secrets.md")); fs.symlinkSync("/etc/passwd", path.join(root, "docs/dr/secrets.md"));
  report = inspectDisasterRecovery(root, contract(), EVALUATED);
  assert.equal(report.checks.some((item) => item.area === "secrets" && item.id === "dr-runbook-missing"), true);
  fs.rmSync(root, { recursive: true, force: true });
});
test("shared runbook file may explicitly cover multiple areas", () => {
  const raw = rawContract(); for (const area of DR_AREAS) raw.plans[0].areas[area].runbookPath = "docs/dr/shared.md";
  const root = repository(); fs.writeFileSync(path.join(root, "docs/dr/shared.md"), "shared recovery plan\n");
  const report = inspectDisasterRecovery(root, contract(raw), EVALUATED);
  assert.equal(report.overallStatus, "PASS");
  fs.rmSync(root, { recursive: true, force: true });
});

test("human output exposes ownership binding but never runbook contents", () => {
  const marker = "UNIQUE_DR_CONTENT_337";
  const root = repository(); fs.writeFileSync(path.join(root, "docs/dr/source.md"), marker);
  const output = formatDisasterRecovery(inspectDisasterRecovery(root, contract(), EVALUATED));
  assert.match(output, /owner-source/);
  assert.doesNotMatch(output, new RegExp(marker));
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI composes contract repository and explicit evaluation time", () => {
  const root = repository(), contractFile = tempJson("dr-contract", rawContract());
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--contract", contractFile, "--evaluated-at", EVALUATED, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  assert.equal(main(["--root", root, "--contract", contractFile, "--evaluated-at", "today"]), 1);
  fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(contractFile, { force: true });
});
test("CLI rejects malformed contract missing repository and unknown options", () => {
  const malformed = tempJson("dr-bad", "{");
  assert.equal(main(["--root", "/tmp/missing-dr-repo", "--contract", malformed, "--evaluated-at", EVALUATED]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("DR audit is local read only and does not read runbook contents", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-disaster-recovery.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /lstatSync/);
  assert.match(source, /validateDisasterRecoveryContract/);
});
