#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const TRACKED_DEPENDENCIES = [
  "react",
  "react-dom",
  "typescript",
  "eslint",
  "@playwright/test",
  "@tanstack/react-query",
  "@tanstack/react-router",
  "@tanstack/react-start",
  "@supabase/supabase-js",
];

/** @param {string} root */
function readPackage(root) {
  const packagePath = path.join(root, "package.json");

  if (!fs.existsSync(packagePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(packagePath, "utf8"));
}

/** @param {string[]} targets */
export function inspectDependencyDrift(targets) {
  /** @type {Array<{
   *   name: string,
   *   path: string,
   *   packageManager: string | null,
   *   engines: Record<string, unknown>,
   *   dependencies: Record<string, string>
   * }>} */
  const repositories = targets.map((target) => {
    const root = resolve(target);
    const pkg = readPackage(root);

    if (!pkg) {
      return {
        name: path.basename(root),
        path: root,
        packageManager: null,
        engines: {},
        dependencies: {},
      };
    }

    const allDependencies = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {}),
    };

    /** @type {Record<string, string>} */
    const dependencies = {};

    for (const dependency of TRACKED_DEPENDENCIES) {
      if (typeof allDependencies[dependency] === "string") {
        dependencies[dependency] = allDependencies[dependency];
      }
    }

    return {
      name: path.basename(root),
      path: root,
      packageManager:
        typeof pkg.packageManager === "string"
          ? pkg.packageManager
          : null,
      engines:
        pkg.engines && typeof pkg.engines === "object"
          ? pkg.engines
          : {},
      dependencies,
    };
  });

  const drift = [];

  for (const dependency of TRACKED_DEPENDENCIES) {
    const versions = new Map();

    for (const repository of repositories) {
      const version = repository.dependencies[dependency];

      if (!version) continue;

      if (!versions.has(version)) {
        versions.set(version, []);
      }

      versions.get(version).push(repository.name);
    }

    if (versions.size > 1) {
      drift.push({
        dependency,
        variants: [...versions.entries()].map(
          ([version, repositoryNames]) => ({
            version,
            repositories: repositoryNames,
          }),
        ),
      });
    }
  }

  const missingPackageManager = repositories
    .filter((repository) => !repository.packageManager)
    .map((repository) => repository.name);

  const missingEngines = repositories
    .filter(
      (repository) =>
        !repository.engines ||
        Object.keys(repository.engines).length === 0,
    )
    .map((repository) => repository.name);

  return {
    repositories,
    drift,
    summary: {
      repositories: repositories.length,
      trackedDependencies: TRACKED_DEPENDENCIES.length,
      driftedDependencies: drift.length,
      missingPackageManager: missingPackageManager.length,
      missingEngines: missingEngines.length,
    },
    reproducibility: {
      missingPackageManager,
      missingEngines,
    },
  };
}

/** @param {ReturnType<typeof inspectDependencyDrift>} report */
export function formatDependencyDrift(report) {
  const lines = [
    "Dependency drift audit",
    "",
  ];

  if (report.drift.length === 0) {
    lines.push("No tracked dependency drift detected.");
  } else {
    for (const item of report.drift) {
      lines.push(`DRIFT  ${item.dependency}`);

      for (const variant of item.variants) {
        lines.push(
          `  ${variant.version}  ${variant.repositories.join(", ")}`,
        );
      }
    }
  }

  lines.push(
    "",
    `Repositories: ${report.summary.repositories}`,
    `Tracked dependencies: ${report.summary.trackedDependencies}`,
    `Drifted dependencies: ${report.summary.driftedDependencies}`,
    `Missing packageManager: ${report.summary.missingPackageManager}`,
    `Missing engines: ${report.summary.missingEngines}`,
  );

  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");

  if (positional.length === 0) {
    console.error(
      "Usage: node scripts/audit-dependency-drift.js <repository> [repository...] [--json]",
    );
    return 1;
  }

  const report = inspectDependencyDrift(positional);

  console.log(
    json
      ? JSON.stringify(report)
      : formatDependencyDrift(report),
  );

  return 0;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
