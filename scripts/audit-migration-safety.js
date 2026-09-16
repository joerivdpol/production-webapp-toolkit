#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const MANIFEST_VERSION = 1;
const MAX_SQL_SCAN_BYTES = 5 * 1024 * 1024;

/** @typedef {"PASS" | "WARN" | "FAIL"} Severity */
/** @typedef {{ id: string, severity: Severity, detail: string, path?: string }} MigrationCheck */
/** @typedef {{ path: string, sha256: string }} ManifestMigration */
/** @typedef {{ version: 1, migrations: ManifestMigration[] }} MigrationManifest */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function normalizedString(value) {
  return typeof value === "string" ? value.trim() : null;
}

/** @param {string} value */
function isSafeRelativePath(value) {
  if (!value || path.isAbsolute(value)) return false;
  const normalized = path.normalize(value);
  return normalized !== ".." && !normalized.startsWith(`..${path.sep}`);
}

/** @param {string} root @param {string} candidate */
function resolvesInside(root, candidate) {
  const resolved = path.resolve(root, candidate);
  const relative = path.relative(root, resolved);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

/** @param {Buffer} contents */
function sha256(contents) {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

/** @param {string} filename */
function normalizedRelative(filename) {
  return filename.replaceAll("\\", "/");
}

/**
 * Replace SQL strings/comments with spaces while preserving newlines. This is
 * deliberately a scanner, not a SQL parser; it exists to keep risk heuristics
 * from firing on comments, literals, and function bodies.
 * @param {string} sql
 */
export function sanitizeSql(sql) {
  let output = "";
  let index = 0;
  let mode = "normal";
  let dollarDelimiter = null;

  /** @param {string} character */
  const blank = (character) => (character === "\n" || character === "\r" ? character : " ");
  while (index < sql.length) {
    const current = sql[index] ?? "";
    const next = sql[index + 1] ?? "";

    if (mode === "line-comment") {
      output += blank(current);
      if (current === "\n") mode = "normal";
      index += 1;
      continue;
    }
    if (mode === "block-comment") {
      output += blank(current);
      if (current === "*" && next === "/") {
        output += " ";
        index += 2;
        mode = "normal";
      } else index += 1;
      continue;
    }
    if (mode === "single") {
      output += blank(current);
      if (current === "'" && next === "'") {
        output += " ";
        index += 2;
      } else {
        if (current === "'") mode = "normal";
        index += 1;
      }
      continue;
    }
    if (mode === "double") {
      output += blank(current);
      if (current === '"' && next === '"') {
        output += " ";
        index += 2;
      } else {
        if (current === '"') mode = "normal";
        index += 1;
      }
      continue;
    }
    if (mode === "dollar") {
      if (dollarDelimiter && sql.startsWith(dollarDelimiter, index)) {
        output += " ".repeat(dollarDelimiter.length);
        index += dollarDelimiter.length;
        dollarDelimiter = null;
        mode = "normal";
      } else {
        output += blank(current);
        index += 1;
      }
      continue;
    }

    if (current === "-" && next === "-") {
      output += "  ";
      index += 2;
      mode = "line-comment";
      continue;
    }
    if (current === "/" && next === "*") {
      output += "  ";
      index += 2;
      mode = "block-comment";
      continue;
    }
    if (current === "'") {
      output += " ";
      index += 1;
      mode = "single";
      continue;
    }
    if (current === '"') {
      output += " ";
      index += 1;
      mode = "double";
      continue;
    }
    if (current === "$") {
      const match = sql.slice(index).match(/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/);
      if (match?.[0]) {
        dollarDelimiter = match[0];
        output += " ".repeat(match[0].length);
        index += match[0].length;
        mode = "dollar";
        continue;
      }
    }
    output += current;
    index += 1;
  }
  return output;
}

/** @param {string} relativePath */
export function parseMigrationId(relativePath) {
  const base = path.basename(relativePath, path.extname(relativePath));
  const numeric = base.match(/^(\d{8,20})[_-]/);
  if (numeric?.[1]) return { scheme: "numeric-prefix", id: numeric[1] };
  const flyway = base.match(/^[Vv](\d+(?:\.\d+)*)__+/);
  if (flyway?.[1]) return { scheme: "flyway", id: flyway[1] };
  return null;
}

/** @param {string} id */
function isPlausibleTimestampId(id) {
  if (id.length !== 8 && id.length !== 14) return true;
  const year = Number(id.slice(0, 4));
  const month = Number(id.slice(4, 6));
  const day = Number(id.slice(6, 8));
  const hour = id.length === 14 ? Number(id.slice(8, 10)) : 0;
  const minute = id.length === 14 ? Number(id.slice(10, 12)) : 0;
  const second = id.length === 14 ? Number(id.slice(12, 14)) : 0;
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second;
}

/** @param {string} root @param {string[]} migrationRoots */
export function discoverMigrationFiles(root, migrationRoots) {
  /** @type {string[]} */
  const files = [];
  /** @type {MigrationCheck[]} */
  const checks = [];

  /** @param {string} absolute */
  const visit = (absolute) => {
    const stat = fs.lstatSync(absolute);
    const relative = normalizedRelative(path.relative(root, absolute));
    if (stat.isSymbolicLink()) {
      checks.push({ id: "migration-symlink", severity: "FAIL", path: relative, detail: `migration path is a symbolic link: ${relative}` });
      return;
    }
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(absolute, entry));
      return;
    }
    if (stat.isFile() && path.extname(absolute).toLowerCase() === ".sql") files.push(relative);
  };

  for (const migrationRoot of migrationRoots) {
    const absolute = path.resolve(root, migrationRoot);
    if (!resolvesInside(root, migrationRoot) || !fs.existsSync(absolute)) {
      checks.push({ id: "migration-root-missing", severity: "FAIL", path: migrationRoot, detail: `declared migration root is missing: ${migrationRoot}` });
      continue;
    }
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      checks.push({ id: "migration-root-invalid", severity: "FAIL", path: migrationRoot, detail: `declared migration root is not a normal directory: ${migrationRoot}` });
      continue;
    }
    visit(absolute);
  }
  files.sort();
  return { files, checks };
}

