import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { validateAgentTask } from "../scripts/agent-task.js";
import { validateAgentRolePolicy } from "../scripts/agent-role-policy.js";
import {
  classifyDependencyVersionChange,
  validateAgentDependencyMaintenanceInput,
  validateAgentDependencyMaintenanceResult,
  runAgentDependencyMaintenance,
  main,
} from "../scripts/agent-dependency-maintenance.js";

const COMMIT="a".repeat(40);
/** @returns {any} */
function rawInput(){return{version:1,taskId:"task:dependency",repository:{id:"demo",commit:COMMIT},generator:{id:"renovate-run",type:"RENOVATE",authenticated:false},changes:[{id:"change-a",ecosystem:"NPM",package:"package-a",fromVersion:"1.2.3",toVersion:"1.3.0",relationship:"PRODUCTION",manifestPath:"package.json",lockfilePath:"bun.lock"},{id:"change-b",ecosystem:"NPM",package:"package-b",fromVersion:"2.0.0",toVersion:"3.0.0",relationship:"DEVELOPMENT",manifestPath:"package.json",lockfilePath:"bun.lock"}],changedPaths:["package.json","bun.lock"],evidence:[{id:"generator-evidence",source:"deterministic-updater",status:"INFO",summary:"The updater proposed these exact dependency versions",changeIds:["change-a","change-b"],path:"package.json"}],unknowns:[]};}
/** @returns {any} */
function rawResult(){return{version:1,taskId:"task:dependency",updates:[{changeId:"change-a",evidenceIds:["generator-evidence"],concerns:[{id:"concern-a",severity:"INFO",statement:"The minor update should retain focused compatibility coverage",evidenceIds:["generator-evidence"]}],verification:[{kind:"TEST",instruction:"Run focused production dependency tests"}]},{changeId:"change-b",evidenceIds:["generator-evidence"],concerns:[{id:"concern-b",severity:"WARN",statement:"The major update warrants explicit compatibility verification",evidenceIds:["generator-evidence"]}],verification:[{kind:"TEST",instruction:"Run tooling and build compatibility tests"}]}],unknowns:[]};}

/** @returns {any} */
function rawTask(){return{version:1,id:"task:dependency",role:"dependency",repository:{id:"demo",baseCommit:COMMIT},createdAt:"2026-09-17T14:30:00Z",risk:"MEDIUM",objective:"Review a deterministic dependency update",authority:{filesystem:"READ_ONLY",shell:"NONE",network:"NONE",merge:false,deploy:false,productionMutation:false},scope:{allowedPaths:["package.json","bun.lock"],deniedPaths:[],requiredChecks:["test","typecheck","build"]},dependsOn:[]};}
/** @returns {any} */
function rawRoles(){return{version:1,roles:[{id:"dependency",maxRisk:"MEDIUM",authority:{filesystem:"READ_ONLY",shell:"BOUNDED",network:"READ_ONLY"},writeMode:"NONE"}]};}
function task(){const result=validateAgentTask(rawTask());assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.task)throw new Error("bad task fixture");return result.task;}
function roles(){const result=validateAgentRolePolicy(rawRoles());assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.policy)throw new Error("bad role fixture");return result.policy;}
function input(){const result=validateAgentDependencyMaintenanceInput(rawInput());assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.input)throw new Error("bad input fixture");return result.input;}
/** @param {any} request @param {string} content */
function modelResponse(request,content){return{version:1,backend:request.backend,model:request.model,content,finishReason:"stop",usage:{inputTokens:100,outputTokens:100},semantics:"synthetic normalized response"};}

test("version classification is deterministic for exact semver",()=>{
  assert.equal(classifyDependencyVersionChange("1.2.3","1.2.4"),"PATCH");
  assert.equal(classifyDependencyVersionChange("1.2.3","1.3.0"),"MINOR");
  assert.equal(classifyDependencyVersionChange("1.2.3","2.0.0"),"MAJOR");
  assert.equal(classifyDependencyVersionChange("2.0.0","1.9.9"),"DOWNGRADE");
  assert.equal(classifyDependencyVersionChange("1.2.3","1.2.3"),"SAME");
  assert.equal(classifyDependencyVersionChange("^1.2.3","1.3.0"),"NON_SEMVER");
});
test("input derives update classes and requires changed-path binding",()=>{
  const result=validateAgentDependencyMaintenanceInput(rawInput());assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.deepEqual(result.input?.summary,{patch:0,minor:1,major:1,downgrade:0,nonSemver:0});
  assert.equal(result.input?.changes[0].updateClass,"MINOR");assert.equal(result.input?.changes[1].updateClass,"MAJOR");
  const bad=rawInput();bad.changedPaths=["package.json"];assert.equal(validateAgentDependencyMaintenanceInput(bad).valid,false);
});

