import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatOpenApiConversion,
  main,
  openApiToSnapshot,
} from "../scripts/openapi-api-contract.js";

/** @param {"baseline"|"candidate"} [kind] */
function metadata(kind = "baseline") {
  return {
    kind,
    service: "example-api",
    source: "synthetic-openapi",
    authenticated: false,
    collectedAt: "2026-09-16T13:45:00Z",
  };
}

/** @param {string} [version] @returns {any} */
function baseDocument(version = "3.0.3") {
  return {
    openapi: version,
    info: { title: "Example", version: "1.0.0" },
    paths: {
      "/users/{id}": {
        parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
        get: {
          parameters: [{ name: "verbose", in: "query", schema: { type: "boolean" } }],
          responses: {
            200: {
              description: "ok",
              content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        User: {
          type: "object",
          additionalProperties: false,
          required: ["id", "name"],
          properties: {
            id: { type: "string" },
            name: version.startsWith("3.0.") ? { type: "string", nullable: true } : { type: ["string", "null"] },
          },
        },
      },
    },
  };
}

/** @param {unknown} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `openapi-contract-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("converts an OpenAPI 3.0 document into canonical API Contract Snapshot v1", () => {
  const snapshot = openApiToSnapshot(baseDocument(), metadata());
  assert.equal(snapshot.version, 1);
  assert.equal(snapshot.kind, "baseline");
  assert.equal(snapshot.service.name, "example-api");
  assert.equal(snapshot.operations.length, 1);
  assert.equal(snapshot.operations[0]?.method, "GET");
  assert.equal(snapshot.operations[0]?.parameters.length, 2);
  assert.equal(snapshot.operations[0]?.responses[0]?.mediaType, "application/json");
  assert.equal(snapshot.operations[0]?.responses[0]?.schema?.properties?.name?.nullable, true);
  assert.match(formatOpenApiConversion(snapshot, "3.0.3"), /Result: VALID/);
});

test("converts OpenAPI 3.1 nullable type arrays without inventing nullable metadata", () => {
  const document = baseDocument("3.1.1");
  document.components.schemas.User.properties.name = { type: ["string", "null"] };
  const snapshot = openApiToSnapshot(document, metadata("candidate"));
  assert.equal(snapshot.operations[0]?.responses[0]?.schema?.properties?.name?.nullable, true);
});

test("supports OpenAPI 3.2 using the 3.1+ schema subset semantics", () => {
  const document = baseDocument("3.2.0");
  document.components.schemas.User.properties.name = { type: ["string", "null"] };
  assert.equal(openApiToSnapshot(document, metadata()).operations.length, 1);
});

test("operation parameters override path-level parameters by location and name", () => {
  const document = baseDocument();
  document.paths["/users/{id}"].parameters.push({ name: "locale", in: "query", required: false, schema: { type: "string" } });
  document.paths["/users/{id}"].get.parameters.push({ name: "locale", in: "query", required: true, schema: { type: "string" } });
  const snapshot = openApiToSnapshot(document, metadata());
  const locale = snapshot.operations[0]?.parameters.find((item) => item.name === "locale");
  assert.equal(locale?.required, true);
});

test("converts request bodies, arrays, enums, and bodyless responses", () => {
  const document = baseDocument();
  document.paths["/users/{id}"].get.requestBody = {
    required: true,
    content: {
      "application/json": {
        schema: {
          type: "object", additionalProperties: false, required: ["roles"],
          properties: { roles: { type: "array", items: { type: "string", enum: ["admin", "user"] } } },
        },
      },
    },
  };
  document.paths["/users/{id}"].get.responses[204] = { description: "no content" };
  const snapshot = openApiToSnapshot(document, metadata());
  assert.equal(snapshot.operations[0]?.body?.required, true);
  const bodySchema = /** @type {any} */ (snapshot.operations[0]?.body?.schema);
  assert.deepEqual(bodySchema.properties.roles.items.enum, ["admin", "user"]);
  assert.equal(snapshot.operations[0]?.responses.some((item) => item.status === "204" && item.mediaType === "none" && item.schema === null), true);
});

test("rejects unsupported security, polymorphism, and external references", () => {
  const security = baseDocument();
  security.security = [{ bearer: [] }];
  assert.throws(() => openApiToSnapshot(security, metadata()), /security requirements/);

  const polymorphic = baseDocument();
  polymorphic.components.schemas.User.properties.name = { oneOf: [{ type: "string" }, { type: "number" }] };
  assert.throws(() => openApiToSnapshot(polymorphic, metadata()), /oneOf/);

  const external = baseDocument();
  external.paths["/users/{id}"].get.responses[200].content["application/json"].schema = { $ref: "other.json#/User" };
  assert.throws(() => openApiToSnapshot(external, metadata()), /only local/);
});

test("rejects recursive schema references and schema-valued additionalProperties", () => {
  const recursive = baseDocument();
  recursive.components.schemas.User.properties.child = { $ref: "#/components/schemas/User" };
  assert.throws(() => openApiToSnapshot(recursive, metadata()), /recursive OpenAPI schema reference/);

  const mapSchema = baseDocument();
  mapSchema.components.schemas.User.additionalProperties = { type: "string" };
  assert.throws(() => openApiToSnapshot(mapSchema, metadata()), /schema-valued additionalProperties/);
});

test("rejects ambiguous request body media types and response ranges", () => {
  const multiple = baseDocument();
  multiple.paths["/users/{id}"].get.requestBody = {
    content: {
      "application/json": { schema: { type: "string" } },
      "text/plain": { schema: { type: "string" } },
    },
  };
  assert.throws(() => openApiToSnapshot(multiple, metadata()), /exactly one request body media type/);

  const range = baseDocument();
  range.paths["/users/{id}"].get.responses["2XX"] = range.paths["/users/{id}"].get.responses[200];
  delete range.paths["/users/{id}"].get.responses[200];
  assert.throws(() => openApiToSnapshot(range, metadata()), /exact-status subset/);
});

test("requires explicit trustworthy evidence shape without generating timestamps", () => {
  assert.throws(() => openApiToSnapshot(baseDocument(), { ...metadata(), collectedAt: "today" }), /evidence metadata/);
  assert.throws(() => openApiToSnapshot(baseDocument(), { ...metadata(), source: "" }), /evidence metadata/);
});

test("CLI emits JSON and leaves the source OpenAPI document unchanged", () => {
  const filename = tempJson(baseDocument());
  const before = fs.readFileSync(filename, "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try {
    assert.equal(main([
      "--file", filename,
      "--kind", "baseline",
      "--service", "example-api",
      "--source", "synthetic-openapi",
      "--collected-at", "2026-09-16T13:45:00Z",
      "--json",
    ]), 0);
  } finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).service.name, "example-api");
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed input and incomplete arguments", () => {
  const malformed = tempJson("{");
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--unknown"]), 1);
  assert.equal(main([
    "--file", malformed,
    "--kind", "baseline",
    "--service", "example-api",
    "--source", "synthetic-openapi",
    "--collected-at", "2026-09-16T13:45:00Z",
  ]), 1);
  fs.rmSync(malformed, { force: true });
});