/** @param {MigrationManifest} manifest */
export function migrationManifestDigest(manifest) {
  return sha256(Buffer.from(JSON.stringify({ version: manifest.version, migrations: manifest.migrations }), "utf8"));
}

/** @param {unknown} value @param {string[]} migrationRoots */
export function validateMigrationManifest(value, migrationRoots) {
  if (!isPlainObject(value) || value.version !== MANIFEST_VERSION || !Array.isArray(value.migrations)) {
    return { ok: false, manifest: null, error: "migration manifest must be version 1 with a migrations array" };
  }
  const roots = migrationRoots.map((item) => normalizedRelative(path.normalize(item)).replace(/\/$/, ""));
  /** @type {ManifestMigration[]} */
  const migrations = [];
  const seen = new Set();
  for (const [index, raw] of value.migrations.entries()) {
    if (!isPlainObject(raw)) return { ok: false, manifest: null, error: `manifest migration ${index + 1} must be an object` };
    const allowed = new Set(["path", "sha256"]);
    if (Object.keys(raw).some((key) => !allowed.has(key))) return { ok: false, manifest: null, error: `manifest migration ${index + 1} contains unsupported fields` };
    const migrationPath = normalizedString(raw.path);
    const hash = normalizedString(raw.sha256);
    if (!migrationPath || !isSafeRelativePath(migrationPath) || path.extname(migrationPath).toLowerCase() !== ".sql") return { ok: false, manifest: null, error: `manifest migration ${index + 1} path must be a safe relative SQL path` };
    const normalizedPath = normalizedRelative(path.normalize(migrationPath));
    if (!roots.some((root) => normalizedPath.startsWith(`${root}/`))) return { ok: false, manifest: null, error: `manifest migration ${normalizedPath} is outside declared migration roots` };
    if (!hash || !/^[0-9a-fA-F]{64}$/.test(hash)) return { ok: false, manifest: null, error: `manifest migration ${normalizedPath} sha256 must be 64 hexadecimal characters` };
    if (seen.has(normalizedPath)) return { ok: false, manifest: null, error: `manifest contains duplicate migration path ${normalizedPath}` };
    seen.add(normalizedPath);
    migrations.push({ path: normalizedPath, sha256: hash.toLowerCase() });
  }
  return { ok: true, manifest: /** @type {MigrationManifest} */ ({ version: 1, migrations }), error: null };
}

