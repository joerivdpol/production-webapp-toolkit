#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const PACKAGE_MANAGER_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_GENERATED_INPUTS = 256;
const MAX_HASH_FILE_BYTES = 64 * 1024 * 1024;

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
function safeRelativePath(value) {
  if (!value || value.includes("\0") || path.isAbsolute(value)) return false;
  const normalized = path.posix.normalize(value.replaceAll("\\", "/"));
  return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && normalized === value.replaceAll("\\", "/");
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value */
export function validateReproducibilityPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, policy: null, errors: [{ id: "policy-invalid", detail: "reproducibility policy must be an object" }] };
  rejectUnknown(value, ["version", "packageManager", "runtime", "lockfile", "frozenInstall", "generatedInputs"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });

  let packageManager = null;
  if (!isPlainObject(value.packageManager)) errors.push({ id: "package-manager-invalid", detail: "packageManager must be an object" });
  else {
    rejectUnknown(value.packageManager, ["name", "expectedVersion"], "package-manager", errors);
    const name = nonEmptyString(value.packageManager.name)?.toLowerCase() ?? null;
    const expectedVersion = value.packageManager.expectedVersion === undefined ? null : nonEmptyString(value.packageManager.expectedVersion);
    if (!name || !PACKAGE_MANAGER_PATTERN.test(name)) errors.push({ id: "package-manager-name-invalid", detail: "packageManager.name must be a portable identifier" });
    if (expectedVersion !== null && !EXACT_VERSION_PATTERN.test(expectedVersion)) errors.push({ id: "package-manager-version-invalid", detail: "packageManager.expectedVersion must be an exact version" });
    if (name && PACKAGE_MANAGER_PATTERN.test(name) && (expectedVersion === null || EXACT_VERSION_PATTERN.test(expectedVersion))) packageManager = { name, expectedVersion };
  }

  let runtime = null;
  if (!isPlainObject(value.runtime)) errors.push({ id: "runtime-invalid", detail: "runtime must be an object" });
  else {
    rejectUnknown(value.runtime, ["nodeVersionFile", "expectedVersion", "requireEngineMajorMatch"], "runtime", errors);
    const nodeVersionFile = nonEmptyString(value.runtime.nodeVersionFile);
    const expectedVersion = value.runtime.expectedVersion === undefined ? null : nonEmptyString(value.runtime.expectedVersion);
    const requireEngineMajorMatch = value.runtime.requireEngineMajorMatch;
    if (!nodeVersionFile || !safeRelativePath(nodeVersionFile)) errors.push({ id: "runtime-version-file-invalid", detail: "runtime.nodeVersionFile must be a safe relative path" });
    if (expectedVersion !== null && !EXACT_VERSION_PATTERN.test(expectedVersion)) errors.push({ id: "runtime-version-invalid", detail: "runtime.expectedVersion must be an exact version" });
    if (typeof requireEngineMajorMatch !== "boolean") errors.push({ id: "runtime-engine-policy-invalid", detail: "runtime.requireEngineMajorMatch must be boolean" });
    if (nodeVersionFile && safeRelativePath(nodeVersionFile) && (expectedVersion === null || EXACT_VERSION_PATTERN.test(expectedVersion)) && typeof requireEngineMajorMatch === "boolean") {
      runtime = { nodeVersionFile, expectedVersion, requireEngineMajorMatch };
    }
  }

  let lockfile = null;
  if (!isPlainObject(value.lockfile)) errors.push({ id: "lockfile-invalid", detail: "lockfile must be an object" });
  else {
    rejectUnknown(value.lockfile, ["path", "expectedSha256"], "lockfile", errors);
    const filePath = nonEmptyString(value.lockfile.path);
    const expectedSha256 = value.lockfile.expectedSha256 === undefined ? null : nonEmptyString(value.lockfile.expectedSha256)?.toLowerCase() ?? null;
    if (!filePath || !safeRelativePath(filePath)) errors.push({ id: "lockfile-path-invalid", detail: "lockfile.path must be a safe relative path" });
    if (expectedSha256 !== null && !SHA256_PATTERN.test(expectedSha256)) errors.push({ id: "lockfile-sha256-invalid", detail: "lockfile.expectedSha256 must be a SHA256 hex digest" });
    if (filePath && safeRelativePath(filePath) && (expectedSha256 === null || SHA256_PATTERN.test(expectedSha256))) lockfile = { path: filePath, expectedSha256 };
  }

  let frozenInstall = null;
  if (!isPlainObject(value.frozenInstall)) errors.push({ id: "frozen-install-invalid", detail: "frozenInstall must be an object" });
  else {
    rejectUnknown(value.frozenInstall, ["files", "requiredCommands"], "frozen-install", errors);
    const files = Array.isArray(value.frozenInstall.files) ? value.frozenInstall.files.map(nonEmptyString) : null;
    const commands = Array.isArray(value.frozenInstall.requiredCommands) ? value.frozenInstall.requiredCommands.map(nonEmptyString) : null;
    if (!files || files.length === 0 || files.some((item) => !item || !safeRelativePath(item))) errors.push({ id: "frozen-install-files-invalid", detail: "frozenInstall.files must contain safe relative paths" });
    if (files && new Set(files).size !== files.length) errors.push({ id: "frozen-install-files-duplicate", detail: "frozenInstall.files must be unique" });
    if (!commands || commands.length === 0 || commands.some((item) => !item || item.length > 256 || /[\r\n]/.test(item))) errors.push({ id: "frozen-install-commands-invalid", detail: "frozenInstall.requiredCommands must contain bounded single-line commands" });
    if (commands && new Set(commands).size !== commands.length) errors.push({ id: "frozen-install-commands-duplicate", detail: "frozenInstall.requiredCommands must be unique" });
    if (files && commands && files.length > 0 && commands.length > 0 && files.every((item) => item && safeRelativePath(item)) && commands.every((item) => item && item.length <= 256 && !/[\r\n]/.test(item)) && new Set(files).size === files.length && new Set(commands).size === commands.length) {
      frozenInstall = { files: /** @type {string[]} */ (files), requiredCommands: /** @type {string[]} */ (commands) };
    }
  }

  /** @type {Array<{path:string,sha256:string}>} */
  const generatedInputs = [];
  if (!Array.isArray(value.generatedInputs)) errors.push({ id: "generated-inputs-invalid", detail: "generatedInputs must be an array" });
  else if (value.generatedInputs.length > MAX_GENERATED_INPUTS) errors.push({ id: "generated-inputs-too-many", detail: `generatedInputs may contain at most ${MAX_GENERATED_INPUTS} entries` });
  else {
    const seen = new Set();
    for (const [index, raw] of value.generatedInputs.entries()) {
      if (!isPlainObject(raw)) { errors.push({ id: "generated-input-invalid", detail: `generatedInputs[${index}] must be an object` }); continue; }
      rejectUnknown(raw, ["path", "sha256"], "generated-input", errors);
      const filePath = nonEmptyString(raw.path);
      const sha256 = nonEmptyString(raw.sha256)?.toLowerCase() ?? null;
      if (!filePath || !safeRelativePath(filePath)) { errors.push({ id: "generated-input-path-invalid", detail: `generatedInputs[${index}].path must be a safe relative path` }); continue; }
      if (!sha256 || !SHA256_PATTERN.test(sha256)) { errors.push({ id: "generated-input-sha256-invalid", detail: `generatedInputs[${index}].sha256 must be a SHA256 hex digest` }); continue; }
      if (seen.has(filePath)) { errors.push({ id: "generated-input-duplicate", detail: `generatedInputs contains duplicate path ${filePath}` }); continue; }
      seen.add(filePath);
      generatedInputs.push({ path: filePath, sha256 });
    }
  }

  if (errors.length > 0 || packageManager === null || runtime === null || lockfile === null || frozenInstall === null) return { ok: false, policy: null, errors };
  return { ok: true, policy: { version: 1, packageManager, runtime, lockfile, frozenInstall, generatedInputs: generatedInputs.sort((a, b) => a.path.localeCompare(b.path)) }, errors: [] };
}

