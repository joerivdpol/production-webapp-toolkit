import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  inspectEnvironmentContract,
  main,
  validateEnvironmentContract,
} from "../scripts/audit-environment-contract.js";

/** @type {string[]} */
const fixtures = [];

/** @param {string} prefix */
function tempDir(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fixtures.push(root);
  return root;
}

/** @param {Record<string, any>} [overrides] */
function contract(overrides = {}) {
  return {
    version: 1,
    scanRoots: ["src"],
    exampleFiles: [".env.example"],
    variables: [
      { name: "VITE_PUBLIC_URL", required: true, exposure: "public", documented: true },
      { name: "SERVER_SECRET", required: true, exposure: "server", documented: true },
    ],
    ...overrides,
  };
}

/** @param {Record<string, string>} [files] @param {string} [example] */
function repository(files = {}, example = "VITE_PUBLIC_URL=\nSERVER_SECRET=\n") {
  const root = tempDir("environment-contract-");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  fs.writeFileSync(path.join(root, ".env.example"), example);
  return root;
}

/** @param {string} root @param {unknown} value */
function contractFile(root, value) {
  const filename = path.join(root, "environment-contract.json");
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value, null, 2));
  return filename;
}

/** @param {...string} args */
function runMain(...args) {
  let stdout = "";
  let stderr = "";
  const log = console.log;
  const error = console.error;
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    return { status: main(args), stdout, stderr };
  } finally {
    console.log = log;
    console.error = error;
  }
}

afterEach(() => {
  for (const root of fixtures.splice(0).reverse()) fs.rmSync(root, { recursive: true, force: true });
});

test("validates and normalizes an explicit environment contract", () => {
  const result = validateEnvironmentContract({
    version: 1,
    scanRoots: [" src "],
    exampleFiles: [" .env.example "],
    variables: [
      { name: "PUBLIC_URL", required: true, exposure: "public", documented: true },
      { name: "SECRET_KEY", required: false, exposure: "server", documented: false },
    ],
  });
  assert.equal(result.ok, true);
  if (!result.ok || !result.contract) return;
  assert.deepEqual(result.contract.scanRoots, ["src"]);
  assert.deepEqual(result.contract.exampleFiles, [".env.example"]);
  assert.equal(result.contract.variables[1]?.required, false);
});

test("rejects unsafe paths, ambiguous variables, duplicate entries, and unknown fields", () => {
  const invalid = [
    {},
    { ...contract(), version: 2 },
    { ...contract(), scanRoots: [] },
    { ...contract(), scanRoots: ["../outside"] },
    { ...contract(), scanRoots: ["src", "src"] },
    { ...contract(), exampleFiles: [".env"] },
    { ...contract(), exampleFiles: ["../.env.example"] },
    { ...contract(), variables: [] },
    { ...contract(), variables: [{ name: "1BAD", required: true, exposure: "server", documented: false }] },
    { ...contract(), variables: [{ name: "A", required: true, exposure: "private", documented: false }] },
    { ...contract(), variables: [{ name: "A", required: "yes", exposure: "server", documented: false }] },
    { ...contract(), variables: [{ name: "A", required: true, exposure: "server", documented: "yes" }] },
    { ...contract(), variables: [{ name: "A", required: true, exposure: "server", documented: false }, { name: "A", required: false, exposure: "public", documented: false }] },
    { ...contract(), variables: [{ name: "A", required: true, exposure: "server", documented: true }], exampleFiles: [] },
    { ...contract(), extra: true },
  ];
  for (const value of invalid) assert.equal(validateEnvironmentContract(value).ok, false);
});

test("passes when required usage, exposure, and example documentation match", () => {
  const root = repository({
    "src/client.ts": "export const publicUrl = import.meta.env.VITE_PUBLIC_URL;\nconst mode = import.meta.env.MODE;\n",
    "src/server.ts": "export const secret = process.env.SERVER_SECRET;\n",
  });
  const validation = validateEnvironmentContract(contract());
  assert.equal(validation.ok, true);
  if (!validation.ok || !validation.contract) return;
  const report = inspectEnvironmentContract(root, validation.contract);
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.unknownReferences, []);
  assert.equal(report.filesScanned, 2);
  assert.equal(report.variables.find((item) => item.name === "SERVER_SECRET")?.references[0]?.channel, "server");
});

