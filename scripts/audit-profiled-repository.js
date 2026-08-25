#!/usr/bin/env node

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { inspectRepository, formatScorecard } from "./audit-repository.js";
import {
  inspectPythonService,
  formatPythonServiceAudit,
} from "./audit-python-service.js";
import { detectRepositoryProfile } from "./detect-repository-profile.js";

/** @param {string} target */
export function inspectProfiledRepository(target) {
  const root = resolve(target);
  const profile = detectRepositoryProfile(root);

  if (profile === "webapp") {
    return {
      profile,
      report: inspectRepository(root),
    };
  }

  if (profile === "python-service") {
    return {
      profile,
      report: inspectPythonService(root),
    };
  }

  return {
    profile: "unknown",
    report: null,
  };
}

/** @param {ReturnType<typeof inspectProfiledRepository>} result */
export function formatProfiledAudit(result) {
  if (result.profile === "webapp" && result.report) {
    return [
      "Profile: webapp",
      "",
      formatScorecard(result.report),
    ].join("\n");
  }

  if (result.profile === "python-service" && result.report) {
    return [
      "Profile: python-service",
      "",
      formatPythonServiceAudit(result.report),
    ].join("\n");
  }

  return "Profile: unknown\n\nResult: FAIL — unsupported repository profile.";
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");
  const target = positional[0] ?? process.cwd();

  const result = inspectProfiledRepository(target);

  console.log(
    json
      ? JSON.stringify(result)
      : formatProfiledAudit(result),
  );

  if (!result.report) return 1;

  return result.report.corePassed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
