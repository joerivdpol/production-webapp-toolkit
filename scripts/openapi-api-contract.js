#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateApiContractSnapshot } from "./api-contract-snapshot.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options", "trace", "query"];
const ANNOTATION_KEYS = new Set(["title", "description", "example", "examples", "deprecated"]);
const CORE_SCHEMA_KEYS = new Set(["$ref", "type", "nullable", "enum", "properties", "required", "additionalProperties", "items"]);
const NO_BODY_MEDIA_TYPE = "none";

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** @param {unknown} value */
function openApiVersion(value) {
  if (typeof value !== "string") return null;
  const match = /^3\.(0|1|2)\.(\d+)$/.exec(value.trim());
  return match ? { text: value.trim(), minor: Number(match[1]) } : null;
}

/** @param {string} reference */
function componentNameFromRef(reference) {
  const prefix = "#/components/schemas/";
  if (!reference.startsWith(prefix)) return null;
  const name = reference.slice(prefix.length);
  return name && !name.includes("/") && !name.includes("~") ? name : null;
}

/** @param {Record<string, unknown>} schema */
function unsupportedSchemaKey(schema) {
  for (const key of Object.keys(schema)) {
    if (CORE_SCHEMA_KEYS.has(key) || ANNOTATION_KEYS.has(key) || key.startsWith("x-")) continue;
    return key;
  }
  return null;
}

/** @param {Record<string, unknown>} document @param {string} name */
function componentSchema(document, name) {
  if (!isPlainObject(document.components) || !isPlainObject(document.components.schemas)) return null;
  const value = document.components.schemas[name];
  return isPlainObject(value) ? value : null;
}

/** @param {Record<string, unknown>} raw @param {Record<string, unknown>} document @param {{ minor:number, stack:string[], depth:number }} context @returns {any} */
function convertSchema(raw, document, context) {
  if (context.depth > 16) throw new Error("OpenAPI schema exceeds maximum supported nesting depth");
  const unsupported = unsupportedSchemaKey(raw);
  if (unsupported) throw new Error(`OpenAPI schema keyword ${unsupported} is outside the supported contract subset`);

  if (raw.$ref !== undefined) {
    if (typeof raw.$ref !== "string") throw new Error("OpenAPI schema $ref must be a string");
    const meaningfulSiblings = Object.keys(raw).filter((key) => key !== "$ref" && !ANNOTATION_KEYS.has(key) && !key.startsWith("x-"));
    if (meaningfulSiblings.length > 0) throw new Error("OpenAPI schema $ref siblings are outside the supported subset");
    const name = componentNameFromRef(raw.$ref);
    if (!name) throw new Error("only local #/components/schemas references are supported");
    if (context.stack.includes(name)) throw new Error(`recursive OpenAPI schema reference is unsupported: ${name}`);
    const target = componentSchema(document, name);
    if (!target) throw new Error(`OpenAPI schema reference cannot be resolved: ${name}`);
    return convertSchema(target, document, { ...context, stack: [...context.stack, name], depth: context.depth + 1 });
  }

  let typeValue = raw.type;
  let nullable = false;
  if (context.minor === 0) {
    if (raw.nullable !== undefined && typeof raw.nullable !== "boolean") throw new Error("OpenAPI 3.0 nullable must be boolean");
    nullable = raw.nullable === true;
    if (Array.isArray(typeValue)) throw new Error("OpenAPI 3.0 schema type arrays are unsupported");
  } else {
    if (raw.nullable !== undefined) throw new Error("nullable keyword is not supported for OpenAPI 3.1+; use type with null");
    if (Array.isArray(typeValue)) {
      const values = typeValue.filter((item) => typeof item === "string");
      if (values.length !== typeValue.length || values.filter((item) => item !== "null").length !== 1 || !values.includes("null")) {
        throw new Error("OpenAPI 3.1+ type arrays must contain exactly one non-null type plus null");
      }
      nullable = true;
      typeValue = values.find((item) => item !== "null");
    }
  }

  const type = nonEmptyString(typeValue)?.toLowerCase() ?? null;
  if (!type) throw new Error("OpenAPI schema type is required by the supported subset");

  let enumValues;
  if (raw.enum !== undefined) {
    if (!Array.isArray(raw.enum) || raw.enum.length === 0) throw new Error("OpenAPI enum must be a non-empty array");
    const values = [];
    for (const item of raw.enum) {
      if (item === null && nullable) continue;
      if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") throw new Error("OpenAPI enum values must be scalar");
      values.push(item);
    }
    if (values.length === 0 || new Set(values.map((item) => `${typeof item}:${String(item)}`)).size !== values.length) {
      throw new Error("OpenAPI enum values must be unique and contain a non-null value");
    }
    enumValues = values;
  }

  if (["string", "number", "integer", "boolean"].includes(type)) {
    return { type, nullable, ...(enumValues ? { enum: enumValues } : {}) };
  }
  if (enumValues) throw new Error("OpenAPI enum is supported only for primitive schemas");

  if (type === "array") {
    if (!isPlainObject(raw.items)) throw new Error("OpenAPI array schema requires object items");
    if (raw.properties !== undefined || raw.required !== undefined || raw.additionalProperties !== undefined) {
      throw new Error("OpenAPI array schema contains object-only keywords");
    }
    return { type: "array", nullable, items: convertSchema(raw.items, document, { ...context, depth: context.depth + 1 }) };
  }

  if (type !== "object") throw new Error(`OpenAPI schema type ${type} is outside the supported contract subset`);
  if (raw.items !== undefined) throw new Error("OpenAPI object schema cannot contain items");
  const propertiesRaw = raw.properties === undefined ? {} : raw.properties;
  if (!isPlainObject(propertiesRaw)) throw new Error("OpenAPI object properties must be an object");
  const requiredRaw = raw.required === undefined ? [] : raw.required;
  if (!Array.isArray(requiredRaw) || requiredRaw.some((item) => !nonEmptyString(item))) throw new Error("OpenAPI object required must be an array of non-empty strings");
  const required = requiredRaw.map((item) => /** @type {string} */ (nonEmptyString(item)));
  if (new Set(required).size !== required.length || required.some((name) => !(name in propertiesRaw))) {
    throw new Error("OpenAPI object required must uniquely reference declared properties");
  }
  let additionalProperties = true;
  if (raw.additionalProperties !== undefined) {
    if (typeof raw.additionalProperties !== "boolean") throw new Error("schema-valued additionalProperties is outside the supported contract subset");
    additionalProperties = raw.additionalProperties;
  }
  /** @type {Record<string, any>} */
  const properties = {};
  for (const name of Object.keys(propertiesRaw).sort()) {
    if (!name.trim() || !isPlainObject(propertiesRaw[name])) throw new Error("OpenAPI object properties must contain named schema objects");
    properties[name] = convertSchema(/** @type {Record<string, unknown>} */ (propertiesRaw[name]), document, { ...context, depth: context.depth + 1 });
  }
  return { type: "object", nullable, properties, required: required.sort(), additionalProperties };
}

