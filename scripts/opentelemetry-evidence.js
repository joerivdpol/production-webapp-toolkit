#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateRuntimeEvidence, isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const TRACE_ID = /^[0-9a-fA-F]{32}$/;
const SPAN_ID = /^[0-9a-fA-F]{16}$/;
/** @param {string|null} value */
function validTraceId(value) { return Boolean(value && TRACE_ID.test(value) && !/^0{32}$/.test(value)); }
/** @param {string|null} value */
function validSpanId(value) { return Boolean(value && SPAN_ID.test(value) && !/^0{16}$/.test(value)); }
const MAX_FILE_BYTES = 16 * 1024 * 1024;

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
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}
/** @param {string} value */
function secretLike(value) {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/i.test(value)
    || /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/.test(value)
    || /\bsk-[A-Za-z0-9_-]{20,}\b/.test(value);
}
/** @param {unknown} value */
function uint64(value) {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) return null;
    return String(value);
  }
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= 18_446_744_073_709_551_615n ? parsed.toString() : null;
  } catch { return null; }
}
/** @param {string|null} value @param {string} collectedAt */
function notAfterCollection(value, collectedAt) {
  if (value === null) return true;
  const nanos = BigInt(value), collectedNanos = BigInt(Date.parse(collectedAt)) * 1_000_000n;
  return nanos <= collectedNanos;
}
/** @param {unknown} value */
function stringAnyValue(value) {
  if (!object(value)) return null;
  const raw = text(value.stringValue, 1024);
  return raw && !secretLike(raw) ? raw : null;
}
/** @param {unknown} resource @param {string} runtimeName @param {string|null} environment */
function validateResourceIdentity(resource, runtimeName, environment) {
  if (!object(resource) || !Array.isArray(resource.attributes)) throw new Error("OTLP resource must contain attributes");
  const attrs = new Map();
  for (const raw of resource.attributes) {
    if (!object(raw)) continue;
    const key = text(raw.key, 256);
    if (!key || attrs.has(key)) continue;
    attrs.set(key, stringAnyValue(raw.value));
  }
  const service = attrs.get("service.name") ?? null;
  const env = attrs.get("deployment.environment.name") ?? null;
  if (service !== runtimeName) throw new Error("OTLP service.name must equal Runtime Evidence runtime name");
  if (environment !== null && env !== environment) throw new Error("OTLP deployment.environment.name must equal Runtime Evidence environment");
  return { serviceName: service, environment: env };
}