/** @param {string} filename @param {number} [maxBytes] */
function readRegularFile(filename, maxBytes = MAX_HASH_FILE_BYTES) {
  let stat;
  try { stat = fs.lstatSync(filename); }
  catch { return { ok: false, id: "file-missing", detail: "required file is missing", bytes: null }; }
  if (stat.isSymbolicLink() || !stat.isFile()) return { ok: false, id: "file-not-regular", detail: "required file must be a regular non-symlink file", bytes: null };
  if (stat.size > maxBytes) return { ok: false, id: "file-too-large", detail: `required file exceeds ${maxBytes} bytes`, bytes: null };
  try { return { ok: true, id: "file-readable", detail: "required file is readable", bytes: fs.readFileSync(filename) }; }
  catch { return { ok: false, id: "file-unreadable", detail: "required file cannot be read", bytes: null }; }
}

/** @param {Buffer} value */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {string} value */
function parsePackageManagerPin(value) {
  const match = /^([a-z0-9][a-z0-9._-]{0,63})@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(value.trim());
  return match && match[1] && match[2] ? { name: match[1], version: match[2] } : null;
}

/** @param {string} engine @param {string} exactVersion */
function engineMatchesMajor(engine, exactVersion) {
  const major = Number(exactVersion.split(".")[0]);
  if (!Number.isInteger(major)) return false;
  const normalized = engine.replace(/\s+/g, " ").trim();
  return normalized === `>=${major} <${major + 1}` || normalized === `^${major}.0.0` || normalized === `${major}.x`;
}

