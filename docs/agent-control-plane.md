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

## Worker and repository leases

`bun run agent:lease` provides Worker Lease v1 on the same private SQLite registry. A lease binds one registered `ROUTED` task to one symbolic worker id for a bounded 30–3600 second TTL. Acquisition, renewal, release, and expiration all use caller-supplied absolute timestamps; the lease engine never reads the system clock.

Lease mode is derived from Agent Task v1 authority. `READ_ONLY` tasks receive read-only leases. A task whose filesystem authority is `WORKTREE_WRITE` receives a `WRITE` lease. Callers cannot request a stronger mode than the task contract. Multiple read-only leases may coexist for one repository, including while a writer exists, but only one unreleased, unexpired `WRITE` lease may own a repository at a time. One task may have only one unreleased lease.

Every lease carries a revision. Renew and release operations require the expected revision and owning worker id, preventing stale controllers or another worker from silently taking over the lease. Expiration is evaluated only when an explicit evaluation time is supplied. Expired and released leases are retained for audit history, and lease events are append-only.

```sh
bun run agent:lease -- acquire --db /private/state/agent-tasks.sqlite --task-id task:repair:1 --worker-id worker-a --at 2026-09-17T12:01:00Z --ttl-seconds 300 --json
bun run agent:lease -- renew --db /private/state/agent-tasks.sqlite --lease-id lease:example --worker-id worker-a --revision 0 --at 2026-09-17T12:03:00Z --ttl-seconds 300 --json
bun run agent:lease -- release --db /private/state/agent-tasks.sqlite --lease-id lease:example --worker-id worker-a --revision 1 --at 2026-09-17T12:04:00Z --reason HANDOFF --json
bun run agent:lease -- expire --db /private/state/agent-tasks.sqlite --at 2026-09-17T12:10:00Z --json
```

Lease state is orchestration evidence, not repository or production truth. It does not create a worktree, start a model, execute a command, grant filesystem access, merge code, deploy, or mutate production. Exclusive path-level write scopes remain future work; v1 deliberately establishes the stricter repository-level writer boundary first.

## Agent Role Policy v1

`bun run agent:role-policy` validates a separate safety policy for agent roles. Role policy is intentionally distinct from Agent Routing Policy: routing chooses an eligible worker/model, while role policy caps what the task is allowed to request. When both are supplied to `agent:route`, a task must satisfy both layers; role policy can therefore only restrict routing, never widen it.

A role declares maximum task risk, maximum filesystem/shell/network authority, and write posture. `READ_ONLY` roles must use `writeMode: NONE`. Any role that permits `WORKTREE_WRITE` must use `writeMode: LEASED_WORKTREE`; unleased write authority is not representable in Agent Role Policy v1. Omitting a canonical role from a policy disables that role.

The public template `templates/agent-role-policy.v1.json` enables all eight canonical roles with a conservative baseline. Diagnose, review, contract, and incident are read-only. Reproduce, repair, and docs may write only in leased worktrees. Dependency analysis remains read-only and is the only default role whose maximum network authority is read-only rather than none. Operators may supply stricter private policies without putting private infrastructure or business truth in the public repository.

```sh
bun run agent:role-policy -- --task ./agent-task.json --policy ./templates/agent-role-policy.v1.json --json
bun run agent:route -- --task ./agent-task.json --policy ./routing-policy.json --role-policy ./templates/agent-role-policy.v1.json --worker ./worker.json --evaluated-at 2026-09-17T12:30:00Z --json
```

Role-policy PASS is not execution authority. A write task still needs Worker Lease v1 and an isolated worktree execution layer. Merge, deployment, payment, booking, migration, and production mutation remain outside Agent Task v1 authority.

## Worker-local model adapter

`bun run agent:model` provides Local Model Adapter v1. Model runtime configuration is private deployment state and is never inferred from Agent Worker v1 or committed as public infrastructure configuration. Each worker supplies its own private backend mapping from symbolic backend/model ids to a worker-local model runtime.

Version 1 supports explicit `OLLAMA` and `OPENAI_COMPATIBLE` backends, but only on literal loopback HTTP origins with an explicit port. Hostnames, LAN addresses, remote addresses, TLS/cloud endpoints, credentials, URL paths, queries, and fragments are rejected. The adapter therefore runs next to the model runtime on the same worker. Other toolkit users must operate their own workers and local model servers; a public toolkit checkout provides no access to any maintainer-operated models.

Prompts are supplied through bounded regular non-symlink files rather than command-line prompt text. Model configuration is also a bounded regular non-symlink JSON file. A request selects exactly one symbolic backend and one symbolic model. Failure of that backend fails the request; no alternative backend and no cloud provider are tried. Provider redirects are rejected. Responses are bounded before JSON parsing.

```sh
bun run agent:model -- \
  --config /private/state/model-backends.json \
  --backend worker-local \
  --model small-local \
  --system-file /private/task/system.txt \
  --prompt-file /private/task/prompt.txt \
  --temperature 0 \
  --max-output-tokens 256 \
  --timeout-ms 30000 \
  --json
```

The normalized result includes the symbolic backend/model id, response content, finish reason, and optional usage counts. It deliberately omits the private base URL, provider model name, and prompt content. The adapter does not persist model responses by itself and has no SSH, subprocess, environment-secret, merge, deployment, or production-mutation surface.

## Initial roles

The initial safe roles are `diagnose`, `reproduce`, and `review`. They are intended to establish evidence quality before source-modifying automation is enabled. `repair`, `docs`, `contract`, `dependency`, and `incident` are reserved Agent Task v1 roles for later phases with separate policy and execution boundaries.

## Authority model

Task authority has independent filesystem, shell, and network dimensions. Role policy supplies the maximum allowed authority. A task whose requested authority exceeds its role policy is unroutable rather than silently downgraded.

Version 1 explicitly fixes merge, deployment, and production mutation authority to false. Later capabilities may propose such actions to an external human-controlled system, but this contract cannot grant them.

## Local model strategy

Model selection is class-based (`SMALL`, `STANDARD`, `STRONG`, `REVIEW`) and policy-driven. A persistent CPU worker can therefore service lightweight diagnosis or classification tasks while a compute worker with more memory or GPU capacity handles stronger review or coding work. There is no implicit cloud fallback.

Private deployment configuration supplies actual worker ids, model ids, endpoints, organization policy, and repository locations. Those values do not belong in the public toolkit.
