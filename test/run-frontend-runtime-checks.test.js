import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  executeFrontendRuntimeChecks,
  formatFrontendRuntimeChecks,
  main,
  validateFrontendRuntimePolicy,
} from "../scripts/run-frontend-runtime-checks.js";

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    suite: "frontend-core",
    hydrationMarkers: ["hydration failed", "did not match"],
    routes: [{
      id: "homepage",
      url: "https://example.com/",
      expectedStatuses: [200],
      timeoutMs: 5000,
      maxConsoleErrors: 0,
      maxPageErrors: 0,
      maxFailedAssets: 0,
      maxFailedRequests: 0,
      maxHydrationErrors: 0,
      maxCspViolations: 0,
      maxBlockedMutations: 0,
    }],
  };
}

function policy(raw = rawPolicy()) {
  const result = validateFrontendRuntimePolicy(raw);
  assert.equal(result.ok, true);
  if (!result.ok || !result.policy) throw new Error("policy fixture invalid");
  return result.policy;
}

function cleanObservation(overrides = {}) {
  return {
    statusCode: 200,
    consoleErrors: 0,
    pageErrors: 0,
    failedAssets: 0,
    failedRequests: 0,
    hydrationErrors: 0,
    cspViolations: 0,
    blockedMutations: 0,
    ...overrides,
  };
}

/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const filename = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("policy validates explicit safe public routes and bounded thresholds", () => {
  assert.equal(validateFrontendRuntimePolicy(rawPolicy()).ok, true);
  const loopback = rawPolicy(); loopback.routes[0].url = "http://127.0.0.1:4173/";
  assert.equal(validateFrontendRuntimePolicy(loopback).ok, true);
  const publicHttp = rawPolicy(); publicHttp.routes[0].url = "http://example.com/";
  assert.equal(validateFrontendRuntimePolicy(publicHttp).ok, false);
  const query = rawPolicy(); query.routes[0].url = "https://example.com/?danger=1";
  assert.equal(validateFrontendRuntimePolicy(query).ok, false);
  const credentials = rawPolicy(); credentials.routes[0].url = "https://user@example.com/";
  assert.equal(validateFrontendRuntimePolicy(credentials).ok, false);
});

test("policy rejects duplicate routes markers statuses and unsupported fields", () => {
  const duplicateRoute = rawPolicy(); duplicateRoute.routes.push(structuredClone(duplicateRoute.routes[0]));
  assert.equal(validateFrontendRuntimePolicy(duplicateRoute).ok, false);
  const duplicateMarker = rawPolicy(); duplicateMarker.hydrationMarkers.push("HYDRATION FAILED");
  assert.equal(validateFrontendRuntimePolicy(duplicateMarker).ok, false);
  const duplicateStatus = rawPolicy(); duplicateStatus.routes[0].expectedStatuses = [200, 200];
  assert.equal(validateFrontendRuntimePolicy(duplicateStatus).ok, false);
  const unknown = rawPolicy(); unknown.routes[0].headers = { authorization: "secret" };
  assert.equal(validateFrontendRuntimePolicy(unknown).ok, false);
});

test("clean route observations PASS and expose the non destructive browser boundary", async () => {
  const report = await executeFrontendRuntimeChecks(policy(), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation() }),
    now: () => "2026-09-16T19:00:00Z",
  });
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.boundary.allowedRequestMethods, ["GET", "HEAD", "OPTIONS"]);
  assert.equal(report.boundary.crossOriginNavigationBlocked, true);
  assert.equal(report.boundary.serviceWorkersBlocked, true);
  assert.equal(report.boundary.credentialsConfigured, false);
});

test("unexpected status and each runtime defect class are blocking route findings", async () => {
  /** @type {Array<[string, number, string]>} */
  const fields = [
    ["statusCode", 503, "unexpected-route-status"],
    ["consoleErrors", 1, "console-errors"],
    ["pageErrors", 1, "page-errors"],
    ["failedAssets", 1, "failed-assets"],
    ["failedRequests", 1, "failed-requests"],
    ["hydrationErrors", 1, "hydration-errors"],
    ["cspViolations", 1, "csp-violations"],
    ["blockedMutations", 1, "blocked-mutation-attempts"],
  ];
  for (const [field, value, finding] of fields) {
    const report = await executeFrontendRuntimeChecks(policy(), {
      observeRoute: async () => ({ ok: true, observation: cleanObservation({ [field]: value }) }),
      now: () => "2026-09-16T19:00:00Z",
    });
    assert.equal(report.overallStatus, "FAIL");
    assert.equal(report.results[0]?.findings.includes(String(finding)), true);
  }
});

