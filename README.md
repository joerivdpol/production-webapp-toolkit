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

### GitHub branch protection and ruleset audit

`bun run audit:github-protection` is an optional read-only online audit for explicit GitHub branch-protection policy. It requires an already authenticated GitHub CLI session plus an explicit repository, branch, and versioned policy file:

```sh
bun run audit:github-protection \
  --repository owner/repository \
  --branch main \
  --policy ./github-protection-policy.json
```

Policy version 1 only checks requirements that are explicitly enabled. Supported requirements include named required status checks, strict status checking, pull-request enforcement, minimum approvals, stale-review dismissal, code-owner review, latest-push approval, conversation resolution, linear history, administrator enforcement, blocked force pushes, and blocked branch deletion. The public toolkit contains the policy engine; project- or organization-specific policies can remain private.

The audit reads three explicit GitHub views through authenticated `gh api --method GET`: branch metadata, classic branch protection, and the effective active rules returned for the selected branch. Classic branch protection and rulesets are additive GitHub mechanisms, so the audit combines their known restrictions instead of choosing one as canonical. When overlapping known protections exist, the effective report preserves the stricter requirement, such as the larger minimum approval count or the union of required status checks.

Source availability is part of the result. A known absent requirement is `FAIL`. When an API source cannot be inspected reliably, a requirement that is not otherwise established is `UNVERIFIED`, producing overall `WARN` rather than falsely declaring the branch unprotected. A requirement already established by another available source remains `PASS`. Administrator enforcement is only asserted from classic protection because a ruleset can contain bypass actors that are not represented by the active-rule response used here.

The audit never changes repository settings, rulesets, branches, reviews, or checks. It performs no POST, PUT, PATCH, DELETE, Git mutation, or token output. Policy failure exits 1, technical provider/input failure exits 1, and fully verified PASS exits 0; `UNVERIFIED` policy results remain WARN and exit 0.

### Environment Contract audit

`bun run audit:env-contract` compares explicit environment configuration policy with statically discoverable code usage and safe example templates. It never reads `.env` runtime files, process environment values, secrets managers, network resources, or Git metadata.

A version 1 contract is explicit about which source roots are scanned, which example/sample/template files document keys, and which variables are required, public, or server only:

```json
{
  "version": 1,
  "scanRoots": ["src", "server"],
  "exampleFiles": [".env.example"],
  "variables": [
    { "name": "PUBLIC_API_URL", "required": true, "exposure": "public", "documented": true },
    { "name": "PAYMENT_SECRET_KEY", "required": true, "exposure": "server", "documented": true }
  ]
}
```

Run it with an explicit contract file:

```sh
bun run audit:env-contract /path/to/repository \
  --contract /path/to/environment-contract.json
```

Supported static accessors include Node `process.env`, Bun `Bun.env`, Deno `Deno.env.get`, Vite style `import.meta.env`, and SvelteKit `$env/static/*` plus `$env/dynamic/*` named imports. Known browser public conventions such as `NEXT_PUBLIC_`, `REACT_APP_`, `PUBLIC_`, Vite `import.meta.env`, and SvelteKit public imports are treated as public access. Vite built ins such as `MODE`, `DEV`, `PROD`, `SSR`, and `BASE_URL` are ignored because they are platform metadata rather than application environment variables.

Required contract variables that are not referenced fail the audit. Undeclared environment references, undeclared example keys, missing documented keys, and server variables used through a public accessor also fail. Dynamic computed access such as `process.env[key]` cannot be mapped safely and therefore produces `WARN`, not invented variable truth. Large source files above the bounded scan limit also produce a warning. Symlinks are not followed.

Example files are accepted only when their path clearly identifies them as `example`, `sample`, or `template` material. Only key names to the left of `=` are retained; values are never included in reports. Missing declared scan roots or example files are contract failures rather than technical crashes. Runtime `process.env` is never consulted, so values present in the auditor process cannot affect or leak into the result.

