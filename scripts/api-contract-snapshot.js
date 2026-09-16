#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const PARAMETER_LOCATIONS = new Set(["path", "query", "header"]);
const PRIMITIVE_TYPES = new Set(["string", "number", "integer", "boolean"]);

/** @typedef {{ type: string, nullable: boolean, enum?: Array<string|number|boolean>, properties?: Record<string, ApiSchema>, required?: string[], additionalProperties?: boolean, items?: ApiSchema }} ApiSchema */
/** @typedef {{ name: string, in: "path"|"query"|"header", required: boolean, schema: ApiSchema }} ApiParameter */
/** @typedef {{ method: string, path: string, parameters: ApiParameter[], body: null | { required: boolean, mediaType: string, schema: ApiSchema }, responses: Array<{ status: string, mediaType: string, schema: ApiSchema | null }> }} ApiOperation */
/** @typedef {{ version: 1, kind: "baseline"|"candidate", service: { name: string }, evidence: { source: string, authenticated: boolean, collectedAt: string }, operations: ApiOperation[] }} ApiContractSnapshot */
/** @typedef {{ id: string, detail: string }} ContractError */

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {Record<string, unknown>} value @param {string[]} allowed @param {string} scope @param {ContractError[]} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
  }
}

/** @param {unknown} value @param {string} scope @param {ContractError[]} errors @param {number} [depth] @returns {ApiSchema | null} */
function normalizeSchema(value, scope, errors, depth = 0) {
  if (depth > 16) { errors.push({ id: "schema-depth-exceeded", detail: `${scope} exceeds maximum schema nesting depth` }); return null; }
  if (!isPlainObject(value)) {
    errors.push({ id: "schema-invalid", detail: `${scope} must be an object` });
    return null;
  }
  rejectUnknown(value, ["type", "nullable", "enum", "properties", "required", "additionalProperties", "items"], "schema", errors);
  const type = nonEmptyString(value.type)?.toLowerCase() ?? null;
  if (!type || (!PRIMITIVE_TYPES.has(type) && type !== "object" && type !== "array")) {
    errors.push({ id: "schema-type-invalid", detail: `${scope}.type is unsupported` });
    return null;
  }
  const nullable = value.nullable === undefined ? false : value.nullable;
  if (typeof nullable !== "boolean") errors.push({ id: "schema-nullable-invalid", detail: `${scope}.nullable must be boolean` });

  let enumValues;
  if (value.enum !== undefined) {
    if (!Array.isArray(value.enum) || value.enum.length === 0) {
      errors.push({ id: "schema-enum-invalid", detail: `${scope}.enum must be a non-empty array` });
    } else {
      const valid = value.enum.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
      const keys = value.enum.map((item) => `${typeof item}:${String(item)}`);
      if (!valid || new Set(keys).size !== keys.length) errors.push({ id: "schema-enum-invalid", detail: `${scope}.enum must contain unique scalar values` });
      else enumValues = [...value.enum].sort((a, b) => String(a).localeCompare(String(b)));
    }
  }

  if (PRIMITIVE_TYPES.has(type)) {
    if (value.properties !== undefined || value.required !== undefined || value.additionalProperties !== undefined || value.items !== undefined) {
      errors.push({ id: "schema-shape-invalid", detail: `${scope} primitive schema contains object or array fields` });
    }
    return typeof nullable === "boolean" ? { type, nullable, ...(enumValues ? { enum: enumValues } : {}) } : null;
  }

  if (enumValues) errors.push({ id: "schema-enum-invalid", detail: `${scope}.enum is supported only for primitive schemas` });

  if (type === "object") {
    if (!isPlainObject(value.properties) || typeof value.additionalProperties !== "boolean" || value.items !== undefined) {
      errors.push({ id: "schema-object-invalid", detail: `${scope} object schema requires properties and boolean additionalProperties` });
      return null;
    }
    const propertyNames = Object.keys(value.properties);
    if (propertyNames.some((name) => !name.trim())) errors.push({ id: "schema-property-name-invalid", detail: `${scope}.properties names must be non-empty` });
    const requiredRaw = value.required === undefined ? [] : value.required;
    if (!Array.isArray(requiredRaw) || requiredRaw.some((item) => !nonEmptyString(item))) {
      errors.push({ id: "schema-required-invalid", detail: `${scope}.required must be an array of non-empty property names` });
      return null;
    }
    const required = requiredRaw.map((item) => /** @type {string} */ (nonEmptyString(item)));
    if (new Set(required).size !== required.length || required.some((name) => !propertyNames.includes(name))) {
      errors.push({ id: "schema-required-invalid", detail: `${scope}.required must be unique and reference declared properties` });
      return null;
    }
    /** @type {Record<string, ApiSchema>} */
    const properties = {};
    for (const name of propertyNames.sort()) {
      const normalized = normalizeSchema(value.properties[name], `${scope}.properties.${name}`, errors, depth + 1);
      if (normalized) properties[name] = normalized;
    }
    return typeof nullable === "boolean" ? { type, nullable, properties, required: required.sort(), additionalProperties: value.additionalProperties } : null;
  }

  if (value.properties !== undefined || value.required !== undefined || value.additionalProperties !== undefined || value.items === undefined) {
    errors.push({ id: "schema-array-invalid", detail: `${scope} array schema requires items and no object fields` });
    return null;
  }
  const items = normalizeSchema(value.items, `${scope}.items`, errors, depth + 1);
  return items && typeof nullable === "boolean" ? { type: "array", nullable, items } : null;
}

