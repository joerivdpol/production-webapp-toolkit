#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateDatabaseSchemaSnapshot } from "./database-schema-snapshot.js";
import {
  migrationManifestDigest,
  validateMigrationManifest,
  validateMigrationRoots,
} from "./audit-migration-safety.js";

/** @typedef {{ category: string, path: string, change: "MISSING" | "EXTRA" | "CHANGED", fields: string[] }} SchemaDifference */

/** @param {unknown} value */
function stableJson(value) {
  return JSON.stringify(value);
}

/** @param {unknown} expected @param {unknown} observed */
function changedFields(expected, observed) {
  if (typeof expected !== "object" || expected === null || typeof observed !== "object" || observed === null) return ["value"];
  const left = /** @type {Record<string, unknown>} */ (expected);
  const right = /** @type {Record<string, unknown>} */ (observed);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => stableJson(left[key]) !== stableJson(right[key]))
    .sort();
}

/** @param {import("./database-schema-snapshot.js").DatabaseSchemaSnapshot} snapshot */
function flattenSnapshot(snapshot) {
  const objects = new Map();
  for (const schema of snapshot.schemas) {
    objects.set(`schema:${schema.name}`, { name: schema.name });
    for (const table of schema.tables) {
      const tablePath = `${schema.name}.${table.name}`;
      objects.set(`table:${tablePath}`, { name: table.name });
      for (const column of table.columns) objects.set(`column:${tablePath}.${column.name}`, column);
      for (const constraint of table.constraints) objects.set(`constraint:${tablePath}.${constraint.name}`, constraint);
      for (const index of table.indexes) objects.set(`index:${tablePath}.${index.name}`, index);
    }
    for (const item of schema.enums) objects.set(`enum:${schema.name}.${item.name}`, item);
    for (const item of schema.views) objects.set(`view:${schema.name}.${item.name}`, item);
    for (const item of schema.sequences) objects.set(`sequence:${schema.name}.${item.name}`, item);
  }
  return objects;
}

/** @param {string} objectPath */
function differenceCategory(objectPath) {
  const separator = objectPath.indexOf(":");
  return separator === -1 ? "object" : objectPath.slice(0, separator);
}

/** @param {import("./database-schema-snapshot.js").DatabaseSchemaSnapshot} expected @param {import("./database-schema-snapshot.js").DatabaseSchemaSnapshot} observed */
export function compareDatabaseSchemaSnapshots(expected, observed) {
  const expectedObjects = flattenSnapshot(expected);
  const observedObjects = flattenSnapshot(observed);
  /** @type {SchemaDifference[]} */
  const differences = [];
  const keys = [...new Set([...expectedObjects.keys(), ...observedObjects.keys()])].sort();
  for (const key of keys) {
    const expectedValue = expectedObjects.get(key);
    const observedValue = observedObjects.get(key);
    if (expectedValue === undefined) {
      differences.push({ category: differenceCategory(key), path: key, change: "EXTRA", fields: [] });
    } else if (observedValue === undefined) {
      differences.push({ category: differenceCategory(key), path: key, change: "MISSING", fields: [] });
    } else if (stableJson(expectedValue) !== stableJson(observedValue)) {
      differences.push({ category: differenceCategory(key), path: key, change: "CHANGED", fields: changedFields(expectedValue, observedValue) });
    }
  }
  return differences;
}

/**
 * @param {import("./database-schema-snapshot.js").DatabaseSchemaSnapshot} expected
 * @param {import("./database-schema-snapshot.js").DatabaseSchemaSnapshot} observed
 * @param {{ manifest?: import("./audit-migration-safety.js").MigrationManifest | null }} [options]
 */
export function inspectDatabaseSchemaDrift(expected, observed, options = {}) {
  if (expected.kind !== "expected") throw new Error("expected snapshot must have kind expected");
  if (observed.kind !== "observed") throw new Error("observed snapshot must have kind observed");

  const environmentMatches = expected.identity.environment === undefined || expected.identity.environment === observed.identity.environment;
  const identityStatus = expected.identity.name === observed.identity.name && environmentMatches ? "MATCH" : "MISMATCH";

  const expectedDigest = expected.migrationManifestSha256 ?? null;
  let migrationBindingStatus = "UNVERIFIED";
  let actualManifestDigest = null;
  if (options.manifest) {
    actualManifestDigest = migrationManifestDigest(options.manifest);
    migrationBindingStatus = actualManifestDigest === expectedDigest ? "MATCH" : "MISMATCH";
  }

  const observedMigrationStatus = observed.migrationManifestSha256 === undefined
    ? "NOT_SUPPLIED"
    : observed.migrationManifestSha256 === expectedDigest
      ? "MATCH"
      : "MISMATCH";

  const differences = identityStatus === "MATCH"
    ? compareDatabaseSchemaSnapshots(expected, observed)
    : [];
  const driftStatus = identityStatus === "MATCH"
    ? differences.length === 0 ? "MATCH" : "MISMATCH"
    : "UNVERIFIED";

  const overallStatus =
    identityStatus === "MISMATCH" ||
    migrationBindingStatus === "MISMATCH" ||
    observedMigrationStatus === "MISMATCH" ||
    driftStatus === "MISMATCH"
      ? "FAIL"
      : migrationBindingStatus === "UNVERIFIED"
        ? "WARN"
        : "PASS";

  return {
    identity: {
      status: identityStatus,
      expectedName: expected.identity.name,
      observedName: observed.identity.name,
      expectedEnvironment: expected.identity.environment ?? null,
      observedEnvironment: observed.identity.environment ?? null,
    },
    migrationBinding: {
      status: migrationBindingStatus,
      expectedManifestSha256: expectedDigest,
      actualManifestSha256: actualManifestDigest,
      observedManifestStatus: observedMigrationStatus,
      observedManifestSha256: observed.migrationManifestSha256 ?? null,
    },
    schemaDrift: {
      status: driftStatus,
      differenceCount: differences.length,
      differences,
    },
    evidence: {
      expected: expected.evidence,
      observed: observed.evidence,
    },
    technicalStatus: "PASS",
    overallStatus,
  };
}