The audit is local and read only. It performs no repository writes, Git commands, network requests, shell commands, secret manager access, or environment reads. `PASS` and `WARN` exit 0; contract violations, invalid contract input, or technical inspection failures exit 1.

### Client environment exposure audit

`bun run audit:env-exposure` builds on the canonical Environment Contract scanner to detect client-visible server configuration and unsafe public environment naming without reading any environment values. It requires the same explicit Environment Contract v1 file and may optionally accept narrowly scoped public-name exceptions:

```sh
bun run audit:env-exposure /path/to/repository \
  --contract /path/to/environment-contract.json

bun run audit:env-exposure /path/to/repository \
  --contract /path/to/environment-contract.json \
  --allow-public-name VITE_PUBLIC_TOKEN
```

A contract variable declared `server` fails when source code reaches it through a public accessor. Public names are also checked for strong secret-like components such as `SECRET`, `PASSWORD`, `TOKEN`, `CREDENTIAL`, `PRIVATE`, `API_KEY`, `ACCESS_KEY`, `ADMIN_KEY`, `MASTER_KEY`, `ROOT_KEY`, `SERVICE_ROLE_KEY`, and `SIGNING_KEY`. The check is deliberately component-based rather than substring-based so names such as `VITE_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`, `VITE_TOKENIZER_VERSION`, `VITE_SECRETARY_NOTE`, and `VITE_PASSWORDLESS_MODE` do not become false positives.

An explicit `--allow-public-name` suppresses only the secret-like naming heuristic for a variable already declared `public` in the contract. It cannot make an undeclared or `server` variable public and duplicate or unknown exceptions are rejected. Public contract names without a recognized framework prefix such as `VITE_`, `NEXT_PUBLIC_`, `REACT_APP_`, `PUBLIC_`, `EXPO_PUBLIC_`, `GATSBY_`, or `NUXT_PUBLIC_` are a readiness warning rather than an automatic exposure failure.

Undeclared public references are warnings when their names are otherwise non-secret-like and failures when they are secret-like. Dynamic computed access remains `WARN` because the auditor does not invent a variable identity. The audit reuses the exact Environment Contract source scanner, so accessor classification, symlink handling, scan bounds, and path safety have one canonical implementation.

The audit is local and read only. It never reads runtime `.env` files, process environment values, example values, network resources, Git metadata, or secret stores and never writes to the inspected repository. `PASS` and `WARN` exit 0; detected unsafe exposure, invalid inputs, or technical inspection failure exits 1.

### Public repository safety gate

`bun run audit:safety .` is the blocking high-confidence safety gate for content already tracked by Git. Findings contain only a rule identifier and file path; matched credentials, usernames, private-key bodies, and secret values are never printed.

The gate blocks tracked runtime dotenv files, private-key and credential-file locations, private-key material, credentialed public URLs, provider-specific credentials, and strong generic hardcoded secret assignments. Provider signatures cover common GitHub, AWS, Google, Stripe, OpenAI, Xendit, SendGrid, npm, GitLab, Slack, and Telegram credential formats. Generic assignments are considered only when the assignment name has a strong secret component and the value looks non-placeholder; obvious example, fixture, dummy, redacted, and replace-me values are excluded to keep tests and documentation usable.

Package-registry authentication and Docker registry auth values are detected without reporting their contents. Tracked credential locations such as netrc, Python package credentials, AWS credentials, application-default cloud credentials, and service-account JSON files are rejected. Additional private-key file formats such as ECDSA, DSA, JKS, and keystores are included.

Tracked frontend artifacts and source maps receive a larger but still bounded text scan so credentials embedded in generated JavaScript are not skipped merely because a bundle exceeds the normal source limit. A strong secret assignment found there is reported separately as `frontend-bundle-secret-assignment`. Binary content and files beyond the relevant bound are not decoded.

