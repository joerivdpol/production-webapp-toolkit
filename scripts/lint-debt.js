#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const LINTABLE_EXTENSION = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/i;
const GENERATED_DIRECTORIES = new Set([
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".toolkit",
  "build",
  "coverage",
  "dist",
  "generated",
  "node_modules",
]);
const DEFAULT_POLICY = Object.freeze({
  version: 1,
  excludeFiles: [],
  excludePrefixes: [],
  includeGenerated: false,
  maxBatchFiles: 10,
  maxBatchBytes: 1024 * 1024,
  maxFileBytes: 1024 * 1024,
});
const DEFAULT_POLICY_PATH = ".toolkit/lint-debt-policy.json";
const DEFAULT_BASELINE_PATH = ".toolkit/lint-debt-baseline.json";

/** @param {string | Buffer} value */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

/** @param {Buffer} buffer */
function parseNullPaths(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

/** @param {string[]} args @param {string} cwd */
function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: null,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim()
      : String(result.stderr ?? "").trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }
  return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? "");
}

/** @param {string} root */
function assertRepositoryRoot(root) {
  const resolved = path.resolve(root);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("Lint debt target must be a regular repository directory");
  }
  const realRoot = fs.realpathSync(resolved);
  const topLevel = runGit(["rev-parse", "--show-toplevel"], resolved).toString("utf8").trim();
  if (!topLevel || fs.realpathSync(topLevel) !== realRoot) {
    throw new Error("Lint debt target must be the Git repository root");
  }
  return realRoot;
}

/** @param {string} root */
function assertCleanRepository(root) {
  const status = runGit(["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
  if (status.length !== 0) {
    throw new Error("Lint debt apply/baseline requires a clean Git worktree");
  }
}

/** @param {unknown} value @param {string} label */
function normalizeRepositoryRelative(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) {
    throw new Error(`${label} must be a repository-relative POSIX path`);
  }
  if (path.posix.isAbsolute(value)) throw new Error(`${label} must be repository-relative`);
  const normalized = path.posix.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized !== value
  ) {
    throw new Error(`${label} must stay inside the repository without normalization`);
  }
  return normalized;
}

/** @param {string} value @param {string} label */
function normalizePrefix(value, label) {
  const withoutSlash = value.endsWith("/") ? value.slice(0, -1) : value;
  return normalizeRepositoryRelative(withoutSlash, label);
}

/** @param {string} root @param {string} relative */
function resolveRepositoryFile(root, relative) {
  const safe = normalizeRepositoryRelative(relative, "Repository file path");
  const absolute = path.resolve(root, ...safe.split("/"));
  const rel = path.relative(root, absolute);
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error("Repository file path escaped root");
  }
  return absolute;
}

/** @param {string} root @param {string} filename */
function assertSafeParents(root, filename) {
  const relativeParent = path.relative(root, path.dirname(filename));
  if (!relativeParent || relativeParent === ".") return;
  let current = root;
  for (const segment of relativeParent.split(path.sep)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) continue;
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("Lint debt state path contains a non-directory or symlink parent");
    }
  }
}

