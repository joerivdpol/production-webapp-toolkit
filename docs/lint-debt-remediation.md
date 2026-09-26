# Lint Debt Remediation v1

Lint Debt Remediation v1 lets an established JavaScript/TypeScript repository keep full-repository lint visible while removing historical debt incrementally instead of turning every legacy finding into an immediate release blocker.

It complements changed-files lint rather than replacing it. Changed-files lint protects touched code. Lint Debt Remediation records the existing repository-wide debt as a versioned baseline, blocks debt above that baseline, and can remove old layout-only findings in bounded automatic batches.

## Commands

Run the engine directly from the toolkit checkout:

```sh
node scripts/lint-debt.js scan /path/to/repository
node scripts/lint-debt.js baseline /path/to/repository
node scripts/lint-debt.js check /path/to/repository
node scripts/lint-debt.js plan /path/to/repository
node scripts/lint-debt.js apply /path/to/repository
node scripts/lint-debt-campaign.js /path/to/repo-a /path/to/repo-b
```

The package aliases are:

```sh
bun run lint:debt:scan -- /path/to/repository
bun run lint:debt:baseline -- /path/to/repository
bun run lint:debt:check -- /path/to/repository
bun run lint:debt:plan -- /path/to/repository
bun run lint:debt:apply -- /path/to/repository
bun run lint:debt:campaign -- /path/to/repo-a /path/to/repo-b
```

The target repository must already have its own local ESLint installation and configuration. The toolkit resolves that repository's ESLint package; it does not substitute the toolkit's lint configuration.

## Multi-repository cleanup campaign

`lint:debt:campaign` accepts one or more explicit repository paths and stays read only. For every repository it runs the canonical debt scan and cleanup plan, inspects the default `.toolkit/lint-debt-baseline.json` when present, and reports:

- current error, warning, fixable and total issue counts;
- baseline state as `PASS`, `FAIL`, `MISSING`, or `INCOMPATIBLE`;
- candidate files with safe layout-only fixes;
- the next bounded batch size, planned resolved-problem count, and concrete repository-relative file list;
- a deterministic priority ordered by safe next-batch impact, then total issue count, then repository path.

One repository failing to scan does not hide healthy results from the others; the campaign reports the failure and exits non-zero. Duplicate repository arguments are collapsed. `--json` emits the same campaign as machine-readable evidence.

The campaign never creates or regenerates a baseline and never calls `apply`. Its `mutationAuthorized` field is always `false`. Cleanup remains an explicit per-repository operation so each batch can be reviewed and followed by that application's own typecheck, tests, build and relevant E2E checks.

## Baseline semantics

`baseline` requires a clean Git worktree and writes `.toolkit/lint-debt-baseline.json` by default.

The baseline stores a multiset of active lint findings. A finding identity contains:

- repository-relative file path;
- ESLint rule id;
- ESLint message id when available;
- otherwise a SHA-256 hash of the lint message;
- severity;
- occurrence count.

It does not store source text or raw lint messages.

Line and column are deliberately not part of the identity. Moving an unchanged finding inside the same file therefore does not manufacture new debt. Moving debt to a different file is treated as new debt.

The baseline is also bound to:

- exact installed ESLint version;
- lint fingerprint version;
- the `layout-only` fix boundary;
- SHA-256 of the normalized Lint Debt Policy v1.

Fingerprint v2 normalizes only volatile `at line N` location fragments in ESLint messages that do not expose a stable `messageId`. Other numeric message content remains unchanged. This prevents pure layout fixes from manufacturing new historical debt merely because the same warning moved to a different source line.

`check` fails closed when the ESLint version, fingerprint version, or normalized policy differs. A policy, fingerprint algorithm, or toolchain change therefore requires explicit review and a newly generated baseline rather than silently changing the debt budget.

Upgrading from a baseline created before fingerprint v2 requires one reviewed baseline regeneration. This is a schema-identity migration, not permission to accept newly introduced lint debt: compare the pre-upgrade and post-upgrade issue totals and rule/file distribution before committing the regenerated baseline.

## New-debt ratchet

`check` compares the current multiset against the baseline.

Existing historical debt is allowed to remain. Reduced debt is reported as improvement. Any count above the baseline for a finding identity is new debt and makes the check fail.

This makes it possible to keep full-repository lint advisory while still adding a repository-wide blocking invariant:

> the known backlog may shrink or stay equal, but it may not grow.

Changed-files lint should normally remain blocking as well. The two controls solve different problems.

## Automatic cleanup boundary

`plan` previews only ESLint fixes whose rule type is `layout`.

ESLint defines layout fixes as fixes that do not change program AST structure. Problem, suggestion, and directive fixes are not part of the automatic cleanup surface.

`apply` is an explicit mutation command. It requires a clean Git worktree and applies one bounded batch from the deterministic plan.

Default limits are:

- 10 files per batch;
- 1 MiB total selected file bytes;
- 1 MiB per tracked lint file.

All limits can be reduced or increased within the hard policy bounds.

The engine never runs arbitrary package scripts, migrations, provider operations, deployments, or production tests as part of autofix.

## Apply verification and rollback

Before writing, every selected target must be a tracked regular file inside the exact Git repository root.

After writing, the engine verifies:

1. every written file matches the exact SHA-256 of the ESLint preview output;
2. Git reports changes only in the selected files;
3. `git diff --check` passes;
4. repository-wide lint debt is scanned again;
5. no new lint-debt fingerprint was introduced;
6. the total active lint issue count decreased.

If any postcondition fails, the original bytes of all files in the batch are restored before the command exits with failure.

The engine leaves a successful batch as ordinary uncommitted Git changes for review. It does not commit, push, merge, publish, or deploy.

## Generated and excluded files

Common generated/build paths are excluded by default, including generated directories and filenames containing `.gen.` or `.generated.`.

Project-specific exclusions belong in `.toolkit/lint-debt-policy.json`.

Example:

```json
{
  "version": 1,
  "excludeFiles": [],
  "excludePrefixes": [
    "src/integrations/supabase"
  ],
  "includeGenerated": false,
  "maxBatchFiles": 10,
  "maxBatchBytes": 1048576,
  "maxFileBytes": 1048576
}
```

An exclusion is not an assertion that the excluded code is safe or clean. It only declares that this engine is not allowed to use that path for historical-debt accounting or automatic layout cleanup.

Policy changes invalidate the existing baseline.

## Recommended adoption

For a repository with historical full-lint debt:

1. Keep changed-files lint blocking.
2. Create a narrow Lint Debt Policy for generated or externally managed sources that must not be rewritten.
3. Run `scan` and review the issue totals.
4. Generate and commit the baseline.
5. Add `check` as a blocking CI/local-CI gate.
6. Run `plan` to see the next safe layout-only batch.
7. Run `apply`.
8. Review the Git diff.
9. Run the repository's normal typecheck, tests, build, and relevant E2E checks.
10. Commit the cleanup and repeat in later small batches.
11. Regenerate the baseline only after an intentional policy/toolchain review.

Do not use baseline regeneration as a way to accept newly introduced lint debt.

## Trust boundary

Lint Debt Remediation is a source-maintenance tool, not a business-logic repair engine.

It does not infer whether a lint suggestion is semantically correct. It therefore does not automatically apply ESLint `problem` or `suggestion` fixes, even when ESLint marks them fixable.

The public toolkit contains no repository-specific exclusions. Organization- or application-specific protected/generated paths remain in the adopting repository or private organization policy.

The engine never reads environment variables, secret stores, databases, customer data, provider state, or deployment credentials.
