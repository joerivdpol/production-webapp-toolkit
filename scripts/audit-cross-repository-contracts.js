#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  validContractId,
  validContractVersion,
  validRepositoryId,
  validateContractInventory,
} from "./contract-inventory.js";

/** @typedef {{ contractId: string, repositories: string[], expectedVersion: string | null }} ContractRequirement */
/** @typedef {{ version: 1, requirements: ContractRequirement[] }} CrossContractPolicy */
/** @typedef {{ id: string, status: "PASS" | "FAIL", contractId: string, repositories: string[], detail: string }} ContractCheck */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateCrossContractPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, policy: null, errors: [{ id: "policy-invalid", detail: "policy must be an object" }] };
  rejectUnknown(value, ["version", "requirements"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (!Array.isArray(value.requirements) || value.requirements.length === 0) {
    errors.push({ id: "requirements-invalid", detail: "requirements must be a non-empty array" });
    return { ok: false, policy: null, errors };
  }

  /** @type {ContractRequirement[]} */
  const requirements = [];
  const seenContractIds = new Set();
  for (const [index, raw] of value.requirements.entries()) {
    if (!isPlainObject(raw)) {
      errors.push({ id: "requirement-invalid", detail: `requirements[${index}] must be an object` });
      continue;
    }
    rejectUnknown(raw, ["contractId", "repositories", "expectedVersion"], "requirement", errors);
    const contractId = nonEmptyString(raw.contractId);
    if (!contractId || !validContractId(contractId)) {
      errors.push({ id: "contract-id-invalid", detail: `requirements[${index}].contractId is invalid` });
      continue;
    }
    if (seenContractIds.has(contractId)) {
      errors.push({ id: "contract-id-duplicate", detail: `policy contains duplicate requirement for "${contractId}"` });
      continue;
    }
    seenContractIds.add(contractId);

    if (!Array.isArray(raw.repositories) || raw.repositories.length < 2) {
      errors.push({ id: "repositories-invalid", detail: `requirements[${index}].repositories must contain at least two repositories` });
      continue;
    }
    const repositories = raw.repositories.map((item) => nonEmptyString(item));
    if (repositories.some((item) => !item || !validRepositoryId(item))) {
      errors.push({ id: "repository-invalid", detail: `requirements[${index}].repositories contains an invalid repository id` });
      continue;
    }
    const normalizedRepositories = /** @type {string[]} */ (repositories);
    if (new Set(normalizedRepositories).size !== normalizedRepositories.length) {
      errors.push({ id: "repository-duplicate", detail: `requirements[${index}].repositories contains duplicates` });
      continue;
    }

    let expectedVersion = null;
    if (raw.expectedVersion !== undefined) {
      const normalized = nonEmptyString(raw.expectedVersion);
      if (!normalized || !validContractVersion(normalized)) {
        errors.push({ id: "expected-version-invalid", detail: `requirements[${index}].expectedVersion must be a portable version token` });
        continue;
      }
      expectedVersion = normalized;
    }
    requirements.push({ contractId, repositories: normalizedRepositories.sort(), expectedVersion });
  }

  if (errors.length > 0) return { ok: false, policy: null, errors };
  return {
    ok: true,
    policy: /** @type {CrossContractPolicy} */ ({ version: 1, requirements: requirements.sort((a, b) => a.contractId.localeCompare(b.contractId)) }),
    errors: [],
  };
}

/** @param {CrossContractPolicy} policy @param {Array<{version:1,repository:string,contracts:Array<{id:string,version:string}>}>} inventories */
export function inspectCrossRepositoryContracts(policy, inventories) {
  /** @type {ContractCheck[]} */
  const checks = [];
  /** @type {Map<string,{version:1,repository:string,contracts:Array<{id:string,version:string}>}>} */
  const byRepository = new Map();
  for (const inventory of inventories) {
    if (byRepository.has(inventory.repository)) {
      checks.push({
        id: "repository-inventory-duplicate",
        status: "FAIL",
        contractId: "(input)",
        repositories: [inventory.repository],
        detail: "repository inventory is supplied more than once",
      });
      continue;
    }
    byRepository.set(inventory.repository, inventory);
  }

  for (const requirement of policy.requirements) {
    const missingInventories = requirement.repositories.filter((repository) => !byRepository.has(repository));
    if (missingInventories.length > 0) {
      checks.push({
        id: "repository-inventory-missing",
        status: "FAIL",
        contractId: requirement.contractId,
        repositories: missingInventories,
        detail: `required contract inventory is missing for ${missingInventories.join(", ")}`,
      });
      continue;
    }

    const entries = requirement.repositories.map((repository) => {
      const inventory = byRepository.get(repository);
      const contract = inventory?.contracts.find((/** @type {{id:string,version:string}} */ item) => item.id === requirement.contractId) ?? null;
      return { repository, contract };
    });
    const missingContracts = entries.filter((entry) => entry.contract === null).map((entry) => entry.repository);
    if (missingContracts.length > 0) {
      checks.push({
        id: "contract-missing",
        status: "FAIL",
        contractId: requirement.contractId,
        repositories: missingContracts,
        detail: `required contract is not declared by ${missingContracts.join(", ")}`,
      });
      continue;
    }

    const versions = entries.map((entry) => ({ repository: entry.repository, version: /** @type {{version:string}} */ (entry.contract).version }));
    if (requirement.expectedVersion !== null) {
      const mismatches = versions.filter((entry) => entry.version !== requirement.expectedVersion);
      if (mismatches.length > 0) {
        checks.push({
          id: "contract-version-mismatch",
          status: "FAIL",
          contractId: requirement.contractId,
          repositories: mismatches.map((entry) => entry.repository),
          detail: `expected version ${requirement.expectedVersion}; mismatches: ${mismatches.map((entry) => `${entry.repository}=${entry.version}`).join(", ")}`,
        });
        continue;
      }
      checks.push({
        id: "contract-version-match",
        status: "PASS",
        contractId: requirement.contractId,
        repositories: requirement.repositories,
        detail: `all required repositories declare expected version ${requirement.expectedVersion}`,
      });
      continue;
    }

    const uniqueVersions = [...new Set(versions.map((entry) => entry.version))];
    if (uniqueVersions.length !== 1) {
      checks.push({
        id: "contract-version-drift",
        status: "FAIL",
        contractId: requirement.contractId,
        repositories: requirement.repositories,
        detail: `repositories disagree: ${versions.map((entry) => `${entry.repository}=${entry.version}`).join(", ")}`,
      });
      continue;
    }
    checks.push({
      id: "contract-version-aligned",
      status: "PASS",
      contractId: requirement.contractId,
      repositories: requirement.repositories,
      detail: `all required repositories declare version ${uniqueVersions[0]}`,
    });
  }

  const fail = checks.filter((check) => check.status === "FAIL").length;
  return {
    policyVersion: policy.version,
    repositories: [...byRepository.keys()].sort(),
    checks,
    summary: { pass: checks.length - fail, fail },
    technicalStatus: "PASS",
    overallStatus: fail > 0 ? "FAIL" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectCrossRepositoryContracts>} report */
export function formatCrossRepositoryContracts(report) {
  const lines = ["Cross-repository contract audit", ""];
  for (const check of report.checks) {
    lines.push(`${check.status.padEnd(4)}  ${check.contractId}  ${check.id}  ${check.detail}`);
  }
  lines.push(
    "",
    `Checks: ${report.summary.pass} pass, ${report.summary.fail} fail`,
    `Technical: ${report.technicalStatus}`,
    `Overall: ${report.overallStatus}`,
  );
  return lines.join("\n");
}

/** @param {string} filename */
function readJson(filename) {
  try { return { ok: true, value: JSON.parse(fs.readFileSync(filename, "utf8")) }; }
  catch { return { ok: false, value: null }; }
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let policyFile = null;
  /** @type {string[]} */
  const inventoryFiles = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--policy" && argument !== "--inventory-file") return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--policy") {
      if (policyFile !== null) return null;
      policyFile = value;
    } else {
      inventoryFiles.push(value);
    }
  }
  if (policyFile === null || inventoryFiles.length === 0 || new Set(inventoryFiles).size !== inventoryFiles.length) return null;
  return { policyFile, inventoryFiles, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/audit-cross-repository-contracts.js --policy <policy.json> --inventory-file <inventory.json> [--inventory-file <inventory.json> ...] [--json]");
    return 1;
  }

  const rawPolicy = readJson(options.policyFile);
  if (!rawPolicy.ok) { console.error("Cross-repository contract policy cannot be read or parsed"); return 1; }
  const policyResult = validateCrossContractPolicy(rawPolicy.value);
  if (!policyResult.ok || policyResult.policy === null) { console.error("Cross-repository contract policy is invalid"); return 1; }

  const inventories = [];
  const repositoryIds = new Set();
  for (const filename of options.inventoryFiles) {
    const rawInventory = readJson(filename);
    if (!rawInventory.ok) { console.error("Contract inventory file cannot be read or parsed"); return 1; }
    const inventoryResult = validateContractInventory(rawInventory.value);
    if (!inventoryResult.ok || inventoryResult.inventory === null) { console.error("Contract inventory is invalid"); return 1; }
    if (repositoryIds.has(inventoryResult.inventory.repository)) { console.error("Contract inventory repository identifiers must be unique"); return 1; }
    repositoryIds.add(inventoryResult.inventory.repository);
    inventories.push(inventoryResult.inventory);
  }

  const report = inspectCrossRepositoryContracts(policyResult.policy, inventories);
  console.log(options.json ? JSON.stringify(report) : formatCrossRepositoryContracts(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
