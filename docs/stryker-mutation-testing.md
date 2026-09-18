# StrykerJS Mutation Testing v1

StrykerJS Mutation Testing v1 measures whether important tests detect deliberate code changes.

The integration is deliberately bounded. A policy names exact source files, an exact repository commit, one test-only command, hard execution limits, and explicit mutation-quality thresholds.

The toolkit pins `@stryker-mutator/core@10.0.0`.

The adapter itself does not invoke Stryker. It generates a bounded Stryker configuration and later validates/adapts the JSON report produced by an operator-controlled or sandboxed Stryker run.

## Policy

Stryker Mutation Policy v1 requires:

- exact repository id and full commit
- exact Stryker version `10.0.0`
- one or more exact source files, never globs
- one bounded test-only command
- concurrency and timeout limits
- maximum accepted mutant count
- minimum valid mutant count
- minimum mutation score
- maximum survived mutants
- maximum no-coverage mutants
- maximum invalid mutants
The test command accepts only a narrow surface:

- `node --test <relative-test-file> ...`
- `bun test <relative-test-file> ...`
- `bun run test[:name]`
- `npm test`, `pnpm test`, or `yarn test`
- `npm|pnpm|yarn run test[:name]`

Absolute paths, `../` traversal, shell control operators, redirects, quoting, command substitution, and non-test package scripts are rejected.

See `templates/stryker-mutation-policy.v1.json`.

## Generate the Stryker config

```sh
bun run mutation:stryker -- config \
  --policy /private/stryker-mutation-policy.json \
  --json > stryker.conf.json
```

The generated config uses:

- command test runner
- coverage analysis off
- exact mutate files
- JSON reporter only
- `inPlace: false`
- incremental mode off
- explicit concurrency and timeout
- non-breaking Stryker reporter thresholds derived from policy
The adapter intentionally does not execute this config.

Run Stryker only inside an operator-controlled environment or the toolkit task sandbox appropriate for the repository. The repository's own test command still executes application/test code and therefore inherits the security posture of that execution environment.

## Produce mutation evidence

After the Stryker run creates `reports/mutation/mutation.json`:

```sh
bun run mutation:stryker -- evidence \
  --policy /private/stryker-mutation-policy.json \
  --report ./reports/mutation/mutation.json \
  --repository-root /path/to/repository \
  --collected-at 2026-09-19T00:00:00Z \
  --json
```

Evidence adaptation verifies:

- repository HEAD equals the policy commit
- tracked files are clean at that commit
- every mutate target is a tracked regular non-symlink source file
- Stryker framework/version identity
- command-runner and coverage-analysis posture
- exact test command
- concurrency and timeout
- JSON-only reporter configuration
- non-in-place and non-incremental execution
- exact mutate scope and report file set
- policy-derived Stryker thresholds
- bounded unique mutant ids and supported statuses
The report itself is SHA256 and byte-count bound.

Raw source text, mutation replacements, status reasons, project root, private test names, and raw test output are never copied into normalized evidence.

## Mutation metrics

The integration follows Stryker mutation semantics:

- detected = Killed + Timeout
- undetected = Survived + NoCoverage
- valid = detected + undetected
- invalid = CompileError + RuntimeError
- mutation score = detected / valid × 100

The score is reported to four decimal places.

The policy assessment separately checks:

- minimum valid mutants
- minimum mutation score
- maximum survived mutants
- maximum no-coverage mutants
- maximum invalid mutants
- zero pending mutants

A structurally valid report can therefore have `evidenceStatus: VALID` while its quality `overallStatus` is `FAIL`.

This distinction prevents weak tests from being confused with malformed evidence.
## Trust and authority boundary

Mutation evidence is engineering evidence about test sensitivity. It is not proof that the application is correct, that all important behaviors are covered, or that a surviving mutant represents a production defect.

The adapter uses read-only Git inspection only. It performs no Stryker invocation, package-manager execution, network call, source mutation, merge, deployment, or production action.

Stryker itself creates temporary mutated copies when `inPlace: false`. Those mutations occur within the explicit external Stryker execution environment, not through the evidence adapter.

The public toolkit contains no repository-specific business invariant. Projects choose which source files are important and what mutation thresholds are acceptable through explicit policy.

The integration test suite includes a real Stryker 10.0.0 run against a synthetic repository so version/config drift is detected by CI.
