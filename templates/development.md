# Development

## Local workflow

Install the Bun version used by the repository, then install exact locked dependencies:

```sh
bun install --frozen-lockfile
```

Before opening a review, run the blocking local gates:

```sh
bun run typecheck
bun run test
bun run build
```

`bun run lint` checks the full repository. In a legacy application it may initially be advisory while existing findings are reduced. New and modified JavaScript and TypeScript must still pass the blocking incremental gate:

```sh
bun run lint:changed origin/main
```

The changed-files command also considers tracked working-tree changes and untracked, non-ignored files, making it useful before a commit.

## End-to-end testing

Playwright is a recommended future gate once the application has stable test fixtures and isolated test environments. Keep E2E tests deterministic and avoid reliance on shared production data.

Production-facing smoke tests, provider calls, or any operation that could affect real users require explicit approval. Prefer local or dedicated test environments.
