import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  AGENT_DASHBOARD_STATUSES,
  buildAgentTaskDashboard,
  formatAgentTaskDashboard,
  main,
  openAgentDashboardDatabase,
} from "../scripts/agent-task-dashboard.js";
import { listAgentTasks, openAgentTaskRegistry, registerAgentTask, transitionAgentTask } from "../scripts/agent-task-registry.js";
import { acquireAgentWorkerLease, listAgentWorkerLeases, releaseAgentWorkerLease } from "../scripts/agent-worker-lease.js";

const T0="2026-09-18T03:00:00Z";
const T1="2026-09-18T03:01:00Z";
const T2="2026-09-18T03:02:00Z";
const T3="2026-09-18T03:03:00Z";
const T4="2026-09-18T03:04:00Z";
const EVAL="2026-09-18T03:10:00Z";
const COMMIT="a".repeat(40);

/** @param {Buffer|string} value */
function digest(value){return crypto.createHash("sha256").update(value).digest("hex");}

/** @param {string} id @param {"READ_ONLY"|"WORKTREE_WRITE"} [filesystem] @param {string} [repository] */
function rawTask(id,filesystem="READ_ONLY",repository="demo"){
  return{
    version:1,id,role:filesystem==="WORKTREE_WRITE"?"repair":"diagnose",repository:{id:repository,baseCommit:COMMIT},createdAt:T0,risk:"LOW",
    objective:"Synthetic dashboard task "+id,
    authority:{filesystem,shell:"NONE",network:"NONE",merge:false,deploy:false,productionMutation:false},
    scope:{allowedPaths:["src/**"],deniedPaths:[],requiredChecks:["test"]},dependsOn:[],
  };
}

function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"agent-dashboard-")),dbFile=path.join(root,"control.sqlite"),db=openAgentTaskRegistry(dbFile);
  return{root,dbFile,db};
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} id @param {string} state @param {{filesystem?:"READ_ONLY"|"WORKTREE_WRITE",ttl?:number,release?:boolean,repository?:string}} [options] */
function createState(db,id,state,options={}){
  const filesystem=options.filesystem??"READ_ONLY";
  const repository=options.repository??(filesystem==="WORKTREE_WRITE"?"repo-"+id.replace(/[^A-Za-z0-9]/g,"-"):"demo");
  const task=rawTask(id,filesystem,repository);registerAgentTask(db,task,T0);
  if(state==="QUEUED")return{task,lease:null};
  if(["BLOCKED","FAILED","CANCELLED","SUPERSEDED"].includes(state)){transitionAgentTask(db,{taskId:id,fromState:"QUEUED",toState:state,expectedRevision:0,at:T1});return{task,lease:null};}
  transitionAgentTask(db,{taskId:id,fromState:"QUEUED",toState:"ROUTED",expectedRevision:0,at:T1});
  if(state==="ROUTED")return{task,lease:null};
  const acquired=acquireAgentWorkerLease(db,{taskId:id,workerId:"worker:"+id.replace(/[^A-Za-z0-9]/g,"_"),at:T2,ttlSeconds:options.ttl??3600});
  if(state==="LEASED")return{task,lease:acquired.lease};
  transitionAgentTask(db,{taskId:id,fromState:"ROUTED",toState:"RUNNING",expectedRevision:1,at:T3});
  if(state==="RUNNING")return{task,lease:acquired.lease};
  if(state==="WAITING_REVIEW"){transitionAgentTask(db,{taskId:id,fromState:"RUNNING",toState:"WAITING_REVIEW",expectedRevision:2,at:T4});return{task,lease:acquired.lease};}
  if(state==="COMPLETED"){
    transitionAgentTask(db,{taskId:id,fromState:"RUNNING",toState:"COMPLETED",expectedRevision:2,at:T4});
    if(options.release!==false)releaseAgentWorkerLease(db,{leaseId:acquired.lease.leaseId,workerId:acquired.lease.workerId,expectedRevision:0,at:T4,reason:"COMPLETED"});
    return{task,lease:acquired.lease};
  }
  throw new Error("unsupported fixture state "+state);
}