GitHub Actions workflows receive a separate leakage check. Normal secret injection into a command environment is allowed, while direct secret output, output of an environment variable mapped from a secret, dumping the environment when secret mappings exist, serializing the complete secrets object, or enabling shell tracing around secret expressions is blocked. Explicit GitHub masking commands remain allowed.

The scanner does not follow tracked symlinks, so a repository cannot cause this audit to read a linked file outside the repository. Credentialed URLs to reserved test hosts such as localhost and reserved test domains remain valid fixtures. This gate complements Environment Contract and client-exposure auditing: those reason about declared public/server policy, while public safety looks for tracked credential material and high-confidence leakage patterns.

### Database migration safety audit

`bun run audit:migration-safety` performs a local read-only static safety review of explicit SQL migration roots. It does not connect to a database, execute migrations, call Git, infer which files were applied, or modify repository content.

```sh
bun run audit:migration-safety /path/to/repository \
  --root supabase/migrations

bun run audit:migration-safety /path/to/repository \
  --root supabase/migrations \
  --manifest /private/path/applied-migrations.json
```

The SQL scanner is comment-, string-, quoted-identifier-, and dollar-body-aware so dangerous words in documentation, literals, or stored function bodies do not become migration-time findings. Static risk findings are primarily `WARN`: destructive DROP DDL, TRUNCATE, unbounded DELETE, enum value additions, non-concurrent index creation, column type changes, NOT NULL validation, validated foreign keys, NOT NULL columns without defaults, volatile defaults, explicit table locks, VACUUM FULL, and REINDEX. These warnings identify operational risk without pretending that every intentional migration is forbidden.

A few conditions are blocking `FAIL` because they are structurally unsafe rather than merely risky: duplicate migration IDs, symbolic-link migration files, binary SQL, unbalanced explicit transaction boundaries, and PostgreSQL `CREATE INDEX CONCURRENTLY` inside an explicit transaction. Common timestamp and Flyway-style migration IDs are recognized; unrecognized IDs, implausible timestamp IDs, inconsistent numeric-ID widths, and duplicate basenames across roots are visible ordering/readiness warnings.

Applied-history integrity is optional but explicit. A version 1 manifest lists repository-relative migration paths plus SHA256 hashes:

```json
{
  "version": 1,
  "migrations": [
    {
      "path": "supabase/migrations/20260916120000_create_users.sql",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ]
}
```

The toolkit never assumes that every migration file is applied. Manifest entries are caller-supplied applied-history evidence. A manifested migration that disappears or changes hash is blocking `FAIL`; current migrations not present in the manifest are reported as `NEW` and are not treated as history corruption. Without a manifest the history dimension is `NOT_CONFIGURED` and the audit remains `WARN`, because modified applied history cannot be verified.

Migration SQL contents are never emitted in JSON or human reports; only file paths, hashes, IDs, classification metadata, and generic risk details are returned. SQL above the bounded static scan size is still hashed but reports `WARN` because its contents were not risk-scanned. `PASS` and `WARN` exit 0; blocking migration findings, invalid inputs, or technical inspection failures exit 1.

### Database schema snapshot and drift audit

`bun run schema:snapshot` validates Database Schema Snapshot v1, a provider-neutral structural PostgreSQL schema document. `bun run audit:schema-drift` compares an explicit expected snapshot with an explicit observed snapshot and optionally verifies that the expected snapshot is bound to the exact applied-migration manifest used by `audit:migration-safety`.

A snapshot records its kind (`expected` or `observed`), database identity, collector trust metadata, and canonical schemas. Structural coverage currently includes tables, columns, constraints, indexes, enums, views, and sequences. Named objects are sorted deterministically; enum value ordering is preserved because it can be semantically relevant. SQL-like definitions are whitespace-normalized only and are not parsed or rewritten by the snapshot contract.

Expected snapshots require `migrationManifestSha256`. The digest is computed from the normalized version 1 applied-history manifest in order, so the expected schema is explicitly bound to a particular migration truth claim. The toolkit never derives an expected schema by pretending to execute arbitrary migration SQL.

