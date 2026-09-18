# Incident Correlation Evidence v1

Incident Correlation Evidence v1 creates deterministic investigation hypotheses from already validated production evidence.

It does not establish root cause, incident resolution, safety, rollback readiness, or deployment authorization.

The engine is offline and read only. It does not call a model, network, package manager, provider API, shell, deployment system, or source mutation surface.

## Inputs

The input composes existing canonical toolkit contracts rather than redefining them:

- Agent Incident Input v1
- zero or more Dependency Maintenance Input v1 objects
- zero or more Contract Impact Input v1 objects
- optional SHA256 incident-error signatures
- optional prior known-failure records
- explicit correlation windows

Invalid nested contracts make the correlation input invalid.
## Correlation classes

### Release temporal

A release correlation is emitted only when the earliest supplied incident error or metric observation is at or after the evaluated release deployment time and within the explicit `maxReleaseWindowSeconds`.

This is temporal proximity only. It does not state that the release caused the incident.

### Dependency change

A dependency change correlates only when its validated dependency-maintenance input has the same repository id and exact commit as the evaluated incident release.

The dependency change and its explicit evidence ids are preserved as source references.

No changelog, package reputation, semantic-version risk, or compatibility claim is inferred beyond the deterministic dependency input.
### Contract failure

A contract correlation requires:

- the incident repository at the exact evaluated commit to be present in the validated Contract Impact Input v1
- a deterministic cross-repository contract audit `FAIL`
- an explicit provider/consumer relationship for that contract that includes the incident repository

The mismatch repository list is preserved in details. The correlation does not select a canonical repository or version and does not invent business rules.

### Prior known failure

Prior failure matching uses opaque SHA256 signatures only.

The caller explicitly binds a current incident error id to a SHA256 signature and supplies prior failure signatures. A match requires exact SHA256 equality, the same repository id, a non-future prior observation, and age within `maxKnownFailureAgeSeconds`.

Raw stack traces, logs, exception bodies, or arbitrary text are not fingerprinted by this engine.
## Source references

Every correlation returns explicit source references such as:

- `release`
- `runtime-deployment`
- `error:<id>`
- `metric:<id>`
- `dependency-change:<task-id>:<change-id>`
- `dependency-evidence:<task-id>:<evidence-id>`
- `contract-audit:<task-id>:<audit-id>`
- `contract-relationship:<task-id>:<relationship-id>`
- `known-failure:<id>`
- caller-supplied prior evidence references

The normalized output deliberately omits raw incident summaries, dependency evidence summaries, and contract evidence summaries.
## CLI

```sh
bun run incident:correlate -- \
  --file /private/incident-correlation-input.json \
  --json
```

A synthetic input example is available at `templates/incident-correlation-input.v1.json`.

Private incident evidence, signatures, dependency proposals, contract inventories, and known-failure catalogs should remain outside the public toolkit repository.

## Trust boundary

Correlation is not causation.

A release-window match means only that evidence appeared within an explicit time window after a release. A dependency match means only that an explicit dependency update belongs to the same commit. A contract match means only that a canonical contract audit failure is linked through an explicit contract relationship. A prior-failure match means only that opaque signatures are identical under the supplied repository and time constraints.

The result always keeps `rootCauseEstablished`, `incidentResolved`, `executionAuthorized`, `rollbackAuthorized`, `deployAuthorized`, and `sourceMutationAuthorized` false.
