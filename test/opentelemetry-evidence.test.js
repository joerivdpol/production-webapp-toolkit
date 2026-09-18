import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  adaptOpenTelemetryEvidence,
  formatOpenTelemetryEvidence,
  main,
  validateOpenTelemetryAdapterPolicy,
} from "../scripts/opentelemetry-evidence.js";

const COMMIT = "a".repeat(40);
const COLLECTED = "2026-09-18T06:15:00Z";
/** @param {string} iso */
const NS = (iso) => String(BigInt(Date.parse(iso)) * 1000000n);
const T1 = NS("2026-09-18T06:10:00Z");
const T2 = NS("2026-09-18T06:11:00Z");
const TRACE = "A".repeat(32);
const SPAN = "B".repeat(16);

/** @returns {any} */
function attrs() {
  return [
    { key: "service.name", value: { stringValue: "web" } },
    { key: "deployment.environment.name", value: { stringValue: "production" } },
    { key: "host.name", value: { stringValue: "private-host-should-not-persist" } },
  ];
}
/** @returns {any} */
function runtime() {
  return {
    version: 1,
    runtime: { name: "web", environment: "production" },
    deployment: { commit: COMMIT },
    evidence: { source: "runtime-collector", authenticated: false, collectedAt: "2026-09-18T06:09:00Z" },
  };
}
/** @returns {any} */
function policy(overrides = {}) {
  return {
    version: 1,
    limits: {
      maxSpans: 10,
      maxMetrics: 10,
      maxDataPoints: 20,
      maxLogs: 10,
      ...overrides,
    },
  };
}
/** @returns {any} */
function traces() {
  return {
    resourceSpans: [{
      resource: { attributes: attrs(), droppedAttributesCount: 0 },
      scopeSpans: [{
        scope: { name: "example", version: "1.0.0" },
        spans: [{
          traceId: TRACE,
          spanId: SPAN,
          name: "GET /items",
          kind: 2,
          startTimeUnixNano: T1,
          endTimeUnixNano: T2,
          status: { code: 2, message: "synthetic failure" },
          attributes: [{ key: "user.email", value: { stringValue: "should-not-persist@example.invalid" } }],
          events: [{ name: "exception", timeUnixNano: T1 }],
          links: [],
        }],
      }],
      unknownFutureField: { ignored: true },
    }],
  };
}
/** @returns {any} */
function metrics() {
  return {
    resourceMetrics: [{
      resource: { attributes: attrs() },
      scopeMetrics: [{
        scope: { name: "example" },
        metrics: [
          {
            name: "http.server.request.duration",
            unit: "ms",
            histogram: {
              dataPoints: [{
                timeUnixNano: T2,
                count: "2",
                sum: 30,
                bucketCounts: ["1", "1"],
                explicitBounds: [10],
                attributes: [{ key: "route", value: { stringValue: "/private" } }],
                exemplars: [{ traceId: TRACE, spanId: SPAN, timeUnixNano: T1, asDouble: 12 }],
              }],
            },
          },
          {
            name: "queue.depth",
            gauge: { dataPoints: [{ timeUnixNano: T2, asInt: "4" }] },
          },
        ],
      }],
    }],
  };
}
/** @returns {any} */
function logs() {
  return {
    resourceLogs: [{
      resource: { attributes: attrs() },
      scopeLogs: [{
        scope: { name: "example" },
        logRecords: [{
          timeUnixNano: T2,
          observedTimeUnixNano: T2,
          severityNumber: 17,
          severityText: "ERROR",
          body: { stringValue: "private log body that must never persist" },
          attributes: [{ key: "customer.email", value: { stringValue: "hidden@example.invalid" } }],
          traceId: TRACE,
          spanId: SPAN,
        }],
      }],
    }],
  };
}
test("adapter policy validates explicit bounded signal limits", () => {
  assert.equal(validateOpenTelemetryAdapterPolicy(policy()).valid, true);
  assert.equal(validateOpenTelemetryAdapterPolicy({ version: 1, limits: { ...policy().limits, maxSpans: 0 } }).valid, false);
  assert.equal(validateOpenTelemetryAdapterPolicy({ ...policy(), endpoint: "http://127.0.0.1:4318" }).valid, false);
});

