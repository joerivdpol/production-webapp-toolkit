# Quality Gate Standard

This toolkit defines a staged quality model for established TypeScript web applications. It is intentionally framework-neutral and can be adopted without rewriting an application's build or test stack.

## Gate model

The core blocking gates are dependency installation from a lockfile, TypeScript validation, automated tests, changed-files lint on pull requests, and a production build. A full-repository lint can remain advisory during migration when legacy findings make immediate enforcement impractical.

Changed-files lint creates a ratchet: existing debt remains visible, but touched JavaScript and TypeScript must meet the current standard. The engine compares committed branch changes with a base revision and adds staged, unstaged, and untracked non-ignored files. It uses NUL-delimited Git output and process argument arrays so unusual filenames do not become shell commands.

The repository audit checks whether these controls exist. It detects structure and command wiring; it does not prove that tests are comprehensive or that a workflow's branch protection is configured. Human review and platform settings remain necessary.

## Required and optional capabilities

The audit treats package metadata, a recognized package manager, TypeScript configuration, the four standard scripts (`lint`, `typecheck`, `test`, and `check`), the changed-lint engine, CI, and blocking CI invocations for typecheck, tests, changed lint, and build as required.

Agent instructions, development documentation, Playwright configuration, and an E2E script are optional readiness indicators. They are valuable, but teams can add them after the core feedback loop is reliable.
