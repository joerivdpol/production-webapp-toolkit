#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { validateOrphanEvidence } from "./orphan-evidence.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const SYMBOL_KINDS = new Set(["export", "handler"]);
const CATALOG_KINDS = new Set(["route", "feature-flag", "translation"]);
const CATALOG_MODES = new Set(["top-level-keys", "flattened-keys", "top-level-string-values", "flattened-string-values"]);

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function object(value) { return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
/** @param {unknown} value */
function text(value) { return typeof value === "string" && value.trim().length > 0 ? value.trim() : null; }
/** @param {unknown} value */
function safePath(value) { const v = text(value); return v && v.length <= 512 && !v.startsWith("/") && !v.includes("\\") && !v.includes("\0") && !v.split("/").includes("..") ? v : null; }
/** @param {unknown} value */
function safePattern(value) { const v = safePath(value); return v && v.length <= 256 ? v : null; }
/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value, allowed, scope, errors) { for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` }); }
/** @param {unknown} value */
function patternList(value) { if (!Array.isArray(value) || value.length === 0) return null; const list = value.map(safePattern); return list.every(Boolean) && new Set(list).size === list.length ? /** @type {string[]} */ (list).sort() : null; }
/** @param {string} pattern */
function glob(pattern) { let out = "^"; for (let i = 0; i < pattern.length; i += 1) { const c = pattern[i]; if (c === undefined) break; if (c === "*" && pattern[i + 1] === "*" && pattern[i + 2] === "/") { out += "(?:.*/)?"; i += 2; } else if (c === "*") { if (pattern[i + 1] === "*") { out += ".*"; i += 1; } else out += "[^/]*"; } else if (c === "?") out += "[^/]"; else out += "^$.*+?()[]{}|".includes(c) ? "\\" + c : c; } return new RegExp(out + "$"); }
/** @param {string} file @param {string[]} patterns */
function matches(file, patterns) { return patterns.some((pattern) => glob(pattern).test(file) || (pattern.includes("/**/") && glob(pattern.replaceAll("/**/", "/")).test(file))); }

/** @param {unknown} value */
export function validateStaticOrphanPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "static orphan policy must be an object" }] };
  unknown(value, ["version", "repository", "tsconfig", "symbolScanners", "catalogScanners"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  const repository = text(value.repository), tsconfig = safePath(value.tsconfig);
  if (!repository || repository.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(repository)) errors.push({ id: "repository-invalid", detail: "repository must be a portable identifier" });
  if (!tsconfig) errors.push({ id: "tsconfig-invalid", detail: "tsconfig must be a safe repository-relative path" });

  const scannerIds = new Set();
  /** @type {Array<any>} */ const symbolScanners = [];
  if (!Array.isArray(value.symbolScanners)) errors.push({ id: "symbol-scanners-invalid", detail: "symbolScanners must be an array" });
  else for (const [index, raw] of value.symbolScanners.entries()) {
    if (!object(raw)) { errors.push({ id: "symbol-scanner-invalid", detail: `symbolScanners[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "kind", "paths", "excludePaths"], "symbol-scanner", errors);
    const id = text(raw.id), kind = text(raw.kind), paths = patternList(raw.paths), excludePaths = raw.excludePaths === undefined || (Array.isArray(raw.excludePaths) && raw.excludePaths.length === 0) ? [] : patternList(raw.excludePaths);
    if (!id || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !kind || !SYMBOL_KINDS.has(kind) || !paths || excludePaths === null) { errors.push({ id: "symbol-scanner-fields-invalid", detail: `symbolScanners[${index}] has invalid id, kind, or paths` }); continue; }
    if (scannerIds.has(id)) { errors.push({ id: "scanner-id-duplicate", detail: `scanner id ${id} is duplicated` }); continue; }
    scannerIds.add(id); symbolScanners.push({ id, kind, paths, excludePaths });
  }

  /** @type {Array<any>} */ const catalogScanners = [];
  if (!Array.isArray(value.catalogScanners)) errors.push({ id: "catalog-scanners-invalid", detail: "catalogScanners must be an array" });
  else for (const [index, raw] of value.catalogScanners.entries()) {
    if (!object(raw)) { errors.push({ id: "catalog-scanner-invalid", detail: `catalogScanners[${index}] must be an object` }); continue; }
    unknown(raw, ["id", "kind", "catalog", "catalogMode", "usagePaths", "callees", "argumentIndex"], "catalog-scanner", errors);
    const id = text(raw.id), kind = text(raw.kind), catalog = safePath(raw.catalog), catalogMode = text(raw.catalogMode), usagePaths = patternList(raw.usagePaths);
    const callees = Array.isArray(raw.callees) ? raw.callees.map(text) : null;
    const argumentIndex = raw.argumentIndex;
    const calleesValid = callees !== null && callees.length > 0 && callees.every((item) => item && item.length <= 128 && /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(item)) && new Set(callees).size === callees.length;
    if (!id || id.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id) || !kind || !CATALOG_KINDS.has(kind) || !catalog || !catalogMode || !CATALOG_MODES.has(catalogMode) || !usagePaths || !calleesValid || !Number.isSafeInteger(argumentIndex) || Number(argumentIndex) < 0 || Number(argumentIndex) > 8) { errors.push({ id: "catalog-scanner-fields-invalid", detail: `catalogScanners[${index}] has invalid fields` }); continue; }
    if (scannerIds.has(id)) { errors.push({ id: "scanner-id-duplicate", detail: `scanner id ${id} is duplicated` }); continue; }
    scannerIds.add(id); catalogScanners.push({ id, kind, catalog, catalogMode, usagePaths, callees: /** @type {string[]} */ (callees).sort(), argumentIndex: Number(argumentIndex) });
  }
  if (symbolScanners.length + catalogScanners.length === 0) errors.push({ id: "scanners-empty", detail: "at least one scanner must be configured" });
  if (errors.length || !repository || !tsconfig) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, repository, tsconfig, symbolScanners: symbolScanners.sort((a, b) => a.id.localeCompare(b.id)), catalogScanners: catalogScanners.sort((a, b) => a.id.localeCompare(b.id)) }, errors: [] };
}

