# Production Webapp Toolkit

Production Webapp Toolkit is a small, reusable set of CI gates, repository diagnostics, and development templates for existing TypeScript/Bun web applications. It addresses a common migration problem: a repository needs stronger safeguards now, but enforcing every modern rule across all legacy code at once is not practical.

The toolkit is generic, read-only where it inspects other repositories, and contains no application or provider configuration. Planned evolution is tracked in [`docs/roadmap.md`](docs/roadmap.md).

## Quality-gate model

The recommended blocking path is frozen dependency installation, typechecking, automated tests, changed-files lint on pull requests, and a production build. Full-repository lint can remain advisory during a measured legacy cleanup.

The changed-files strategy acts as a ratchet. [`scripts/lint-changed.js`](scripts/lint-changed.js) safely collects added, modified, copied, and renamed JS/JSX/TS/TSX files from the branch comparison, tracked local changes, and untracked non-ignored files. Deleted files are ignored. Git output is NUL-delimited, paths are passed without shell interpolation, and ESLint's exit status remains blocking.

## Quick start

The reference toolchain is Node.js 24.21.0 and Bun 1.3.14. CI uses the same pinned versions. The supported Node.js engine range for v1.1 is 24.x.

```sh
bun install --frozen-lockfile
bun run check
bun run audit /path/to/repository
bun run audit:git-governance /path/to/repository
bun run audit:production-baseline /path/to/repository --expected-ref origin/production/example --compare-ref HEAD
bun run audit:deployment /path/to/repository --expected-ref origin/production/example --deployed-commit 0123456789abcdef0123456789abcdef01234567
bun run audit:repository-status /path/to/repository --expected-ref origin/production/example --deployed-commit 0123456789abcdef0123456789abcdef01234567
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

Deployment verification answers one narrow question: whether an explicitly supplied deployed commit exactly equals an explicitly declared production baseline. Supply at least one baseline selector, `--expected-ref <git-ref>` and/or `--expected-commit <commit>`, and exactly one evidence input:

```sh
bun run audit:deployment /path/to/repository --expected-ref origin/production/example --deployed-commit 0123456789abcdef0123456789abcdef01234567
bun run audit:deployment /path/to/repository --expected-ref origin/production/example --evidence-file ./runtime-evidence.json
bun run audit:deployment /path/to/repository --expected-ref origin/production/example --evidence-file ./runtime-evidence.json --max-evidence-age-seconds 3600 --evaluated-at 2026-09-16T12:00:00Z
bun run audit:deployment /path/to/repository --expected-ref origin/production/example --evidence-file ./runtime-evidence.json --expected-runtime-name runtime-a --expected-runtime-environment production
```

`--deployed-commit` accepts only a full 40-character SHA-1 or 64-character SHA-256 object ID; abbreviated IDs, `HEAD`, refs, branches, and revision expressions are rejected. Hex case is normalized for comparison. `--evidence-file` reads only that explicit JSON file, parses it, and validates and normalizes it through Runtime Evidence Contract v1 before using its `deployment.commit`. The two inputs are mutually exclusive; absent input, both inputs, unknown options, or a missing value are CLI failures (exit 1). Missing or unreadable files, malformed JSON, and schema-invalid evidence files are also input failures (exit 1), with no fallback to a ref, branch, baseline, `HEAD`, or other commit source.

Direct commits remain represented as `evidence.type: "explicit-commit"`, `source: "caller-supplied"`, and `authenticated: false`. Evidence-file reports instead use `evidence.type: "runtime-evidence"` and retain the validated `source`, `authenticated`, `collectedAt`, and `runtime` (`name` and optional `environment`) fields. These are compact trust metadata only: `runtime.environment` and `source` get no inferred meaning, and `authenticated: true` never turns a mismatch into a match or a warning into a pass. Schema validity is not runtime authenticity; it only proves that the supplied document satisfies the contract.

Runtime Evidence can optionally be evaluated against an explicit freshness policy with `--max-evidence-age-seconds <seconds>` and `--evaluated-at <absolute-iso-timestamp>`. Both options are required together and are valid only with `--evidence-file`. The evaluator never reads the system clock and never generates an evaluation time. Age is calculated deterministically as `evaluatedAt - collectedAt`; an age equal to the maximum remains `FRESH`, an older observation is `STALE`, and evidence collected after the explicit evaluation time is `FUTURE`. Without a policy, runtime evidence reports freshness as `NOT_CONFIGURED`; direct commit evidence reports `NOT_APPLICABLE`.

Freshness is independent from commit identity. A stale or future-dated observation can still have `deploymentStatus: "MATCH"`, because its commit matches the baseline, but its overall readiness becomes `WARN`. `FRESH` evidence does not add authenticity: it only establishes recency relative to the caller-supplied policy and evaluation time.

Runtime Evidence can also be bound to an explicit runtime identity with `--expected-runtime-name <name>` and optional `--expected-runtime-environment <environment>`. Environment binding requires a runtime name, and identity policy is valid only with `--evidence-file`. Policy strings are trimmed and then compared exactly and case-sensitively with the normalized Runtime Evidence values. The toolkit assigns no special semantics to names such as `production`, `staging`, or `development`.

A matching identity reports `runtimeIdentity.status: "MATCH"`; a different runtime name, a different configured environment, or a missing evidence environment when one is explicitly expected reports `MISMATCH`. Identity binding is independent from commit truth and freshness. Evidence for the wrong runtime can therefore still have `deploymentStatus: "MATCH"`, but repository readiness becomes `WARN`. Without an identity policy, Runtime Evidence reports `NOT_CONFIGURED`; direct commits report `NOT_APPLICABLE`.

This auditor does not collect or cryptographically authenticate runtime evidence. It makes no SSH, system, container, HTTP, Git-host, or remote-runtime request, and never reads runtime state or private configuration. Apart from its existing local, read-only production-baseline inspection, evidence mode reads only the requested evidence file; it does not modify that input or generate timestamps.

For direct in-process callers, an absent or invalid deployed value is reported as `deploymentStatus: "UNVERIFIED"` with an evidence warning; it is never treated as a proven mismatch. Caller-supplied runtime-evidence metadata is ignored by that public API, so only the evidence-file flow can establish the validated runtime-evidence report variant. The CLI continues to reject invalid deployed values during argument validation.

`deploymentStatus` is `MATCH` when that evidence equals a reliably locally resolved baseline, `MISMATCH` when it reliably differs, and `UNVERIFIED` when the baseline cannot be established locally or the supplied ref-and-commit contract is inconsistent. Runtime evidence never selects the production baseline: only `--expected-ref` and/or `--expected-commit` do that. It does not select a branch from `production/*`, `main`, a remote default, or governance candidates. `technicalStatus` is independent: a baseline-inspection failure is `FAIL`; otherwise it is `PASS`. A `MATCH` produces overall `PASS` unless a configured freshness policy reports `STALE` or `FUTURE`, or a configured runtime identity policy reports `MISMATCH`; those conditions produce overall `WARN` while preserving the commit match. `MISMATCH` and `UNVERIFIED` deployment states also produce overall `WARN` and exit 0; technical `FAIL` produces overall `FAIL` and exit 1. No deployment genealogy or production truth is inferred.

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

## CI evidence and verification

`bun run ci:evidence --file ./ci-evidence.json` validates CI Evidence Contract v1. The contract represents evidence for one exact Git object ID and contains explicit CI provider metadata, collector-supplied trust metadata, and a non-empty set of uniquely named check results. It is provider-neutral: a future GitHub Actions, GitLab, or other collector can emit the same contract without changing verification semantics.

```json
{
  "version": 1,
  "commit": "0123456789abcdef0123456789abcdef01234567",
  "ci": {
    "provider": "github-actions",
    "workflow": "CI",
    "runId": "12345"
  },
  "evidence": {
    "source": "github-api",
    "authenticated": false,
    "collectedAt": "2026-09-16T05:00:00Z"
  },
  "checks": [
    { "name": "typecheck", "status": "PASS" },
    { "name": "test", "status": "PASS" },
    { "name": "lint", "status": "PASS" },
    { "name": "build", "status": "PASS" }
  ]
}
```

The commit must be a full 40-character SHA-1 or 64-character SHA-256 object ID and is normalized to lowercase. `ci.provider`, `evidence.source`, and each check name are required non-empty strings. `ci.workflow` and `ci.runId` are optional metadata. `evidence.authenticated` is a boolean trust claim supplied by the collector; it does not change verification truth. `evidence.collectedAt` uses the same absolute ISO 8601 timestamp validator as Runtime Evidence. Check names are trimmed, unique, exact, and case-sensitive. A check status is exactly `PASS`, `FAIL`, or `SKIPPED`. Unknown version-1 fields are rejected.

Use the separate verifier to compare validated CI evidence with an explicit expected commit and explicit required checks:

```sh
bun run audit:ci \
  --evidence-file ./ci-evidence.json \
  --expected-commit 0123456789abcdef0123456789abcdef01234567 \
  --require-check typecheck \
  --require-check test \
  --require-check lint \
  --require-check build
```

Verification keeps commit truth and check truth separate. An exact commit with every required check `PASS` is overall `PASS`. A commit mismatch is `WARN` when the required checks otherwise pass. A required check that explicitly reports `FAIL` is blocking overall `FAIL`. A required check that is `SKIPPED` or absent from the evidence is `UNVERIFIED` and produces overall `WARN`. Failed or skipped checks that were not explicitly required do not affect the verification result. Invalid evidence or an invalid verification policy is an input failure rather than a CI status result. `FAIL` verification exits 1; `PASS` and `WARN` verification exit 0.

Both commands are offline and read only. They read only the explicitly supplied evidence file, run no Git command, make no network request, read no environment variables, and write no files. CI Evidence Contract validity does not prove that the source is authenticated or that a provider actually produced the document. Collection and provider authentication are separate adapters.

### GitHub Actions CI evidence adapter

`bun run ci:evidence:github-actions` converts explicit GitHub Actions workflow-run and jobs REST payloads into CI Evidence Contract v1. The adapter itself remains offline and read only: it does not call GitHub, read authentication tokens, inspect environment variables, or write output files. The caller is responsible for obtaining the two payloads and supplying an explicit collection timestamp.

```sh
bun run ci:evidence:github-actions \
  --run-file ./workflow-run.json \
  --jobs-file ./workflow-jobs.json \
  --collected-at 2026-09-16T07:40:29Z \
  --authenticated \
  --json
```

The workflow run must have `status: completed`, a non-empty name, a valid run ID, a full `head_sha`, and a conclusion. Every job must belong to that run, have `status: completed`, and have a unique non-empty name. GitHub job conclusions map deterministically: `success` becomes `PASS`; `skipped` and `neutral` become `SKIPPED`; `failure`, `cancelled`, `timed_out`, `action_required`, `startup_failure`, and `stale` become `FAIL`. Unknown conclusions, in-progress runs or jobs, mismatched run IDs, duplicate job names, or empty job sets are rejected rather than guessed.

The adapter emits `provider: github-actions`, the workflow name, the run ID, and job names as CI check names. `--authenticated` only records a caller-supplied trust claim that the input payloads came through an authenticated collection path; it is not cryptographic proof and does not alter CI verification truth. `--collected-at` is mandatory because the adapter never generates or substitutes a collection time.

An optional read-only online collector can obtain those payloads through an already authenticated GitHub CLI session and feed the same adapter:

```sh
bun run ci:evidence:github-actions:collect \
  --repository owner/repository \
  --run-id 35070038181 \
  --json > ci-evidence.json
```

The collector requires an explicit `owner/repository` and explicit numeric workflow run ID. It never selects the latest run, a branch, a commit, or a workflow automatically. It first verifies `gh auth status --hostname github.com`, then performs only `gh api --method GET` requests for the named workflow run and all of its job pages. Job pagination uses `per_page=100` until the API `total_count` is reached exactly. Authentication tokens are never command arguments or output, provider stderr is not forwarded, and collection failures return generic error messages. The shell redirect in the example writes the evidence file; the collector itself performs no file writes or Git mutations.

Because this component is the collector, it records the actual collection time after the API payloads have been obtained. Its evidence source is `github-cli-api` and `authenticated: true` means only that `gh auth status` succeeded before the GET requests. That remains trust metadata rather than cryptographic proof. The collected document is still validated by the same offline GitHub Actions adapter and CI Evidence Contract before it is returned.

## Repository status

`bun run audit:repository-status /path/to/repository` combines the existing profiled quality, offline Git-governance, optional production-baseline, optional deployment-verification, and optional CI-verification audits into one read-only scorecard. It composes their canonical results rather than reimplementing their rules or inferring production truth.

The scorecard has five dimensions: `QUALITY`, `GOVERNANCE`, `BASELINE`, `DEPLOYMENT`, and `CI`. `QUALITY` passes only when the detected webapp or Python-service profile passes its required core checks. `GOVERNANCE` preserves the Git governance audit result. `BASELINE` runs only when `--expected-ref <git-ref>` and/or `--expected-commit <commit>` is explicitly supplied. `DEPLOYMENT` runs only when a baseline is explicit and exactly one deployment evidence input is supplied. `CI` runs only when an explicit CI evidence file, an explicit expected commit, and at least one explicit required check are all supplied. The CI expected commit is never inferred from the baseline, deployment, `HEAD`, or a branch.

Without an explicit baseline selector, JSON reports `baselineConfigured: false` and the scorecard shows `BASELINE NOT_CONFIGURED`. Without deployment evidence, JSON reports `deploymentConfigured: false` and the scorecard shows `DEPLOYMENT NOT_CONFIGURED`. Without CI verification input, JSON reports `ciConfigured: false` and the scorecard shows `CI NOT_CONFIGURED`. An unconfigured readiness dimension is a warning rather than a technical defect, so a fully passing repository status requires explicit matching baseline and deployment evidence plus passing CI evidence for the explicitly selected CI commit and checks.

Use a direct deployed object ID:

```sh
bun run audit:repository-status /path/to/repository \
  --expected-ref origin/production/example \
  --deployed-commit 0123456789abcdef0123456789abcdef01234567
```

Or use a Runtime Evidence Contract v1 file:

```sh
bun run audit:repository-status /path/to/repository \
  --expected-ref origin/production/example \
  --evidence-file ./runtime-evidence.json \
  --max-evidence-age-seconds 3600 \
  --evaluated-at 2026-09-16T12:00:00Z \
  --expected-runtime-name runtime-a \
  --expected-runtime-environment production
```
`--deployed-commit` and `--evidence-file` are mutually exclusive. Deployment evidence without an explicit baseline is rejected. Direct commits use the canonical full-object-ID validator; evidence files use the canonical Runtime Evidence Contract validator and deployment comparison adapter. Missing, unreadable, malformed, or schema-invalid evidence files are CLI input failures with exit 1 and never fall back to another commit source.

Configure CI independently and explicitly when repository readiness should include actual CI results:

```sh
bun run audit:repository-status /path/to/repository \
  --expected-ref origin/production/example \
  --deployed-commit 0123456789abcdef0123456789abcdef01234567 \
  --ci-evidence-file ./ci-evidence.json \
  --ci-expected-commit 0123456789abcdef0123456789abcdef01234567 \
  --require-ci-check typecheck \
  --require-ci-check test \
  --require-ci-check lint \
  --require-ci-check build
```

CI configuration is all-or-nothing: `--ci-evidence-file`, `--ci-expected-commit`, and at least one `--require-ci-check` must be supplied together. Required check names are trimmed, unique, exact, and case-sensitive. A matching CI commit with all required checks `PASS` makes the CI dimension `PASS`; commit mismatch or required `SKIPPED`/missing checks make it `WARN`; an explicit required `FAIL` makes the CI dimension and repository overall status `FAIL` without being classified as a technical inspection failure.

The deployment dimension retains canonical trust metadata in JSON, including `deployedCommit`, `deploymentStatus`, `technicalStatus`, `evidence.type`, `source`, `authenticated`, and, for runtime evidence, `collectedAt` plus runtime name and optional environment. It also preserves the canonical `freshness` and `runtimeIdentity` reports. Freshness and runtime identity policies are accepted only with `evidenceFile`. Stale, future, or identity-mismatched evidence renders the deployment dimension as `WARN` while preserving `deploymentStatus: "MATCH"`. `authenticated: true` remains metadata and does not alter deployment status.

The top-level JSON keeps `root`, `profile`, `baselineConfigured`, `deploymentConfigured`, `dimensions`, `technicalStatus`, `overallStatus`, and `summary`, and adds `ciConfigured`, `dimensions.ci`, and `summary.ci`. The CI dimension retains the canonical commit status, required-check status, required check results, provider metadata, and trust metadata from CI verification.

`WARN` is not a technical failure. Governance warnings, an unconfigured baseline, deployment, or CI dimension, baseline `MISMATCH` or `UNVERIFIED`, deployment `MISMATCH` or `UNVERIFIED`, configured freshness states `STALE` or `FUTURE`, configured runtime identity `MISMATCH`, CI commit mismatch, and required CI `SKIPPED`/missing states exit 0. Quality failure, an explicit required CI `FAIL`, or a technical audit failure produces overall `FAIL` and exit 1. Runtime evidence never selects the production baseline, and CI evidence never selects the expected CI commit.

The repository-status layer adds no network access, runtime probing, target-repository writes, Git mutation, or production inference. Runtime evidence is read only through the deployment-verification adapter and CI evidence is read only through the CI-verification adapter.

## Ecosystem status

`bun run audit:ecosystem-status` aggregates the canonical repository-status report for several repositories. It does not add QUALITY, GOVERNANCE, BASELINE, DEPLOYMENT, or CI rules, choose a branch, or infer a production baseline from `main`, remote `HEAD`, or governance production candidates.

Config mode can supply deployment and CI evidence independently for each repository. CI configuration uses the same explicit contract as repository status: a CI evidence file, an expected full Git object ID, and at least one required check. Ecosystem status never infers the CI expected commit from a baseline, deployment, `HEAD`, branch, or another repository.

Config mode can supply deployment evidence independently for each repository. A repository may use either `deployedCommit` with a full Git object ID or `evidenceFile` with a Runtime Evidence Contract v1 document. Deployment evidence requires an explicit `expectedRef` and/or `expectedCommit`; the two deployment inputs are mutually exclusive. Repositories without deployment evidence continue to report `DEPLOYMENT NOT_CONFIGURED` and contribute a readiness warning when their other dimensions pass.

Use positional repository paths when no repository has a configured production baseline. Every positional repository therefore reports both `BASELINE NOT_CONFIGURED` and `DEPLOYMENT NOT_CONFIGURED` and contributes an overall warning when its other dimensions pass:

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
      "compareRef": "HEAD",
      "deployedCommit": "0123456789abcdef0123456789abcdef01234567"
    },
    {
      "name": "worker-b",
      "path": "/path/to/worker-b",
      "expectedRef": "origin/production",
      "evidenceFile": "./evidence/worker-b.json",
      "maxEvidenceAgeSeconds": 3600,
      "evaluatedAt": "2026-09-16T12:00:00Z",
      "expectedRuntimeName": "worker-b-runtime",
      "expectedRuntimeEnvironment": "production",
      "ciEvidenceFile": "./evidence/worker-b-ci.json",
      "ciExpectedCommit": "0123456789abcdef0123456789abcdef01234567",
      "requiredCiChecks": ["typecheck", "test", "lint", "build"]
    },
    {
      "path": "/path/to/app-c"
    }
  ]
}
```

`name` is display metadata only. A repository with no `expectedRef` or `expectedCommit` remains `BASELINE NOT_CONFIGURED`; `compareRef` requires one of those selectors. `deployedCommit` and `evidenceFile` require a baseline and cannot be supplied together. Direct deployment commits reuse the canonical full-object-ID validator. Runtime evidence files are resolved relative to the ecosystem config file and are validated through repository status and the canonical Runtime Evidence Contract adapter. `maxEvidenceAgeSeconds` and `evaluatedAt` are an optional pair, valid only with `evidenceFile`, and reuse the canonical freshness policy validator. `expectedRuntimeName` optionally binds the evidence to a specific runtime; `expectedRuntimeEnvironment` is optional but requires the name, and both reuse the canonical runtime identity policy validator.

`ciEvidenceFile`, `ciExpectedCommit`, and non-empty `requiredCiChecks` are an all-or-nothing CI configuration. CI evidence paths are also resolved relative to the ecosystem config file. The expected commit and required check names are normalized by the canonical CI verification policy; required check names must be non-empty and unique after trimming. CI verification failures remain isolated to the affected repository so later repositories are still inspected. Duplicate resolved repository target paths are rejected, preventing duplicate counts.

```sh
bun run audit:ecosystem-status --config /private/path/ecosystem-status.json
bun run audit:ecosystem-status --config /private/path/ecosystem-status.json --json
```

The stable JSON report contains `inputMode`, optional `configVersion`, ordered `repositories`, machine-readable `summary`, `technicalStatus`, and `overallStatus`; it never prints config-file contents or the config path. The summary counts both deployment and CI `pass`, `warn`, `fail`, and `notConfigured` states alongside the existing dimensions. The human scorecard includes `DEPLOYMENT` and `CI` columns. Deployment policy state is visible in labels such as `MATCH/FRESH/IDENTITY_MATCH`; CI state is visible as `MATCH/PASS`, `MISMATCH/PASS`, `MATCH/UNVERIFIED`, or `FAIL/MATCH/FAIL`. Overall status is `FAIL` when any repository fails, otherwise `WARN` when any repository warns, otherwise `PASS`. Technical status fails only when at least one repository has a technical inspection failure. A required CI `FAIL` can therefore make ecosystem overall `FAIL` while technical status remains `PASS`. `FAIL` exits 1; `PASS` and `WARN` exit 0. A failed or missing target, unreadable evidence file, malformed evidence document, or schema-invalid runtime or CI evidence is isolated to that repository so the remaining repositories are still inspected.

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

## v1.1 capability surface

Production Webapp Toolkit v1.1 supports repository profiles and profiled auditing for TypeScript webapps and Python services, plus explicit Git governance, production baselines, runtime evidence, deployment verification, repository status, and ecosystem status.

It provides dependency drift auditing across repositories, including version differences and reproducibility gaps.

It provides public repository safety checks for tracked sensitive files and secret-like content. The toolkit runs this check as a blocking CI gate and does not print detected secret values.

It provides architecture compliance through external versioned policy files. Organization-specific policy remains outside this public toolkit.

The toolkit also provides safe repository bootstrap, remediation planning and execution, dependency and architecture auditing, and self-contained v1.1 release-readiness validation. Runtime Evidence may be checked for freshness and explicit runtime identity without inferring production truth or authentication.

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
- bun run audit:release . --expected-version 1.1.0
- bun run release:verify
