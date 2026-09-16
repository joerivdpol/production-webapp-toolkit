#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";
import { normalizeLicenseExpression, validateLicenseEvidence } from "./license-evidence.js";

const MAX_PACKAGE_DIRECTORIES = 20000;
const MAX_NESTED_NODE_MODULES_DEPTH = 12;

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {string} filename */
function readRegularJson(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch { return null; }
  if (!stat.isFile() || stat.isSymbolicLink()) return null;
  try { return JSON.parse(fs.readFileSync(filename, "utf8")); } catch { return null; }
}

/** @param {unknown} value */
export function packageTargetsFromSbom(value) {
  if (!isPlainObject(value) || value.bomFormat !== "CycloneDX" || value.specVersion !== "1.7") {
    throw new Error("SBOM must be CycloneDX 1.7");
  }
  if (!isPlainObject(value.metadata) || !isPlainObject(value.metadata.component)) throw new Error("SBOM metadata component is required");
  const root = value.metadata.component;
  const artifactName = nonEmptyString(root.name);
  const artifactVersion = nonEmptyString(root.version);
  if (!artifactName || !artifactVersion) throw new Error("SBOM artifact identity is incomplete");
  if (!Array.isArray(root.hashes)) throw new Error("SBOM artifact SHA256 is required");
  const shaHashes = root.hashes.filter((item) => isPlainObject(item) && item.alg === "SHA-256" && typeof item.content === "string");
  if (shaHashes.length !== 1 || !/^[a-f0-9]{64}$/i.test(String(shaHashes[0]?.content ?? ""))) throw new Error("SBOM must contain exactly one artifact SHA256");
  const sha256 = String(shaHashes[0]?.content).toLowerCase();

  if (!Array.isArray(value.metadata.properties)) throw new Error("SBOM metadata properties are required");
  const sourceValues = value.metadata.properties.filter((item) => isPlainObject(item) && item.name === "toolkit:sourceCommit").map((item) => item.value);
  if (sourceValues.length !== 1 || typeof sourceValues[0] !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sourceValues[0])) {
    throw new Error("SBOM must contain exactly one full toolkit:sourceCommit");
  }
  const sourceCommit = sourceValues[0].toLowerCase();

  if (!Array.isArray(value.components)) throw new Error("SBOM components must be an array");
  const targets = [];
  const seen = new Set();
  for (const [index, component] of value.components.entries()) {
    if (!isPlainObject(component) || component.type !== "library") throw new Error(`SBOM components[${index}] must be a library component`);
    const name = nonEmptyString(component.name);
    const version = nonEmptyString(component.version);
    if (!name || !version || /\s/.test(name) || /\s/.test(version)) throw new Error(`SBOM components[${index}] has invalid package identity`);
    if (!Array.isArray(component.properties)) throw new Error(`SBOM components[${index}] relationship property is required`);
    const relationships = component.properties.filter((item) => isPlainObject(item) && item.name === "toolkit:dependencyRelationship").map((item) => item.value);
    if (relationships.length !== 1 || typeof relationships[0] !== "string") throw new Error(`SBOM components[${index}] must contain one dependency relationship`);
    const key = `${name}@${version}`;
    if (seen.has(key)) throw new Error(`SBOM contains duplicate package identity ${key}`);
    seen.add(key);
    targets.push({ name, version, relationship: relationships[0] });
  }
  targets.sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
  return {
    artifact: { name: artifactName, version: artifactVersion, sha256, sourceCommit },
    targets,
  };
}

/** @param {string} directory */
function childDirectories(directory) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch { return []; }
  return entries.filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).map((entry) => path.join(directory, entry.name));
}

/** @param {string} nodeModules */
function packageDirectories(nodeModules) {
  const directories = [];
  for (const entry of childDirectories(nodeModules)) {
    const name = path.basename(entry);
    if (name.startsWith("@")) directories.push(...childDirectories(entry));
    else directories.push(entry);
  }
  return directories;
}

/** @param {unknown} value */
function manifestLicense(value) {
  if (!isPlainObject(value)) return null;
  if (typeof value.license !== "string") return null;
  return normalizeLicenseExpression(value.license);
}

