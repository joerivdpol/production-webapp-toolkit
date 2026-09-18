# Testcontainers Integration v1

Testcontainers Integration v1 provides disposable synthetic database and service environments for integration tests.

The public toolkit pins `testcontainers@12.1.0`. Scenario policy declares one exact repository commit, a bounded set of services, startup timeout, and synthetic-only environment values.

The integration intentionally does not expose a general Docker executor.

## Scenario policy

A Testcontainers Scenario Policy v1 requires:

- exact repository id and full Git commit
- exact Testcontainers version `12.1.0`
- portable scenario id
- `dataClassification: SYNTHETIC_ONLY`
- bounded startup timeout
- one to eight containers
- explicit image version tag or immutable sha256 digest
- one or more container ports
- optional environment entries classified `SYNTHETIC`

`latest`, untagged images, fixed host-port objects, duplicate ports, duplicate environment keys, host-network fields, privileged fields, and unknown container fields are rejected.
The public template uses immutable Redis and PostgreSQL digests:

```text
redis@sha256:e957842a3e7962bfe3e5ab9814eab06e029a2f0d7b0f5d74178af12713b9ab4d
postgres@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73
```

See `templates/testcontainers-scenario-policy.v1.json`.

## Validate without Docker execution

```sh
bun run integration:testcontainers -- validate \
  --policy /private/testcontainers-scenario-policy.json \
  --json
```

Validation does not start containers.

## Controlled execution

Programmatic integration uses `withSyntheticTestcontainers()`.

Before any container starts, the toolkit verifies that the supplied repository is a regular non-symlink Git root, its HEAD equals the policy commit exactly, and the checkout is clean.
Each container receives only:

- the explicitly versioned or digest-pinned image
- dynamically mapped container ports
- bounded startup timeout
- listening-port wait strategy
- explicitly declared synthetic environment values

Version 1 has no API for fixed host ports, bind mounts, privileged mode, host network, Docker socket mounts, container commands, entrypoint replacement, or production credentials.

Testcontainers may use the operator Docker runtime to acquire an image when it is not already present. That image acquisition occurs outside the disposable container and may use the operator host network. The toolkit does not claim Docker daemon isolation.

## Private callback runtime

The callback receives ephemeral runtime connection data:

- service id
- image identity
- runtime host
- dynamically mapped ports

That data is deliberately omitted from normalized evidence.

The toolkit supplies no production dataset or credentials to the callback. `SYNTHETIC_ONLY` is an authorization boundary, not proof that arbitrary external callback code cannot violate operator policy.
Application integration callbacks remain responsible for using synthetic fixtures only.

## Cleanup

Containers start sequentially and stop in reverse order.

Cleanup is attempted when:

- all services start and the callback succeeds
- the callback throws
- a later service fails during startup

A cleanup failure is blocking. Private callback errors and provider/runtime details are not forwarded in the normalized error message.

Normalized evidence contains cleanup counts and status but not container ids, runtime hosts, mapped ports, environment values, raw logs, or callback return values.

## Real runtime smoke

The repository includes a separate Docker-dependent Redis smoke:

```sh
bun run integration:testcontainers:smoke
```

It creates a temporary synthetic Git repository, starts the digest-pinned Redis image, performs `PING`, synthetic `SET`, and `GET` over the dynamically mapped port, then verifies cleanup.
The normal `bun test` suite uses injected fake Testcontainers primitives and therefore remains Docker-independent. CI runs the real smoke as a separate step so library/runtime drift is still caught.

The PostgreSQL profile has also been verified with the digest-pinned PostgreSQL 17 Alpine image and synthetic disposable credentials. Project-specific database schemas and business invariants remain outside the public toolkit.

## Infrastructure boundary

Running Testcontainers requires Docker authority on the machine executing the integration.

The public repository does not contain access to maintainer Lenovo or Ubuntu workers, Docker endpoints, SSH routes, tailnet details, credentials, or hosted agent infrastructure.

Users who adopt the toolkit must provide their own Docker-capable runner/server.

Do not expose the host Docker socket to AI-agent sandboxes. Testcontainers execution should remain an operator-controlled or explicitly isolated worker capability.

The evidence adapter does not authorize merge, deployment, payment, booking, migration, or production mutation.
