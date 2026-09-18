#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

import { isFullObjectId } from "./runtime-evidence.js";

const GIT = "/usr/bin/git";
const LOOPS = new Set(["claude","codex","copilot","opencode","vscode","vscode-legacy"]);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value @param {number} [max] */
function text(value, max = 512) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}
/** @param {unknown} value */
function portableId(value) {
  const normalized = text(value, 128);
  return normalized && ID.test(normalized) ? normalized : null;
}
/** @param {unknown} value */
function safePath(value) {
  const normalized = text(value, 512);
  if (!normalized || path.isAbsolute(normalized) || normalized.includes("\\")) return null;
  const posix = path.posix.normalize(normalized);
  return posix !== "." && posix !== ".." && !posix.startsWith("../") && posix === normalized ? normalized : null;
}
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: scope + "-field-unknown", detail: scope + " contains unsupported field \"" + key + "\"" });
  }
}
/** @param {string} root @param {string} relative */
function absoluteInside(root, relative) {
  const absolute = path.resolve(root, ...relative.split("/"));
  const rel = path.relative(root, absolute);
  if (rel === "" || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error("Playwright agent path escapes worktree");
  }
  return absolute;
}
/** @param {string} filename @param {number} maxBytes */
function readRegularText(filename, maxBytes) {
  let stat;
  try { stat = fs.lstatSync(filename); } catch { throw new Error("Playwright agent file is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) {
    throw new Error("Playwright agent file must be a bounded regular non-symlink file");
  }
  const value = fs.readFileSync(filename, "utf8");
  if (value.includes("\u0000")) throw new Error("Playwright agent file contains binary NUL content");
  return value;
}
/** @param {unknown} value */
export function validatePlaywrightAgentPolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "Playwright agent policy must be an object" }] };
  rejectUnknown(value, [
    "version","repository","expectedPlaywrightVersion","loop","configFile","seedFile","planFile",
    "generatedTestRoot","plannerDefinition","generatorDefinition","plannerPrompt","generatorPrompt",
    "maxPlanBytes","maxTestBytes","maxGeneratedFiles"
  ], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "policy version must be exactly 1" });
  const repository = portableId(value.repository);
  const expectedPlaywrightVersion = text(value.expectedPlaywrightVersion, 64);
  const loop = text(value.loop, 32);
  const configFile = safePath(value.configFile), seedFile = safePath(value.seedFile), planFile = safePath(value.planFile);
  const generatedTestRoot = safePath(value.generatedTestRoot), plannerDefinition = safePath(value.plannerDefinition);
  const generatorDefinition = safePath(value.generatorDefinition), plannerPrompt = safePath(value.plannerPrompt);
  const generatorPrompt = safePath(value.generatorPrompt);
  const maxPlanBytes = integer(value.maxPlanBytes, 256, 1024 * 1024);
  const maxTestBytes = integer(value.maxTestBytes, 256, 1024 * 1024);
  const maxGeneratedFiles = integer(value.maxGeneratedFiles, 1, 512);
  if (!repository || !expectedPlaywrightVersion || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(expectedPlaywrightVersion)
      || !loop || !LOOPS.has(loop)) {
    errors.push({ id: "policy-identity-invalid", detail: "repository, exact Playwright version, or loop is invalid" });
  }
  if (!configFile || !seedFile || !planFile || !generatedTestRoot || !plannerDefinition || !generatorDefinition || !plannerPrompt || !generatorPrompt) {
    errors.push({ id: "policy-path-invalid", detail: "all policy paths must be safe relative paths" });
  }
  if (maxPlanBytes === null || maxTestBytes === null || maxGeneratedFiles === null) {
    errors.push({ id: "policy-bounds-invalid", detail: "plan/test/file bounds are invalid" });
  }
  if (errors.length || !repository || !expectedPlaywrightVersion || !loop || !configFile || !seedFile || !planFile
      || !generatedTestRoot || !plannerDefinition || !generatorDefinition || !plannerPrompt || !generatorPrompt
      || maxPlanBytes === null || maxTestBytes === null || maxGeneratedFiles === null) {
    return { valid: false, policy: null, errors };
  }
  return {
    valid: true,
    policy: {
      version: 1, repository, expectedPlaywrightVersion, loop, configFile, seedFile, planFile, generatedTestRoot,
      plannerDefinition, generatorDefinition, plannerPrompt, generatorPrompt, maxPlanBytes, maxTestBytes, maxGeneratedFiles,
    },
    errors: [],
  };
}
/** @param {string} root @param {string[]} args */
function git(root, args) {
  const result = spawnSync(GIT, ["-C", root, ...args], {
    encoding: "utf8", timeout: 10000, maxBuffer: 8 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", LANG: "C" },
  });
  if (result.status !== 0) throw new Error("read-only Git worktree inspection failed");
  return result.stdout.trim();
}
/** @param {string} root @param {string} expectedCommit */
function inspectLinkedWorktree(root, expectedCommit) {
  const resolved = path.resolve(root);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error("Playwright workspace is unavailable"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Playwright workspace must be a regular directory");
  let dotGit;
  try { dotGit = fs.lstatSync(path.join(resolved, ".git")); } catch { throw new Error("Playwright integration requires a linked Git worktree"); }
  if (!dotGit.isFile() || dotGit.isSymbolicLink()) throw new Error("Playwright integration requires a linked Git worktree, not the primary checkout");
  const top = path.resolve(git(resolved, ["rev-parse","--show-toplevel"]));
  const head = git(resolved, ["rev-parse","HEAD"]).toLowerCase();
  if (top !== resolved || !isFullObjectId(head) || head !== expectedCommit) throw new Error("Playwright worktree identity does not match expected commit");
  return { root: resolved, commit: head, clean: git(resolved, ["status","--porcelain=v1","--untracked-files=all"]) === "" };
}
/** @param {string} source @param {"planner"|"generator"} kind */
function inspectAgentDefinition(source, kind) {
  const expected = kind === "planner" ? "playwright_test_planner" : "playwright_test_generator";
  const namePattern = new RegExp('^name\\s*=\\s*"' + expected + '"\\s*$', "m");
  const name = namePattern.test(source);
  const readOnly = /^sandbox_mode\s*=\s*"read-only"\s*$/m.test(source);
  const mcp = /\[mcp_servers\.playwright-test\]/.test(source) && /run-test-mcp-server/.test(source);
  const forbidden = /playwright_test_healer|test\.fixme\s*\(|test\.skip\s*\(/.test(source);
  return { name, readOnly, mcp, forbidden, valid: name && readOnly && mcp && !forbidden };
}
/** @param {string} source @param {"planner"|"generator"} kind */
function inspectAgentPrompt(source, kind) {
  const expected = kind === "planner" ? "playwright-test-planner" : "playwright-test-generator";
  const agentPattern = new RegExp("^agent:\\s*" + expected + "\\s*$", "m");
  const agent = agentPattern.test(source);
  const forbidden = /playwright-test-healer|<heal>|test\.fixme|test\.skip/.test(source);
  return { agent, forbidden, valid: agent && !forbidden };
}
/** @param {string} root @param {any} policy @param {string} expectedCommit */
export function inspectPlaywrightAgentWorkspace(root, policy, expectedCommit) {
  if (!isFullObjectId(expectedCommit)) throw new Error("expectedCommit must be a full Git object id");
  const worktree = inspectLinkedWorktree(root, expectedCommit);
  const packageFile = absoluteInside(worktree.root, "node_modules/@playwright/test/package.json");
  let packageJson;
  try { packageJson = JSON.parse(readRegularText(packageFile, 1024 * 1024)); }
  catch { throw new Error("installed Playwright package metadata is unavailable or invalid"); }
  const installedVersion = text(packageJson.version, 64);
  const versionMatches = installedVersion === policy.expectedPlaywrightVersion;

  const plannerDefinitionSource = readRegularText(absoluteInside(worktree.root, policy.plannerDefinition), MAX_FILE_BYTES);
  const generatorDefinitionSource = readRegularText(absoluteInside(worktree.root, policy.generatorDefinition), MAX_FILE_BYTES);
  const plannerPromptSource = readRegularText(absoluteInside(worktree.root, policy.plannerPrompt), MAX_FILE_BYTES);
  const generatorPromptSource = readRegularText(absoluteInside(worktree.root, policy.generatorPrompt), MAX_FILE_BYTES);
  readRegularText(absoluteInside(worktree.root, policy.configFile), MAX_FILE_BYTES);
  readRegularText(absoluteInside(worktree.root, policy.seedFile), MAX_FILE_BYTES);
  const plannerDefinition = inspectAgentDefinition(plannerDefinitionSource, "planner");
  const generatorDefinition = inspectAgentDefinition(generatorDefinitionSource, "generator");
  const plannerPrompt = inspectAgentPrompt(plannerPromptSource, "planner");
  const generatorPrompt = inspectAgentPrompt(generatorPromptSource, "generator");
  const status = versionMatches && plannerDefinition.valid && generatorDefinition.valid && plannerPrompt.valid && generatorPrompt.valid ? "PASS" : "FAIL";

  return {
    version: 1,
    repository: policy.repository,
    expectedCommit,
    status,
    worktree: { linked: true, clean: worktree.clean },
    playwright: { expectedVersion: policy.expectedPlaywrightVersion, installedVersion, versionMatches },
    agents: { planner: plannerDefinition, generator: generatorDefinition, healerAuthorized: false },
    prompts: { planner: plannerPrompt, generator: generatorPrompt, coveragePromptAuthorized: false },
    initPlan: {
      executable: "node_modules/.bin/playwright",
      args: ["init-agents", "--loop=" + policy.loop, "--prompts", "--config", policy.configFile],
      executionPerformed: false,
    },
    sourceMutationAuthorized: false,
    healerAuthorized: false,
    semantics: "workspace readiness inspection only; planner and generator are authorized, healer and coverage-heal workflow are not authorized, and init command is declarative rather than executed",
  };
}
/** @param {string} plan @param {any} policy */
export function validatePlaywrightAgentPlan(plan, policy) {
  if (Buffer.byteLength(plan, "utf8") > policy.maxPlanBytes) {
    return { valid: false, scenarios: 0, errors: ["plan exceeds maxPlanBytes"] };
  }
  const escapedSeed = policy.seedFile.replace(/[.*+?^$()|[\]\\]/g, "\\$&");
  const seedPattern = new RegExp("\\*\\*Seed:\\*\\*\\s*`" + escapedSeed + "`", "g");
  const seeds = [...plan.matchAll(seedPattern)].length;
  const scenarios = [...plan.matchAll(/^####\s+\d+(?:\.\d+)*\s+.+$/gm)].length;
  const hasSteps = /^\*\*Steps:\*\*/m.test(plan);
  const hasExpected = /^\*\*Expected Results?:\*\*/m.test(plan);
  const forbidden = /\bskip(?:ped)?\b|\bfixme\b|\bxfail\b/i.test(plan);
  const errors = [];
  if (seeds === 0) errors.push("plan does not bind the configured seed file");
  if (scenarios === 0) errors.push("plan contains no numbered generated scenarios");
  if (!hasSteps) errors.push("plan contains no Steps section");
  if (!hasExpected) errors.push("plan contains no Expected Results section");
  if (forbidden) errors.push("plan contains skip/fixme/xfail language");
  return { valid: errors.length === 0, scenarios, errors };
}
/** @param {ts.Expression} expression @param {ts.SourceFile} sourceFile */
function expressionText(expression, sourceFile) {
  return expression.getText(sourceFile).replace(/\s+/g, "");
}
/** @param {ts.SourceFile} sourceFile */
function auditPlaywrightAst(sourceFile) {
  let testCalls = 0;
  let expectCalls = 0;
  /** @type {string[]} */ const forbidden = [];
  /** @param {ts.Node} node */
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = expressionText(node.expression, sourceFile);
      if (callee === "test") testCalls += 1;
      if (callee === "expect") expectCalls += 1;
      if (/^(?:test|testInfo)(?:\.[A-Za-z0-9_$]+)*\.(?:skip|fixme|only|fail)$/.test(callee)) forbidden.push(callee);
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { testCalls, expectCalls, forbidden: [...new Set(forbidden)].sort() };
}
/** @param {string} root @param {string} relative @param {any} policy */
function auditGeneratedTest(root, relative, policy) {
  const absolute = absoluteInside(root, relative);
  const source = readRegularText(absolute, policy.maxTestBytes);
  const extension = path.extname(relative).toLowerCase();
  if (![".ts",".tsx",".js",".jsx",".mjs",".cjs"].includes(extension)) throw new Error("generated Playwright test extension is unsupported");
  const scriptKind = extension.includes("ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const sourceFile = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, scriptKind);
  const parseDiagnostics = /** @type {any} */ (sourceFile).parseDiagnostics;
  if (Array.isArray(parseDiagnostics) && parseDiagnostics.length > 0) throw new Error("generated Playwright test has syntax errors");

  const specMatch = /^\/\/\s*spec:\s*(\S+)\s*$/m.exec(source);
  const seedMatch = /^\/\/\s*seed:\s*(\S+)\s*$/m.exec(source);
  const ast = auditPlaywrightAst(sourceFile);
  const errors = [];
  if (!specMatch || specMatch[1] !== policy.planFile) errors.push("generated test must bind exact configured spec file");
  if (!seedMatch || seedMatch[1] !== policy.seedFile) errors.push("generated test must bind exact configured seed file");
  if (ast.testCalls < 1) errors.push("generated test contains no test() case");
  if (ast.expectCalls < 1) errors.push("generated test contains no expect() assertion");
  if (ast.forbidden.length > 0) errors.push("generated test contains forbidden disabled/focused/expected-failure calls: " + ast.forbidden.join(","));
  return { file: relative, valid: errors.length === 0, testCalls: ast.testCalls, expectCalls: ast.expectCalls, forbiddenCalls: ast.forbidden, errors };
}
/** @param {string} root @param {string} relativeRoot @param {number} maxFiles */
function generatedFiles(root, relativeRoot, maxFiles) {
  const absoluteRoot = absoluteInside(root, relativeRoot);
  let stat;
  try { stat = fs.lstatSync(absoluteRoot); } catch { throw new Error("generated Playwright test root is unavailable"); }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("generated Playwright test root must be a regular directory");
  const output = [];
  const stack = [absoluteRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    for (const name of fs.readdirSync(current).sort()) {
      const absolute = path.join(current, name);
      const child = fs.lstatSync(absolute);
      if (child.isSymbolicLink()) throw new Error("generated Playwright test root must not contain symlinks");
      if (child.isDirectory()) { stack.push(absolute); continue; }
      if (!child.isFile()) throw new Error("generated Playwright test root contains unsupported special files");
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      if (/\.spec\.(?:[cm]?[jt]sx?)$/.test(relative)) output.push(relative);
      if (output.length > maxFiles) throw new Error("generated Playwright test count exceeds policy maxGeneratedFiles");
    }
  }
  return output.sort();
}
/** @param {string} root @param {any} policy @param {string} expectedCommit */
export function auditPlaywrightGeneratedTests(root, policy, expectedCommit) {
  const workspace = inspectPlaywrightAgentWorkspace(root, policy, expectedCommit);
  const resolvedRoot = path.resolve(root);
  const plan = readRegularText(absoluteInside(resolvedRoot, policy.planFile), policy.maxPlanBytes);
  const planAudit = validatePlaywrightAgentPlan(plan, policy);
  const files = generatedFiles(resolvedRoot, policy.generatedTestRoot, policy.maxGeneratedFiles);
  const tests = files.map((file) => auditGeneratedTest(resolvedRoot, file, policy));
  const status = workspace.status === "PASS" && planAudit.valid && files.length > 0 && tests.every((item) => item.valid) ? "PASS" : "FAIL";
  return {
    version: 1,
    repository: policy.repository,
    expectedCommit,
    status,
    workspace,
    plan: { file: policy.planFile, ...planAudit },
    generated: { root: policy.generatedTestRoot, files: tests },
    plannerAuthorized: true,
    generatorAuthorized: true,
    healerAuthorized: false,
    generatedTestsApproved: status === "PASS",
    executionPerformed: false,
    semantics: "artifact audit only; planner and generator are authorized, generated tests require explicit assertions and exact plan/seed binding, and disabled/focused/expected-failure constructs are blocking",
  };
}
/** @param {string} filename */
function readJson(filename) {
  try { return JSON.parse(readRegularText(path.resolve(filename), MAX_FILE_BYTES)); }
  catch { throw new Error("Playwright agent policy cannot be read or parsed"); }
}
/** @param {any} report */
export function formatPlaywrightAgentIntegration(report) {
  const lines = [
    "Playwright Planner/Generator Integration v1", "",
    "Repository: " + report.repository,
    "Commit: " + report.expectedCommit,
    "Status: " + report.status,
    "Playwright: " + report.workspace.playwright.installedVersion,
    "Planner authorized: " + String(report.plannerAuthorized ?? true),
    "Generator authorized: " + String(report.generatorAuthorized ?? true),
    "Healer authorized: false",
  ];
  if (report.plan) {
    lines.push("Plan: " + report.plan.file + " scenarios=" + report.plan.scenarios + " valid=" + report.plan.valid);
    lines.push("Generated tests: " + report.generated.files.length);
  }
  lines.push("", "Semantics: " + (report.semantics ?? report.workspace.semantics));
  return lines.join("\n");
}
/** @param {string[]} argv */
function parse(argv) {
  const mode = argv[0];
  if (!["inspect","audit"].includes(mode ?? "")) return null;
  const values = new Map();
  let json = false;
  const allowed = new Set(["--root","--policy","--expected-commit"]);
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") { if (json) return null; json = true; continue; }
    if (!allowed.has(arg ?? "") || values.has(arg)) return null;
    const next = argv[index + 1];
    if (typeof next !== "string" || next.startsWith("--")) return null;
    values.set(arg, next); index += 1;
  }
  for (const arg of allowed) if (!values.has(arg)) return null;
  return {
    mode,
    root: values.get("--root"),
    policy: values.get("--policy"),
    expectedCommit: values.get("--expected-commit"),
    json,
  };
}

export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) {
    console.error("Usage: node scripts/playwright-agent-integration.js <inspect|audit> --root <linked-worktree> --policy <policy.json> --expected-commit <full-sha> [--json]");
    return 1;
  }
  try {
    const policyResult = validatePlaywrightAgentPolicy(readJson(options.policy));
    if (!policyResult.valid || !policyResult.policy) throw new Error("Playwright agent integration policy is invalid");
    const report = options.mode === "inspect"
      ? inspectPlaywrightAgentWorkspace(options.root, policyResult.policy, options.expectedCommit)
      : auditPlaywrightGeneratedTests(options.root, policyResult.policy, options.expectedCommit);
    console.log(options.json ? JSON.stringify(report) : formatPlaywrightAgentIntegration(report));
    return report.status === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Playwright agent integration failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
