#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {"webapp" | "python-service" | "unknown"} RepositoryProfile
 */

const PYTHON_SCAN_EXCLUDED_DIRECTORIES = new Set([
  ".git", ".mypy_cache", ".pytest_cache", ".ruff_cache", ".tox", ".venv",
  "build", "dist", "node_modules", "tests", "venv",
]);
const PYTHON_SCAN_MAX_DEPTH = 4;
const PYTHON_SCAN_MAX_ENTRIES = 4096;

/** @param {string} root */
function hasPythonSources(root) {
  /** @type {Array<{directory:string,depth:number}>} */
  const pending = [{ directory: root, depth: 0 }];
  let visitedEntries = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) break;
    let entries;
    try {
      entries = fs.readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visitedEntries += 1;
      if (visitedEntries > PYTHON_SCAN_MAX_ENTRIES) return false;
      if (entry.isFile() && entry.name.endsWith(".py")) return true;
      if (
        entry.isDirectory() &&
        current.depth < PYTHON_SCAN_MAX_DEPTH &&
        !PYTHON_SCAN_EXCLUDED_DIRECTORIES.has(entry.name)
      ) {
        pending.push({ directory: path.join(current.directory, entry.name), depth: current.depth + 1 });
      }
    }
  }
  return false;
}

/** @param {string} target @returns {RepositoryProfile} */
export function detectRepositoryProfile(target) {
  const root = resolve(target);

  if (!fs.existsSync(root)) {
    return "unknown";
  }

  const packageJson = path.join(root, "package.json");
  const tsconfig = path.join(root, "tsconfig.json");
  const tsconfigBase = path.join(root, "tsconfig.base.json");

  if (
    fs.existsSync(packageJson) &&
    (fs.existsSync(tsconfig) || fs.existsSync(tsconfigBase))
  ) {
    return "webapp";
  }

  if (hasPythonSources(root)) {
    return "python-service";
  }

  return "unknown";
}

export function main(argv = process.argv.slice(2)) {
  const target = argv[0] ?? process.cwd();
  const profile = detectRepositoryProfile(target);

  console.log(profile);

  return profile === "unknown" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
