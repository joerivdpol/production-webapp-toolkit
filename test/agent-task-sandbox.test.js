import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { validateAgentTask } from "../scripts/agent-task.js";
import { validateAgentRolePolicy } from "../scripts/agent-role-policy.js";
import { openAgentTaskRegistry, registerAgentTask, transitionAgentTask } from "../scripts/agent-task-registry.js";
import { acquireAgentWorkerLease } from "../scripts/agent-worker-lease.js";
import {
  validateAgentSandboxPolicy,
  deriveAgentSandboxId,
  createAgentTaskSandbox,
  inspectAgentTaskSandbox,
  buildAgentSandboxInvocation,
  runAgentSandboxCommand,
  cleanupAgentTaskSandbox,
  main,
} from "../scripts/agent-task-sandbox.js";

const T0="2026-09-17T15:00:00Z",T1="2026-09-17T15:01:00Z",T2="2026-09-17T15:20:00Z";
/** @param {string} cwd @param {string[]} args */
function git(cwd,args){const result=spawnSync("git",args,{cwd,encoding:"utf8"});if(result.status!==0)throw new Error(`fixture git failed: ${args.join(" ")}`);return result.stdout.trim();}

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"agent-sandbox-")),repo=path.join(root,"repo"),sandboxes=path.join(root,"sandboxes");
  fs.mkdirSync(repo);fs.mkdirSync(sandboxes);git(repo,["init","-q"]);git(repo,["config","user.email","sandbox@example.invalid"]);git(repo,["config","user.name","Sandbox Test"]);
  fs.writeFileSync(path.join(repo,"README.md"),"# Sandbox fixture\n");fs.writeFileSync(path.join(repo,"package.json"),"{\"name\":\"sandbox-fixture\",\"private\":true}\n");
  git(repo,["add","."]);git(repo,["commit","-qm","initial"]);const commit=git(repo,["rev-parse","HEAD"]);return{root,repo,sandboxes,commit};
}

/** @param {string} commit @param {"WORKTREE_WRITE"|"READ_ONLY"} [filesystem] */
function rawTask(commit,filesystem="WORKTREE_WRITE"){const write=filesystem==="WORKTREE_WRITE";return{version:1,id:write?"task:sandbox-write":"task:sandbox-read",role:write?"repair":"diagnose",repository:{id:"demo",baseCommit:commit},createdAt:T0,risk:"LOW",objective:"Execute one bounded sandbox command",authority:{filesystem,shell:"NONE",network:"NONE",merge:false,deploy:false,productionMutation:false},scope:{allowedPaths:["**"],deniedPaths:[],requiredChecks:["test"]},dependsOn:[]};}
/** @returns {any} */
function rawRoles(){return{version:1,roles:[{id:"repair",maxRisk:"MEDIUM",authority:{filesystem:"WORKTREE_WRITE",shell:"BOUNDED",network:"NONE"},writeMode:"LEASED_WORKTREE"},{id:"diagnose",maxRisk:"CRITICAL",authority:{filesystem:"READ_ONLY",shell:"BOUNDED",network:"NONE"},writeMode:"NONE"}]};}
/** @param {number} [wallTimeMs] @param {number} [fileSizeBytes] @returns {any} */
function rawPolicy(wallTimeMs=2000,fileSizeBytes=1024*1024){return{version:1,repository:"demo",backend:"BWRAP",network:"NONE",runtimeReadOnlyBinds:[],commands:[{id:"read",argv:["/bin/sh","-c","test -r README.md; printf ok"]},{id:"write",argv:["/bin/sh","-c","set -e; printf sandboxed > /workspace/generated.txt; test ! -e /home/joeri; test -z \"${SECRET_FOR_SANDBOX_TEST:-}\"; printf ok"]},{id:"sleep",argv:["/bin/sh","-c","sleep 5"]},{id:"network",argv:["/bin/sh","-c","test \"$(wc -l < /proc/net/route)\" -eq 1"]},{id:"bigfile",argv:["/bin/sh","-c","dd if=/dev/zero of=/workspace/big.bin bs=2048 count=1 >/dev/null 2>&1"]}],limits:{wallTimeMs,cpuSeconds:2,addressSpaceBytes:512*1024*1024,fileSizeBytes,openFiles:64,processes:16,maxOutputBytes:65536,maxWorkspaceBytes:16*1024*1024,maxWorkspaceFiles:4096}};}
/** @param {string} commit @param {"WORKTREE_WRITE"|"READ_ONLY"} [filesystem] */
function taskValue(commit,filesystem="WORKTREE_WRITE"){const result=validateAgentTask(rawTask(commit,filesystem));assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.task)throw new Error("bad task fixture");return result.task;}
function roleValue(){const result=validateAgentRolePolicy(rawRoles());assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.policy)throw new Error("bad role fixture");return result.policy;}
function policyValue(wallTimeMs=2000,fileSizeBytes=1024*1024){const result=validateAgentSandboxPolicy(rawPolicy(wallTimeMs,fileSizeBytes));assert.equal(result.valid,true,JSON.stringify(result.errors));if(!result.valid||!result.policy)throw new Error("bad sandbox policy fixture");return result.policy;}

