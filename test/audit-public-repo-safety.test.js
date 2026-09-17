import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  inspectPublicRepoSafety,
  formatPublicRepoSafety,
} from "../scripts/audit-public-repo-safety.js";

function createGitRepository() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "public-safety-"));

  execFileSync("git", ["init", root], { stdio: "ignore" });
  execFileSync(
    "git",
    ["-C", root, "config", "user.email", "test@example.invalid"],
    { stdio: "ignore" },
  );
  execFileSync(
    "git",
    ["-C", root, "config", "user.name", "Toolkit Test"],
    { stdio: "ignore" },
  );

  return root;
}

/**
 * @param {string} root
 * @param {string} relativePath
 * @param {string} content
 */
function track(root, relativePath, content) {
  const absolutePath = path.join(root, relativePath);

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, content);

  execFileSync("git", ["-C", root, "add", relativePath], {
    stdio: "ignore",
  });
}

test("allows credential fixtures on reserved local test origins", () => {
  const root = createGitRepository();

  track(
    root,
    "test/example.test.js",
    'const target = "http://user:password@localhost:4173/test";\n',
  );

  const report = inspectPublicRepoSafety(root);

  assert.equal(report.passed, true);
  assert.deepEqual(report.findings, []);
});

test("blocks credentialed URLs to public hosts without exposing credentials", () => {
  const root = createGitRepository();

  const fakeUsername = ["public", "user"].join("-");
  const fakePassword = ["super", "secret", "value"].join("-");
  const credentialedUrl = [
    "https://",
    fakeUsername,
    ":",
    fakePassword,
    "@",
    "example.com/api",
  ].join("");

  track(
    root,
    "config/example.js",
    `const target = ${JSON.stringify(credentialedUrl)};
`,
  );

  const report = inspectPublicRepoSafety(root);

  assert.equal(report.passed, false);

  assert.deepEqual(report.findings, [
    {
      rule: "credentialed-url",
      path: "config/example.js",
    },
  ]);

  const formatted = formatPublicRepoSafety(report);

  assert.equal(formatted.includes(fakePassword), false);
  assert.equal(formatted.includes(fakeUsername), false);
});

test("blocks tracked dotenv files but permits example templates", () => {
  const root = createGitRepository();

  track(root, ".env", "SOME_VALUE=example\n");
  track(root, ".env.example", "SOME_VALUE=\n");

  const report = inspectPublicRepoSafety(root);

  assert.equal(report.passed, false);
  assert.deepEqual(report.findings, [
    {
      rule: "dotenv",
      path: ".env",
    },
  ]);
});

test("blocks private key material without printing the key content", () => {
  const root = createGitRepository();

  track(
    root,
    "fixtures/key.txt",
    [
      "-----BEGIN " + "PRIVATE KEY-----",
      "DO-NOT-PRINT-" + "THIS-TEST-SECRET",
      "-----END " + "PRIVATE KEY-----",
      "",
    ].join("\n"),
  );

  const report = inspectPublicRepoSafety(root);

  assert.equal(report.passed, false);

  assert.deepEqual(report.findings, [
    {
      rule: "private-key-content",
      path: "fixtures/key.txt",
    },
  ]);

  assert.doesNotMatch(
    formatPublicRepoSafety(report),
    new RegExp(["DO-NOT-PRINT", "THIS-TEST-SECRET"].join("-")),
  );
});

test("blocks additional private key files and private key formats", () => {
  const fileRoot = createGitRepository();
  track(fileRoot, "keys/id_ecdsa", "synthetic fixture\n");
  track(fileRoot, "keys/signing.jks", "synthetic binary-looking fixture\n");
  const fileReport = inspectPublicRepoSafety(fileRoot);
  assert.equal(fileReport.passed, false);
  assert.deepEqual(fileReport.findings.map((item) => item.rule), [
    "private-key-file",
    "private-key-file",
  ]);

  const contentRoot = createGitRepository();
  const pgpHeader = ["-----BEGIN PGP PRIVATE KEY ", "BLOCK-----"].join("");
  track(contentRoot, "fixtures/key.txt", `${pgpHeader}\nfixture-only\n`);
  const contentReport = inspectPublicRepoSafety(contentRoot);
  assert.equal(contentReport.passed, false);
  assert.deepEqual(contentReport.findings, [
    { rule: "private-key-content", path: "fixtures/key.txt" },
  ]);
});

