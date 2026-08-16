# Multi-repository Rollout

Adopt the standard incrementally. Start by running the audit against each repository and recording missing required gates separately from optional readiness. Avoid copying workflow files without checking the repository's actual package manager, script names, build requirements, and default branch.

Recommended sequence:

1. Establish a lockfile-backed install and deterministic `typecheck`, `test`, and `build` commands.
2. Add the changed-files lint engine and make it blocking for pull requests.
3. Add CI with sufficient Git history and keep full lint advisory if legacy findings remain.
4. Add repository-specific development and agent instructions based on the templates.
5. Once the audit reports 13/13 core, introduce Level 1 Playwright checks with a local server and the target-origin validator.
6. Add the separate blocking E2E CI job, installing only Chromium and its OS dependencies. Do not add production secrets.
7. Progress through Level 2 public UI state, Level 3 mocked/isolated business flows, and—only with separate authorization—Level 4 staging/provider sandboxes.
8. Re-run the audit regularly and track exceptions with owners and review dates.

Central consistency should not erase legitimate repository differences. Keep shared policy small, version changes deliberately, and validate templates in a representative repository before broad rollout. Never distribute secrets or production configuration through templates.

## Auditing the rollout

Use `bun run audit /path/to/repository` for a working-tree inspection. Use `bun run audit:all --projects-root /path/to/projects` for the coordinated view of the configured repositories at their latest fetched `origin/main`. The multi-repository command fetches without switching branches, creates a detached temporary worktree for the resolved commit, runs the same 18-check engine, and always attempts cleanup. It does not run checkout, reset, stash, clean, rebase, or pull in an application's active worktree, so dirty feature branches remain untouched.

The full score is 18 per repository. The required core score is 13; the other five checks cover agent/development documentation and three E2E-readiness signals. Consequently, optional readiness can produce (for example) 15/18 with core 13/13 and a passing result. The aggregate exits successfully only when every selected repository completed without operational errors and passed all core gates.

For automation, append `--json`. For an offline snapshot, append `--no-fetch`; this deliberately trusts the existing local `origin/main`. Repeat `--repo` or use comma-separated names to audit a subset. A useful workflow is to record a JSON baseline before multi-repository changes, then run the fetched audit again after each repository has merged and pushed its work.

For each application, adapt the start command, port, base URL, readiness/health route, and stable accessible selectors. Add pinned `@playwright/test` plus these conventional scripts:

```json
{
  "test:e2e": "playwright test",
  "test:e2e:ui": "playwright test --ui",
  "test:e2e:install": "playwright install chromium"
}
```

Do not use dependency lifecycle scripts to install browsers. Validate Level 1 locally, then enable the E2E job repository by repository. Production URLs, provider calls, real user data, and deployment operations remain out of scope.
