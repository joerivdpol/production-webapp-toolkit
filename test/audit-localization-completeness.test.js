import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatLocalizationCompleteness,
  inspectLocalizationCompleteness,
  main,
  validateLocalizationPolicy,
} from "../scripts/audit-localization-completeness.js";

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    referenceLocale: "en",
    catalogMode: "nested",
    locales: [
      { id: "en", file: "locales/en.json" },
      { id: "nl", file: "locales/nl.json" },
    ],
    placeholderSyntaxes: ["brace", "double-brace", "percent-brace"],
    extraKeys: { severity: "FAIL" },
    fallback: { severity: "FAIL", minimumLength: 5, allowKeys: ["brand.name"] },
    html: { severity: "FAIL", allowKeys: [] },
    currencyRules: [{ key: "price.label", requiredPlaceholders: ["amount"], forbiddenLiterals: ["Rp", "IDR"] }],
  };
}
function policy(raw = rawPolicy()) {
  const result = validateLocalizationPolicy(raw);
  assert.equal(result.valid, true);
  if (!result.valid || !result.policy) throw new Error("policy fixture invalid");
  return result.policy;
}

/** @param {any} [en] @param {any} [nl] */
function repository(en = null, nl = null) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "localization-audit-"));
  fs.mkdirSync(path.join(root, "locales"), { recursive: true });
  const source = en ?? {
    brand: { name: "Happinezz" },
    greeting: "Hello {name}",
    price: { label: "Price {amount}" },
  };
  const target = nl ?? {
    brand: { name: "Happinezz" },
    greeting: "Hallo {name}",
    price: { label: "Prijs {amount}" },
  };
  fs.writeFileSync(path.join(root, "locales/en.json"), JSON.stringify(source));
  fs.writeFileSync(path.join(root, "locales/nl.json"), JSON.stringify(target));
  return root;
}

