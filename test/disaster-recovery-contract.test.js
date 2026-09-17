import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DR_AREAS, formatDisasterRecoveryContract, main, validateDisasterRecoveryContract } from "../scripts/disaster-recovery-contract.js";

/** @returns {any} */
function rawContract() {
  /** @type {Record<string, {owner:string,runbookPath:string}>} */
  const areas = {};
  for (const area of DR_AREAS) areas[area] = { owner: `owner-${area}`, runbookPath: `docs/dr/${area}.md` };
  return { version: 1, plans: [{ id: "production", reviewedAt: "2026-09-16T00:00:00Z", maxReviewAgeMinutes: 43200, areas }] };
}
/** @param {any} value */
function tempJson(value) { const file = path.join(os.tmpdir(), `dr-contract-${process.pid}-${Math.random().toString(16).slice(2)}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("validates all seven required disaster recovery areas", () => {
  const result = validateDisasterRecoveryContract(rawContract());
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  if (!result.valid || !result.contract) return;
  assert.deepEqual(Object.keys(result.contract.plans[0].areas).sort(), [...DR_AREAS].sort());
  assert.match(formatDisasterRecoveryContract(result.contract), /Result: VALID/);
});
test("missing area fails closed rather than treating partial recovery as complete", () => {
  const raw = rawContract(); delete raw.plans[0].areas.restore;
  const result = validateDisasterRecoveryContract(raw);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((item) => item.id === "area-missing"), true);
});

test("rejects unsafe runbook paths invalid owners and unknown area fields", () => {
  const unsafe = rawContract(); unsafe.plans[0].areas.database.runbookPath = "../db.md";
  assert.equal(validateDisasterRecoveryContract(unsafe).valid, false);
  const owner = rawContract(); owner.plans[0].areas.secrets.owner = "ops team";
  assert.equal(validateDisasterRecoveryContract(owner).valid, false);
  const unknown = rawContract(); unknown.plans[0].areas.dns.providerToken = true;
  assert.equal(validateDisasterRecoveryContract(unknown).valid, false);
});

test("rejects duplicate plans invalid review timestamps and review-age bounds", () => {
  const duplicate = rawContract(); duplicate.plans.push(structuredClone(duplicate.plans[0]));
  assert.equal(validateDisasterRecoveryContract(duplicate).valid, false);
  const time = rawContract(); time.plans[0].reviewedAt = "yesterday";
  assert.equal(validateDisasterRecoveryContract(time).valid, false);
  const age = rawContract(); age.plans[0].maxReviewAgeMinutes = 0;
  assert.equal(validateDisasterRecoveryContract(age).valid, false);
});
test("CLI emits canonical JSON without changing source contract", () => {
  const file = tempJson(rawContract()), before = fs.readFileSync(file, "utf8");
  const original = console.log; let stdout = ""; console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", file, "--json"]), 0); } finally { console.log = original; }
  assert.equal(JSON.parse(stdout).plans[0].id, "production");
  assert.equal(fs.readFileSync(file, "utf8"), before);
  fs.rmSync(file, { force: true });
});

test("CLI rejects malformed and unknown input", () => {
  const malformed = tempJson("{");
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("DR contract validator remains offline and read only", () => {
  const source = fs.readFileSync(new URL("../scripts/disaster-recovery-contract.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
