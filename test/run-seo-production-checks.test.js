import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  executeSeoProductionChecks,
  formatSeoProductionChecks,
  main,
  validateSeoPolicy,
} from "../scripts/run-seo-production-checks.js";

/** @returns {any} */
function rawPolicy() {
  return {
    version: 1,
    suite: "public-seo",
    site: null,
    routes: [{
      id: "homepage",
      url: "https://example.com/",
      expectedStatuses: [200],
      timeoutMs: 5000,
      title: { required: true, minLength: 3, maxLength: 70 },
      description: { required: true, minLength: 10, maxLength: 180 },
      expectedCanonical: "https://example.com/",
      allowNoindex: false,
      requiredHreflang: ["en", "nl"],
      requiredStructuredDataTypes: ["WebSite"],
      checkInternalLinks: true,
      maxInternalLinks: 10,
    }],
  };
}
function policy(raw = rawPolicy()) {
  const result = validateSeoPolicy(raw);
  assert.equal(result.ok, true);
  if (!result.ok || !result.policy) throw new Error("policy fixture invalid");
  return result.policy;
}

function cleanObservation(overrides = {}) {
  return {
    statusCode: 200,
    blockedMutations: 0,
    titleCount: 1,
    title: "Example Home",
    descriptionCount: 1,
    description: "A useful example homepage description.",
    canonicals: ["https://example.com/"],
    robots: ["index,follow"],
    xRobotsTag: "",
    hreflang: [
      { lang: "en", href: "https://example.com/" },
      { lang: "nl", href: "https://example.com/nl" },
    ],
    structuredTypes: ["WebSite"],
    malformedJsonLd: 0,
    internalLinks: ["https://example.com/about"],
    ...overrides,
  };
}

/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const filename = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}
test("policy accepts HTTPS and loopback routes and rejects unsafe public HTTP credentials and mixed origins", () => {
  assert.equal(validateSeoPolicy(rawPolicy()).ok, true);
  const loopback = rawPolicy(); loopback.routes[0].url = "http://127.0.0.1:4173/"; loopback.routes[0].expectedCanonical = "http://127.0.0.1:4173/";
  assert.equal(validateSeoPolicy(loopback).ok, true);
  const publicHttp = rawPolicy(); publicHttp.routes[0].url = "http://example.com/";
  assert.equal(validateSeoPolicy(publicHttp).ok, false);
  const credentials = rawPolicy(); credentials.routes[0].url = "https://user@example.com/";
  assert.equal(validateSeoPolicy(credentials).ok, false);
  const mixed = rawPolicy(); mixed.routes.push(structuredClone(mixed.routes[0])); mixed.routes[1].id = "other"; mixed.routes[1].url = "https://other.example/"; mixed.routes[1].expectedCanonical = "https://other.example/";
  assert.equal(validateSeoPolicy(mixed).ok, false);
});

test("policy rejects duplicate ids statuses languages unknown fields and invalid budgets", () => {
  const duplicate = rawPolicy(); duplicate.routes.push(structuredClone(duplicate.routes[0]));
  assert.equal(validateSeoPolicy(duplicate).ok, false);
  const statuses = rawPolicy(); statuses.routes[0].expectedStatuses = [200, 200];
  assert.equal(validateSeoPolicy(statuses).ok, false);
  const languages = rawPolicy(); languages.routes[0].requiredHreflang = ["en", "en"];
  assert.equal(validateSeoPolicy(languages).ok, false);
  const unknown = rawPolicy(); unknown.routes[0].headers = { authorization: "secret" };
  assert.equal(validateSeoPolicy(unknown).ok, false);
  const budget = rawPolicy(); budget.routes[0].title = { required: true, minLength: 80, maxLength: 70 };
  assert.equal(validateSeoPolicy(budget).ok, false);
});

