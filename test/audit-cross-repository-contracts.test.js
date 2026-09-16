import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatCrossRepositoryContracts,
  inspectCrossRepositoryContracts,
  main,
  validateCrossContractPolicy,
} from "../scripts/audit-cross-repository-contracts.js";
import { validateContractInventory } from "../scripts/contract-inventory.js";

/** @param {string} repository @param {string} [roomVersion] @param {string} [paymentVersion] @returns {any} */
function rawInventory(repository, roomVersion = "v12", paymentVersion = "schema-3") {
  return {
    version: 1,
    repository,
    contracts: [
      { id: "room-types", version: roomVersion },
      { id: "payment/account-routing", version: paymentVersion },
    ],
  };
}

/** @param {string} repository @param {string} [roomVersion] @param {string} [paymentVersion] */
function inventory(repository, roomVersion = "v12", paymentVersion = "schema-3") {
  const result = validateContractInventory(rawInventory(repository, roomVersion, paymentVersion));
  assert.equal(result.ok, true);
  if (!result.ok || result.inventory === null) throw new Error("fixture inventory invalid");
  return result.inventory;
}

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    requirements: [
      { contractId: "room-types", repositories: ["pulse", "hills", "travel"], expectedVersion: "v12" },
      { contractId: "payment/account-routing", repositories: ["hills", "travel"] },
    ],
  };
}

function policy() {
  const result = validateCrossContractPolicy(rawPolicy());
  assert.equal(result.ok, true);
  if (!result.ok || result.policy === null) throw new Error("fixture policy invalid");
  return result.policy;
}

/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const filename = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("validates explicit multi-repository contract policy", () => {
  const result = validateCrossContractPolicy(rawPolicy());
  assert.equal(result.ok, true);
  if (!result.ok || result.policy === null) return;
  assert.equal(result.policy.requirements.length, 2);
  assert.deepEqual(result.policy.requirements.find((item) => item.contractId === "room-types")?.repositories, ["hills", "pulse", "travel"]);
});

test("policy rejects single-repository checks, duplicate repos, duplicate contracts, and unknown fields", () => {
  const single = rawPolicy();
  single.requirements[0].repositories = ["hills"];
  assert.equal(validateCrossContractPolicy(single).ok, false);

  const duplicateRepo = rawPolicy();
  duplicateRepo.requirements[0].repositories = ["hills", "hills"];
  assert.equal(validateCrossContractPolicy(duplicateRepo).ok, false);

  const duplicateContract = rawPolicy();
  duplicateContract.requirements.push({ contractId: "room-types", repositories: ["hills", "pulse"] });
  assert.equal(validateCrossContractPolicy(duplicateContract).ok, false);

  const unknown = rawPolicy();
  unknown.requirements[0].canonicalRepository = "pulse";
  assert.equal(validateCrossContractPolicy(unknown).ok, false);
});

test("explicit expected versions PASS when every required repository matches", () => {
  const report = inspectCrossRepositoryContracts(policy(), [inventory("pulse"), inventory("hills"), inventory("travel")]);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.summary.fail, 0);
});

test("expected version mismatch is blocking and identifies only mismatching repositories", () => {
  const report = inspectCrossRepositoryContracts(policy(), [inventory("pulse"), inventory("hills"), inventory("travel", "v11")]);
  assert.equal(report.overallStatus, "FAIL");
  const check = report.checks.find((item) => item.id === "contract-version-mismatch");
  assert.deepEqual(check?.repositories, ["travel"]);
  assert.match(check?.detail ?? "", /travel=v11/);
});

test("consensus requirements detect drift without inventing a canonical repository", () => {
  const report = inspectCrossRepositoryContracts(policy(), [
    inventory("pulse"),
    inventory("hills", "v12", "schema-3"),
    inventory("travel", "v12", "schema-4"),
  ]);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "contract-version-drift" && item.contractId === "payment/account-routing"), true);
});

test("missing repository inventory and missing contract declarations are blocking", () => {
  const missingInventory = inspectCrossRepositoryContracts(policy(), [inventory("hills"), inventory("travel")]);
  assert.equal(missingInventory.checks.some((item) => item.id === "repository-inventory-missing" && item.repositories.includes("pulse")), true);

  const travel = rawInventory("travel");
  travel.contracts = travel.contracts.filter((/** @type {any} */ item) => item.id !== "payment/account-routing");
  const validatedTravel = validateContractInventory(travel);
  assert.equal(validatedTravel.ok, true);
  if (!validatedTravel.ok || validatedTravel.inventory === null) return;
  const missingContract = inspectCrossRepositoryContracts(policy(), [inventory("pulse"), inventory("hills"), validatedTravel.inventory]);
  assert.equal(missingContract.checks.some((item) => item.id === "contract-missing" && item.repositories.includes("travel")), true);
});


test("direct inspection rejects duplicate repository inventories", () => {
  const report = inspectCrossRepositoryContracts(policy(), [inventory("pulse"), inventory("hills"), inventory("hills"), inventory("travel")]);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "repository-inventory-duplicate" && item.repositories.includes("hills")), true);
});

test("unreferenced inventory contracts and repositories do not alter explicit policy truth", () => {
  const extra = inventory("other", "v999", "schema-999");
  extra.contracts.push({ id: "private-business-rule", version: "one" });
  const report = inspectCrossRepositoryContracts(policy(), [inventory("pulse"), inventory("hills"), inventory("travel"), extra]);
  assert.equal(report.overallStatus, "PASS");
});

test("human output exposes contract versions but no business semantics", () => {
  const report = inspectCrossRepositoryContracts(policy(), [inventory("pulse"), inventory("hills"), inventory("travel", "v11")]);
  const text = formatCrossRepositoryContracts(report);
  assert.match(text, /room-types/);
  assert.match(text, /travel=v11/);
  assert.match(text, /Overall: FAIL/);
});

test("CLI emits JSON for PASS and returns one for contract drift", () => {
  const policyFile = tempJson("cross-policy", rawPolicy());
  const pulseFile = tempJson("pulse-contracts", rawInventory("pulse"));
  const hillsFile = tempJson("hills-contracts", rawInventory("hills"));
  const travelFile = tempJson("travel-contracts", rawInventory("travel"));
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(main(["--policy", policyFile, "--inventory-file", pulseFile, "--inventory-file", hillsFile, "--inventory-file", travelFile, "--json"]), 0);
  } finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");

  fs.writeFileSync(travelFile, JSON.stringify(rawInventory("travel", "v11")));
  assert.equal(main(["--policy", policyFile, "--inventory-file", pulseFile, "--inventory-file", hillsFile, "--inventory-file", travelFile]), 1);
  for (const filename of [policyFile, pulseFile, hillsFile, travelFile]) fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed inputs and duplicate repository identities", () => {
  const malformedPolicy = tempJson("bad-cross-policy", "{");
  const hillsA = tempJson("hills-a", rawInventory("hills"));
  const hillsB = tempJson("hills-b", rawInventory("hills"));
  const validPolicy = tempJson("cross-policy", rawPolicy());
  assert.equal(main(["--policy", malformedPolicy, "--inventory-file", hillsA]), 1);
  assert.equal(main(["--policy", validPolicy, "--inventory-file", hillsA, "--inventory-file", hillsB]), 1);
  assert.equal(main(["--unknown"]), 1);
  for (const filename of [malformedPolicy, hillsA, hillsB, validPolicy]) fs.rmSync(filename, { force: true });
});

test("cross-repository audit stays offline, local, and read only", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-cross-repository-contracts.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /validateContractInventory/);
});
