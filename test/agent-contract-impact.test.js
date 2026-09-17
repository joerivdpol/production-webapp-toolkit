import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateAgentTask } from "../scripts/agent-task.js";
import { validateAgentRolePolicy } from "../scripts/agent-role-policy.js";
import {
  validateAgentContractImpactInput,
  validateAgentContractImpactResult,
  runAgentContractImpact,
  main,
} from "../scripts/agent-contract-impact.js";

const PROVIDER_COMMIT="a".repeat(40),CONSUMER_COMMIT="b".repeat(40);
/** @param {boolean} [expected] @returns {any} */
function rawInput(expected=true){return{version:1,taskId:"task:contract-impact",repositories:[{id:"provider",commit:PROVIDER_COMMIT},{id:"consumer",commit:CONSUMER_COMMIT}],crossContractPolicy:{version:1,requirements:[{contractId:"public-api",repositories:["provider","consumer"],...(expected?{expectedVersion:"v2"}:{})}]},inventories:[{version:1,repository:"provider",contracts:[{id:"public-api",version:"v2"}]},{version:1,repository:"consumer",contracts:[{id:"public-api",version:"v1"}]}],evidence:[{id:"edge-evidence",source:"consumer-import",status:"INFO",summary:"Consumer uses the explicit public API contract",repository:"consumer",path:"src/client.ts"}],relationships:[{id:"edge-one",contractId:"public-api",providerRepository:"provider",consumerRepository:"consumer",providerPaths:["src/api.ts"],consumerPaths:["src/client.ts"],evidenceIds:["edge-evidence"]}],unknowns:[]};}
/** @returns {any} */
function rawResult(auditId="audit:public-api:contract-version-mismatch"){return{version:1,taskId:"task:contract-impact",impacts:[{id:"impact-one",contractId:"public-api",relationshipIds:["edge-one"],auditIds:[auditId],evidenceIds:["edge-evidence"],affected:[{repository:"provider",paths:["src/api.ts"]},{repository:"consumer",paths:["src/client.ts"]}],verification:[{kind:"INSPECT",repository:"provider",instruction:"Inspect the provider contract implementation"},{kind:"TEST",repository:"consumer",instruction:"Run the consumer compatibility tests"}]}],unknowns:[]};}
function inputValue(expected=true){const result=validateAgentContractImpactInput(rawInput(expected));assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.input)throw new Error("bad input fixture");return result.input;}
/** @returns {any} */
function rawTask(){return{version:1,id:"task:contract-impact",role:"contract",repository:{id:"provider",baseCommit:PROVIDER_COMMIT},createdAt:"2026-09-17T16:00:00Z",risk:"HIGH",objective:"Map explicit cross-repository contract impact",authority:{filesystem:"READ_ONLY",shell:"NONE",network:"NONE",merge:false,deploy:false,productionMutation:false},scope:{allowedPaths:["src/**"],deniedPaths:[],requiredChecks:["cross-contracts"]},dependsOn:[]};}
/** @returns {any} */
function rawRoles(){return{version:1,roles:[{id:"contract",maxRisk:"CRITICAL",authority:{filesystem:"READ_ONLY",shell:"BOUNDED",network:"NONE"},writeMode:"NONE"}]};}
function taskValue(){const result=validateAgentTask(rawTask());assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.task)throw new Error("bad task fixture");return result.task;}
function roleValue(){const result=validateAgentRolePolicy(rawRoles());assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.policy)throw new Error("bad role fixture");return result.policy;}
/** @param {any} request @param {string} content */
function modelResponse(request,content){return{version:1,backend:request.backend,model:request.model,content,finishReason:"stop",usage:{inputTokens:100,outputTokens:100},semantics:"synthetic normalized response"};}
test("contract impact input composes canonical policy inventories and deterministic mismatch audit",()=>{
  const input=inputValue(true);assert.equal(input.audit.overallStatus,"FAIL");assert.equal(input.audit.findings.at(0)?.id,"audit:public-api:contract-version-mismatch");
});

test("consensus drift remains distinct when no expected version exists",()=>{
  const input=inputValue(false);assert.equal(input.audit.findings.at(0)?.id,"audit:public-api:contract-version-drift");const result=validateAgentContractImpactResult(rawResult("audit:public-api:contract-version-drift"),input);assert.equal(result.valid,true,JSON.stringify(result.errors));assert.equal(result.result?.impacts.at(0)?.kind,"VERSION_DRIFT");assert.equal(result.result?.impacts.at(0)?.expectedVersion,null);assert.equal(result.result?.canonicalVersionSelectedByAgent,false);
});

test("explicit expected version remains caller policy truth in normalized impact",()=>{
  const input=inputValue(true),result=validateAgentContractImpactResult(rawResult(),input);assert.equal(result.valid,true,JSON.stringify(result.errors));assert.equal(result.result?.impacts.at(0)?.kind,"VERSION_MISMATCH");assert.equal(result.result?.impacts.at(0)?.expectedVersion,"v2");
});