/** @param {ReturnType<typeof inspectDatabaseSchemaDrift>} report */
export function formatDatabaseSchemaDrift(report) {
  const lines = [
    "Database schema drift audit",
    "",
    `Identity: ${report.identity.status}`,
    `Migration binding: ${report.migrationBinding.status}`,
    `Observed migration claim: ${report.migrationBinding.observedManifestStatus}`,
    `Schema drift: ${report.schemaDrift.status}`,
    `Differences: ${report.schemaDrift.differenceCount}`,
    "",
  ];
  for (const difference of report.schemaDrift.differences) {
    const fields = difference.fields.length > 0 ? ` (${difference.fields.join(", ")})` : "";
    lines.push(`${difference.change}  ${difference.path}${fields}`);
  }
  lines.push("", `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string} filename @param {"expected" | "observed"} kind */
function readSnapshotFile(filename, kind) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    return {
      ok: false,
      snapshot: null,
      error: error instanceof SyntaxError
        ? `${kind} schema snapshot contains invalid JSON`
        : `${kind} schema snapshot file cannot be read`,
    };
  }
  const validation = validateDatabaseSchemaSnapshot(value);
  if (!validation.ok || validation.snapshot === null) {
    return {
      ok: false,
      snapshot: null,
      error: `${kind} schema snapshot does not satisfy Database Schema Snapshot v1`,
    };
  }
  if (validation.snapshot.kind !== kind) {
    return { ok: false, snapshot: null, error: `${kind} schema snapshot must have kind ${kind}` };
  }
  return { ok: true, snapshot: validation.snapshot, error: null };
}

/** @param {string} filename @param {string[]} migrationRoots */
function readMigrationManifest(filename, migrationRoots) {
  let value;
  try {
    value = JSON.parse(fs.readFileSync(filename, "utf8"));
  } catch (error) {
    return {
      ok: false,
      manifest: null,
      error: error instanceof SyntaxError
        ? "migration manifest contains invalid JSON"
        : "migration manifest file cannot be read",
    };
  }
  const validation = validateMigrationManifest(value, migrationRoots);
  if (!validation.ok || validation.manifest === null) {
    return { ok: false, manifest: null, error: validation.error ?? "invalid migration manifest" };
  }
  return { ok: true, manifest: validation.manifest, error: null };
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  let expectedFile = null;
  let observedFile = null;
  let manifestFile = null;
  /** @type {string[]} */
  const migrationRoots = [];
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") {
      json = true;
    } else if (
      argument === "--expected-file" ||
      argument === "--observed-file" ||
      argument === "--migration-manifest" ||
      argument === "--migration-root"
    ) {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) return null;
      if (argument === "--expected-file") {
        if (expectedFile !== null) return null;
        expectedFile = value;
      }
      if (argument === "--observed-file") {
        if (observedFile !== null) return null;
        observedFile = value;
      }
      if (argument === "--migration-manifest") {
        if (manifestFile !== null) return null;
        manifestFile = value;
      }
      if (argument === "--migration-root") migrationRoots.push(value);
      index += 1;
    } else return null;
  }
  if (expectedFile === null || observedFile === null) return null;
  const rootsValidation = migrationRoots.length === 0
    ? { ok: true, roots: [], error: null }
    : validateMigrationRoots(migrationRoots);
  if (!rootsValidation.ok) return null;
  if ((manifestFile === null) !== (migrationRoots.length === 0)) return null;
  return {
    expectedFile,
    observedFile,
    manifestFile,
    migrationRoots: rootsValidation.roots,
    json,
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error(
      "Usage: node scripts/audit-database-schema-drift.js --expected-file <expected.json> --observed-file <observed.json> [--migration-manifest <manifest.json> --migration-root <root> ...] [--json]",
    );
    return 1;
  }

  const expected = readSnapshotFile(options.expectedFile, "expected");
  if (!expected.ok || expected.snapshot === null) {
    console.error(expected.error ?? "invalid expected schema snapshot");
    return 1;
  }
  const observed = readSnapshotFile(options.observedFile, "observed");
  if (!observed.ok || observed.snapshot === null) {
    console.error(observed.error ?? "invalid observed schema snapshot");
    return 1;
  }

  let manifest = null;
  if (options.manifestFile !== null) {
    const loaded = readMigrationManifest(options.manifestFile, options.migrationRoots);
    if (!loaded.ok || loaded.manifest === null) {
      console.error(loaded.error ?? "invalid migration manifest");
      return 1;
    }
    manifest = loaded.manifest;
  }

  let report;
  try {
    report = inspectDatabaseSchemaDrift(expected.snapshot, observed.snapshot, { manifest });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid database schema drift input");
    return 1;
  }
  console.log(options.json ? JSON.stringify(report) : formatDatabaseSchemaDrift(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

// This comparator reads only explicit snapshot and optional manifest files. It
// performs no database, network, Git, shell, environment, migration execution,
// or repository-write operation and never emits raw SQL definitions in drift.
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
