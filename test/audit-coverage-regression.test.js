import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {formatCoverageAudit,inspectCoverageRegression,main,validateCoveragePolicy} from "../scripts/audit-coverage-regression.js";
import {validateCoverageComparisonEvidence} from "../scripts/coverage-comparison-evidence.js";

function metric(covered=8,total=10){return{covered,total};}
function metrics(covered=8,total=10){return{lines:metric(covered,total),statements:metric(covered,total),functions:metric(covered,total),branches:metric(covered,total)};}
/** @returns {any} */
function rawEvidence(){return{
  version:1,source:{baseCommit:"a".repeat(40),headCommit:"b".repeat(40)},evidence:{source:"synthetic",authenticated:false,collectedAt:"2026-09-16T17:00:00Z"},
  changes:[{path:"src/core.js",status:"MODIFIED"}],baseline:[{path:"src/core.js",metrics:metrics(9,10)},{path:"src/critical/a.js",metrics:metrics(9,10)}],candidate:[{path:"src/core.js",metrics:metrics(9,10)},{path:"src/critical/a.js",metrics:metrics(9,10)}],
};}
function evidence(raw=rawEvidence()){const result=validateCoverageComparisonEvidence(raw);assert.equal(result.valid,true);if(!result.valid||!result.evidence)throw new Error("bad fixture");return result.evidence;}
/** @returns {any} */
function rawPolicy(){return{version:1,changed:{includePaths:["src/**"],minimums:{lines:80,statements:80,functions:70,branches:70},maxRegressionPoints:{lines:2,statements:2,functions:3,branches:3}},criticalModules:[{id:"critical",paths:["src/critical/**"],required:true,minimums:{lines:85,statements:85,functions:80,branches:80}}]};}
function policy(){const result=validateCoveragePolicy(rawPolicy());assert.equal(result.valid,true);if(!result.valid||!result.policy)throw new Error("bad policy");return result.policy;}
/** @param {unknown} value */
function tempJson(value){const file=path.join(os.tmpdir(),`coverage-audit-${process.pid}-${Math.random().toString(16).slice(2)}.json`);fs.writeFileSync(file,typeof value==="string"?value:JSON.stringify(value));return file;}

test("validates explicit changed-file and critical-module policy",()=>{const result=validateCoveragePolicy(rawPolicy());assert.equal(result.valid,true);if(result.valid&&result.policy)assert.equal(result.policy.criticalModules[0]?.id,"critical");});

test("policy rejects unsafe patterns invalid percentages duplicate ids and unknown fields",()=>{
  const unsafe=rawPolicy();unsafe.changed.includePaths=["../src/**"];assert.equal(validateCoveragePolicy(unsafe).valid,false);
  const percent=rawPolicy();percent.changed.minimums.lines=101;assert.equal(validateCoveragePolicy(percent).valid,false);
  const duplicate=rawPolicy();duplicate.criticalModules.push(structuredClone(duplicate.criticalModules[0]));assert.equal(validateCoveragePolicy(duplicate).valid,false);
  const unknown=rawPolicy();unknown.mode="automatic";assert.equal(validateCoveragePolicy(unknown).valid,false);
});

test("unchanged coverage above minimums passes",()=>{const report=inspectCoverageRegression(policy(),evidence());assert.equal(report.overallStatus,"PASS");});

test("changed coverage regression beyond tolerance is blocking",()=>{
  const raw=rawEvidence();raw.candidate.find((/** @type {any} */ file)=>file.path==="src/core.js").metrics.lines=metric(8,10);
  const report=inspectCoverageRegression(policy(),evidence(raw));assert.equal(report.overallStatus,"FAIL");assert.equal(report.checks.some(check=>check.id==="coverage-regression"&&check.metric==="lines"&&check.status==="FAIL"),true);
});

test("changed file minimum coverage is enforced independently of regression",()=>{
  const raw=rawEvidence();raw.baseline[0].metrics.functions=metric(6,10);raw.candidate[0].metrics.functions=metric(6,10);
  const report=inspectCoverageRegression(policy(),evidence(raw));assert.equal(report.checks.some(check=>check.id==="coverage-minimum"&&check.metric==="functions"&&check.status==="FAIL"),true);
});

test("added changed file requires candidate coverage but no baseline",()=>{
  const raw=rawEvidence();raw.changes=[{path:"src/new.js",status:"ADDED"}];raw.candidate.push({path:"src/new.js",metrics:metrics(8,10)});
  const report=inspectCoverageRegression(policy(),evidence(raw));assert.equal(report.overallStatus,"PASS");assert.equal(report.checks.some(check=>check.scope==="changed:src/new.js"&&check.id==="coverage-regression"),false);
});

test("deleted files are ignored because candidate coverage cannot contain them",()=>{
  const raw=rawEvidence();raw.changes=[{path:"src/old.js",status:"DELETED"}];const report=inspectCoverageRegression(policy(),evidence(raw));assert.equal(report.overallStatus,"PASS");assert.equal(report.checks.some(check=>check.scope==="changed:src/old.js"),false);
});

