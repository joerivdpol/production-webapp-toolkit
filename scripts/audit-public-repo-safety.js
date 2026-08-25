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
      /(?:^|\/)(?:id_rsa|id_ed25519)$/.test(name) ||
      /\.(?:pem|key|p12|pfx)$/i.test(name),
  },
  {
    id: "credential-file",
    matches: (name) =>
      /(?:^|\/)(?:credentials|secrets?)\.(?:json|ya?ml|toml)$/i.test(name),
  },
];

const SECRET_PATTERNS = [
  {
    id: "private-key-content",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  },
  {
    id: "github-token",
    pattern: /\b(?:ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})\b/,
  },
  {
    id: "aws-access-key",
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
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

/** @param {string} root */
function trackedFiles(root) {
  const output = execFileSync(
    "git",
    ["-C", root, "ls-files", "-z"],
    { encoding: "utf8" },
  );

  return output.split("\0").filter(Boolean);
}

/** @param {string} absolutePath */
function readScannableText(absolutePath) {
  const stat = fs.statSync(absolutePath);

  if (!stat.isFile() || stat.size > 1024 * 1024) {
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

  for (const relativePath of trackedFiles(root)) {
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
    const text = readScannableText(absolutePath);

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
  }

  return {
    root,
    scannedFiles: trackedFiles(root).length,
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