/** @param {string} root */
export function scanInstalledPackageLicenses(root) {
  const first = path.join(root, "node_modules");
  let firstStat;
  try { firstStat = fs.lstatSync(first); } catch { throw new Error("node_modules directory is missing"); }
  if (!firstStat.isDirectory() || firstStat.isSymbolicLink()) throw new Error("node_modules must be a real directory, not a symlink");

  /** @type {Array<{path:string,depth:number}>} */
  const queue = [{ path: first, depth: 0 }];
  /** @type {Map<string, Set<string|null>>} */
  const found = new Map();
  let inspected = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    for (const packageDir of packageDirectories(current.path)) {
      inspected += 1;
      if (inspected > MAX_PACKAGE_DIRECTORIES) throw new Error("installed package scan exceeds safety bound");
      const manifest = readRegularJson(path.join(packageDir, "package.json"));
      if (!isPlainObject(manifest)) continue;
      const name = nonEmptyString(manifest.name);
      const version = nonEmptyString(manifest.version);
      if (name && version) {
        const key = `${name}@${version}`;
        const licenses = found.get(key) ?? new Set();
        licenses.add(manifestLicense(manifest));
        found.set(key, licenses);
      }
      if (current.depth < MAX_NESTED_NODE_MODULES_DEPTH) {
        const nested = path.join(packageDir, "node_modules");
        let nestedStat;
        try { nestedStat = fs.lstatSync(nested); } catch { nestedStat = null; }
        if (nestedStat?.isDirectory() && !nestedStat.isSymbolicLink()) queue.push({ path: nested, depth: current.depth + 1 });
      }
    }
  }
  return { found, inspected };
}

/** @param {string} root @param {unknown} sbom @param {string} collectedAt */
export function collectInstalledLicenseEvidence(root, sbom, collectedAt) {
  if (!isAbsoluteIsoTimestamp(collectedAt)) throw new Error("collected-at must be an absolute ISO timestamp");
  const target = packageTargetsFromSbom(sbom);
  const scan = scanInstalledPackageLicenses(root);
  const packages = target.targets.map((item) => {
    const key = `${item.name}@${item.version}`;
    const licenses = scan.found.get(key);
    let licenseExpression = null;
    if (licenses && licenses.size > 1) throw new Error(`installed package manifests disagree about license for ${key}`);
    if (licenses?.size === 1) licenseExpression = [...licenses][0] ?? null;
    return { ...item, licenseExpression };
  });
  const candidate = {
    version: 1,
    artifact: target.artifact,
    source: { kind: "installed-package-manifests", authenticated: false, collectedAt },
    packages,
  };
  const validated = validateLicenseEvidence(candidate);
  if (!validated.ok || validated.evidence === null) throw new Error("collected license evidence failed canonical validation");
  const known = validated.evidence.packages.filter((item) => item.licenseExpression !== null).length;
  return {
    evidence: validated.evidence,
    summary: { targets: packages.length, known, unknown: packages.length - known, inspectedPackageDirectories: scan.inspected },
  };
}

/** @param {ReturnType<typeof collectInstalledLicenseEvidence>} result */
export function formatInstalledLicenseCollection(result) {
  return [
    "Installed package license evidence collection",
    "",
    `Artifact: ${result.evidence.artifact.name}@${result.evidence.artifact.version}`,
    `Targets: ${result.summary.targets}`,
    `Declared licenses: ${result.summary.known}`,
    `Unknown licenses: ${result.summary.unknown}`,
    `Package directories inspected: ${result.summary.inspectedPackageDirectories}`,
    "Source trust: local installed package manifests; unauthenticated",
    "Result: COLLECTED",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let root = null;
  let sbomFile = null;
  let collectedAt = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--root", "--sbom-file", "--collected-at"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--root") { if (root !== null) return null; root = value; continue; }
    if (argument === "--sbom-file") { if (sbomFile !== null) return null; sbomFile = value; continue; }
    if (argument === "--collected-at") { if (collectedAt !== null) return null; collectedAt = value; continue; }
  }
  return root && sbomFile && collectedAt ? { root, sbomFile, collectedAt, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/collect-installed-license-evidence.js --root <repository> --sbom-file <release.cdx.json> --collected-at <ISO timestamp> [--json]");
    return 1;
  }
  let sbom;
  try { sbom = JSON.parse(fs.readFileSync(options.sbomFile, "utf8")); }
  catch { console.error("SBOM file cannot be read or parsed"); return 1; }
  try {
    const result = collectInstalledLicenseEvidence(path.resolve(options.root), sbom, options.collectedAt);
    console.log(options.json ? JSON.stringify(result.evidence) : formatInstalledLicenseCollection(result));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "License evidence collection failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
