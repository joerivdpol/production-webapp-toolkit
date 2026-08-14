# Production Webapp Toolkit

Production Webapp Toolkit is a small, reusable set of CI gates, repository diagnostics, and development templates for existing TypeScript/Bun web applications. It addresses a common migration problem: a repository needs stronger safeguards now, but enforcing every modern rule across all legacy code at once is not practical.

The toolkit is generic, read-only where it inspects other repositories, and contains no application or provider configuration.

## Quality-gate model

The recommended blocking path is frozen dependency installation, typechecking, automated tests, changed-files lint on pull requests, and a production build. Full-repository lint can remain advisory during a measured legacy cleanup.

The changed-files strategy acts as a ratchet. [`scripts/lint-changed.js`](scripts/lint-changed.js) safely collects added, modified, copied, and renamed JS/JSX/TS/TSX files from the branch comparison, tracked local changes, and untracked non-ignored files. Deleted files are ignored. Git output is NUL-delimited, paths are passed without shell interpolation, and ESLint's exit status remains blocking.

## Quick start

Requires Bun and Node.js 20 or newer.

```sh
bun install --frozen-lockfile
bun run check
bun run audit /path/to/repository
bun run lint:changed origin/main
```

The audit is also directly executable:

```sh
node scripts/audit-repository.js /path/to/repository
```

It prints a human-readable scorecard and never modifies the target. The score has 18 checks: 13 required core checks plus five optional documentation/E2E indicators. E2E readiness consists of a Playwright config, an E2E package script, and CI invocation; it does not affect the 13/13 core result. The process exits non-zero only when a required core check is absent.

## Optional Playwright foundation

After a repository reaches the 13/13 core standard, copy and adapt [`templates/playwright/`](templates/playwright/) and the separate E2E job in [`templates/github-actions/bun-webapp-ci-with-e2e.yml`](templates/github-actions/bun-webapp-ci-with-e2e.yml). The template is Chromium-first, starts its own local server, captures retry/failure diagnostics, and validates the target before any browser starts.

Adopting repositories should pin `@playwright/test` and expose `test:e2e`, `test:e2e:ui`, and `test:e2e:install`. Browser installation is explicit rather than a postinstall side effect. The default foundation accepts only loopback and reserved `.test`/`.localhost` origins; it needs no production credentials or provider access.

## AI-agent workflow

[`templates/AGENTS.md`](templates/AGENTS.md) defines a conservative starting agreement: inspect before editing, work away from `main`, protect secrets and production systems, make reviewable changes, run local gates, and obtain explicit authorization before repository publication or operational actions. [`docs/ai-agent-workflow.md`](docs/ai-agent-workflow.md) explains how agent behavior and CI verification complement each other.

## Project structure

```text
scripts/                         changed-files lint and repository audit CLIs
test/                            deterministic parser and audit fixture tests
templates/github-actions/        reusable Bun web application CI example
templates/playwright/             fail-closed Playwright config, helper, and smoke suite
templates/AGENTS.md              generic agent guardrails
templates/development.md         generic contributor workflow
docs/                            standard, rollout, and agent architecture
.github/workflows/ci.yml         CI for this toolkit
```

See [`docs/standard.md`](docs/standard.md) for the architecture and required/optional distinction, and [`docs/multi-repo-rollout.md`](docs/multi-repo-rollout.md) for staged adoption guidance.

## Roadmap

- Test the changed-files engine against a broader Git compatibility matrix.
- Add machine-readable audit output without changing the human scorecard.
- Provide version-pinned CI template variants.
- Add machine-readable detail for E2E readiness levels.
- Document branch-protection verification, which cannot be inferred from repository files alone.

## License

MIT
