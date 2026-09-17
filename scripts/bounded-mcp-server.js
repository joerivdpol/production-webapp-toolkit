#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod/v4";

import { validateAgentTask } from "./agent-task.js";
import { validateAgentRolePolicy, inspectAgentTaskRolePolicy } from "./agent-role-policy.js";
import { validateContractInventory } from "./contract-inventory.js";
import { validateCrossContractPolicy, inspectCrossRepositoryContracts } from "./audit-cross-repository-contracts.js";
import { validateAgentEvaluationCorpus, validateAgentEvaluationRun, evaluateAgentCorpus } from "./agent-evaluation-corpus.js";

const MAX_INPUT_BYTES = 1024 * 1024;
const MAX_DEPTH = 32;
const MAX_CONTAINER_ITEMS = 10000;

const errorSchema = z.object({ id: z.string(), detail: z.string() }).strict();
const outputSchema = z.object({
  ok: z.boolean(),
  operation: z.string(),
  result: z.unknown().nullable(),
  errors: z.array(errorSchema),
}).strict();
const toolSchemas = {
  "validate-agent-task": z.object({ task: z.unknown() }).strict(),
  "inspect-agent-role-policy": z.object({ task: z.unknown(), policy: z.unknown() }).strict(),
  "validate-contract-inventory": z.object({ inventory: z.unknown() }).strict(),
  "inspect-cross-repository-contracts": z.object({
    policy: z.unknown(),
    inventories: z.array(z.unknown()).max(64),
  }).strict(),
  "evaluate-agent-corpus": z.object({ corpus: z.unknown(), run: z.unknown() }).strict(),
};

export const BOUNDED_MCP_TOOL_NAMES = Object.freeze(Object.keys(toolSchemas).sort());

/** @param {unknown} value @param {number} [depth] */
function inspectPayloadShape(value, depth = 0) {
  if (depth > MAX_DEPTH) throw new Error("bounded MCP input exceeds maximum nesting depth");
  if (Array.isArray(value)) {
    if (value.length > MAX_CONTAINER_ITEMS) throw new Error("bounded MCP input array is too large");
    for (const item of value) inspectPayloadShape(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > MAX_CONTAINER_ITEMS) throw new Error("bounded MCP input object is too large");
    for (const [, item] of entries) inspectPayloadShape(item, depth + 1);
  }
}
/** @param {unknown} value */
function assertBoundedPayload(value) {
  inspectPayloadShape(value);
  let serialized;
  try { serialized = JSON.stringify(value); }
  catch { throw new Error("bounded MCP input must be JSON-serializable"); }
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_INPUT_BYTES) {
    throw new Error("bounded MCP input exceeds maximum byte size");
  }
}

/** @param {unknown} value */
function normalizeErrors(value) {
  if (!Array.isArray(value)) return [{ id: "validation-failed", detail: "toolkit validation failed" }];
  return value.map((item) => ({
    id: typeof item?.id === "string" ? item.id : "validation-failed",
    detail: typeof item?.detail === "string" ? item.detail : "toolkit validation failed",
  }));
}

/** @param {string} operation @param {unknown} result */
function success(operation, result) { return { ok: true, operation, result, errors: [] }; }
/** @param {string} operation @param {unknown} errors */
function failure(operation, errors) { return { ok: false, operation, result: null, errors: normalizeErrors(errors) }; }

