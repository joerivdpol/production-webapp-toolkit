import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectOrphans, main, validateOrphanPolicy } from "../scripts/audit-orphans.js";
import { validateOrphanEvidence } from "../scripts/orphan-evidence.js";

/** @returns {any} */
function evidenceRaw() {
  /** @param {string} scanner @param {string} kind @param {string} id @param {number} total @param {number} external @param {string} declarationPath */
  const item = (scanner, kind, id, total, external, declarationPath) => ({ scanner, kind, id, analysis: kind === "export" || kind === "handler" ? "typescript-symbol" : "catalog-call-string", declaration: { path: declarationPath, line: 1 }, references: { total, external, files: total ? ["src/app.ts"] : [] } });
  return {
    version: 1, repository: { name: "example" }, evidence: { source: "synthetic", authenticated: false, collectedAt: "2026-09-16T17:20:00Z" },
    items: [
      item("exports", "export", "used", 2, 2, "src/lib.ts"), item("exports", "export", "dead", 0, 0, "src/lib.ts"),
      item("handlers", "handler", "usedHandler", 2, 2, "src/handlers.ts"), item("handlers", "handler", "oldHandler", 0, 0, "src/handlers.ts"),
      item("routes", "route", "/home", 1, 1, "catalogs/routes.json"), item("routes", "route", "/dead", 0, 0, "catalogs/routes.json"),
      item("flags", "feature-flag", "active", 1, 1, "catalogs/flags.json"), item("flags", "feature-flag", "beta", 0, 0, "catalogs/flags.json"),
      item("translations", "translation", "home.title", 1, 1, "catalogs/en.json"), item("translations", "translation", "home.unused", 0, 0, "catalogs/en.json"),
    ],
  };
}
/** @returns {any} */
function policyRaw() {
  return {
    version: 1, repository: "example",
    rules: [
      { scanner: "exports", kind: "export", metric: "external", minimumReferences: 1, orphanStatus: "FAIL", requireItems: true },
      { scanner: "handlers", kind: "handler", metric: "total", minimumReferences: 1, orphanStatus: "FAIL", requireItems: true },
      { scanner: "routes", kind: "route", metric: "total", minimumReferences: 1, orphanStatus: "FAIL", requireItems: true },
      { scanner: "flags", kind: "feature-flag", metric: "total", minimumReferences: 1, orphanStatus: "WARN", requireItems: true },
      { scanner: "translations", kind: "translation", metric: "total", minimumReferences: 1, orphanStatus: "WARN", requireItems: true },
    ], exceptions: [],
  };
}
function validatedEvidence() { const result = validateOrphanEvidence(evidenceRaw()); assert.equal(result.valid, true); if (!result.evidence) throw new Error("fixture invalid"); return result.evidence; }
function validatedPolicy(raw = policyRaw()) { const result = validateOrphanPolicy(raw); assert.equal(result.valid, true); if (!result.policy) throw new Error("fixture invalid"); return result.policy; }
/** @param {any} value */
function temp(value) { const file = path.join(os.tmpdir(), `orphan-audit-${process.pid}-${Math.random()}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; }

test("policy validates explicit per-scanner thresholds and severities", () => {
  const result = validateOrphanPolicy(policyRaw()); assert.equal(result.valid, true); assert.equal(result.policy?.rules.length, 5);
});

test("policy rejects duplicate rules, unsafe exceptions, and invalid thresholds", () => {
  const duplicate = policyRaw(); duplicate.rules.push(structuredClone(duplicate.rules[0])); assert.equal(validateOrphanPolicy(duplicate).valid, false);
  const unsafe = policyRaw(); unsafe.exceptions = [{ scanner: "exports", kind: "export", id: "x", declarationPath: "../x", reason: "legacy" }]; assert.equal(validateOrphanPolicy(unsafe).valid, false);
  const threshold = policyRaw(); threshold.rules[0].minimumReferences = 0; assert.equal(validateOrphanPolicy(threshold).valid, false);
});

test("blocking and advisory orphan severities remain distinct", () => {
  const report = inspectOrphans(validatedEvidence(), validatedPolicy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((/** @type {any} */ item) => item.id === "orphan-detected" && item.kind === "export" && item.status === "FAIL"), true);
  assert.equal(report.checks.some((/** @type {any} */ item) => item.id === "orphan-detected" && item.kind === "translation" && item.status === "WARN"), true);
});

test("explicit exception keeps orphan visible as WARN and never converts it to PASS", () => {
  const raw = policyRaw(); raw.exceptions = [{ scanner: "exports", kind: "export", id: "dead", declarationPath: "src/lib.ts", reason: "public compatibility export" }];
  const report = inspectOrphans(validatedEvidence(), validatedPolicy(raw));
  const check = report.checks.find((/** @type {any} */ item) => item.id === "orphan-exempted" && item.item?.id === "dead");
  assert.equal(check?.status, "WARN"); assert.match(check?.detail ?? "", /public compatibility export/);
});

test("stale exceptions and unconfigured scanners are visible warnings", () => {
  const raw = policyRaw(); raw.rules = raw.rules.filter((/** @type {any} */ item) => item.scanner !== "translations"); raw.exceptions = [{ scanner: "exports", kind: "export", id: "missing", declarationPath: "src/lib.ts", reason: "temporary" }];
  const report = inspectOrphans(validatedEvidence(), validatedPolicy(raw));
  assert.equal(report.checks.some((/** @type {any} */ item) => item.id === "scanner-unconfigured" && item.scanner === "translations"), true);
  assert.equal(report.checks.some((/** @type {any} */ item) => item.id === "exception-stale"), true);
});

test("required empty scanner fails while optional empty scanner warns", () => {
  const evidence = evidenceRaw(); evidence.items = evidence.items.filter((/** @type {any} */ item) => item.scanner !== "routes");
  const checked = validateOrphanEvidence(evidence); assert.equal(checked.valid, true); if (!checked.evidence) return;
  const required = inspectOrphans(checked.evidence, validatedPolicy()); assert.equal(required.checks.find((/** @type {any} */ item) => item.scanner === "routes")?.status, "FAIL");
  const raw = policyRaw(); raw.rules.find((/** @type {any} */ item) => item.scanner === "routes").requireItems = false;
  const optional = inspectOrphans(checked.evidence, validatedPolicy(raw)); assert.equal(optional.checks.find((/** @type {any} */ item) => item.scanner === "routes")?.status, "WARN");
});

test("repository identity mismatch is blocking without evaluating item truth", () => {
  const raw = policyRaw(); raw.repository = "other"; const report = inspectOrphans(validatedEvidence(), validatedPolicy(raw));
  assert.equal(report.overallStatus, "FAIL"); assert.deepEqual(report.checks.map((/** @type {any} */ item) => item.id), ["repository-mismatch"]);
});

test("CLI returns one for blocking orphan and zero for warning-only policy", () => {
  const evidenceFile = temp(evidenceRaw()), policyFile = temp(policyRaw()); assert.equal(main(["--evidence-file", evidenceFile, "--policy", policyFile]), 1);
  const warning = policyRaw(); warning.rules.forEach((/** @type {any} */ rule) => { rule.orphanStatus = "WARN"; }); fs.writeFileSync(policyFile, JSON.stringify(warning));
  assert.equal(main(["--evidence-file", evidenceFile, "--policy", policyFile, "--json"]), 0); fs.rmSync(evidenceFile); fs.rmSync(policyFile);
});

test("audit core stays offline and read only", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-orphans.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/); assert.match(source, /validateOrphanEvidence/);
});
