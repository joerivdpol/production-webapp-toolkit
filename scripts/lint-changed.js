#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const LINTABLE_EXTENSION = /\.(?:js|jsx|ts|tsx)$/i;

/** Parse `git diff --name-status -z` output into non-deleted destination paths. */
/** @param {Buffer} buffer */
export function parseNameStatus(buffer) {
  const fields = buffer.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();

  const paths = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) throw new Error("Malformed Git name-status output: missing status");
    const code = status[0];
    if (!code) throw new Error("Malformed Git name-status output: empty status");

    if (code === "R" || code === "C") {
      const oldPath = fields[index++];
      const newPath = fields[index++];
      if (oldPath === undefined || newPath === undefined) {
        throw new Error(`Malformed Git name-status output for ${status}`);
      }
      paths.push(newPath);
      continue;
    }

    const path = fields[index++];
    if (path === undefined) throw new Error(`Malformed Git name-status output for ${status}`);
    if (code !== "D" && ["A", "M", "T", "U"].includes(code)) paths.push(path);
  }
  return paths;
}

/** Parse NUL-delimited paths, filtering the trailing delimiter. */
/** @param {Buffer} buffer */
export function parseNullPaths(buffer) {
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

/** Select unique lintable paths while preserving their first-seen order. */
/** @param {...string[]} pathGroups */
export function selectLintablePaths(...pathGroups) {
  return [...new Set(pathGroups.flat())].filter((path) => LINTABLE_EXTENSION.test(path));
}

/** @param {string[]} args @param {{ cwd?: string, stdio?: import("node:child_process").StdioOptions }} options @returns {Buffer} */
function runGit(args, options = {}) {
  const result = spawnSync("git", args, {
    cwd: options.cwd,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = Buffer.isBuffer(result.stderr)
      ? result.stderr.toString("utf8").trim()
      : String(result.stderr ?? "").trim();
    throw new Error(`git ${args[0]} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}

/** @param {string | undefined} requested @param {string} cwd */
export function resolveBaseRevision(requested, cwd = process.cwd()) {
  const candidates = [requested, process.env.LINT_CHANGED_BASE, "origin/main", "main"].filter(Boolean);
  for (const candidate of candidates) {
    const result = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], {
      cwd,
      stdio: "ignore",
    });
    if (result.status === 0) return candidate;
  }
  throw new Error(`No valid base revision found (tried: ${candidates.join(", ")})`);
}

/** @param {string} base @param {string} cwd */
export function collectChangedFiles(base, cwd = process.cwd()) {
  const committed = parseNameStatus(
    runGit(["diff", "--name-status", "-z", "--find-renames", "--find-copies", `${base}...HEAD`], { cwd }),
  );
  const workingTree = parseNameStatus(
    runGit(["diff", "--name-status", "-z", "--find-renames", "--find-copies", "HEAD"], { cwd }),
  );
  const untracked = parseNullPaths(runGit(["ls-files", "--others", "--exclude-standard", "-z"], { cwd }));
  return selectLintablePaths(committed, workingTree, untracked);
}

export function main(argv = process.argv.slice(2)) {
  try {
    const base = resolveBaseRevision(argv[0]);
    if (!base) throw new Error("No base revision resolved");
    const files = collectChangedFiles(base);
    if (files.length === 0) {
      console.log(`No changed JavaScript or TypeScript files to lint (base: ${base}).`);
      return 0;
    }

    const require = createRequire(import.meta.url);
    const eslintBin = resolve(dirname(require.resolve("eslint/package.json")), "bin/eslint.js");
    console.log(`Linting ${files.length} changed file(s) against ${base}.`);
    const result = spawnSync(process.execPath, [eslintBin, "--", ...files], { stdio: "inherit" });
    if (result.error) throw result.error;
    return result.status ?? 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) process.exitCode = main();
