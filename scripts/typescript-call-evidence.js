import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/** @param {unknown} value @param {number} [max] */
function text(value, max = 512) { if (typeof value !== "string") return null; const normalized = value.trim(); return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null; }
/** @param {unknown} value */
export function safeTypeScriptSourcePath(value) { const v = text(value); if (!v || path.isAbsolute(v) || v.includes("\\")) return null; const normalized = path.posix.normalize(v); const extension = path.posix.extname(normalized).toLowerCase(); return normalized !== "." && normalized !== ".." && !normalized.startsWith("../") && normalized === v && SOURCE_EXTENSIONS.has(extension) ? normalized : null; }
/** @param {unknown} value @param {{minimum?:number,maximum?:number}} [options] */
export function sourcePathList(value, options = {}) { const minimum = options.minimum ?? 1, maximum = options.maximum ?? 128; if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return null; const paths = value.map(safeTypeScriptSourcePath); if (paths.some((item) => !item) || new Set(paths).size !== paths.length) return null; return /** @type {string[]} */ (paths).sort(); }
/** @param {unknown} value */
export function validCalleeName(value) { const v = text(value, 128); return v && /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(v) ? v : null; }
/** @param {unknown} value @param {{minimum?:number,maximum?:number}} [options] */
export function calleeNameList(value, options = {}) { const minimum = options.minimum ?? 1, maximum = options.maximum ?? 64; if (!Array.isArray(value) || value.length < minimum || value.length > maximum) return null; const items = value.map(validCalleeName); if (items.some((item) => !item) || new Set(items).size !== items.length) return null; return /** @type {string[]} */ (items).sort(); }
/** @param {string} filename */
function scriptKind(filename) { const extension = path.extname(filename).toLowerCase(); if (extension === ".tsx") return ts.ScriptKind.TSX; if (extension === ".jsx") return ts.ScriptKind.JSX; if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS; return ts.ScriptKind.TS; }
/** @param {any} expression @returns {string|null} */
function calleeName(expression) { if (ts.isIdentifier(expression)) return expression.text; if (ts.isPropertyAccessExpression(expression)) { const left = calleeName(expression.expression); return left ? `${left}.${expression.name.text}` : null; } if (ts.isParenthesizedExpression(expression)) return calleeName(expression.expression); return null; }
/** @param {string} root @param {string} relative */
export function inspectTypeScriptCalls(root, relative) {
  const base = path.resolve(root), absolute = path.resolve(base, relative), rel = path.relative(base, absolute);
  /** @param {string} reason */ const failure = (reason) => ({ ok: false, calls: new Set(), orderedCalls: [], reason });
  if (rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return failure("path-escape");
  let stat; try { stat = fs.lstatSync(absolute); } catch { return failure("missing"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) return failure("uninspectable");
  const buffer = fs.readFileSync(absolute); if (buffer.includes(0)) return failure("binary");
  const source = ts.createSourceFile(relative, buffer.toString("utf8"), ts.ScriptTarget.Latest, true, scriptKind(relative));
  const diagnostics = /** @type {any} */ (source).parseDiagnostics ?? [];
  if (diagnostics.length > 0) return failure("parse-error");
  const calls = new Set();
  /** @type {Array<{name:string,position:number}>} */ const orderedCalls = [];
  /** @param {any} node */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name) { calls.add(name); orderedCalls.push({ name, position: node.getStart(source, false) }); }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  orderedCalls.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  return { ok: true, calls, orderedCalls, reason: null };
}