/** @param {unknown} candidate */
export function validateLintDebtPolicy(candidate) {
  if (candidate === undefined || candidate === null) return { ...DEFAULT_POLICY };
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new Error("Lint debt policy must be an object");
  }
  const policyInput = /** @type {any} */ (candidate);
  const allowed = new Set([
    "version",
    "excludeFiles",
    "excludePrefixes",
    "includeGenerated",
    "maxBatchFiles",
    "maxBatchBytes",
    "maxFileBytes",
  ]);
  for (const key of Object.keys(policyInput)) {
    if (!allowed.has(key)) throw new Error(`Unknown lint debt policy key: ${key}`);
  }
  if (policyInput.version !== 1) throw new Error("Lint debt policy version must be 1");

  const excludeFiles = policyInput.excludeFiles ?? [];
  const excludePrefixes = policyInput.excludePrefixes ?? [];
  if (!Array.isArray(excludeFiles) || excludeFiles.length > 500) {
    throw new Error("excludeFiles must contain at most 500 paths");
  }
  if (!Array.isArray(excludePrefixes) || excludePrefixes.length > 200) {
    throw new Error("excludePrefixes must contain at most 200 paths");
  }
  const normalizedFiles = excludeFiles.map((value, index) =>
    normalizeRepositoryRelative(value, `excludeFiles[${index}]`),
  );
  const normalizedPrefixes = excludePrefixes.map((value, index) =>
    normalizePrefix(value, `excludePrefixes[${index}]`),
  );

  const includeGenerated = policyInput.includeGenerated ?? false;
  if (typeof includeGenerated !== "boolean") throw new Error("includeGenerated must be boolean");

  /**
   * @param {unknown} value
   * @param {number} fallback
   * @param {number} minimum
   * @param {number} maximum
   * @param {string} label
   */
  const boundedInteger = (value, fallback, minimum, maximum, label) => {
    const actual = value ?? fallback;
    if (
      typeof actual !== "number" ||
      !Number.isInteger(actual) ||
      actual < minimum ||
      actual > maximum
    ) {
      throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
    }
    return actual;
  };

  return {
    version: 1,
    excludeFiles: [...new Set(normalizedFiles)].sort(),
    excludePrefixes: [...new Set(normalizedPrefixes)].sort(),
    includeGenerated,
    maxBatchFiles: boundedInteger(policyInput.maxBatchFiles, 10, 1, 100, "maxBatchFiles"),
    maxBatchBytes: boundedInteger(
      policyInput.maxBatchBytes,
      1024 * 1024,
      1024,
      10 * 1024 * 1024,
      "maxBatchBytes",
    ),
    maxFileBytes: boundedInteger(
      policyInput.maxFileBytes,
      1024 * 1024,
      1024,
      5 * 1024 * 1024,
      "maxFileBytes",
    ),
  };
}

/** @param {string} relative */
export function isGeneratedLintPath(relative) {
  const segments = relative.split("/");
  if (segments.some((segment) => GENERATED_DIRECTORIES.has(segment))) return true;
  const basename = segments.at(-1) ?? "";
  return (
    basename.includes(".gen.") ||
    basename.includes(".generated.") ||
    basename.startsWith("generated.")
  );
}

/** @param {string} relative @param {ReturnType<typeof validateLintDebtPolicy>} policy */
function isPolicyExcluded(relative, policy) {
  if (policy.excludeFiles.includes(relative)) return true;
  return policy.excludePrefixes.some(
    (prefix) => relative === prefix || relative.startsWith(`${prefix}/`),
  );
}

/** @param {string} root @param {string | undefined} requested */
export function loadLintDebtPolicy(root, requested) {
  const relative = requested ?? DEFAULT_POLICY_PATH;
  const filename = resolveRepositoryFile(root, relative);
  if (!fs.existsSync(filename)) {
    if (requested) throw new Error(`Lint debt policy not found: ${relative}`);
    return { ...DEFAULT_POLICY };
  }
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
    throw new Error("Lint debt policy must be a regular JSON file no larger than 64 KiB");
  }
  return validateLintDebtPolicy(JSON.parse(fs.readFileSync(filename, "utf8")));
}

