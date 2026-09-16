import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { collectStaticOrphanEvidence, main, validateStaticOrphanPolicy } from "../scripts/collect-static-orphan-evidence.js";

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "orphan-project-"));
  fs.mkdirSync(path.join(root, "src")); fs.mkdirSync(path.join(root, "catalogs"));
  fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noLib: true }, include: ["src/**/*.ts"] }));
  fs.writeFileSync(path.join(root, "src/lib.ts"), "export function used(){return 1}\nexport function dead(){return 2}\n");
  fs.writeFileSync(path.join(root, "src/handlers.ts"), "export function usedHandler(){}\nexport function oldHandler(){}\n");
  fs.writeFileSync(path.join(root, "src/app.ts"), [
    "import { used } from \"./lib\";",
    "import { usedHandler } from \"./handlers\";",
    "used();",
    "const router = { get(...args: any[]) { return args; } };",
    "router.get(\"/home\", usedHandler);",
    "function isEnabled(name: string) { return name; }",
    "isEnabled(\"active\");",
    "function t(key: string) { return key; }",
    "t(\"home.title\");",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "catalogs/routes.json"), JSON.stringify({ home: "/home", dead: "/dead" }));
  fs.writeFileSync(path.join(root, "catalogs/flags.json"), JSON.stringify({ active: true, beta: false }));
  fs.writeFileSync(path.join(root, "catalogs/en.json"), JSON.stringify({ home: { title: "Title", unused: "Unused" } }));
  return root;
}
/** @returns {any} */
function policy() {
  return {
    version: 1, repository: "example", tsconfig: "tsconfig.json",
    symbolScanners: [
      { id: "exports", kind: "export", paths: ["src/lib.ts"], excludePaths: [] },
      { id: "handlers", kind: "handler", paths: ["src/handlers.ts"], excludePaths: [] },
    ],
    catalogScanners: [
      { id: "routes", kind: "route", catalog: "catalogs/routes.json", catalogMode: "top-level-string-values", usagePaths: ["src/**/*.ts"], callees: ["router.get"], argumentIndex: 0 },
      { id: "flags", kind: "feature-flag", catalog: "catalogs/flags.json", catalogMode: "top-level-keys", usagePaths: ["src/**/*.ts"], callees: ["isEnabled"], argumentIndex: 0 },
      { id: "translations", kind: "translation", catalog: "catalogs/en.json", catalogMode: "flattened-keys", usagePaths: ["src/**/*.ts"], callees: ["t"], argumentIndex: 0 },
    ],
  };
}
/** @param {any} value */
function jsonFile(value) { const file = path.join(os.tmpdir(), `orphan-policy-${process.pid}-${Math.random()}.json`); fs.writeFileSync(file, JSON.stringify(value)); return file; }

test("policy accepts generic symbol and catalog scanners", () => {
  const result = validateStaticOrphanPolicy(policy()); assert.equal(result.valid, true); assert.equal(result.policy?.catalogScanners.length, 3);
});

test("policy rejects duplicate scanner ids, unsafe paths, unsupported kinds, and missing scanners", () => {
  const duplicate = policy(); duplicate.catalogScanners[0].id = "exports"; assert.equal(validateStaticOrphanPolicy(duplicate).valid, false);
  const unsafe = policy(); unsafe.tsconfig = "../tsconfig.json"; assert.equal(validateStaticOrphanPolicy(unsafe).valid, false);
  const kind = policy(); kind.symbolScanners[0].kind = "route"; assert.equal(validateStaticOrphanPolicy(kind).valid, false);
  const empty = policy(); empty.symbolScanners = []; empty.catalogScanners = []; assert.equal(validateStaticOrphanPolicy(empty).valid, false);
});