/** @param {string} text @param {string} command */
function activeTextContains(text, command) {
  return text.split(/\r?\n/).some((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.startsWith("#") && trimmed.includes(command);
  });
}

/** @param {string} root @param {NonNullable<ReturnType<typeof validateReproducibilityPolicy>["policy"]>} policy */
export function inspectBuildReproducibility(root, policy) {
  /** @type {Array<{id:string,status:"PASS"|"FAIL",target:string,detail:string}>} */
  const checks = [];
  const resolvedRoot = path.resolve(root);
  let rootStat;
  try { rootStat = fs.lstatSync(resolvedRoot); }
  catch { return { checks: [], summary: { pass: 0, fail: 0 }, technicalStatus: "FAIL", overallStatus: "FAIL", error: "repository cannot be read" }; }
  if (!rootStat.isDirectory()) return { checks: [], summary: { pass: 0, fail: 0 }, technicalStatus: "FAIL", overallStatus: "FAIL", error: "repository must be a directory" };

  const packageFile = readRegularFile(path.join(resolvedRoot, "package.json"), 4 * 1024 * 1024);
  let pkg = null;
  if (!packageFile.ok || !packageFile.bytes) checks.push({ id: "package-json", status: "FAIL", target: "package.json", detail: packageFile.detail });
  else {
    try { pkg = JSON.parse(packageFile.bytes.toString("utf8")); }
    catch { checks.push({ id: "package-json", status: "FAIL", target: "package.json", detail: "package.json cannot be parsed" }); }
    if (pkg !== null && !isPlainObject(pkg)) { checks.push({ id: "package-json", status: "FAIL", target: "package.json", detail: "package.json must be an object" }); pkg = null; }
  }

  if (pkg) {
    const declared = nonEmptyString(pkg.packageManager);
    const parsed = declared ? parsePackageManagerPin(declared) : null;
    if (!parsed) checks.push({ id: "package-manager-pin", status: "FAIL", target: "package.json", detail: "packageManager must pin exact name@version" });
    else if (parsed.name !== policy.packageManager.name) checks.push({ id: "package-manager-name", status: "FAIL", target: "package.json", detail: `package manager is ${parsed.name}; policy requires ${policy.packageManager.name}` });
    else if (policy.packageManager.expectedVersion !== null && parsed.version !== policy.packageManager.expectedVersion) checks.push({ id: "package-manager-version", status: "FAIL", target: "package.json", detail: `package manager version is ${parsed.version}; policy requires ${policy.packageManager.expectedVersion}` });
    else checks.push({ id: "package-manager-pin", status: "PASS", target: "package.json", detail: `package manager is pinned to ${parsed.name}@${parsed.version}` });

    const runtimeFile = readRegularFile(path.join(resolvedRoot, policy.runtime.nodeVersionFile), 1024);
    let nodeVersion = null;
    if (!runtimeFile.ok || !runtimeFile.bytes) checks.push({ id: "runtime-pin", status: "FAIL", target: policy.runtime.nodeVersionFile, detail: runtimeFile.detail });
    else {
      nodeVersion = runtimeFile.bytes.toString("utf8").trim();
      if (!EXACT_VERSION_PATTERN.test(nodeVersion)) checks.push({ id: "runtime-pin", status: "FAIL", target: policy.runtime.nodeVersionFile, detail: "runtime version file must contain one exact version" });
      else if (policy.runtime.expectedVersion !== null && nodeVersion !== policy.runtime.expectedVersion) checks.push({ id: "runtime-version", status: "FAIL", target: policy.runtime.nodeVersionFile, detail: `runtime version is ${nodeVersion}; policy requires ${policy.runtime.expectedVersion}` });
      else checks.push({ id: "runtime-pin", status: "PASS", target: policy.runtime.nodeVersionFile, detail: `runtime is pinned to ${nodeVersion}` });
    }
    if (policy.runtime.requireEngineMajorMatch) {
      const engine = isPlainObject(pkg.engines) ? nonEmptyString(pkg.engines.node) : null;
      const validNodeVersion = nodeVersion !== null && EXACT_VERSION_PATTERN.test(nodeVersion) ? nodeVersion : null;
      const matches = validNodeVersion !== null && engine !== null && engineMatchesMajor(engine, validNodeVersion);
      const major = validNodeVersion?.split(".")[0] ?? "unknown";
      checks.push({ id: "runtime-engine-major", status: matches ? "PASS" : "FAIL", target: "package.json#engines.node", detail: matches ? `engines.node matches pinned Node major ${major}` : "engines.node must explicitly match the pinned Node major" });
    }
  }

  const lock = readRegularFile(path.join(resolvedRoot, policy.lockfile.path));
  if (!lock.ok || !lock.bytes) checks.push({ id: "lockfile", status: "FAIL", target: policy.lockfile.path, detail: lock.detail });
  else if (lock.bytes.length === 0) checks.push({ id: "lockfile", status: "FAIL", target: policy.lockfile.path, detail: "lockfile must not be empty" });
  else {
    const digest = sha256(lock.bytes);
    if (policy.lockfile.expectedSha256 !== null && digest !== policy.lockfile.expectedSha256) checks.push({ id: "lockfile-hash", status: "FAIL", target: policy.lockfile.path, detail: "lockfile SHA256 does not match explicit policy binding" });
    else checks.push({ id: "lockfile", status: "PASS", target: policy.lockfile.path, detail: `lockfile is regular and SHA256=${digest}` });
  }

  /** @type {Array<{path:string,text:string}>} */
  const ciTexts = [];
  for (const relative of policy.frozenInstall.files) {
    const file = readRegularFile(path.join(resolvedRoot, relative), 4 * 1024 * 1024);
    if (!file.ok || !file.bytes) checks.push({ id: "frozen-install-file", status: "FAIL", target: relative, detail: file.detail });
    else ciTexts.push({ path: relative, text: file.bytes.toString("utf8") });
  }
  for (const command of policy.frozenInstall.requiredCommands) {
    const locations = ciTexts.filter((item) => activeTextContains(item.text, command)).map((item) => item.path);
    checks.push({ id: "frozen-install-command", status: locations.length > 0 ? "PASS" : "FAIL", target: command, detail: locations.length > 0 ? `required frozen install command appears in ${locations.join(", ")}` : "required frozen install command is absent from configured CI files" });
  }

  for (const input of policy.generatedInputs) {
    const file = readRegularFile(path.join(resolvedRoot, input.path));
    if (!file.ok || !file.bytes) checks.push({ id: "generated-input", status: "FAIL", target: input.path, detail: file.detail });
    else {
      const digest = sha256(file.bytes);
      checks.push({ id: "generated-input", status: digest === input.sha256 ? "PASS" : "FAIL", target: input.path, detail: digest === input.sha256 ? "generated input matches explicit SHA256 binding" : "generated input differs from explicit SHA256 binding" });
    }
  }

  const fail = checks.filter((check) => check.status === "FAIL").length;
  return { checks, summary: { pass: checks.length - fail, fail }, technicalStatus: "PASS", overallStatus: fail > 0 ? "FAIL" : "PASS", error: null };
}

