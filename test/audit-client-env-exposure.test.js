import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  inspectClientEnvironmentExposure,
  isSecretLikePublicEnvironmentName,
  main,
  validatePublicExposureAllowlist,
} from "../scripts/audit-client-env-exposure.js";
import { validateEnvironmentContract } from "../scripts/audit-environment-contract.js";

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
    exampleFiles: [],
    variables: [
      { name: "VITE_PUBLIC_URL", required: true, exposure: "public", documented: false },
      { name: "SERVER_SECRET", required: true, exposure: "server", documented: false },
    ],
    ...overrides,
  };
}

/** @param {Record<string, string>} files */
function repository(files) {
  const root = tempDir("client-env-exposure-");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const filename = path.join(root, relative);
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, contents);
  }
  return root;
}

/** @param {Record<string, any>} value */
function validatedContract(value = contract()) {
  const result = validateEnvironmentContract(value);
  if (!result.ok || !result.contract) throw new Error("fixture contract invalid");
  return result.contract;
}

/** @param {string} root @param {unknown} value */
function contractFile(root, value) {
  const file = path.join(root, "environment-contract.json");
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
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

test("secret-like naming uses strong components without broad substring false positives", () => {
  for (const name of [
    "VITE_XENDIT_SECRET_KEY",
    "NEXT_PUBLIC_API_KEY",
    "PUBLIC_WEBHOOK_TOKEN",
    "REACT_APP_PASSWORD",
    "VITE_SERVICE_ROLE_KEY",
  ]) assert.equal(isSecretLikePublicEnvironmentName(name), true, name);

  for (const name of [
    "VITE_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY",
    "VITE_TOKENIZER_VERSION",
    "VITE_SECRETARY_NOTE",
    "VITE_PASSWORDLESS_MODE",
    "PUBLIC_URL",
  ]) assert.equal(isSecretLikePublicEnvironmentName(name), false, name);
});

test("server-only variables referenced through public accessors fail", () => {
  const root = repository({
    "src/app.ts": "const a=import.meta.env.VITE_PUBLIC_URL;\nconst b=import.meta.env.SERVER_SECRET;\n",
  });
  const report = inspectClientEnvironmentExposure(root, validatedContract());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "server-variable-public-access")?.severity, "FAIL");
});

test("secret-like public variable names fail even when contract marks them public", () => {
  const root = repository({ "src/app.ts": "const a=import.meta.env.VITE_XENDIT_SECRET_KEY;\n" });
  const contractValue = validatedContract({
    ...contract(),
    variables: [{ name: "VITE_XENDIT_SECRET_KEY", required: true, exposure: "public", documented: false }],
  });
  const report = inspectClientEnvironmentExposure(root, contractValue);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "secret-like-public-name")?.severity, "FAIL");
});

test("secret-like public contract names fail before any public reference exists", () => {
  const root = repository({ "src/app.ts": "export const x = 1;\n" });
  const contractValue = validatedContract({
    ...contract(),
    variables: [{ name: "NEXT_PUBLIC_API_KEY", required: false, exposure: "public", documented: false }],
  });
  const report = inspectClientEnvironmentExposure(root, contractValue);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "secret-like-public-contract-name")?.severity, "FAIL");
});

test("explicit public exceptions suppress naming heuristics only for public contract variables", () => {
  const root = repository({ "src/app.ts": "const a=import.meta.env.VITE_PUBLIC_TOKEN;\n" });
  const contractValue = validatedContract({
    ...contract(),
    variables: [{ name: "VITE_PUBLIC_TOKEN", required: true, exposure: "public", documented: false }],
  });
  const allowed = validatePublicExposureAllowlist([" VITE_PUBLIC_TOKEN "], contractValue);
  assert.equal(allowed.ok, true);
  const report = inspectClientEnvironmentExposure(root, contractValue, ["VITE_PUBLIC_TOKEN"]);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks.find((check) => check.id === "public-name-exception")?.severity, "PASS");

  const serverContract = validatedContract({
    ...contract(),
    variables: [{ name: "SERVER_SECRET", required: true, exposure: "server", documented: false }],
  });
  assert.equal(validatePublicExposureAllowlist(["SERVER_SECRET"], serverContract).ok, false);
  assert.equal(validatePublicExposureAllowlist(["UNKNOWN_SECRET"], contractValue).ok, false);
  assert.equal(validatePublicExposureAllowlist(["VITE_PUBLIC_TOKEN", "VITE_PUBLIC_TOKEN"], contractValue).ok, false);
});

test("safe publishable and anonymous keys are not classified as secret-like", () => {
  const root = repository({
    "src/app.ts": "const a=import.meta.env.VITE_SUPABASE_ANON_KEY;\nconst b=process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;\n",
  });
  const contractValue = validatedContract({
    ...contract(),
    variables: [
      { name: "VITE_SUPABASE_ANON_KEY", required: true, exposure: "public", documented: false },
      { name: "NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY", required: true, exposure: "public", documented: false },
    ],
  });
  const report = inspectClientEnvironmentExposure(root, contractValue);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.exposures.every((item) => item.secretLikeName === false), true);
});

test("undeclared public references warn, while undeclared secret-like public references fail", () => {
  const root = repository({
    "src/app.ts": "const a=import.meta.env.VITE_UNDECLARED_URL;\nconst b=import.meta.env.VITE_UNDECLARED_SECRET;\nconst c=process.env.SERVER_SECRET;\nconst d=import.meta.env.VITE_PUBLIC_URL;\n",
  });
  const report = inspectClientEnvironmentExposure(root, validatedContract());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((check) => /** @type {any} */ (check).variable === "VITE_UNDECLARED_URL")?.severity, "WARN");
  assert.equal(report.checks.find((check) => /** @type {any} */ (check).variable === "VITE_UNDECLARED_SECRET" && check.id === "secret-like-public-name")?.severity, "FAIL");
});

