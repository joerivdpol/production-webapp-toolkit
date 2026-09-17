#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** @type {Array<{ id: string, matches: (name: string) => boolean }>} */
const SENSITIVE_FILE_RULES = [
  {
    id: "dotenv",
    matches: (name) =>
      /^\.env(?:\.|$)/.test(name) &&
      !/\.(?:example|sample|template)$/.test(name),
  },
  {
    id: "private-key-file",
    matches: (name) =>
      /(?:^|\/)(?:id_rsa|id_ed25519|id_ecdsa|id_dsa)$/.test(name) ||
      /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(name),
  },
  {
    id: "credential-file",
    matches: (name) =>
      /(?:^|\/)(?:credentials|secrets?)\.(?:json|ya?ml|toml)$/i.test(name) ||
      /(?:^|\/)\.netrc$/i.test(name) ||
      /(?:^|\/)\.pypirc$/i.test(name) ||
      /(?:^|\/)\.aws\/credentials$/i.test(name) ||
      /(?:^|\/)application_default_credentials\.json$/i.test(name) ||
      /(?:^|\/)(?:service[-_]?account|serviceaccount)[^/]*\.json$/i.test(name),
  },
];

const SECRET_PATTERNS = [
  {
    id: "private-key-content",
    pattern: /-----BEGIN (?:(?:RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|-----BEGIN PGP PRIVATE KEY [B]LOCK-----/,
  },
  {
    id: "github-token",
    pattern: /\b(?:(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  },
  {
    id: "aws-access-key",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  },
  {
    id: "google-api-key",
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
  },
  {
    id: "stripe-live-secret",
    pattern: /\bsk_live_[A-Za-z0-9]{20,}\b/,
  },
  {
    id: "openai-project-key",
    pattern: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: "xendit-production-key",
    pattern: /\bxnd_production_[A-Za-z0-9]{40,}\b/,
  },
  {
    id: "sendgrid-api-key",
    pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: "npm-access-token",
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/,
  },
  {
    id: "gitlab-access-token",
    pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/,
  },
  {
    id: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/,
  },
  {
    id: "telegram-bot-token",
    pattern: /\b[0-9]{8,12}:[A-Za-z0-9_-]{30,}\b/,
  },
  {
    id: "credentialed-url",
    pattern: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^/\s"'`]+/i,
  },
];

/** @param {string} hostname */
function isReservedTestHostname(hostname) {
  const normalized = hostname.toLowerCase();

  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".test") ||
    normalized.endsWith(".example") ||
    normalized.endsWith(".invalid")
  );
}

/** @param {string} text */
function containsUnsafeCredentialedUrl(text) {
  const pattern = /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@[^/\s"'`]+/gi;

  for (const match of text.matchAll(pattern)) {
    try {
      const url = new URL(match[0]);

      if (!isReservedTestHostname(url.hostname)) {
        return true;
      }
    } catch {
      return true;
    }
  }

  return false;
}

const DEFAULT_SCAN_BYTES = 1024 * 1024;
const FRONTEND_ARTIFACT_SCAN_BYTES = 5 * 1024 * 1024;

/** @param {string} name */
function isFrontendArtifactPath(name) {
  return (
    /(?:^|\/)(?:dist|build|out|\.next\/static|\.output\/public|public\/assets|static\/(?:js|chunks)|assets)\//i.test(name) ||
    /\.map$/i.test(name)
  );
}

/** @param {string} value */
function isLikelyPlaceholder(value) {
  const trimmed = value.trim();
  const normalized = trimmed.toLowerCase();
  if (normalized.length < 12) return true;
  if (/^env\(\s*[A-Za-z_][A-Za-z0-9_]*\s*\)$/.test(trimmed)) return true;
  if (/^\$\{\s*[A-Za-z_][A-Za-z0-9_]*\s*\}$/.test(trimmed)) return true;
  if (/(?:placeholder|example|sample|dummy|fake|fixture|test[-_]?only|changeme|change[-_]?me|replace[-_]?me|redacted|not[-_]?a[-_]?secret|your[-_])/.test(normalized)) return true;
  const compact = normalized.replace(/[^a-z0-9]/g, "");
  return compact.length === 0 || new Set(compact).size <= 2;
}

/** @param {string} name */
function normalizedAssignmentName(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toUpperCase();
}

/** @param {string} name */
function isSensitiveAssignmentName(name) {
  const normalized = normalizedAssignmentName(name);
  return /(^|_)(?:SECRET|PASSWORD|PASSWD|TOKEN|AUTH_TOKEN|CREDENTIAL|CREDENTIALS|PRIVATE_KEY|SERVICE_ROLE_KEY|API_KEY|ACCESS_KEY|ADMIN_KEY|MASTER_KEY|ROOT_KEY|SIGNING_KEY)(_|$)/.test(normalized);
}

/** @param {string} name @param {string} value */
function isClearlyNonSecretMetadataAssignment(name, value) {
  const normalized = normalizedAssignmentName(name);
  const trimmed = value.trim();

  const relativeEndpoint = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~:@!$&'()*+,;=-]+)+$/;
  const interpolatedEndpoint = /^\$\{[A-Za-z_$][A-Za-z0-9_$.]*\}(?:\/[A-Za-z0-9._~:@!$&'()*+,;=-]+)+$/;
  if (
    /(?:_URL|_URI|_ENDPOINT)$/.test(normalized) &&
    (/^https?:\/\//i.test(trimmed) || relativeEndpoint.test(trimmed) || interpolatedEndpoint.test(trimmed))
  ) return true;
  if (/_PATH$/.test(normalized) && /^(?:[./~]|[A-Za-z]:[\\/])/.test(trimmed)) return true;
  if (/(?:_FILE|_FILE_NAME|_FILENAME)$/.test(normalized) && /^[A-Za-z0-9._/~-]+$/.test(trimmed)) return true;
  if (/(?:_ENVIRONMENT_KEY|_ENV_KEY|_VARIABLE|_VARIABLE_NAME|_KEY_NAME)$/.test(normalized) && /^[A-Z][A-Z0-9_]*$/.test(trimmed)) return true;

  return false;
}

/** @param {string} text */
function containsHardcodedSecretAssignment(text) {
  const patterns = [
    /\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*["'`]([^"'`\r\n]{12,})["'`]/g,
    /(?:^|[\r\n,{]\s*)["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*["'`]([^"'`\r\n#]{12,})["'`]/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[1];
      const value = match[2];
      if (
        name &&
        value &&
        isSensitiveAssignmentName(name) &&
        !isLikelyPlaceholder(value) &&
        !isClearlyNonSecretMetadataAssignment(name, value)
      ) return true;
    }
  }
  return false;
}

/** @param {string} text */
function containsPackageRegistryCredential(text) {
  const npmAuth = /(?:^|\n)\s*(?:(?:\/\/[^\s:]+\/)?:)?_(?:authToken|auth)\s*=\s*([^\s#]{12,})/gim;
  for (const match of text.matchAll(npmAuth)) {
    if (match[1] && !isLikelyPlaceholder(match[1])) return true;
  }
  return false;
}

/** @param {string} text */
function containsDockerRegistryAuth(text) {
  const pattern = /["']auth["']\s*:\s*["']([A-Za-z0-9+/=]{16,})["']/g;
  for (const match of text.matchAll(pattern)) {
    if (match[1] && !isLikelyPlaceholder(match[1])) return true;
  }
  return false;
}

/** @param {string} text */
function containsCiSecretLeak(text) {
  const secretExpression = /\$\{\{\s*secrets(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])\s*\}\}/i;
  if (/\btoJson\s*\(\s*secrets\s*\)/i.test(text)) return true;

  for (const line of text.split(/\r?\n/)) {
    if (/::add-mask::/i.test(line)) continue;
    if (/\b(?:echo|printf|printenv)\b/i.test(line) && secretExpression.test(line)) return true;
  }

  const mappedSecretNames = new Set();
  for (const match of text.matchAll(/^\s*([A-Z][A-Z0-9_]*)\s*:\s*(\$\{\{\s*secrets(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[^\]]+\])\s*\}\})\s*$/gim)) {
    if (match[1]) mappedSecretNames.add(match[1]);
  }
  for (const name of mappedSecretNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const outputPattern = new RegExp(`\\b(?:echo|printf|printenv)\\b[^\\r\\n]*(?:\\$\\{?${escaped}\\}?|\\b${escaped}\\b)`, "i");
    if (outputPattern.test(text)) return true;
  }
  if (mappedSecretNames.size > 0 && /^\s*(?:-\s*)?run\s*:\s*(?:env|printenv)\s*$/im.test(text)) return true;
  if (secretExpression.test(text) && /(?:^|\n)\s*(?:run\s*:\s*)?(?:\|\s*)?set\s+-[A-Za-z]*x[A-Za-z]*\b/m.test(text)) return true;
  return false;
}

/** @param {string} root */
function trackedFiles(root) {
  const output = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z"],
    { encoding: "utf8" },
  );

  return output.split("\0").filter(Boolean);
}

/** @param {string} absolutePath @param {number} maxBytes */
function readScannableText(absolutePath, maxBytes = DEFAULT_SCAN_BYTES) {
  const stat = fs.lstatSync(absolutePath);

  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
    return null;
  }

  const buffer = fs.readFileSync(absolutePath);

  if (buffer.includes(0)) {
    return null;
  }

  return buffer.toString("utf8");
}

/** @param {string} target */
export function inspectPublicRepoSafety(target) {
  const root = resolve(target);

  /** @type {Array<{ rule: string, path: string }>} */
  const findings = [];

  const tracked = trackedFiles(root);

  for (const relativePath of tracked) {
    const normalized = relativePath.replaceAll("\\", "/");

    for (const rule of SENSITIVE_FILE_RULES) {
      if (rule.matches(normalized)) {
        findings.push({
          rule: rule.id,
          path: normalized,
        });
      }
    }

    const absolutePath = path.join(root, relativePath);
    let text = null;
    try {
      text = readScannableText(
        absolutePath,
        isFrontendArtifactPath(normalized) ? FRONTEND_ARTIFACT_SCAN_BYTES : DEFAULT_SCAN_BYTES,
      );
    } catch {
      continue;
    }

    if (text === null) continue;

    for (const rule of SECRET_PATTERNS) {
      const matched =
        rule.id === "credentialed-url"
          ? containsUnsafeCredentialedUrl(text)
          : rule.pattern.test(text);

      if (matched) {
        findings.push({
          rule: rule.id,
          path: normalized,
        });
      }
    }

    if (containsHardcodedSecretAssignment(text)) {
      findings.push({
        rule: isFrontendArtifactPath(normalized)
          ? "frontend-bundle-secret-assignment"
          : "hardcoded-secret-assignment",
        path: normalized,
      });
    }

    if (containsPackageRegistryCredential(text)) {
      findings.push({ rule: "package-registry-credential", path: normalized });
    }

    if (/(?:^|\/)\.docker\/config\.json$/i.test(normalized) && containsDockerRegistryAuth(text)) {
      findings.push({ rule: "docker-registry-credential", path: normalized });
    }

    if (/^\.github\/workflows\/[^/]+\.ya?ml$/i.test(normalized) && containsCiSecretLeak(text)) {
      findings.push({ rule: "ci-secret-output", path: normalized });
    }
  }

  return {
    root,
    scannedFiles: tracked.length,
    findings,
    passed: findings.length === 0,
  };
}

/** @param {ReturnType<typeof inspectPublicRepoSafety>} report */
export function formatPublicRepoSafety(report) {
  const lines = [
    `Public repository safety audit: ${report.root}`,
    "",
  ];

  if (report.findings.length === 0) {
    lines.push("PASS  No tracked sensitive files or secret-like values detected.");
  } else {
    for (const finding of report.findings) {
      lines.push(`FAIL  ${finding.rule}  ${finding.path}`);
    }
  }

  lines.push(
    "",
    `Tracked files scanned: ${report.scannedFiles}`,
    report.passed
      ? "Result: PASS"
      : "Result: FAIL — review findings before pushing to a public repository.",
  );

  return lines.join("\n");
}

export function main(argv = process.argv.slice(2)) {
  const json = argv.includes("--json");
  const positional = argv.filter((argument) => argument !== "--json");
  const target = positional[0] ?? process.cwd();

  const report = inspectPublicRepoSafety(target);

  console.log(
    json
      ? JSON.stringify(report)
      : formatPublicRepoSafety(report),
  );

  return report.passed ? 0 : 1;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