test("clean SEO observation passes with explicit non destructive browser boundary", async () => {
  const report = await executeSeoProductionChecks(policy(), {
    observePage: async () => ({ ok: true, observation: cleanObservation() }),
    inspectLink: async () => ({ ok: true, statusCode: 200 }),
    now: () => "2026-09-16T20:00:00Z",
  });
  assert.equal(report.overallStatus, "PASS");
  assert.deepEqual(report.boundary.allowedRequestMethods, ["GET", "HEAD", "OPTIONS"]);
  assert.equal(report.boundary.credentialsConfigured, false);
  assert.equal(report.boundary.auxiliaryRedirectsFollowed, false);
});
test("metadata canonical and noindex failures are independently visible", async () => {
  const observations = [
    cleanObservation({ title: "x" }),
    cleanObservation({ descriptionCount: 0, description: "" }),
    cleanObservation({ canonicals: ["https://example.com/wrong"] }),
    cleanObservation({ robots: ["noindex,follow"] }),
  ];
  const expected = ["title-length-out-of-budget", "missing-description", "canonical-mismatch", "unexpected-noindex"];
  for (let index = 0; index < observations.length; index += 1) {
    const report = await executeSeoProductionChecks(policy(), {
      observePage: async () => ({ ok: true, observation: /** @type {any} */ (observations[index]) }),
      inspectLink: async () => ({ ok: true, statusCode: 200 }),
      now: () => "2026-09-16T20:00:00Z",
    });
    assert.equal(report.results[0]?.findings.includes(/** @type {string} */ (expected[index])), true);
  }
});

test("hreflang structured data malformed JSON-LD and status requirements block readiness", async () => {
  const report = await executeSeoProductionChecks(policy(), {
    observePage: async () => ({ ok: true, observation: cleanObservation({
      statusCode: 503,
      hreflang: [{ lang: "en", href: "https://example.com/" }],
      structuredTypes: [],
      malformedJsonLd: 1,
    }) }),
    inspectLink: async () => ({ ok: true, statusCode: 200 }),
    now: () => "2026-09-16T20:00:00Z",
  });
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.results[0]?.findings.includes("unexpected-route-status"), true);
  assert.equal(report.results[0]?.findings.includes("missing-hreflang:nl"), true);
  assert.equal(report.results[0]?.findings.includes("missing-structured-data:WebSite"), true);
  assert.equal(report.results[0]?.findings.includes("malformed-structured-data"), true);
});
test("broken internal links and link bounds fail without exposing response bodies", async () => {
  const broken = await executeSeoProductionChecks(policy(), {
    observePage: async () => ({ ok: true, observation: cleanObservation() }),
    inspectLink: async () => ({ ok: true, statusCode: 404, body: "secret page" }),
    now: () => "2026-09-16T20:00:00Z",
  });
  assert.equal(broken.results[0]?.findings.includes("broken-internal-links"), true);
  assert.equal(broken.results[0]?.internalLinks.broken, 1);
  assert.doesNotMatch(JSON.stringify(broken), /secret page/);

  const raw = rawPolicy(); raw.routes[0].maxInternalLinks = 1;
  const bounded = await executeSeoProductionChecks(policy(raw), {
    observePage: async () => ({ ok: true, observation: cleanObservation({ internalLinks: ["https://example.com/a", "https://example.com/b"] }) }),
    inspectLink: async () => ({ ok: true, statusCode: 200 }),
    now: () => "2026-09-16T20:00:00Z",
  });
  assert.equal(bounded.results[0]?.findings.includes("internal-link-limit-exceeded"), true);
});

test("robots sitemap declaration and route inventory are explicit site checks", async () => {
  const raw = rawPolicy();
  raw.site = {
    robotsUrl: "https://example.com/robots.txt",
    sitemapUrl: "https://example.com/sitemap.xml",
    requireSitemapDeclaration: true,
    requireRoutesInSitemap: true,
    maxSitemaps: 8,
    timeoutMs: 5000,
  };
  const fetchText = async (/** @type {string} */ url) => url.endsWith("robots.txt")
    ? { ok: true, statusCode: 200, body: "User-agent: *\nSitemap: https://example.com/sitemap.xml\n" }
    : { ok: true, statusCode: 200, body: "<urlset><url><loc>https://example.com/</loc></url></urlset>" };
  const report = await executeSeoProductionChecks(policy(raw), {
    observePage: async () => ({ ok: true, observation: cleanObservation() }),
    inspectLink: async () => ({ ok: true, statusCode: 200 }),
    fetchText,
    now: () => "2026-09-16T20:00:00Z",
  });
  assert.equal(report.site?.status, "PASS");
  assert.equal(report.overallStatus, "PASS");
});
test("site checks fail closed for missing robots declaration sitemap routes and auxiliary redirects", async () => {
  const raw = rawPolicy();
  raw.site = {
    robotsUrl: "https://example.com/robots.txt",
    sitemapUrl: "https://example.com/sitemap.xml",
    requireSitemapDeclaration: true,
    requireRoutesInSitemap: true,
    maxSitemaps: 8,
    timeoutMs: 5000,
  };
  const report = await executeSeoProductionChecks(policy(raw), {
    observePage: async () => ({ ok: true, observation: cleanObservation() }),
    inspectLink: async () => ({ ok: true, statusCode: 200 }),
    fetchText: async (url) => url.endsWith("robots.txt")
      ? { ok: true, statusCode: 200, body: "User-agent: *\n" }
      : { ok: false, statusCode: 302, body: "", error: "redirect-not-followed" },
    now: () => "2026-09-16T20:00:00Z",
  });
  assert.equal(report.site?.status, "FAIL");
  assert.equal(report.site?.findings.includes("sitemap-not-declared-in-robots"), true);
  assert.equal(report.site?.findings.includes("sitemap-unavailable-or-invalid"), true);
  assert.equal(report.site?.findings.includes("route-missing-from-sitemap:homepage"), true);
  assert.equal(report.overallStatus, "FAIL");
});