/** @param {string} operation @param {unknown} rawArgs */
export function invokeBoundedToolkitOperation(operation, rawArgs) {
  const schema = toolSchemas[/** @type {keyof typeof toolSchemas} */ (operation)];
  if (!schema) return failure(operation, [{ id: "operation-unknown", detail: "operation is not in the bounded MCP allowlist" }]);
  try { assertBoundedPayload(rawArgs); }
  catch (error) { return failure(operation, [{ id: "input-bounds-invalid", detail: error instanceof Error ? error.message : "bounded MCP input is invalid" }]); }
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) return failure(operation, [{ id: "input-schema-invalid", detail: "operation input does not match its strict schema" }]);
  return invokeParsedOperation(operation, parsed.data);
}
/** @param {string} operation @param {any} args */
function invokeParsedOperation(operation, args) {
  if (operation === "validate-agent-task") {
    const validated = validateAgentTask(args.task);
    return validated.valid && validated.task ? success(operation, validated.task) : failure(operation, validated.errors);
  }
  if (operation === "inspect-agent-role-policy") {
    const task = validateAgentTask(args.task), policy = validateAgentRolePolicy(args.policy);
    if (!task.valid || !task.task) return failure(operation, task.errors);
    if (!policy.valid || !policy.policy) return failure(operation, policy.errors);
    return success(operation, inspectAgentTaskRolePolicy(task.task, policy.policy));
  }
  if (operation === "validate-contract-inventory") {
    const validated = validateContractInventory(args.inventory);
    return validated.ok && validated.inventory ? success(operation, validated.inventory) : failure(operation, validated.errors);
  }
  if (operation === "inspect-cross-repository-contracts") {
    const policy = validateCrossContractPolicy(args.policy);
    if (!policy.ok || !policy.policy) return failure(operation, policy.errors);
    const inventories = [];
    for (const raw of args.inventories) {
      const validated = validateContractInventory(raw);
      if (!validated.ok || !validated.inventory) return failure(operation, validated.errors);
      inventories.push(validated.inventory);
    }
    return success(operation, inspectCrossRepositoryContracts(policy.policy, inventories));
  }
  if (operation === "evaluate-agent-corpus") {
    const corpus = validateAgentEvaluationCorpus(args.corpus), run = validateAgentEvaluationRun(args.run);
    if (!corpus.valid || !corpus.corpus) return failure(operation, corpus.errors);
    if (!run.valid || !run.run) return failure(operation, run.errors);
    return success(operation, evaluateAgentCorpus(corpus.corpus, run.run));
  }
  return failure(operation, [{ id: "operation-unimplemented", detail: "operation implementation is unavailable" }]);
}
const toolMetadata = {
  "validate-agent-task": ["Validate Agent Task", "Validate one Agent Task v1 JSON object."],
  "inspect-agent-role-policy": ["Inspect Agent Role Policy", "Validate a task and role policy, then inspect their monotone authority composition."],
  "validate-contract-inventory": ["Validate Contract Inventory", "Validate one portable Contract Inventory v1 JSON object."],
  "inspect-cross-repository-contracts": ["Inspect Cross Repository Contracts", "Run the deterministic cross-repository contract audit over explicit policy and inventories."],
  "evaluate-agent-corpus": ["Evaluate Agent Corpus", "Evaluate an explicit Agent Evaluation Run against an explicit Agent Evaluation Corpus."],
};

/** @param {ReturnType<typeof invokeBoundedToolkitOperation>} result @returns {any} */
function asMcpResult(result) {
  return {
    resultType: "complete",
    isError: !result.ok,
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
  };
}

/** @param {McpServer} server @param {keyof typeof toolSchemas} name */
function registerOperation(server, name) {
  const metadata = toolMetadata[name];
  if (!metadata) throw new Error("bounded MCP tool metadata is missing");
  server.registerTool(name, /** @type {any} */ ({
    title: metadata[0],
    description: metadata[1],
    inputSchema: toolSchemas[name],
    outputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }), async (/** @type {any} */ args) => asMcpResult(invokeBoundedToolkitOperation(name, args)));
}
/** @returns {McpServer} */
export function createBoundedMcpServer() {
  const server = new McpServer(
    { name: "production-webapp-toolkit", version: "2.1.0" },
    { capabilities: { tools: {} } },
  );
  for (const name of BOUNDED_MCP_TOOL_NAMES) registerOperation(server, /** @type {keyof typeof toolSchemas} */ (name));
  return server;
}

export function startBoundedMcpStdio() {
  return serveStdio(() => createBoundedMcpServer(), {
    legacy: "serve",
    onerror: (error) => console.error(`bounded MCP transport error: ${error.message}`),
  });
}

export function main() {
  startBoundedMcpStdio();
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) main();