test("input requires evidence coverage for every dependency change",()=>{
  const bad=rawInput();bad.evidence[0].changeIds=["change-a"];
  const result=validateAgentDependencyMaintenanceInput(bad);assert.equal(result.valid,false);assert.ok(result.errors.some((item)=>item.id==="change-evidence-missing"));
});

test("generator authentication remains metadata not update approval",()=>{
  const raw=rawInput();raw.generator.authenticated=true;const result=validateAgentDependencyMaintenanceInput(raw);
  assert.equal(result.valid,true);assert.equal(result.input?.generator.authenticated,true);
});

test("input rejects unchanged duplicate and unbound changes",()=>{
  const unchanged=rawInput();unchanged.changes[0].toVersion=unchanged.changes[0].fromVersion;assert.equal(validateAgentDependencyMaintenanceInput(unchanged).valid,false);
  const duplicate=rawInput();duplicate.changes.push({...duplicate.changes[0]});assert.equal(validateAgentDependencyMaintenanceInput(duplicate).valid,false);
  const outside=rawInput();outside.changes[0].manifestPath="other.json";assert.equal(validateAgentDependencyMaintenanceInput(outside).valid,false);
});
test("result must analyze every declared change exactly once",()=>{
  const maintenance=input(),bad=rawResult();bad.updates.pop();
  const result=validateAgentDependencyMaintenanceResult(bad,maintenance);assert.equal(result.valid,false);assert.ok(result.errors.some((item)=>item.id==="change-analysis-missing"));
  const duplicate=rawResult();duplicate.updates.push({...duplicate.updates[0]});assert.equal(validateAgentDependencyMaintenanceResult(duplicate,maintenance).valid,false);
});

test("update and concern evidence must be bound to the same change",()=>{
  const maintenance=input(),bad=rawResult();bad.updates[0].evidenceIds=["generator-evidence"];
  bad.updates[0].concerns[0].evidenceIds=["generator-evidence"];assert.equal(validateAgentDependencyMaintenanceResult(bad,maintenance).valid,true);
  const split=rawInput();split.evidence=[{id:"a-evidence",source:"deterministic-updater",status:"INFO",summary:"A",changeIds:["change-a"],path:"package.json"},{id:"b-evidence",source:"deterministic-updater",status:"INFO",summary:"B",changeIds:["change-b"],path:"package.json"}];
  const splitResult=validateAgentDependencyMaintenanceInput(split);assert.equal(splitResult.valid,true);if(!splitResult.valid||!splitResult.input)throw new Error("bad split fixture");
  const wrong=rawResult();wrong.updates[0].evidenceIds=["b-evidence"];wrong.updates[0].concerns[0].evidenceIds=["b-evidence"];wrong.updates[1].evidenceIds=["b-evidence"];wrong.updates[1].concerns[0].evidenceIds=["b-evidence"];
  assert.equal(validateAgentDependencyMaintenanceResult(wrong,splitResult.input).valid,false);
});

test("model cannot inject version class approval or mutation fields",()=>{
  const maintenance=input(),bad=rawResult();bad.updates[0].updateClass="SAFE";assert.equal(validateAgentDependencyMaintenanceResult(bad,maintenance).valid,false);
  const approval=rawResult();approval.approved=true;assert.equal(validateAgentDependencyMaintenanceResult(approval,maintenance).valid,false);
});
test("verification remains proposal-only and bounded to read-only action classes",()=>{
  const maintenance=input(),bad=rawResult();bad.updates[0].verification[0].kind="PATCH";
  assert.equal(validateAgentDependencyMaintenanceResult(bad,maintenance).valid,false);
});

test("normalized result preserves deterministic classes and denies all execution authority",()=>{
  const maintenance=input(),result=validateAgentDependencyMaintenanceResult(rawResult(),maintenance);assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(result.result?.updates[0].change.updateClass,"MINOR");assert.equal(result.result?.updates[1].change.updateClass,"MAJOR");
  assert.equal(result.result?.packageMutationPerformed,false);assert.equal(result.result?.sourceMutationAuthorized,false);assert.equal(result.result?.executionAuthorized,false);assert.equal(result.result?.approvalEstablished,false);assert.equal(result.result?.mergeAuthorized,false);assert.equal(result.result?.deployAuthorized,false);
});