/** @param {string} root @param {string} relative */
function regularFile(root, relative) { const absolute = path.resolve(root, relative); const prefix = `${path.resolve(root)}${path.sep}`; if (!absolute.startsWith(prefix)) throw new Error("configured path escapes repository root"); let stat; try { stat = fs.lstatSync(absolute); } catch { throw new Error(`required file is missing: ${relative}`); } if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`required file must be a regular non-symlink file: ${relative}`); if (stat.size > 4 * 1024 * 1024) throw new Error(`configured file exceeds bounded size: ${relative}`); return absolute; }
/** @param {string} root @param {string} absolute */
function relative(root, absolute) { const result = path.relative(root, absolute).replaceAll("\\", "/"); return result.startsWith("../") || path.isAbsolute(result) ? null : result; }
/** @param {import("typescript").Symbol | undefined} symbol @param {import("typescript").TypeChecker} checker */
function canonical(symbol, checker) { if (!symbol) return null; if (symbol.flags & ts.SymbolFlags.Alias) { try { return checker.getAliasedSymbol(symbol); } catch { return symbol; } } return symbol; }
/** @param {import("typescript").Symbol} symbol */
function declarationNameKeys(symbol) { const keys = new Set(); for (const declaration of symbol.declarations ?? []) { const name = /** @type {any} */ (declaration).name; if (name && ts.isIdentifier(name)) keys.add(`${name.getSourceFile().fileName}\0${name.getStart()}`); } return keys; }
/** @param {import("typescript").Expression} expression @returns {string|null} */
function calleeName(expression) { if (ts.isIdentifier(expression)) return expression.text; if (ts.isPropertyAccessExpression(expression)) { const parent = calleeName(expression.expression); return parent ? `${parent}.${expression.name.text}` : null; } return null; }

/** @param {string} root @param {Array<{sourceFile:import("typescript").SourceFile,relative:string|null}>} sourceFiles @param {string} targetFile @param {string} exportName @param {import("typescript").CompilerOptions} options */
function importReferenceEvidence(root, sourceFiles, targetFile, exportName, options) {
  const targetAbsolute = path.resolve(root, targetFile);
  const files = [];
  for (const { sourceFile, relative: sourcePath } of sourceFiles) {
    if (!sourcePath || sourcePath === targetFile) continue;
    let referenced = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
      const specifier = statement.moduleSpecifier;
      if (!specifier || !ts.isStringLiteral(specifier)) continue;
      const resolved = ts.resolveModuleName(specifier.text, sourceFile.fileName, options, ts.sys).resolvedModule?.resolvedFileName;
      if (!resolved || path.resolve(resolved) !== targetAbsolute) continue;
      if (ts.isImportDeclaration(statement)) {
        const clause = statement.importClause;
        if (!clause) continue;
        if (exportName === "default" && clause.name) referenced = true;
        const bindings = clause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) referenced = true;
        if (bindings && ts.isNamedImports(bindings) && bindings.elements.some((element) => (element.propertyName?.text ?? element.name.text) === exportName)) referenced = true;
      } else {
        const clause = statement.exportClause;
        if (!clause) referenced = true;
        else if (ts.isNamedExports(clause) && clause.elements.some((element) => (element.propertyName?.text ?? element.name.text) === exportName)) referenced = true;
      }
      if (referenced) break;
    }
    if (referenced) files.push(sourcePath);
  }
  return [...new Set(files)].sort();
}