test("blocks high-confidence provider credentials without reporting their values", () => {
  const cases = [
    ["github-token", ["ghp", "_", "A".repeat(36)].join("")],
    ["aws-access-key", ["ASIA", "B".repeat(16)].join("")],
    ["google-api-key", ["AIza", "C".repeat(35)].join("")],
    ["stripe-live-secret", ["sk", "_live_", "D".repeat(28)].join("")],
    ["openai-project-key", ["sk", "-proj-", "E".repeat(28)].join("")],
    ["xendit-production-key", ["xnd", "_production_", "F".repeat(48)].join("")],
    ["sendgrid-api-key", ["SG", ".", "G".repeat(18), ".", "H".repeat(24)].join("")],
    ["npm-access-token", ["npm", "_", "I".repeat(36)].join("")],
    ["gitlab-access-token", ["glpat", "-", "J".repeat(24)].join("")],
  ];

  for (const [rule, credential] of cases) {
    const root = createGitRepository();
    track(root, "config/provider.txt", `credential=${credential}\n`);
    const report = inspectPublicRepoSafety(root);
    assert.ok(report.findings.some((item) => item.rule === rule), String(rule));
    assert.equal(formatPublicRepoSafety(report).includes(String(credential)), false);
  }
});

test("blocks generic hardcoded sensitive assignments but permits clear placeholders", () => {
  const root = createGitRepository();
  const sensitiveName = ["PAYMENT", "SECRET"].join("_");
  const sensitiveValue = ["live", "credential", "material", "987654321"].join("-");
  track(root, "src/config.js", `const ${sensitiveName} = ${JSON.stringify(sensitiveValue)};\n`);
  const report = inspectPublicRepoSafety(root);
  assert.ok(report.findings.some((item) => item.rule === "hardcoded-secret-assignment"));
  assert.equal(formatPublicRepoSafety(report).includes(sensitiveValue), false);

  const placeholderRoot = createGitRepository();
  const placeholder = ["replace", "me", "before", "deployment"].join("-");
  track(placeholderRoot, "src/config.js", `const ${sensitiveName} = ${JSON.stringify(placeholder)};\n`);
  assert.equal(inspectPublicRepoSafety(placeholderRoot).passed, true);
});

test("permits explicit environment indirection and clearly typed secret metadata", () => {
  const root = createGitRepository();

  track(
    root,
    "src/config.js",
    [
      'const OPENAI_API_KEY = "env(OPENAI_API_KEY)";',
      'const SERVICE_ROLE_KEY = "${SUPABASE_SERVICE_ROLE_KEY}";',
      'const TOKEN_URL = "https://provider.example.invalid/oauth/token";',
      'const REFRESH_TOKEN_ENDPOINT = "oauth/v2/refresh-token";',
      'const INTERPOLATED_TOKEN_URL = "${PROVIDER_ORIGIN}/oauth/token";',
      'const CREDENTIAL_PATH = "/run/secrets/provider-credential";',
      'const CREDENTIAL_FILE_NAME = "provider-credential.json";',
      'const CREDENTIAL_PATH_ENVIRONMENT_KEY = "PROVIDER_CREDENTIAL_PATH";',
      "",
    ].join("\n"),
  );

  assert.equal(inspectPublicRepoSafety(root).passed, true);
});

test("does not let metadata names suppress an actual hardcoded secret", () => {
  const root = createGitRepository();
  const value = ["live", "credential", "material", "987654321"].join("-");

  track(root, "src/config.js", `const PAYMENT_SECRET = ${JSON.stringify(value)};\n`);

  const report = inspectPublicRepoSafety(root);
  assert.ok(report.findings.some((item) => item.rule === "hardcoded-secret-assignment"));
  assert.equal(formatPublicRepoSafety(report).includes(value), false);
});

test("blocks registry credentials in npm and Docker configuration", () => {
  const npmRoot = createGitRepository();
  const npmToken = ["registry", "credential", "1234567890"].join("-");
  track(npmRoot, ".npmrc", `//registry.npmjs.org/:_authToken=${npmToken}\n`);
  const npmReport = inspectPublicRepoSafety(npmRoot);
  assert.ok(npmReport.findings.some((item) => item.rule === "package-registry-credential"));

  const dockerRoot = createGitRepository();
  const dockerAuth = Buffer.from("synthetic-user:synthetic-password-material").toString("base64");
  track(dockerRoot, ".docker/config.json", JSON.stringify({ auths: { "registry.example.invalid": { auth: dockerAuth } } }));
  const dockerReport = inspectPublicRepoSafety(dockerRoot);
  assert.ok(dockerReport.findings.some((item) => item.rule === "docker-registry-credential"));
  assert.equal(formatPublicRepoSafety(dockerReport).includes(dockerAuth), false);
});