/** @param {string} root @param {ReturnType<typeof validateLintDebtPolicy>} policy */
export function collectTrackedLintFiles(root, policy) {
  const tracked = parseNullPaths(runGit(["ls-files", "-z"], root));
  const files = [];
  let excludedGenerated = 0;
  let excludedPolicy = 0;

  for (const relative of tracked) {
    if (!LINTABLE_EXTENSION.test(relative)) continue;
    if (!policy.includeGenerated && isGeneratedLintPath(relative)) {
      excludedGenerated += 1;
      continue;
    }
    if (isPolicyExcluded(relative, policy)) {
      excludedPolicy += 1;
      continue;
    }
    const filename = resolveRepositoryFile(root, relative);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Tracked lint target is not a regular file: ${relative}`);
    }
    if (stat.size > policy.maxFileBytes) {
      throw new Error(
        `Tracked lint target exceeds maxFileBytes and must be explicitly excluded: ${relative}`,
      );
    }
    files.push(relative);
  }

  return {
    files: files.sort(),
    selection: {
      trackedLintable: files.length + excludedGenerated + excludedPolicy,
      linted: files.length,
      excludedGenerated,
      excludedPolicy,
    },
  };
}

/** @param {string} root */
async function resolveTargetESLint(root) {
  const packageJson = path.join(root, "package.json");
  if (!fs.existsSync(packageJson)) throw new Error("Target repository has no package.json");
  const targetRequire = createRequire(pathToFileURL(packageJson));
  let entry;
  let manifest;
  try {
    entry = targetRequire.resolve("eslint");
    manifest = targetRequire.resolve("eslint/package.json");
  } catch {
    throw new Error("Target repository must have ESLint installed locally");
  }
  const eslintModule = await import(pathToFileURL(entry).href);
  const ESLintClass = eslintModule.ESLint ?? eslintModule.default?.ESLint;
  if (typeof ESLintClass !== "function") throw new Error("Installed ESLint does not expose ESLint class");
  const metadata = JSON.parse(fs.readFileSync(manifest, "utf8"));
  return { ESLintClass, version: String(metadata.version ?? "unknown") };
}

/** @param {string} root @param {string[]} files @param {boolean} fixLayout */
async function runESLint(root, files, fixLayout) {
  const { ESLintClass, version } = await resolveTargetESLint(root);
  if (files.length === 0) return { results: [], version, ESLintClass };
  /** @type {any} */
  const options = {
    cwd: root,
    errorOnUnmatchedPattern: false,
    warnIgnored: false,
    fix: fixLayout,
  };
  if (fixLayout) options.fixTypes = ["layout"];
  const eslint = new ESLintClass(options);
  const results = await eslint.lintFiles(files);
  return { results, version, ESLintClass };
}

/** @param {any[]} results @param {string} root */
function issueGroupsFromResults(results, root) {
  const groups = new Map();
  for (const result of results) {
    const relative = path.relative(root, result.filePath).split(path.sep).join("/");
    for (const message of result.messages ?? []) {
      if (![1, 2].includes(message.severity)) continue;
      const ruleId = message.ruleId ?? "fatal";
      const messageId = message.messageId ?? null;
      const messageHash = messageId === null ? sha256(String(message.message ?? "")) : null;
      const messageIdentity = messageId ?? messageHash;
      const identity = JSON.stringify([relative, ruleId, messageIdentity, message.severity]);
      const signature = sha256(identity);
      const current = groups.get(signature);
      if (current) {
        current.count += 1;
      } else {
        groups.set(signature, {
          signature,
          file: relative,
          ruleId,
          messageId,
          severity: message.severity,
          messageHash,
          count: 1,
        });
      }
    }
  }
  return [...groups.values()].sort((a, b) =>
    [a.file, a.ruleId, a.messageId ?? "", a.messageHash ?? "", a.severity]
      .join("\0")
      .localeCompare(
        [b.file, b.ruleId, b.messageId ?? "", b.messageHash ?? "", b.severity].join("\0"),
      ),
  );
}

/** @param {any[]} results */
function summarizeResults(results) {
  let errors = 0;
  let warnings = 0;
  let fixable = 0;
  let filesWithIssues = 0;
  for (const result of results) {
    const active = (result.messages ?? []).filter(
      (/** @type {any} */ message) => [1, 2].includes(message.severity),
    );
    if (active.length > 0) filesWithIssues += 1;
    for (const message of active) {
      if (message.severity === 2) errors += 1;
      else warnings += 1;
      if (message.fix) fixable += 1;
    }
  }
  return {
    issues: errors + warnings,
    errors,
    warnings,
    fixable,
    filesWithIssues,
  };
}

/** @param {string} root @param {ReturnType<typeof validateLintDebtPolicy>} policy */
async function collectLintState(root, policy) {
  const selection = collectTrackedLintFiles(root, policy);
  const lint = await runESLint(root, selection.files, false);
  return {
    root,
    files: selection.files,
    selection: selection.selection,
    eslintVersion: lint.version,
    results: lint.results,
    issueGroups: issueGroupsFromResults(lint.results, root),
    summary: summarizeResults(lint.results),
  };
}

/** @param {ReturnType<typeof summarizeResults>} summary */
function publicSummary(summary) {
  return { ...summary };
}

/** @param {string} target @param {{ policyPath?: string }} options */
export async function scanLintDebt(target, options = {}) {
  const root = assertRepositoryRoot(target);
  const policy = loadLintDebtPolicy(root, options.policyPath);
  const state = await collectLintState(root, policy);
  return {
    version: 1,
    root,
    engine: { name: "eslint", version: state.eslintVersion },
    fixBoundary: "layout-only",
    policy,
    policySha256: sha256(JSON.stringify(policy)),
    selection: state.selection,
    summary: publicSummary(state.summary),
    issueGroups: state.issueGroups,
  };
}

/** @param {{ eslintVersion:string, selection:any, summary:any, issueGroups:any[] }} state */
function baselineFromState(state) {
  return {
    version: 1,
    engine: { name: "eslint", version: state.eslintVersion },
    fixBoundary: "layout-only",
    selection: state.selection,
    summary: publicSummary(state.summary),
    issueGroups: state.issueGroups,
  };
}

/** @param {Awaited<ReturnType<typeof scanLintDebt>>} scan */
export function buildLintDebtBaseline(scan) {
  return {
    version: 1,
    engine: scan.engine,
    fixBoundary: scan.fixBoundary,
    policy: scan.policy,
    policySha256: scan.policySha256,
    selection: scan.selection,
    summary: scan.summary,
    issueGroups: scan.issueGroups,
  };
}

/** @param {Awaited<ReturnType<typeof scanLintDebt>>} report @param {any} baseline */
export function assertLintDebtBaselineCompatible(report, baseline) {
  if (!baseline || baseline.version !== 1) throw new Error("Lint debt baseline must use version 1");
  if (
    baseline.engine?.name !== report.engine.name ||
    baseline.engine?.version !== report.engine.version
  ) {
    throw new Error("Lint debt baseline ESLint version differs; review and regenerate the baseline");
  }
  if (baseline.fixBoundary !== "layout-only") {
    throw new Error("Lint debt baseline uses an unsupported fix boundary");
  }
  if (!baseline.policySha256 || baseline.policySha256 !== report.policySha256) {
    throw new Error("Lint debt policy changed; review the exclusions and regenerate the baseline");
  }
}

/** @param {any[]} currentGroups @param {{ version:number, issueGroups:any[] }} baseline */
export function compareLintDebt(currentGroups, baseline) {
  if (!baseline || baseline.version !== 1 || !Array.isArray(baseline.issueGroups)) {
    throw new Error("Lint debt baseline must use version 1");
  }
  const current = new Map(currentGroups.map((group) => [group.signature, group]));
  const previous = new Map(baseline.issueGroups.map((group) => [group.signature, group]));
  const added = [];
  const improved = [];

  for (const [signature, group] of current) {
    const prior = previous.get(signature);
    const delta = group.count - (prior?.count ?? 0);
    if (delta > 0) added.push({ ...group, count: delta });
  }
  for (const [signature, group] of previous) {
    const now = current.get(signature);
    const delta = group.count - (now?.count ?? 0);
    if (delta > 0) improved.push({ ...group, count: delta });
  }
  /** @param {any[]} groups */
  const count = (groups) =>
    groups.reduce(
      (/** @type {number} */ sum, /** @type {any} */ group) => sum + group.count,
      0,
    );
  return {
    newDebt: count(added),
    improvedDebt: count(improved),
    added,
    improved,
  };
}

/** @param {string} root @param {string} relative @param {any} value */
function writeRepositoryJson(root, relative, value) {
  const filename = resolveRepositoryFile(root, relative);
  assertSafeParents(root, filename);
  if (fs.existsSync(filename)) {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("Lint debt state destination must be a regular file");
    }
  } else {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    assertSafeParents(root, filename);
  }
  const temp = `${filename}.tmp-${process.pid}`;
  if (fs.existsSync(temp)) throw new Error("Lint debt temporary state path already exists");
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  fs.renameSync(temp, filename);
  return filename;
}

/** @param {string} root @param {string} relative */
function readRepositoryJson(root, relative) {
  const filename = resolveRepositoryFile(root, relative);
  const stat = fs.lstatSync(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5 * 1024 * 1024) {
    throw new Error("Lint debt baseline must be a regular JSON file no larger than 5 MiB");
  }
  return JSON.parse(fs.readFileSync(filename, "utf8"));
}

/** @param {any[]} groups */
function issueCountsByFile(groups) {
  const counts = new Map();
  for (const group of groups) counts.set(group.file, (counts.get(group.file) ?? 0) + group.count);
  return counts;
}

/** @param {string} root @param {ReturnType<typeof validateLintDebtPolicy>} policy */
async function buildLintDebtPlanState(root, policy) {
  const before = await collectLintState(root, policy);
  const preview = await runESLint(root, before.files, true);
  const beforeCounts = issueCountsByFile(before.issueGroups);
  const afterGroups = issueGroupsFromResults(preview.results, root);
  const afterCounts = issueCountsByFile(afterGroups);
  const candidates = [];

  for (const result of preview.results) {
    if (typeof result.output !== "string") continue;
    const relative = path.relative(root, result.filePath).split(path.sep).join("/");
    const resolvedProblems = Math.max(
      0,
      (beforeCounts.get(relative) ?? 0) - (afterCounts.get(relative) ?? 0),
    );
    if (resolvedProblems <= 0) continue;
    const outputBytes = Buffer.byteLength(result.output);
    if (outputBytes > policy.maxFileBytes) continue;
    candidates.push({
      file: relative,
      resolvedProblems,
      outputBytes,
      outputSha256: sha256(result.output),
      output: result.output,
    });
  }

  candidates.sort(
    (a, b) => b.resolvedProblems - a.resolvedProblems || a.file.localeCompare(b.file),
  );
  const selected = [];
  let selectedBytes = 0;
  for (const candidate of candidates) {
    if (selected.length >= policy.maxBatchFiles) break;
    if (selectedBytes + candidate.outputBytes > policy.maxBatchBytes) continue;
    selected.push(candidate);
    selectedBytes += candidate.outputBytes;
  }

  return {
    root,
    policy,
    before,
    candidates,
    selected,
    selectedBytes,
  };
}

/** @param {string} target @param {{ policyPath?: string }} options */
export async function planLintDebtRemediation(target, options = {}) {
  const root = assertRepositoryRoot(target);
  const policy = loadLintDebtPolicy(root, options.policyPath);
  const state = await buildLintDebtPlanState(root, policy);
  const stripOutput = (/** @type {any} */ candidate) => {
    const { output, ...rest } = candidate;
    void output;
    return rest;
  };
  return {
    version: 1,
    root,
    mode: "layout-only",
    automatic: true,
    risk: "LOW_LAYOUT_ONLY",
    requiresCleanWorktreeForApply: true,
    policy,
    before: publicSummary(state.before.summary),
    candidates: state.candidates.map(stripOutput),
    selected: state.selected.map(stripOutput),
    summary: {
      candidateFiles: state.candidates.length,
      selectedFiles: state.selected.length,
      selectedBytes: state.selectedBytes,
      plannedResolvedProblems: state.selected.reduce(
        (sum, candidate) => sum + candidate.resolvedProblems,
        0,
      ),
    },
  };
}

/** @param {string} root @param {string[]} expected */
function assertOnlyExpectedDiffs(root, expected) {
  const actual = parseNullPaths(runGit(["diff", "--name-only", "-z"], root)).sort();
  const allowed = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(allowed)) {
    throw new Error(
      `Lint debt apply changed unexpected paths: ${actual.filter((item) => !allowed.includes(item)).join(", ") || "(set mismatch)"}`,
    );
  }
}

/** @param {string} target @param {{ policyPath?: string }} options */
export async function applyLintDebtRemediation(target, options = {}) {
  const root = assertRepositoryRoot(target);
  assertCleanRepository(root);
  const policy = loadLintDebtPolicy(root, options.policyPath);
  const state = await buildLintDebtPlanState(root, policy);
  if (state.selected.length === 0) {
    return {
      version: 1,
      root,
      mode: "layout-only",
      applied: false,
      files: [],
      before: publicSummary(state.before.summary),
      after: publicSummary(state.before.summary),
      resolvedProblems: 0,
      newDebt: 0,
    };
  }

  const originals = new Map();
  for (const candidate of state.selected) {
    const filename = resolveRepositoryFile(root, candidate.file);
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Lint debt apply refuses non-regular file: ${candidate.file}`);
    }
    originals.set(candidate.file, fs.readFileSync(filename));
  }

  const rollback = () => {
    for (const [relative, bytes] of originals) {
      fs.writeFileSync(resolveRepositoryFile(root, relative), bytes);
    }
  };

  try {
    for (const candidate of state.selected) {
      const filename = resolveRepositoryFile(root, candidate.file);
      fs.writeFileSync(filename, candidate.output);
      if (sha256(fs.readFileSync(filename)) !== candidate.outputSha256) {
        throw new Error(`Lint debt apply verification failed for ${candidate.file}`);
      }
    }

    assertOnlyExpectedDiffs(
      root,
      state.selected.map((candidate) => candidate.file),
    );
    runGit(["diff", "--check"], root);

    const after = await collectLintState(root, policy);
    const comparison = compareLintDebt(after.issueGroups, baselineFromState(state.before));
    if (comparison.newDebt !== 0) {
      throw new Error("Lint debt apply introduced new lint debt");
    }
    if (after.summary.issues >= state.before.summary.issues) {
      throw new Error("Lint debt apply did not reduce the historical lint issue count");
    }

    return {
      version: 1,
      root,
      mode: "layout-only",
      applied: true,
      files: state.selected.map((candidate) => candidate.file),
      before: publicSummary(state.before.summary),
      after: publicSummary(after.summary),
      resolvedProblems: state.before.summary.issues - after.summary.issues,
      newDebt: comparison.newDebt,
    };
  } catch (error) {
    rollback();
    throw error;
  }
}

