#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const EXACT_STRYKER_VERSION = "10.0.0";
const REPORT_SCHEMA = "1.0";
const REPORT_FILE = "reports/mutation/mutation.json";
const MAX_REPORT_BYTES = 32 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);
const MUTANT_STATUSES = [
  "Killed",
  "Survived",
  "NoCoverage",
  "CompileError",
  "RuntimeError",
  "Timeout",
  "Ignored",
  "Pending",
];

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value @param {number} [max] */
function text(value, max = 512) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized)
    ? normalized
    : null;
}

/** @param {unknown} value */
function portableId(value) {
  const normalized = text(value, 128);
  return normalized && ID.test(normalized) ? normalized : null;
}

/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max
    ? Number(value)
    : null;
}

/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      errors.push({
        id: scope + "-field-unknown",
        detail: scope + ' contains unsupported field "' + key + '"',
      });
    }
  }
}

/** @param {Buffer|string} value */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {unknown} value */
function safeSourcePath(value) {
  const normalized = text(value, 512);
  if (!normalized || path.isAbsolute(normalized) || normalized.includes("\\")) return null;
  if (/[*?[\]{}()!]/.test(normalized)) return null;
  const posix = path.posix.normalize(normalized);
  if (posix === "." || posix === ".." || posix.startsWith("../") || posix !== normalized) return null;
  return SOURCE_EXTENSIONS.has(path.posix.extname(posix)) ? posix : null;
}

/** @param {unknown} value */
function safeTestPath(value) {
  const normalized = text(value, 512);
  if (!normalized || normalized.startsWith("-") || path.isAbsolute(normalized) || normalized.includes("\\") || /[*?[\]{}()!]/.test(normalized)) return null;
  const posix = path.posix.normalize(normalized);
  if (posix === "." || posix === ".." || posix.startsWith("../") || posix !== normalized) return null;
  return SOURCE_EXTENSIONS.has(path.posix.extname(posix)) ? posix : null;
}