/** @param {string} dbFile @param {any} task */
function runningLease(dbFile,task){const db=openAgentTaskRegistry(dbFile);registerAgentTask(db,task,T0);transitionAgentTask(db,{taskId:task.id,fromState:"QUEUED",toState:"ROUTED",expectedRevision:0,at:"2026-09-17T15:00:10Z"});const acquired=acquireAgentWorkerLease(db,{taskId:task.id,workerId:"worker:sandbox",at:"2026-09-17T15:00:20Z",ttlSeconds:600});transitionAgentTask(db,{taskId:task.id,fromState:"ROUTED",toState:"RUNNING",expectedRevision:1,at:"2026-09-17T15:00:30Z"});return{db,leaseId:acquired.lease.leaseId,workerId:"worker:sandbox"};}
test("sandbox policy is BWRAP network-none exact-command and resource bounded",()=>{
  const result=validateAgentSandboxPolicy(rawPolicy());assert.equal(result.valid,true,JSON.stringify(result.errors));assert.equal(result.policy?.backend,"BWRAP");assert.equal(result.policy?.network,"NONE");
  const network=rawPolicy();network.network="READ_ONLY";assert.equal(validateAgentSandboxPolicy(network).valid,false);
  const relative=rawPolicy();relative.commands[0].argv[0]="sh";assert.equal(validateAgentSandboxPolicy(relative).valid,false);
  const nested=rawPolicy();nested.runtimeReadOnlyBinds=[{id:"bad",source:"/usr/bin",target:"/runtime/tools/node"}];assert.equal(validateAgentSandboxPolicy(nested).valid,false);
});

test("sandbox id is deterministic over task repository commit and policy",()=>{
  const task=taskValue("a".repeat(40)),policy=policyValue();assert.equal(deriveAgentSandboxId(task,policy),deriveAgentSandboxId(task,policy));
  const changed=policyValue();changed.limits.wallTimeMs=3000;assert.notEqual(deriveAgentSandboxId(task,policy),deriveAgentSandboxId(task,changed));
});