```sh
bun run schema:snapshot --file ./expected-schema.json
bun run schema:snapshot --file ./observed-schema.json

bun run audit:schema-drift \
  --expected-file ./expected-schema.json \
  --observed-file ./observed-schema.json \
  --migration-manifest ./applied-migrations.json \
  --migration-root supabase/migrations
```

The drift report keeps three independent results: database `IDENTITY`, `MIGRATION_BINDING`, and `SCHEMA_DRIFT`. A matching schema without an explicit manifest remains `WARN` because the expected snapshot cannot be proven current against migration truth. A manifest digest mismatch, observed migration digest mismatch, database identity mismatch, or structural schema mismatch is blocking `FAIL`. Snapshot `authenticated` metadata is reported but does not change truth semantics.

Schema drift is object-level. Missing and extra objects are reported by canonical path; changed objects report only the names of changed fields. Raw defaults, constraints, index definitions, view definitions, sequence definitions, or SQL fragments are never copied into drift output, avoiding accidental disclosure of literals or implementation details.

The drift comparator remains collector-independent and read only: it reads only explicit JSON snapshots and an optional migration manifest. It performs no database, network, Git, shell, environment, migration execution, or repository-write operation. A matching structure with unverified migration binding exits 0 as `WARN`; structural or binding mismatch exits 1.

A separate read-only PostgreSQL collector can create an observed snapshot through an explicit libpq service:

```sh
bun run schema:snapshot:postgres:collect \
  --service production-audit \
  --identity-name primary-database \
  --environment production \
  --schema public \
  --json > observed-schema.json
```

The collector requires an explicit service name, database identity, and at least one explicit PostgreSQL schema. It never accepts a password, host, username, connection URL, or arbitrary SQL argument. Authentication and connection details remain in the existing libpq service/psql context. Collection runs one generated catalog query beginning with `BEGIN READ ONLY`, uses only PostgreSQL catalog reads, and emits Database Schema Snapshot v1 after canonical validation. Provider stderr and connection errors are reduced to generic failure messages. The collector itself writes no files; shell redirection in the example is the caller-controlled output step.

Observed collection covers tables, columns, constraints, indexes, enums, views, materialized views, and sequences. It does not automatically discover all schemas and it does not claim migration truth. Migration binding remains a separate explicit manifest comparison. The catalog query and adapter are regression-tested offline and have also been validated against a temporary PostgreSQL 17 instance with synthetic schema objects.

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

### PostgreSQL security policy audit

`bun run security:snapshot` validates PostgreSQL Security Snapshot v1. `bun run security:snapshot:postgres:collect` collects read-only catalog evidence through an explicit libpq service. `bun run audit:postgres-security` evaluates that evidence against an explicit version 1 project policy.

Role names receive no built-in meaning. Projects explicitly declare the roles and privileges they want to prohibit. Security evidence includes schema, table, sequence, and function grants; RLS and FORCE RLS state; policy command, roles and permissive mode; boolean always-true signals; and security-definer search-path and execute metadata.

Raw RLS predicates and function bodies are intentionally excluded from the evidence contract. The policy is bound to an explicit database identity and optional environment. Table selectors can require RLS, FORCE RLS, reject selected grants, or reject permissive always-true policies for selected roles. Separate rules cover schema and sequence grants plus security-definer search paths and execute grants.

The collector accepts only an explicit libpq service and explicit schemas. It runs a generated `BEGIN READ ONLY` catalog query and returns canonical evidence. Provider failures are reduced to generic collection errors. Collection trust metadata never overrides policy results. The query and adapter are tested offline and against temporary PostgreSQL 17 with synthetic security objects.

```sh
bun run security:snapshot:postgres:collect --service production-audit --identity-name primary-database --environment production --schema public --json > postgres-security.json
bun run audit:postgres-security --snapshot-file ./postgres-security.json --policy /private/path/postgres-security-policy.json
```