/** @param {unknown} value */
function safeTestCommand(value) {
  const command = text(value, 1024);
  if (!command || /[;&|><\x60$\\'"]/u.test(command)) return null;
  const parts = command.split(/\s+/).filter(Boolean);
  if (parts.length < 2 || parts.length > 64) return null;
  if (parts.some((part) => !/^[A-Za-z0-9._:/@=+-]+$/.test(part))) return null;

  const tool = parts[0] ?? "", first = parts[1] ?? "", second = parts[2] ?? "";
  if (tool === "node" && first === "--test") return parts.length >= 3 && parts.slice(2).every((part) => safeTestPath(part)) ? command : null;
  if (tool === "bun" && first === "test") return parts.length >= 3 && parts.slice(2).every((part) => safeTestPath(part)) ? command : null;
  if (tool === "bun" && first === "run" && parts.length === 3 && /^test(?::[A-Za-z0-9._-]+)*$/.test(second)) return command;
  if (["npm", "pnpm", "yarn"].includes(tool) && first === "test" && parts.length === 2) return command;
  if (["npm", "pnpm", "yarn"].includes(tool) && first === "run" && parts.length === 3 && /^test(?::[A-Za-z0-9._-]+)*$/.test(second)) return command;
  return null;
}

/** @param {unknown} value */
export function validateStrykerMutationPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */
  const errors = [];
  if (!object(value)) {
    return {
      valid: false,
      policy: null,
      errors: [{ id: "policy-invalid", detail: "Stryker mutation policy must be an object" }],
    };
  }
  rejectUnknown(
    value,
    ["version", "repository", "strykerVersion", "mutate", "testCommand", "concurrency", "timeoutMs", "maxMutants", "minimumValidMutants", "minimumMutationScore", "maxSurvived", "maxNoCoverage", "maxInvalidMutants"],
    "policy",
    errors,
  );
  if (value.version !== 1) {
    errors.push({ id: "version-invalid", detail: "policy version must be exactly 1" });
  }

  let repository = null;
  if (!object(value.repository)) {
    errors.push({ id: "repository-invalid", detail: "repository must be an object" });
  } else {
    rejectUnknown(value.repository, ["id", "commit"], "repository", errors);
    const repositoryId = portableId(value.repository.id);
    const commit = text(value.repository.commit, 128)?.toLowerCase() ?? null;
    if (!repositoryId || !commit || !isFullObjectId(commit)) {
      errors.push({
        id: "repository-fields-invalid",
        detail: "repository requires portable id and full commit",
      });
    } else {
      repository = { id: repositoryId, commit };
    }
  }

  if (value.strykerVersion !== EXACT_STRYKER_VERSION) {
    errors.push({
      id: "stryker-version-invalid",
      detail: "Stryker version must match the tested integration version exactly",
    });
  }

  const mutate = [];
  if (!Array.isArray(value.mutate) || value.mutate.length < 1 || value.mutate.length > 64) {
    errors.push({
      id: "mutate-invalid",
      detail: "mutate must be a non-empty bounded list of exact source files",
    });
  } else {
    const seen = new Set();
    for (const raw of value.mutate) {
      const sourcePath = safeSourcePath(raw);
      if (!sourcePath || seen.has(sourcePath)) {
        errors.push({
          id: "mutate-path-invalid",
          detail: "mutate contains unsafe duplicate or non-exact source path",
        });
      } else {
        seen.add(sourcePath);
        mutate.push(sourcePath);
      }
    }
  }

  const testCommand = safeTestCommand(value.testCommand);
  if (!testCommand) {
    errors.push({
      id: "test-command-invalid",
      detail: "testCommand must be a bounded test-only command without shell control syntax",
    });
  }

  const concurrency = integer(value.concurrency, 1, 8);
  const timeoutMs = integer(value.timeoutMs, 1000, 60000);
  const maxMutants = integer(value.maxMutants, 1, 100000);
  const minimumValidMutants = integer(value.minimumValidMutants, 1, 100000);
  const minimumMutationScore = integer(value.minimumMutationScore, 0, 100);
  const maxSurvived = integer(value.maxSurvived, 0, 100000);
  const maxNoCoverage = integer(value.maxNoCoverage, 0, 100000);
  const maxInvalidMutants = integer(value.maxInvalidMutants, 0, 100000);
  if ([concurrency, timeoutMs, maxMutants, minimumValidMutants, minimumMutationScore, maxSurvived, maxNoCoverage, maxInvalidMutants].some((item) => item === null)) {
    errors.push({
      id: "limits-invalid",
      detail: "mutation execution or quality limits are outside hard bounds",
    });
  }
  if (minimumValidMutants !== null && maxMutants !== null && minimumValidMutants > maxMutants) {
    errors.push({ id: "minimum-valid-mutants-invalid", detail: "minimumValidMutants cannot exceed maxMutants" });
  }

  if (
    errors.length > 0
    || !repository
    || !testCommand
    || concurrency === null
    || timeoutMs === null
    || maxMutants === null
    || minimumValidMutants === null
    || minimumMutationScore === null
    || maxSurvived === null
    || maxNoCoverage === null
    || maxInvalidMutants === null
  ) {
    return { valid: false, policy: null, errors };
  }

  return {
    valid: true,
    policy: {
      version: 1,
      repository,
      strykerVersion: EXACT_STRYKER_VERSION,
      mutate: mutate.sort(),
      testCommand,
      concurrency,
      timeoutMs,
      maxMutants,
      minimumValidMutants,
      minimumMutationScore,
      maxSurvived,
      maxNoCoverage,
      maxInvalidMutants,
    },
    errors: [],
  };
}

/** @param {unknown} rawPolicy */
export function buildStrykerMutationConfig(rawPolicy) {
  const result = validateStrykerMutationPolicy(rawPolicy);
  if (!result.valid || !result.policy) {
    throw new Error("Stryker Mutation Policy v1 is invalid");
  }
  const policy = result.policy;
  return {
    testRunner: "command",
    commandRunner: { command: policy.testCommand },
    coverageAnalysis: "off",
    mutate: policy.mutate,
    reporters: ["json"],
    jsonReporter: { fileName: REPORT_FILE },
    concurrency: policy.concurrency,
    timeoutMS: policy.timeoutMs,
    inPlace: false,
    incremental: false,
    cleanTempDir: true,
    fileLogLevel: "off",
    allowConsoleColors: false,
    thresholds: { high: policy.minimumMutationScore, low: policy.minimumMutationScore, break: null },
  };
}

/** @param {string} root @param {string} expectedCommit */
function inspectRepository(root, expectedCommit) {
  const resolved = path.resolve(root);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error("mutation evidence repository is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(resolved) !== resolved) {
    throw new Error("mutation evidence repository must be a regular non-symlink directory");
  }
  /** @param {string[]} args */
  const git = (args) => {
    const result = spawnSync("git", args, {
      cwd: resolved,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 4 * 1024 * 1024,
      env: { PATH: process.env.PATH ?? "" },
    });
    if (result.status !== 0) {
      throw new Error("read-only Git repository inspection failed");
    }
    return result.stdout.trim();
  };
  const top = path.resolve(git(["rev-parse", "--show-toplevel"]));
  if (top !== resolved) {
    throw new Error("mutation evidence repository root does not match Git top-level");
  }
  const head = git(["rev-parse", "HEAD"]).toLowerCase();
  if (head !== expectedCommit) {
    throw new Error("mutation evidence repository HEAD does not match policy commit");
  }
  if (git(["status", "--porcelain=v1", "--untracked-files=no"]) !== "") {
    throw new Error("mutation evidence repository tracked files must match policy commit exactly");
  }
  return { root: resolved, head };
}

/** @param {string} root @param {string[]} mutate */
function inspectMutationFiles(root, mutate) {
  for (const relative of mutate) {
    const absolute = path.resolve(root, ...relative.split("/"));
    if (path.relative(root, absolute).startsWith("..") || path.isAbsolute(path.relative(root, absolute))) throw new Error("mutation target escapes repository root");
    let stat; try { stat = fs.lstatSync(absolute); } catch { throw new Error("mutation target is unavailable"); }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("mutation target must be a regular non-symlink file");
    const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", relative], { cwd: root, encoding: "utf8", timeout: 10000, maxBuffer: 1024 * 1024, env: { PATH: process.env.PATH ?? "" } });
    if (tracked.status !== 0) throw new Error("mutation target must be tracked at the bound commit");
  }
}

/** @returns {Record<string,number>} */
function emptyCounts() {
  return Object.fromEntries(MUTANT_STATUSES.map((status) => [status, 0]));
}

/** @param {Record<string,number>} counts */
function summaryCounts(counts) {
  const killed = counts.Killed ?? 0, survived = counts.Survived ?? 0, noCoverage = counts.NoCoverage ?? 0;
  const compileError = counts.CompileError ?? 0, runtimeError = counts.RuntimeError ?? 0, timeout = counts.Timeout ?? 0;
  const ignored = counts.Ignored ?? 0, pending = counts.Pending ?? 0;
  const detected = killed + timeout, undetected = survived + noCoverage, valid = detected + undetected, invalid = compileError + runtimeError;
  const mutationScore = valid > 0 ? Math.round((detected / valid) * 1000000) / 10000 : null;
  return { total: Object.values(counts).reduce((sum, value) => sum + value, 0), killed, survived, noCoverage, compileError, runtimeError, timeout, ignored, pending, detected, undetected, valid, invalid, mutationScore };
}

/**
 * @param {unknown} rawReport
 * @param {any} policy
 * @param {string} collectedAt
 * @param {{sha256:string,bytes:number}} reportBinding
 */
export function adaptStrykerMutationReport(
  rawReport,
  policy,
  collectedAt,
  reportBinding,
) {
  if (!isAbsoluteIsoTimestamp(collectedAt)) {
    throw new Error("collectedAt must be an absolute ISO timestamp");
  }
  if (
    !object(rawReport)
    || rawReport.schemaVersion !== REPORT_SCHEMA
    || !object(rawReport.files)
  ) {
    throw new Error("Stryker report schema is unsupported");
  }
  if (
    !object(rawReport.framework)
    || rawReport.framework.name !== "StrykerJS"
    || rawReport.framework.version !== policy.strykerVersion
  ) {
    throw new Error("Stryker framework identity does not match policy");
  }
  if (!object(rawReport.config)) {
    throw new Error("Stryker report config is missing");
  }
  const config = rawReport.config;
  if (config.testRunner !== "command" || config.coverageAnalysis !== "off") {
    throw new Error("Stryker report did not use the bounded command-runner configuration");
  }
  if (
    !object(config.commandRunner)
    || config.commandRunner.command !== policy.testCommand
  ) {
    throw new Error("Stryker report test command does not match policy");
  }
  if (
    config.concurrency !== policy.concurrency
    || config.timeoutMS !== policy.timeoutMs
  ) {
    throw new Error("Stryker report execution limits do not match policy");
  }
  if (config.inPlace !== false || config.incremental !== false || JSON.stringify(config.reporters) !== JSON.stringify(["json"]) || !object(config.jsonReporter) || config.jsonReporter.fileName !== REPORT_FILE) {
    throw new Error("Stryker report did not use bounded non-in-place JSON reporting");
  }
  if (!object(config.thresholds) || config.thresholds.high !== policy.minimumMutationScore || config.thresholds.low !== policy.minimumMutationScore || config.thresholds.break !== null) {
    throw new Error("Stryker report thresholds do not match policy");
  }
  if (!Array.isArray(config.mutate)) {
    throw new Error("Stryker report mutate scope is missing");
  }
  const reportMutate = config.mutate.map(safeSourcePath);
  if (
    reportMutate.some((item) => !item)
    || JSON.stringify([...reportMutate].sort()) !== JSON.stringify(policy.mutate)
  ) {
    throw new Error("Stryker report mutate scope does not match policy");
  }

  const reportFiles = Object.keys(rawReport.files).sort();
  if (JSON.stringify(reportFiles) !== JSON.stringify(policy.mutate)) {
    throw new Error("Stryker report file set does not match exact mutate scope");
  }

  const globalIds = new Set();
  const totalCounts = emptyCounts();
  const files = [];
  let mutantTotal = 0;

  for (const filePath of reportFiles) {
    const sourcePath = safeSourcePath(filePath);
    const rawFile = rawReport.files[filePath];
    if (
      !sourcePath
      || !object(rawFile)
      || typeof rawFile.language !== "string"
      || !Array.isArray(rawFile.mutants)
    ) {
      throw new Error("Stryker report file entry is invalid");
    }
    const language = text(rawFile.language, 64);
    if (!language) throw new Error("Stryker report language is invalid");

    const counts = emptyCounts();
    for (const rawMutant of rawFile.mutants) {
      if (!object(rawMutant)) {
        throw new Error("Stryker mutant entry is invalid");
      }
      const mutantId = text(rawMutant.id, 128);
      const status = text(rawMutant.status, 32);
      if (
        !mutantId
        || globalIds.has(mutantId)
        || !status
        || !MUTANT_STATUSES.includes(status)
      ) {
        throw new Error("Stryker mutant identity or status is invalid");
      }
      globalIds.add(mutantId);
      counts[status] = (counts[status] ?? 0) + 1;
      mutantTotal += 1;
      if (mutantTotal > policy.maxMutants) {
        throw new Error("Stryker report exceeds policy maxMutants");
      }
    }

    files.push({
      path: sourcePath,
      language,
      ...summaryCounts(counts),
    });
    for (const status of MUTANT_STATUSES) {
      totalCounts[status] = (totalCounts[status] ?? 0) + (counts[status] ?? 0);
    }
  }

  const summary = summaryCounts(totalCounts);
  const checks = [
    { id: "minimum-valid-mutants", status: summary.valid >= policy.minimumValidMutants ? "PASS" : "FAIL", detail: `valid mutants ${summary.valid} must be >= ${policy.minimumValidMutants}` },
    { id: "minimum-mutation-score", status: summary.mutationScore !== null && summary.mutationScore >= policy.minimumMutationScore ? "PASS" : "FAIL", detail: `mutation score ${summary.mutationScore === null ? "n/a" : summary.mutationScore} must be >= ${policy.minimumMutationScore}` },
    { id: "max-survived", status: summary.survived <= policy.maxSurvived ? "PASS" : "FAIL", detail: `survived mutants ${summary.survived} must be <= ${policy.maxSurvived}` },
    { id: "max-no-coverage", status: summary.noCoverage <= policy.maxNoCoverage ? "PASS" : "FAIL", detail: `no-coverage mutants ${summary.noCoverage} must be <= ${policy.maxNoCoverage}` },
    { id: "max-invalid-mutants", status: summary.invalid <= policy.maxInvalidMutants ? "PASS" : "FAIL", detail: `invalid mutants ${summary.invalid} must be <= ${policy.maxInvalidMutants}` },
    { id: "no-pending-mutants", status: summary.pending === 0 ? "PASS" : "FAIL", detail: `pending mutants ${summary.pending} must be zero` },
  ];
  const failedChecks = checks.filter((check) => check.status === "FAIL").length;

  return {
    version: 1,
    repository: policy.repository,
    collectedAt,
    source: {
      framework: "StrykerJS",
      version: policy.strykerVersion,
      reportSchema: REPORT_SCHEMA,
      testRunner: "command",
      coverageAnalysis: "off",
      authenticated: false,
    },
    report: {
      sha256: reportBinding.sha256,
      bytes: reportBinding.bytes,
    },
    configuration: {
      mutate: policy.mutate,
      testCommandSha256: sha256(policy.testCommand),
      concurrency: policy.concurrency,
      timeoutMs: policy.timeoutMs,
      minimumValidMutants: policy.minimumValidMutants,
      minimumMutationScore: policy.minimumMutationScore,
      maxSurvived: policy.maxSurvived,
      maxNoCoverage: policy.maxNoCoverage,
      maxInvalidMutants: policy.maxInvalidMutants,
    },
    summary,
    checks,
    assessmentStatus: failedChecks === 0 ? "PASS" : "FAIL",
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    technicalStatus: "PASS",
    evidenceStatus: "VALID",
    overallStatus: failedChecks === 0 ? "PASS" : "FAIL",
    semantics: "compact Stryker mutation evidence preserves exact mutant status counts while omitting source replacement test output statusReason projectRoot and test names; checkout binding is verified at adaptation time and does not prove where the original report was generated",
  };
}

/** @param {string} filename @param {number} maxBytes */
function readRegularFile(filename, maxBytes) {
  const resolved = path.resolve(filename);
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch {
    throw new Error("mutation integration input cannot be read");
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.size < 1
    || stat.size > maxBytes
  ) {
    throw new Error("mutation integration input must be a bounded non-empty regular file");
  }
  return { resolved, bytes: fs.readFileSync(resolved) };
}

/** @param {string} filename @param {number} maxBytes */
function readJson(filename, maxBytes) {
  const file = readRegularFile(filename, maxBytes);
  try {
    return {
      ...file,
      value: JSON.parse(file.bytes.toString("utf8")),
    };
  } catch {
    throw new Error("mutation integration JSON input cannot be parsed");
  }
}

/**
 * @param {string} root
 * @param {unknown} rawPolicy
 * @param {string} reportFile
 * @param {string} collectedAt
 */
export function buildStrykerMutationEvidence(
  root,
  rawPolicy,
  reportFile,
  collectedAt,
) {
  const policyResult = validateStrykerMutationPolicy(rawPolicy);
  if (!policyResult.valid || !policyResult.policy) {
    throw new Error("Stryker Mutation Policy v1 is invalid");
  }
  const policy = policyResult.policy;
  const repository = inspectRepository(root, policy.repository.commit);
  inspectMutationFiles(repository.root, policy.mutate);
  const report = readJson(reportFile, MAX_REPORT_BYTES);
  return adaptStrykerMutationReport(
    report.value,
    policy,
    collectedAt,
    {
      sha256: sha256(report.bytes),
      bytes: report.bytes.length,
    },
  );
}

/** @param {any} evidence */
export function formatStrykerMutationEvidence(evidence) {
  const summary = evidence.summary;
  return [
    "Stryker Mutation Evidence v1",
    "",
    "Repository: " + evidence.repository.id + " @ " + evidence.repository.commit,
    "Stryker: " + evidence.source.version,
    "Mutated files: " + evidence.files.length,
    "Total mutants: " + summary.total,
    "Killed: " + summary.killed,
    "Survived: " + summary.survived,
    "No coverage: " + summary.noCoverage,
    "Compile error: " + summary.compileError,
    "Runtime error: " + summary.runtimeError,
    "Timeout: " + summary.timeout,
    "Ignored: " + summary.ignored,
    "Pending: " + summary.pending,
    "Valid mutants: " + summary.valid,
    "Invalid mutants: " + summary.invalid,
    "Mutation score: " + (summary.mutationScore === null ? "n/a" : summary.mutationScore),
    "Assessment: " + evidence.assessmentStatus,
    "Evidence: VALID",
    "Semantics: " + evidence.semantics,
  ].join("\n");
}

/** @param {string[]} argv */
function parse(argv) {
  const mode = argv[0];
  if (!["config", "evidence"].includes(mode ?? "")) return null;

  const values = new Map();
  let json = false;
  const allowed = mode === "config"
    ? new Set(["--policy"])
    : new Set(["--policy", "--report", "--repository-root", "--collected-at"]);

  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      if (json) return null;
      json = true;
      continue;
    }
    if (!allowed.has(arg ?? "") || values.has(arg)) return null;
    const next = argv[index + 1];
    if (typeof next !== "string" || next.startsWith("--")) return null;
    values.set(arg, next);
    index += 1;
  }
  for (const arg of allowed) {
    if (!values.has(arg)) return null;
  }
  return { mode, values, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) {
    console.error(
      "Usage: node scripts/stryker-mutation-integration.js config --policy <policy.json> [--json] | evidence --policy <policy.json> --report <mutation.json> --repository-root <repo> --collected-at <ISO> [--json]",
    );
    return 1;
  }

  try {
    const policy = readJson(
      options.values.get("--policy"),
      1024 * 1024,
    ).value;

    if (options.mode === "config") {
      const config = buildStrykerMutationConfig(policy);
      console.log(
        options.json
          ? JSON.stringify(config)
          : JSON.stringify(config, null, 2),
      );
      return 0;
    }

    const evidence = buildStrykerMutationEvidence(
      options.values.get("--repository-root"),
      policy,
      options.values.get("--report"),
      options.values.get("--collected-at"),
    );
    console.log(
      options.json
        ? JSON.stringify(evidence)
        : formatStrykerMutationEvidence(evidence),
    );
    return evidence.overallStatus === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "Stryker mutation integration failed",
    );
    return 1;
  }
}

if (
  import.meta.url
  === pathToFileURL(path.resolve(process.argv[1] ?? "")).href
) {
  process.exitCode = main();
}
