import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  executeAccessibilityGates,
  formatAccessibilityGates,
  main,
  validateAccessibilityPolicy,
} from "../scripts/run-accessibility-gates.js";

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    suite: "critical-routes",
    routes: [{
      id: "homepage",
      url: "https://example.com/",
      expectedStatuses: [200],
      timeoutMs: 5000,
      tags: ["wcag2a", "wcag2aa", "wcag21aa"],
      maxCritical: 0,
      maxSerious: 0,
      maxModerate: 0,
      maxMinor: 0,
      maxUnknown: 0,
    }],
  };
}

function policy(raw = rawPolicy()) {
  const result = validateAccessibilityPolicy(raw);
  assert.equal(result.ok, true);
  if (!result.ok || !result.policy) throw new Error("policy fixture invalid");
  return result.policy;
}

function cleanObservation(overrides = {}) {
  return {
    statusCode: 200,
    blockedMutations: 0,
    counts: { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 },
    rules: [],
    ...overrides,
  };
}

/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const filename = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("policy requires explicit safe public routes tags and impact thresholds", () => {
  assert.equal(validateAccessibilityPolicy(rawPolicy()).ok, true);
  const loopback = rawPolicy(); loopback.routes[0].url = "http://127.0.0.1:4173/";
  assert.equal(validateAccessibilityPolicy(loopback).ok, true);
  const publicHttp = rawPolicy(); publicHttp.routes[0].url = "http://example.com/";
  assert.equal(validateAccessibilityPolicy(publicHttp).ok, false);
  const query = rawPolicy(); query.routes[0].url = "https://example.com/?x=1";
  assert.equal(validateAccessibilityPolicy(query).ok, false);
  const credentials = rawPolicy(); credentials.routes[0].url = "https://user@example.com/";
  assert.equal(validateAccessibilityPolicy(credentials).ok, false);
});

test("policy rejects duplicate ids statuses tags unknown fields and invalid thresholds", () => {
  const duplicate = rawPolicy(); duplicate.routes.push(structuredClone(duplicate.routes[0]));
  assert.equal(validateAccessibilityPolicy(duplicate).ok, false);
  const statuses = rawPolicy(); statuses.routes[0].expectedStatuses = [200, 200];
  assert.equal(validateAccessibilityPolicy(statuses).ok, false);
  const tags = rawPolicy(); tags.routes[0].tags.push("wcag2a");
  assert.equal(validateAccessibilityPolicy(tags).ok, false);
  const unknown = rawPolicy(); unknown.routes[0].headers = { authorization: "secret" };
  assert.equal(validateAccessibilityPolicy(unknown).ok, false);
  const negative = rawPolicy(); negative.routes[0].maxSerious = -1;
  assert.equal(validateAccessibilityPolicy(negative).ok, false);
});

test("clean axe observation passes with explicit non destructive browser boundary", async () => {
  const report = await executeAccessibilityGates(policy(), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation() }),
    now: () => "2026-09-16T19:30:00Z",
  });
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.engine.name, "axe-core");
  assert.match(report.engine.version, /^4\./);
  assert.deepEqual(report.boundary.allowedRequestMethods, ["GET", "HEAD", "OPTIONS"]);
  assert.equal(report.boundary.credentialsConfigured, false);
});

test("axe impact thresholds are independently enforced", async () => {
  /** @type {Array<"critical"|"serious"|"moderate"|"minor"|"unknown">} */
  const impacts = ["critical", "serious", "moderate", "minor", "unknown"];
  for (const impact of impacts) {
    const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 };
    counts[impact] = 2;
    const report = await executeAccessibilityGates(policy(), {
      observeRoute: async () => ({ ok: true, observation: cleanObservation({ counts, rules: [{ id: `rule-${impact}`, impact, nodes: 2 }] }) }),
      now: () => "2026-09-16T19:30:00Z",
    });
    assert.equal(report.overallStatus, "FAIL");
    assert.equal(report.results[0]?.findings.includes(`${impact}-violations`), true);
  }
});

test("explicit impact allowances permit bounded known debt while keeping rules visible", async () => {
  const raw = rawPolicy(); raw.routes[0].maxModerate = 2;
  const report = await executeAccessibilityGates(policy(raw), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation({ counts: { critical: 0, serious: 0, moderate: 2, minor: 0, unknown: 0 }, rules: [{ id: "color-contrast", impact: "moderate", nodes: 2 }] }) }),
    now: () => "2026-09-16T19:30:00Z",
  });
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.results[0]?.rules, [{ id: "color-contrast", impact: "moderate", nodes: 2 }]);
});

