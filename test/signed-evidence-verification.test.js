import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildSignedEvidenceMessage,
  formatSignedEvidenceVerification,
  main,
  validateSignedEvidenceEnvelope,
  validateSignedEvidencePolicy,
  verifySignedEvidenceBytes,
} from "../scripts/signed-evidence-verification.js";

const SIGNED_AT = "2026-09-18T01:00:00Z";
const EVALUATED_AT = "2026-09-18T01:10:00Z";

/** @param {Buffer|string} value */
function digest(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
/** @returns {{publicKey:crypto.KeyObject,privateKey:crypto.KeyObject,der:Buffer}} */
function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { publicKey, privateKey, der };
}
/** @param {any} keys @param {Partial<any>} [overrides] */
function policy(keys, overrides = {}) {
  return {
    version: 1,
    domain: "example.invalid/toolkit-evidence",
    maxSignatureAgeSeconds: 3600,
    maxFutureSkewSeconds: 60,
    keys: [{
      signerId: "ci-signer",
      keyId: "key:2026-01",
      algorithm: "Ed25519",
      publicKeySpkiBase64: keys.der.toString("base64"),
      publicKeySha256: digest(keys.der),
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2027-01-01T00:00:00Z",
      status: "ACTIVE",
      allowedEvidenceKinds: ["ci-evidence", "runtime-evidence"],
    }],
    ...overrides,
  };
}
/** @param {Buffer} evidence @param {crypto.KeyObject} privateKey @param {Partial<any>} [overrides] */
function envelope(evidence, privateKey, overrides = {}) {
  const base = {
    version: 1, domain: "example.invalid/toolkit-evidence", evidenceKind: "ci-evidence",
    evidenceSha256: digest(evidence), evidenceBytes: evidence.length,
    signerId: "ci-signer", keyId: "key:2026-01", signedAt: SIGNED_AT,
  };
  Object.assign(base, overrides);
  const signature = crypto.sign(null, buildSignedEvidenceMessage(base), privateKey);
  return { ...base, signatureBase64: signature.toString("base64") };
}test("valid Ed25519 signature authenticates exact evidence bytes", () => {
  const keys = keypair(), evidence = Buffer.from('{"version":1,"evidence":{"authenticated":true},"value":"demo"}\n');
  const report = verifySignedEvidenceBytes(evidence, policy(keys), envelope(evidence, keys.privateKey), EVALUATED_AT);
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.authenticated, true);
  assert.equal(report.signatureVerified, true);
  assert.equal(report.subject.sha256, digest(evidence));
  assert.equal(report.signer.publicKeySha256, digest(keys.der));
  assert.equal(report.checks.every((check) => check.status === "PASS"), true);
});

test("caller authenticated boolean is irrelevant when exact bytes are tampered", () => {
  const keys = keypair(), original = Buffer.from('{"evidence":{"authenticated":true},"value":"one"}\n');
  const signed = envelope(original, keys.privateKey);
  const tampered = Buffer.from('{"evidence":{"authenticated":true},"value":"two"}\n');
  const report = verifySignedEvidenceBytes(tampered, policy(keys), signed, EVALUATED_AT);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.authenticated, false);
  assert.equal(report.checks.find((check) => check.id === "subject-sha256")?.status, "FAIL");
});test("signature from a different private key fails authentication", () => {
  const trusted = keypair(), attacker = keypair(), evidence = Buffer.from("signed payload\n");
  const report = verifySignedEvidenceBytes(evidence, policy(trusted), envelope(evidence, attacker.privateKey), EVALUATED_AT);
  assert.equal(report.authenticated, false);
  assert.equal(report.signatureVerified, false);
  assert.equal(report.checks.find((check) => check.id === "signature")?.status, "FAIL");
});

test("domain signer key and evidence kind are policy-bound", () => {
  const keys = keypair(), evidence = Buffer.from("payload\n");
  const wrongDomain = envelope(evidence, keys.privateKey, { domain: "other.invalid/domain" });
  assert.equal(verifySignedEvidenceBytes(evidence, policy(keys), wrongDomain, EVALUATED_AT).authenticated, false);
  const wrongSigner = envelope(evidence, keys.privateKey, { signerId: "other-signer" });
  assert.equal(verifySignedEvidenceBytes(evidence, policy(keys), wrongSigner, EVALUATED_AT).authenticated, false);
  const wrongKind = envelope(evidence, keys.privateKey, { evidenceKind: "unknown-kind" });
  assert.equal(verifySignedEvidenceBytes(evidence, policy(keys), wrongKind, EVALUATED_AT).authenticated, false);
});test("revoked or out-of-window key never authenticates", () => {
  const keys = keypair(), evidence = Buffer.from("payload\n"), signed = envelope(evidence, keys.privateKey);
  const revoked = /** @type {any} */ (policy(keys)); revoked.keys[0].status = "REVOKED";
  assert.equal(verifySignedEvidenceBytes(evidence, revoked, signed, EVALUATED_AT).authenticated, false);
  const expiredAtSigning = /** @type {any} */ (policy(keys)); expiredAtSigning.keys[0].validUntil = "2026-09-17T00:00:00Z";
  assert.equal(verifySignedEvidenceBytes(evidence, expiredAtSigning, signed, EVALUATED_AT).authenticated, false);
});