test("OTLP JSON adapts traces metrics and logs into bounded evidence", () => {
  const evidence = adaptOpenTelemetryEvidence(runtime(), policy(), { traces: traces(), metrics: metrics(), logs: logs() }, COLLECTED);
  assert.equal(evidence.signals.traces.spanCount, 1);
  assert.equal(evidence.signals.traces.errorSpanCount, 1);
  assert.equal(evidence.signals.metrics.metricCount, 2);
  assert.equal(evidence.signals.metrics.dataPointCount, 2);
  assert.equal(evidence.signals.logs.recordCount, 1);
  assert.equal(evidence.signals.logs.errorOrFatalRecordCount, 1);
  assert.equal(evidence.signals.logs.correlatedRecordCount, 1);
  assert.equal(evidence.deployment.commit, COMMIT);
  assert.equal(evidence.evidence.authenticated, false);
});

test("trace and log correlation ids normalize case-insensitive OTLP hex to lowercase", () => {
  const evidence = adaptOpenTelemetryEvidence(runtime(), policy(), { traces: traces(), metrics: metrics(), logs: logs() }, COLLECTED);
  assert.equal(evidence.signals.traces.records[0]?.traceId, TRACE.toLowerCase());
  assert.equal(evidence.signals.traces.records[0]?.spanId, SPAN.toLowerCase());
  assert.equal(evidence.signals.logs.records[0]?.traceId, TRACE.toLowerCase());
  assert.equal(evidence.signals.logs.records[0]?.spanId, SPAN.toLowerCase());
});
test("privacy projection excludes raw log bodies and arbitrary attributes events links and exemplars", () => {
  const evidence = adaptOpenTelemetryEvidence(runtime(), policy(), { traces: traces(), metrics: metrics(), logs: logs() }, COLLECTED);
  const serialized = JSON.stringify(evidence);
  for (const forbidden of ["private log body", "should-not-persist@example.invalid", "hidden@example.invalid", "private-host-should-not-persist", "exception", "asDouble"]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.deepEqual(evidence.privacy.persistedResourceAttributes, ["service.name", "deployment.environment.name"]);
  assert.equal(evidence.privacy.logBodiesPersisted, false);
  assert.equal(evidence.privacy.spanAttributesPersisted, false);
  assert.equal(evidence.privacy.metricPointAttributesPersisted, false);
});

test("resource service and environment must match Runtime Evidence identity", () => {
  const service = traces(); service.resourceSpans[0].resource.attributes[0].value.stringValue = "other";
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: service, metrics: metrics(), logs: logs() }, COLLECTED), /service.name/);
  const environment = logs(); environment.resourceLogs[0].resource.attributes[1].value.stringValue = "staging";
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: traces(), metrics: metrics(), logs: environment }, COLLECTED), /deployment.environment.name/);
});

test("adapter accepts OTLP unknown fields without persisting them", () => {
  const t = traces(); t.resourceSpans[0].scopeSpans[0].spans[0].futureField = "future-private-value";
  const evidence = adaptOpenTelemetryEvidence(runtime(), policy(), { traces: t, metrics: metrics(), logs: logs() }, COLLECTED);
  assert.equal(evidence.signals.traces.spanCount, 1);
  assert.equal(JSON.stringify(evidence).includes("future-private-value"), false);
});
test("future span log and metric timestamps fail closed", () => {
  const future = NS("2026-09-18T06:20:00Z");
  const t = traces(); t.resourceSpans[0].scopeSpans[0].spans[0].endTimeUnixNano = future;
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: t, metrics: metrics(), logs: logs() }, COLLECTED), /span identity/);
  const m = metrics(); m.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0].timeUnixNano = future;
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: traces(), metrics: m, logs: logs() }, COLLECTED), /future-dated/);
  const l = logs(); l.resourceLogs[0].scopeLogs[0].logRecords[0].timeUnixNano = future;
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: traces(), metrics: metrics(), logs: l }, COLLECTED), /future-dated/);
});

test("signal limits fail closed before unbounded projection", () => {
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy({ maxSpans: 1 }), {
    traces: { resourceSpans: [{ resource: { attributes: attrs() }, scopeSpans: [{ spans: [...traces().resourceSpans[0].scopeSpans[0].spans, { ...traces().resourceSpans[0].scopeSpans[0].spans[0], spanId: "C".repeat(16) }] }] }] },
    metrics: metrics(), logs: logs(),
  }, COLLECTED), /span count/);
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy({ maxMetrics: 1 }), { traces: traces(), metrics: metrics(), logs: logs() }, COLLECTED), /metric is invalid or exceeds/);
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy({ maxDataPoints: 1 }), { traces: traces(), metrics: metrics(), logs: logs() }, COLLECTED), /data point count/);
});
test("invalid trace context and span chronology fail closed", () => {
  const badTrace = traces(); badTrace.resourceSpans[0].scopeSpans[0].spans[0].traceId = "not-hex";
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: badTrace, metrics: metrics(), logs: logs() }, COLLECTED), /span identity/);
  const chronology = traces(); chronology.resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano = T2; chronology.resourceSpans[0].scopeSpans[0].spans[0].endTimeUnixNano = T1;
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: chronology, metrics: metrics(), logs: logs() }, COLLECTED), /span identity/);
  const badLog = logs(); badLog.resourceLogs[0].scopeLogs[0].logRecords[0].traceId = ""; badLog.resourceLogs[0].scopeLogs[0].logRecords[0].spanId = SPAN;
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: traces(), metrics: metrics(), logs: badLog }, COLLECTED), /trace context/);
});