### API Contract Snapshot and compatibility audit

`bun run api:contract` validates API Contract Snapshot v1. `bun run audit:api-contract` compares an explicit baseline snapshot with an explicit candidate snapshot. The core engine is provider neutral and does not infer contracts from application code or network traffic.

Snapshot v1 covers HTTP method and path, path/query/header parameters, optional request bodies, response status plus media type, and a deliberately bounded JSON schema subset: primitive types, nullability, scalar enums, objects with explicit `additionalProperties`, required properties, and arrays. Unsupported fields and malformed path parameter bindings are rejected rather than guessed.

Compatibility is directional. A candidate request contract must continue accepting every input accepted by the baseline. Making parameters or bodies required, narrowing nullability or enums, changing request media type, or otherwise narrowing request schemas is blocking `FAIL`. Candidate responses must remain within what baseline clients were told to accept; widening response enums/nullability, removing required response fields, opening a closed object, changing existing types, or removing a baseline response contract is blocking `FAIL`.

Adding an operation is compatible. Adding another response status/media contract is reported as `WARN` because existing clients may not have modeled that outcome even though no baseline response was removed. Evidence authentication metadata remains trust metadata and never changes compatibility truth. The comparator reads only explicit JSON files and performs no network, Git, environment, command, or repository write operation.

`bun run api:contract:openapi` converts an explicit OpenAPI 3.0, 3.1, or 3.2 JSON document into the same canonical snapshot. The adapter deliberately supports only the schema subset represented by API Contract Snapshot v1. Local component schema references are resolved with bounded recursion; external references, polymorphic schema keywords, schema-valued `additionalProperties`, request bodies with multiple media types, response ranges, callbacks, and security requirements fail closed instead of being silently discarded. Evidence source, collection time, service identity, snapshot kind, and authentication state are caller supplied; the adapter never generates trust metadata. A bodyless OpenAPI response is represented with media type `none` and a null schema so status-only response contracts remain visible.

```sh
bun run api:contract --file ./baseline-api.json
bun run api:contract --file ./candidate-api.json
bun run api:contract:openapi --file ./openapi.json --kind candidate --service example-api --source local-openapi --collected-at 2026-09-16T13:45:00Z --json
bun run audit:api-contract --baseline-file ./baseline-api.json --candidate-file ./candidate-api.json
```

### Cross-repository contract version audit

`bun run contract:inventory` validates Contract Inventory v1 for one repository. An inventory contains only a portable repository identifier plus explicit contract ids and version tokens. It does not contain business rules or infer contracts from code. `bun run audit:cross-contracts` evaluates multiple inventories against an explicit Cross Repository Contract Policy v1.

A policy requirement names at least two repositories and a contract id. It may specify `expectedVersion`; when it does, every named repository must explicitly declare that exact version. When `expectedVersion` is omitted, the toolkit performs consensus-only drift detection and requires the named repositories to agree. It never chooses a canonical repository or decides which differing version is correct. Missing inventories, missing required contract declarations, explicit version mismatches, and consensus drift are blocking `FAIL`. Unreferenced repositories and contracts do not affect policy truth.

```json
{
  "version": 1,
  "requirements": [
    {
      "contractId": "room-types",
      "repositories": ["pulse", "hills", "travel"],
      "expectedVersion": "v12"
    },
    {
      "contractId": "payment/account-routing",
      "repositories": ["hills", "travel"]
    }
  ]
}
```

```sh
bun run contract:inventory --file ./hills-contracts.json
bun run audit:cross-contracts \
  --policy /private/path/cross-contract-policy.json \
  --inventory-file ./pulse-contracts.json \
  --inventory-file ./hills-contracts.json \
  --inventory-file ./travel-contracts.json
```

Both commands are offline and read only. Policy and inventory files are explicit caller inputs; the public toolkit contains no Happinezz-specific contract ids, versions, canonical ownership, or private organization rules.