test("stale signature stays cryptographically authentic but fails policy freshness", () => {
  const keys = keypair(), evidence = Buffer.from("payload\n"), signed = envelope(evidence, keys.privateKey);
  const report = verifySignedEvidenceBytes(evidence, policy(keys), signed, "2026-09-18T03:00:00Z");
  assert.equal(report.signatureVerified, true);
  assert.equal(report.authenticated, true);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "freshness")?.status, "FAIL");
});test("future signature outside explicit skew is rejected", () => {
  const keys = keypair(), evidence = Buffer.from("payload\n");
  const signed = envelope(evidence, keys.privateKey, { signedAt: "2026-09-18T01:20:00Z" });
  const report = verifySignedEvidenceBytes(evidence, policy(keys), signed, EVALUATED_AT);
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.find((check) => check.id === "not-future")?.status, "FAIL");
});

test("policy validates Ed25519 SPKI fingerprint and rejects RSA or mismatched fingerprint", () => {
  const keys = keypair();
  assert.equal(validateSignedEvidencePolicy(policy(keys)).valid, true);
  const mismatch = /** @type {any} */ (policy(keys)); mismatch.keys[0].publicKeySha256 = "0".repeat(64);
  assert.equal(validateSignedEvidencePolicy(mismatch).valid, false);
  const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" });
  const wrong = /** @type {any} */ (policy(keys)); wrong.keys[0].publicKeySpkiBase64 = rsa.toString("base64"); wrong.keys[0].publicKeySha256 = digest(rsa);
  assert.equal(validateSignedEvidencePolicy(wrong).valid, false);
});test("envelope rejects noncanonical or wrong-length signatures and unknown fields", () => {
  const keys = keypair(), evidence = Buffer.from("payload\n"), signed = envelope(evidence, keys.privateKey);
  assert.equal(validateSignedEvidenceEnvelope(signed).valid, true);
  assert.equal(validateSignedEvidenceEnvelope({ ...signed, signatureBase64: Buffer.alloc(32).toString("base64") }).valid, false);
  assert.equal(validateSignedEvidenceEnvelope({ ...signed, command: "deploy" }).valid, false);
});

test("verification report never exposes evidence content signature or public key", () => {
  const keys = keypair(), evidence = Buffer.from("secret-looking-but-synthetic-payload\n");
  const report = verifySignedEvidenceBytes(evidence, policy(keys), envelope(evidence, keys.privateKey), EVALUATED_AT);
  const serialized = JSON.stringify(report);
  assert.doesNotMatch(serialized, /secret-looking/);
  assert.doesNotMatch(serialized, /signatureBase64|publicKeySpkiBase64/);
  assert.match(formatSignedEvidenceVerification(report), /Authenticated: true/);
});test("CLI verifies regular files and exits nonzero after evidence tampering", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signed-evidence-"));
  const keys = keypair(), evidence = Buffer.from('{"evidence":{"authenticated":true}}\n');
  const evidenceFile = path.join(root, "evidence.json"), policyFile = path.join(root, "policy.json"), envelopeFile = path.join(root, "envelope.json");
  fs.writeFileSync(evidenceFile, evidence); fs.writeFileSync(policyFile, JSON.stringify(policy(keys))); fs.writeFileSync(envelopeFile, JSON.stringify(envelope(evidence, keys.privateKey)));
  const original = console.log; console.log = () => {};
  try {
    assert.equal(main(["--evidence", evidenceFile, "--policy", policyFile, "--envelope", envelopeFile, "--evaluated-at", EVALUATED_AT, "--json"]), 0);
    fs.appendFileSync(evidenceFile, " ");
    assert.equal(main(["--evidence", evidenceFile, "--policy", policyFile, "--envelope", envelopeFile, "--evaluated-at", EVALUATED_AT, "--json"]), 1);
  } finally { console.log = original; fs.rmSync(root, { recursive: true, force: true }); }
});test("CLI rejects symlinked evidence and malformed argument surface", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "signed-evidence-link-"));
  const target = path.join(root, "target.json"), link = path.join(root, "evidence.json");
  fs.writeFileSync(target, "{}\n"); fs.symlinkSync(target, link);
  const original = console.error; console.error = () => {};
  try {
    assert.equal(main([]), 1);
    assert.equal(main(["--unknown", "x"]), 1);
    assert.equal(main(["--evidence", link, "--policy", target, "--envelope", target, "--evaluated-at", EVALUATED_AT]), 1);
  } finally { console.error = original; fs.rmSync(root, { recursive: true, force: true }); }
});

test("public signed-evidence policy template is valid and contains no private key", () => {
  const file = new URL("../templates/signed-evidence-policy.v1.json", import.meta.url);
  const rawText = fs.readFileSync(file, "utf8"), raw = JSON.parse(rawText);
  assert.equal(validateSignedEvidencePolicy(raw).valid, true);
  assert.doesNotMatch(rawText, /PRIVATE KEY|privateKey/i);
});

test("verifier source has no signing private-key generation network or implicit clock surface", () => {
  const source = fs.readFileSync(new URL("../scripts/signed-evidence-verification.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /generateKeyPair|createPrivateKey|fetch\(|https?:\/\//);
  assert.doesNotMatch(source, /Date\.now\(\)/);
  assert.match(source, /crypto\.verify/);
});