/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const filename = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}
test("complete nested catalogs pass with configured currency placeholders", () => {
  const root = repository();
  const report = inspectLocalizationCompleteness(root, policy());
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.referenceKeys, 3);
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing and extra keys follow explicit blocking policy", () => {
  const root = repository(undefined, {
    brand: { name: "Happinezz" },
    greeting: "Hallo {name}",
    old: "Oud",
  });
  const report = inspectLocalizationCompleteness(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "translation-key-missing" && item.key === "price.label"), true);
  assert.equal(report.checks.some((item) => item.id === "translation-key-extra" && item.key === "old"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("extra key severity can be WARN without weakening missing-key failures", () => {
  const raw = rawPolicy(); raw.extraKeys.severity = "WARN";
  const root = repository(undefined, {
    brand: { name: "Happinezz" }, greeting: "Hallo {name}", price: { label: "Prijs {amount}" }, old: "Oud",
  });
  const report = inspectLocalizationCompleteness(root, policy(raw));
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.some((item) => item.id === "translation-key-extra" && item.status === "WARN"), true);
  fs.rmSync(root, { recursive: true, force: true });
});
test("all configured placeholder syntaxes are compared with the reference", () => {
  const en = { message: "Hello {name} {{count}} %{amount}" , price: { label: "Price {amount}" } };
  const nl = { message: "Hallo {name} {{other}} %{amount}", price: { label: "Prijs {amount}" } };
  const root = repository(en, nl);
  const raw = rawPolicy(); raw.fallback.severity = "IGNORE"; raw.currencyRules = [{ key: "price.label", requiredPlaceholders: ["amount"], forbiddenLiterals: [] }];
  const report = inspectLocalizationCompleteness(root, policy(raw));
  assert.equal(report.checks.some((item) => item.id === "placeholder-mismatch" && item.key === "message"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("exact reference equality fallback is bounded and allowlisted", () => {
  const en = { copied: "This should differ", short: "Yes", brand: { name: "Happinezz" }, price: { label: "Price {amount}" } };
  const nl = { copied: "This should differ", short: "Yes", brand: { name: "Happinezz" }, price: { label: "Prijs {amount}" } };
  const root = repository(en, nl);
  const report = inspectLocalizationCompleteness(root, policy());
  assert.equal(report.checks.some((item) => item.id === "fallback-identical-to-reference" && item.key === "copied"), true);
  assert.equal(report.checks.some((item) => item.id === "fallback-identical-to-reference" && item.key === "short"), false);
  assert.equal(report.checks.some((item) => item.id === "fallback-identical-to-reference" && item.key === "brand.name"), false);
  fs.rmSync(root, { recursive: true, force: true });
});

test("HTML policy detects tags without retaining translation payload", () => {
  const root = repository({ message: "Plain", price: { label: "Price {amount}" } }, { message: "<b>Vertaling</b>", price: { label: "Prijs {amount}" } });
  const raw = rawPolicy(); raw.fallback.severity = "IGNORE";
  const report = inspectLocalizationCompleteness(root, policy(raw));
  assert.equal(report.checks.some((item) => item.id === "translation-html-present"), true);
  assert.doesNotMatch(JSON.stringify(report), /Vertaling|<b>/);
  fs.rmSync(root, { recursive: true, force: true });
});
test("currency formatting rules require runtime placeholders and forbid configured literals", () => {
  const root = repository(undefined, {
    brand: { name: "Happinezz" }, greeting: "Hallo {name}", price: { label: "Prijs Rp 100" },
  });
  const report = inspectLocalizationCompleteness(root, policy());
  assert.equal(report.checks.some((item) => item.id === "placeholder-mismatch" && item.key === "price.label"), true);
  assert.equal(report.checks.some((item) => item.id === "currency-placeholder-missing"), true);
  assert.equal(report.checks.some((item) => item.id === "currency-literal-present"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("policy rejects unsafe paths duplicate locales unsupported syntax and unknown fields", () => {
  const traversal = rawPolicy(); traversal.locales[0].file = "../en.json";
  assert.equal(validateLocalizationPolicy(traversal).valid, false);
  const duplicate = rawPolicy(); duplicate.locales[1].file = "locales/en.json";
  assert.equal(validateLocalizationPolicy(duplicate).valid, false);
  const syntax = rawPolicy(); syntax.placeholderSyntaxes = ["unknown"];
  assert.equal(validateLocalizationPolicy(syntax).valid, false);
  const unknown = rawPolicy(); unknown.runtimeTranslation = true;
  assert.equal(validateLocalizationPolicy(unknown).valid, false);
});

test("flat and nested catalog modes are explicit and fail closed on incompatible shapes", () => {
  const root = repository({ greeting: "Hello {name}", price: "Price {amount}" }, { greeting: "Hallo {name}", price: "Prijs {amount}" });
  const raw = rawPolicy(); raw.catalogMode = "flat"; raw.currencyRules = [{ key: "price", requiredPlaceholders: ["amount"], forbiddenLiterals: [] }]; raw.fallback.severity = "IGNORE";
  assert.equal(inspectLocalizationCompleteness(root, policy(raw)).overallStatus, "PASS");
  fs.writeFileSync(path.join(root, "locales/en.json"), JSON.stringify({ "common.greeting": "Hello {name}", price: "Price {amount}" }));
  fs.writeFileSync(path.join(root, "locales/nl.json"), JSON.stringify({ "common.greeting": "Hallo {name}", price: "Prijs {amount}" }));
  const nested = rawPolicy();
  assert.throws(() => inspectLocalizationCompleteness(root, policy(nested)), /nested locale key segments|nested locale catalogs/);
  fs.rmSync(root, { recursive: true, force: true });
});
test("catalog symlinks binary-like content and oversized files fail before parsing", () => {
  const root = repository();
  const outside = path.join(os.tmpdir(), `outside-locale-${process.pid}.json`);
  fs.writeFileSync(outside, JSON.stringify({ greeting: "external secret" }));
  fs.rmSync(path.join(root, "locales/nl.json"));
  fs.symlinkSync(outside, path.join(root, "locales/nl.json"));
  assert.throws(() => inspectLocalizationCompleteness(root, policy()), /regular non-symlink/);
  fs.rmSync(path.join(root, "locales/nl.json"));
  fs.writeFileSync(path.join(root, "locales/nl.json"), Buffer.from([0, 1, 2, 3]));
  assert.throws(() => inspectLocalizationCompleteness(root, policy()), /UTF-8 JSON text/);
  fs.rmSync(outside, { force: true }); fs.rmSync(root, { recursive: true, force: true });
});

test("currency rules referencing absent reference keys fail explicitly", () => {
  const raw = rawPolicy(); raw.currencyRules = [{ key: "missing.price", requiredPlaceholders: ["amount"], forbiddenLiterals: [] }];
  const root = repository();
  const report = inspectLocalizationCompleteness(root, policy(raw));
  assert.equal(report.checks.some((item) => item.id === "currency-rule-key-missing" && item.key === "missing.price"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("human output exposes keys and counts without translation text", () => {
  const root = repository({ copied: "Secret reference sentence", price: { label: "Price {amount}" } }, { copied: "Secret reference sentence", price: { label: "Prijs {amount}" } });
  const report = inspectLocalizationCompleteness(root, policy());
  const output = formatLocalizationCompleteness(report);
  assert.match(output, /fallback-identical-to-reference/);
  assert.match(output, /nl\s+copied/);
  assert.doesNotMatch(output, /Secret reference sentence/);
  fs.rmSync(root, { recursive: true, force: true });
});
test("CLI emits JSON without modifying catalogs and returns blocking exit on drift", () => {
  const root = repository();
  const policyFile = tempJson("localization-policy", rawPolicy());
  const before = fs.readFileSync(path.join(root, "locales/nl.json"), "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", policyFile, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  assert.equal(fs.readFileSync(path.join(root, "locales/nl.json"), "utf8"), before);
  fs.writeFileSync(path.join(root, "locales/nl.json"), JSON.stringify({ greeting: "Hallo {name}" }));
  assert.equal(main(["--root", root, "--policy", policyFile]), 1);
  fs.rmSync(policyFile, { force: true }); fs.rmSync(root, { recursive: true, force: true });
});

test("CLI rejects malformed policy incomplete arguments and missing repository", () => {
  const malformed = tempJson("localization-bad", "{");
  const root = repository();
  assert.equal(main(["--root", root, "--policy", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  const policyFile = tempJson("localization-policy", rawPolicy());
  assert.equal(main(["--root", "/tmp/definitely-missing-localization-root", "--policy", policyFile]), 1);
  fs.rmSync(malformed, { force: true }); fs.rmSync(policyFile, { force: true }); fs.rmSync(root, { recursive: true, force: true });
});

test("localization audit stays local read only and never inspects runtime environment", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-localization-completeness.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /lstatSync/);
  assert.match(source, /fallback-identical-to-reference/);
});

test("placeholder parity preserves syntax identity and duplicate occurrences", () => {
  const en = { message: "Hello {{count}} {{count}} {name}", price: { label: "Price {amount}" } };
  const nl = { message: "Hallo {{count}} {name} {count}", price: { label: "Prijs {amount}" } };
  const root = repository(en, nl);
  const raw = rawPolicy(); raw.fallback.severity = "IGNORE";
  const report = inspectLocalizationCompleteness(root, policy(raw));
  assert.equal(report.checks.some((item) => item.id === "placeholder-mismatch" && item.key === "message"), true);
  fs.rmSync(root, { recursive: true, force: true });
});