test("renamed files compare candidate path with explicit previous baseline path",()=>{
  const raw=rawEvidence();raw.changes=[{path:"src/new-name.js",status:"RENAMED",previousPath:"src/old-name.js"}];raw.baseline.push({path:"src/old-name.js",metrics:metrics(9,10)});raw.candidate.push({path:"src/new-name.js",metrics:metrics(9,10)});
  const report=inspectCoverageRegression(policy(),evidence(raw));assert.equal(report.overallStatus,"PASS");
});

test("missing candidate or required baseline coverage fails closed",()=>{
  const candidate=rawEvidence();candidate.candidate=candidate.candidate.filter((/** @type {any} */ file)=>file.path!=="src/core.js");let report=inspectCoverageRegression(policy(),evidence(candidate));assert.equal(report.checks.some(check=>check.id==="changed-coverage-missing"),true);
  const baseline=rawEvidence();baseline.baseline=baseline.baseline.filter((/** @type {any} */ file)=>file.path!=="src/core.js");report=inspectCoverageRegression(policy(),evidence(baseline));assert.equal(report.checks.some(check=>check.id==="baseline-coverage-missing"),true);
});

test("critical module coverage is aggregated across matching files",()=>{
  const raw=rawEvidence();raw.candidate.push({path:"src/critical/b.js",metrics:metrics(7,10)});raw.baseline.push({path:"src/critical/b.js",metrics:metrics(7,10)});
  const report=inspectCoverageRegression(policy(),evidence(raw));const criticalLine=report.checks.find(check=>check.scope==="critical:critical"&&check.metric==="lines");assert.equal(criticalLine?.status,"FAIL");assert.match(criticalLine?.detail??"",/80\.00%/);
});

test("required absent critical modules fail while optional absent modules pass",()=>{
  const required=rawPolicy();required.criticalModules[0].paths=["missing/**"];const requiredPolicy=validateCoveragePolicy(required);assert.equal(requiredPolicy.valid,true);if(!requiredPolicy.valid||!requiredPolicy.policy)return;let report=inspectCoverageRegression(requiredPolicy.policy,evidence());assert.equal(report.checks.some(check=>check.id==="critical-module-missing"&&check.status==="FAIL"),true);
  const optional=rawPolicy();optional.criticalModules[0].paths=["missing/**"];optional.criticalModules[0].required=false;const optionalPolicy=validateCoveragePolicy(optional);assert.equal(optionalPolicy.valid,true);if(!optionalPolicy.valid||!optionalPolicy.policy)return;report=inspectCoverageRegression(optionalPolicy.policy,evidence());assert.equal(report.checks.some(check=>check.id==="critical-module-not-present"&&check.status==="PASS"),true);
});

test("zero coverable units are N/A but disappearing totals are blocking",()=>{
  const added=rawEvidence();added.changes=[{path:"src/types.d.ts",status:"ADDED"}];added.candidate.push({path:"src/types.d.ts",metrics:metrics(0,0)});let report=inspectCoverageRegression(policy(),evidence(added));assert.equal(report.checks.filter(check=>check.scope==="changed:src/types.d.ts"&&check.status==="FAIL").length,0);
  const disappeared=rawEvidence();disappeared.candidate[0].metrics.lines=metric(0,0);report=inspectCoverageRegression(policy(),evidence(disappeared));assert.equal(report.checks.some(check=>check.id==="coverage-total-disappeared"&&check.status==="FAIL"),true);
});

test("changes outside explicit include paths do not affect changed-file gate",()=>{
  const p=rawPolicy();p.changed.includePaths=["lib/**"];const validated=validateCoveragePolicy(p);assert.equal(validated.valid,true);if(!validated.valid||!validated.policy)return;
  const raw=rawEvidence();raw.candidate=[];const report=inspectCoverageRegression(validated.policy,evidence(raw));assert.equal(report.checks.some(check=>check.id==="changed-coverage-missing"),false);
});

test("human output names concrete scopes metrics and regression reasons",()=>{
  const raw=rawEvidence();raw.candidate[0].metrics.lines=metric(8,10);const text=formatCoverageAudit(inspectCoverageRegression(policy(),evidence(raw)));assert.match(text,/coverage-regression/);assert.match(text,/changed:src\/core\.js/);assert.match(text,/Overall: FAIL/);
});

test("CLI returns zero for pass and one for blocking coverage regression",()=>{
  const evidenceFile=tempJson(rawEvidence()),policyFile=tempJson(rawPolicy()),original=console.log;let stdout="";console.log=(...values)=>{stdout+=`${values.join(" ")}\n`;};
  try{assert.equal(main(["--evidence-file",evidenceFile,"--policy",policyFile,"--json"]),0);}finally{console.log=original;}
  assert.equal(JSON.parse(stdout).overallStatus,"PASS");const raw=rawEvidence();raw.candidate[0].metrics.lines=metric(5,10);fs.writeFileSync(evidenceFile,JSON.stringify(raw));assert.equal(main(["--evidence-file",evidenceFile,"--policy",policyFile]),1);fs.rmSync(evidenceFile,{force:true});fs.rmSync(policyFile,{force:true});
});

test("audit core stays offline read only and delegates canonical evidence validation",()=>{
  const source=fs.readFileSync(new URL("../scripts/audit-coverage-regression.js",import.meta.url),"utf8");assert.match(source,/validateCoverageComparisonEvidence/);assert.doesNotMatch(source,/node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