test("thresholds permit explicitly tolerated runtime noise without hiding counts", async () => {
  const raw = rawPolicy();
  raw.routes[0].maxConsoleErrors = 2;
  raw.routes[0].maxFailedRequests = 1;
  const report = await executeFrontendRuntimeChecks(policy(raw), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation({ consoleErrors: 2, failedRequests: 1 }) }),
    now: () => "2026-09-16T19:00:00Z",
  });
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.results[0]?.metrics?.consoleErrors, 2);
  assert.equal(report.results[0]?.metrics?.failedRequests, 1);
});

test("navigation failures and malformed observations fail closed without provider detail", async () => {
  const failed = await executeFrontendRuntimeChecks(policy(), {
    observeRoute: async () => ({ ok: false, error: "ECONNREFUSED secret upstream detail" }),
    now: () => "2026-09-16T19:00:00Z",
  });
  assert.equal(failed.overallStatus, "FAIL");
  assert.deepEqual(failed.results[0]?.findings, ["route-navigation-failed"]);
  assert.doesNotMatch(JSON.stringify(failed), /ECONNREFUSED|secret upstream/);

  const invalid = await executeFrontendRuntimeChecks(policy(), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation({ statusCode: 999 }) }),
    now: () => "2026-09-16T19:00:00Z",
  });
  assert.deepEqual(invalid.results[0]?.findings, ["route-observation-invalid"]);
});

test("multiple routes are isolated and deterministically ordered by policy validation", async () => {
  const raw = rawPolicy();
  const second = structuredClone(raw.routes[0]);
  second.id = "admin-login";
  second.url = "https://example.com/admin/login";
  raw.routes.push(second);
  const checked = policy(raw);
  assert.deepEqual(checked.routes.map((route) => route.id), ["admin-login", "homepage"]);
  const report = await executeFrontendRuntimeChecks(checked, {
    observeRoute: async (route) => route.id === "homepage" ? { ok: true, observation: cleanObservation({ consoleErrors: 1 }) } : { ok: true, observation: cleanObservation() },
    now: () => "2026-09-16T19:00:00Z",
  });
  assert.equal(report.summary.pass, 1);
  assert.equal(report.summary.fail, 1);
});

test("collection clock must be an absolute timestamp", async () => {
  await assert.rejects(() => executeFrontendRuntimeChecks(policy(), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation() }),
    now: () => "today",
  }), /absolute ISO timestamp/);
});

test("CLI emits JSON and preserves PASS FAIL exit semantics with injected browser observations", async () => {
  const filename = tempJson("frontend-runtime-policy", rawPolicy());
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(await main(["--policy", filename, "--json"], {
      observeRoute: async () => ({ ok: true, observation: cleanObservation() }),
      now: () => "2026-09-16T19:00:00Z",
    }), 0);
  } finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  assert.equal(await main(["--policy", filename], {
    observeRoute: async () => ({ ok: true, observation: cleanObservation({ failedAssets: 1 }) }),
    now: () => "2026-09-16T19:00:00Z",
  }), 1);
  fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed and incomplete policy input", async () => {
  const malformed = tempJson("frontend-runtime-bad", "{");
  assert.equal(await main(["--policy", malformed]), 1);
  assert.equal(await main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("human output exposes bounded counts and safety boundary without console payloads", async () => {
  const report = await executeFrontendRuntimeChecks(policy(), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation({ consoleErrors: 1 }) }),
    now: () => "2026-09-16T19:00:00Z",
  });
  const text = formatFrontendRuntimeChecks(report);
  assert.match(text, /GET\/HEAD\/OPTIONS only/);
  assert.match(text, /console=1/);
  assert.match(text, /console-errors/);
});

test("frontend runtime source has no environment subprocess or credential configuration surface", () => {
  const source = fs.readFileSync(new URL("../scripts/run-frontend-runtime-checks.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.env|node:child_process|spawnSync|execFile|httpCredentials|Authorization|extraHTTPHeaders/);
  assert.match(source, /serviceWorkers: "block"/);
  assert.match(source, /securitypolicyviolation/);
  assert.match(source, /READ_METHODS/);
});
