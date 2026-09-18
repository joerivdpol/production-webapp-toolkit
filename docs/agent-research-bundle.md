# Agent Research Bundle v1

Agent Research Bundle v1 packages bounded investigation material so an agent or human can revisit the same task without depending on chat history.

A bundle records:

* one exact Agent Task v1 identity
* one exact repository commit
* explicit tool ids and versions
* caller sanitized JSON evidence copied byte for byte
* declarative commands and purposes
* optional canonical Reproduction Run Evidence v1 metadata
* SHA256 and byte count bindings for every copied evidence file

The bundle is evidence packaging only. It does not execute commands, clone repositories, copy source trees, contact providers, or authorize mutation.

## Sanitization boundary

Every input evidence entry must explicitly declare sanitization mode CALLER_SANITIZED.

That declaration is not proof that every sensitive value has been removed.

The builder adds bounded structural hygiene checks before copying JSON evidence. It rejects several strong secret like key names and common credential value patterns, oversized structures, invalid JSON, symlinked inputs, and files outside configured byte limits.

Structural hygiene is deliberately described as bounded evidence, not a guarantee. Operators remain responsible for producing sanitized evidence before handing it to the bundle builder.

The public template uses only synthetic paths. Real evidence paths remain input only and are never persisted in the resulting manifest.

## Bundle contents

A generated bundle contains only:

* research-bundle.json
* one evidence directory
* the copied JSON evidence files declared by the manifest

The verifier fails if extra files, extra directories, symlinks, special files, missing files, changed SHA256 values, changed byte counts, or evidence that no longer passes structural hygiene are found.

Evidence output names are derived from evidence ids. Original source filenames and absolute source paths are not persisted.

The output directory and generated files use restrictive local permissions on Linux. The bundle format itself should still be treated according to the sensitivity of the sanitized evidence it contains.

## Commands are declarative

Research Bundle v1 stores commands only as:

* a symbolic command id
* a symbolic tool id
* a relative working directory
* bounded argument strings
* an INSPECT, TEST, or REPRODUCE purpose

The bundle builder and verifier never execute those commands.

Tool versions are explicit caller supplied metadata. The bundle does not infer installed versions or claim that a tool actually ran merely because it appears in the manifest.

For execution, use a separately authorized execution capability such as Task Worktree Sandbox v1. That execution must remain subject to its own role policy, lease, command allowlist, filesystem containment, network boundary, and resource limits.

## Reproduction metadata

Optional reproduction data must satisfy the existing Reproduction Run Evidence v1 contract.

The run evidence must bind the same task id, repository id, and exact commit as the Agent Task used to create the research bundle. Bundle creation time may not precede the reproduction evidence collection time.

A reproduction trust boolean remains metadata. It is not converted into cryptographic authentication by the research bundle.

If cryptographic provenance is required, verify the relevant evidence separately with Signed Evidence Verification v1.

## Build and verify

Build from an explicit Agent Task and Research Bundle Input v1 file:

    bun run agent:research-bundle -- build \
      --task /private/task.json \
      --input /private/research-input.json \
      --output /private/research-bundles/task-example \
      --json

Verify a bundle later:

    bun run agent:research-bundle -- verify \
      --bundle /private/research-bundles/task-example \
      --json

The builder refuses an existing output directory. It also refuses output under Git metadata.

The verifier performs no command execution and returns nonzero when integrity or hygiene checks fail.

## Public and private boundary

The public toolkit contains only the generic bundle contract, builder, verifier, synthetic template, and tests.

Do not place maintainer hostnames, IP addresses, remote access routes, private model mappings, credentials, production data, or unsanitized incident payloads in a public template or committed research bundle.

Each installation supplies its own evidence sources, task files, tool metadata, and storage location.

Maintainer-operated infrastructure is not a shared service for public toolkit users. Each installation must provide its own workers, model runtimes, evidence sources, and bundle storage.

Research Bundle v1 has no network, subprocess, environment secret, package manager, merge, deployment, or production mutation authority.
