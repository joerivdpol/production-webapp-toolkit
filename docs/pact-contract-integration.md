# Pact Contract Integration v1

Pact integration is an executable complement to the existing static API and
cross-repository contract audits. It replays consumer-generated literal HTTP
contracts against a caller-controlled synthetic provider. It does not replace
canonical application contracts, business rules, or application integration tests.

The toolkit pins `@pact-foundation/pact@17.1.4` and uses its real native verifier.
The complete smoke generates a contract using a real Pact consumer test before
performing provider verification. Do not hand-author production Pact contracts
from an API schema; generate them from the application's consumer tests.

## Scope and policy

See `templates/pact-contract-policy.v1.json`. The repeated commits and hash in the
template are placeholders, not valid evidence about an actual repository.

Policy declares exact consumer and provider ids and full Git commits, the pinned
Pact version, a synthetic-only classification, an explicit HTTP method allowlist,
and one to sixteen exact repository-relative contract paths. Every contract has
its own SHA-256 and expected nonzero interaction count. There are at most 64
interactions per file and 256 in total. A file is limited to 1 MiB; all files
together to 8 MiB. Empty suites never constitute a successful verification.

Both roots must be real, non-symlink Git roots with matching HEAD and clean Git
status. Contracts must also be tracked regular files; their bytes must match the
committed Git blob and the policy SHA-256. This additional byte check detects
contract changes hidden by `assume-unchanged` or `skip-worktree`. Contract source
and repository identity are inspected again after execution and cleanup.

Version 1 deliberately supports a small surface:

- Pact specification 3.0.0, HTTP request/response interactions, literal JSON data.
- Explicit methods and simple absolute paths; no query strings, path traversal,
  URL encoding, alternate authorities, fragments, or arbitrary endpoints.
- Bounded Accept, Content-Type and X-Synthetic-Scenario headers. No authorization,
  cookies, Host override, or caller-supplied forwarding headers.
- No provider states, generators, matching rules, plugins, messages, pending/WIP
  interactions, broker lookup, selectors, custom filters or publication options.

Unsupported input fails closed; it is not silently ignored. These restrictions
are intentional v1 limitations, not a claim to implement every Pact feature.
Body limits and `SYNTHETIC_ONLY` do not prove that all caller data is synthetic or
free of secrets: only synthetic fixtures belong in this integration.

## Offline validation and inspection

```sh
bun run integration:pact -- validate \
  --policy /private/pact-contract-policy.json --json

bun run integration:pact -- inspect \
  --policy /private/pact-contract-policy.json \
  --consumer-root /private/consumer-checkout --json
```

Neither CLI command starts a provider or contacts a network endpoint. The CLI
intentionally has no arbitrary provider URL or command-execution mode.

## Programmatic verification

An operator-controlled test imports `verifyPactContracts()` from
`scripts/pact-contract-integration.js` and supplies:

```js
const evidence = await verifyPactContracts(
  consumerRoot,
  providerRoot,
  policy,
  collectedAt,
  async () => {
    // Start the application's disposable synthetic test provider here.
    // Return only after it is listening on an ephemeral IPv4 loopback port.
    const provider = await startSyntheticProvider();
    return {
      baseUrl: provider.baseUrl,
      close: async () => { await provider.close(); },
    };
  },
);
if (evidence.overallStatus !== "PASS") process.exitCode = 1;
```

The callback must return a URL exactly shaped as `http://127.0.0.1:<port>` with a
nonprivileged port and a cleanup function. No production provider, tunnel, proxy
to production, credentials or real customer dataset is authorized. Allowed
POST/PUT/PATCH/DELETE methods apply only to the disposable synthetic provider.

The gateway binds a random loopback port, permits only contract-declared
method/path pairs and forwards bounded request/response bodies. It does not
follow redirects, and strips unapproved headers. Pact sees the gateway rather
than a caller-supplied external URL. A dedicated non-proxy HTTP agent avoids
ambient global-agent/proxy settings in the parent process. Successful native
verification additionally requires request counts covering every declared interaction.

## Worker and cleanup boundaries

The verifier runs as a separate fixed worker with an explicit environment;
ambient broker credentials, proxy variables, Node preload flags and Pact
interaction-selection variables are not inherited. Telemetry is disabled in the
worker, and dependency installation opts out of Scarf analytics. No shell,
custom modules, provider hooks or broker publication are loaded from policy.

The 1–30 second policy timeout is a hard limit on the native verifier worker,
including worker startup. Combined stdout/stderr has a 1 MiB limit and is
counted then discarded, not copied into evidence. On POSIX, termination targets
the worker process group. Linux with the repository's pinned Node/Bun toolchain
is the tested platform.

The gateway closes, the provider cleanup callback runs, and private temporary
contract copies are removed on success and failure. Cleanup errors are blocking.
Changes made during cleanup cannot leave a successful report over changed source.

Provider callbacks are trusted application test code, not an OS sandbox.
`timeoutMs` does not time-limit arbitrary caller startup/cleanup code; callbacks
must manage their own partial-startup cleanup and termination deadlines. The
private parent directory has mode 0700 and copies mode 0600, but this is not
isolation from hostile processes running under the same OS account. Use a
separately isolated worker for untrusted application code.

## Evidence and trust

Evidence contains both declared commits, validated contract paths/hashes/counts,
the parsed policy hash, explicit collection time, pinned tool identity, verification
outcome, technical status, cleanup status and overall status. It omits provider
URLs and ports, absolute paths, request/response bodies, environment values,
raw worker logs and callback exceptions.

A completed contract mismatch has `verificationStatus: FAIL` and
`technicalStatus: PASS`: the comparison ran and rejected the contract. Gateway,
timeout, worker, integrity or cleanup failures have failing technical status.
`overallStatus` passes only when verification and cleanup both pass.

`runtimeIdentityVerified: false` and `authenticity: UNVERIFIED` are deliberate.
Clean checkout binding is not proof that a callback started that exact build.
The result is not signed evidence and grants no merge, deployment, payment,
booking, migration or production-mutation authority. Application-specific
provider/consumer edge ownership still belongs in private contract policy.

## Tests

```sh
node --test test/pact-contract-integration.test.js
bun run integration:pact:smoke
```

The native smoke generates two consumer interactions (GET and synthetic POST),
then verifies ambient-proxy isolation, a compatible provider, an intentionally
incompatible provider, a redirect, a timeout, an oversized response, a cleanup failure and a source
change during cleanup. The redirect target must receive zero requests.

Policy/unit tests cover identity/version limits, broker/selector rejection,
path and symlink containment, dirty/mismatched roots, committed-blob binding,
malformed/oversized contracts, body limits, callback errors and offline CLI
behavior. CI runs the native smoke as a separate bounded step.

The public toolkit includes no access to maintainer computers, model servers,
private workers or Docker endpoints. Adopters provide their own test runners.

## Upstream references

- https://docs.pact.io/implementation_guides/javascript/docs/provider
- https://docs.pact.io/implementation_guides/javascript/docs/troubleshooting
- https://docs.pact.io/faq
