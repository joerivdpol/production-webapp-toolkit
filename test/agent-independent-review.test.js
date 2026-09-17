import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";

import { validateAgentTask } from "../scripts/agent-task.js";
import { validateAgentRolePolicy } from "../scripts/agent-role-policy.js";
import {
  validateAgentReviewInput,
  validateAgentReviewResult,
  runAgentIndependentReview,
  main,
} from "../scripts/agent-independent-review.js";

const COMMIT="a".repeat(40);
/** @param {string} value */
function digest(value){return crypto.createHash("sha256").update(value).digest("hex");}
/** @returns {any} */
function rawTask(){return{version:1,id:"task:review",role:"review",repository:{id:"demo",baseCommit:COMMIT},createdAt:"2026-09-17T13:00:00Z",risk:"HIGH",objective:"Independently review the proposal",authority:{filesystem:"READ_ONLY",shell:"NONE",network:"NONE",merge:false,deploy:false,productionMutation:false},scope:{allowedPaths:["src/**","test/**"],deniedPaths:[],requiredChecks:["test"]},dependsOn:["task:proposal"]};}
/** @returns {any} */
function rawRoles(){return{version:1,roles:[{id:"review",maxRisk:"CRITICAL",authority:{filesystem:"READ_ONLY",shell:"BOUNDED",network:"NONE"},writeMode:"NONE"}]};}
/** @returns {any} */
function rawInput(){const content="diff --git a/src/value.js b/src/value.js\n+return fallback;\n";return{version:1,taskId:"task:review",repository:{id:"demo",commit:COMMIT},evidence:[{id:"ci-fail",source:"ci",status:"FAIL",summary:"Regression suite fails on the fallback branch",path:"src/value.js"},{id:"contract",source:"contract-audit",status:"PASS",summary:"Public response contract remains unchanged",path:"src/value.js"}],proposal:{id:"proposal-one",kind:"PATCH",sourceTaskId:"task:proposal",summary:"Change fallback branch",paths:["src/value.js"],content,sha256:digest(content),trust:"UNTRUSTED_PROPOSAL"},unknowns:["Runtime branch frequency is unknown"]};}
/** @returns {any} */
function rawResult(){return{version:1,taskId:"task:review",findings:[{id:"finding-one",severity:"BLOCKER",statement:"The fallback behavior can still violate the failing scenario",evidenceIds:["ci-fail"],proposalPaths:["src/value.js"],verification:[{kind:"TEST",instruction:"Run a focused regression covering the fallback branch"}]}],regressionGaps:[{id:"gap-one",statement:"No edge-case regression is demonstrated",evidenceIds:["ci-fail"],proposalPaths:["src/value.js"],testIdea:"Add an edge-case fallback assertion"}],unknowns:[]};}
function task(){const result=validateAgentTask(rawTask());assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.task)throw new Error("bad task fixture");return result.task;}
function roles(){const result=validateAgentRolePolicy(rawRoles());assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.policy)throw new Error("bad role fixture");return result.policy;}
function input(){const result=validateAgentReviewInput(rawInput());assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.input)throw new Error("bad review fixture");return result.input;}
/** @param {any} request @param {string} content */
function modelResponse(request,content){return{version:1,backend:request.backend,model:request.model,content,finishReason:"stop",usage:{inputTokens:100,outputTokens:100},semantics:"synthetic normalized response"};}
test("review input keeps proposal untrusted and hash-bound",()=>{
  const result=validateAgentReviewInput(rawInput());assert.equal(result.valid,true,JSON.stringify(result.errors));
  const tampered=rawInput();tampered.proposal.content+="x";assert.equal(validateAgentReviewInput(tampered).valid,false);
  const trusted=rawInput();trusted.proposal.trust="TRUSTED";assert.equal(validateAgentReviewInput(trusted).valid,false);
});

test("review result requires independent evidence for every finding",()=>{
  const review=input(),result=validateAgentReviewResult(rawResult(),new Set(review.evidence.map((item)=>item.id)),new Set(review.proposal.paths),review.taskId);
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  const bad=rawResult();bad.findings[0].evidenceIds=["proposal-one"];assert.equal(validateAgentReviewResult(bad,new Set(review.evidence.map((item)=>item.id)),new Set(review.proposal.paths),review.taskId).valid,false);
});

test("review result cannot cite paths outside proposal",()=>{
  const review=input(),bad=rawResult();bad.findings[0].proposalPaths=["src/other.js"];
  assert.equal(validateAgentReviewResult(bad,new Set(review.evidence.map((item)=>item.id)),new Set(review.proposal.paths),review.taskId).valid,false);
});
test("disposition is derived from validated findings and never establishes approval",()=>{
  const review=input(),ids=new Set(review.evidence.map((item)=>item.id),),paths=new Set(review.proposal.paths);
  let result=validateAgentReviewResult(rawResult(),ids,paths,review.taskId);assert.equal(result.result?.disposition,"BLOCKERS_REPORTED");assert.equal(result.result?.approvalEstablished,false);assert.equal(result.result?.mergeAuthorized,false);
  const warn=rawResult();warn.findings[0].severity="WARN";result=validateAgentReviewResult(warn,ids,paths,review.taskId);assert.equal(result.result?.disposition,"WARNINGS_REPORTED");
  const clean=rawResult();clean.findings=[];clean.regressionGaps=[];result=validateAgentReviewResult(clean,ids,paths,review.taskId);assert.equal(result.result?.disposition,"NO_BLOCKERS_REPORTED");assert.equal(result.result?.approvalEstablished,false);
});

