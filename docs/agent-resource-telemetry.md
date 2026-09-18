# Agent Resource & Model Quality Telemetry v1

Agent Resource & Model Quality Telemetry v1 records explicit observations about agent runs.

It is designed to answer operational questions such as:

- how long agent runs take
- how much CPU or GPU time they consume
- whether token usage was reported
- how often proposals are accepted or rejected
- how much human review effort was recorded
- whether an accepted proposal later reopened as a defect
- whether a run passed or failed an explicit evaluation corpus

The toolkit deliberately does not collapse these observations into a single model-quality score.
## Run identity

Every run binds:

- run id
- task id
- canonical agent role
- repository id and full commit
- symbolic worker id and worker class
- symbolic model id, model class, and backend id

No provider model name, endpoint, prompt, response content, hostname, credential, or maintainer infrastructure address belongs in this evidence contract.

Worker and model ids are symbolic identifiers supplied by the local deployment.

## Timing and resources

A run carries caller-supplied `startedAt`, `completedAt`, and `latencyMs`.

The validator requires:

```
latencyMs = completedAt - startedAt
```

exactly in milliseconds.
CPU time is required as `cpuTimeMs`.

GPU time is either a non-negative integer or `null` when it was not measured.

The telemetry contract does not infer CPU/GPU utilization percentages and does not inspect the operating system.

## Token usage

`inputTokens` and `outputTokens` are non-negative integers when the selected local model runtime reports them.

Either field may be `null` when usage was not available.

Invalid non-null values are rejected rather than silently converted to missing data.

Aggregates keep both reported and missing token-usage counts visible.

## Proposal and defect outcomes

Proposal outcome is one of:

- `ACCEPTED`
- `REJECTED`
- `NOT_APPLICABLE`

A reopened defect can only be recorded for an accepted proposal.
That rule does not establish that the agent caused the defect. It only keeps the recorded workflow outcome internally consistent.

Human review effort is stored as explicit seconds.

The toolkit does not infer review effort from chat duration, commit time, or wall-clock gaps.

## Evaluation corpus

A run may bind an explicit evaluation-corpus result:

- `PASS`
- `FAIL`
- `NOT_EVALUATED`

PASS or FAIL requires a symbolic `corpusId`.

NOT_EVALUATED requires `corpusId: null`.

This preserves the distinction between benchmark evidence and ordinary production usage.

## Aggregation
The CLI aggregates observations across the complete evidence file and groups them by:

- role
- symbolic model/backend/class
- symbolic worker/class

Aggregates expose counts and sums for latency, resources, tokens, proposal outcomes, review effort, reopened defects, and corpus outcomes.

No weighted score, winner, ranking, or automatically selected "best model" is produced by this capability.

Item 97 can use these observations together with explicit evaluation policy to test routing choices.

## CLI

```sh
bun run agent:telemetry -- \
  --file /private/agent-telemetry.json \
  --json
```

A synthetic example is available at `templates/agent-resource-telemetry.v1.json`.
## Trust boundary

The top-level `evidence.authenticated` field is metadata only.

It does not cryptographically establish that telemetry came from a trusted runner.

Installations that need cryptographic provenance should use Signed Evidence Verification separately.

The collector/runner that measures CPU time, GPU time, review effort, reopened defects, or proposal outcomes is outside this contract. This validator only checks the supplied values for shape, chronology, consistency, and bounds.

Agent Resource & Model Quality Telemetry v1 is offline and read only. It does not invoke models, read prompts or model outputs, call worker endpoints, inspect processes, mutate repositories, merge, deploy, or perform provider actions.