/** @param {unknown} raw @param {Record<string, unknown>} document @param {number} minor */
function convertParameter(raw, document, minor) {
  if (!isPlainObject(raw)) throw new Error("OpenAPI parameter must be an object");
  if (raw.$ref !== undefined) throw new Error("parameter $ref is outside the supported contract subset");
  const name = nonEmptyString(raw.name);
  const location = nonEmptyString(raw.in)?.toLowerCase() ?? null;
  if (!name || !["path", "query", "header"].includes(location ?? "")) throw new Error("OpenAPI parameter name or location is unsupported");
  if (raw.content !== undefined) throw new Error("content-based parameters are outside the supported contract subset");
  if (raw.style !== undefined || raw.explode !== undefined || raw.allowReserved !== undefined || raw.allowEmptyValue !== undefined) throw new Error("custom parameter serialization is outside the supported contract subset");
  if (raw.required !== undefined && typeof raw.required !== "boolean") throw new Error("OpenAPI parameter required must be boolean");
  if (!isPlainObject(raw.schema)) throw new Error("OpenAPI parameter schema is required");
  const required = raw.required === true;
  if (location === "path" && !required) throw new Error("OpenAPI path parameters must be required");
  return {
    name,
    in: location,
    required,
    schema: convertSchema(raw.schema, document, { minor, stack: [], depth: 0 }),
  };
}

/** @param {unknown} value @param {Record<string, unknown>} document @param {number} minor */
function convertParameters(value, document, minor) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error("OpenAPI parameters must be an array");
  const parameters = value.map((item) => convertParameter(item, document, minor));
  const seen = new Set();
  for (const parameter of parameters) {
    const key = `${parameter.in}:${parameter.name.toLowerCase()}`;
    if (seen.has(key)) throw new Error(`OpenAPI parameters contain duplicate ${key}`);
    seen.add(key);
  }
  return parameters;
}

