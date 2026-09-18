# Operator Task Dashboard v1

Operator Task Dashboard v1 is a read-only projection of the existing agent control-plane state.

Its canonical inputs are:

- Agent Task Registry v1
- Worker Lease v1

The dashboard does not create its own task table, lease table, workflow state machine, or audit truth.

Every task row preserves the original registry state alongside a derived dashboard status.

## Derived dashboard statuses

The dashboard vocabulary is:

- `QUEUED`
- `ROUTED`
- `LEASED`
- `RUNNING`
- `REVIEW_REQUIRED`
- `BLOCKED`
- `FAILED`
- `COMPLETED`
- `CANCELLED`
- `SUPERSEDED`
`LEASED` is presentation-only. It means the canonical task state is `ROUTED` and one active lease exists at the supplied evaluation time.

`REVIEW_REQUIRED` is presentation-only. It maps the canonical `WAITING_REVIEW` task state.

All other dashboard statuses directly preserve their Agent Task Registry state.

No derived dashboard status is written back to SQLite.

## Explicit evaluation time

Every dashboard snapshot requires an absolute caller-supplied `evaluatedAt`.

Lease state is calculated relative to that value as:

- `ACTIVE`
- `EXPIRED`
- `FUTURE`
- `RELEASED`
- `INVALID_TIME`

The dashboard never reads the system clock.

An unreleased lease that has expired remains unchanged in the database. The dashboard reports it as expired and may surface a consistency warning instead of calling the lease-expiration mutator.
## Consistency findings

The projection reports inconsistencies without rewriting source truth.

Examples include:

- more than one active lease for one task
- a queued or terminal task that still has an active lease
- an active write task without an active WRITE lease
- invalid or future lease chronology
- a running or review task with an unreleased expired lease

A finding is observational. It does not establish the reason for the inconsistency or authorize remediation.

The task record continues to expose its original registry state, revision, attempt count, repository commit, and last update time.

## Database posture

The CLI opens the existing SQLite database with Node's `readOnly: true` option and enables SQLite `query_only`.

It calls only the existing list APIs.

It does not:

- install or migrate schema
- register tasks
- transition tasks
- acquire, renew, release, or expire leases
- modify worker records
- create dashboard tables
Tests verify that reading a dashboard leaves the database bytes unchanged.

## CLI

```sh
bun run agent:dashboard -- \
  --db /private/control-plane.sqlite \
  --evaluated-at 2026-09-18T03:10:00Z \
  --json
```

Optional filters:

```sh
--repository example-repository
--status REVIEW_REQUIRED
```

Filters change presentation only. They do not alter the registry.

The command returns non-zero only when the derived snapshot contains a technical consistency `FAIL`. Ordinary warnings remain visible without becoming writes.
## Information boundary

The human view intentionally exposes operational identity such as task id, role, risk, repository commit, current state, and lease owner.

It does not print task objective text, path scope contents, private model configuration, credentials, or infrastructure endpoints.

The public toolkit contains the dashboard engine only. Every installation supplies its own registry location and infrastructure.

## Trust boundary

The dashboard is not an authorization engine.

A displayed state does not grant permission to:

- write source
- run arbitrary shell commands
- merge code
- deploy
- mutate production systems

Actual authority continues to come from Agent Task v1, Agent Role Policy v1, Worker Lease v1, the sandbox, and the relevant action-specific policy.

Operator Task Dashboard v1 has no network or subprocess execution surface and does not become a second audit truth model.