test("unexpected status and page initiated mutations are blocking", async () => {
  const status = await executeAccessibilityGates(policy(), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation({ statusCode: 503 }) }),
    now: () => "2026-09-16T19:30:00Z",
  });
  assert.equal(status.results[0]?.findings.includes("unexpected-route-status"), true);
  const mutation = await executeAccessibilityGates(policy(), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation({ blockedMutations: 1 }) }),
    now: () => "2026-09-16T19:30:00Z",
  });
  assert.equal(mutation.results[0]?.findings.includes("blocked-mutation-attempts"), true);
});

test("route failures and malformed observations fail closed without provider payload", async () => {
  const failed = await executeAccessibilityGates(policy(), {
    observeRoute: async () => ({ ok: false, error: "browser stack and secret response" }),
    now: () => "2026-09-16T19:30:00Z",
  });
  assert.deepEqual(failed.results[0]?.findings, ["accessibility-route-failed"]);
  assert.doesNotMatch(JSON.stringify(failed), /browser stack|secret response/);

  const inconsistent = await executeAccessibilityGates(policy(), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation({ counts: { critical: 1, serious: 0, moderate: 0, minor: 0, unknown: 0 }, rules: [] }) }),
    now: () => "2026-09-16T19:30:00Z",
  });
  assert.deepEqual(inconsistent.results[0]?.findings, ["accessibility-observation-invalid"]);
});

test("rule evidence is bounded unique and payload free", async () => {
  const duplicate = await executeAccessibilityGates(policy(), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation({ counts: { critical: 0, serious: 2, moderate: 0, minor: 0, unknown: 0 }, rules: [{ id: "label", impact: "serious", nodes: 1 }, { id: "label", impact: "serious", nodes: 1 }] }) }),
    now: () => "2026-09-16T19:30:00Z",
  });
  assert.deepEqual(duplicate.results[0]?.findings, ["accessibility-observation-invalid"]);
});

test("collection clock must be absolute", async () => {
  await assert.rejects(() => executeAccessibilityGates(policy(), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation() }),
    now: () => "today",
  }), /absolute ISO timestamp/);
});

test("CLI emits JSON and preserves PASS FAIL semantics with injected axe observations", async () => {
  const filename = tempJson("accessibility-policy", rawPolicy());
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(await main(["--policy", filename, "--json"], { observeRoute: async () => ({ ok: true, observation: cleanObservation() }), now: () => "2026-09-16T19:30:00Z" }), 0);
  } finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  assert.equal(await main(["--policy", filename], { observeRoute: async () => ({ ok: true, observation: cleanObservation({ counts: { critical: 1, serious: 0, moderate: 0, minor: 0, unknown: 0 }, rules: [{ id: "aria-required-attr", impact: "critical", nodes: 1 }] }) }), now: () => "2026-09-16T19:30:00Z" }), 1);
  fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed and incomplete policies", async () => {
  const malformed = tempJson("accessibility-bad", "{");
  assert.equal(await main(["--policy", malformed]), 1);
  assert.equal(await main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("human output exposes rule ids counts and browser boundary without DOM payload", async () => {
  const raw = rawPolicy(); raw.routes[0].maxSerious = 1;
  const report = await executeAccessibilityGates(policy(raw), {
    observeRoute: async () => ({ ok: true, observation: cleanObservation({ counts: { critical: 0, serious: 1, moderate: 0, minor: 0, unknown: 0 }, rules: [{ id: "button-name", impact: "serious", nodes: 1 }] }) }),
    now: () => "2026-09-16T19:30:00Z",
  });
  const text = formatAccessibilityGates(report);
  assert.match(text, /axe-core/);
  assert.match(text, /button-name/);
  assert.match(text, /GET\/HEAD\/OPTIONS only/);
  assert.doesNotMatch(text, /<button|html>/i);
});

test("accessibility runner source has no environment subprocess credential or page mutation surface", () => {
  const source = fs.readFileSync(new URL("../scripts/run-accessibility-gates.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.env|node:child_process|spawnSync|execFile|httpCredentials|Authorization|extraHTTPHeaders/);
  assert.match(source, /axe\.source/);
  assert.match(source, /serviceWorkers: "block"/);
  assert.match(source, /READ_METHODS/);
});