/** @param {string[]} argv */
function parseCli(argv) {
  const modes = new Set(["scan", "baseline", "check", "plan", "apply"]);
  const mode = argv[0];
  if (mode === undefined || !modes.has(mode)) return null;
  let target;
  let json = false;
  let policyPath;
  let baselinePath = DEFAULT_BASELINE_PATH;
  let outputPath = DEFAULT_BASELINE_PATH;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === undefined) return null;
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (["--policy", "--baseline", "--output"].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) return null;
      if (argument === "--policy") policyPath = value;
      if (argument === "--baseline") baselinePath = value;
      if (argument === "--output") outputPath = value;
      index += 1;
      continue;
    }
    if (argument.startsWith("--") || target !== undefined) return null;
    target = argument;
  }
  return {
    mode,
    target: target ?? process.cwd(),
    json,
    policyPath,
    baselinePath,
    outputPath,
  };
}

/** @param {any} report */
function formatScan(report) {
  return [
    `Lint debt: ${report.root}`,
    `ESLint: ${report.engine.version}  boundary=layout-only`,
    `Files: ${report.selection.linted} linted, ${report.selection.excludedGenerated} generated excluded, ${report.selection.excludedPolicy} policy excluded`,
    `Issues: ${report.summary.issues} (${report.summary.errors} errors, ${report.summary.warnings} warnings, ${report.summary.fixable} fixable)`,
  ].join("\n");
}