/** @param {unknown} raw @param {string} mode @returns {string[]} */
function catalogIds(raw, mode) {
  if (!object(raw)) throw new Error("catalog root must be a JSON object");
  /** @type {string[]} */ const ids = [];
  const valuesMode = mode.endsWith("string-values"), flattened = mode.startsWith("flattened");
  /** @param {unknown} value @param {string[]} parts */
  function walk(value, parts) {
    if (object(value) && flattened) { for (const key of Object.keys(value).sort()) walk(value[key], [...parts, key]); return; }
    if (!flattened && parts.length === 0 && object(value)) { for (const key of Object.keys(value).sort()) { const child = value[key]; if (valuesMode) { if (typeof child !== "string" || child.length === 0) throw new Error("top-level-string-values catalog requires non-empty string values"); ids.push(child); } else ids.push(key); } return; }
    if (valuesMode) { if (typeof value !== "string" || value.length === 0) throw new Error("flattened-string-values catalog leaves must be non-empty strings"); ids.push(value); }
    else if (parts.length > 0) ids.push(parts.join("."));
  }
  walk(raw, []);
  if (ids.some((id) => id.length > 512 || /[\u0000-\u001f]/.test(id))) throw new Error("catalog contains an invalid bounded identifier");
  if (new Set(ids).size !== ids.length) throw new Error("catalog produces duplicate identifiers");
  return ids.sort();
}

