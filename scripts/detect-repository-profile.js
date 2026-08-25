#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * @typedef {"webapp" | "python-service" | "unknown"} RepositoryProfile
 */

/** @param {string} root */
function hasPythonSources(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .some(
      (entry) =>
        entry.isFile() &&
        entry.name.endsWith(".py"),
    );
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