test("write sandbox requires exact active WRITE lease and starts clean",()=>{
  const f=fixture(),task=taskValue(f.commit),policy=policyValue();
  try{
    assert.throws(()=>createAgentTaskSandbox(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,createdAt:T1}),/WRITE lease|registry/);
    const state=runningLease(path.join(f.root,"control.sqlite"),task);
    try{const created=createAgentTaskSandbox(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,createdAt:T1,db:state.db,leaseId:state.leaseId,workerId:state.workerId});assert.equal(created.clean,true);assert.equal(created.network,"NONE");assert.equal(created.lease?.leaseId,state.leaseId);assert.equal(fs.existsSync(created.metadataFile),true);assert.match(git(f.repo,["worktree","list","--porcelain"]),new RegExp(created.worktreeRoot.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")));cleanupAgentTaskSandbox(task,policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,cleanedAt:T2});}finally{state.db.close();}
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});test("read-only sandbox needs no lease and cannot mutate workspace",()=>{
  const f=fixture(),task=taskValue(f.commit,"READ_ONLY"),policy=policyValue();
  try{
    const created=createAgentTaskSandbox(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,createdAt:T1});assert.equal(created.lease,null);
    const read=runAgentSandboxCommand(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,commandId:"read",evaluatedAt:T1});assert.equal(read.status,"PASS");assert.equal(read.filesystem,"READ_ONLY");assert.equal(read.output.stdoutBytes,2);assert.equal("stdout" in read.output,false);
    const write=runAgentSandboxCommand(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,commandId:"write",evaluatedAt:T1});assert.equal(write.status,"FAIL");assert.equal(fs.existsSync(path.join(created.worktreeRoot,"generated.txt")),false);assert.equal(inspectAgentTaskSandbox(task,policy,f.repo,f.sandboxes).clean,true);
    cleanupAgentTaskSandbox(task,policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,cleanedAt:T2});
  }finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("write sandbox mutates only workspace and clears host environment",()=>{
  const f=fixture(),task=taskValue(f.commit),policy=policyValue(),state=runningLease(path.join(f.root,"control.sqlite"),task),prior=process.env.SECRET_FOR_SANDBOX_TEST;process.env.SECRET_FOR_SANDBOX_TEST="host-secret";
  try{
    const created=createAgentTaskSandbox(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,createdAt:T1,db:state.db,leaseId:state.leaseId,workerId:state.workerId});
    const run=runAgentSandboxCommand(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,commandId:"write",evaluatedAt:T1,db:state.db,leaseId:state.leaseId,workerId:state.workerId});assert.equal(run.status,"PASS");assert.equal(run.network,"NONE");assert.equal(run.executionPerformed,true);assert.equal(run.mergeAuthorized,false);assert.equal(run.deployAuthorized,false);assert.equal(run.productionMutationAuthorized,false);assert.equal(fs.readFileSync(path.join(created.worktreeRoot,"generated.txt"),"utf8"),"sandboxed");assert.equal(fs.existsSync(path.join(f.root,"generated.txt")),false);assert.equal(run.output.stdoutBytes,2);assert.equal("stdout" in run.output,false);
    const cleaned=cleanupAgentTaskSandbox(task,policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,cleanedAt:T2});assert.equal(cleaned.dirtyBeforeCleanup,true);assert.equal(fs.existsSync(created.controlRoot),false);assert.equal(git(f.repo,["worktree","list","--porcelain"]).includes(created.worktreeRoot),false);
  }finally{if(prior===undefined)delete process.env.SECRET_FOR_SANDBOX_TEST;else process.env.SECRET_FOR_SANDBOX_TEST=prior;state.db.close();fs.rmSync(f.root,{recursive:true,force:true});}
});test("sandbox invocation unshares network and exposes only fixed prlimit bwrap chain",()=>{
  const task=taskValue("a".repeat(40)),policy=policyValue(),sandbox={worktreeRoot:"/tmp/example-worktree"};const invocation=buildAgentSandboxInvocation(task,policy,sandbox,"write");
  assert.equal(invocation.executable,"/usr/bin/bwrap");assert.equal(invocation.network,"NONE");assert.equal(invocation.workspaceMode,"WRITE");assert.ok(invocation.args.includes("--unshare-all"));assert.equal(invocation.args.includes("--share-net"),false);assert.ok(invocation.args.includes("--cap-drop"));assert.ok(invocation.args.includes("--clearenv"));assert.ok(invocation.args.includes("--bind"));assert.ok(invocation.args.some((arg)=>arg.startsWith("--cpu=")));assert.ok(invocation.args.some((arg)=>arg.startsWith("--as=")));assert.ok(invocation.args.includes("/usr/bin/prlimit"));assert.equal(invocation.args.at(-2),"-c");assert.match(invocation.args.at(-1)??"",/generated\.txt/);
});