/** @param {string} root @param {any} policy @param {string} collectedAt */
export function collectStaticOrphanEvidence(root, policy, collectedAt) {
  if (!isAbsoluteIsoTimestamp(collectedAt)) throw new Error("collectedAt must be an absolute ISO timestamp");
  const tsconfigPath = regularFile(root, policy.tsconfig);
  const config = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  if (config.error) throw new Error("TypeScript configuration cannot be read");
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, path.dirname(tsconfigPath), undefined, tsconfigPath);
  if (parsed.errors.length > 0) throw new Error("TypeScript configuration cannot be parsed");
  const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options });
  const checker = program.getTypeChecker();
  const sourceFiles = program.getSourceFiles().map((sourceFile) => ({ sourceFile, relative: relative(root, sourceFile.fileName) })).filter((entry) => entry.relative !== null && !entry.relative.includes("node_modules/") && !entry.sourceFile.isDeclarationFile);

  /** @type {Map<import("typescript").Symbol, Array<{path:string,pos:number}>>} */ const occurrences = new Map();
  for (const { sourceFile, relative: file } of sourceFiles) {
    /** @param {import("typescript").Node} node */
    function visit(node) { if (ts.isIdentifier(node)) { const symbol = canonical(checker.getSymbolAtLocation(node), checker); if (symbol) { const list = occurrences.get(symbol) ?? []; list.push({ path: /** @type {string} */ (file), pos: node.getStart() }); occurrences.set(symbol, list); } } ts.forEachChild(node, visit); }
    visit(sourceFile);
  }

  /** @type {Array<any>} */ const items = [];
  for (const scanner of policy.symbolScanners) {
    for (const { sourceFile, relative: fileValue } of sourceFiles) {
      const file = /** @type {string} */ (fileValue);
      if (!matches(file, scanner.paths) || (scanner.excludePaths.length > 0 && matches(file, scanner.excludePaths))) continue;
      const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
      if (!moduleSymbol) continue;
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const target = canonical(exported, checker);
        if (!target) continue;
        const exportName = exported.getName();
        if (!exportName || exportName === "__esModule") continue;
        const declaration = (exported.declarations ?? []).find((item) => item.getSourceFile() === sourceFile) ?? (target.declarations ?? []).find((item) => item.getSourceFile() === sourceFile) ?? null;
        const line = declaration ? sourceFile.getLineAndCharacterOfPosition(declaration.getStart()).line + 1 : null;
        const declarationKeys = declarationNameKeys(target);
        const refs = (occurrences.get(target) ?? []).filter((entry) => !declarationKeys.has(`${path.resolve(root, entry.path)}\0${entry.pos}`) && !declarationKeys.has(`${sourceFiles.find((candidate) => candidate.relative === entry.path)?.sourceFile.fileName ?? ""}\0${entry.pos}`));
        const importFiles = importReferenceEvidence(root, sourceFiles, file, exportName, parsed.options);
        const refFiles = [...new Set([...refs.map((entry) => entry.path), ...importFiles])].sort();
        const external = Math.max(refs.filter((entry) => entry.path !== file).length, importFiles.length);
        const total = Math.max(refs.length, external, refFiles.length);
        items.push({ scanner: scanner.id, kind: scanner.kind, id: exportName, analysis: "typescript-symbol", declaration: { path: file, line }, references: { total, external, files: refFiles } });
      }
    }
  }

  for (const scanner of policy.catalogScanners) {
    const catalogPath = regularFile(root, scanner.catalog);
    let rawCatalog; try { rawCatalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")); } catch { throw new Error(`catalog cannot be parsed as JSON: ${scanner.catalog}`); }
    const ids = catalogIds(rawCatalog, scanner.catalogMode);
    const idSet = new Set(ids);
    /** @type {Map<string, Array<string>>} */ const refs = new Map(ids.map((id) => [id, []]));
    for (const { sourceFile, relative: fileValue } of sourceFiles) {
      const file = /** @type {string} */ (fileValue);
      if (!matches(file, scanner.usagePaths)) continue;
      /** @param {import("typescript").Node} node */
      function visit(node) {
        if (ts.isCallExpression(node)) {
          const called = calleeName(node.expression);
          const arg = node.arguments[scanner.argumentIndex];
          if (called && scanner.callees.includes(called) && arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && idSet.has(arg.text)) refs.get(arg.text)?.push(file);
        }
        ts.forEachChild(node, visit);
      }
      visit(sourceFile);
    }
    for (const id of ids) {
      const occurrencesForId = refs.get(id) ?? [], files = [...new Set(occurrencesForId)].sort();
      items.push({ scanner: scanner.id, kind: scanner.kind, id, analysis: "catalog-call-string", declaration: { path: scanner.catalog, line: null }, references: { total: occurrencesForId.length, external: occurrencesForId.length, files } });
    }
  }

  const raw = { version: 1, repository: { name: policy.repository }, evidence: { source: "local-static-orphan-collector", authenticated: false, collectedAt }, items };
  const validated = validateOrphanEvidence(raw);
  if (!validated.valid || !validated.evidence) throw new Error("generated orphan evidence is invalid");
  return validated.evidence;
}

/** @param {string} file */
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
/** @param {string[]} argv */
function parse(argv) { let root = null, policyFile = null, collectedAt = null, json = false; for (let i = 0; i < argv.length; i += 1) { const arg = argv[i]; if (arg === "--json") { json = true; continue; } if (!["--root", "--policy", "--collected-at"].includes(arg ?? "")) return null; const value = argv[i + 1]; if (typeof value !== "string" || value.startsWith("--")) return null; i += 1; if (arg === "--root") { if (root) return null; root = value; } else if (arg === "--policy") { if (policyFile) return null; policyFile = value; } else { if (collectedAt) return null; collectedAt = value; } } return root && policyFile && collectedAt ? { root, policyFile, collectedAt, json } : null; }
export function main(argv = process.argv.slice(2)) { const options = parse(argv); if (!options) { console.error("Usage: node scripts/collect-static-orphan-evidence.js --root <repo> --policy <policy.json> --collected-at <ISO> [--json]"); return 1; } const rawPolicy = readJson(options.policyFile); if (!rawPolicy) { console.error("Static orphan policy cannot be read or parsed"); return 1; } const checked = validateStaticOrphanPolicy(rawPolicy); if (!checked.valid || !checked.policy) { console.error("Static orphan policy is invalid"); return 1; } try { const evidence = collectStaticOrphanEvidence(path.resolve(options.root), checked.policy, options.collectedAt); console.log(options.json ? JSON.stringify(evidence) : JSON.stringify(evidence, null, 2)); return 0; } catch (error) { console.error(error instanceof Error ? error.message : "Static orphan evidence collection failed"); return 1; } }
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
