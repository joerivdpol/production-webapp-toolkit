#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA_PATTERN = /^[a-f0-9]{40}$|^[a-f0-9]{64}$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SRI_PATTERN = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/;
const TOOLKIT_PACKAGE = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const TOOLKIT_VERSION = typeof TOOLKIT_PACKAGE.version === "string" ? TOOLKIT_PACKAGE.version : "unknown";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {string} text */
export function stripJsonTrailingCommas(text) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      output += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      output += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next] ?? "")) next += 1;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    output += character;
  }
  return output;
}

/** @param {string} text */
export function parseBunLock(text) {
  let value;
  try { value = JSON.parse(stripJsonTrailingCommas(text)); }
  catch { throw new Error("bun.lock cannot be parsed as supported Bun text lockfile"); }
  if (!isPlainObject(value) || value.lockfileVersion !== 1 || !isPlainObject(value.workspaces) || !isPlainObject(value.packages)) {
    throw new Error("bun.lock must be version 1 with workspaces and packages objects");
  }
  const rootWorkspace = value.workspaces[""];
  if (!isPlainObject(rootWorkspace)) throw new Error("bun.lock root workspace is required");
  return { rootWorkspace, packages: value.packages };
}

/** @param {string} packageId */
function parsePackageId(packageId) {
  const separator = packageId.lastIndexOf("@");
  if (separator <= 0 || separator === packageId.length - 1) {
    throw new Error("bun.lock package identity is invalid");
  }
  const name = packageId.slice(0, separator);
  const version = packageId.slice(separator + 1);
  if (!name || !version || /\s/.test(name) || /\s/.test(version)) {
    throw new Error("bun.lock package identity is invalid");
  }
  return { name, version };
}

/** @param {string} integrity */
function integrityHash(integrity) {
  const match = SRI_PATTERN.exec(integrity);
  if (!match) return null;
  const encoded = match[2];
  if (!encoded) return null;
  let bytes;
  try { bytes = Buffer.from(encoded, "base64"); }
  catch { return null; }
  if (bytes.length === 0) return null;
  const expectedLength = match[1] === "sha256" ? 32 : match[1] === "sha384" ? 48 : 64;
  if (bytes.length !== expectedLength) return null;
  return {
    alg: match[1] === "sha256" ? "SHA-256" : match[1] === "sha384" ? "SHA-384" : "SHA-512",
    content: bytes.toString("hex"),
  };
}

/** @param {string} filename */
function readRegularFile(filename) {
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch { throw new Error(`required file is missing: ${path.basename(filename)}`); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`required file must be a regular file: ${path.basename(filename)}`);
  return fs.readFileSync(filename, "utf8");
}