test("fails when a server-only variable is referenced through a public accessor", () => {
  const root = repository({
    "src/app.ts": "const a = import.meta.env.VITE_PUBLIC_URL;\nconst secret = import.meta.env.SERVER_SECRET;\n",
  });
  const validation = validateEnvironmentContract(contract());
  if (!validation.ok || !validation.contract) throw new Error("fixture contract invalid");
  const report = inspectEnvironmentContract(root, validation.contract);
  assert.equal(report.overallStatus, "FAIL");
  const exposure = report.checks.find((check) => check.id === "server-variable-exposure" && /** @type {any} */ (check).variable === "SERVER_SECRET");
  assert.equal(exposure?.severity, "FAIL");
});

test("detects undeclared source references and undeclared example keys", () => {
  const root = repository({
    "src/app.ts": "const a = import.meta.env.VITE_PUBLIC_URL;\nconst b = process.env.SERVER_SECRET;\nconst c = process.env.EXTRA_KEY;\n",
  }, "VITE_PUBLIC_URL=\nSERVER_SECRET=\nOTHER_KEY=placeholder-value-that-must-not-appear\n");
  const validation = validateEnvironmentContract(contract());
  if (!validation.ok || !validation.contract) throw new Error("fixture contract invalid");
  const report = inspectEnvironmentContract(root, validation.contract);
  assert.equal(report.overallStatus, "FAIL");
  assert.deepEqual(report.unknownReferences, ["EXTRA_KEY"]);
  assert.deepEqual(report.unknownExampleKeys, ["OTHER_KEY"]);
  assert.equal(JSON.stringify(report).includes("placeholder-value-that-must-not-appear"), false);
});

test("required usage and required documentation are enforced independently", () => {
  const root = repository({ "src/app.ts": "const a = import.meta.env.VITE_PUBLIC_URL;\n" }, "VITE_PUBLIC_URL=\n");
  const validation = validateEnvironmentContract(contract());
  if (!validation.ok || !validation.contract) throw new Error("fixture contract invalid");
  const report = inspectEnvironmentContract(root, validation.contract);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "required-variable-usage" && /** @type {any} */ (check).variable === "SERVER_SECRET")?.severity, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "variable-documentation" && /** @type {any} */ (check).variable === "SERVER_SECRET")?.severity, "FAIL");
});

test("dynamic environment access is an uncertainty warning, not invented variable truth", () => {
  const root = repository({
    "src/app.ts": "const key = 'SERVER_SECRET';\nconst a = process.env[key];\nconst b = import.meta.env[key];\nconst c = Bun.env[key];\nconst d = Deno.env.get(key);\nconst e = import.meta.env.VITE_PUBLIC_URL;\nconst f = process.env.SERVER_SECRET;\n",
  });
  const validation = validateEnvironmentContract(contract());
  if (!validation.ok || !validation.contract) throw new Error("fixture contract invalid");
  const report = inspectEnvironmentContract(root, validation.contract);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.dynamicAccess.length, 4);
  assert.equal(report.checks.filter((check) => check.id === "dynamic-environment-access").length, 4);
});