/** @param {any[]} pathParameters @param {any[]} operationParameters */
function mergeParameters(pathParameters, operationParameters) {
  const merged = new Map();
  for (const parameter of [...pathParameters, ...operationParameters]) merged.set(`${parameter.in}:${parameter.name.toLowerCase()}`, parameter);
  return [...merged.values()];
}

/** @param {unknown} raw @param {Record<string, unknown>} document @param {number} minor */
function convertRequestBody(raw, document, minor) {
  if (raw === undefined) return null;
  if (!isPlainObject(raw)) throw new Error("OpenAPI requestBody must be an object");
  if (raw.$ref !== undefined) throw new Error("requestBody $ref is outside the supported contract subset");
  if (raw.required !== undefined && typeof raw.required !== "boolean") throw new Error("OpenAPI requestBody required must be boolean");
  if (!isPlainObject(raw.content)) throw new Error("OpenAPI requestBody content must be an object");
  const mediaTypes = Object.keys(raw.content);
  if (mediaTypes.length !== 1) throw new Error("API Contract Snapshot v1 requires exactly one request body media type");
  const mediaType = mediaTypes[0];
  if (!mediaType) throw new Error("API Contract Snapshot v1 requires exactly one request body media type");
  const media = raw.content[mediaType];
  if (!isPlainObject(media) || !isPlainObject(media.schema)) throw new Error("OpenAPI requestBody media type requires a schema");
  return {
    required: raw.required === true,
    mediaType: mediaType.toLowerCase(),
    schema: convertSchema(media.schema, document, { minor, stack: [], depth: 0 }),
  };
}

/** @param {unknown} raw @param {Record<string, unknown>} document @param {number} minor */
function convertResponses(raw, document, minor) {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) throw new Error("OpenAPI responses must be a non-empty object");
  const responses = [];
  for (const statusKey of Object.keys(raw).sort()) {
    const status = statusKey.toUpperCase();
    if (!/^(?:[1-5][0-9][0-9]|DEFAULT)$/.test(status)) throw new Error(`OpenAPI response status ${statusKey} is outside the supported exact-status subset`);
    const response = raw[statusKey];
    if (!isPlainObject(response)) throw new Error(`OpenAPI response ${statusKey} must be an object`);
    if (response.$ref !== undefined) throw new Error("response $ref is outside the supported contract subset");
    if (response.links !== undefined || response.headers !== undefined) throw new Error("response links and headers are outside the supported contract subset");
    if (response.content === undefined) {
      responses.push({ status, mediaType: NO_BODY_MEDIA_TYPE, schema: null });
      continue;
    }
    if (!isPlainObject(response.content) || Object.keys(response.content).length === 0) throw new Error(`OpenAPI response ${statusKey} content must be a non-empty object`);
    for (const mediaType of Object.keys(response.content).sort()) {
      const media = response.content[mediaType];
      if (!isPlainObject(media)) throw new Error(`OpenAPI response ${statusKey} media type ${mediaType} must be an object`);
      if (media.schema === undefined) throw new Error(`OpenAPI response ${statusKey} media type ${mediaType} requires a schema`);
      else {
        if (!isPlainObject(media.schema)) throw new Error(`OpenAPI response ${statusKey} media type ${mediaType} schema must be an object`);
        responses.push({ status, mediaType: mediaType.toLowerCase(), schema: convertSchema(media.schema, document, { minor, stack: [], depth: 0 }) });
      }
    }
  }
  return responses;
}