test("wall-time limit terminates exact policy command",()=>{
  const f=fixture(),task=taskValue(f.commit,"READ_ONLY"),policy=policyValue(250);
  try{createAgentTaskSandbox(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,createdAt:T1});const run=runAgentSandboxCommand(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,commandId:"sleep",evaluatedAt:T1});assert.equal(run.status,"FAIL");assert.equal(run.timedOut,true);cleanupAgentTaskSandbox(task,policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,cleanedAt:T2});}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("file-size resource limit blocks oversized workspace write",()=>{
  const f=fixture(),task=taskValue(f.commit),policy=policyValue(2000,1024),state=runningLease(path.join(f.root,"control.sqlite"),task);
  try{const created=createAgentTaskSandbox(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,createdAt:T1,db:state.db,leaseId:state.leaseId,workerId:state.workerId});const run=runAgentSandboxCommand(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,commandId:"bigfile",evaluatedAt:T1,db:state.db,leaseId:state.leaseId,workerId:state.workerId});assert.equal(run.status,"FAIL");assert.equal(run.executionPerformed,true);const file=path.join(created.worktreeRoot,"big.bin");if(fs.existsSync(file))assert.ok(fs.statSync(file).size<=1024);cleanupAgentTaskSandbox(task,policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,cleanedAt:T2});}finally{state.db.close();fs.rmSync(f.root,{recursive:true,force:true});}
});test("expired write lease blocks execution but never deterministic cleanup",()=>{
  const f=fixture(),task=taskValue(f.commit),policy=policyValue(),state=runningLease(path.join(f.root,"control.sqlite"),task);
  try{const created=createAgentTaskSandbox(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,createdAt:T1,db:state.db,leaseId:state.leaseId,workerId:state.workerId});assert.throws(()=>runAgentSandboxCommand(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,commandId:"read",evaluatedAt:T2,db:state.db,leaseId:state.leaseId,workerId:state.workerId}),/active WRITE lease|no longer active/);const cleaned=cleanupAgentTaskSandbox(task,policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,cleanedAt:T2});assert.equal(cleaned.status,"CLEANED");assert.equal(cleaned.leaseRequired,false);assert.equal(fs.existsSync(created.controlRoot),false);}finally{state.db.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test("cleanup refuses tampered metadata until exact binding is restored",()=>{
  const f=fixture(),task=taskValue(f.commit,"READ_ONLY"),policy=policyValue();
  try{const created=createAgentTaskSandbox(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,createdAt:T1});const original=fs.readFileSync(created.metadataFile,"utf8"),tampered=JSON.parse(original);tampered.taskId="task:other";fs.writeFileSync(created.metadataFile,JSON.stringify(tampered));assert.throws(()=>cleanupAgentTaskSandbox(task,policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,cleanedAt:T2}),/metadata does not match/);assert.equal(fs.existsSync(created.worktreeRoot),true);fs.writeFileSync(created.metadataFile,original);cleanupAgentTaskSandbox(task,policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,cleanedAt:T2});}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("symlinked sandbox parent fails closed before worktree creation",()=>{
  const f=fixture(),task=taskValue(f.commit,"READ_ONLY"),policy=policyValue(),real=path.join(f.root,"real-parent"),link=path.join(f.root,"linked-parent");fs.mkdirSync(real);fs.symlinkSync(real,link);
  try{assert.throws(()=>createAgentTaskSandbox(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:link,createdAt:T1}),/symlinked host path/);assert.equal(git(f.repo,["worktree","list","--porcelain"]).split("\n").filter((line)=>line.startsWith("worktree ")).length,1);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("explicit runtime bind executes from read-only runtime mount",()=>{
  const f=fixture(),task=taskValue(f.commit,"READ_ONLY"),raw=rawPolicy();raw.runtimeReadOnlyBinds=[{id:"dash",source:"/usr/bin/dash",target:"/runtime/dash"}];raw.commands=[{id:"runtime",argv:["/runtime/dash","-c","printf ok"]}];const validated=validateAgentSandboxPolicy(raw);assert.equal(validated.valid,true,JSON.stringify(validated.errors));if(!validated.valid||!validated.policy)throw new Error("bad runtime-bind policy");
  try{createAgentTaskSandbox(task,roleValue(),validated.policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,createdAt:T1});const run=runAgentSandboxCommand(task,roleValue(),validated.policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,commandId:"runtime",evaluatedAt:T1});assert.equal(run.status,"PASS");assert.equal(run.output.stdoutBytes,2);cleanupAgentTaskSandbox(task,validated.policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,cleanedAt:T2});}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});test("sandbox source has no general shell network or implicit environment authority",()=>{
  const source=fs.readFileSync(new URL("../scripts/agent-task-sandbox.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/shell\s*:\s*true|fetch\(|https?:\/\//);assert.doesNotMatch(source,/process\.env/);assert.match(source,/const BWRAP = "\/usr\/bin\/bwrap"/);assert.match(source,/const PRLIMIT = "\/usr\/bin\/prlimit"/);assert.match(source,/const GIT = "\/usr\/bin\/git"/);assert.match(source,/--unshare-all/);assert.doesNotMatch(source,/--share-net/);
});

test("sandbox CLI fails closed on incomplete or unknown commands",()=>{
  assert.equal(main([]),1);assert.equal(main(["create","--unknown","x"]),1);
});

test("network namespace inherits no host route",()=>{
  const f=fixture(),task=taskValue(f.commit,"READ_ONLY"),policy=policyValue();
  try{createAgentTaskSandbox(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,createdAt:T1});const run=runAgentSandboxCommand(task,roleValue(),policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,commandId:"network",evaluatedAt:T1});assert.equal(run.status,"PASS");assert.equal(run.network,"NONE");cleanupAgentTaskSandbox(task,policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,cleanedAt:T2});}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("runtime bind must be one executable file, never a host directory",()=>{
  const f=fixture(),task=taskValue(f.commit,"READ_ONLY"),raw=rawPolicy();raw.runtimeReadOnlyBinds=[{id:"usr",source:"/usr/bin",target:"/runtime/usr"}];raw.commands=[{id:"runtime",argv:["/runtime/usr","--version"]}];const validated=validateAgentSandboxPolicy(raw);assert.equal(validated.valid,true,JSON.stringify(validated.errors));if(!validated.valid||!validated.policy)throw new Error("bad directory-bind fixture");
  try{assert.throws(()=>createAgentTaskSandbox(task,roleValue(),validated.policy,{repositoryRoot:f.repo,sandboxParent:f.sandboxes,createdAt:T1}),/regular executable file/);}finally{fs.rmSync(f.root,{recursive:true,force:true});}
});

test("sandbox CLI completes read-only create inspect run cleanup roundtrip",()=>{
  const f=fixture(),taskFile=path.join(f.root,"task.json"),roleFile=path.join(f.root,"roles.json"),policyFile=path.join(f.root,"policy.json");fs.writeFileSync(taskFile,JSON.stringify(rawTask(f.commit,"READ_ONLY")));fs.writeFileSync(roleFile,JSON.stringify(rawRoles()));fs.writeFileSync(policyFile,JSON.stringify(rawPolicy()));
  const original=console.log;let stdout="";console.log=(...values)=>{stdout+=`${values.join(" ")}\n`;};
  try{
    assert.equal(main(["create","--task",taskFile,"--role-policy",roleFile,"--policy",policyFile,"--repository-root",f.repo,"--sandbox-parent",f.sandboxes,"--created-at",T1,"--json"]),0);let parsed=JSON.parse(stdout.trim());assert.equal(parsed.clean,true);stdout="";
    assert.equal(main(["inspect","--task",taskFile,"--policy",policyFile,"--repository-root",f.repo,"--sandbox-parent",f.sandboxes,"--json"]),0);parsed=JSON.parse(stdout.trim());assert.equal(parsed.clean,true);stdout="";
    assert.equal(main(["run","--task",taskFile,"--role-policy",roleFile,"--policy",policyFile,"--repository-root",f.repo,"--sandbox-parent",f.sandboxes,"--command-id","read","--evaluated-at",T1,"--json"]),0);parsed=JSON.parse(stdout.trim());assert.equal(parsed.status,"PASS");stdout="";
    assert.equal(main(["cleanup","--task",taskFile,"--policy",policyFile,"--repository-root",f.repo,"--sandbox-parent",f.sandboxes,"--cleaned-at",T2,"--json"]),0);parsed=JSON.parse(stdout.trim());assert.equal(parsed.status,"CLEANED");
  }finally{console.log=original;fs.rmSync(f.root,{recursive:true,force:true});}
});
