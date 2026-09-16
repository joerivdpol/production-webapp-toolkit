#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

const SHA256_PATTERN = /^[0-9a-fA-F]{64}$/;

/** @typedef {{ id:string, detail:string }} ValidationError */
/** @typedef {{ version:1, source:{commit:string}, build:{ci:{provider:string,workflow:string,runId:string},artifact:{name:string,sha256:string}}, deployment:{target:string,artifactSha256:string,runtime:{name:string,environment?:string}}, evidence:{source:string,authenticated:boolean,collectedAt:string} }} ArtifactProvenance */

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** @param {unknown} value */
function text(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }

/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {ValidationError[]} errors */
function rejectUnknown(value, allowed, scope, errors) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push({ id: `${scope}-field-unknown`, detail: `${scope} contains unsupported field "${key}"` });
}

/** @param {unknown} value */
export function validateArtifactProvenance(value) {
  /** @type {ValidationError[]} */
  const errors = [];
  if (!isPlainObject(value)) return { valid:false, provenance:null, errors:[{ id:"input-invalid", detail:"artifact provenance must be a JSON object" }] };
  rejectUnknown(value, ["version","source","build","deployment","evidence"], "top-level", errors);
  if (value.version !== 1) errors.push({ id:"version-invalid", detail:"version must be exactly 1" });

  let source = null;
  if (!isPlainObject(value.source)) errors.push({ id:"source-invalid", detail:"source must be an object" });
  else {
    rejectUnknown(value.source, ["commit"], "source", errors);
    const commit = text(value.source.commit);
    if (!commit || !isFullObjectId(commit)) errors.push({ id:"source-commit-invalid", detail:"source.commit must be a full Git object id" });
    else source = { commit:commit.toLowerCase() };
  }

  let build = null;
  if (!isPlainObject(value.build)) errors.push({ id:"build-invalid", detail:"build must be an object" });
  else {
    rejectUnknown(value.build, ["ci","artifact"], "build", errors);
    let ci = null;
    if (!isPlainObject(value.build.ci)) errors.push({ id:"build-ci-invalid", detail:"build.ci must be an object" });
    else {
      rejectUnknown(value.build.ci, ["provider","workflow","runId"], "build-ci", errors);
      const provider=text(value.build.ci.provider), workflow=text(value.build.ci.workflow), runId=text(value.build.ci.runId);
      if (!provider || !workflow || !runId) errors.push({ id:"build-ci-identity-invalid", detail:"build.ci requires provider, workflow, and runId" });
      else ci={provider,workflow,runId};
    }
    let artifact = null;
    if (!isPlainObject(value.build.artifact)) errors.push({ id:"build-artifact-invalid", detail:"build.artifact must be an object" });
    else {
      rejectUnknown(value.build.artifact, ["name","sha256"], "build-artifact", errors);
      const name=text(value.build.artifact.name), sha256=text(value.build.artifact.sha256)?.toLowerCase() ?? null;
      if (!name || !sha256 || !SHA256_PATTERN.test(sha256)) errors.push({ id:"build-artifact-identity-invalid", detail:"build.artifact requires name and SHA256" });
      else artifact={name,sha256};
    }
    if (ci && artifact) build={ci,artifact};
  }

  let deployment = null;
  if (!isPlainObject(value.deployment)) errors.push({ id:"deployment-invalid", detail:"deployment must be an object" });
  else {
    rejectUnknown(value.deployment, ["target","artifactSha256","runtime"], "deployment", errors);
    const target=text(value.deployment.target), artifactSha256=text(value.deployment.artifactSha256)?.toLowerCase() ?? null;
    if (!target) errors.push({ id:"deployment-target-invalid", detail:"deployment.target must be a non-empty string" });
    if (!artifactSha256 || !SHA256_PATTERN.test(artifactSha256)) errors.push({ id:"deployment-artifact-invalid", detail:"deployment.artifactSha256 must be SHA256" });
    let runtime = null;
    if (!isPlainObject(value.deployment.runtime)) errors.push({ id:"deployment-runtime-invalid", detail:"deployment.runtime must be an object" });
    else {
      rejectUnknown(value.deployment.runtime, ["name","environment"], "deployment-runtime", errors);
      const name=text(value.deployment.runtime.name), environment=value.deployment.runtime.environment === undefined ? null : text(value.deployment.runtime.environment);
      if (!name || (value.deployment.runtime.environment !== undefined && !environment)) errors.push({ id:"deployment-runtime-identity-invalid", detail:"deployment.runtime requires name and a non-empty optional environment" });
      else runtime={name,...(environment ? {environment} : {})};
    }
    if (target && artifactSha256 && SHA256_PATTERN.test(artifactSha256) && runtime) deployment={target,artifactSha256,runtime};
  }

  let evidence = null;
  if (!isPlainObject(value.evidence)) errors.push({ id:"evidence-invalid", detail:"evidence must be an object" });
  else {
    rejectUnknown(value.evidence, ["source","authenticated","collectedAt"], "evidence", errors);
    const sourceName=text(value.evidence.source), collectedAt=text(value.evidence.collectedAt);
    if (!sourceName || typeof value.evidence.authenticated !== "boolean" || !collectedAt || !isAbsoluteIsoTimestamp(collectedAt)) errors.push({ id:"evidence-fields-invalid", detail:"evidence requires source, authenticated boolean, and absolute collectedAt" });
    else evidence={source:sourceName,authenticated:value.evidence.authenticated,collectedAt};
  }

  if (errors.length || !source || !build || !deployment || !evidence) return { valid:false, provenance:null, errors };
  return { valid:true, provenance:/** @type {ArtifactProvenance} */({version:1,source,build,deployment,evidence}), errors:[] };
}

/** @param {ArtifactProvenance} provenance */
export function formatArtifactProvenance(provenance) {
  return ["Artifact Provenance Contract v1","",`Source commit: ${provenance.source.commit}`,`CI: ${provenance.build.ci.provider} / ${provenance.build.ci.workflow} / ${provenance.build.ci.runId}`,`Artifact: ${provenance.build.artifact.name}`,`Artifact SHA256: ${provenance.build.artifact.sha256}`,`Deployment target: ${provenance.deployment.target}`,`Runtime: ${provenance.deployment.runtime.name}`,`Authenticated: ${provenance.evidence.authenticated}`,`Collected at: ${provenance.evidence.collectedAt}`,"Result: VALID"].join("\n");
}

/** @param {string[]} argv */
function parseArguments(argv) {
  let file=null, json=false;
  for (let i=0;i<argv.length;i+=1) {
    const arg=argv[i];
    if (arg === "--json") { json=true; continue; }
    if (arg !== "--file" || file !== null) return null;
    const value=argv[i+1]; if (typeof value !== "string" || value.startsWith("--")) return null; file=value; i+=1;
  }
  return file ? {file,json} : null;
}

export function main(argv=process.argv.slice(2)) {
  const options=parseArguments(argv);
  if (!options) { console.error("Usage: node scripts/artifact-provenance.js --file <provenance.json> [--json]"); return 1; }
  let input; try { input=JSON.parse(fs.readFileSync(options.file,"utf8")); } catch { console.error("Artifact provenance file cannot be read or parsed"); return 1; }
  const result=validateArtifactProvenance(input);
  if (!result.valid || !result.provenance) { console.error("Artifact provenance is invalid"); return 1; }
  console.log(options.json ? JSON.stringify(result.provenance) : formatArtifactProvenance(result.provenance)); return 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode=main();
