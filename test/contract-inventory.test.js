import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatContractInventory,
  main,
  validateContractInventory,
} from "../scripts/contract-inventory.js";

/** @returns {any} */
function inventory() {
  return {
    version: 1,
    repository: "hills",
    contracts: [
      { id: "room-types", version: "v12" },
      { id: "payment/account-routing", version: "schema-3" },
    ],
  };
}

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `contract-inventory-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("validates and deterministically sorts a portable contract inventory", () => {
  const value = inventory();
  value.contracts.reverse();
  const result = validateContractInventory(value);
  assert.equal(result.ok, true);
  if (!result.ok || result.inventory === null) return;
  assert.deepEqual(result.inventory.contracts.map((item) => item.id), ["payment/account-routing", "room-types"]);
  assert.match(formatContractInventory(result.inventory), /Result: VALID/);
});

test("rejects ambiguous repository ids and contract versions", () => {
  const badRepository = inventory();
  badRepository.repository = "../hills";
  assert.equal(validateContractInventory(badRepository).ok, false);

  const badVersion = inventory();
  badVersion.contracts[0].version = "version with spaces";
  assert.equal(validateContractInventory(badVersion).ok, false);
});

test("rejects duplicate contract ids, empty inventories, and unknown fields", () => {
  const duplicate = inventory();
  duplicate.contracts.push({ id: "room-types", version: "v13" });
  assert.equal(validateContractInventory(duplicate).ok, false);

  const empty = inventory();
  empty.contracts = [];
  assert.equal(validateContractInventory(empty).ok, false);

  const unknown = inventory();
  unknown.environment = "production";
  assert.equal(validateContractInventory(unknown).ok, false);
});

test("CLI emits canonical JSON and leaves the source file unchanged", () => {
  const filename = tempJson(inventory());
  const before = fs.readFileSync(filename, "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", filename, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).repository, "hills");
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed, invalid, missing, and unknown input", () => {
  const malformed = tempJson("{");
  const invalid = tempJson({ version: 1 });
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--file", invalid]), 1);
  assert.equal(main(["--file", "/tmp/missing-contract-inventory.json"]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  fs.rmSync(invalid, { force: true });
});

test("contract inventory validator stays local and read only", () => {
  const source = fs.readFileSync(new URL("../scripts/contract-inventory.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
