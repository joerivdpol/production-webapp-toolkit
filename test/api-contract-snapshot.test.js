import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatApiContractSnapshot,
  main,
  validateApiContractSnapshot,
} from "../scripts/api-contract-snapshot.js";

/** @param {"baseline"|"candidate"} [kind] @returns {any} */
function rawSnapshot(kind = "baseline") {
  return {
    version: 1,
    kind,
    service: { name: "example-api" },
    evidence: { source: "synthetic", authenticated: false, collectedAt: "2026-09-16T13:30:00Z" },
    operations: [{
      method: "GET",
      path: "/users/{id}",
      parameters: [
        { name: "id", in: "path", required: true, schema: { type: "string", nullable: false } },
        { name: "verbose", in: "query", required: false, schema: { type: "boolean", nullable: false } },
      ],
      body: null,
      responses: [],
    }],
  };
}

function responseSchema() {
  return {
    type: "object",
    nullable: false,
    additionalProperties: false,
    required: ["id", "name"],
    properties: {
      id: { type: "string", nullable: false },
      name: { type: "string", nullable: false },
      status: { type: "string", nullable: false, enum: ["active", "disabled"] },
    },
  };
}

/** @param {"baseline"|"candidate"} [kind] @returns {any} */
function completeSnapshot(kind = "baseline") {
  const value = rawSnapshot(kind);
  value.operations[0].responses = [{ status: "200", mediaType: "application/json", schema: responseSchema() }];
  return value;
}

/** @param {any} value */
function tempFile(value) {
  const filename = path.join(os.tmpdir(), `api-contract-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, typeof value === "string" ? value : JSON.stringify(value));
  return filename;
}

test("normalizes a valid API contract snapshot deterministically", () => {
  const value = completeSnapshot();
  value.operations[0].method = "get";
  value.operations[0].responses[0].mediaType = "Application/JSON";
  const result = validateApiContractSnapshot(value);
  assert.equal(result.ok, true);
  if (!result.ok || result.snapshot === null) return;
  assert.equal(result.snapshot.operations[0]?.method, "GET");
  assert.equal(result.snapshot.operations[0]?.responses[0]?.mediaType, "application/json");
  assert.deepEqual(result.snapshot.operations[0]?.responses[0]?.schema?.required, ["id", "name"]);
  assert.match(formatApiContractSnapshot(result.snapshot), /Result: VALID/);
});

test("path placeholders must exactly match required path parameters", () => {
  const missing = completeSnapshot();
  missing.operations[0].parameters = [];
  assert.equal(validateApiContractSnapshot(missing).ok, false);

  const optional = completeSnapshot();
  optional.operations[0].parameters[0].required = false;
  assert.equal(validateApiContractSnapshot(optional).ok, false);
});

test("rejects duplicate operations, parameters, and responses", () => {
  const duplicateOperation = completeSnapshot();
  duplicateOperation.operations.push(structuredClone(duplicateOperation.operations[0]));
  assert.equal(validateApiContractSnapshot(duplicateOperation).ok, false);

  const duplicateParameter = completeSnapshot();
  duplicateParameter.operations[0].parameters.push(structuredClone(duplicateParameter.operations[0].parameters[1]));
  assert.equal(validateApiContractSnapshot(duplicateParameter).ok, false);

  const duplicateResponse = completeSnapshot();
  duplicateResponse.operations[0].responses.push(structuredClone(duplicateResponse.operations[0].responses[0]));
  assert.equal(validateApiContractSnapshot(duplicateResponse).ok, false);
});

test("validates primitive, object, and array schema shapes", () => {
  const badObject = completeSnapshot();
  delete badObject.operations[0].responses[0].schema.additionalProperties;
  assert.equal(validateApiContractSnapshot(badObject).ok, false);

  const badPrimitive = completeSnapshot();
  badPrimitive.operations[0].parameters[1].schema.properties = {};
  assert.equal(validateApiContractSnapshot(badPrimitive).ok, false);
});

test("required object fields must reference declared properties", () => {
  const value = completeSnapshot();
  value.operations[0].responses[0].schema.required.push("missing");
  assert.equal(validateApiContractSnapshot(value).ok, false);
});

test("rejects unsupported fields and invalid evidence timestamps", () => {
  const unknown = completeSnapshot();
  unknown.operations[0].extra = true;
  assert.equal(validateApiContractSnapshot(unknown).ok, false);

  const badTime = completeSnapshot();
  badTime.evidence.collectedAt = "2026-09-16";
  assert.equal(validateApiContractSnapshot(badTime).ok, false);
});

test("rejects schemas beyond the bounded nesting depth", () => {
  const value = completeSnapshot();
  let current = value.operations[0].responses[0].schema;
  for (let index = 0; index < 18; index += 1) {
    current.properties.deep = { type: "object", nullable: false, additionalProperties: false, required: [], properties: {} };
    current = current.properties.deep;
  }
  assert.equal(validateApiContractSnapshot(value).ok, false);
});

test("CLI validates files, emits JSON, and leaves input unchanged", () => {
  const filename = tempFile(completeSnapshot());
  const before = fs.readFileSync(filename, "utf8");
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--file", filename, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).service.name, "example-api");
  assert.equal(fs.readFileSync(filename, "utf8"), before);
  fs.rmSync(filename, { force: true });
});

test("CLI rejects malformed, missing, invalid, and unknown input", () => {
  const malformed = tempFile("{");
  const invalid = tempFile({ version: 1 });
  assert.equal(main(["--file", malformed]), 1);
  assert.equal(main(["--file", invalid]), 1);
  assert.equal(main(["--file", "/tmp/missing-api-contract.json"]), 1);
  assert.equal(main(["--unknown"]), 1);
  fs.rmSync(malformed, { force: true });
  fs.rmSync(invalid, { force: true });
});

test("snapshot validator stays offline and read only", () => {
  const source = fs.readFileSync(new URL("../scripts/api-contract-snapshot.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
  assert.match(source, /isAbsoluteIsoTimestamp/);
});
