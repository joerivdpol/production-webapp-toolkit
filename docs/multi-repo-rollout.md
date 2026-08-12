# Multi-repository Rollout

Adopt the standard incrementally. Start by running the audit against each repository and recording missing required gates separately from optional readiness. Avoid copying workflow files without checking the repository's actual package manager, script names, build requirements, and default branch.

Recommended sequence:

1. Establish a lockfile-backed install and deterministic `typecheck`, `test`, and `build` commands.
2. Add the changed-files lint engine and make it blocking for pull requests.
3. Add CI with sufficient Git history and keep full lint advisory if legacy findings remain.
4. Add repository-specific development and agent instructions based on the templates.
5. Introduce isolated Playwright tests when stable fixtures and test environments exist.
6. Re-run the audit regularly and track exceptions with owners and review dates.

Central consistency should not erase legitimate repository differences. Keep shared policy small, version changes deliberately, and validate templates in a representative repository before broad rollout. Never distribute secrets or production configuration through templates.
