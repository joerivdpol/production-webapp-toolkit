#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEFAULT_REPOSITORIES = [
  "thehappinezzhills.com",
  "travelwithhappinezz",
  "segara-rasa",
  "karimunjawa-boat-ticket",
  "happinezz-pulse",
];

const DISPLAY_NAMES = new Map([
  ["thehappinezzhills.com", "The Happinezz Hills"],
  ["travelwithhappinezz", "Travel with Happinezz"],
  ["segara-rasa", "Segara Rasa"],
  ["karimunjawa-boat-ticket", "Karimunjawa Boat Ticket"],
  ["happinezz-pulse", "Happinezz Pulse"],
]);
const SCRIPT_DIRECTORY = dirname(fileURLToPath(import.meta.url));
const DEFAULT_AUDIT_SCRIPT = join(SCRIPT_DIRECTORY, "audit-repository.js");

/** @typedef {{repository: string, path: string, commit: string|null, totalScore: number, totalChecks: number, coreScore: number, coreChecks: number, passed: boolean, errors: string[]}} RepositoryResult */
/** @typedef {{status: number|null, stdout: string, stderr: string, error?: Error}} CommandResult */

/** @param {string} command @param {string[]} args @param {string=} cwd @returns {CommandResult} */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { status: result.status, stdout: String(result.stdout ?? ""), stderr: String(result.stderr ?? ""), ...(result.error ? { error: result.error } : {}) };
}

/** @param {string} worktree @param {string} auditScript */
function runAuditSubprocess(worktree, auditScript) {
  return run(process.execPath, [auditScript, worktree, "--json"]);
}

/** @param {CommandResult} result @param {string} action */
function commandError(result, action) {
  const detail = result.error?.message || result.stderr?.trim() || result.stdout?.trim();
  return detail ? `${action}: ${detail}` : `${action} (exit ${result.status ?? "unknown"})`;
}

