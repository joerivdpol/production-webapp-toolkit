# AI-assisted Development Workflow

AI agents should operate within the same review and quality system as human contributors. Repository instructions define their authority; CI supplies independent verification.

A safe workflow is inspect, scope, modify, verify, and report. The agent should begin on a task branch, read local instructions and existing changes, and identify the smallest reviewable implementation. It should preserve unrelated work, avoid production access, and treat credentials and private data as out of scope.

Before completion, the agent runs typechecking, tests, the production build when relevant, and changed-files lint. It must report failures rather than weakening checks to obtain a green result. Commit, push, merge, deploy, publish, provider operations, and production-facing smoke tests require explicit authorization.

The `templates/AGENTS.md` file is a starting point, not a substitute for repository-specific context. Add commands, architectural boundaries, and safety constraints that are genuinely applicable, while keeping confidential business rules and secrets outside public instructions.