test("unconventional public contract names warn without inventing exposure failure", () => {
  const root = repository({ "src/app.ts": "const a=import.meta.env.API_URL;\nconst b=process.env.SERVER_SECRET;\n" });
  const contractValue = validatedContract({
    ...contract(),
    variables: [
      { name: "API_URL", required: true, exposure: "public", documented: false },
      { name: "SERVER_SECRET", required: true, exposure: "server", documented: false },
    ],
  });
  const report = inspectClientEnvironmentExposure(root, contractValue);
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.checks.find((check) => check.id === "unconventional-public-name")?.severity, "WARN");
});

test("dynamic environment access remains an uncertainty warning", () => {
  const root = repository({
    "src/app.ts": "const k='VITE_PUBLIC_URL';\nconst a=import.meta.env[k];\nconst b=process.env.SERVER_SECRET;\nconst c=import.meta.env.VITE_PUBLIC_URL;\n",
  });
  const report = inspectClientEnvironmentExposure(root, validatedContract());
  assert.equal(report.overallStatus, "WARN");
  assert.equal(report.dynamicAccess.length, 1);
  assert.equal(report.checks.find((check) => check.id === "dynamic-environment-access")?.severity, "WARN");
});

test("missing scan roots fail policy without becoming a technical crash", () => {
  const root = repository({ "src/app.ts": "export const x=1;\n" });
  const contractValue = validatedContract({
    ...contract(),
    scanRoots: ["missing-src"],
  });
  const report = inspectClientEnvironmentExposure(root, contractValue);
  assert.equal(report.technicalStatus, "PASS");
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "scan-root-missing")?.severity, "FAIL");
});

test("missing repository is a technical failure", () => {
  const report = inspectClientEnvironmentExposure(
    path.join(os.tmpdir(), "client-env-exposure-no-such-repository"),
    validatedContract(),
  );
  assert.equal(report.technicalStatus, "FAIL");
  assert.equal(report.overallStatus, "FAIL");
});

test("CLI supports explicit exceptions and stable PASS WARN FAIL semantics", () => {
  const passRoot = repository({ "src/app.ts": "const a=import.meta.env.VITE_PUBLIC_URL;\nconst b=process.env.SERVER_SECRET;\n" });
  const passContract = contractFile(passRoot, contract());
  const pass = runMain(passRoot, "--contract", passContract, "--json");
  assert.equal(pass.status, 0);
  assert.equal(JSON.parse(pass.stdout).overallStatus, "PASS");

  const warnContractValue = {
    ...contract(),
    variables: [
      { name: "API_URL", required: true, exposure: "public", documented: false },
      { name: "SERVER_SECRET", required: true, exposure: "server", documented: false },
    ],
  };
  const warnRoot = repository({ "src/app.ts": "const a=import.meta.env.API_URL;\nconst b=process.env.SERVER_SECRET;\n" });
  const warn = runMain(warnRoot, "--contract", contractFile(warnRoot, warnContractValue), "--json");
  assert.equal(warn.status, 0);
  assert.equal(JSON.parse(warn.stdout).overallStatus, "WARN");

  const failRoot = repository({ "src/app.ts": "const a=import.meta.env.VITE_XENDIT_SECRET_KEY;\n" });
  const failContract = {
    ...contract(),
    variables: [{ name: "VITE_XENDIT_SECRET_KEY", required: true, exposure: "public", documented: false }],
  };
  const fail = runMain(failRoot, "--contract", contractFile(failRoot, failContract), "--json");
  assert.equal(fail.status, 1);
  assert.equal(JSON.parse(fail.stdout).overallStatus, "FAIL");

  const allowed = runMain(
    failRoot,
    "--contract", contractFile(failRoot, failContract),
    "--allow-public-name", "VITE_XENDIT_SECRET_KEY",
    "--json",
  );
  assert.equal(allowed.status, 0);
  assert.equal(JSON.parse(allowed.stdout).overallStatus, "PASS");
});

test("CLI rejects missing contracts, invalid allowlists, and unknown options", () => {
  const root = repository({ "src/app.ts": "const a=import.meta.env.VITE_PUBLIC_URL;\nconst b=process.env.SERVER_SECRET;\n" });
  const file = contractFile(root, contract());
  for (const args of [
    [root],
    [root, "--contract", path.join(root, "missing.json")],
    [root, "--contract", file, "--allow-public-name", "SERVER_SECRET"],
    [root, "--contract", file, "--allow-public-name", "UNKNOWN_SECRET"],
    [root, "--contract", file, "--allow-public-name", "bad-name!"],
    [root, "--contract", file, "--unknown"],
  ]) assert.equal(runMain(...args).status, 1);
});

test("audit reuses canonical environment scanning and has no second accessor scanner", () => {
  const source = fs.readFileSync(path.resolve("scripts/audit-client-env-exposure.js"), "utf8");
  assert.match(source, /scanEnvironmentSource/);
  assert.match(source, /readEnvironmentContractFile/);
  assert.doesNotMatch(source, /process\.env\.|import\.meta\.env\.|Deno\.env\.get|Bun\.env\./);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|https?:\/\//);
  assert.doesNotMatch(source, /writeFile|appendFile|unlink|rmSync|rename/);
});