test("dashboard exposes requested operational states as a derived projection",()=>{
  const f=fixture();
  try{
    createState(f.db,"task:queued","QUEUED");
    createState(f.db,"task:leased","LEASED",{filesystem:"WORKTREE_WRITE"});
    createState(f.db,"task:running","RUNNING",{filesystem:"WORKTREE_WRITE"});
    createState(f.db,"task:review","WAITING_REVIEW",{filesystem:"WORKTREE_WRITE"});
    createState(f.db,"task:blocked","BLOCKED");
    createState(f.db,"task:completed","COMPLETED",{filesystem:"WORKTREE_WRITE"});
    createState(f.db,"task:superseded","SUPERSEDED");
    const dashboard=buildAgentTaskDashboard(f.db,EVAL);
    const statuses=Object.fromEntries(dashboard.tasks.map((task)=>[task.id,task.dashboardStatus]));
    assert.equal(statuses["task:queued"],"QUEUED");assert.equal(statuses["task:leased"],"LEASED");assert.equal(statuses["task:running"],"RUNNING");
    assert.equal(statuses["task:review"],"REVIEW_REQUIRED");assert.equal(statuses["task:blocked"],"BLOCKED");assert.equal(statuses["task:completed"],"COMPLETED");assert.equal(statuses["task:superseded"],"SUPERSEDED");
  }finally{f.db.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test("dashboard preserves registry state alongside derived status",()=>{
  const f=fixture();try{
    createState(f.db,"task:leased","LEASED",{filesystem:"WORKTREE_WRITE"});
    createState(f.db,"task:review","WAITING_REVIEW",{filesystem:"WORKTREE_WRITE"});
    const dashboard=buildAgentTaskDashboard(f.db,EVAL),leased=dashboard.tasks.find((task)=>task.id==="task:leased"),review=dashboard.tasks.find((task)=>task.id==="task:review");
    assert.equal(leased?.registryState,"ROUTED");assert.equal(leased?.dashboardStatus,"LEASED");
    assert.equal(review?.registryState,"WAITING_REVIEW");assert.equal(review?.dashboardStatus,"REVIEW_REQUIRED");
  }finally{f.db.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test("expired lease is observed without mutating task or lease truth",()=>{
  const f=fixture();try{
    createState(f.db,"task:expired","RUNNING",{filesystem:"WORKTREE_WRITE",ttl:30});
    const tasksBefore=JSON.stringify(listAgentTasks(f.db)),leasesBefore=JSON.stringify(listAgentWorkerLeases(f.db,{}));
    const dashboard=buildAgentTaskDashboard(f.db,EVAL),task=dashboard.tasks.find((item)=>item.id==="task:expired");
    assert.equal(task?.dashboardStatus,"RUNNING");assert.equal(task?.lease,null);assert.equal(task?.lastLease?.condition,"EXPIRED");
    assert.equal(task?.consistency.some((item)=>item.id==="lease-expired"),true);
    assert.equal(task?.consistency.some((item)=>item.id==="write-lease-missing"),true);
    assert.equal(JSON.stringify(listAgentTasks(f.db)),tasksBefore);assert.equal(JSON.stringify(listAgentWorkerLeases(f.db,{})),leasesBefore);
  }finally{f.db.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test("terminal task with active lease is visible as consistency warning only",()=>{
  const f=fixture();try{
    createState(f.db,"task:terminal-lease","COMPLETED",{filesystem:"WORKTREE_WRITE",release:false});
    const dashboard=buildAgentTaskDashboard(f.db,EVAL),task=dashboard.tasks.find((item)=>item.id==="task:terminal-lease");
    assert.equal(task?.dashboardStatus,"COMPLETED");assert.equal(task?.lease?.condition,"ACTIVE");
    assert.equal(task?.consistency.some((item)=>item.id==="unexpected-active-lease"),true);
    assert.equal(dashboard.summary.technicalStatus,"WARN");
  }finally{f.db.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test("failed cancelled and routed states stay distinct",()=>{
  const f=fixture();try{
    createState(f.db,"task:failed","FAILED");createState(f.db,"task:cancelled","CANCELLED");createState(f.db,"task:routed","ROUTED");
    const dashboard=buildAgentTaskDashboard(f.db,EVAL),statuses=Object.fromEntries(dashboard.tasks.map((task)=>[task.id,task.dashboardStatus]));
    assert.equal(statuses["task:failed"],"FAILED");assert.equal(statuses["task:cancelled"],"CANCELLED");assert.equal(statuses["task:routed"],"ROUTED");
  }finally{f.db.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test("repository and dashboard status filters are explicit",()=>{
  const f=fixture();try{
    createState(f.db,"task:one","QUEUED");registerAgentTask(f.db,rawTask("task:other","READ_ONLY","other"),T0);
    assert.deepEqual(buildAgentTaskDashboard(f.db,EVAL,{repository:"other"}).tasks.map((task)=>task.id),["task:other"]);
    assert.deepEqual(buildAgentTaskDashboard(f.db,EVAL,{status:"QUEUED"}).tasks.map((task)=>task.id),["task:one","task:other"]);
    assert.throws(()=>buildAgentTaskDashboard(f.db,EVAL,{status:"UNKNOWN"}),/status filter/);
  }finally{f.db.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test("read-only dashboard database opens existing registry without changing bytes",()=>{
  const f=fixture();try{
    createState(f.db,"task:queued","QUEUED");f.db.close();
    const before=fs.readFileSync(f.dbFile),beforeHash=digest(before),beforeStat=fs.statSync(f.dbFile);
    const readOnly=openAgentDashboardDatabase(f.dbFile);
    try{const dashboard=buildAgentTaskDashboard(readOnly,EVAL);assert.equal(dashboard.tasks.length,1);}finally{readOnly.close();}
    const after=fs.readFileSync(f.dbFile),afterStat=fs.statSync(f.dbFile);
    assert.equal(digest(after),beforeHash);assert.equal(after.length,before.length);assert.equal(afterStat.size,beforeStat.size);
  }finally{try{f.db.close();}catch{}fs.rmSync(f.root,{recursive:true,force:true});}
});

test("dashboard CLI returns JSON without modifying registry bytes",()=>{
  const f=fixture();try{
    createState(f.db,"task:queued","QUEUED");f.db.close();const before=digest(fs.readFileSync(f.dbFile));
    const original=console.log;let stdout="";console.log=(...values)=>{stdout+=values.join(" ")+"\n";};
    try{assert.equal(main(["--db",f.dbFile,"--evaluated-at",EVAL,"--json"]),0);}finally{console.log=original;}
    const dashboard=JSON.parse(stdout.trim());assert.equal(dashboard.tasks[0].id,"task:queued");assert.equal(dashboard.semantics.includes("never written back"),true);
    assert.equal(digest(fs.readFileSync(f.dbFile)),before);
  }finally{try{f.db.close();}catch{}fs.rmSync(f.root,{recursive:true,force:true});}
});

test("symlink database and invalid evaluation/filter inputs fail closed",()=>{
  const f=fixture(),link=path.join(f.root,"linked.sqlite");
  try{
    createState(f.db,"task:q","QUEUED");f.db.close();fs.symlinkSync(f.dbFile,link);
    assert.throws(()=>openAgentDashboardDatabase(link),/symlink/);
    const readOnly=openAgentDashboardDatabase(f.dbFile);
    try{assert.throws(()=>buildAgentTaskDashboard(readOnly,"not-time"),/evaluatedAt/);assert.throws(()=>buildAgentTaskDashboard(readOnly,EVAL,{repository:"bad id"}),/repository filter/);}finally{readOnly.close();}
  }finally{try{f.db.close();}catch{}fs.rmSync(f.root,{recursive:true,force:true});}
});

test("human dashboard exposes operational identity but not task objective or scope",()=>{
  const f=fixture();try{
    createState(f.db,"task:running","RUNNING",{filesystem:"WORKTREE_WRITE"});
    const dashboard=buildAgentTaskDashboard(f.db,EVAL),output=formatAgentTaskDashboard(dashboard);
    assert.match(output,/Agent Operator Task Dashboard v1/);assert.match(output,/RUNNING/);assert.match(output,/task:running/);
    assert.doesNotMatch(output,/Synthetic dashboard task/);assert.doesNotMatch(output,/src\/\*\*/);
  }finally{f.db.close();fs.rmSync(f.root,{recursive:true,force:true});}
});

test("dashboard status vocabulary contains roadmap operational buckets",()=>{
  for(const status of ["QUEUED","LEASED","RUNNING","REVIEW_REQUIRED","BLOCKED","COMPLETED","SUPERSEDED"])assert.equal(AGENT_DASHBOARD_STATUSES.includes(status),true);
});

test("dashboard source is read-only and contains no second task state model",()=>{
  const source=fs.readFileSync(new URL("../scripts/agent-task-dashboard.js",import.meta.url),"utf8");
  assert.match(source,/readOnly:true/);assert.match(source,/query_only/);
  assert.doesNotMatch(source,/INSERT INTO|UPDATE agent_|DELETE FROM|registerAgentTask|transitionAgentTask|acquireAgentWorkerLease|expireAgentWorkerLeases/);
  assert.doesNotMatch(source,/fetch\(|https?:\/\/|node:child_process|process\.env|Date\.now\(\)/);
  assert.match(source,/listAgentTasks/);assert.match(source,/listAgentWorkerLeases/);
});

test("dashboard CLI rejects incomplete or unknown argument surface",()=>{
  const original=console.error;console.error=()=>{};
  try{assert.equal(main([]),1);assert.equal(main(["--db","x","--evaluated-at",EVAL,"--unknown","y"]),1);}finally{console.error=original;}
});
