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

## Local worker observation and discovery

`bun run agent:worker:observe` converts a private Worker Declaration v1 into Agent Worker v1 heartbeat evidence. CPU concurrency and total memory are observed locally through the Node runtime. Optional GPU metadata, capabilities, execution capacity, current load, and symbolic model metadata are explicit declaration inputs. Model-bearing declarations must be cross-checked against an explicit private Local Model Adapter config; only symbolic backend/model ids enter the heartbeat, never provider model names or local runtime URLs.

`bun run agent:worker:registry` registers explicit heartbeat files in the same local SQLite control-plane database. Registry schema v3 keeps only the latest validated heartbeat per worker plus append-only heartbeat history. A heartbeat with an older observation time is rejected. Reusing the same observation time with different content is a conflict. Every latest record is revalidated and SHA256-checked when read, so direct database corruption cannot silently become worker truth.

Discovery is local and deterministic. An explicit evaluation time plus maximum heartbeat age yields `FRESH`, `STALE`, or `FUTURE`. Only a `FRESH` worker whose Agent Worker state is `ONLINE` is marked routable. Agent Route v1 still performs its own freshness and capability checks; discovery does not weaken routing policy.

```sh
bun run agent:worker:observe -- --declaration /private/worker.json --model-config /private/model-backends.json --json > /private/state/worker-heartbeat.json
bun run agent:worker:registry -- register --db /private/state/agent-tasks.sqlite --heartbeat /private/state/worker-heartbeat.json --registered-at 2026-09-17T12:30:02Z --json
bun run agent:worker:registry -- discover --db /private/state/agent-tasks.sqlite --evaluated-at 2026-09-17T12:30:30Z --max-age-seconds 120 --json
```

The public capability deliberately includes no heartbeat transport. A persistent controller may register its own local heartbeat and may accept heartbeat files from optional compute workers through an operator-selected private authenticated transport, but SSH configuration, overlay-network addressing, worker URLs, credentials, and maintainer infrastructure do not belong in this repository. A public installation therefore discovers only workers that its own operator explicitly registers.

The example `templates/agent-worker-declaration.v1.json` contains generic symbolic ids only. Operators must replace it with their own private declaration and capacity policy.

## Diagnosis Agent v1

`bun run agent:diagnose` is the first executable AI role. It remains read-only: one exact Agent Task v1 with role `diagnose`, one Agent Role Policy v1, one explicit Diagnosis Input v1 evidence file, and one private worker-local model configuration are composed into evidence-bound hypotheses.

Diagnosis Input v1 binds evidence to the exact task repository id and source commit. Every evidence record has a portable id, source id, explicit status, bounded summary, and optional repository-relative path. Changed files and already-known unknowns are explicit inputs. The model is not allowed to inspect arbitrary additional sources through this command.

The model must return Diagnosis Result v1 JSON. Every hypothesis must cite one or more evidence ids that already exist in the input. Verification proposals and the recommended next step can only be classified as `INSPECT`, `TEST`, or `QUERY`. Unknown evidence references, malformed JSON, unsupported action classes, wrong task/repository binding, non-diagnose roles, or write-authorized diagnosis tasks fail closed.

Validated output always carries `executionAuthorized: false`, `sourceMutationAuthorized: false`, and `rootCauseEstablished: false`. A diagnosis is therefore a set of evidence-backed hypotheses that still require verification. Model confidence or fluent prose never upgrades a hypothesis into canonical root-cause truth.

```sh
bun run agent:diagnose -- \
  --task /private/tasks/diagnose-task.json \
  --role-policy /private/policy/agent-roles.json \
  --input /private/tasks/diagnosis-input.json \
  --model-config /private/config/model-backends.json \
  --backend worker-local \
  --model small-local \
  --json
```

Diagnosis v1 does not execute verification proposals. The later Reproduction Agent is responsible for turning a verified diagnosis target into an isolated failing regression test under a separate leased-worktree write boundary.

## Reproduction Agent v1

