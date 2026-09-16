#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

/** @typedef {{ id: string, version: string }} ContractEntry */
/** @typedef {{ version: 1, repository: string, contracts: ContractEntry[] }} ContractInventory */
/** @typedef {{ id: string, detail: string }} InventoryError */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {string} value */
export function validRepositoryId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value);
}

/** @param {string} value */
export function validContractId(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(value);
}

/** @param {string} value */
export function validContractVersion(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._:+/@-]{0,127}$/.test(value);
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {InventoryError[]} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateContractInventory(value) {
  /** @type {InventoryError[]} */
  const errors = [];
  if (!isPlainObject(value)) {
    return { ok: false, inventory: null, errors: [{ id: "inventory-invalid", detail: "contract inventory must be an object" }] };
  }
  rejectUnknown(value, ["version", "repository", "contracts"], "inventory", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  const repository = nonEmptyString(value.repository);
  if (!repository || !validRepositoryId(repository)) {
    errors.push({ id: "repository-invalid", detail: "repository must be an explicit portable identifier" });
  }

  if (!Array.isArray(value.contracts) || value.contracts.length === 0) {
    errors.push({ id: "contracts-invalid", detail: "contracts must be a non-empty array" });
    return { ok: false, inventory: null, errors };
  }

  /** @type {ContractEntry[]} */
  const contracts = [];
  const ids = new Set();
  for (const [index, raw] of value.contracts.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "contract-invalid", detail: `contracts[${index}] must be an object` });
      continue;
    }
    rejectUnknown(raw, ["id", "version"], "contract", errors);
    const id = nonEmptyString(raw.id);
    const contractVersion = nonEmptyString(raw.version);
    if (!id || !validContractId(id)) {
      errors.push({ id: "contract-id-invalid", detail: `contracts[${index}].id is invalid` });
      continue;
    }
    if (!contractVersion || !validContractVersion(contractVersion)) {
      errors.push({ id: "contract-version-invalid", detail: `contracts[${index}].version must be a portable version token` });
      continue;
    }
    if (ids.has(id)) {
      errors.push({ id: "contract-id-duplicate", detail: `contract inventory contains duplicate contract id "${id}"` });
      continue;
    }
    ids.add(id);
    contracts.push({ id, version: contractVersion });
  }

  if (errors.length > 0 || !repository) return { ok: false, inventory: null, errors };
  return {
    ok: true,
    inventory: /** @type {ContractInventory} */ ({
      version: 1,
      repository,
      contracts: contracts.sort((a, b) => a.id.localeCompare(b.id)),
    }),
    errors: [],
  };
}

/** @param {ContractInventory} inventory */
export function formatContractInventory(inventory) {
  return [
    "Contract inventory",
    "",
    `Repository: ${inventory.repository}`,
    `Contracts: ${inventory.contracts.length}`,
    ...inventory.contracts.map((item) => `  ${item.id}  ${item.version}`),
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let file = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--file" || file !== null) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    file = value;
    index += 1;
  }
  return file === null ? null : { file, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/contract-inventory.js --file <inventory.json> [--json]");
    return 1;
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(options.file, "utf8")); }
  catch { console.error("Contract inventory file cannot be read or parsed"); return 1; }
  const result = validateContractInventory(value);
  if (!result.ok || result.inventory === null) {
    console.error("Contract inventory is invalid");
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.inventory) : formatContractInventory(result.inventory));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
