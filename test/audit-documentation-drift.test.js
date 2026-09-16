import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatDocumentationDrift,
  inspectDocumentationDrift,
  main,
  validateDocumentationDriftPolicy,
} from "../scripts/audit-documentation-drift.js";

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    documents: ["README.md", "docs/generated.md"],
    packageScripts: [{ manifest: "package.json", documents: ["README.md"] }],
    environmentBindings: [{ contract: "config/environment.json", documents: ["README.md"] }],
    pathReferenceRules: [{ documents: ["README.md"], prefixes: ["src/", "scripts/"] }],
    generatedBindings: [{ document: "docs/generated.md", sources: ["src/schema.ts"], marker: "toolkit-source-sha256" }],
    severity: {
      documentInspection: "FAIL",
      commandReference: "FAIL",
      environmentReference: "FAIL",
      pathReference: "FAIL",
      generatedDocument: "FAIL",
    },
  };
}

function policy() {
  const result = validateDocumentationDriftPolicy(rawPolicy());
  assert.equal(result.valid, true);
  if (!result.valid || !result.policy) throw new Error("fixture policy invalid");
  return result.policy;
}

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "documentation-drift-"));
}

/** @param {string} root @param {string} file @param {string|Buffer} content */
function write(root, file, content) {
  const absolute = path.join(root, file);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

/** @param {string} root @param {string[]} sources */
function digest(root, sources) {
  const hash = crypto.createHash("sha256");
  for (const source of [...sources].sort()) {
    hash.update(source, "utf8");
    hash.update("\0");
    hash.update(fs.readFileSync(path.join(root, source), "utf8"), "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function completeRoot() {
  const root = tempRoot();
  write(root, "package.json", JSON.stringify({ scripts: { test: "node --test", "audit:safety": "node scripts/safety.js" } }));
  write(root, "src/app.ts", "export const app = true;\n");
  write(root, "src/schema.ts", "export const schemaVersion = 1;\n");
  write(root, "scripts/safety.js", "export {};\n");
  write(root, "config/environment.json", JSON.stringify({
    version: 1,
    scanRoots: ["src"],
    exampleFiles: [".env.example"],
    variables: [
      { name: "PUBLIC_API_URL", required: true, exposure: "public", documented: true },
      { name: "SERVER_ONLY", required: false, exposure: "server", documented: false },
    ],
  }));
  write(root, ".env.example", "PUBLIC_API_URL=\n");
  write(root, "README.md", "# App\n\nRun `bun run test`. Configure `PUBLIC_API_URL`. Architecture lives at `src/app.ts` and `scripts/safety.js`.\n");
  const hash = digest(root, ["src/schema.ts"]);
  write(root, "docs/generated.md", `<!-- toolkit-source-sha256: ${hash} -->\n# Generated\n`);
  return root;
}

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `documentation-drift-policy-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("validates explicit documentation drift policy", () => {
  const result = validateDocumentationDriftPolicy(rawPolicy());
  assert.equal(result.valid, true);
  if (!result.valid || !result.policy) return;
  assert.equal(result.policy.documents.length, 2);
  assert.equal(result.policy.generatedBindings[0]?.marker, "toolkit-source-sha256");
});

test("policy rejects traversal unconfigured documents bad prefixes and unknown fields", () => {
  const traversal = rawPolicy(); traversal.documents = ["../README.md"];
  assert.equal(validateDocumentationDriftPolicy(traversal).valid, false);

  const unconfigured = rawPolicy(); unconfigured.packageScripts[0].documents = ["docs/other.md"];
  assert.equal(validateDocumentationDriftPolicy(unconfigured).valid, false);

  const prefix = rawPolicy(); prefix.pathReferenceRules[0].prefixes = ["src"];
  assert.equal(validateDocumentationDriftPolicy(prefix).valid, false);

  const unknown = rawPolicy(); unknown.inferArchitecture = true;
  assert.equal(validateDocumentationDriftPolicy(unknown).valid, false);
});

test("current commands environment paths and generated bindings pass", () => {
  const root = completeRoot();
  const report = inspectDocumentationDrift(root, policy());
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks[0]?.id, "documentation-current");
  fs.rmSync(root, { recursive: true, force: true });
});

test("documented package command missing from manifest is blocking", () => {
  const root = completeRoot();
  fs.appendFileSync(path.join(root, "README.md"), "\nAlso run `npm run removed-script`.\n");
  const report = inspectDocumentationDrift(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "documented-command-missing" && /removed-script/.test(item.detail)), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("yarn built in prose is not treated as a package script reference", () => {
  const root = completeRoot();
  fs.appendFileSync(path.join(root, "README.md"), "\nInstall with `yarn install`.\n");
  const report = inspectDocumentationDrift(root, policy());
  assert.equal(report.overallStatus, "PASS");
  fs.rmSync(root, { recursive: true, force: true });
});

test("environment variables marked documented must appear in configured docs", () => {
  const root = completeRoot();
  fs.writeFileSync(path.join(root, "README.md"), "# App\n\nRun `bun run test`. Architecture `src/app.ts`.\n");
  const report = inspectDocumentationDrift(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "documented-environment-variable-missing" && /PUBLIC_API_URL/.test(item.detail)), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("invalid environment contract fails closed without inventing variable truth", () => {
  const root = completeRoot();
  fs.writeFileSync(path.join(root, "config/environment.json"), JSON.stringify({ version: 1 }));
  const report = inspectDocumentationDrift(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "environment-contract-invalid"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("inline architecture paths under explicit prefixes must exist", () => {
  const root = completeRoot();
  fs.appendFileSync(path.join(root, "README.md"), "\nLegacy module: `src/removed/module.ts`.\n");
  const report = inspectDocumentationDrift(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "documented-path-missing" && /src\/removed\/module\.ts/.test(item.detail)), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("paths outside explicit architecture prefixes are not guessed", () => {
  const root = completeRoot();
  fs.appendFileSync(path.join(root, "README.md"), "\nExternal example: `examples/not-present.ts`.\n");
  assert.equal(inspectDocumentationDrift(root, policy()).overallStatus, "PASS");
  fs.rmSync(root, { recursive: true, force: true });
});

test("generated documentation marker detects source drift", () => {
  const root = completeRoot();
  fs.writeFileSync(path.join(root, "src/schema.ts"), "export const schemaVersion = 2;\n");
  const report = inspectDocumentationDrift(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "generated-document-stale"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("missing generated marker and missing source fail closed", () => {
  const root = completeRoot();
  fs.writeFileSync(path.join(root, "docs/generated.md"), "# Generated without marker\n");
  let report = inspectDocumentationDrift(root, policy());
  assert.equal(report.checks.some((item) => item.id === "generated-marker-missing"), true);
  fs.rmSync(path.join(root, "src/schema.ts"));
  report = inspectDocumentationDrift(root, policy());
  assert.equal(report.checks.some((item) => item.id === "generated-source-uninspectable"), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test("configured documentation symlinks are never followed", () => {
  const root = completeRoot();
  const outside = path.join(os.tmpdir(), `documentation-outside-${process.pid}.md`);
  fs.writeFileSync(outside, "# Outside\nPUBLIC_API_URL\n");
  fs.rmSync(path.join(root, "README.md"));
  fs.symlinkSync(outside, path.join(root, "README.md"));
  const report = inspectDocumentationDrift(root, policy());
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "document-uninspectable" && /not-regular-file/.test(item.detail)), true);
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { force: true });
});

test("formatter reports stale references without exposing document contents", () => {
  const root = completeRoot();
  fs.appendFileSync(path.join(root, "README.md"), "\n`bun run missing` SECRET_DOCUMENT_PAYLOAD\n");
  const output = formatDocumentationDrift(inspectDocumentationDrift(root, policy()));
  assert.match(output, /documented-command-missing/);
  assert.match(output, /missing/);
  assert.doesNotMatch(output, /SECRET_DOCUMENT_PAYLOAD/);
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI emits JSON and preserves source documentation", () => {
  const root = completeRoot();
  const policyFile = tempJson(rawPolicy());
  const before = fs.readFileSync(path.join(root, "README.md"), "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--root", root, "--policy", policyFile, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  assert.equal(fs.readFileSync(path.join(root, "README.md"), "utf8"), before);
  fs.rmSync(policyFile, { force: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test("CLI rejects malformed policy missing repository and unknown arguments", () => {
  const malformed = tempJson("{");
  const valid = tempJson(rawPolicy());
  assert.equal(main(["--root", "/tmp/missing-documentation-drift-root", "--policy", valid]), 1);
  assert.equal(main(["--root", ".", "--policy", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  fs.rmSync(valid, { force: true });
});

test("documentation drift audit is local read only and reuses environment contract validation", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-documentation-drift.js", import.meta.url), "utf8");
  assert.match(source, /validateEnvironmentContract/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|https?:\/\/|process\.env|writeFile|rmSync|unlinkSync/);
});
