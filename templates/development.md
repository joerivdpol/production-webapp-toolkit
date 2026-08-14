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

Playwright is recommended after the repository reaches the 13/13 core quality standard. Use the conventional scripts `test:e2e`, `test:e2e:ui`, and `test:e2e:install`; the install command should fetch only Chromium initially. Browser installation must remain an explicit command, not a postinstall hook.

Build capability in stages: Level 1 starts the app and checks rendering/no fatal errors; Level 2 covers deterministic public navigation and forms; Level 3 covers business flows only with mocks or isolated disposable fixtures; Level 4 covers staging/provider sandboxes only with separate authorization.

The default configuration must fail closed: accept only a loopback or reserved test-only base URL, reject production-looking origins, start the application through Playwright `webServer`, and fail if readiness is not reached. It must not need production credentials, shared data, production APIs, or provider-facing tests.

Production-facing E2E is outside the normal development workflow and requires explicit approval separate from ordinary test authorization.