test("verification actions remain read-only proposal classes",()=>{
  const review=input(),bad=rawResult();bad.findings[0].verification[0].kind="PATCH";
  assert.equal(validateAgentReviewResult(bad,new Set(review.evidence.map((item)=>item.id)),new Set(review.proposal.paths),review.taskId).valid,false);
});

test("review input rejects unknown fields unsafe paths and duplicate evidence",()=>{
  const duplicate=rawInput();duplicate.evidence.push({...duplicate.evidence[0]});assert.equal(validateAgentReviewInput(duplicate).valid,false);
  const unsafe=rawInput();unsafe.proposal.paths=["../secret"];assert.equal(validateAgentReviewInput(unsafe).valid,false);
  const unknown={...rawInput(),endpoint:"http://127.0.0.1"};assert.equal(validateAgentReviewInput(unknown).valid,false);
});
test("independent review returns evidence-bound findings over untrusted proposal",async()=>{
  const invoke=async(/** @type {any} */_config,/** @type {any} */request)=>modelResponse(request,JSON.stringify(rawResult()));
  const result=await runAgentIndependentReview(task(),roles(),input(),{},"local","review",{invoke});
  assert.equal(result.disposition,"BLOCKERS_REPORTED");assert.equal(result.proposal.trust,"UNTRUSTED_PROPOSAL");assert.equal(result.approvalEstablished,false);assert.equal(result.sourceMutationAuthorized,false);
});

test("review requires read-only authority exact binding and proposal dependency before model",async()=>{
  const reviewTask=task(),review=input();let invoked=false;const invoke=async()=>{invoked=true;throw new Error("unexpected model call");};
  reviewTask.authority.filesystem="WORKTREE_WRITE";
  await assert.rejects(()=>runAgentIndependentReview(reviewTask,roles(),review,{},"local","review",{invoke}),/READ_ONLY/);assert.equal(invoked,false);
  const noDep=task();noDep.dependsOn=[];await assert.rejects(()=>runAgentIndependentReview(noDep,roles(),review,{},"local","review",{invoke}),/depend/);assert.equal(invoked,false);
});

test("model output with prior proposal claim as fake evidence fails closed",async()=>{
  const bad=rawResult();bad.findings[0].evidenceIds=["proposal-one"];
  const invoke=async(/** @type {any} */_config,/** @type {any} */request)=>modelResponse(request,JSON.stringify(bad));
  await assert.rejects(()=>runAgentIndependentReview(task(),roles(),input(),{},"local","review",{invoke}),/failed Independent Review Result/);
});
test("review result output omits proposal content and independent evidence payloads",async()=>{
  const invoke=async(/** @type {any} */_config,/** @type {any} */request)=>modelResponse(request,JSON.stringify(rawResult()));
  const result=await runAgentIndependentReview(task(),roles(),input(),{},"local","review",{invoke});
  const output=JSON.stringify(result);assert.doesNotMatch(output,/diff --git|Regression suite fails/);assert.match(output,/proposal-one/);
});

test("CLI composes explicit private inputs with injected local model",async()=>{
  const root=fs.mkdtempSync("/tmp/agent-review-");const taskFile=`${root}/task.json`,roleFile=`${root}/roles.json`,inputFile=`${root}/input.json`,modelFile=`${root}/models.json`;
  fs.writeFileSync(taskFile,JSON.stringify(rawTask()));fs.writeFileSync(roleFile,JSON.stringify(rawRoles()));fs.writeFileSync(inputFile,JSON.stringify(rawInput()));fs.writeFileSync(modelFile,JSON.stringify({version:1,backends:[{id:"local",type:"OLLAMA",baseUrl:"http://127.0.0.1:11434",models:[{id:"review",providerModel:"private",thinking:"DISABLED"}]}]}));
  const invoke=async(/** @type {any} */_config,/** @type {any} */request)=>modelResponse(request,JSON.stringify(rawResult()));const original=console.log;let stdout="";console.log=(...values)=>{stdout+=`${values.join(" ")}\n`;};
  try{assert.equal(await main(["--task",taskFile,"--role-policy",roleFile,"--input",inputFile,"--model-config",modelFile,"--backend","local","--model","review","--json"],{invoke}),0);}finally{console.log=original;fs.rmSync(root,{recursive:true,force:true});}
  const parsed=JSON.parse(stdout);assert.equal(parsed.disposition,"BLOCKERS_REPORTED");assert.doesNotMatch(stdout,/private|diff --git/);
});

test("review source has no mutation subprocess transport or execution surface",()=>{
  const source=fs.readFileSync(new URL("../scripts/agent-independent-review.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/node:child_process|spawnSync|execFile|writeFile|appendFile|rmSync|renameSync|\bfetch\s*\(|https?:\/\/|\bssh\b|\bdocker\b|\bkubectl\b|process\.env/);
});