### Dependency and runtime drift audit

`bun run audit:drift` compares explicit dependency and toolchain declarations across repositories. It reports exact version-string drift separately from major-version conflicts, and it now covers common frontend frameworks, client libraries, and tooling in addition to React, TanStack, Supabase, TypeScript, ESLint, and Playwright.

Runtime evidence remains explicit. Node repositories may contribute `.node-version`, `packageManager`, and `engines.node`; Python repositories may contribute `.python-version`. The audit does not inspect installed runtimes or normalize version ranges into invented compatibility claims. Python-only repositories are not penalized for missing Node metadata.

An optional version 1 runtime policy can constrain supported Node majors and package-manager majors or require an exact `.node-version`, pinned `packageManager`, and `engines.node`. Unsupported explicit policy evidence is blocking `FAIL`; missing evidence needed only to evaluate support remains `WARN` unless the policy explicitly requires that evidence.

```sh
bun run audit:drift /path/to/app-one /path/to/app-two --json
bun run audit:drift /path/to/app-one /path/to/app-two --policy /private/path/runtime-policy.json
```

The human report includes an ecosystem matrix for high-value framework, runtime, client-library, and test-tool versions. The audit is local and read only: it reads repository metadata files only and performs no install, package-manager, network, Git mutation, or runtime probe.

### Vulnerability evidence and policy audit

`bun run vulnerability:evidence` validates provider-neutral Vulnerability Evidence Contract v1 documents and explicit package query manifests. Evidence binds an exact package version to `direct`, `transitive`, or `unknown` dependency relationship and stores only bounded advisory identity, aliases, normalized severity, provider modification time, and known fixed versions. Advisory prose and raw provider payloads are intentionally excluded.

Two collectors currently emit the same canonical evidence contract:

* `bun run vulnerability:osv:collect` sends exact package/version queries to OSV's fixed batch endpoint. OSV is treated as unauthenticated public evidence.
* `bun run vulnerability:github:collect` uses authenticated read-only `gh api --method GET` requests for open Dependabot alerts. Because Dependabot alerts do not establish the exact installed package version, collection requires the same explicit package/version manifest and fails closed when an open alert cannot be bound unambiguously.

The audit is policy driven. `bun run audit:vulnerabilities` requires explicit blocking severities and dependency relationships, plus an explicit evaluation time. Optional evidence freshness limits and bounded vulnerability exceptions can be configured. Exceptions remain visible as warnings and can expire automatically.

A known advisory never proves exploitability in the application. Reports therefore keep exploitability `UNKNOWN` unless a future separate evidence contract establishes runtime context. Likewise, absence of a patched version in provider evidence is reported as fix status `UNKNOWN`, not as a claim that no fix exists.
```json
{
  "version": 1,
  "evaluatedAt": "2026-09-16T14:35:00Z",
  "maxEvidenceAgeSeconds": 86400,
  "blockingSeverities": ["HIGH", "CRITICAL"],
  "blockingRelationships": ["direct", "transitive"],
  "exceptions": []
}
```

```sh
bun run vulnerability:evidence --manifest-file ./vulnerability-packages.json --json
bun run vulnerability:osv:collect --manifest-file ./vulnerability-packages.json --json > osv-evidence.json
bun run vulnerability:github:collect --repository owner/repo --manifest-file ./vulnerability-packages.json --json > github-evidence.json
bun run audit:vulnerabilities --evidence-file ./osv-evidence.json --policy /private/path/vulnerability-policy.json
```

The canonical evidence validator and audit core are offline and read only. The OSV collector has one fixed HTTPS POST surface; the GitHub collector is limited to authenticated GET requests. Neither collector changes repositories, alerts, dependencies, or provider state.
### CycloneDX release SBOM generation

`bun run sbom:generate` emits a CycloneDX 1.7 JSON SBOM for an explicit release artifact. The generator reads only `package.json`, `.node-version`, and Bun text lockfile v1 from the target repository. It requires the caller to supply the full source commit, artifact SHA256, and absolute collection timestamp rather than inferring release identity from Git or the clock.