test("missing required contract declaration is deterministic CONTRACT_MISSING impact kind",()=>{
  const raw=rawInput(true);raw.inventories[1].contracts=[{id:"other-contract",version:"v1"}];const validated=validateAgentContractImpactInput(raw);assert.equal(validated.valid,true,JSON.stringify(validated.errors));if(!validated.valid||!validated.input)return;assert.equal(validated.input.audit.findings.at(0)?.id,"audit:public-api:contract-missing");const resultRaw=rawResult("audit:public-api:contract-missing"),result=validateAgentContractImpactResult(resultRaw,validated.input);assert.equal(result.valid,true,JSON.stringify(result.errors));assert.equal(result.result?.impacts.at(0)?.kind,"CONTRACT_MISSING");
});
test("input requires every policy repository inventory and explicit relationship coverage",()=>{
  const missingInventory=rawInput(true);missingInventory.inventories=missingInventory.inventories.slice(0,1);assert.equal(validateAgentContractImpactInput(missingInventory).valid,false);
  const raw=rawInput(true);raw.repositories.push({id:"third",commit:"c".repeat(40)});raw.inventories.push({version:1,repository:"third",contracts:[{id:"public-api",version:"v2"}]});raw.crossContractPolicy.requirements[0].repositories=["provider","consumer","third"];assert.equal(validateAgentContractImpactInput(raw).valid,false);
});

test("relationship must bind declared policy repositories contract and evidence",()=>{
  const unknownEvidence=rawInput(true);unknownEvidence.relationships[0].evidenceIds=["missing-evidence"];assert.equal(validateAgentContractImpactInput(unknownEvidence).valid,false);
  const wrongContract=rawInput(true);wrongContract.relationships[0].contractId="invented-contract";assert.equal(validateAgentContractImpactInput(wrongContract).valid,false);
  const wrongRepo=rawInput(true);wrongRepo.relationships[0].consumerRepository="unknown";assert.equal(validateAgentContractImpactInput(wrongRepo).valid,false);
});

test("impact paths must come from referenced provider-consumer relationships",()=>{
  const input=inputValue(true),bad=rawResult();bad.impacts[0].affected[1].paths=["src/unbound.ts"];
  assert.equal(validateAgentContractImpactResult(bad,input).valid,false);
});

test("impact evidence must overlap evidence bound to referenced relationship",()=>{
  const raw=rawInput(true);raw.evidence.push({id:"unrelated",source:"note",status:"INFO",summary:"Unrelated explicit observation",repository:"provider",path:"src/other.ts"});const validated=validateAgentContractImpactInput(raw);assert.equal(validated.valid,true,JSON.stringify(validated.errors));if(!validated.valid||!validated.input)return;const bad=rawResult();bad.impacts[0].evidenceIds=["unrelated"];assert.equal(validateAgentContractImpactResult(bad,validated.input).valid,false);
});

test("impact audit ids must match the same explicit contract",()=>{
  const input=inputValue(true),bad=rawResult();bad.impacts[0].auditIds=["audit:other:contract-version-mismatch"];assert.equal(validateAgentContractImpactResult(bad,input).valid,false);
});
test("every deterministic FAIL must be covered by a model impact",()=>{
  const input=inputValue(true),bad={version:1,taskId:input.taskId,impacts:[],unknowns:[]};const result=validateAgentContractImpactResult(bad,input);assert.equal(result.valid,false);assert.equal(result.errors.some((item)=>item.id==="deterministic-failure-uncovered"),true);
});

test("clean deterministic contract audit permits no-impact result",()=>{
  const raw=rawInput(true);raw.inventories[1].contracts[0].version="v2";const validated=validateAgentContractImpactInput(raw);assert.equal(validated.valid,true,JSON.stringify(validated.errors));if(!validated.valid||!validated.input)return;assert.equal(validated.input.audit.overallStatus,"PASS");const result=validateAgentContractImpactResult({version:1,taskId:validated.input.taskId,impacts:[],unknowns:[]},validated.input);assert.equal(result.valid,true,JSON.stringify(result.errors));assert.equal(result.result?.status,"NO_IMPACTS_REPORTED");
});

test("model cannot inject expectedVersion or impact kind into proposal schema",()=>{
  const input=inputValue(true),bad=rawResult();bad.impacts[0].expectedVersion="v999";bad.impacts[0].kind="VERSION_MISMATCH";assert.equal(validateAgentContractImpactResult(bad,input).valid,false);
});

test("verification is restricted to affected repositories and read-only action classes",()=>{
  const input=inputValue(true),outside=rawResult();outside.impacts[0].verification[0].repository="other";assert.equal(validateAgentContractImpactResult(outside,input).valid,false);const patch=rawResult();patch.impacts[0].verification[0].kind="PATCH";assert.equal(validateAgentContractImpactResult(patch,input).valid,false);
});