/** @param {any} plan */
function formatPlan(plan) {
  return [
    `Lint debt remediation plan: ${plan.root}`,
    "Boundary: ESLint layout fixes only; no problem/suggestion/directive fixes",
    `Candidates: ${plan.summary.candidateFiles} files`,
    `Selected batch: ${plan.summary.selectedFiles} files / ${plan.summary.selectedBytes} bytes`,
    `Planned resolved problems: ${plan.summary.plannedResolvedProblems}`,
    ...plan.selected.map(
      (/** @type {any} */ item) => `  ${item.file}: resolve ${item.resolvedProblems}`,
    ),
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCli(argv);
  if (!parsed) {
    console.error(
      "Usage: node scripts/lint-debt.js <scan|baseline|check|plan|apply> [repository] [--policy <path>] [--baseline <path>] [--output <path>] [--json]",
    );
    return 1;
  }

  try {
    const root = assertRepositoryRoot(parsed.target);
    const policyOptions =
      parsed.policyPath === undefined ? {} : { policyPath: parsed.policyPath };

    if (parsed.mode === "scan") {
      const report = await scanLintDebt(root, policyOptions);
      console.log(parsed.json ? JSON.stringify(report) : formatScan(report));
      return 0;
    }

    if (parsed.mode === "baseline") {
      assertCleanRepository(root);
      const report = await scanLintDebt(root, policyOptions);
      const baseline = buildLintDebtBaseline(report);
      const filename = writeRepositoryJson(root, parsed.outputPath, baseline);
      const result = {
        version: 1,
        root,
        baseline: path.relative(root, filename).split(path.sep).join("/"),
        summary: baseline.summary,
      };
      console.log(
        parsed.json
          ? JSON.stringify(result)
          : `Wrote lint debt baseline ${result.baseline} with ${baseline.summary.issues} historical issue(s).`,
      );
      return 0;
    }

    if (parsed.mode === "check") {
      const report = await scanLintDebt(root, policyOptions);
      const baseline = readRepositoryJson(root, parsed.baselinePath);
      assertLintDebtBaselineCompatible(report, baseline);
      const comparison = compareLintDebt(report.issueGroups, baseline);
      const result = {
        version: 1,
        root,
        current: report.summary,
        newDebt: comparison.newDebt,
        improvedDebt: comparison.improvedDebt,
        added: comparison.added,
        improved: comparison.improved,
        overallStatus: comparison.newDebt === 0 ? "PASS" : "FAIL",
      };
      console.log(
        parsed.json
          ? JSON.stringify(result)
          : [
              `Lint debt check: ${result.overallStatus}`,
              `Current historical issues: ${result.current.issues}`,
              `New debt: ${result.newDebt}`,
              `Improved debt: ${result.improvedDebt}`,
            ].join("\n"),
      );
      return comparison.newDebt === 0 ? 0 : 1;
    }

    if (parsed.mode === "plan") {
      const plan = await planLintDebtRemediation(root, policyOptions);
      console.log(parsed.json ? JSON.stringify(plan) : formatPlan(plan));
      return 0;
    }

    const result = await applyLintDebtRemediation(root, policyOptions);
    console.log(
      parsed.json
        ? JSON.stringify(result)
        : [
            `Lint debt apply: ${result.applied ? "APPLIED" : "NOOP"}`,
            `Files: ${result.files.length}`,
            `Issues: ${result.before.issues} -> ${result.after.issues}`,
            `Resolved: ${result.resolvedProblems}`,
            `New debt: ${result.newDebt}`,
          ].join("\n"),
    );
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Lint debt operation failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = await main();
}
