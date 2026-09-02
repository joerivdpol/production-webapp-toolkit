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
bun run audit:git-governance /path/to/repository
bun run audit:production-baseline /path/to/repository --expected-ref origin/production/example --compare-ref HEAD
bun run audit:deployment /path/to/repository --expected-ref origin/production/example --deployed-commit 0123456789abcdef0123456789abcdef01234567
bun run audit:repository-status /path/to/repository --expected-ref origin/production/example --compare-ref HEAD
bun run audit:all --projects-root "$HOME/projects"
bun run lint:changed origin/main
```

The audit is also directly executable:

```sh
node scripts/audit-repository.js /path/to/repository
```

It prints a human-readable scorecard and never modifies the target. The score has 18 checks: 13 required core checks plus five optional documentation/E2E indicators. E2E readiness consists of a Playwright config, an E2E package script, and CI invocation; it does not affect the 13/13 core result. The process exits non-zero only when a required core check is absent. Add `--json` to the direct command for the engine's machine-readable report.

## Offline Git governance audit

`bun run audit:git-governance /path/to/repository` reads local Git metadata and refs to make branch governance visible. It is read only: it never fetches, pulls, switches branches, writes Git configuration, or contacts a Git host. Add `--json` for a machine-readable report.

The audit reports local remotes, fetch refspecs, remote-tracking refs, locally resolvable remote `HEAD` refs, current-branch upstream and ahead/behind state, plus names that look production-like (`production`, `production/*`, `prod`, or `prod/*`). A production-like name is only a candidate: the audit never decides which branch is the canonical production truth. Restricted fetch refspecs, missing local remote `HEAD`, absent upstreams, and branch divergence are governance warnings rather than code-quality failures. This first version makes no network verification, including no GitHub default-branch or branch-protection lookup.

## Offline production baseline audit

`bun run audit:production-baseline /path/to/repository --expected-ref origin/production/example --compare-ref HEAD` verifies an explicitly supplied production-baseline contract using only local Git objects and refs. It never chooses a production branch from a name: `production/*` has no special meaning to this command. Supply at least one baseline selector: `--expected-ref <git-ref>` and/or `--expected-commit <commit>`. `--expected-ref` and `--compare-ref` accept real local refs (including short and fully-qualified refs) plus the explicit `HEAD` pseudo-ref; Git revision expressions such as `HEAD~1`, `main^`, and `main@{1}` are not accepted. `--compare-ref <git-ref>` is an optional, explicitly supplied second ref with no inferred semantics. Add `--json` for a stable machine-readable report.

The audit is fully offline and read only: it does not fetch, contact a host, change a checkout, update refs, or write target-repository files. A locally missing remote-tracking ref means only that it cannot be verified from the locally available metadata; it does **not** establish that the remote branch does not exist. The report separates `technicalStatus` (`PASS` or `FAIL`) from `baselineStatus`: `MATCH` means the explicit contract was locally verified, `MISMATCH` means supplied ref and commit resolve to different commits, and `UNVERIFIED` means a required local ref or commit was unavailable. `MISMATCH` and `UNVERIFIED` produce `overallStatus: WARN` and exit 0; technical failures produce `overallStatus: FAIL` and exit 1.

When a comparison resolves, `exactMatch` and its genealogy are reported as `same`, `expected-ancestor-of-comparison`, `comparison-ancestor-of-expected`, or `diverged`. `ahead` and `behind` are explicitly relative to the expected baseline: `ahead` counts comparison-only commits and `behind` counts expected-only commits.

## Deployment verification

`bun run audit:deployment /path/to/repository --expected-ref origin/production/example --deployed-commit 0123456789abcdef0123456789abcdef01234567` answers one narrow question: whether an explicitly supplied deployed commit exactly equals an explicitly declared production baseline. Supply at least one baseline selector, `--expected-ref <git-ref>` and/or `--expected-commit <commit>`, plus `--deployed-commit <commit>`. The deployed value must be a full 40-character SHA-1 or 64-character SHA-256 object ID; abbreviated IDs, refs, and revision expressions are rejected. Hex case is normalized for comparison.

The deployed commit is caller-supplied runtime evidence, represented in the report as `evidence.type: "explicit-commit"`, `source: "caller-supplied"`, and `authenticated: false`. This auditor does not collect or cryptographically authenticate runtime evidence. It makes no SSH, system, container, HTTP, Git-host, or remote-runtime request, and never reads runtime state or private configuration.

For direct in-process callers, an absent or invalid deployed value is reported as `deploymentStatus: "UNVERIFIED"` with an evidence warning; it is never treated as a proven mismatch. The CLI continues to reject invalid deployed values during argument validation.

`deploymentStatus` is `MATCH` when that evidence equals a reliably locally resolved baseline, `MISMATCH` when it reliably differs, and `UNVERIFIED` when the baseline cannot be established locally or the supplied ref-and-commit contract is inconsistent. It does not select a branch from `production/*`, `main`, a remote default, or governance candidates. `technicalStatus` is independent: a baseline-inspection failure is `FAIL`; otherwise it is `PASS`. `MATCH` produces overall `PASS`; `MISMATCH` and `UNVERIFIED` produce overall `WARN` and exit 0; technical `FAIL` produces overall `FAIL` and exit 1. No deployment genealogy is inferred.

Use `--json` for the stable machine-readable report:

```sh
bun run audit:deployment /path/to/repository --expected-commit 0123456789abcdef0123456789abcdef01234567 --deployed-commit 0123456789abcdef0123456789abcdef01234567 --json
```

## Runtime evidence contract

`bun run runtime:evidence --file ./runtime-evidence.json` validates a versioned, machine-readable runtime-evidence document. Version 1 is deliberately a contract boundary: a collector supplies evidence, this command normalizes and validates it, and a later deployment-verification capability may compare it with an explicit production baseline. This command does not inspect a baseline or decide what any runtime environment means.

Version 1 accepts this schema. Required string values are trimmed during normalization; commits are also normalized to lowercase.

```json
{
  "version": 1,
  "runtime": {
    "name": "runtime-a",
    "environment": "production"
  },
  "deployment": {
    "commit": "0123456789abcdef0123456789abcdef01234567"
  },
  "evidence": {
    "source": "manual",
    "authenticated": false,
    "collectedAt": "2026-09-01T12:00:00Z"
  },
  "metadata": {
    "collectorNote": "generic example"
  }
}
```

`version` must be exactly `1`. `runtime.name`, `deployment.commit`, and all fields in `evidence` are required; `runtime.environment` is optional metadata with no special meaning. A commit must be a full 40-character SHA-1 or 64-character SHA-256 hexadecimal object ID—never an abbreviation, ref, `HEAD`, branch name, or revision expression. `collectedAt` must be a real absolute ISO 8601 calendar timestamp with a timezone (`Z` or an offset); no collection time is generated automatically. Unknown fields are rejected in the version-1 top level, `runtime`, `deployment`, and `evidence` objects. `metadata` is the extension location and may contain only JSON-serializable values. As a small structural safeguard, metadata keys are split into camelCase and separator-delimited components, normalized to lowercase, and rejected only when a component is exactly `token`, `tokens`, `password`, `passwords`, `secret`, `secrets`, `credential`, `credentials`, `env`, or `environment`; this check is case-insensitive and recursive, including objects inside arrays. Metadata values are not scanned; this remains a structural key safeguard, not a secrets scanner. Evidence must not contain credentials, tokens, environment values, or other secrets.

The validation API is `validateRuntimeEvidence(value)`. It never throws for ordinary schema failures and returns a stable result: `{ valid, evidence, errors }`. On success, `evidence` contains the normalized document; on failure it is `null` and `errors` contains stable machine-readable IDs.

Use JSON output when another program consumes the normalized result:

```sh
bun run runtime:evidence --file ./runtime-evidence.json --json
```

The command accepts only `--file <path>` and `--json`. A missing option, unknown option, unreadable file, malformed JSON, or invalid schema exits 1; valid schema exits 0. Human output lists the runtime, environment, commit, source, authenticated state, collection time, and `Result: VALID`.

Schema validity is not proof that the evidence is authenticated, and `authenticated: true` is not proof that its claims are correct. `source`, `authenticated`, and `collectedAt` remain collector-supplied trust metadata; this contract assigns no automatic trust meaning to a source and does not infer authentication. Comparing structurally valid evidence to a baseline also does not prove runtime authenticity. Collectors remain responsible for gathering and representing their own evidence.

The command is offline and read only. It reads only the explicitly supplied evidence JSON file, never changes that file, and performs no Git inspection or command, network, SSH, systemd, Docker, HTTP, runtime probe, environment-variable or `.env` read, baseline inspection, or timestamp generation. It does not collect evidence automatically.

## Repository status

`bun run audit:repository-status /path/to/repository` combines the existing profiled quality, offline Git-governance, and optional production-baseline audits into one read-only scorecard. It does not reimplement their rules or infer production truth.

`QUALITY` passes only when the detected webapp or Python-service profile passes its required core checks. `GOVERNANCE` preserves the Git governance audit's `PASS`, `WARN`, or `FAIL` result. `BASELINE` is run only when `--expected-ref <git-ref>` and/or `--expected-commit <commit>` is explicitly supplied; all three baseline options are forwarded unchanged, including the baseline auditor's revision-expression restrictions.

Without an explicit baseline selector, the scorecard reports `baselineConfigured: false` in JSON and `BASELINE NOT_CONFIGURED`. This means no production truth has been declared; it never selects from production-like candidates, `main`, `origin/main`, or a remote default branch. It is a readiness warning, not a technical defect.

```sh
bun run audit:repository-status /path/to/repository --expected-ref origin/production/example --compare-ref HEAD
bun run audit:repository-status /path/to/repository --expected-ref origin/production/example --compare-ref HEAD --json
```

The top-level JSON has stable `root`, `profile`, `baselineConfigured`, `dimensions`, `technicalStatus`, `overallStatus`, and `summary` fields. `WARN` is not a technical failure: governance warnings, an unconfigured baseline, and baseline `MISMATCH` or `UNVERIFIED` exit 0. The command exits 1 only for `overallStatus: FAIL`, including quality failure, governance technical failure, or a configured baseline technical failure; it exits 0 for `PASS` and `WARN`.

## Ecosystem status

`bun run audit:ecosystem-status` aggregates the canonical repository-status report for several repositories. It does not add QUALITY, GOVERNANCE, or BASELINE rules, choose a branch, or infer a production baseline from `main`, remote `HEAD`, or governance production candidates.

Use positional repository paths when no repository has a configured production baseline. Every positional repository therefore reports `BASELINE NOT_CONFIGURED` and contributes an overall warning when its other dimensions pass:

```sh
bun run audit:ecosystem-status /path/to/app-a /path/to/worker-b --json
```

Use `--config` for explicit, per-repository baseline selectors. Positional paths and `--config` are mutually exclusive. Version 1 configuration uses this contract (relative repository paths are resolved relative to the config file):

```json
{
  "version": 1,
  "repositories": [
    {
      "name": "app-a",
      "path": "/path/to/app-a",
      "expectedRef": "origin/production",
      "compareRef": "HEAD"
    },
    {
      "name": "worker-b",
      "path": "/path/to/worker-b",
      "expectedCommit": "abc1234"
    },
    {
      "path": "/path/to/app-c"
    }
  ]
}
```

`name` is display metadata only. A repository with no `expectedRef` or `expectedCommit` remains `NOT_CONFIGURED`; `compareRef` requires one of those selectors. Baseline ref and commit validation is delegated unchanged to the repository-status baseline auditor. Duplicate resolved target paths are rejected, preventing duplicate counts.

```sh
bun run audit:ecosystem-status --config /private/path/ecosystem-status.json
bun run audit:ecosystem-status --config /private/path/ecosystem-status.json --json
```

The stable JSON report contains `inputMode`, optional `configVersion`, ordered `repositories`, machine-readable `summary`, `technicalStatus`, and `overallStatus`; it never prints config-file contents or the config path. Overall status is `FAIL` when any repository fails, otherwise `WARN` when any repository warns, otherwise `PASS`. Technical status fails only when at least one repository has a technical failure. `FAIL` exits 1; `PASS` and `WARN` exit 0. A failed or missing target is isolated to that repository so the remaining repositories are still inspected.

The command is read only and offline. The ecosystem layer only reads an explicitly supplied JSON config and calls the in-process repository-status inspector; it runs no Git command itself and performs no fetch, network request, checkout, or target-repository write.

## Multi-repository audit

`bun run audit:all` audits the latest `origin/main` of the five default application repositories beneath `~/projects`. It runs sequentially and prints one row per repository plus aggregate total and core scores. Override the parent directory or selection without editing the script:

```sh
bun run audit:all --projects-root /path/to/projects
bun run audit:all --projects-root /path/to/projects --repo app-one --repo app-two
bun run audit:all --projects-root /path/to/projects --repo app-one,app-two --json
bun run audit:all --projects-root /path/to/projects --no-fetch
```

By default, the command runs `git fetch origin` and resolves `origin/main` to an exact commit. It checks that commit in a uniquely named detached worktree beneath the operating system's temporary directory, invokes the existing single-repository audit engine there, and removes the temporary worktree in a `finally` cleanup. The checked-out branch, index, tracked files, and untracked files in the active application worktree are never switched, reset, stashed, cleaned, rebased, pulled into, or otherwise changed. `--no-fetch` skips network access and audits the currently available local `origin/main`, which is useful for offline and repeatable runs.

An optional miss can reduce the 18-check score while the repository still passes at 13/13 core. A missing repository, fetch error, missing `origin/main`, audit execution error, cleanup error, or core score below 13/13 makes the aggregate result fail and exits non-zero. JSON output contains `repositories` (each with `repository`, `path`, `commit`, `totalScore`, `totalChecks`, `coreScore`, `coreChecks`, `passed`, and `errors`) and `aggregate` with summed scores and `passed`.

Run the multi-repository audit before a coordinated change to capture a baseline, and again after each repository's changes reach `origin/main`. Use `--no-fetch` only when the caller has deliberately established the remote-tracking refs to audit.

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
- Provide version-pinned CI template variants.
- Add machine-readable detail for E2E readiness levels.
- Document branch-protection verification, which cannot be inferred from repository files alone.

## License

MIT

## v1 capability surface

Production Webapp Toolkit v1 supports repository profiles and profiled auditing for TypeScript webapps and Python services.

It provides dependency drift auditing across repositories, including version differences and reproducibility gaps.

It provides public repository safety checks for tracked sensitive files and secret-like content. The toolkit runs this check as a blocking CI gate and does not print detected secret values.

It provides architecture compliance through external versioned policy files. Organization-specific policy remains outside this public toolkit.

The toolkit also provides safe repository bootstrap, remediation planning and execution, ecosystem auditing, and self-contained v1 release-readiness validation.

Useful commands:

- bun run audit:profiled /path/to/repository
- bun run audit:ecosystem /path/to/repository-one /path/to/repository-two
- bun run audit:drift /path/to/app-one /path/to/app-two
- bun run audit:safety .
- bun run audit:architecture --policy /private/path/policy.json
- bun run audit:git-governance /path/to/repository --json
- bun run bootstrap /path/to/repository --dry-run
- bun run remediation:plan /path/to/repository
- bun run remediation:apply /path/to/repository --dry-run
- bun run audit:release .
