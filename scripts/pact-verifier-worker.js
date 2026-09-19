#!/usr/bin/env node

// Internal one-shot worker. No broker, filters, state hooks, selectors or
// caller-provided module/command loading. Parent enforces timeout/output caps.
import fs from "node:fs";
import { createRequire } from "node:module";
import { isPactLoopbackUrl, PACT_INTEGRATION_VERSION } from "./pact-contract-integration.js";

const chunks = [];
let size = 0;
try {
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 16384) throw new Error("input exceeds worker limits");
    chunks.push(chunk);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!input || Object.keys(input).sort().join(",") !== "baseUrl,commit,files,provider,timeoutMs"
      || !isPactLoopbackUrl(input.baseUrl)
      || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commit)
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(input.provider)
      || !Number.isInteger(input.timeoutMs) || input.timeoutMs < 1000 || input.timeoutMs > 30000
      || !Array.isArray(input.files) || input.files.length < 1 || input.files.length > 16
      || !input.files.every((/** @type {unknown} */ value) => typeof value === "string" && value.length < 1024 && fs.lstatSync(value).isFile() && fs.realpathSync(value) === value)) {
    throw new Error("invalid worker input");
  }
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(require.resolve("@pact-foundation/pact/package.json"), "utf8"));
  if (manifest.version !== PACT_INTEGRATION_VERSION) throw new Error("Pact runtime version mismatch");
  const { Verifier } = await import("@pact-foundation/pact");
  try {
    await new Verifier({
      provider: input.provider, providerVersion: input.commit,
      providerBaseUrl: input.baseUrl, pactUrls: input.files,
      publishVerificationResult: false, enablePending: false,
      timeout: input.timeoutMs, logLevel: "error",
    }).verifyProvider();
    process.exitCode = 0;
  } catch { process.exitCode = 1; }
} catch { process.exitCode = 2; }