test("OpenAPI adapter stays offline and read only", () => {
  const source = fs.readFileSync(new URL("../scripts/openapi-api-contract.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /validateApiContractSnapshot/);
  assert.match(source, /isAbsoluteIsoTimestamp/);
});

test("rejects webhooks, unknown operation fields, and unmodeled response schemas", () => {
  const webhook = baseDocument("3.1.2");
  webhook.components.schemas.User.properties.name = { type: ["string", "null"] };
  webhook.webhooks = { event: {} };
  assert.throws(() => openApiToSnapshot(webhook, metadata()), /webhooks/);

  const unknown = baseDocument();
  unknown.paths["/users/{id}"].get.futureField = true;
  assert.throws(() => openApiToSnapshot(unknown, metadata()), /unsupported OpenAPI Operation field/);

  const response = baseDocument();
  response.paths["/users/{id}"].get.responses[200].content["application/json"] = {};
  assert.throws(() => openApiToSnapshot(response, metadata()), /requires a schema/);
});

test("duplicate parameters within one OpenAPI parameter list are rejected", () => {
  const document = baseDocument();
  document.paths["/users/{id}"].get.parameters.push({ name: "verbose", in: "query", schema: { type: "boolean" } });
  assert.throws(() => openApiToSnapshot(document, metadata()), /duplicate query:verbose/);
});

test("rejects schema keywords with unmodeled compatibility semantics", () => {
  for (const field of ["format", "readOnly", "writeOnly", "pattern", "minimum"]) {
    const document = baseDocument();
    document.components.schemas.User.properties.name[field] = field === "minimum" ? 1 : field === "readOnly" || field === "writeOnly" ? true : "value";
    assert.throws(() => openApiToSnapshot(document, metadata()), new RegExp(field));
  }
});

test("rejects custom parameter serialization and malformed required flags", () => {
  const styled = baseDocument();
  styled.paths["/users/{id}"].get.parameters[0].style = "deepObject";
  assert.throws(() => openApiToSnapshot(styled, metadata()), /serialization/);

  const malformed = baseDocument();
  malformed.paths["/users/{id}"].get.parameters[0].required = "yes";
  assert.throws(() => openApiToSnapshot(malformed, metadata()), /required must be boolean/);
});

test("supports OpenAPI 3.2 QUERY and additional operations", () => {
  const document = baseDocument("3.2.1");
  document.components.schemas.User.properties.name = { type: ["string", "null"] };
  document.paths["/users/{id}"].query = {
    responses: { 200: { description: "ok", content: { "application/json": { schema: { type: "string" } } } } },
  };
  document.paths["/users/{id}"].additionalOperations = {
    PURGE: { responses: { 204: { description: "done" } } },
  };
  const snapshot = openApiToSnapshot(document, metadata());
  assert.equal(snapshot.operations.some((item) => item.method === "QUERY"), true);
  assert.equal(snapshot.operations.some((item) => item.method === "PURGE"), true);
});

test("rejects OpenAPI 3.2-only operations in older descriptions", () => {
  const document = baseDocument("3.1.2");
  document.components.schemas.User.properties.name = { type: ["string", "null"] };
  document.paths["/users/{id}"].query = { responses: { 204: { description: "done" } } };
  assert.throws(() => openApiToSnapshot(document, metadata()), /QUERY operations require OpenAPI 3.2/);
});
