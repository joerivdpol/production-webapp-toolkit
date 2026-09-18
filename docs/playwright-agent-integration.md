# Playwright Planner/Generator Integration v1

This integration audits Playwright's official planner and generator setup without authorizing the healer.

Playwright 1.61.1 exposes planner, generator, and healer agent definitions through `playwright init-agents`. The healer can modify failing tests and may mark a test as fixme when it believes application behavior is broken. This toolkit therefore treats healer and the generated coverage workflow that invokes healer as outside item 98 authority.

## Trust boundary

The toolkit adapter is read-only.

It does not execute `init-agents`, launch a browser, invoke Playwright MCP, write generated tests, heal tests, update snapshots, or modify source files.

The adapter only:

- verifies a linked Git worktree at one exact commit
- verifies the locally installed Playwright version
- inspects planner/generator definitions and prompts
- validates a saved Markdown test plan
- audits already generated test files
The reported `initPlan` is declarative. An operator or separately authorized agent may execute the official initialization command outside this adapter.

The public template is `templates/playwright-agent-integration-policy.v1.json`. Each installation supplies its own repository paths and policy.

## Planner and generator only

Allowed agent definitions must:

- identify exactly `playwright_test_planner` or `playwright_test_generator`
- use a read-only agent sandbox
- point at Playwright's test MCP server
- contain no healer reference

Allowed prompt files must identify the corresponding planner or generator and must not invoke healer behavior.

The integration always reports:

```text
healerAuthorized: false
coveragePromptAuthorized: false
```
## Test plan requirements

The saved plan is bounded by policy and must contain:

- the exact configured seed file
- at least one numbered scenario
- a Steps section
- an Expected Result or Expected Results section

Plan text containing skip, fixme, or xfail language is rejected.

## Generated test audit

Generated files are read only from the configured generated test root.

Each generated Playwright test must:

- be a supported JavaScript or TypeScript spec file
- parse successfully
- contain `// spec: <exact plan file>`
- contain `// seed: <exact seed file>`
- contain at least one `test(...)`
- contain at least one `expect(...)`

The AST audit blocks disabled, focused, or expected-failure calls including `test.skip`, `test.fixme`, `test.only`, `test.fail`, nested forms such as `test.describe.skip`, and `test.step.skip`.
This is intentionally stricter than a "make tests green" workflow. A product defect remains visible instead of being hidden by disabling the generated regression.

The adapter does not approve snapshot updates and does not invoke any snapshot-update command.

## Usage

First initialize Playwright's repository agents separately if the repository does not already contain them:

```sh
npx playwright init-agents --loop=codex --prompts --config playwright.config.ts
```

Review the generated files before use. The toolkit does not automatically trust every file produced by `init-agents`.

Inspect the planner/generator setup:

```sh
bun run playwright:agents -- inspect \
  --root /path/to/linked-worktree \
  --policy /private/playwright-agent-policy.json \
  --expected-commit <full-sha> \
  --json
```
Audit a saved plan and generated tests:

```sh
bun run playwright:agents -- audit \
  --root /path/to/linked-worktree \
  --policy /private/playwright-agent-policy.json \
  --expected-commit <full-sha> \
  --json
```

A PASS means only that the inspected files satisfy these bounded structural rules.

It does not prove that the test is semantically correct, that the browser flow is safe, or that application functionality is correct. Running generated tests remains a separate sandboxed execution step.