/** @param {string} name */
function displayName(name) {
  if (DISPLAY_NAMES.has(name)) return DISPLAY_NAMES.get(name) ?? name;
  return basename(name).replace(/[._-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  /** @type {{projectsRoot: string, repositories: string[], fetch: boolean, json: boolean}} */
  const options = { projectsRoot: resolve(homedir(), "projects"), repositories: [], fetch: true, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--no-fetch") options.fetch = false;
    else if (argument === "--projects-root") {
      const value = argv[++index];
      if (!value) throw new Error("--projects-root requires a path");
      options.projectsRoot = resolve(value);
    } else if (argument === "--repo") {
      const value = argv[++index];
      if (!value) throw new Error("--repo requires a repository name or path");
      options.repositories.push(...value.split(",").map((item) => item.trim()).filter(Boolean));
    } else throw new Error(`Unknown option: ${argument}`);
  }
  if (options.repositories.length === 0) options.repositories = [...DEFAULT_REPOSITORIES];
  return options;
}

/** @param {string} projectsRoot @param {string} repository */
function repositoryPath(projectsRoot, repository) {
  return isAbsolute(repository) ? resolve(repository) : resolve(projectsRoot, repository);
}

/**
 * @param {string} repository
 * @param {{projectsRoot: string, fetch: boolean, temporaryRoot: string, auditScript?: string, auditRunner?: (worktree: string, auditScript: string) => CommandResult}} options
 * @returns {Promise<RepositoryResult>}
 */
export async function auditRepository(repository, options) {
  const path = repositoryPath(options.projectsRoot, repository);
  /** @type {RepositoryResult} */
  const output = { repository, path, commit: null, totalScore: 0, totalChecks: 0, coreScore: 0, coreChecks: 0, passed: false, errors: [] };
  if (!existsSync(path)) {
    output.errors.push("Repository is missing");
    return output;
  }

  if (options.fetch) {
    const fetched = run("git", ["-C", path, "fetch", "origin"]);
    if (fetched.status !== 0) {
      output.errors.push(commandError(fetched, "Fetch failed"));
      return output;
    }
  }

  const revision = run("git", ["-C", path, "rev-parse", "--verify", "origin/main^{commit}"]);
  if (revision.status !== 0) {
    output.errors.push(commandError(revision, "origin/main is missing"));
    return output;
  }
  output.commit = revision.stdout.trim();

  const worktree = join(options.temporaryRoot, `${basename(path)}-${output.commit.slice(0, 12)}`);
  let worktreeCreated = false;
  try {
    const added = run("git", ["-C", path, "worktree", "add", "--detach", worktree, output.commit]);
    if (added.status !== 0) {
      worktreeCreated = existsSync(worktree);
      output.errors.push(commandError(added, "Temporary worktree creation failed"));
      return output;
    }
    worktreeCreated = true;

    const audited = (options.auditRunner ?? runAuditSubprocess)(worktree, options.auditScript ?? DEFAULT_AUDIT_SCRIPT);
    let report;
    try { report = JSON.parse(audited.stdout); } catch { /* handled below */ }
    if (!report || typeof report !== "object" || !Array.isArray(report.checks)) {
      output.errors.push(commandError(audited, "Audit execution failed"));
      return output;
    }
    output.totalScore = report.passed;
    output.totalChecks = report.checks.length;
    output.coreScore = report.requiredPassed;
    output.coreChecks = report.requiredTotal;
    output.passed = report.corePassed === true && audited.status === 0;
    const expectedStatus = report.corePassed === true ? 0 : 1;
    if (audited.status !== expectedStatus) output.errors.push(commandError(audited, "Audit execution failed"));
    return output;
  } finally {
    if (worktreeCreated) {
      const removed = run("git", ["-C", path, "worktree", "remove", worktree]);
      if (removed.status !== 0) {
        // This path is beneath the unique directory created by this process.
        const forced = run("git", ["-C", path, "worktree", "remove", "--force", worktree]);
        if (forced.status !== 0) output.errors.push(commandError(forced, "Temporary worktree cleanup failed"));
      }
    }
  }
}

/** @param {Array<Pick<RepositoryResult, "totalScore"|"totalChecks"|"coreScore"|"coreChecks"|"passed"|"errors">>} repositories */
export function aggregateResults(repositories) {
  return {
    totalScore: repositories.reduce((sum, item) => sum + item.totalScore, 0),
    totalChecks: repositories.reduce((sum, item) => sum + item.totalChecks, 0),
    coreScore: repositories.reduce((sum, item) => sum + item.coreScore, 0),
    coreChecks: repositories.reduce((sum, item) => sum + item.coreChecks, 0),
    passed: repositories.length > 0 && repositories.every((item) => item.passed && item.errors.length === 0),
  };
}

/** @param {RepositoryResult[]} repositories @param {ReturnType<typeof aggregateResults>} aggregate */
export function formatSummary(repositories, aggregate) {
  const width = Math.max("Repository".length, ...repositories.map((item) => displayName(item.repository).length));
  const lines = repositories.map((item) => {
    const score = item.totalChecks ? `${item.totalScore}/${item.totalChecks}` : "-";
    const core = item.coreChecks ? `${item.coreScore}/${item.coreChecks}` : "-";
    const state = item.errors.length ? "ERROR" : item.passed ? "PASS" : "FAIL";
    return `${displayName(item.repository).padEnd(width)}  ${score.padEnd(5)}  core ${core.padEnd(5)}  ${state}`;
  });
  for (const item of repositories) for (const error of item.errors) lines.push(`${displayName(item.repository)}: ${error}`);
  return [...lines, "", `${"TOTAL".padEnd(width)}  ${aggregate.totalScore}/${aggregate.totalChecks}`, `${"CORE".padEnd(width)}  ${aggregate.coreScore}/${aggregate.coreChecks}`, `${"RESULT".padEnd(width)}  ${aggregate.passed ? "PASS" : "FAIL"}`].join("\n");
}

/** @param {string[]} argv @param {{auditScript?: string, auditRunner?: (worktree: string, auditScript: string) => CommandResult}=} dependencies */
export async function runAll(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArguments(argv);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "production-webapp-toolkit-audit-"));
  try {
    const repositories = [];
    for (const repository of options.repositories) repositories.push(await auditRepository(repository, {
      ...options,
      temporaryRoot,
      ...(dependencies.auditScript ? { auditScript: dependencies.auditScript } : {}),
      ...(dependencies.auditRunner ? { auditRunner: dependencies.auditRunner } : {}),
    }));
    const aggregate = aggregateResults(repositories);
    return { options, repositories, aggregate };
  } finally {
    const normalized = resolve(temporaryRoot);
    const expectedPrefix = resolve(tmpdir()) + sep + "production-webapp-toolkit-audit-";
    if (normalized.startsWith(expectedPrefix)) await rm(normalized, { recursive: true, force: true });
  }
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const result = await runAll(argv);
    console.log(result.options.json ? JSON.stringify({ repositories: result.repositories, aggregate: result.aggregate }, null, 2) : formatSummary(result.repositories, result.aggregate));
    return result.aggregate.passed ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) process.exitCode = await main();