/** @param {unknown} value */
export function validateOpenTelemetryAdapterPolicy(value) {
  if (!object(value)) return { valid: false, policy: null, error: "policy must be an object" };
  if (value.version !== 1 || !object(value.limits)) return { valid: false, policy: null, error: "policy version or limits are invalid" };
  if (Object.keys(value).some((key) => !["version","limits"].includes(key)) || Object.keys(value.limits).some((key) => !["maxSpans","maxMetrics","maxDataPoints","maxLogs"].includes(key))) {
    return { valid: false, policy: null, error: "policy contains unsupported fields" };
  }
  const maxSpans = integer(value.limits.maxSpans, 1, 100_000), maxMetrics = integer(value.limits.maxMetrics, 1, 100_000);
  const maxDataPoints = integer(value.limits.maxDataPoints, 1, 1_000_000), maxLogs = integer(value.limits.maxLogs, 1, 100_000);
  if (maxSpans === null || maxMetrics === null || maxDataPoints === null || maxLogs === null) return { valid: false, policy: null, error: "policy limits are invalid" };
  return { valid: true, policy: { version: 1, limits: { maxSpans, maxMetrics, maxDataPoints, maxLogs } }, error: null };
}
/** @param {unknown} value @param {any} runtime @param {any} policy @param {string} collectedAt */
function parseTraces(value, runtime, policy, collectedAt) {
  if (!object(value) || !Array.isArray(value.resourceSpans)) throw new Error("OTLP traces must contain resourceSpans");
  const records = []; let resources = 0, scopes = 0, errorSpans = 0, rootSpans = 0;
  for (const resourceSpan of value.resourceSpans) {
    if (!object(resourceSpan)) throw new Error("OTLP resourceSpans entry is invalid");
    validateResourceIdentity(resourceSpan.resource, runtime.runtime.name, runtime.runtime.environment ?? null); resources += 1;
    if (!Array.isArray(resourceSpan.scopeSpans)) throw new Error("OTLP scopeSpans must be an array");
    for (const scopeSpan of resourceSpan.scopeSpans) {
      if (!object(scopeSpan) || !Array.isArray(scopeSpan.spans)) throw new Error("OTLP scopeSpans entry is invalid"); scopes += 1;
      for (const span of scopeSpan.spans) {
        if (!object(span)) throw new Error("OTLP span is invalid");
        if (records.length >= policy.limits.maxSpans) throw new Error("OTLP span count exceeds policy limit");
        const traceId = text(span.traceId, 64), spanId = text(span.spanId, 32), parentSpanId = span.parentSpanId === undefined || span.parentSpanId === "" ? null : text(span.parentSpanId, 32);
        const name = text(span.name, 512), start = uint64(span.startTimeUnixNano), end = uint64(span.endTimeUnixNano);
        const statusCode = object(span.status) && integer(span.status.code, 0, 2) !== null ? Number(span.status.code) : 0;
        if (!validTraceId(traceId) || !validSpanId(spanId) || (parentSpanId && !validSpanId(parentSpanId)) || !name || secretLike(name) || !start || !end || BigInt(end) < BigInt(start) || !notAfterCollection(end, collectedAt)) throw new Error("OTLP span identity, timing, or name is invalid");
        if (statusCode === 2) errorSpans += 1; if (!parentSpanId) rootSpans += 1;
        records.push({ traceId: String(traceId).toLowerCase(), spanId: String(spanId).toLowerCase(), ...(parentSpanId ? { parentSpanId: parentSpanId.toLowerCase() } : {}), name, startTimeUnixNano: start, endTimeUnixNano: end, statusCode });
      }
    }
  }
  return { resourceCount: resources, scopeCount: scopes, spanCount: records.length, errorSpanCount: errorSpans, rootSpanCount: rootSpans, records };
}
/** @param {any} metric */
function metricData(metric) {
  const kinds = ["gauge","sum","histogram","exponentialHistogram","summary"].filter((key) => object(metric[key]));
  if (kinds.length !== 1) throw new Error("OTLP metric must contain exactly one supported data field");
  const type = kinds[0]; if (!type) throw new Error("OTLP metric data field is unavailable"); const data = metric[type];
  if (!Array.isArray(data.dataPoints)) throw new Error("OTLP metric dataPoints must be an array");
  return { type, dataPoints: data.dataPoints };
}
/** @param {unknown} value @param {any} runtime @param {any} policy @param {string} collectedAt */
function parseMetrics(value, runtime, policy, collectedAt) {
  if (!object(value) || !Array.isArray(value.resourceMetrics)) throw new Error("OTLP metrics must contain resourceMetrics");
  const records = []; let resources = 0, scopes = 0, dataPointCount = 0;
  for (const resourceMetric of value.resourceMetrics) {
    if (!object(resourceMetric)) throw new Error("OTLP resourceMetrics entry is invalid");
    validateResourceIdentity(resourceMetric.resource, runtime.runtime.name, runtime.runtime.environment ?? null); resources += 1;
    if (!Array.isArray(resourceMetric.scopeMetrics)) throw new Error("OTLP scopeMetrics must be an array");
    for (const scopeMetric of resourceMetric.scopeMetrics) {
      if (!object(scopeMetric) || !Array.isArray(scopeMetric.metrics)) throw new Error("OTLP scopeMetrics entry is invalid"); scopes += 1;
      for (const metric of scopeMetric.metrics) {
        if (!object(metric) || records.length >= policy.limits.maxMetrics) throw new Error("OTLP metric is invalid or exceeds policy limit");
        const name = text(metric.name, 512), unit = metric.unit === undefined ? null : text(metric.unit, 128);
        if (!name || secretLike(name) || (metric.unit !== undefined && !unit)) throw new Error("OTLP metric name or unit is invalid");
        const parsed = metricData(metric); dataPointCount += parsed.dataPoints.length;
        if (dataPointCount > policy.limits.maxDataPoints) throw new Error("OTLP data point count exceeds policy limit");
        let latest = null;
        for (const point of parsed.dataPoints) {
          if (!object(point)) throw new Error("OTLP metric data point is invalid");
          const timestamp = point.timeUnixNano === undefined ? null : uint64(point.timeUnixNano);
          if (!timestamp || !notAfterCollection(timestamp, collectedAt)) throw new Error("OTLP metric data point requires valid non-future timeUnixNano; future-dated values are rejected");
          if (timestamp && (latest === null || BigInt(timestamp) > BigInt(latest))) latest = timestamp;
        }
        records.push({ name, type: parsed.type, ...(unit ? { unit } : {}), dataPointCount: parsed.dataPoints.length, ...(latest ? { latestTimeUnixNano: latest } : {}) });
      }
    }
  }
  return { resourceCount: resources, scopeCount: scopes, metricCount: records.length, dataPointCount, records };
}
/** @param {unknown} value @param {any} runtime @param {any} policy @param {string} collectedAt */
function parseLogs(value, runtime, policy, collectedAt) {
  if (!object(value) || !Array.isArray(value.resourceLogs)) throw new Error("OTLP logs must contain resourceLogs");
  const records = []; let resources = 0, scopes = 0, errorOrFatal = 0, correlated = 0;
  for (const resourceLog of value.resourceLogs) {
    if (!object(resourceLog)) throw new Error("OTLP resourceLogs entry is invalid");
    validateResourceIdentity(resourceLog.resource, runtime.runtime.name, runtime.runtime.environment ?? null); resources += 1;
    if (!Array.isArray(resourceLog.scopeLogs)) throw new Error("OTLP scopeLogs must be an array");
    for (const scopeLog of resourceLog.scopeLogs) {
      if (!object(scopeLog) || !Array.isArray(scopeLog.logRecords)) throw new Error("OTLP scopeLogs entry is invalid"); scopes += 1;
      for (const record of scopeLog.logRecords) {
        if (!object(record) || records.length >= policy.limits.maxLogs) throw new Error("OTLP log record is invalid or exceeds policy limit");
        const time = record.timeUnixNano === undefined ? null : uint64(record.timeUnixNano), observed = record.observedTimeUnixNano === undefined ? null : uint64(record.observedTimeUnixNano);
        const severityNumber = record.severityNumber === undefined ? 0 : integer(record.severityNumber, 0, 24);
        const traceId = record.traceId === undefined || record.traceId === "" ? null : text(record.traceId, 64), spanId = record.spanId === undefined || record.spanId === "" ? null : text(record.spanId, 32);
        if ((record.timeUnixNano !== undefined && !time) || (record.observedTimeUnixNano !== undefined && !observed) || severityNumber === null || (traceId && !validTraceId(traceId)) || (spanId && !validSpanId(spanId)) || (spanId && !traceId)) throw new Error("OTLP log timing, severity, or trace context is invalid");
        const effective = time ?? observed;
        if (effective && !notAfterCollection(effective, collectedAt)) throw new Error("OTLP log record is future-dated");
        if (severityNumber >= 17) errorOrFatal += 1; if (traceId && spanId) correlated += 1;
        records.push({ ...(time ? { timeUnixNano: time } : {}), ...(observed ? { observedTimeUnixNano: observed } : {}), severityNumber, ...(traceId ? { traceId: traceId.toLowerCase() } : {}), ...(spanId ? { spanId: spanId.toLowerCase() } : {}) });
      }
    }
  }
  return { resourceCount: resources, scopeCount: scopes, recordCount: records.length, errorOrFatalRecordCount: errorOrFatal, correlatedRecordCount: correlated, records };
}
/** @param {unknown} runtimeRaw @param {unknown} policyRaw @param {{traces:unknown,metrics:unknown,logs:unknown}} payloads @param {string} collectedAt */
export function adaptOpenTelemetryEvidence(runtimeRaw, policyRaw, payloads, collectedAt) {
  if (!isAbsoluteIsoTimestamp(collectedAt)) throw new Error("collectedAt must be an absolute ISO timestamp");
  const runtimeResult = validateRuntimeEvidence(runtimeRaw), policyResult = validateOpenTelemetryAdapterPolicy(policyRaw);
  if (!runtimeResult.valid || !runtimeResult.evidence) throw new Error("runtime evidence is invalid");
  if (!policyResult.valid || !policyResult.policy) throw new Error("OpenTelemetry adapter policy is invalid");
  if (Date.parse(runtimeResult.evidence.evidence.collectedAt) > Date.parse(collectedAt)) throw new Error("Runtime Evidence collection time cannot exceed adapter collectedAt");
  const traces = parseTraces(payloads.traces, runtimeResult.evidence, policyResult.policy, collectedAt);
  const metrics = parseMetrics(payloads.metrics, runtimeResult.evidence, policyResult.policy, collectedAt);
  const logs = parseLogs(payloads.logs, runtimeResult.evidence, policyResult.policy, collectedAt);
  return {
    version: 1,
    runtime: { ...runtimeResult.evidence.runtime },
    deployment: { commit: runtimeResult.evidence.deployment.commit },
    evidence: { source: "otlp-json-adapter", authenticated: false, collectedAt },
    signals: { traces, metrics, logs },
    privacy: {
      persistedResourceAttributes: ["service.name", ...(runtimeResult.evidence.runtime.environment ? ["deployment.environment.name"] : [])],
      logBodiesPersisted: false, logAttributesPersisted: false, spanAttributesPersisted: false,
      spanEventsPersisted: false, spanLinksPersisted: false, metricPointAttributesPersisted: false, exemplarsPersisted: false,
    },
    semantics: "offline bounded projection of caller-supplied OTLP JSON; raw log bodies, arbitrary attributes, span events/links, exemplars, endpoints, headers, and credentials are not persisted",
  };
}
/** @param {string} filename */
function readJson(filename) {
  const resolved = path.resolve(filename); let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error("OpenTelemetry input cannot be read"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_FILE_BYTES) throw new Error("OpenTelemetry input must be a bounded regular non-symlink file");
  try { return JSON.parse(fs.readFileSync(resolved, "utf8")); } catch { throw new Error("OpenTelemetry input JSON cannot be parsed"); }
}
/** @param {any} evidence */
export function formatOpenTelemetryEvidence(evidence) {
  return [
    "OpenTelemetry Evidence v1", "",
    `Runtime: ${evidence.runtime.name}${evidence.runtime.environment ? ` / ${evidence.runtime.environment}` : ""}`,
    `Commit: ${evidence.deployment.commit}`,
    `Spans: ${evidence.signals.traces.spanCount}`,
    `Metrics: ${evidence.signals.metrics.metricCount} / points ${evidence.signals.metrics.dataPointCount}`,
    `Logs: ${evidence.signals.logs.recordCount}`,
    `Collected at: ${evidence.evidence.collectedAt}`,
    `Semantics: ${evidence.semantics}`,
  ].join("\n");
}
/** @param {string[]} argv */
function parse(argv) {
  const values = new Map(), flags = new Set(), allowed = new Set(["--runtime-evidence","--policy","--traces","--metrics","--logs","--collected-at"]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]; if (arg === "--json") { if (flags.has(arg)) return null; flags.add(arg); continue; }
    if (!allowed.has(arg ?? "") || values.has(arg)) return null;
    const next = argv[index + 1]; if (typeof next !== "string" || next.startsWith("--")) return null;
    values.set(arg, next); index += 1;
  }
  for (const key of allowed) if (!values.has(key)) return null;
  return { values, json: flags.has("--json") };
}
export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/opentelemetry-evidence.js --runtime-evidence <runtime.json> --policy <otel-policy.json> --traces <traces.json> --metrics <metrics.json> --logs <logs.json> --collected-at <absolute-ISO> [--json]"); return 1; }
  try {
    const evidence = adaptOpenTelemetryEvidence(
      readJson(options.values.get("--runtime-evidence")), readJson(options.values.get("--policy")),
      { traces: readJson(options.values.get("--traces")), metrics: readJson(options.values.get("--metrics")), logs: readJson(options.values.get("--logs")) },
      options.values.get("--collected-at"),
    );
    console.log(options.json ? JSON.stringify(evidence) : formatOpenTelemetryEvidence(evidence)); return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "OpenTelemetry evidence adaptation failed"); return 1;
  }
}
if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
