# Incident Analysis Agent v1

Incident Analysis Agent v1 is a read only hypothesis generator over explicitly supplied, sanitized runtime evidence.

It does not monitor production directly, restart services, roll back releases, deploy code, mutate providers, change bookings or payments, or modify source.

The deterministic toolkit remains authoritative for evidence validation and operational policy.

## Required input

The input binds one Agent Task v1 to one exact repository commit and one exact release.

It composes existing Runtime Evidence v1 and Runtime Health Evidence v1 rather than defining replacement runtime schemas.

The release commit, repository commit, and runtime deployment commit must match exactly.

The runtime identity in Runtime Health Evidence must match the runtime identity in Runtime Evidence.
The caller also supplies:

* an explicit evaluation time
* bounded sanitized error summaries
* bounded numeric metrics
* known unknowns

All timestamps must be absolute ISO timestamps and may not be later than the evaluation time.

Runtime and health evidence may not predate the evaluated release deployment.

Error summaries and unknowns are bounded single line text and reject common secret like value patterns.

## Evidence ids

Incident v1 derives stable evidence ids for the model:

* `release`
* `runtime-deployment`
* `health:<check-id>`
* `error:<error-id>`
* `metric:<metric-id>`

Every model hypothesis must cite at least one of these exact ids.
## Model output

The model may return only hypotheses, known unknowns, and proposed verification steps.

Verification steps are limited to:

* `INSPECT`
* `TEST`
* `QUERY`

The normalized result always sets the following to false:

* incident resolved
* root cause established
* restart authorized
* rollback authorized
* deploy authorized
* provider mutation authorized
* source mutation authorized

A model statement is therefore never itself operational authority or proof of root cause.
## Usage

```sh
bun run agent:incident -- \
  --task /private/task.json \
  --role-policy /private/agent-role-policy.json \
  --input /private/incident-input.json \
  --model-config /private/model-config.json \
  --backend worker-local \
  --model small-local \
  --json
```

The public template is `templates/agent-incident-input.v1.json`.

It contains only synthetic identifiers and evidence. Real runtime errors, metrics, release ids, model mappings, endpoints, credentials, and infrastructure details stay outside the public repository.

## Trust boundary

The `authenticated` booleans embedded in runtime evidence remain metadata. Incident v1 does not upgrade them to cryptographic proof.

Use Signed Evidence Verification v1 where cryptographic authentication is required.
The agent does not fetch logs or metrics itself in v1. All runtime material is caller supplied.

OpenTelemetry ingestion is a separate roadmap capability so collection, privacy, retention, and analysis remain independent concerns.

A hypothesis can be useful for narrowing an investigation, but must be verified using deterministic checks or independently collected evidence before it is treated as a cause.