/** @param {unknown} value @param {string} scope @param {ContractError[]} errors */
function normalizeParameters(value, scope, errors) {
  if (!Array.isArray(value)) {
    errors.push({ id: "parameters-invalid", detail: `${scope} must be an array` });
    return [];
  }
  /** @type {ApiParameter[]} */
  const parameters = [];
  const seen = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) { errors.push({ id: "parameter-invalid", detail: `${scope}[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["name", "in", "required", "schema"], "parameter", errors);
    const name = nonEmptyString(raw.name);
    const location = nonEmptyString(raw.in)?.toLowerCase() ?? null;
    if (!name || !location || !PARAMETER_LOCATIONS.has(location) || typeof raw.required !== "boolean") {
      errors.push({ id: "parameter-fields-invalid", detail: `${scope}[${index}] has invalid name, location, or required flag` });
      continue;
    }
    if (location === "path" && raw.required !== true) errors.push({ id: "path-parameter-required", detail: `${scope}[${index}] path parameters must be required` });
    const key = `${location}:${name.toLowerCase()}`;
    if (seen.has(key)) { errors.push({ id: "parameter-duplicate", detail: `${scope} contains duplicate parameter ${location}:${name}` }); continue; }
    seen.add(key);
    const schema = normalizeSchema(raw.schema, `${scope}[${index}].schema`, errors);
    if (schema) parameters.push({ name, in: /** @type {ApiParameter["in"]} */ (location), required: raw.required, schema });
  }
  return parameters.sort((a, b) => `${a.in}:${a.name.toLowerCase()}`.localeCompare(`${b.in}:${b.name.toLowerCase()}`));
}

/** @param {unknown} value @param {string} scope @param {ContractError[]} errors */
function normalizeBody(value, scope, errors) {
  if (value === null) return null;
  if (!isPlainObject(value)) { errors.push({ id: "body-invalid", detail: `${scope} must be null or an object` }); return null; }
  rejectUnknown(value, ["required", "mediaType", "schema"], "body", errors);
  const mediaType = nonEmptyString(value.mediaType)?.toLowerCase() ?? null;
  if (typeof value.required !== "boolean" || !mediaType) {
    errors.push({ id: "body-fields-invalid", detail: `${scope} requires boolean required and mediaType` });
    return null;
  }
  const schema = normalizeSchema(value.schema, `${scope}.schema`, errors);
  return schema ? { required: value.required, mediaType, schema } : null;
}

/** @param {unknown} value @param {string} scope @param {ContractError[]} errors */
function normalizeResponses(value, scope, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ id: "responses-invalid", detail: `${scope} must be a non-empty array` });
    return [];
  }
  const responses = [];
  const seen = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) { errors.push({ id: "response-invalid", detail: `${scope}[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["status", "mediaType", "schema"], "response", errors);
    const status = nonEmptyString(raw.status)?.toUpperCase() ?? null;
    const mediaType = nonEmptyString(raw.mediaType)?.toLowerCase() ?? null;
    if (!status || !/^(?:[1-5][0-9][0-9]|DEFAULT)$/.test(status) || !mediaType) {
      errors.push({ id: "response-fields-invalid", detail: `${scope}[${index}] has invalid status or mediaType` });
      continue;
    }
    const key = `${status}:${mediaType}`;
    if (seen.has(key)) { errors.push({ id: "response-duplicate", detail: `${scope} contains duplicate response ${key}` }); continue; }
    seen.add(key);
    let schema = null;
    if (raw.schema !== null) schema = normalizeSchema(raw.schema, `${scope}[${index}].schema`, errors);
    if (raw.schema === null || schema) responses.push({ status, mediaType, schema });
  }
  return responses.sort((a, b) => `${a.status}:${a.mediaType}`.localeCompare(`${b.status}:${b.mediaType}`));
}

/** @param {unknown} value @param {ContractError[]} errors */
function normalizeOperations(value, errors) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push({ id: "operations-invalid", detail: "operations must be a non-empty array" });
    return [];
  }
  /** @type {ApiOperation[]} */
  const operations = [];
  const seen = new Set();
  for (const [index, raw] of value.entries()) {
    if (!isPlainObject(raw)) { errors.push({ id: "operation-invalid", detail: `operations[${index}] must be an object` }); continue; }
    rejectUnknown(raw, ["method", "path", "parameters", "body", "responses"], "operation", errors);
    const method = nonEmptyString(raw.method)?.toUpperCase() ?? null;
    const operationPath = nonEmptyString(raw.path);
    if (!method || !METHODS.has(method) || !operationPath || !operationPath.startsWith("/")) {
      errors.push({ id: "operation-fields-invalid", detail: `operations[${index}] has invalid method or path` });
      continue;
    }
    const key = `${method} ${operationPath}`;
    if (seen.has(key)) { errors.push({ id: "operation-duplicate", detail: `operations contains duplicate ${key}` }); continue; }
    seen.add(key);
    const parameters = normalizeParameters(raw.parameters, `operations[${index}].parameters`, errors);
    const placeholderMatches = [...operationPath.matchAll(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g)];
    const strippedPath = operationPath.replace(/\{[A-Za-z_][A-Za-z0-9_]*\}/g, "");
    const placeholders = /** @type {string[]} */ (placeholderMatches.map((match) => match[1]).filter((name) => typeof name === "string"));
    const pathParameters = parameters.filter((parameter) => parameter.in === "path").map((parameter) => parameter.name);
    if (strippedPath.includes("{") || strippedPath.includes("}") || new Set(placeholders).size !== placeholders.length ||
        placeholders.length !== pathParameters.length || placeholders.some((name) => !pathParameters.includes(name))) {
      errors.push({ id: "path-parameters-mismatch", detail: `operations[${index}] path placeholders must exactly match path parameters` });
    }
    const body = normalizeBody(raw.body, `operations[${index}].body`, errors);
    const responses = normalizeResponses(raw.responses, `operations[${index}].responses`, errors);
    operations.push({ method, path: operationPath, parameters, body, responses });
  }
  return operations.sort((a, b) => `${a.path}:${a.method}`.localeCompare(`${b.path}:${b.method}`));
}