The SBOM records:

* application name and version;
* release artifact SHA256;
* full source commit;
* Bun lockfile SHA256;
* exact Node and Bun reference toolchain;
* every resolved package name and version in `bun.lock`;
* SRI package integrity converted to CycloneDX hexadecimal hashes when available;
* explicit direct production, direct development, direct optional, or transitive relationship metadata.

The root dependency graph contains only direct edges proven by the root workspace declaration. The generator does not infer transitive parent edges from version ranges. The SBOM marks this limitation with `toolkit:dependencyGraph=root-direct-only`; consumers must not interpret missing transitive parent edges as proof that a component has no dependencies.

```sh
bun run sbom:generate \
  --root /path/to/repository \
  --source-commit 0123456789abcdef0123456789abcdef01234567 \
  --artifact-sha256 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa \
  --created-at 2026-09-16T15:30:00Z \
  --json > release.cdx.json
```

The generator fails closed on unsupported lockfile structure, ambiguous direct dependency resolution, symlinked evidence files, floating Bun or Node toolchains, malformed release identity, and malformed package identities. Missing package integrity remains explicit as `toolkit:packageIntegrity=unavailable`; no hash is synthesized. The generator performs no Git, network, environment, subprocess, installation, or repository-write operation.

### Dependency license evidence and policy audit

`bun run license:collect:installed` collects package license declarations from an installed dependency tree and binds them to the exact package identities in a CycloneDX 1.7 release SBOM. The collector never substitutes a different installed package version when the SBOM target is missing. Missing exact packages or unsupported license declarations remain `UNKNOWN` evidence.

Collection is local and read only. `node_modules` must be a real directory rather than a symlink. Package-directory symlinks are not followed, nested `node_modules` trees are scanned within explicit safety bounds, and conflicting license declarations for the same exact `name@version` fail closed. The canonical License Evidence Contract v1 carries the artifact name, version, SHA256, source commit, evidence timestamp, dependency relationship, exact package version, and declared license expression.

`bun run audit:licenses` compares that evidence with an explicit version 1 engineering policy. Policy can include selected dependency relationships, exact allowed expressions, exact denied expressions, and WARN or FAIL behavior for unknown and unlisted expressions. Expressions are matched exactly after whitespace normalization. The toolkit does not decide that two different SPDX expressions are legally equivalent, resolve dual licensing choices, or provide a legal conclusion about license obligations.

```json
{
  "version": 1,
  "includedRelationships": ["direct-production", "transitive"],
  "allowedExpressions": ["MIT", "Apache-2.0", "BSD-3-Clause"],
  "deniedExpressions": ["GPL-3.0-only"],
  "unknownStatus": "FAIL",
  "unlistedStatus": "WARN"
}
```

```sh
bun run license:collect:installed \
  --root /path/to/repository \
  --sbom-file ./release.cdx.json \
  --collected-at 2026-09-16T15:45:00Z \
  --json > license-evidence.json

bun run license:evidence --file ./license-evidence.json
bun run audit:licenses --evidence-file ./license-evidence.json --policy /private/path/license-policy.json
```

The evidence validator and audit core perform no network, Git, environment, subprocess, installation, repository write, or provider mutation operation. Source authentication metadata is retained as trust metadata and does not change the exact-expression policy result.

### Build reproducibility audit

`bun run audit:reproducibility` performs a local read only audit against an explicit Build Reproducibility Policy v1. The policy binds the repository to an exact package manager, an exact Node runtime file, a regular lockfile, one or more required frozen install commands in explicit CI files, and optional SHA256 bindings for generated build inputs.

The audit distinguishes configuration evidence from stronger artifact reproducibility claims. It never executes package installation, generators, build commands, Git, network requests, or environment inspection. A generated input is checked only when its repository relative path and expected SHA256 are explicitly declared. An empty `generatedInputs` array means the policy declares no generated inputs for this repository; the toolkit does not discover or invent them.

