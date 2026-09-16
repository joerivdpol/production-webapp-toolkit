import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  formatApiContractAudit,
  inspectApiContractCompatibility,
  main,
} from "../scripts/audit-api-contract.js";
import { validateApiContractSnapshot } from "../scripts/api-contract-snapshot.js";

/** @param {"baseline"|"candidate"} kind @returns {any} */
function rawSnapshot(kind) {
  return {
    version: 1,
    kind,
    service: { name: "example-api" },
    evidence: { source: "synthetic", authenticated: false, collectedAt: "2026-09-16T13:30:00Z" },
    operations: [],
  };
}

/** @returns {any} */
function responseSchema() {
  return {
    type: "object", nullable: false, additionalProperties: false,
    required: ["id", "name"],
    properties: {
      id: { type: "string", nullable: false },
      name: { type: "string", nullable: false },
      status: { type: "string", nullable: false, enum: ["active", "disabled"] },
    },
  };
}

/** @returns {any} */
function operation() {
  return {
    method: "GET", path: "/users/{id}",
    parameters: [
      { name: "id", in: "path", required: true, schema: { type: "string", nullable: false } },
      { name: "verbose", in: "query", required: false, schema: { type: "boolean", nullable: false } },
    ],
    body: null,
    responses: [{ status: "200", mediaType: "application/json", schema: responseSchema() }],
  };
}

/** @param {"baseline"|"candidate"} [kind] @returns {any} */
function validated(kind = "baseline") {
  const value = rawSnapshot(kind);
  value.operations.push(operation());
  const result = validateApiContractSnapshot(value);
  assert.equal(result.ok, true);
  if (!result.ok || result.snapshot === null) throw new Error("contract fixture invalid");
  return result.snapshot;
}

/** @param {any} value */
function validate(value) {
  const result = validateApiContractSnapshot(value);
  assert.equal(result.ok, true);
  if (!result.ok || result.snapshot === null) throw new Error("contract fixture invalid");
  return result.snapshot;
}

/** @returns {{ baseline: any, candidate: any }} */
function pair() {
  return { baseline: validated("baseline"), candidate: validated("candidate") };
}

test("identical contracts are compatible PASS", () => {
  const { baseline, candidate } = pair();
  const report = inspectApiContractCompatibility(baseline, candidate);
  assert.equal(report.compatibilityStatus, "COMPATIBLE");
  assert.equal(report.overallStatus, "PASS");
});

test("adding an operation is compatible", () => {
  const baseline = rawSnapshot("baseline");
  baseline.operations.push(operation());
  const candidate = structuredClone(baseline);
  candidate.kind = "candidate";
  candidate.operations.push({ method: "GET", path: "/health", parameters: [], body: null, responses: [{ status: "200", mediaType: "text/plain", schema: null }] });
  const report = inspectApiContractCompatibility(validate(baseline), validate(candidate));
  assert.equal(report.overallStatus, "PASS");
  assert.equal(report.checks.some((item) => item.id === "operation-added"), true);
});

test("removing an operation is breaking", () => {
  const baseline = validated("baseline");
  const candidateRaw = rawSnapshot("candidate");
  candidateRaw.operations.push({ method: "GET", path: "/health", parameters: [], body: null, responses: [{ status: "200", mediaType: "text/plain", schema: null }] });
  const report = inspectApiContractCompatibility(baseline, validate(candidateRaw));
  assert.equal(report.overallStatus, "FAIL");
  assert.equal(report.checks.some((item) => item.id === "operation-removed"), true);
});

test("service identity and snapshot kinds are blocking", () => {
  const { baseline, candidate } = pair();
  candidate.service.name = "other-api";
  assert.equal(inspectApiContractCompatibility(baseline, candidate).overallStatus, "FAIL");
  assert.equal(inspectApiContractCompatibility(candidate, baseline).overallStatus, "FAIL");
});

test("new optional request parameter is compatible but required is breaking", () => {
  const { baseline, candidate } = pair();
  candidate.operations[0].parameters.push({ name: "locale", in: "query", required: false, schema: { type: "string", nullable: false } });
  assert.equal(inspectApiContractCompatibility(baseline, candidate).overallStatus, "PASS");
  candidate.operations[0].parameters.at(-1).required = true;
  assert.equal(inspectApiContractCompatibility(baseline, candidate).overallStatus, "FAIL");
});

test("removing a request parameter or making one required is breaking", () => {
  const first = pair();
  first.candidate.operations[0].parameters = first.candidate.operations[0].parameters.filter((/** @type {any} */ item) => item.name !== "verbose");
  assert.equal(inspectApiContractCompatibility(first.baseline, first.candidate).overallStatus, "FAIL");

  const second = pair();
  second.candidate.operations[0].parameters.find((/** @type {any} */ item) => item.name === "verbose").required = true;
  assert.equal(inspectApiContractCompatibility(second.baseline, second.candidate).overallStatus, "FAIL");
});