/** @param {unknown} value */
export function validateApiContractSnapshot(value) {
  /** @type {ContractError[]} */
  const errors = [];
  if (!isPlainObject(value)) return { ok: false, snapshot: null, errors: [{ id: "snapshot-invalid", detail: "API contract snapshot must be an object" }] };
  rejectUnknown(value, ["version", "kind", "service", "evidence", "operations"], "snapshot", errors);
  if (value.version !== 1) errors.push({ id: "version-invalid", detail: "version must be exactly 1" });
  if (value.kind !== "baseline" && value.kind !== "candidate") errors.push({ id: "kind-invalid", detail: "kind must be baseline or candidate" });

  let service = null;
  if (!isPlainObject(value.service)) errors.push({ id: "service-invalid", detail: "service must be an object" });
  else {
    rejectUnknown(value.service, ["name"], "service", errors);
    const name = nonEmptyString(value.service.name);
    if (!name) errors.push({ id: "service-name-invalid", detail: "service.name must be non-empty" });
    else service = { name };
  }

  let evidence = null;
  if (!isPlainObject(value.evidence)) errors.push({ id: "evidence-invalid", detail: "evidence must be an object" });
  else {
    rejectUnknown(value.evidence, ["source", "authenticated", "collectedAt"], "evidence", errors);
    const source = nonEmptyString(value.evidence.source);
    const collectedAt = nonEmptyString(value.evidence.collectedAt);
    if (!source) errors.push({ id: "evidence-source-invalid", detail: "evidence.source must be non-empty" });
    if (typeof value.evidence.authenticated !== "boolean") errors.push({ id: "evidence-authenticated-invalid", detail: "evidence.authenticated must be boolean" });
    if (!collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) errors.push({ id: "evidence-collected-at-invalid", detail: "evidence.collectedAt must be an absolute ISO timestamp" });
    if (source && typeof value.evidence.authenticated === "boolean" && collectedAt && isAbsoluteIsoTimestamp(collectedAt)) {
      evidence = { source, authenticated: value.evidence.authenticated, collectedAt };
    }
  }

  const operations = normalizeOperations(value.operations, errors);
  if (errors.length > 0 || service === null || evidence === null || (value.kind !== "baseline" && value.kind !== "candidate")) {
    return { ok: false, snapshot: null, errors };
  }
  return {
    ok: true,
    snapshot: /** @type {ApiContractSnapshot} */ ({
      version: 1,
      kind: value.kind,
      service,
      evidence,
      operations,
    }),
    errors: [],
  };
}

/** @param {ApiContractSnapshot} snapshot */
export function formatApiContractSnapshot(snapshot) {
  return [
    "API Contract Snapshot v1",
    "",
    `Kind: ${snapshot.kind}`,
    `Service: ${snapshot.service.name}`,
    `Operations: ${snapshot.operations.length}`,
    `Source: ${snapshot.evidence.source}`,
    `Authenticated: ${snapshot.evidence.authenticated}`,
    `Collected at: ${snapshot.evidence.collectedAt}`,
    "Result: VALID",
  ].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let file = null;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument !== "--file" || file !== null) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    file = value;
    index += 1;
  }
  return file === null ? null : { file, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/api-contract-snapshot.js --file <api-contract.json> [--json]");
    return 1;
  }
  let value;
  try { value = JSON.parse(fs.readFileSync(options.file, "utf8")); }
  catch { console.error("API contract snapshot file cannot be read or parsed"); return 1; }
  const result = validateApiContractSnapshot(value);
  if (!result.ok || result.snapshot === null) {
    console.error("API contract snapshot is invalid");
    return 1;
  }
  console.log(options.json ? JSON.stringify(result.snapshot) : formatApiContractSnapshot(result.snapshot));
  return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