/** @param {Record<string, unknown>} document @param {{kind:"baseline"|"candidate",service:string,source:string,authenticated:boolean,collectedAt:string}} metadata */
export function openApiToSnapshot(document, metadata) {
  const version = openApiVersion(document.openapi);
  if (!version) throw new Error("supported OpenAPI version must be 3.0.x, 3.1.x, or 3.2.x");
  if (metadata.kind !== "baseline" && metadata.kind !== "candidate") throw new Error("kind must be baseline or candidate");
  const service = nonEmptyString(metadata.service);
  const source = nonEmptyString(metadata.source);
  if (!service || !source || typeof metadata.authenticated !== "boolean" || !isAbsoluteIsoTimestamp(metadata.collectedAt)) {
    throw new Error("explicit service and valid evidence metadata are required");
  }
  if (document.security !== undefined) throw new Error("document security requirements are outside API Contract Snapshot v1");
  if (!isPlainObject(document.paths) || Object.keys(document.paths).length === 0) throw new Error("OpenAPI paths must be a non-empty object");

  const operations = [];
  for (const operationPath of Object.keys(document.paths).sort()) {
    if (!operationPath.startsWith("/")) throw new Error(`OpenAPI path must start with /: ${operationPath}`);
    const pathItem = document.paths[operationPath];
    if (!isPlainObject(pathItem)) throw new Error(`OpenAPI path item ${operationPath} must be an object`);
    if (pathItem.$ref !== undefined) throw new Error("path-item $ref is outside the supported contract subset");
    const pathParameters = convertParameters(pathItem.parameters, document, version.minor);
    for (const method of HTTP_METHODS) {
      const rawOperation = pathItem[method];
      if (rawOperation === undefined) continue;
      if (!isPlainObject(rawOperation)) throw new Error(`OpenAPI operation ${method.toUpperCase()} ${operationPath} must be an object`);
      if (rawOperation.security !== undefined) throw new Error(`operation security is outside API Contract Snapshot v1: ${method.toUpperCase()} ${operationPath}`);
      if (rawOperation.callbacks !== undefined) throw new Error(`callbacks are outside API Contract Snapshot v1: ${method.toUpperCase()} ${operationPath}`);
      const operationParameters = convertParameters(rawOperation.parameters, document, version.minor);
      operations.push({
        method: method.toUpperCase(),
        path: operationPath,
        parameters: mergeParameters(pathParameters, operationParameters),
        body: convertRequestBody(rawOperation.requestBody, document, version.minor),
        responses: convertResponses(rawOperation.responses, document, version.minor),
      });
    }
  }
  if (operations.length === 0) throw new Error("OpenAPI document contains no supported HTTP operations");

  const candidate = {
    version: 1,
    kind: metadata.kind,
    service: { name: service },
    evidence: { source, authenticated: metadata.authenticated, collectedAt: metadata.collectedAt },
    operations,
  };
  const validation = validateApiContractSnapshot(candidate);
  if (!validation.ok || validation.snapshot === null) {
    const detail = validation.errors.map((item) => `${item.id}: ${item.detail}`).join("; ");
    throw new Error(`converted OpenAPI contract is invalid: ${detail}`);
  }
  return validation.snapshot;
}

/** @param {ReturnType<typeof openApiToSnapshot>} snapshot @param {string} openapi */
export function formatOpenApiConversion(snapshot, openapi) {
  return [
    "OpenAPI to API Contract Snapshot",
    "",
    `OpenAPI: ${openapi}`,
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
  let kind = null;
  let service = null;
  let source = null;
  let collectedAt = null;
  let authenticated = false;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") { json = true; continue; }
    if (argument === "--authenticated") { authenticated = true; continue; }
    if (!["--file", "--kind", "--service", "--source", "--collected-at"].includes(argument ?? "")) return null;
    const value = argv[index + 1];
    if (typeof value !== "string" || value.startsWith("--")) return null;
    index += 1;
    if (argument === "--file") { if (file !== null) return null; file = value; continue; }
    if (argument === "--kind") { if (kind !== null) return null; kind = value; continue; }
    if (argument === "--service") { if (service !== null) return null; service = value; continue; }
    if (argument === "--source") { if (source !== null) return null; source = value; continue; }
    if (argument === "--collected-at") { if (collectedAt !== null) return null; collectedAt = value; continue; }
    return null;
  }
  if (!file || !kind || !service || !source || !collectedAt) return null;
  return { file, kind, service, source, collectedAt, authenticated, json };
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options === null) {
    console.error("Usage: node scripts/openapi-api-contract.js --file <openapi.json> --kind <baseline|candidate> --service <name> --source <description> --collected-at <ISO timestamp> [--authenticated] [--json]");
    return 1;
  }
  let document;
  try { document = JSON.parse(fs.readFileSync(options.file, "utf8")); }
  catch { console.error("OpenAPI JSON file cannot be read or parsed"); return 1; }
  if (!isPlainObject(document)) { console.error("OpenAPI document must be an object"); return 1; }
  try {
    const snapshot = openApiToSnapshot(document, {
      kind: /** @type {"baseline"|"candidate"} */ (options.kind),
      service: options.service,
      source: options.source,
      authenticated: options.authenticated,
      collectedAt: options.collectedAt,
    });
    console.log(options.json ? JSON.stringify(snapshot) : formatOpenApiConversion(snapshot, String(document.openapi)));
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "OpenAPI conversion failed");
    return 1;
  }
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  process.exitCode = main();
}
