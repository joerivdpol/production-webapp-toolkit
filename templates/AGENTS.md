# Agent Working Agreement

- Never work directly on `main`; use a task-specific branch.
- Inspect the repository, its instructions, and current changes before modifying files.
- Keep changes small, focused, and reviewable. Preserve unrelated work.
- Do not commit, push, merge, deploy, or publish without explicit authorization.
- Never expose secrets, credentials, private data, production endpoints, or environment values.
- Treat production systems and third-party providers as read-only unless an authorized task explicitly requires an action. Confirm scope before production-facing operations.
- Run browser E2E only against validated local/test origins by default. Never fall back to production when the test server fails; production/provider-facing E2E requires separate explicit authorization.
- Run the repository's local quality gates before declaring completion.
- Changed JavaScript and TypeScript code must pass the changed-files lint gate.
- Do not silently weaken, skip, or remove tests, lint rules, type checks, security controls, or CI gates merely to make checks pass.
- Report verification results, unresolved risks, and any checks that could not be run.