/** @param {ReturnType<typeof inspectBuildReproducibility>} report */
export function formatBuildReproducibility(report) {
  const lines = ["Build reproducibility audit", ""];
  if (report.error) lines.push(`ERROR  ${report.error}`);
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.target}  ${check.detail}`);
  lines.push("", `Checks: ${report.summary.pass} pass, ${report.summary.fail} fail`, `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let root = null;
  let policyFile = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--root" && argument !== "--policy") return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--root") { if (root !== null) return null; root = value; }
    else { if (policyFile !== null) return null; policyFile = value; }
  }
  return root !== null && policyFile !== null ? { root, policyFile, json } : null;
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/audit-build-reproducibility.js --root <repository> --policy <policy.json> [--json]");
    return 1;
  }
  let rawPolicy;
  try { rawPolicy = JSON.parse(fs.readFileSync(options.policyFile, "utf8")); }
  catch { console.error("Build reproducibility policy cannot be read or parsed"); return 1; }
  const policyResult = validateReproducibilityPolicy(rawPolicy);
  if (!policyResult.ok || policyResult.policy === null) { console.error("Build reproducibility policy is invalid"); return 1; }
  const report = inspectBuildReproducibility(path.resolve(options.root), policyResult.policy);
  console.log(options.json ? JSON.stringify(report) : formatBuildReproducibility(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