test("normalized result keeps deterministic audit authoritative and all mutation authority false",()=>{
  const input=inputValue(true),result=validateAgentContractImpactResult(rawResult(),input);assert.equal(result.valid,true,JSON.stringify(result.errors));assert.equal(result.result?.deterministicAudit.overallStatus,"FAIL");assert.equal(result.result?.canonicalVersionSelectedByAgent,false);assert.equal(result.result?.sourceMutationAuthorized,false);assert.equal(result.result?.mergeAuthorized,false);assert.equal(result.result?.deployAuthorized,false);
});
test("contract impact agent returns deterministic-enriched read-only impact",async()=>{
  const input=inputValue(true),invoke=async(/** @type {any} */_config,/** @type {any} */request)=>modelResponse(request,JSON.stringify(rawResult()));const result=await runAgentContractImpact(taskValue(),roleValue(),input,{},"local","contract",{invoke});assert.equal(result.status,"IMPACTS_REPORTED");assert.equal(result.impacts.at(0)?.kind,"VERSION_MISMATCH");assert.equal(result.impacts.at(0)?.expectedVersion,"v2");assert.equal(result.canonicalVersionSelectedByAgent,false);assert.equal(result.executionAuthorized,false);
});

test("contract agent requires exact read-only authority and repository binding before model",async()=>{
  const input=inputValue(true);let invoked=false;const invoke=async()=>{invoked=true;throw new Error("unexpected model call");};const shellTask=taskValue();shellTask.authority.shell="BOUNDED";await assert.rejects(()=>runAgentContractImpact(shellTask,roleValue(),input,{},"local","contract",{invoke}),/shell NONE and network NONE/);assert.equal(invoked,false);const wrongTask=taskValue();wrongTask.repository.baseCommit="c".repeat(40);await assert.rejects(()=>runAgentContractImpact(wrongTask,roleValue(),input,{},"local","contract",{invoke}),/repository identity/);assert.equal(invoked,false);
});

test("model omission of deterministic failure fails closed",async()=>{
  const input=inputValue(true),invoke=async(/** @type {any} */_config,/** @type {any} */request)=>modelResponse(request,JSON.stringify({version:1,taskId:input.taskId,impacts:[],unknowns:[]}));await assert.rejects(()=>runAgentContractImpact(taskValue(),roleValue(),input,{},"local","contract",{invoke}),/failed Contract Impact Result/);
});

test("normalized agent output omits raw evidence summaries and inventory payloads",async()=>{
  const input=inputValue(true),invoke=async(/** @type {any} */_config,/** @type {any} */request)=>modelResponse(request,JSON.stringify(rawResult()));const result=await runAgentContractImpact(taskValue(),roleValue(),input,{},"local","contract",{invoke});const output=JSON.stringify(result);assert.doesNotMatch(output,/Consumer uses the explicit public API contract/);assert.doesNotMatch(output,/"contracts":/);assert.match(output,/contract-version-mismatch/);
});
test("CLI composes explicit private contract-impact inputs with injected local model",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"agent-contract-impact-")),taskFile=path.join(root,"task.json"),roleFile=path.join(root,"roles.json"),inputFile=path.join(root,"input.json"),modelFile=path.join(root,"models.json");fs.writeFileSync(taskFile,JSON.stringify(rawTask()));fs.writeFileSync(roleFile,JSON.stringify(rawRoles()));fs.writeFileSync(inputFile,JSON.stringify(rawInput(true)));fs.writeFileSync(modelFile,JSON.stringify({version:1,backends:[{id:"local",type:"OLLAMA",baseUrl:"http://127.0.0.1:11434",models:[{id:"contract",providerModel:"private",thinking:"DISABLED"}]}]}));
  const invoke=async(/** @type {any} */_config,/** @type {any} */request)=>modelResponse(request,JSON.stringify(rawResult())),original=console.log;let stdout="";console.log=(...values)=>{stdout+=`${values.join(" ")}\n`;};
  try{assert.equal(await main(["--task",taskFile,"--role-policy",roleFile,"--input",inputFile,"--model-config",modelFile,"--backend","local","--model","contract","--json"],{invoke}),0);}finally{console.log=original;fs.rmSync(root,{recursive:true,force:true});}
  const parsed=JSON.parse(stdout);assert.equal(parsed.status,"IMPACTS_REPORTED");assert.doesNotMatch(stdout,/127\.0\.0\.1|providerModel|Consumer uses the explicit/);
});

test("contract impact CLI rejects incomplete and unknown input",async()=>{assert.equal(await main([]),1);assert.equal(await main(["--unknown","x"]),1);});

test("contract impact source is offline read-only and delegates canonical contract validators",()=>{
  const source=fs.readFileSync(new URL("../scripts/agent-contract-impact.js",import.meta.url),"utf8");assert.match(source,/validateContractInventory/);assert.match(source,/validateCrossContractPolicy/);assert.match(source,/inspectCrossRepositoryContracts/);assert.doesNotMatch(source,/node:child_process|spawnSync|execFile|writeFile|appendFile|rmSync|renameSync|\bfetch\s*\(|https?:\/\/|\bssh\b|\bdocker\b|\bkubectl\b|process\.env/);
});