```json
{
  "version": 1,
  "packageManager": { "name": "bun", "expectedVersion": "1.3.14" },
  "runtime": {
    "nodeVersionFile": ".node-version",
    "expectedVersion": "24.21.0",
    "requireEngineMajorMatch": true
  },
  "lockfile": {
    "path": "bun.lock",
    "expectedSha256": "<64-character SHA256>"
  },
  "frozenInstall": {
    "files": [".github/workflows/ci.yml"],
    "requiredCommands": ["bun install --frozen-lockfile"]
  },
  "generatedInputs": [
    { "path": "src/generated/schema.json", "sha256": "<64-character SHA256>" }
  ]
}
```

Lockfiles and generated inputs must be regular non symlink files and are read within bounded sizes. Policy paths reject traversal. A configured lockfile digest or generated input digest mismatch is blocking `FAIL`; exact package manager and runtime pins are always required. `engines.node` can optionally be required to match the pinned Node major. Frozen install evidence is static configuration evidence only: the audit proves that the configured command is present in an explicit CI file, not that a particular CI run executed it.

```sh
bun run audit:reproducibility --root . --policy config/build-reproducibility-policy.json
```

### Artifact provenance contract and audit

`bun run artifact:provenance` validates Artifact Provenance Contract v1. The contract explicitly binds a source commit to one exact CI provider, workflow and run identifier, one built artifact name plus SHA256, the artifact SHA256 claimed for a deployment target, and the intended runtime identity. It also carries evidence source, authentication and collection time as trust metadata.

`bun run audit:artifact-provenance` composes that contract with existing canonical CI Evidence v1 and Runtime Evidence v1 documents. The audit independently verifies source commit equality with CI, exact CI provider/workflow/run identity, built artifact SHA256 equality with the deployed artifact SHA256 claim, runtime deployment commit equality with source, and exact runtime name/environment binding. A mismatch is blocking `FAIL`.

```sh
bun run artifact:provenance --file ./artifact-provenance.json
bun run audit:artifact-provenance \
  --provenance-file ./artifact-provenance.json \
  --ci-evidence-file ./ci-evidence.json \
  --runtime-evidence-file ./runtime-evidence.json
```

The validator and audit core are offline and read only. They do not build artifacts, deploy software, inspect a live runtime, call Git, read environment variables, or generate collection timestamps. `authenticated` fields are reported but never convert a matching claim into proof that a provider really built or deployed those bytes. Authenticity depends on the collector that produced the evidence; this layer only proves that explicit evidence documents form a consistent source → CI build → artifact → deployment → runtime chain.

### Release risk classification

`bun run change:evidence` validates Change Surface Evidence v1. The evidence is explicit input: exact base and head commits, aggregate file and line counts, declared engineering surfaces (`frontend`, `database`, `auth`, `payment`, `deployment`, `api`, `infrastructure`), and boolean flags for test changes, environment changes, and major dependency upgrades. This contract deliberately does not infer changed surfaces from a Git diff; automated changed-surface analysis is a separate roadmap capability.

`bun run audit:release-risk` classifies release risk as `LOW`, `MEDIUM`, or `HIGH` using an explicit version 1 policy. The policy names high- and medium-risk surfaces, large-diff thresholds, levels for environment and major-dependency changes, and the surfaces for which unchanged tests are a risk driver. The classifier returns concrete drivers and takes the highest configured level. It does not compute an opaque numeric score or use AI judgment.

```sh
bun run change:evidence --file ./change-surface-evidence.json
bun run audit:release-risk --evidence-file ./change-surface-evidence.json --policy /private/path/release-risk-policy.json
```

Both commands are offline and read only. Authentication metadata on change evidence is reported by the contract but does not change classification truth. Organization-specific risk policy belongs outside the public toolkit.
