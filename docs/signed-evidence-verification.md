# Signed Evidence Verification v1

Signed Evidence Verification v1 establishes evidence authentication from an Ed25519 signature over exact evidence bytes and explicit metadata.

It does not infer trust from an evidence field such as `authenticated: true`. Those booleans remain caller metadata and do not prove who produced a file.

The verifier is intentionally one-way. The public toolkit does not generate signing keys, hold private keys, call a key-management service, or publish a hosted signing endpoint.

## Signed subject

A detached envelope binds:

- `domain`
- `evidenceKind`
- evidence SHA256
- evidence byte count
- `signerId`
- `keyId`
- `signedAt`

The Ed25519 signature covers the canonical JSON representation of those fields in that fixed order.
The evidence file itself is not rewritten or normalized before hashing. Whitespace or any other byte change after signing changes the SHA256 and fails verification.

A successful report therefore authenticates one exact byte sequence, not merely a semantically equivalent JSON object.

## Public-key policy

The policy is caller supplied and may remain private even though its Ed25519 public keys are not secret.

Each key binds an explicit signer id and key id to:

- one SPKI DER public key encoded as canonical base64
- the SHA256 fingerprint of that exact SPKI key
- an ACTIVE or REVOKED status
- a validity window
- an allowlist of evidence kinds

The policy also sets one domain, maximum signature age, and maximum allowed future clock skew.

See `templates/signed-evidence-policy.v1.json` for a synthetic public-key example.
The example key has no role in maintainer infrastructure. Installations must replace it with their own public key material.

## Verification

```sh
bun run evidence:signed:verify -- \
  --evidence ./ci-evidence.json \
  --policy /private/signed-evidence-policy.json \
  --envelope ./ci-evidence.signature.json \
  --evaluated-at 2026-09-18T01:10:00Z \
  --json
```

The evaluation clock is always caller supplied. The verifier never reads the system clock.

A PASS requires exact subject hash and byte count, domain match, signer/key lookup, allowed evidence kind, active key status, signing inside the key validity window, runtime fingerprint match, valid Ed25519 signature, acceptable future skew, and freshness.
`authenticated: true` in the verification report means the cryptographic identity and exact-byte checks passed under the supplied key policy.

Freshness is reported separately as part of overall status. A stale signature can remain cryptographically authentic while the overall verification is FAIL.

Authentication does not prove that the evidence is correct, complete, safe, sufficient, or semantically valid. Canonical evidence validators and audits remain responsible for those properties.

## Release Evidence Bundle integration

Release Evidence Bundle v1 no longer copies authentication booleans from source evidence into bundle trust.

Without signed evidence proofs, all five bundle trust fields are `false`.

Optional signed mode uses:

```sh
--signed-evidence-policy-file /private/signed-evidence-policy.json
--signed-evidence ci-evidence=./ci.signature.json
```
The `--signed-evidence` option may be repeated for the supported canonical evidence ids:

- `ci-evidence`
- `artifact-provenance`
- `runtime-evidence`
- `runtime-health-evidence`
- `vulnerability-evidence`

Every supplied envelope is reverified against the exact evidence file bytes at bundle `createdAt`.

A valid proof sets only its matching trust field to true. A wrong signer, signature, evidence kind, hash, byte count, key status, key validity, or freshness produces a FAIL bundle check and leaves that trust field false.

The public evidence index stores SHA256 bindings for the signed-evidence policy and detached envelopes when signed mode is used. It never stores a private key.

## Trust boundary

Keep private signing keys outside this repository and outside agent worktrees.
Signing should occur in an independently controlled CI, KMS/HSM workflow, or another operator-managed environment appropriate for the deployment.

Do not expose a maintainer signing service through the public toolkit, MCP server, Lenovo worker, or Ubuntu worker.

Signed Evidence Verification v1 is read-only. It has no network, subprocess, deployment, merge, package-manager, or source-mutation authority.

The verifier intentionally supports Ed25519 only in v1 to keep the accepted cryptographic surface explicit and narrow.
