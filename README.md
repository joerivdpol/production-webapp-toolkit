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

It prints a human-readable scorecard and never modifies the target. Required checks cover the core install, TypeScript, scripts, changed-lint, and CI baseline; agent documentation and E2E readiness are optional. The process exits non-zero when a required core check is absent.

## AI-agent workflow

[`templates/AGENTS.md`](templates/AGENTS.md) defines a conservative starting agreement: inspect before editing, work away from `main`, protect secrets and production systems, make reviewable changes, run local gates, and obtain explicit authorization before repository publication or operational actions. [`docs/ai-agent-workflow.md`](docs/ai-agent-workflow.md) explains how agent behavior and CI verification complement each other.

## Project structure

```text
scripts/                         changed-files lint and repository audit CLIs
test/                            deterministic parser and audit fixture tests
templates/github-actions/        reusable Bun web application CI example
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
- Add optional Playwright/E2E foundations with isolated example fixtures.
- Document branch-protection verification, which cannot be inferred from repository files alone.

## License

MIT
