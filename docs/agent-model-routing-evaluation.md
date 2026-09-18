# Model Routing Evaluation v1

Model Routing Evaluation v1 turns explicit Agent Resource & Model Quality Telemetry v1 into a deterministic routing recommendation.

It does not mutate Agent Route v1 policy, deploy models, install models, or choose a cloud fallback.

The evaluator is intentionally conservative: a stronger model class is recommended only when all earlier configured classes have sufficient measured evidence and are explicitly disqualified.

Missing measurements do not justify escalation.

## Inputs

The evaluator consumes one validated Agent Telemetry Evidence v1 file and one explicit Model Routing Evaluation Policy v1 file.

Telemetry remains observational. It contains exact symbolic worker/model identity, role, latency, CPU/GPU time, token usage, proposal outcome, review effort, reopened-defect status, and optional evaluation-corpus PASS/FAIL.

Caller supplied `evidence.authenticated` remains metadata and is not cryptographic proof.
The policy supplies:

- an explicit caller evaluation time
- maximum telemetry age
- one or more agent roles
- an ordered model-class preference per role
- minimum number of evaluated runs
- maximum accepted evaluation failures
- maximum accepted reopened defects

The public example is `templates/agent-model-routing-evaluation-policy.v1.json`.

Private deployments may define different role thresholds. The public toolkit does not infer them from hardware, cost, provider, organization, or business rules.

## Exact model identity

Qualification is evaluated per exact:

```text
backend:model-id:model-class
```

A good result from one SMALL model therefore does not automatically qualify every SMALL model.

The evaluator records which worker classes produced the measurements but does not use worker class as a quality claim.
## Status semantics

Each exact model identity receives one of:

- `QUALIFIED`: enough evaluated runs exist and explicit failure/reopened-defect limits are satisfied
- `DISQUALIFIED`: enough evaluated runs exist but an explicit quality limit is exceeded
- `UNVERIFIED`: there are not enough evaluated runs

Per role, routing recommendation is:

- `QUALIFIED_SMALLEST_MEASURED_CLASS`: the first configured model class has at least one qualified exact model
- `ESCALATION_REQUIRED_BY_MEASURED_QUALITY`: all earlier classes are explicitly disqualified and a stronger class has a qualified exact model
- `UNVERIFIED`: a preferred class has missing or insufficient evidence, or telemetry is stale/future-dated
- `NO_QUALIFIED_MODEL`: every configured class is explicitly disqualified

An UNVERIFIED smaller class blocks escalation. This is deliberate: lack of evidence is not evidence that a stronger model is required.
When multiple exact models in the same first qualified class pass, average measured latency is used only as a deterministic tiebreaker. It is not part of a model-quality score.

Proposal acceptance/rejection, token usage, CPU/GPU time, and review effort stay visible in measurements but do not independently qualify or disqualify a model.

## Usage

```sh
bun run agent:route:evaluate -- \
  --telemetry ./agent-telemetry.json \
  --policy /private/model-routing-evaluation-policy.json \
  --json
```

The evaluator exits nonzero only when all configured classes for a role are explicitly disqualified. UNVERIFIED remains a recommendation state rather than an execution failure.

Agent Route v1 remains a separate deterministic worker/model capability router.
## Trust boundary

Model Routing Evaluation v1 is local and read-only.

It has no network client, subprocess execution, file mutation, model invocation, routing-policy mutation, deployment authority, or automatic model installation.

It does not combine measurements into an artificial numeric model-quality score.

A recommendation says only what the supplied telemetry and policy support. It does not prove general intelligence, safety, correctness, or suitability outside the measured role and exact model identity.

If cryptographic evidence authenticity is required, Signed Evidence Verification v1 must be applied separately to the telemetry evidence bytes.
