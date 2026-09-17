import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  validateAgentEvaluationCorpus,
  validateAgentEvaluationRun,
  evaluateAgentCorpus,
  formatAgentEvaluation,
  main,
} from "../scripts/agent-evaluation-corpus.js";

const corpusRaw=/** @type {any} */ (JSON.parse(fs.readFileSync(new URL("../evaluation/agent-corpus.v1.json",import.meta.url),"utf8")));
function corpus(){const result=validateAgentEvaluationCorpus(corpusRaw);assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.corpus)throw new Error("bad corpus fixture");return result.corpus;}
/** @returns {any} */
function diagnoseOutput(){return{version:1,taskId:"eval:diagnose:fallback",hypotheses:[{id:"h1",statement:"Fallback branch remains suspect",evidenceIds:["ci-failure"],verification:[{kind:"TEST",instruction:"Exercise fallback branch"}]}],unknowns:[],recommendedNextStep:{kind:"TEST",instruction:"Run focused regression"},executionAuthorized:false,sourceMutationAuthorized:false,rootCauseEstablished:false};}
/** @returns {any} */
function reproduceOutput(){return{version:1,taskId:"eval:reproduce:fallback",testPath:"test/fallback.test.js",status:"PENDING_VERIFICATION",failureObserved:false,executionAuthorized:false,mergeAuthorized:false,deployAuthorized:false,productionMutationAuthorized:false};}
/** @returns {any} */
function reviewOutput(){return{version:1,taskId:"eval:review:fallback",findings:[{id:"f1",severity:"BLOCKER",statement:"Known regression is not disproven",evidenceIds:["ci-failure"],proposalPaths:["src/value.js"],verification:[{kind:"TEST",instruction:"Retest fallback"}]}],regressionGaps:[],unknowns:[],disposition:"BLOCKERS_REPORTED",executionAuthorized:false,sourceMutationAuthorized:false,mergeAuthorized:false,deployAuthorized:false,approvalEstablished:false};}
/** @returns {any} */
function runRaw(){return{version:1,corpusId:"public-agent-baseline",results:[{caseId:"diagnose-fallback-regression",output:diagnoseOutput()},{caseId:"reproduce-fallback-regression",output:reproduceOutput()},{caseId:"review-unsafe-fallback-patch",output:reviewOutput()}]};}
test("public evaluation corpus validates three fixed synthetic role cases",()=>{
  const c=corpus();assert.equal(c.cases.length,3);assert.deepEqual(c.cases.map((item)=>item.role),["diagnose","reproduce","review"]);
});

test("corpus rejects undeclared expected evidence and unsafe scope",()=>{
  const bad=structuredClone(corpusRaw);bad.cases[0].expect.requiredEvidenceIds=["not-declared"];assert.equal(validateAgentEvaluationCorpus(bad).valid,false);
  const unsafe=structuredClone(corpusRaw);unsafe.cases[0].scope.allowedPaths=["../src/**"];assert.equal(validateAgentEvaluationCorpus(unsafe).valid,false);
});

test("evaluation run validates exact unique case outputs",()=>{
  assert.equal(validateAgentEvaluationRun(runRaw()).valid,true);
  const duplicate=runRaw();duplicate.results.push(structuredClone(duplicate.results[0]));assert.equal(validateAgentEvaluationRun(duplicate).valid,false);
});

test("baseline synthetic outputs pass every deterministic case",()=>{
  const run=validateAgentEvaluationRun(runRaw());assert.equal(run.valid,true);if(!run.valid||!run.run)return;
  const report=evaluateAgentCorpus(corpus(),run.run);assert.equal(report.overallStatus,"PASS");assert.deepEqual(report.summary,{pass:3,fail:0});
});
test("missing case and unknown case are deterministic failures",()=>{
  const raw=runRaw();raw.results=raw.results.slice(0,2);raw.results.push({caseId:"unknown-case",output:{}});const run=validateAgentEvaluationRun(raw);assert.equal(run.valid,true);if(!run.valid||!run.run)return;
  const report=evaluateAgentCorpus(corpus(),run.run);assert.equal(report.overallStatus,"FAIL");assert.equal(report.cases.some((/** @type {any} */ item)=>item.caseId==="review-unsafe-fallback-patch"&&item.status==="FAIL"),true);assert.equal(report.cases.some((/** @type {any} */ item)=>item.caseId==="unknown-case"&&item.status==="FAIL"),true);
});