test("route and malformed observation failures are payload free", async () => {
  const failed = await executeSeoProductionChecks(policy(), {
    observePage: async () => ({ ok: false, error: "browser secret stack" }),
    now: () => "2026-09-16T20:00:00Z",
  });
  assert.deepEqual(failed.results[0]?.findings, ["seo-route-failed"]);
  assert.doesNotMatch(JSON.stringify(failed), /browser secret stack/);

  const malformed = await executeSeoProductionChecks(policy(), {
    observePage: async () => /** @type {any} */ ({ ok: true, observation: { statusCode: 200 } }),
    now: () => "2026-09-16T20:00:00Z",
  });
  assert.deepEqual(malformed.results[0]?.findings, ["seo-observation-invalid"]);
});
test("collection clock must be absolute", async () => {
  await assert.rejects(() => executeSeoProductionChecks(policy(), {
    observePage: async () => ({ ok: true, observation: cleanObservation() }),
    inspectLink: async () => ({ ok: true, statusCode: 200 }),
    now: () => "today",
  }), /absolute ISO timestamp/);
});

test("CLI emits JSON and preserves PASS FAIL semantics", async () => {
  const filename = tempJson("seo-policy", rawPolicy());
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(await main(["--policy", filename, "--json"], {
      observePage: async () => ({ ok: true, observation: cleanObservation() }),
      inspectLink: async () => ({ ok: true, statusCode: 200 }),
      now: () => "2026-09-16T20:00:00Z",
    }), 0);
  } finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  assert.equal(await main(["--policy", filename], {
    observePage: async () => ({ ok: true, observation: cleanObservation({ robots: ["noindex"] }) }),
    inspectLink: async () => ({ ok: true, statusCode: 200 }),
    now: () => "2026-09-16T20:00:00Z",
  }), 1);
  fs.rmSync(filename, { force: true });
});
test("CLI rejects malformed and incomplete policies", async () => {
  const malformed = tempJson("seo-bad", "{");
  assert.equal(await main(["--policy", malformed]), 1);
  assert.equal(await main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
});

test("human output exposes bounded findings and request boundary without page payload", async () => {
  const report = await executeSeoProductionChecks(policy(), {
    observePage: async () => ({ ok: true, observation: cleanObservation({ robots: ["noindex"] }) }),
    inspectLink: async () => ({ ok: true, statusCode: 200 }),
    now: () => "2026-09-16T20:00:00Z",
  });
  const output = formatSeoProductionChecks(report);
  assert.match(output, /unexpected-noindex/);
  assert.match(output, /GET\/HEAD\/OPTIONS only/);
  assert.doesNotMatch(output, /<html|<meta|application\/ld\+json/i);
});

test("SEO runner source has no environment subprocess credential or mutation surface", () => {
  const source = fs.readFileSync(new URL("../scripts/run-seo-production-checks.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /process\.env|node:child_process|spawnSync|execFile|httpCredentials|Authorization|extraHTTPHeaders/);
  assert.match(source, /serviceWorkers: "block"/);
  assert.match(source, /READ_METHODS/);
  assert.match(source, /redirect: "manual"/);
});