/** @param {string} text */
function sha256Text(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

/** @param {Record<string, unknown>} workspace */
function directRelationships(workspace) {
  const relationships = new Map();
  /** @type {Array<[string,string]>} */
  const groups = [
    ["dependencies", "direct-production"],
    ["devDependencies", "direct-development"],
    ["optionalDependencies", "direct-optional"],
  ];
  for (const [field, relationship] of groups) {
    const value = workspace[field];
    if (value === undefined) continue;
    if (!isPlainObject(value)) throw new Error(`bun.lock root workspace ${field} must be an object`);
    for (const name of Object.keys(value)) {
      if (!name.trim()) throw new Error(`bun.lock root workspace ${field} contains an invalid package name`);
      if (relationships.has(name)) throw new Error(`direct dependency ${name} is declared in multiple relationship groups`);
      relationships.set(name, relationship);
    }
  }
  return relationships;
}

/** @param {string} name @param {string} version */
function componentRef(name, version) {
  return `npm:${name}@${version}`;
}

/** @param {Record<string, unknown>} packages @param {Map<string,string>} relationships */
function buildComponents(packages, relationships) {
  /** @type {Array<any>} */
  const components = [];
  /** @type {string[]} */
  const directRefs = [];
  const seenRefs = new Set();
  /** @type {Map<string,string[]>} */
  const packageByName = new Map();
  for (const [lockKey, raw] of Object.entries(packages)) {
    if (!Array.isArray(raw) || raw.length < 4 || typeof raw[0] !== "string") {
      throw new Error(`bun.lock package entry is unsupported: ${lockKey}`);
    }
    const { name, version } = parsePackageId(raw[0]);
    const ref = componentRef(name, version);
    if (seenRefs.has(ref)) continue;
    seenRefs.add(ref);
    const relationship = relationships.get(name) ?? "transitive";
    /** @type {any} */
    const component = {
      type: "library",
      name,
      version,
      "bom-ref": ref,
      properties: [{ name: "toolkit:dependencyRelationship", value: relationship }],
    };
    const integrity = typeof raw[3] === "string" ? integrityHash(raw[3]) : null;
    if (integrity) component.hashes = [integrity];
    else component.properties.push({ name: "toolkit:packageIntegrity", value: "unavailable" });
    components.push(component);
    const refs = packageByName.get(name) ?? [];
    refs.push(ref);
    packageByName.set(name, refs);
  }
  for (const name of relationships.keys()) {
    const refs = packageByName.get(name) ?? [];
    if (refs.length !== 1 || !refs[0]) throw new Error(`direct dependency ${name} does not resolve to exactly one locked package`);
    directRefs.push(refs[0]);
  }
  components.sort((a, b) => a["bom-ref"].localeCompare(b["bom-ref"]));
  directRefs.sort();
  return { components, directRefs };
}

/** @param {unknown} value @param {string} label */
function requiredString(value, label) {
  const normalized = nonEmptyString(value);
  if (!normalized) throw new Error(`${label} must be a non-empty string`);
  return normalized;
}

/**
 * @param {string} root
 * @param {{ sourceCommit:string, artifactSha256:string, createdAt:string, artifactName?:string|null, artifactVersion?:string|null }} options
 */
export function generateSbom(root, options) {
  const packageText = readRegularFile(path.join(root, "package.json"));
  const lockText = readRegularFile(path.join(root, "bun.lock"));
  const nodeVersion = readRegularFile(path.join(root, ".node-version")).trim();
  let pkg;
  try { pkg = JSON.parse(packageText); }
  catch { throw new Error("package.json cannot be parsed"); }
  if (!isPlainObject(pkg)) throw new Error("package.json must be an object");
  const packageName = requiredString(pkg.name, "package.json name");
  const packageVersion = requiredString(pkg.version, "package.json version");
  const packageManager = requiredString(pkg.packageManager, "package.json packageManager");
  if (!/^\d+\.\d+\.\d+$/.test(nodeVersion)) throw new Error(".node-version must contain an exact semantic version");
  if (!/^bun@\d+\.\d+\.\d+$/.test(packageManager)) throw new Error("packageManager must pin an exact Bun version");

  const sourceCommit = requiredString(options.sourceCommit, "source commit").toLowerCase();
  const artifactSha256 = requiredString(options.artifactSha256, "artifact SHA256").toLowerCase();
  const createdAt = requiredString(options.createdAt, "created-at");
  if (!SHA_PATTERN.test(sourceCommit)) throw new Error("source commit must be a full SHA-1 or SHA-256 object id");
  if (!SHA256_PATTERN.test(artifactSha256)) throw new Error("artifact SHA256 must be exactly 64 hexadecimal characters");
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(createdAt) || Number.isNaN(Date.parse(createdAt))) {
    throw new Error("created-at must be an absolute ISO timestamp");
  }

  const artifactName = options.artifactName ? requiredString(options.artifactName, "artifact name") : packageName;
  const artifactVersion = options.artifactVersion ? requiredString(options.artifactVersion, "artifact version") : packageVersion;
  const lock = parseBunLock(lockText);
  const relationships = directRelationships(lock.rootWorkspace);
  const { components, directRefs } = buildComponents(lock.packages, relationships);
  const rootRef = `application:${artifactName}@${artifactVersion}`;

  const sbom = {
    "$schema": "https://cyclonedx.org/schema/bom-1.7.schema.json",
    bomFormat: "CycloneDX",
    specVersion: "1.7",
    version: 1,
    metadata: {
      timestamp: createdAt,
      tools: {
        components: [{ type: "application", name: "production-webapp-toolkit", version: TOOLKIT_VERSION }],
      },
      component: {
        type: "application",
        name: artifactName,
        version: artifactVersion,
        "bom-ref": rootRef,
        hashes: [{ alg: "SHA-256", content: artifactSha256 }],
      },
      properties: [
        { name: "toolkit:sourceCommit", value: sourceCommit },
        { name: "toolkit:lockfileSha256", value: sha256Text(lockText) },
        { name: "toolkit:nodeVersion", value: nodeVersion },
        { name: "toolkit:packageManager", value: packageManager },
      ],
    },
    components,
    dependencies: [{ ref: rootRef, dependsOn: directRefs }],
  };
  sbom.metadata.properties.push({ name: "toolkit:dependencyGraph", value: "root-direct-only" });
  return {
    sbom,
    summary: {
      components: components.length,
      directDependencies: directRefs.length,
      hashedComponents: components.filter((component) => Array.isArray(component.hashes)).length,
      unhashedComponents: components.filter((component) => !Array.isArray(component.hashes)).length,
    },
  };
}

/** @param {ReturnType<typeof generateSbom>} result */
export function formatSbomSummary(result) {
  return [
    "CycloneDX SBOM generation",
    "",
    `Artifact: ${result.sbom.metadata.component.name}@${result.sbom.metadata.component.version}`,
    `Components: ${result.summary.components}`,
    `Direct dependencies: ${result.summary.directDependencies}`,
    `Hashed components: ${result.summary.hashedComponents}`,
    `Unhashed components: ${result.summary.unhashedComponents}`,
    "Dependency graph: root direct edges only; transitive parent edges are not inferred",
    "Result: GENERATED",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let root = null;
  let sourceCommit = null;
  let artifactSha256 = null;
  let createdAt = null;
  let artifactName = null;
  let artifactVersion = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (!["--root", "--source-commit", "--artifact-sha256", "--created-at", "--artifact-name", "--artifact-version"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--root") { if (root !== null) return null; root = value; continue; }
    if (argument === "--source-commit") { if (sourceCommit !== null) return null; sourceCommit = value; continue; }
    if (argument === "--artifact-sha256") { if (artifactSha256 !== null) return null; artifactSha256 = value; continue; }
    if (argument === "--created-at") { if (createdAt !== null) return null; createdAt = value; continue; }
    if (argument === "--artifact-name") { if (artifactName !== null) return null; artifactName = value; continue; }
    if (argument === "--artifact-version") { if (artifactVersion !== null) return null; artifactVersion = value; continue; }
  }
  if (root === null || sourceCommit === null || artifactSha256 === null || createdAt === null) return null;
  return { root, sourceCommit, artifactSha256, createdAt, artifactName, artifactVersion, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/generate-sbom.js --root <repository> --source-commit <full-sha> --artifact-sha256 <sha256> --created-at <ISO timestamp> [--artifact-name <name>] [--artifact-version <version>] [--json]");
    return 1;
  }
  let result;
  try {
    result = generateSbom(path.resolve(options.root), {
      sourceCommit: options.sourceCommit,
      artifactSha256: options.artifactSha256,
      createdAt: options.createdAt,
      artifactName: options.artifactName,
      artifactVersion: options.artifactVersion,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "SBOM generation failed");
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.sbom) : formatSbomSummary(result));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
