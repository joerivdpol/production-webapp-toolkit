# OpenTelemetry Evidence v1

OpenTelemetry Evidence v1 is an offline adapter for caller supplied OTLP JSON traces, metrics, and logs.

It does not connect to an OpenTelemetry Collector, exporter endpoint, backend, or vendor API.

The adapter projects high volume telemetry into a bounded, privacy conscious evidence shape for later incident and correlation workflows.

## Runtime identity

The adapter requires an existing Runtime Evidence v1 document.

Every OTLP resource must contain `service.name` equal to the Runtime Evidence runtime name.

When Runtime Evidence includes an environment, every OTLP resource must also contain `deployment.environment.name` with the same value.

The deployment commit is inherited from Runtime Evidence v1 rather than guessed from telemetry attributes.
## OTLP JSON scope

v1 accepts the stable OTLP JSON shapes for:

* `resourceSpans`
* `resourceMetrics`
* `resourceLogs`

Trace ids and span ids use the OTLP JSON hexadecimal representation.

64 bit nanosecond timestamps may be decimal strings or safe integers and are normalized to decimal strings.

Unknown OTLP fields are ignored rather than copied, matching the forward compatible OTLP JSON behavior.

The adapter supports gauge, sum, histogram, exponential histogram, and summary metric data fields.
## Privacy boundary

The adapter persists only:

* runtime service name and optional environment
* deployment commit from Runtime Evidence
* bounded trace ids, span ids, names, timing, and status codes
* metric names, type, unit, data point counts, and latest point timestamp
* log timestamps, severity number, and optional trace/span correlation ids
* aggregate signal counts

The adapter never persists raw log bodies, arbitrary resource attributes beyond service identity, log attributes, span attributes, span events, span links, metric data point attributes, or exemplars.

It also contains no exporter endpoint, headers, credentials, network client, subprocess, or environment variable reader.
## Limits

The public policy template is `templates/opentelemetry-adapter-policy.v1.json`.

It sets hard per run limits for spans, metrics, metric data points, and log records.

The adapter fails closed when a signal exceeds policy bounds rather than truncating silently.

All telemetry timestamps that are present must not be later than the caller supplied collection time.

The Runtime Evidence collection time may not be later than the adapter collection time.

## Usage

```sh
bun run otel:evidence -- \
  --runtime-evidence ./runtime-evidence.json \
  --policy /private/opentelemetry-adapter-policy.json \
  --traces ./otlp-traces.json \
  --metrics ./otlp-metrics.json \
  --logs ./otlp-logs.json \
  --collected-at 2026-09-18T06:15:00Z \
  --json
```
All input files must be bounded regular non symlink JSON files.

The public repository contains no collector address or maintainer telemetry configuration. Each installation supplies its own telemetry collection pipeline and sanitized OTLP JSON evidence outside this repository.

OpenTelemetry Evidence v1 is evidence projection only. It does not establish incident root cause, service health, release safety, or deployment authorization on its own.