test("supports explicit Node, Bun, Deno, Vite, and SvelteKit accessors", () => {
  const root = repository({
    "src/access.ts": [
      "const a = process.env.SERVER_A;",
      "const b = process.env['SERVER_B'];",
      "const c = Bun.env.SERVER_C;",
      "const d = Bun.env['SERVER_D'];",
      "const e = Deno.env.get('SERVER_E');",
      "const f = import.meta.env.VITE_PUBLIC_A;",
      "const g = import.meta.env['VITE_PUBLIC_B'];",
    ].join("\n"),
    "src/svelte.ts": "import { PUBLIC_C } from '$env/static/public';\nimport { SERVER_F as secret } from '$env/dynamic/private';\n",
  }, "SERVER_A=\nSERVER_B=\nSERVER_C=\nSERVER_D=\nSERVER_E=\nSERVER_F=\nVITE_PUBLIC_A=\nVITE_PUBLIC_B=\nPUBLIC_C=\n");
  const variables = [
    ...["SERVER_A", "SERVER_B", "SERVER_C", "SERVER_D", "SERVER_E", "SERVER_F"].map((name) => ({ name, required: true, exposure: "server", documented: true })),
    ...["VITE_PUBLIC_A", "VITE_PUBLIC_B", "PUBLIC_C"].map((name) => ({ name, required: true, exposure: "public", documented: true })),
  ];
  const validation = validateEnvironmentContract(contract({ variables }));
  if (!validation.ok || !validation.contract) throw new Error("fixture contract invalid");
  const report = inspectEnvironmentContract(root, validation.contract);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.variables.find((item) => item.name === "PUBLIC_C")?.references[0]?.channel, "public");
  assert.equal(report.variables.find((item) => item.name === "SERVER_F")?.references[0]?.channel, "server");
});

test("public process prefixes are treated as public exposure", () => {
  const root = repository({
    "src/app.ts": "const a = process.env.NEXT_PUBLIC_SECRET;\nconst b = process.env.PUBLIC_URL;\n",
  }, "NEXT_PUBLIC_SECRET=\nPUBLIC_URL=\n");
  const validation = validateEnvironmentContract(contract({ variables: [
    { name: "NEXT_PUBLIC_SECRET", required: true, exposure: "server", documented: true },
    { name: "PUBLIC_URL", required: true, exposure: "public", documented: true },
  ] }));
  if (!validation.ok || !validation.contract) throw new Error("fixture contract invalid");
  const report = inspectEnvironmentContract(root, validation.contract);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.variables.find((item) => item.name === "NEXT_PUBLIC_SECRET")?.references[0]?.channel, "public");
});

test("missing declared roots and example files are contract failures, not technical crashes", () => {
  const root = repository({ "src/app.ts": "const a = process.env.SERVER_SECRET;\nconst b = import.meta.env.VITE_PUBLIC_URL;\n" });
  const validation = validateEnvironmentContract(contract({ scanRoots: ["missing-src"], exampleFiles: ["missing.example.env"] }));
  if (!validation.ok || !validation.contract) throw new Error("fixture contract invalid");
  const report = inspectEnvironmentContract(root, validation.contract);
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "FAIL");
  assert.ok(report.checks.some((check) => check.id === "scan-root-missing"));
  assert.ok(report.checks.some((check) => check.id === "example-file-missing"));
});

test("duplicate example keys fail without exposing any values", () => {
  const root = repository({ "src/app.ts": "const a = process.env.SERVER_SECRET;\nconst b = import.meta.env.VITE_PUBLIC_URL;\n" }, "VITE_PUBLIC_URL=first-hidden\nSERVER_SECRET=second-hidden\nSERVER_SECRET=third-hidden\n");
  const validation = validateEnvironmentContract(contract());
  if (!validation.ok || !validation.contract) throw new Error("fixture contract invalid");
  const report = inspectEnvironmentContract(root, validation.contract);
  const serialized = JSON.stringify(report);
  assert.equal(report.overallStatus, "FAIL");
  assert.ok(report.checks.some((check) => check.id === "example-key-duplicate"));
  for (const secret of ["first-hidden", "second-hidden", "third-hidden"]) assert.equal(serialized.includes(secret), false);
});

test("large source files and symlinks do not escape or silently overclaim completeness", () => {
  const root = repository({ "src/app.ts": "const a = process.env.SERVER_SECRET;\nconst b = import.meta.env.VITE_PUBLIC_URL;\n" });
  fs.writeFileSync(path.join(root, "src", "large.ts"), "x".repeat(2 * 1024 * 1024 + 1));
  const outside = tempDir("environment-contract-outside-");
  fs.writeFileSync(path.join(outside, "secret.ts"), "const leaked = process.env.OUTSIDE_SECRET;\n");
  fs.symlinkSync(path.join(outside, "secret.ts"), path.join(root, "src", "linked.ts"));
  const validation = validateEnvironmentContract(contract());
  if (!validation.ok || !validation.contract) throw new Error("fixture contract invalid");
  const report = inspectEnvironmentContract(root, validation.contract);
  assert.equal(report.overallStatus, "WARN");
  assert.equal((/** @type {string[]} */ (report.unknownReferences)).includes("OUTSIDE_SECRET"), false);
  assert.ok(report.checks.some((check) => check.id === "source-file-too-large"));
});

