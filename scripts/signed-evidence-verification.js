#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const MAX_POLICY_BYTES = 1024 * 1024;
const MAX_ENVELOPE_BYTES = 128 * 1024;

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
/** @param {unknown} value @param {number} [max] */
function text(value, max = 512) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= max && !/[\u0000\r\n]/.test(normalized) ? normalized : null;
}
/** @param {unknown} value */
function portableId(value) {
  const normalized = text(value, 128);
  return normalized && ID.test(normalized) ? normalized : null;
}
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value, min, max) {
  return Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= max ? Number(value) : null;
}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
}
/** @param {unknown} value @param {number} maxBytes */
function canonicalBase64(value, maxBytes) {
  const normalized = text(value, Math.ceil(maxBytes / 3) * 4 + 8);
  if (!normalized || !/^[A-Za-z0-9+/]+={0,2}$/.test(normalized)) return null;
  let decoded;
  try { decoded = Buffer.from(normalized, "base64"); } catch { return null; }
  if (decoded.length < 1 || decoded.length > maxBytes || decoded.toString("base64") !== normalized) return null;
  return decoded;
}
/** @param {Buffer|string} value */
function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}
/** @param {unknown} value */
export function validateSignedEvidencePolicy(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, policy: null, errors: [{ id: "policy-invalid", detail: "signed evidence policy must be an object" }] };
  rejectUnknown(value, ["version", "domain", "maxSignatureAgeSeconds", "maxFutureSkewSeconds", "keys"], "policy", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "policy version must be exactly 1" });
  const domain = text(value.domain, 256);
  const maxSignatureAgeSeconds = integer(value.maxSignatureAgeSeconds, 1, 365 * 24 * 3600);
  const maxFutureSkewSeconds = integer(value.maxFutureSkewSeconds, 0, 3600);
  if (!domain) errors.push({ id: "domain-invalid", detail: "policy domain must be a bounded single-line string" });
  if (maxSignatureAgeSeconds === null || maxFutureSkewSeconds === null) errors.push({ id: "freshness-policy-invalid", detail: "signature age and future skew bounds are invalid" });

  /** @type {Array<any>} */ const keys = [];
  const identities = new Set();
  if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > 64) errors.push({ id: "keys-invalid", detail: "policy keys must be a non-empty bounded array" });
  else for (const [index, raw] of value.keys.entries()) {
    if (!object(raw)) { errors.push({ id: "key-invalid", detail: `keys[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["signerId", "keyId", "algorithm", "publicKeySpkiBase64", "publicKeySha256", "validFrom", "validUntil", "status", "allowedEvidenceKinds"], "key", errors);
    const signerId = portableId(raw.signerId), keyId = portableId(raw.keyId), algorithm = text(raw.algorithm, 32), status = text(raw.status, 32);
    const publicKeyDer = canonicalBase64(raw.publicKeySpkiBase64, 512), fingerprint = text(raw.publicKeySha256, 64)?.toLowerCase() ?? null;
    const validFrom = text(raw.validFrom, 64), validUntil = text(raw.validUntil, 64);
    const kinds = Array.isArray(raw.allowedEvidenceKinds) ? raw.allowedEvidenceKinds.map(portableId) : null;
    const identity = signerId && keyId ? `${signerId}\u0000${keyId}` : null;
    if (!signerId || !keyId || !identity || identities.has(identity)) errors.push({ id: "key-identity-invalid", detail: `keys[${index}] signer/key identity is invalid or duplicate` });
    if (algorithm !== "Ed25519" || !publicKeyDer || !fingerprint || !SHA256.test(fingerprint) || sha256(publicKeyDer) !== fingerprint) errors.push({ id: "key-cryptography-invalid", detail: `keys[${index}] must contain an Ed25519 SPKI public key bound to its SHA256 fingerprint` });
    if (!validFrom || !validUntil || !isAbsoluteIsoTimestamp(validFrom) || !isAbsoluteIsoTimestamp(validUntil) || Date.parse(validUntil) <= Date.parse(validFrom)) errors.push({ id: "key-validity-invalid", detail: `keys[${index}] validity window is invalid` });
    if (!status || !["ACTIVE", "REVOKED"].includes(status)) errors.push({ id: "key-status-invalid", detail: `keys[${index}] status must be ACTIVE or REVOKED` });
    if (!kinds || kinds.length === 0 || kinds.length > 64 || kinds.some((kind) => !kind) || new Set(kinds).size !== kinds.length) errors.push({ id: "key-kinds-invalid", detail: `keys[${index}] allowedEvidenceKinds must be unique portable ids` });
    if (publicKeyDer) {
      try {
        const key = crypto.createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
        if (key.asymmetricKeyType !== "ed25519") errors.push({ id: "key-type-invalid", detail: `keys[${index}] SPKI key is not Ed25519` });
      } catch { errors.push({ id: "key-parse-invalid", detail: `keys[${index}] SPKI public key cannot be parsed` }); }
    }
    if (identity) identities.add(identity);
    if (signerId && keyId && publicKeyDer && fingerprint && validFrom && validUntil && status && kinds && kinds.every(Boolean)) keys.push({
      signerId, keyId, algorithm: "Ed25519", publicKeySpkiBase64: publicKeyDer.toString("base64"), publicKeySha256: fingerprint,
      validFrom, validUntil, status, allowedEvidenceKinds: /** @type {string[]} */ (kinds).sort(),
    });
  }
  if (errors.length || !domain || maxSignatureAgeSeconds === null || maxFutureSkewSeconds === null) return { valid: false, policy: null, errors };
  return { valid: true, policy: { version: 1, domain, maxSignatureAgeSeconds, maxFutureSkewSeconds, keys: keys.sort((a, b) => `${a.signerId}\u0000${a.keyId}`.localeCompare(`${b.signerId}\u0000${b.keyId}`)) }, errors: [] };
}

/** @param {unknown} value */
/** @param {unknown} value */
export function validateSignedEvidenceEnvelope(value) {
  /** @type {Array<{id:string,detail:string}>} */ const errors = [];
  if (!object(value)) return { valid: false, envelope: null, errors: [{ id: "envelope-invalid", detail: "signed evidence envelope must be an object" }] };
  rejectUnknown(value, ["version", "domain", "evidenceKind", "evidenceSha256", "evidenceBytes", "signerId", "keyId", "signedAt", "signatureBase64"], "envelope", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "envelope version must be exactly 1" });
  const domain = text(value.domain, 256), evidenceKind = portableId(value.evidenceKind), evidenceSha256 = text(value.evidenceSha256, 64)?.toLowerCase() ?? null;
  const evidenceBytes = integer(value.evidenceBytes, 1, MAX_EVIDENCE_BYTES), signerId = portableId(value.signerId), keyId = portableId(value.keyId), signedAt = text(value.signedAt, 64);
  const signature = canonicalBase64(value.signatureBase64, 64);
  if (!domain || !evidenceKind || !evidenceSha256 || !SHA256.test(evidenceSha256) || evidenceBytes === null || !signerId || !keyId || !signedAt || !isAbsoluteIsoTimestamp(signedAt)) errors.push({ id: "envelope-fields-invalid", detail: "signed evidence envelope contains invalid identity, subject, or time fields" });
  if (!signature || signature.length !== 64) errors.push({ id: "signature-invalid", detail: "Ed25519 signature must be exactly 64 canonical base64 bytes" });
  if (errors.length || !domain || !evidenceKind || !evidenceSha256 || evidenceBytes === null || !signerId || !keyId || !signedAt || !signature) return { valid: false, envelope: null, errors };
  return { valid: true, envelope: { version: 1, domain, evidenceKind, evidenceSha256, evidenceBytes, signerId, keyId, signedAt, signatureBase64: signature.toString("base64") }, errors: [] };
}

/** @param {any} envelope */
export function buildSignedEvidenceMessage(envelope) {
  const validated = validateSignedEvidenceEnvelope({ ...envelope, signatureBase64: envelope.signatureBase64 ?? Buffer.alloc(64).toString("base64") });
  if (!validated.valid || !validated.envelope) throw new Error("signed evidence envelope fields are invalid");
  const e = validated.envelope;
  return Buffer.from(JSON.stringify({ version: 1, domain: e.domain, evidenceKind: e.evidenceKind, evidenceSha256: e.evidenceSha256, evidenceBytes: e.evidenceBytes, signerId: e.signerId, keyId: e.keyId, signedAt: e.signedAt }), "utf8");
}
/** @param {Buffer} evidenceBytes @param {any} rawPolicy @param {any} rawEnvelope @param {string} evaluatedAt */
/** @param {Buffer} evidenceBytes @param {unknown} rawPolicy @param {unknown} rawEnvelope @param {string} evaluatedAt */
export function verifySignedEvidenceBytes(evidenceBytes, rawPolicy, rawEnvelope, evaluatedAt) {
  if (!Buffer.isBuffer(evidenceBytes) || evidenceBytes.length < 1 || evidenceBytes.length > MAX_EVIDENCE_BYTES) throw new Error("evidence bytes must be a bounded non-empty Buffer");
  if (!isAbsoluteIsoTimestamp(evaluatedAt)) throw new Error("evaluatedAt must be an absolute ISO timestamp");
  const policyResult = validateSignedEvidencePolicy(rawPolicy), envelopeResult = validateSignedEvidenceEnvelope(rawEnvelope);
  if (!policyResult.valid || !policyResult.policy) throw new Error("signed evidence policy is invalid");
  if (!envelopeResult.valid || !envelopeResult.envelope) throw new Error("signed evidence envelope is invalid");
  const policy = policyResult.policy, envelope = envelopeResult.envelope;
  /** @type {Array<{id:string,status:"PASS"|"FAIL",detail:string}>} */ const checks = [];
  /** @param {string} id @param {boolean} pass @param {string} detail */
  const add = (id, pass, detail) => checks.push({ id, status: pass ? "PASS" : "FAIL", detail });
  const actualSha = sha256(evidenceBytes);
  add("subject-sha256", actualSha === envelope.evidenceSha256, "evidence SHA256 must equal the signed subject hash");
  add("subject-bytes", evidenceBytes.length === envelope.evidenceBytes, "evidence byte count must equal the signed subject size");
  add("domain", envelope.domain === policy.domain, "signed domain must equal policy domain exactly");

  const key = policy.keys.find((candidate) => candidate.signerId === envelope.signerId && candidate.keyId === envelope.keyId) ?? null;
  add("signer-key", key !== null, "signerId and keyId must identify one explicit policy key");
  add("evidence-kind", key !== null && key.allowedEvidenceKinds.includes(envelope.evidenceKind), "evidence kind must be explicitly allowed by the signer key");
  add("key-status", key !== null && key.status === "ACTIVE", "signer key must be ACTIVE");
  add("key-valid-from", key !== null && Date.parse(envelope.signedAt) >= Date.parse(key.validFrom), "signature time must not precede key validity");
  add("key-valid-until", key !== null && Date.parse(envelope.signedAt) <= Date.parse(key.validUntil), "signature time must not exceed key validity");

  let signatureVerified = false, keyFingerprint = null;
  if (key) {
    try {
      const der = Buffer.from(key.publicKeySpkiBase64, "base64");
      keyFingerprint = sha256(der);
      const publicKey = crypto.createPublicKey({ key: der, format: "der", type: "spki" });
      signatureVerified = crypto.verify(null, buildSignedEvidenceMessage(envelope), publicKey, Buffer.from(envelope.signatureBase64, "base64"));
    } catch { signatureVerified = false; }
  }
  add("key-fingerprint", key !== null && keyFingerprint === key.publicKeySha256, "runtime public-key fingerprint must equal policy binding");
  add("signature", signatureVerified, "Ed25519 signature must verify over the canonical signed evidence message");

  const signedMs = Date.parse(envelope.signedAt), evaluatedMs = Date.parse(evaluatedAt), ageSeconds = Math.floor((evaluatedMs - signedMs) / 1000);
  add("not-future", signedMs <= evaluatedMs + policy.maxFutureSkewSeconds * 1000, "signature time must not exceed the allowed future skew");
  add("freshness", ageSeconds <= policy.maxSignatureAgeSeconds, "signature age must not exceed policy maxSignatureAgeSeconds");

  const authenticationChecks = new Set(["subject-sha256", "subject-bytes", "domain", "signer-key", "evidence-kind", "key-status", "key-valid-from", "key-valid-until", "key-fingerprint", "signature"]);
  const authenticated = checks.filter((check) => authenticationChecks.has(check.id)).every((check) => check.status === "PASS");
  const overallStatus = checks.every((check) => check.status === "PASS") ? "PASS" : "FAIL";
  return {
    version: 1, overallStatus, authenticated, signatureVerified,
    subject: { evidenceKind: envelope.evidenceKind, sha256: actualSha, bytes: evidenceBytes.length },
    signer: { signerId: envelope.signerId, keyId: envelope.keyId, publicKeySha256: keyFingerprint },
    signedAt: envelope.signedAt, evaluatedAt, ageSeconds,
    checks, technicalStatus: "PASS",
    semantics: "authentication proves Ed25519 control of an explicitly trusted active key over the exact evidence bytes and signed metadata; it does not prove evidence semantics, correctness, completeness, or freshness beyond the explicit checks",
  };
}

/** @param {string} filename @param {number} maxBytes */
function readRegularFile(filename, maxBytes) {
  const resolved = path.resolve(filename); let stat;
  try { stat = fs.lstatSync(resolved); } catch { throw new Error("signed evidence input cannot be read"); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > maxBytes) throw new Error("signed evidence input must be a bounded non-empty regular file");
  return fs.readFileSync(resolved);
}
/** @param {string} filename @param {number} maxBytes */
function readJson(filename, maxBytes) {
  let value; try { value = JSON.parse(readRegularFile(filename, maxBytes).toString("utf8")); } catch { throw new Error("signed evidence JSON input cannot be parsed"); }
  return value;
}
/** @param {any} report */
/** @param {any} report */
export function formatSignedEvidenceVerification(report) {
  const lines = ["Signed Evidence Verification v1", "", `Evidence kind: ${report.subject.evidenceKind}`, `SHA256: ${report.subject.sha256}`, `Bytes: ${report.subject.bytes}`, `Signer: ${report.signer.signerId} / ${report.signer.keyId}`, `Signed at: ${report.signedAt}`, `Evaluated at: ${report.evaluatedAt}`, `Authenticated: ${report.authenticated}`, `Signature verified: ${report.signatureVerified}`, ""];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.detail}`);
  lines.push("", `Overall: ${report.overallStatus}`, `Semantics: ${report.semantics}`);
  return lines.join("\n");
}
/** @param {string[]} argv */
function parse(argv) {
  const values = new Map(), allowed = new Set(["--evidence", "--policy", "--envelope", "--evaluated-at"]); let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]; if (arg === "--json") { if (json) return null; json = true; continue; }
    if (!allowed.has(arg ?? "") || values.has(arg)) return null;
    const next = argv[index + 1]; if (typeof next !== "string" || next.startsWith("--")) return null;
    values.set(arg, next); index += 1;
  }
  for (const arg of allowed) if (!values.has(arg)) return null;
  return { evidence: values.get("--evidence"), policy: values.get("--policy"), envelope: values.get("--envelope"), evaluatedAt: values.get("--evaluated-at"), json };
}export function main(argv = process.argv.slice(2)) {
  const options = parse(argv);
  if (!options) { console.error("Usage: node scripts/signed-evidence-verification.js --evidence <file> --policy <signed-evidence-policy.json> --envelope <signature-envelope.json> --evaluated-at <absolute-ISO> [--json]"); return 1; }
  try {
    const evidence = readRegularFile(options.evidence, MAX_EVIDENCE_BYTES), policy = readJson(options.policy, MAX_POLICY_BYTES), envelope = readJson(options.envelope, MAX_ENVELOPE_BYTES);
    const report = verifySignedEvidenceBytes(evidence, policy, envelope, options.evaluatedAt);
    console.log(options.json ? JSON.stringify(report) : formatSignedEvidenceVerification(report));
    return report.overallStatus === "PASS" ? 0 : 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "signed evidence verification failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode = main();
