#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateArtifactProvenance } from "./artifact-provenance.js";
import { validateCiEvidence } from "./ci-evidence.js";
import { validateRuntimeEvidence } from "./runtime-evidence.js";

/** @param {any} provenance @param {any} ci @param {any} runtime */
export function inspectArtifactProvenance(provenance, ci, runtime) {
  /** @type {Array<{id:string,status:"PASS"|"FAIL",detail:string}>} */
  const checks=[];
  /** @param {string} id @param {boolean} passed @param {string} detail */
  const add=(id,passed,detail)=>checks.push({id,status:passed?"PASS":"FAIL",detail});
  add("source-ci-commit", provenance.source.commit === ci.commit, "source commit must equal the exact CI evidence commit");
  add("ci-provider", provenance.build.ci.provider === ci.ci.provider, "build provider must match CI evidence");
  add("ci-workflow", provenance.build.ci.workflow === ci.ci.workflow, "build workflow must match CI evidence");
  add("ci-run", provenance.build.ci.runId === ci.ci.runId, "build runId must match CI evidence");
  add("artifact-deployment-hash", provenance.build.artifact.sha256 === provenance.deployment.artifactSha256, "deployment artifact SHA256 must equal built artifact SHA256");
  add("source-runtime-commit", provenance.source.commit === runtime.deployment.commit, "runtime deployment commit must equal source commit");
  add("runtime-name", provenance.deployment.runtime.name === runtime.runtime.name, "deployment runtime name must match runtime evidence");
  const expectedEnvironment=provenance.deployment.runtime.environment ?? null;
  const observedEnvironment=runtime.runtime.environment ?? null;
  add("runtime-environment", expectedEnvironment === observedEnvironment, "deployment runtime environment must match runtime evidence exactly");
  const failed=checks.filter((item)=>item.status === "FAIL").length;
  return {
    sourceCommit:provenance.source.commit,
    artifact:{name:provenance.build.artifact.name,sha256:provenance.build.artifact.sha256},
    deploymentTarget:provenance.deployment.target,
    trust:{provenanceAuthenticated:provenance.evidence.authenticated,ciAuthenticated:ci.evidence.authenticated,runtimeAuthenticated:runtime.evidence.authenticated},
    checks,
    summary:{pass:checks.length-failed,fail:failed},
    technicalStatus:"PASS",
    provenanceStatus:failed ? "MISMATCH" : "MATCH",
    overallStatus:failed ? "FAIL" : "PASS",
  };
}

/** @param {ReturnType<typeof inspectArtifactProvenance>} report */
export function formatArtifactProvenanceAudit(report) {
  const lines=["Artifact provenance audit","",`Source commit: ${report.sourceCommit}`,`Artifact: ${report.artifact.name}`,`Artifact SHA256: ${report.artifact.sha256}`,`Deployment target: ${report.deploymentTarget}`,`Provenance authenticated: ${report.trust.provenanceAuthenticated}`,`CI authenticated: ${report.trust.ciAuthenticated}`,`Runtime authenticated: ${report.trust.runtimeAuthenticated}`,""];
  for (const check of report.checks) lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.detail}`);
  lines.push("",`Checks: ${report.summary.pass} pass, ${report.summary.fail} fail`,`Provenance: ${report.provenanceStatus}`,`Technical: ${report.technicalStatus}`,`Overall: ${report.overallStatus}`);
  return lines.join("\n");
}

/** @param {string} filename */
function readJson(filename) { try { return JSON.parse(fs.readFileSync(filename,"utf8")); } catch { return null; } }

/** @param {string[]} argv */
function parseArguments(argv) {
  let provenanceFile=null,ciFile=null,runtimeFile=null,json=false;
  for (let i=0;i<argv.length;i+=1) {
    const arg=argv[i]; if (arg === "--json") { json=true; continue; }
    if (!["--provenance-file","--ci-evidence-file","--runtime-evidence-file"].includes(arg ?? "")) return null;
    const value=argv[i+1]; if (typeof value !== "string" || value.startsWith("--")) return null; i+=1;
    if (arg === "--provenance-file") { if (provenanceFile) return null; provenanceFile=value; }
    if (arg === "--ci-evidence-file") { if (ciFile) return null; ciFile=value; }
    if (arg === "--runtime-evidence-file") { if (runtimeFile) return null; runtimeFile=value; }
  }
  return provenanceFile&&ciFile&&runtimeFile ? {provenanceFile,ciFile,runtimeFile,json} : null;
}

export function main(argv=process.argv.slice(2)) {
  const options=parseArguments(argv);
  if (!options) { console.error("Usage: node scripts/audit-artifact-provenance.js --provenance-file <provenance.json> --ci-evidence-file <ci.json> --runtime-evidence-file <runtime.json> [--json]"); return 1; }
  const rawProvenance=readJson(options.provenanceFile), rawCi=readJson(options.ciFile), rawRuntime=readJson(options.runtimeFile);
  if (!rawProvenance || !rawCi || !rawRuntime) { console.error("Artifact provenance audit input cannot be read or parsed"); return 1; }
  const provenanceResult=validateArtifactProvenance(rawProvenance), ciResult=validateCiEvidence(rawCi), runtimeResult=validateRuntimeEvidence(rawRuntime);
  if (!provenanceResult.valid || !provenanceResult.provenance || !ciResult.valid || !ciResult.evidence || !runtimeResult.valid || !runtimeResult.evidence) { console.error("Artifact provenance audit input is invalid"); return 1; }
  const report=inspectArtifactProvenance(provenanceResult.provenance,ciResult.evidence,runtimeResult.evidence);
  console.log(options.json ? JSON.stringify(report) : formatArtifactProvenanceAudit(report)); return report.overallStatus === "FAIL" ? 1 : 0;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) process.exitCode=main();
