# Quality Gate Standard

This toolkit defines a staged quality model for established TypeScript web applications. It is intentionally framework-neutral and can be adopted without rewriting an application's build or test stack.

## Gate model

The core blocking gates are dependency installation from a lockfile, TypeScript validation, automated tests, changed-files lint on pull requests, and a production build. A full-repository lint can remain advisory during migration when legacy findings make immediate enforcement impractical.

Changed-files lint creates a ratchet: existing debt remains visible, but touched JavaScript and TypeScript must meet the current standard. The engine compares committed branch changes with a base revision and adds staged, unstaged, and untracked non-ignored files. It uses NUL-delimited Git output and process argument arrays so unusual filenames do not become shell commands.

The repository audit checks whether these controls exist. It detects structure and command wiring; it does not prove that tests are comprehensive or that a workflow's branch protection is configured. Human review and platform settings remain necessary.

## Required and optional capabilities

The audit treats package metadata, a recognized package manager, TypeScript configuration, the four standard scripts (`lint`, `typecheck`, `test`, and `check`), the changed-lint engine, CI, and blocking CI invocations for typecheck, tests, changed lint, and build as required.

Agent instructions and development documentation are optional. E2E readiness is also optional and has three indicators: Playwright configuration, a `test:e2e` or `e2e` script, and CI invocation. Adding CI detection changes the human score from 17 to 18 checks, while the required core remains unchanged at 13. A repository can therefore be core-complete at 13/13 without Playwright.

## Staged browser-testing model

Adopt E2E only after the core gate is reliable:

1. Level 1: the isolated app starts, the homepage and important routes render, and no fatal page error occurs.
2. Level 2: stable public navigation and non-destructive forms run against deterministic UI state.
3. Level 3: booking or other business flows use mocks or isolated, disposable fixtures. They never write production data.
4. Level 4: staging or provider-sandbox integration is separately scoped, credentialed, and authorized.

Production-facing browser tests are outside the default workflow and require separate explicit authorization.

## E2E safety baseline

The default `baseURL` must be a local or reserved test-only origin. Validate it before Playwright starts, explicitly reject production-looking/public origins, and provide no production fallback. E2E must not require production credentials, shared customer data, production APIs, or provider-facing smoke tests. The Playwright `webServer` owns local startup and readiness; a failed start or health check blocks the test run.

Use Chromium as the first blocking browser. Recommended diagnostics are trace on first retry and screenshots only on failure; keep video off unless it materially helps investigate failures. Each test must receive an isolated browser context.