test("dependency agent returns evidence-bound notes over deterministic proposal",async()=>{
  const invoke=async(/** @type {any} */_config,/** @type {any} */request)=>modelResponse(request,JSON.stringify(rawResult()));
  const result=await runAgentDependencyMaintenance(task(),roles(),input(),{},"local","dependency",{invoke});
  assert.equal(result.status,"MAINTENANCE_NOTES_REPORTED");assert.equal(result.deterministicSummary.major,1);assert.equal(result.packageMutationPerformed,false);assert.equal(result.rolePolicyStatus,"PASS");
});

test("agent rejects write shell network and repository mismatch before model",async()=>{
  let invoked=false;const invoke=async()=>{invoked=true;throw new Error("unexpected model call");};
  const writeTask=task();writeTask.authority.filesystem="WORKTREE_WRITE";await assert.rejects(()=>runAgentDependencyMaintenance(writeTask,roles(),input(),{},"local","dependency",{invoke}),/READ_ONLY/);assert.equal(invoked,false);
  const shellTask=task();shellTask.authority.shell="BOUNDED";await assert.rejects(()=>runAgentDependencyMaintenance(shellTask,roles(),input(),{},"local","dependency",{invoke}),/shell NONE/);assert.equal(invoked,false);
  const networkTask=task();networkTask.authority.network="READ_ONLY";await assert.rejects(()=>runAgentDependencyMaintenance(networkTask,roles(),input(),{},"local","dependency",{invoke}),/network NONE/);assert.equal(invoked,false);
  const wrong=input();wrong.repository.commit="b".repeat(40);await assert.rejects(()=>runAgentDependencyMaintenance(task(),roles(),wrong,{},"local","dependency",{invoke}),/exact Agent Task/);assert.equal(invoked,false);
});
test("normalized output omits raw evidence summaries and changed-path payload",async()=>{
  const invoke=async(/** @type {any} */_config,/** @type {any} */request)=>modelResponse(request,JSON.stringify(rawResult()));
  const result=await runAgentDependencyMaintenance(task(),roles(),input(),{},"local","dependency",{invoke});const output=JSON.stringify(result);
  assert.doesNotMatch(output,/The updater proposed these exact dependency versions/);assert.doesNotMatch(output,/changedPaths/);assert.match(output,/package-a/);
});

test("CLI composes explicit files with injected local model",async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"agent-dependency-")),taskFile=path.join(root,"task.json"),roleFile=path.join(root,"roles.json"),inputFile=path.join(root,"input.json"),modelFile=path.join(root,"models.json");
  fs.writeFileSync(taskFile,JSON.stringify(rawTask()));fs.writeFileSync(roleFile,JSON.stringify(rawRoles()));fs.writeFileSync(inputFile,JSON.stringify(rawInput()));fs.writeFileSync(modelFile,JSON.stringify({version:1,backends:[{id:"local",type:"OLLAMA",baseUrl:"http://127.0.0.1:11434",models:[{id:"dependency",providerModel:"private",thinking:"DISABLED"}]}]}));
  const invoke=async(/** @type {any} */_config,/** @type {any} */request)=>modelResponse(request,JSON.stringify(rawResult()));const original=console.log;let stdout="";console.log=(...values)=>{stdout+=`${values.join(" ")}\n`;};
  try{assert.equal(await main(["--task",taskFile,"--role-policy",roleFile,"--input",inputFile,"--model-config",modelFile,"--backend","local","--model","dependency","--json"],{invoke}),0);}finally{console.log=original;fs.rmSync(root,{recursive:true,force:true});}
  const parsed=JSON.parse(stdout);assert.equal(parsed.status,"MAINTENANCE_NOTES_REPORTED");assert.equal(parsed.packageMutationPerformed,false);assert.doesNotMatch(stdout,/The updater proposed these exact dependency versions/);
});

test("dependency source exposes no package-manager subprocess mutation or deployment surface",()=>{
  const source=fs.readFileSync(new URL("../scripts/agent-dependency-maintenance.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/node:child_process|spawnSync|execSync|writeFileSync|unlinkSync|renameSync/);assert.doesNotMatch(source,/\bnpm\b|\byarn\b|\bpnpm\b|\bbun\s+(?:add|update|install)\b/);assert.doesNotMatch(source,/deployAuthorized:\s*true|mergeAuthorized:\s*true|approvalEstablished:\s*true/);
});

test("dependency CLI fails closed on incomplete and unknown input",async()=>{
  assert.equal(await main([]),1);assert.equal(await main(["--task","x","--unknown","y"]),1);
});