test("all-zero trace and span ids fail closed", () => {
  const zeroTrace = traces(); zeroTrace.resourceSpans[0].scopeSpans[0].spans[0].traceId = "0".repeat(32);
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: zeroTrace, metrics: metrics(), logs: logs() }, COLLECTED), /span identity/);
  const zeroSpan = traces(); zeroSpan.resourceSpans[0].scopeSpans[0].spans[0].spanId = "0".repeat(16);
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: zeroSpan, metrics: metrics(), logs: logs() }, COLLECTED), /span identity/);
  const zeroLog = logs(); zeroLog.resourceLogs[0].scopeLogs[0].logRecords[0].traceId = "0".repeat(32);
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: traces(), metrics: metrics(), logs: zeroLog }, COLLECTED), /trace context/);
});

test("metric data points require observation timeUnixNano", () => {
  const raw = metrics(); delete raw.resourceMetrics[0].scopeMetrics[0].metrics[0].histogram.dataPoints[0].timeUnixNano;
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: traces(), metrics: raw, logs: logs() }, COLLECTED), /requires valid non-future timeUnixNano/);
});

test("metric requires exactly one supported OTLP data field", () => {
  const raw = metrics(); raw.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge = { dataPoints: [] };
  assert.throws(() => adaptOpenTelemetryEvidence(runtime(), policy(), { traces: traces(), metrics: raw, logs: logs() }, COLLECTED), /exactly one/);
});

test("Runtime Evidence collection cannot be later than adapter collection", () => {
  const raw = runtime(); raw.evidence.collectedAt = "2026-09-18T06:20:00Z";
  assert.throws(() => adaptOpenTelemetryEvidence(raw, policy(), { traces: traces(), metrics: metrics(), logs: logs() }, COLLECTED), /cannot exceed/);
});
/** @param {string} prefix @param {any} value */
function tempJson(prefix, value) {
  const file = path.join(os.tmpdir(), `${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(file, JSON.stringify(value)); return file;
}
test("CLI composes explicit local OTLP JSON files without network", () => {
  const files = [
    tempJson("otel-runtime", runtime()), tempJson("otel-policy", policy()), tempJson("otel-traces", traces()),
    tempJson("otel-metrics", metrics()), tempJson("otel-logs", logs()),
  ];
  const originalLog = console.log, originalError = console.error; let stdout = "", stderr = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; }; console.error = (...values) => { stderr += `${values.join(" ")}\n`; };
  try {
    const [runtimeFile, policyFile, tracesFile, metricsFile, logsFile] = files;
    if (!runtimeFile || !policyFile || !tracesFile || !metricsFile || !logsFile) throw new Error("fixture missing");
    const code = main(["--runtime-evidence", runtimeFile, "--policy", policyFile, "--traces", tracesFile, "--metrics", metricsFile, "--logs", logsFile, "--collected-at", COLLECTED, "--json"]);
    assert.equal(code, 0); assert.equal(stderr, "");
    const evidence = JSON.parse(stdout); assert.equal(evidence.signals.traces.spanCount, 1); assert.equal(evidence.privacy.logBodiesPersisted, false);
  } finally { console.log = originalLog; console.error = originalError; for (const file of files) fs.rmSync(file, { force: true }); }
});

test("human output is compact and excludes raw telemetry payloads", () => {
  const evidence = adaptOpenTelemetryEvidence(runtime(), policy(), { traces: traces(), metrics: metrics(), logs: logs() }, COLLECTED);
  const output = formatOpenTelemetryEvidence(evidence);
  assert.match(output, /OpenTelemetry Evidence v1/);
  assert.match(output, /Spans: 1/);
  assert.doesNotMatch(output, /private log body|customer.email|host.name/);
});

test("adapter source is offline file-only and contains no endpoint credential or exporter surface", () => {
  const source = fs.readFileSync(new URL("../scripts/opentelemetry-evidence.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /fetch\(|https?:\/\/|OTEL_EXPORTER|authorization|process\.env|node:child_process/);
  assert.match(source, /service\.name/);
  assert.match(source, /deployment\.environment\.name/);
});
