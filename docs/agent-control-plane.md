# Agent Control Plane

The agent control plane is an orchestration layer above the deterministic Production Webapp Toolkit. It schedules bounded AI work but does not replace toolkit audits, policies, evidence validators, or deployment decisions.

## Topology

A typical deployment has one persistent control worker and zero or more optional compute workers. The persistent worker owns the task registry, leases, scheduling, and lightweight local models. Compute workers may appear and disappear and can expose larger models, GPU capacity, browser tooling, or isolated worktree write capacity.

Worker availability is represented by Agent Worker v1 heartbeat evidence. Routing uses an explicit evaluation time and maximum heartbeat age. An old heartbeat is never treated as proof that a worker is currently online.

## Self-hosting and isolation boundary

The public toolkit is not a hosted agent service. It does not contain or distribute access to the maintainer's machines, model servers, private network, repositories, credentials, or worker endpoints. Every installation supplies its own controller, workers, model runtimes, network policy, credentials, and private deployment configuration.

Agent Worker v1 contains only portable capability and resource evidence. Model `backend` values are symbolic identifiers, not URLs. Private adapters resolve those identifiers to endpoints outside the public repository. A public checkout alone therefore provides no route to any maintainer-controlled infrastructure.

Operators should expose worker APIs only on networks they control, authenticate every controller-to-worker request, and avoid publishing SSH, overlay-network, LAN, model-server, or management endpoints in repository configuration.

## Versioned contracts

Agent Task v1 binds one task to an exact repository commit, agent role, risk, objective, allowed and denied paths, required validation checks, and bounded authority. Version 1 never permits merge, deployment, or production mutation.

Agent Worker v1 describes worker class, state, observation time, CPU and memory, optional GPU, capabilities, model inventory, execution capacity, and current read/write load.

Agent Route v1 combines a validated task, validated worker heartbeats, and explicit role routing policy. Routing is deterministic and proposal-only. It does not start a model, create a worktree, execute a command, or mutate a repository.

## Persistent task registry

`bun run agent:registry` provides Agent Task Registry v1 on a caller-supplied local SQLite database. The database location is deployment state and should live outside the public repository. Parent paths and existing database files must be regular non-symlink paths.

Registration validates Agent Task v1, stores its canonical JSON plus SHA256, and is idempotent only when the same task id carries byte-identical canonical content. Reusing an id for different task truth fails closed. Task identity columns and task rows are protected from direct update/delete, while task events are append-only.

State transitions use both expected state and expected revision. This optimistic concurrency boundary prevents a stale controller from overwriting a newer task state. Transition timestamps are explicit caller input and must remain monotone; the registry does not read the system clock. `RUNNING` entries increment the attempt count. `FAILED` or `BLOCKED` tasks can be explicitly requeued through the versioned transition model, while completed, cancelled, and superseded tasks are terminal.

```sh
bun run agent:registry -- init --db /private/state/agent-tasks.sqlite --json
bun run agent:registry -- register --db /private/state/agent-tasks.sqlite --task ./task.json --at 2026-09-17T12:00:05Z --json
bun run agent:registry -- transition --db /private/state/agent-tasks.sqlite --task-id task:diagnose:1 --from QUEUED --to ROUTED --revision 0 --at 2026-09-17T12:01:00Z --json
bun run agent:registry -- events --db /private/state/agent-tasks.sqlite --task-id task:diagnose:1 --json
```

The registry has no model, network, subprocess, environment, merge, deployment, or production-mutation surface. Worker ownership is intentionally not inferred here; exclusive worker/repository leases are a separate capability.

## Initial roles

The initial safe roles are `diagnose`, `reproduce`, and `review`. They are intended to establish evidence quality before source-modifying automation is enabled. `repair`, `docs`, `contract`, `dependency`, and `incident` are reserved Agent Task v1 roles for later phases with separate policy and execution boundaries.

## Authority model

Task authority has independent filesystem, shell, and network dimensions. Role policy supplies the maximum allowed authority. A task whose requested authority exceeds its role policy is unroutable rather than silently downgraded.

Version 1 explicitly fixes merge, deployment, and production mutation authority to false. Later capabilities may propose such actions to an external human-controlled system, but this contract cannot grant them.

## Local model strategy

Model selection is class-based (`SMALL`, `STANDARD`, `STRONG`, `REVIEW`) and policy-driven. A persistent CPU worker can therefore service lightweight diagnosis or classification tasks while a compute worker with more memory or GPU capacity handles stronger review or coding work. There is no implicit cloud fallback.

Private deployment configuration supplies actual worker ids, model ids, endpoints, organization policy, and repository locations. Those values do not belong in the public toolkit.