test("request enum narrowing breaks while widening remains compatible", () => {
  const baselineRaw = rawSnapshot("baseline");
  const op = operation();
  op.parameters[1].schema = { type: "string", nullable: false, enum: ["a", "b"] };
  baselineRaw.operations.push(op);
  const narrowRaw = structuredClone(baselineRaw); narrowRaw.kind = "candidate"; narrowRaw.operations[0].parameters[1].schema.enum = ["a"];
  const wideRaw = structuredClone(baselineRaw); wideRaw.kind = "candidate"; wideRaw.operations[0].parameters[1].schema.enum = ["a", "b", "c"];
  assert.equal(inspectApiContractCompatibility(validate(baselineRaw), validate(narrowRaw)).overallStatus, "FAIL");
  assert.equal(inspectApiContractCompatibility(validate(baselineRaw), validate(wideRaw)).overallStatus, "PASS");
});

test("request nullability and object required fields cannot narrow", () => {
  const baseRaw = rawSnapshot("baseline");
  const op = operation();
  op.parameters[1].schema = { type: "string", nullable: true };
  baseRaw.operations.push(op);
  const nullNarrow = structuredClone(baseRaw); nullNarrow.kind = "candidate"; nullNarrow.operations[0].parameters[1].schema.nullable = false;
  assert.equal(inspectApiContractCompatibility(validate(baseRaw), validate(nullNarrow)).overallStatus, "FAIL");

  const objectBase = rawSnapshot("baseline");
  const objectOp = operation();
  objectOp.parameters[1].schema = { type: "object", nullable: false, additionalProperties: false, required: [], properties: { q: { type: "string", nullable: false } } };
  objectBase.operations.push(objectOp);
  const objectCandidate = structuredClone(objectBase); objectCandidate.kind = "candidate"; objectCandidate.operations[0].parameters[1].schema.required = ["q"];
  assert.equal(inspectApiContractCompatibility(validate(objectBase), validate(objectCandidate)).overallStatus, "FAIL");
});

test("new optional request object properties remain compatible", () => {
  const baseRaw = rawSnapshot("baseline");
  const op = operation();
  op.parameters[1].schema = { type: "object", nullable: false, additionalProperties: false, required: [], properties: {} };
  baseRaw.operations.push(op);
  const candidateRaw = structuredClone(baseRaw); candidateRaw.kind = "candidate";
  candidateRaw.operations[0].parameters[1].schema.properties.q = { type: "string", nullable: false };
  assert.equal(inspectApiContractCompatibility(validate(baseRaw), validate(candidateRaw)).overallStatus, "PASS");
});

test("request additionalProperties may not become narrower", () => {
  const baseRaw = rawSnapshot("baseline");
  const op = operation();
  op.parameters[1].schema = { type: "object", nullable: false, additionalProperties: true, required: [], properties: {} };
  baseRaw.operations.push(op);
  const candidateRaw = structuredClone(baseRaw); candidateRaw.kind = "candidate";
  candidateRaw.operations[0].parameters[1].schema.additionalProperties = false;
  assert.equal(inspectApiContractCompatibility(validate(baseRaw), validate(candidateRaw)).overallStatus, "FAIL");
});

test("request body may not become required or change media type", () => {
  const baseRaw = rawSnapshot("baseline");
  const op = operation();
  op.method = "POST";
  op.body = { required: false, mediaType: "application/json", schema: { type: "string", nullable: false } };
  baseRaw.operations.push(op);
  const requiredRaw = structuredClone(baseRaw); requiredRaw.kind = "candidate"; requiredRaw.operations[0].body.required = true;
  assert.equal(inspectApiContractCompatibility(validate(baseRaw), validate(requiredRaw)).overallStatus, "FAIL");
  const mediaRaw = structuredClone(baseRaw); mediaRaw.kind = "candidate"; mediaRaw.operations[0].body.mediaType = "text/plain";
  assert.equal(inspectApiContractCompatibility(validate(baseRaw), validate(mediaRaw)).overallStatus, "FAIL");
});

test("adding an extra response contract is a non-breaking warning", () => {
  const { baseline, candidate } = pair();
  candidate.operations[0].responses.push({ status: "404", mediaType: "application/json", schema: null });
  const report = inspectApiContractCompatibility(baseline, candidate);
  assert.equal(report.compatibilityStatus, "COMPATIBLE");
  assert.equal(report.overallStatus, "WARN");
});