test("collector detects used and unused TypeScript exports and handlers", () => {
  const root = project(), checked = validateStaticOrphanPolicy(policy()); assert.equal(checked.valid, true); if (!checked.policy) return;
  const evidence = collectStaticOrphanEvidence(root, checked.policy, "2026-09-16T17:15:00Z");
  const used = evidence.items.find((item) => item.scanner === "exports" && item.id === "used");
  const dead = evidence.items.find((item) => item.scanner === "exports" && item.id === "dead");
  const usedHandler = evidence.items.find((item) => item.scanner === "handlers" && item.id === "usedHandler");
  const oldHandler = evidence.items.find((item) => item.scanner === "handlers" && item.id === "oldHandler");
  assert.ok((used?.references.external ?? 0) > 0); assert.equal(dead?.references.external, 0);
  assert.ok((usedHandler?.references.external ?? 0) > 0); assert.equal(oldHandler?.references.external, 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("collector detects orphan route, flag, and translation catalog entries", () => {
  const root = project(), checked = validateStaticOrphanPolicy(policy()); assert.equal(checked.valid, true); if (!checked.policy) return;
  const evidence = collectStaticOrphanEvidence(root, checked.policy, "2026-09-16T17:15:00Z");
  /** @param {string} scanner @param {string} id */
  const get = (scanner, id) => evidence.items.find((item) => item.scanner === scanner && item.id === id)?.references.total;
  assert.equal(get("routes", "/home"), 1); assert.equal(get("routes", "/dead"), 0);
  assert.equal(get("flags", "active"), 1); assert.equal(get("flags", "beta"), 0);
  assert.equal(get("translations", "home.title"), 1); assert.equal(get("translations", "home.unused"), 0);
  fs.rmSync(root, { recursive: true, force: true });
});

test("excludePaths removes explicit public export surfaces from collection", () => {
  const root = project(), raw = policy(); raw.symbolScanners[0].excludePaths = ["src/lib.ts"];
  const checked = validateStaticOrphanPolicy(raw); assert.equal(checked.valid, true); if (!checked.policy) return;
  const evidence = collectStaticOrphanEvidence(root, checked.policy, "2026-09-16T17:15:00Z");
  assert.equal(evidence.items.some((item) => item.scanner === "exports"), false); fs.rmSync(root, { recursive: true, force: true });
});

test("collector fails closed on duplicate catalog values and symlinked catalog input", () => {
  const root = project(), checked = validateStaticOrphanPolicy(policy()); assert.equal(checked.valid, true); if (!checked.policy) return;
  fs.writeFileSync(path.join(root, "catalogs/routes.json"), JSON.stringify({ a: "/same", b: "/same" }));
  assert.throws(() => collectStaticOrphanEvidence(root, checked.policy, "2026-09-16T17:15:00Z"), /duplicate identifiers/);
  fs.rmSync(path.join(root, "catalogs/routes.json")); fs.symlinkSync("flags.json", path.join(root, "catalogs/routes.json"));
  assert.throws(() => collectStaticOrphanEvidence(root, checked.policy, "2026-09-16T17:15:00Z"), /regular non-symlink/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("collector requires caller supplied absolute collection time", () => {
  const root = project(), checked = validateStaticOrphanPolicy(policy()); assert.equal(checked.valid, true); if (!checked.policy) return;
  assert.throws(() => collectStaticOrphanEvidence(root, checked.policy, "today"), /absolute ISO timestamp/); fs.rmSync(root, { recursive: true, force: true });
});

test("CLI emits canonical evidence", () => {
  const root = project(), file = jsonFile(policy()); const old = console.log; let stdout = ""; console.log = (...args) => { stdout += `${args.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", file, "--collected-at", "2026-09-16T17:15:00Z", "--json"]), 0); } finally { console.log = old; }
  const parsed = JSON.parse(stdout); assert.equal(parsed.repository.name, "example"); assert.ok(parsed.items.length >= 10);
  fs.rmSync(file); fs.rmSync(root, { recursive: true, force: true });
});

test("collector operational surface is local filesystem plus TypeScript only", () => {
  const source = fs.readFileSync(new URL("../scripts/collect-static-orphan-evidence.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\//);
  assert.match(source, /from "typescript"/); assert.match(source, /validateOrphanEvidence/);
});