test("blocks known credential file locations", () => {
  const root = createGitRepository();
  for (const filename of [
    ".netrc",
    ".pypirc",
    ".aws/credentials",
    "config/application_default_credentials.json",
    "config/service-account-production.json",
  ]) track(root, filename, "synthetic fixture\n");
  const report = inspectPublicRepoSafety(root);
  assert.equal(report.findings.filter((item) => item.rule === "credential-file").length, 5);
});

test("scans bounded frontend artifacts beyond the normal source scan limit", () => {
  const root = createGitRepository();
  const sensitiveName = ["CLIENT", "SECRET"].join("_");
  const sensitiveValue = ["bundled", "credential", "9876543210"].join("-");
  const padding = "x".repeat(1024 * 1024 + 128);
  track(
    root,
    "dist/assets/app.js",
    `${padding}\nconst ${sensitiveName}=${JSON.stringify(sensitiveValue)};\n`,
  );
  const report = inspectPublicRepoSafety(root);
  assert.ok(report.findings.some((item) => item.rule === "frontend-bundle-secret-assignment"));
  assert.equal(formatPublicRepoSafety(report).includes(sensitiveValue), false);
});

test("does not follow tracked symlinks outside the repository", () => {
  const root = createGitRepository();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "public-safety-outside-"));
  const credential = ["ghp", "_", "K".repeat(36)].join("");
  const outsideFile = path.join(outside, "outside.txt");
  fs.writeFileSync(outsideFile, credential);
  fs.symlinkSync(outsideFile, path.join(root, "linked.txt"));
  execFileSync("git", ["-C", root, "add", "linked.txt"], { stdio: "ignore" });
  try {
    const report = inspectPublicRepoSafety(root);
    assert.equal(report.passed, true);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("blocks direct GitHub Actions secret output but permits normal secret injection", () => {
  const leakRoot = createGitRepository();
  track(
    leakRoot,
    ".github/workflows/ci.yml",
    [
      "jobs:",
      "  test:",
      "    steps:",
      "      - run: echo \"${{ secrets.PRODUCTION_TOKEN }}\"",
      "",
    ].join("\n"),
  );
  const leak = inspectPublicRepoSafety(leakRoot);
  assert.ok(leak.findings.some((item) => item.rule === "ci-secret-output"));

  const safeRoot = createGitRepository();
  track(
    safeRoot,
    ".github/workflows/ci.yml",
    [
      "jobs:",
      "  test:",
      "    env:",
      "      API_TOKEN: ${{ secrets.PRODUCTION_TOKEN }}",
      "    steps:",
      "      - run: node scripts/test.js",
      "",
    ].join("\n"),
  );
  assert.equal(inspectPublicRepoSafety(safeRoot).passed, true);
});

test("blocks mapped-secret output, whole secret JSON output, and shell tracing", () => {
  const workflows = [
    [
      "env:",
      "  DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}",
      "steps:",
      "  - run: echo $DEPLOY_TOKEN",
    ].join("\n"),
    [
      "env:",
      "  DEPLOY_TOKEN: ${{ secrets.DEPLOY_TOKEN }}",
      "steps:",
      "  - run: printenv",
    ].join("\n"),
    [
      "steps:",
      "  - run: echo '${{ toJson(secrets) }}'",
    ].join("\n"),
    [
      "steps:",
      "  - run: |",
      "      set -x",
      "      curl -H 'Authorization: ${{ secrets.DEPLOY_TOKEN }}' https://example.invalid",
    ].join("\n"),
  ];

  for (const [index, workflow] of workflows.entries()) {
    const root = createGitRepository();
    track(root, `.github/workflows/leak-${index}.yml`, `${workflow}\n`);
    const report = inspectPublicRepoSafety(root);
    assert.ok(report.findings.some((item) => item.rule === "ci-secret-output"), String(index));
  }
});

test("permits GitHub add-mask output for an explicitly masked secret", () => {
  const root = createGitRepository();
  track(
    root,
    ".github/workflows/mask.yml",
    [
      "steps:",
      "  - run: echo '::add-mask::${{ secrets.DEPLOY_TOKEN }}'",
      "",
    ].join("\n"),
  );
  assert.equal(inspectPublicRepoSafety(root).passed, true);
});