test("removing a baseline response is breaking", () => {
  const { baseline, candidate } = pair();
  candidate.operations[0].responses = [];
  const raw = rawSnapshot("candidate"); raw.operations.push(operation()); raw.operations[0].responses = [{ status: "404", mediaType: "application/json", schema: null }];
  assert.equal(inspectApiContractCompatibility(baseline, validate(raw)).overallStatus, "FAIL");
});

test("response required fields cannot disappear", () => {
  const { baseline, candidate } = pair();
  candidate.operations[0].responses[0].schema.required = ["id"];
  assert.equal(inspectApiContractCompatibility(baseline, candidate).overallStatus, "FAIL");
});

test("response enum widening breaks while narrowing remains compatible", () => {
  const first = pair();
  first.candidate.operations[0].responses[0].schema.properties.status.enum.push("archived");
  assert.equal(inspectApiContractCompatibility(first.baseline, first.candidate).overallStatus, "FAIL");

  const second = pair();
  second.candidate.operations[0].responses[0].schema.properties.status.enum = ["active"];
  assert.equal(inspectApiContractCompatibility(second.baseline, second.candidate).overallStatus, "PASS");
});

test("response nullability cannot widen", () => {
  const { baseline, candidate } = pair();
  candidate.operations[0].responses[0].schema.properties.name.nullable = true;
  assert.equal(inspectApiContractCompatibility(baseline, candidate).overallStatus, "FAIL");
});

test("closed response objects may not gain properties", () => {
  const { baseline, candidate } = pair();
  candidate.operations[0].responses[0].schema.properties.extra = { type: "string", nullable: false };
  assert.equal(inspectApiContractCompatibility(baseline, candidate).overallStatus, "FAIL");
});

test("response object may not become open", () => {
  const { baseline, candidate } = pair();
  candidate.operations[0].responses[0].schema.additionalProperties = true;
  assert.equal(inspectApiContractCompatibility(baseline, candidate).overallStatus, "FAIL");
});

test("existing response property type changes are breaking", () => {
  const { baseline, candidate } = pair();
  candidate.operations[0].responses[0].schema.properties.id.type = "integer";
  assert.equal(inspectApiContractCompatibility(baseline, candidate).overallStatus, "FAIL");
});

test("trust metadata never changes compatibility truth", () => {
  const { baseline, candidate } = pair();
  baseline.evidence.authenticated = false;
  candidate.evidence.authenticated = true;
  assert.equal(inspectApiContractCompatibility(baseline, candidate).overallStatus, "PASS");
});

/** @param {any} value */
function tempJson(value) {
  const filename = path.join(os.tmpdir(), `api-audit-${process.pid}-${Math.random().toString(16).slice(2)}.json`);
  fs.writeFileSync(filename, JSON.stringify(value));
  return filename;
}

test("CLI exposes PASS WARN FAIL semantics", () => {
  const baselineRaw = rawSnapshot("baseline"); baselineRaw.operations.push(operation());
  const candidateRaw = rawSnapshot("candidate"); candidateRaw.operations.push(operation());
  const baselineFile = tempJson(baselineRaw);
  const candidateFile = tempJson(candidateRaw);
  const originalLog = console.log;
  let stdout = "";
  console.log = (...values) => { stdout += `${values.join(" ")}\n`; };
  try { assert.equal(main(["--baseline-file", baselineFile, "--candidate-file", candidateFile, "--json"]), 0); }
  finally { console.log = originalLog; }
  assert.equal(JSON.parse(stdout).overallStatus, "PASS");
  candidateRaw.operations[0].responses.push({ status: "404", mediaType: "application/json", schema: null });
  fs.writeFileSync(candidateFile, JSON.stringify(candidateRaw));
  assert.equal(main(["--baseline-file", baselineFile, "--candidate-file", candidateFile]), 0);
  candidateRaw.operations = [];
  fs.writeFileSync(candidateFile, JSON.stringify(candidateRaw));
  assert.equal(main(["--baseline-file", baselineFile, "--candidate-file", candidateFile]), 1);
  fs.rmSync(baselineFile, { force: true }); fs.rmSync(candidateFile, { force: true });
});

test("human output reports paths and rules without schema payloads", () => {
  const { baseline, candidate } = pair();
  candidate.operations[0].responses[0].schema.properties.id.type = "integer";
  const text = formatApiContractAudit(inspectApiContractCompatibility(baseline, candidate));
  assert.match(text, /response-type-changed/);
  assert.match(text, /response:200:application\/json\.id/);
  assert.doesNotMatch(text, /active.*disabled/);
});

test("compatibility core delegates canonical validation and stays offline", () => {
  const source = fs.readFileSync(new URL("../scripts/audit-api-contract.js", import.meta.url), "utf8");
  assert.match(source, /validateApiContractSnapshot/);
  assert.doesNotMatch(source, /node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