`bun run agent:reproduce` turns one selected Diagnosis Result v1 hypothesis into exactly one new regression-test candidate. The generate path requires a `reproduce` Agent Task v1, Agent Role Policy v1, private Reproduction Policy v1, the local SQLite task registry, an active WRITE lease owned by the supplied worker, an exact diagnosis input/result pair, and a private worker-local model configuration.

Before the model is invoked, the target repository must be a clean linked Git worktree whose `HEAD` equals the task `baseCommit`. The primary checkout is rejected. The registered task must exactly match the supplied task and be `RUNNING`; the lease must be active, WRITE mode, and bound to the same task, worker, and repository. Reproduction v1 additionally requires shell `NONE` and network `NONE` because this capability does not execute project code or access external services.

The model may propose one new test file only. The path must satisfy both Agent Task path scope and the private Reproduction Policy. The parent directory must already exist and must not be a symlink. Existing files are never overwritten. After writing, Git status must show exactly that one untracked test file and no other change; otherwise the new file is removed and the operation fails.

Generated JavaScript/TypeScript tests must parse, contain an explicit `test`/`it` call and assertion call, and may not use skip, focus, todo, fixme, expected-failure, lint, type-check, or coverage bypass constructs. Python tests require an explicit `test_` function and `assert`, while common skip/xfail constructs are rejected. The generated test is not executed by Reproduction v1.

```sh
bun run agent:reproduce -- generate \
  --task /private/tasks/reproduce.json \
  --role-policy /private/policy/agent-roles.json \
  --policy /private/policy/reproduction.json \
  --registry /private/state/agent-control.sqlite \
  --lease-id lease:example \
  --worker-id worker-example \
  --evaluated-at 2026-09-17T12:01:00Z \
  --worktree /private/worktrees/task \
  --diagnosis-input /private/tasks/diagnosis-input.json \
  --diagnosis-result /private/tasks/diagnosis-result.json \
  --hypothesis-id hypothesis-one \
  --model-config /private/config/model-backends.json \
  --backend worker-local \
  --model small-local \
  --json
```

Generation returns `PENDING_VERIFICATION`. A separate `verify` command accepts Reproduction Run Evidence v1 bound to the exact task, repository commit, test path, and SHA256. It re-applies task and reproduction policy, re-checks the linked worktree and test safety, and never reads raw runner logs. `outcome: FAIL` becomes `FAILING_TEST_REPORTED`, not “confirmed”: the toolkit did not independently execute the test, and caller-supplied `authenticated` metadata does not prove runtime truth. The later sandbox and signed-evidence layers can strengthen this boundary.

```sh
bun run agent:reproduce -- verify \
  --task /private/tasks/reproduce.json \
  --policy /private/policy/reproduction.json \
  --worktree /private/worktrees/task \
  --run-evidence /private/tasks/reproduction-run.json \
  --json
```

The public `templates/agent-reproduction-policy.v1.json` is generic. Repository paths, worker ids, leases, model mappings, worktree locations, and run evidence remain operator-owned private state.

## Initial roles

The initial safe roles are `diagnose`, `reproduce`, and `review`. They are intended to establish evidence quality before source-modifying automation is enabled. `repair`, `docs`, `contract`, `dependency`, and `incident` are reserved Agent Task v1 roles for later phases with separate policy and execution boundaries.

## Authority model

Task authority has independent filesystem, shell, and network dimensions. Role policy supplies the maximum allowed authority. A task whose requested authority exceeds its role policy is unroutable rather than silently downgraded.

Version 1 explicitly fixes merge, deployment, and production mutation authority to false. Later capabilities may propose such actions to an external human-controlled system, but this contract cannot grant them.

## Local model strategy

Model selection is class-based (`SMALL`, `STANDARD`, `STRONG`, `REVIEW`) and policy-driven. A persistent CPU worker can therefore service lightweight diagnosis or classification tasks while a compute worker with more memory or GPU capacity handles stronger review or coding work. There is no implicit cloud fallback.

Private deployment configuration supplies actual worker ids, model ids, endpoints, organization policy, and repository locations. Those values do not belong in the public toolkit.