test("missing repository is a technical failure", () => {
  const validation = validateEnvironmentContract(contract());
  if (!validation.ok || !validation.contract) throw new Error("fixture contract invalid");
  const report = inspectEnvironmentContract(path.join(os.tmpdir(), "environment-contract-no-such-repository"), validation.contract);
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.overallStatus, "FAIL");
});

test("CLI emits stable JSON and human output with PASS, WARN, and FAIL exits", () => {
  const passRoot = repository({ "src/app.ts": "const a = process.env.SERVER_SECRET;\nconst b = import.meta.env.VITE_PUBLIC_URL;\n" });
  const passContract = contractFile(passRoot, contract());
  const passJson = runMain(passRoot, "--contract", passContract, "--json");
  assert.equal(passJson.status, 0);
  assert.equal(JSON.parse(passJson.stdout).overallStatus, "PASS");
  const human = runMain(passRoot, "--contract", passContract);
  assert.equal(human.status, 0);
  assert.match(human.stdout, /Environment contract audit/);
  assert.match(human.stdout, /Overall: PASS/);

  const warnRoot = repository({ "src/app.ts": "const key='SERVER_SECRET';\nconst x=process.env[key];\nconst a=process.env.SERVER_SECRET;\nconst b=import.meta.env.VITE_PUBLIC_URL;\n" });
  const warn = runMain(warnRoot, "--contract", contractFile(warnRoot, contract()), "--json");
  assert.equal(warn.status, 0);
  assert.equal(JSON.parse(warn.stdout).overallStatus, "WARN");

  const failRoot = repository({ "src/app.ts": "const a=import.meta.env.SERVER_SECRET;\nconst b=import.meta.env.VITE_PUBLIC_URL;\n" });
  const fail = runMain(failRoot, "--contract", contractFile(failRoot, contract()), "--json");
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).overallStatus, "FAIL");
});

test("CLI rejects missing, malformed, invalid contracts and unknown arguments", () => {
  const root = repository();
  const malformed = contractFile(root, "{");
  const invalid = contractFile(root, { version: 1, scanRoots: [], exampleFiles: [], variables: [] });
  for (const args of [
    [root],
    [root, "--contract", path.join(root, "missing.json")],
    [root, "--contract", malformed],
    [root, "--contract", invalid],
    [root, "--contract", invalid, "--unknown"],
  ]) assert.equal(runMain(...args).status, 1);
});

test("runtime process environment values are never consulted or surfaced", () => {
  const previous = process.env.TOOLKIT_SHOULD_NOT_READ_THIS;
  process.env.TOOLKIT_SHOULD_NOT_READ_THIS = "extremely-sensitive-runtime-value";
  try {
    const root = repository({ "src/app.ts": "const a=process.env.SERVER_SECRET;\nconst b=import.meta.env.VITE_PUBLIC_URL;\n" });
    const validation = validateEnvironmentContract(contract());
    if (!validation.ok || !validation.contract) throw new Error("fixture contract invalid");
    const report = inspectEnvironmentContract(root, validation.contract);
    assert.equal(JSON.stringify(report).includes("extremely-sensitive-runtime-value"), false);
  } finally {
    if (previous === undefined) delete process.env.TOOLKIT_SHOULD_NOT_READ_THIS;
    else process.env.TOOLKIT_SHOULD_NOT_READ_THIS = previous;
  }
});

test("source audit stays local, read only, and avoids runtime env or network integrations", () => {
  const source = fs.readFileSync(path.resolve("scripts/audit-environment-contract.js"), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|https?:\/\//);
  assert.doesNotMatch(source, /writeFile|appendFile|unlink|rmSync|rename|mkdir/);
  assert.match(source, /example\/sample\/template/);
  assert.match(source, /dynamic-environment-access/);
});
