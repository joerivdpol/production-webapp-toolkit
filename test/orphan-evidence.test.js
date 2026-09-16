import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, validateOrphanEvidence } from "../scripts/orphan-evidence.js";

/** @returns {any} */
function sample() {
  return {
    version: 1,
    repository: { name: "example" },
    evidence: { source: "synthetic", authenticated: false, collectedAt: "2026-09-16T17:10:00Z" },
    items: [
      { scanner: "exports", kind: "export", id: "used", analysis: "typescript-symbol", declaration: { path: "src/lib.ts", line: 1 }, references: { total: 2, external: 2, files: ["src/app.ts"] } },
      { scanner: "translations", kind: "translation", id: "home.title", analysis: "catalog-call-string", declaration: { path: "locales/en.json", line: null }, references: { total: 1, external: 1, files: ["src/app.ts"] } },
    ],
  };
}
/** @param {any} value */
function temp(value) { const file = path.join(os.tmpdir(), `orphan-${process.pid}-${Math.random()}.json`); fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); return file; }

test("valid evidence normalizes item ordering", () => {
  const value = sample(); value.items.reverse();
  const result = validateOrphanEvidence(value);
  assert.equal(result.valid, true);
  assert.deepEqual(result.evidence?.items.map((item) => item.scanner), ["exports", "translations"]);
});

test("all five orphan kinds are accepted", () => {
  const value = sample();
  value.items = ["export", "route", "feature-flag", "translation", "handler"].map((kind, index) => ({ scanner: `s${index}`, kind, id: `id${index}`, analysis: index < 2 ? "typescript-symbol" : "catalog-call-string", declaration: { path: `src/${index}.ts`, line: 1 }, references: { total: 0, external: 0, files: [] } }));
  assert.equal(validateOrphanEvidence(value).valid, true);
});

test("rejects inconsistent reference counts and files", () => {
  const value = sample(); value.items[0].references.external = 3;
  assert.equal(validateOrphanEvidence(value).valid, false);
  const files = sample(); files.items[0].references.files = ["src/a.ts", "src/a.ts"];
  assert.equal(validateOrphanEvidence(files).valid, false);
});

test("rejects unsafe paths, unknown fields, duplicates, and bad timestamps", () => {
  const unsafe = sample(); unsafe.items[0].declaration.path = "../secret"; assert.equal(validateOrphanEvidence(unsafe).valid, false);
  const unknown = sample(); unknown.items[0].payload = "x"; assert.equal(validateOrphanEvidence(unknown).valid, false);
  const duplicate = sample(); duplicate.items.push(structuredClone(duplicate.items[0])); assert.equal(validateOrphanEvidence(duplicate).valid, false);
  const time = sample(); time.evidence.collectedAt = "today"; assert.equal(validateOrphanEvidence(time).valid, false);
});

test("CLI emits canonical JSON without changing input", () => {
  const file = temp(sample()), before = fs.readFileSync(file, "utf8");
  const old = console.log; let stdout = ""; console.log = (...args) => { stdout += `${args.join(" ")}\n`; };
  try { assert.equal(main(["--file", file, "--json"]), 0); } finally { console.log = old; }
  assert.equal(JSON.parse(stdout).repository.name, "example"); assert.equal(fs.readFileSync(file, "utf8"), before); fs.rmSync(file);
});

test("CLI rejects malformed and incomplete input", () => {
  const bad = temp("{"); assert.equal(main(["--file", bad]), 1); assert.equal(main(["--unknown"]), 1); fs.rmSync(bad);
});

test("evidence validator is offline and read only", () => {
  const source = fs.readFileSync(new URL("../scripts/orphan-evidence.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