test("diagnosis must cite required evidence and explicitly deny authority",()=>{
  const raw=runRaw();raw.results[0].output.hypotheses[0].evidenceIds=["contract-pass"];raw.results[0].output.rootCauseEstablished=true;const run=validateAgentEvaluationRun(raw);assert.equal(run.valid,true);if(!run.valid||!run.run)return;
  const report=evaluateAgentCorpus(corpus(),run.run);const c=report.cases.find((/** @type {any} */ item)=>item.caseId==="diagnose-fallback-regression");assert.equal(c?.status,"FAIL");assert.equal(c?.checks.some((/** @type {any} */ item)=>item.id==="evidence:ci-failure"&&item.status==="FAIL"),true);assert.equal(c?.checks.some((/** @type {any} */ item)=>item.id==="authority"&&item.status==="FAIL"),true);
});

test("reproduction test path and authority are measured against fixed scope",()=>{
  const raw=runRaw();raw.results[1].output.testPath="src/fallback.test.js";raw.results[1].output.mergeAuthorized=true;const run=validateAgentEvaluationRun(raw);assert.equal(run.valid,true);if(!run.valid||!run.run)return;
  const c=evaluateAgentCorpus(corpus(),run.run).cases.find((/** @type {any} */ item)=>item.caseId==="reproduce-fallback-regression");assert.equal(c?.status,"FAIL");assert.equal(c?.checks.some((/** @type {any} */ item)=>item.id==="test-path"&&item.status==="FAIL"),true);assert.equal(c?.checks.some((/** @type {any} */ item)=>item.id==="authority"&&item.status==="FAIL"),true);
});
test("review must report required evidence and remain non-approving",()=>{
  const raw=runRaw();raw.results[2].output.findings[0].evidenceIds=["contract-pass"];raw.results[2].output.approvalEstablished=true;const run=validateAgentEvaluationRun(raw);assert.equal(run.valid,true);if(!run.valid||!run.run)return;
  const c=evaluateAgentCorpus(corpus(),run.run).cases.find((/** @type {any} */ item)=>item.caseId==="review-unsafe-fallback-patch");assert.equal(c?.status,"FAIL");assert.equal(c?.checks.some((/** @type {any} */ item)=>item.id==="evidence:ci-failure"&&item.status==="FAIL"),true);assert.equal(c?.checks.some((/** @type {any} */ item)=>item.id==="authority"&&item.status==="FAIL"),true);
});

test("human report exposes criteria without inventing a numeric model score",()=>{
  const run=validateAgentEvaluationRun(runRaw());if(!run.valid||!run.run)throw new Error("bad run");const text=formatAgentEvaluation(evaluateAgentCorpus(corpus(),run.run));
  assert.match(text,/Cases: 3 pass, 0 fail/);assert.match(text,/Overall: PASS/);assert.doesNotMatch(text,/score|percent|rating/i);
});

test("CLI evaluates explicit corpus and run files with PASS and FAIL exit semantics",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"agent-eval-"));const corpusFile=path.join(root,"corpus.json"),runFile=path.join(root,"run.json");fs.writeFileSync(corpusFile,JSON.stringify(corpusRaw));fs.writeFileSync(runFile,JSON.stringify(runRaw()));const original=console.log;let stdout="";console.log=(...values)=>{stdout+=`${values.join(" ")}\n`;};
  try{assert.equal(main(["--corpus",corpusFile,"--run",runFile,"--json"]),0);assert.equal(JSON.parse(stdout).overallStatus,"PASS");stdout="";const failing=runRaw();failing.results[1].output.failureObserved=true;fs.writeFileSync(runFile,JSON.stringify(failing));assert.equal(main(["--corpus",corpusFile,"--run",runFile,"--json"]),1);assert.equal(JSON.parse(stdout).overallStatus,"FAIL");}finally{console.log=original;fs.rmSync(root,{recursive:true,force:true});}
});

test("evaluation engine is offline read-only and contains no model invocation surface",()=>{
  const source=fs.readFileSync(new URL("../scripts/agent-evaluation-corpus.js",import.meta.url),"utf8");assert.doesNotMatch(source,/node:child_process|spawnSync|execFile|writeFile|appendFile|\bfetch\s*\(|https?:\/\/|invokeAgent|process\.env/);
});
test("checked-in synthetic reference run passes the checked-in corpus",()=>{
  const raw=JSON.parse(fs.readFileSync(new URL("../evaluation/agent-reference-run.v1.json",import.meta.url),"utf8"));const validated=validateAgentEvaluationRun(raw);assert.equal(validated.valid,true,JSON.stringify(validated.errors));if(!validated.valid||!validated.run)return;
  const report=evaluateAgentCorpus(corpus(),validated.run);assert.equal(report.overallStatus,"PASS");assert.deepEqual(report.summary,{pass:3,fail:0});
});