/** @param {string} relativePath @param {string} sql */
function inspectSqlRisks(relativePath, sql) {
  const sanitized = sanitizeSql(sql);
  const statements = sanitized.split(";").map((item) => item.trim()).filter(Boolean);
  /** @type {MigrationCheck[]} */
  const checks = [];
  const emitted = new Set();
  /** @param {string} id @param {Severity} severity @param {string} detail */
  const add = (id, severity, detail) => {
    if (emitted.has(id)) return;
    emitted.add(id);
    checks.push({ id, severity, path: relativePath, detail });
  };

  const hasBegin = /\b(?:BEGIN|START\s+TRANSACTION)\b/i.test(sanitized);
  const hasCommit = /\bCOMMIT\b/i.test(sanitized);
  const hasConcurrentIndex = /\bCREATE\s+(?:UNIQUE\s+)?INDEX\s+CONCURRENTLY\b/i.test(sanitized);
  if (hasBegin !== hasCommit) add("transaction-boundary-unbalanced", "FAIL", "explicit transaction boundary is unbalanced");
  if (hasBegin && hasConcurrentIndex) add("concurrent-index-in-transaction", "FAIL", "CREATE INDEX CONCURRENTLY cannot run inside an explicit PostgreSQL transaction");

  for (const statement of statements) {
    if (/\bDROP\s+(?:TABLE|COLUMN|TYPE|INDEX|CONSTRAINT)\b/i.test(statement)) {
      add("destructive-ddl", "WARN", "migration contains destructive DROP DDL and should have an explicit recovery plan");
    }
    if (/\bTRUNCATE(?:\s+TABLE)?\b/i.test(statement)) {
      add("destructive-data-operation", "WARN", "migration contains TRUNCATE and may irreversibly remove data");
    }
    if (/\bDELETE\s+FROM\b/i.test(statement) && !/\bWHERE\b/i.test(statement)) {
      add("unbounded-delete", "WARN", "migration contains DELETE FROM without a WHERE clause");
    }
    if (/\bALTER\s+TYPE\b[\s\S]*\bADD\s+VALUE\b/i.test(statement)) {
      add("irreversible-enum-change", "WARN", "enum value additions are difficult to reverse safely");
    }
    if (/\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement) && !/\bCONCURRENTLY\b/i.test(statement)) {
      add("blocking-index-build", "WARN", "CREATE INDEX without CONCURRENTLY may block writes on a populated PostgreSQL table");
    }
    if (/\bALTER\s+TABLE\b/i.test(statement) && /\bALTER\s+(?:COLUMN\s+)?(?:[^\s]+\s+)?TYPE\b/i.test(statement)) {
      add("column-type-rewrite", "WARN", "ALTER COLUMN TYPE may rewrite or lock a populated table");
    }
    if (/\bSET\s+NOT\s+NULL\b/i.test(statement)) {
      add("not-null-validation", "WARN", "SET NOT NULL may require table validation and locking");
    }
    if (/\bADD\s+(?:CONSTRAINT(?:\s+[^\s]+)?\s+)?FOREIGN\s+KEY\b/i.test(statement) && !/\bNOT\s+VALID\b/i.test(statement)) {
      add("foreign-key-validation", "WARN", "adding a validated foreign key may scan and lock existing rows");
    }
    if (/\bADD\s+COLUMN\b/i.test(statement) && /\bNOT\s+NULL\b/i.test(statement) && !/\bDEFAULT\b/i.test(statement)) {
      add("not-null-column-no-default", "WARN", "adding a NOT NULL column without a default may fail when existing rows are present");
    }
    if (/\bADD\s+COLUMN\b/i.test(statement) && /\bDEFAULT\s+(?:now\s*\(|current_timestamp\b|gen_random_uuid\s*\(|uuid_generate[^\s(]*\s*\(|nextval\s*\(|random\s*\()/i.test(statement)) {
      add("volatile-column-default", "WARN", "adding a column with a volatile default may rewrite rows or create deployment-time load");
    }
    if (/\bLOCK\s+TABLE\b|\bVACUUM\s+FULL\b|\bREINDEX\b/i.test(statement)) {
      add("explicit-locking-operation", "WARN", "migration contains an operation with significant locking potential");
    }
  }

  return {
    sanitized,
    explicitTransaction: hasBegin && hasCommit,
    checks,
  };
}

/** @param {unknown} values */
export function validateMigrationRoots(values) {
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, roots: [], error: "at least one migration root is required" };
  }
  const roots = [];
  const seen = new Set();
  for (const raw of values) {
    const value = normalizedString(raw);
    if (!value || !isSafeRelativePath(value)) return { ok: false, roots: [], error: "migration roots must be safe relative paths" };
    const normalized = normalizedRelative(path.normalize(value)).replace(/\/$/, "");
    if (seen.has(normalized)) return { ok: false, roots: [], error: `duplicate migration root ${normalized}` };
    seen.add(normalized);
    roots.push(normalized);
  }
  return { ok: true, roots, error: null };
}

/**
 * @param {string} target
 * @param {{ migrationRoots: string[], manifest?: MigrationManifest | null }} options
 */
export function inspectMigrationSafety(target, options) {
  const root = path.resolve(target);
  const rootsValidation = validateMigrationRoots(options.migrationRoots);
  if (!rootsValidation.ok) throw new Error(rootsValidation.error ?? "invalid migration roots");
  const migrationRoots = rootsValidation.roots;
  let manifest = null;
  if (options.manifest !== null && options.manifest !== undefined) {
    const manifestValidation = validateMigrationManifest(options.manifest, migrationRoots);
    if (!manifestValidation.ok || manifestValidation.manifest === null) {
      throw new Error(manifestValidation.error ?? "invalid migration manifest");
    }
    manifest = manifestValidation.manifest;
  }

  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return {
      root,
      migrationRoots,
      historyConfigured: manifest !== null,
      historyStatus: "UNVERIFIED",
      migrations: [],
      checks: [{ id: "repository-unreadable", severity: "FAIL", detail: "repository path is not a readable directory" }],
      summary: { pass: 0, warn: 0, fail: 1 },
      technicalStatus: "FAIL",
      overallStatus: "FAIL",
    };
  }

  let discovery;
  try {
    discovery = discoverMigrationFiles(root, migrationRoots);
  } catch {
    return {
      root,
      migrationRoots,
      historyConfigured: manifest !== null,
      historyStatus: "UNVERIFIED",
      migrations: [],
      checks: [{ id: "migration-discovery-failed", severity: "FAIL", detail: "migration files could not be inspected reliably" }],
      summary: { pass: 0, warn: 0, fail: 1 },
      technicalStatus: "FAIL",
      overallStatus: "FAIL",
    };
  }

  /** @type {MigrationCheck[]} */
  const checks = [...discovery.checks];
  /** @type {Array<{ path: string, id: string | null, idScheme: string | null, sha256: string, explicitTransaction: boolean | null, risks: MigrationCheck[], scanned: boolean, history: "APPLIED" | "NEW" | "UNVERIFIED" }>} */
  const migrations = [];
  const manifestEntries = new Map((manifest?.migrations ?? []).map((item) => [item.path, item.sha256]));
  const idOwners = new Map();
  const basenameOwners = new Map();
  const numericWidthsByDirectory = new Map();

  for (const relativePath of discovery.files) {
    const absolute = path.join(root, relativePath);
    let contents;
    try {
      contents = fs.readFileSync(absolute);
    } catch {
      checks.push({ id: "migration-read-failed", severity: "FAIL", path: relativePath, detail: `migration file could not be read: ${relativePath}` });
      continue;
    }
    const hash = sha256(contents);
    const parsedId = parseMigrationId(relativePath);
    /** @type {MigrationCheck[]} */
    const risks = [];
    let explicitTransaction = null;
    let scanned = false;

    if (contents.includes(0)) {
      risks.push({ id: "migration-binary", severity: "FAIL", path: relativePath, detail: "SQL migration contains binary NUL content" });
    } else if (contents.length > MAX_SQL_SCAN_BYTES) {
      risks.push({ id: "migration-too-large", severity: "WARN", path: relativePath, detail: "SQL migration exceeds the bounded static risk scan size" });
    } else {
      scanned = true;
      const inspected = inspectSqlRisks(relativePath, contents.toString("utf8"));
      explicitTransaction = inspected.explicitTransaction;
      risks.push(...inspected.checks);
    }
    checks.push(...risks);

    if (parsedId === null) {
      checks.push({ id: "migration-id-unrecognized", severity: "WARN", path: relativePath, detail: `migration filename has no recognized numeric or Flyway version prefix: ${relativePath}` });
    } else {
      const key = `${parsedId.scheme}:${parsedId.id}`;
      const owner = idOwners.get(key);
      if (owner) {
        checks.push({ id: "duplicate-migration-id", severity: "FAIL", path: relativePath, detail: `migration ID ${parsedId.id} is duplicated by ${owner} and ${relativePath}` });
      } else idOwners.set(key, relativePath);
      if (parsedId.scheme === "numeric-prefix") {
        if (!isPlausibleTimestampId(parsedId.id)) checks.push({ id: "migration-id-invalid-timestamp", severity: "WARN", path: relativePath, detail: `numeric migration ID does not represent a plausible calendar timestamp: ${parsedId.id}` });
        const directory = path.dirname(relativePath);
        const widths = numericWidthsByDirectory.get(directory) ?? new Set();
        widths.add(parsedId.id.length);
        numericWidthsByDirectory.set(directory, widths);
      }
    }

    const basename = path.basename(relativePath);
    const basenameOwner = basenameOwners.get(basename);
    if (basenameOwner && basenameOwner !== relativePath) {
      checks.push({ id: "duplicate-migration-basename", severity: "WARN", path: relativePath, detail: `migration basename ${basename} appears in multiple migration roots` });
    } else basenameOwners.set(basename, relativePath);

    const manifestHash = manifestEntries.get(relativePath);
    const history = manifest === null ? "UNVERIFIED" : manifestHash === undefined ? "NEW" : "APPLIED";
    migrations.push({
      path: relativePath,
      id: parsedId?.id ?? null,
      idScheme: parsedId?.scheme ?? null,
      sha256: hash,
      explicitTransaction,
      risks,
      scanned,
      history,
    });
  }

  for (const [directory, widths] of numericWidthsByDirectory) {
    if (widths.size > 1) checks.push({ id: "migration-id-width-drift", severity: "WARN", path: normalizedRelative(directory), detail: `numeric migration IDs use inconsistent widths in ${normalizedRelative(directory)}` });
  }

  if (migrations.length === 0 && discovery.checks.every((check) => check.id !== "migration-root-missing" && check.id !== "migration-root-invalid")) {
    checks.push({ id: "no-migration-files", severity: "WARN", detail: "no SQL migration files were found in the declared migration roots" });
  }

  let historyStatus = "NOT_CONFIGURED";
  if (manifest === null) {
    checks.push({ id: "history-not-configured", severity: "WARN", detail: "applied migration history cannot be checked without an explicit manifest" });
  } else {
    historyStatus = "MATCH";
    const currentHashes = new Map(migrations.map((item) => [item.path, item.sha256]));
    for (const applied of manifest.migrations) {
      const currentHash = currentHashes.get(applied.path);
      if (currentHash === undefined) {
        checks.push({ id: "applied-migration-missing", severity: "FAIL", path: applied.path, detail: `manifested applied migration is missing from the repository: ${applied.path}` });
        historyStatus = "MISMATCH";
      } else if (currentHash !== applied.sha256) {
        checks.push({ id: "modified-applied-migration", severity: "FAIL", path: applied.path, detail: `manifested applied migration content changed: ${applied.path}` });
        historyStatus = "MISMATCH";
      }
    }
  }

  const technicalFailure = checks.some((check) => check.id === "migration-read-failed");
  const failCount = checks.filter((check) => check.severity === "FAIL").length;
  const warnCount = checks.filter((check) => check.severity === "WARN").length;
  return {
    root,
    migrationRoots,
    historyConfigured: manifest !== null,
    historyStatus,
    manifestEntries: manifest?.migrations.length ?? 0,
    migrations,
    checks,
    summary: {
      migrations: migrations.length,
      applied: migrations.filter((item) => item.history === "APPLIED").length,
      new: migrations.filter((item) => item.history === "NEW").length,
      pass: checks.filter((check) => check.severity === "PASS").length,
      warn: warnCount,
      fail: failCount,
    },
    technicalStatus: technicalFailure ? "FAIL" : "PASS",
    overallStatus: failCount > 0 ? "FAIL" : warnCount > 0 ? "WARN" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectMigrationSafety>} report */
export function formatMigrationSafety(report) {
  const lines = [
    "Migration safety audit",
    "",
    `Repository: ${report.root}`,
    `Migration roots: ${report.migrationRoots.join(", ")}`,
    `Migrations: ${report.migrations.length}`,
    `History: ${report.historyStatus}`,
    "",
  ];
  const reportChecks = /** @type {MigrationCheck[]} */ (report.checks);
  const relevant = reportChecks.filter((check) => check.severity !== "PASS");
  if (relevant.length === 0) lines.push("PASS  migration-safety  no migration safety findings detected");
  else for (const check of relevant) lines.push(`${check.severity}  ${check.id}${check.path ? `  ${check.path}` : ""}  ${check.detail}`);
  lines.push("", `Technical: ${report.technicalStatus}`, `Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string[]} argv */
export function parseArguments(argv) {
  let target = null;
  /** @type {string[]} */
  const migrationRoots = [];
  let manifestFile = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (typeof argument !== "string") return null;
    if (argument === "--json") {
      json = true;
    } else if (argument === "--root" || argument === "--manifest") {
      const value = argv[index + 1];
      if (typeof value !== "string" || !value || value.startsWith("--")) return null;
      if (argument === "--root") migrationRoots.push(value);
      else {
        if (manifestFile !== null) return null;
        manifestFile = value;
      }
      index += 1;
    } else if (argument.startsWith("-")) {
      return null;
    } else if (target === null) {
      target = argument;
    } else {
      return null;
    }
  }
  const roots = validateMigrationRoots(migrationRoots);
  if (!roots.ok) return null;
  return { target, migrationRoots: roots.roots, manifestFile, json };
}

/** @param {string} filename @param {string[]} migrationRoots */
function readManifestFile(filename, migrationRoots) {
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
  return validateMigrationManifest(value, migrationRoots);
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (!options) {
    console.error("Usage: node scripts/audit-migration-safety.js [repository] --root <migration-root> [--root <migration-root> ...] [--manifest <applied-manifest.json>] [--json]");
    return 1;
  }

  let manifest = null;
  if (options.manifestFile !== null) {
    const loaded = readManifestFile(options.manifestFile, options.migrationRoots);
    if (!loaded.ok || loaded.manifest === null) {
      console.error(loaded.error ?? "invalid migration manifest");
      return 1;
    }
    manifest = loaded.manifest;
  }

  let report;
  try {
    report = inspectMigrationSafety(options.target ?? process.cwd(), {
      migrationRoots: options.migrationRoots,
      manifest,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid migration safety input");
    return 1;
  }
  console.log(options.json ? JSON.stringify(report) : formatMigrationSafety(report));
  return report.overallStatus === "FAIL" ? 1 : 0;
}

// The migration safety auditor reads only the repository migration roots and an
// optional explicit hash manifest. It performs no database, network, Git, shell,
// migration execution, repository write, or runtime-environment operation.
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
