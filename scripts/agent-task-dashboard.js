#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { AGENT_TASK_STATES, listAgentTasks } from "./agent-task-registry.js";
import { listAgentWorkerLeases } from "./agent-worker-lease.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
export const AGENT_DASHBOARD_STATUSES=["QUEUED","ROUTED","LEASED","RUNNING","REVIEW_REQUIRED","BLOCKED","FAILED","COMPLETED","CANCELLED","SUPERSEDED"];
const DASHBOARD_STATUS_SET=new Set(AGENT_DASHBOARD_STATUSES);
const REGISTRY_STATE_SET=new Set(AGENT_TASK_STATES);
const TERMINAL=new Set(["COMPLETED","CANCELLED","SUPERSEDED"]);

/** @param {unknown} value @param {number} [max] */
function text(value,max=256){if(typeof value!=="string")return null;const normalized=value.trim();return normalized.length>0&&normalized.length<=max&&!/[\u0000\r\n]/.test(normalized)?normalized:null;}
/** @param {unknown} value */
function portableId(value){const normalized=text(value,128);return normalized&&ID.test(normalized)?normalized:null;}
/** @param {string} absolute */
function assertNoSymlinkAncestors(absolute){
  const resolved=path.resolve(absolute),parsed=path.parse(resolved),parts=resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);let current=parsed.root;
  for(const part of parts){current=path.join(current,part);let stat;try{stat=fs.lstatSync(current);}catch{throw new Error("dashboard database path does not exist");}if(stat.isSymbolicLink())throw new Error("dashboard database path must not traverse symlinks");}
  return resolved;
}

/** @param {string} filename */
export function openAgentDashboardDatabase(filename){
  const resolved=assertNoSymlinkAncestors(filename),stat=fs.lstatSync(resolved);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1)throw new Error("dashboard database must be an existing regular non-symlink file");
  const db=new DatabaseSync(resolved,{readOnly:true});
  try{db.exec("PRAGMA query_only = ON; PRAGMA foreign_keys = ON;");return db;}catch(error){db.close();throw error;}
}

/** @param {any} lease @param {string} evaluatedAt */
function leaseCondition(lease,evaluatedAt){
  if(lease.releasedAt!==null)return"RELEASED";
  const evaluated=Date.parse(evaluatedAt),acquired=Date.parse(lease.acquiredAt),renewed=Date.parse(lease.renewedAt),expires=Date.parse(lease.expiresAt);
  if(!Number.isFinite(acquired)||!Number.isFinite(renewed)||!Number.isFinite(expires))return"INVALID_TIME";
  if(acquired>evaluated||renewed>evaluated)return"FUTURE";
  if(expires<=evaluated)return"EXPIRED";
  return"ACTIVE";
}

/** @param {string} registryState @param {any[]} activeLeases */
function dashboardStatus(registryState,activeLeases){
  if(registryState==="ROUTED"&&activeLeases.length>0)return"LEASED";
  if(registryState==="WAITING_REVIEW")return"REVIEW_REQUIRED";
  return registryState;
}

/** @param {any} record @param {any[]} leases @param {string} evaluatedAt */
function projectTask(record,leases,evaluatedAt){
  const classified=leases.map((lease)=>({...lease,condition:leaseCondition(lease,evaluatedAt)}));
  const active=classified.filter((lease)=>lease.condition==="ACTIVE");
  const task=record.task,status=dashboardStatus(record.state,active);
  /** @type {Array<{id:string,severity:"WARN"|"FAIL",detail:string}>} */ const consistency=[];
  if(!REGISTRY_STATE_SET.has(record.state))consistency.push({id:"registry-state-invalid",severity:"FAIL",detail:"registry state is outside Agent Task Registry v1 vocabulary"});
  if(active.length>1)consistency.push({id:"multiple-active-leases",severity:"FAIL",detail:"task has more than one active worker lease"});
  if((record.state==="QUEUED"||TERMINAL.has(record.state))&&active.length>0)consistency.push({id:"unexpected-active-lease",severity:"WARN",detail:"task state should not normally retain an active lease"});
  if(task.authority.filesystem==="WORKTREE_WRITE"&&(record.state==="RUNNING"||record.state==="WAITING_REVIEW")&&!active.some((lease)=>lease.mode==="WRITE"))consistency.push({id:"write-lease-missing",severity:"WARN",detail:"write task is active without an active WRITE lease"});
  if(classified.some((lease)=>lease.condition==="FUTURE"||lease.condition==="INVALID_TIME"))consistency.push({id:"lease-time-invalid",severity:"FAIL",detail:"lease chronology is invalid relative to evaluatedAt"});
  if(classified.some((lease)=>lease.condition==="EXPIRED")&&(record.state==="ROUTED"||record.state==="RUNNING"||record.state==="WAITING_REVIEW"))consistency.push({id:"lease-expired",severity:"WARN",detail:"active task has an unreleased expired lease record"});
  const currentLease=active.length===1?active[0]:null;
  const latestLease=classified.length?classified[classified.length-1]:null;
  return{
    id:task.id,role:task.role,risk:task.risk,repository:task.repository.id,commit:task.repository.baseCommit,
    registryState:record.state,dashboardStatus:status,attemptCount:record.attemptCount,revision:record.revision,updatedAt:record.updatedAt,
    lease:currentLease?{leaseId:currentLease.leaseId,workerId:currentLease.workerId,mode:currentLease.mode,expiresAt:currentLease.expiresAt,condition:currentLease.condition}:null,
    lastLease:latestLease?{leaseId:latestLease.leaseId,workerId:latestLease.workerId,mode:latestLease.mode,expiresAt:latestLease.expiresAt,releasedAt:latestLease.releasedAt,releaseReason:latestLease.releaseReason,condition:latestLease.condition}:null,
    consistency,
  };
}

/** @param {import("node:sqlite").DatabaseSync} db @param {string} evaluatedAt @param {{repository?:string|null,status?:string|null}} [filters] */
export function buildAgentTaskDashboard(db,evaluatedAt,filters={}){
  if(!isAbsoluteIsoTimestamp(evaluatedAt))throw new Error("dashboard evaluatedAt must be an absolute ISO timestamp");
  const repository=filters.repository===undefined||filters.repository===null?null:portableId(filters.repository);
  const status=filters.status===undefined||filters.status===null?null:text(filters.status,32);
  if(filters.repository!==undefined&&filters.repository!==null&&!repository)throw new Error("dashboard repository filter is invalid");
  if(filters.status!==undefined&&filters.status!==null&&(!status||!DASHBOARD_STATUS_SET.has(status)))throw new Error("dashboard status filter is invalid");
  const records=/** @type {any[]} */(listAgentTasks(db,repository?{repository}:{}).filter(Boolean));
  const leases=/** @type {any[]} */(listAgentWorkerLeases(db,{}).filter(Boolean));
  const leasesByTask=/** @type {Map<string,any[]>} */(new Map());
  for(const lease of leases){const existing=leasesByTask.get(lease.taskId);if(existing)existing.push(lease);else leasesByTask.set(lease.taskId,[lease]);}
  for(const values of leasesByTask.values())values.sort((a,b)=>a.acquiredAt.localeCompare(b.acquiredAt)||a.leaseId.localeCompare(b.leaseId));
  let tasks=records.map((record)=>projectTask(record,leasesByTask.get(record.task.id)??[],evaluatedAt));
  if(status)tasks=tasks.filter((task)=>task.dashboardStatus===status);
  tasks.sort((a,b)=>a.updatedAt.localeCompare(b.updatedAt)||a.id.localeCompare(b.id));
  const counts=Object.fromEntries(AGENT_DASHBOARD_STATUSES.map((item)=>[item,tasks.filter((task)=>task.dashboardStatus===item).length]));
  const warnings=tasks.reduce((sum,task)=>sum+task.consistency.filter((item)=>item.severity==="WARN").length,0);
  const failures=tasks.reduce((sum,task)=>sum+task.consistency.filter((item)=>item.severity==="FAIL").length,0);
  return{
    version:1,evaluatedAt,filters:{repository,status},tasks,counts,
    summary:{tasks:tasks.length,warnings,failures,technicalStatus:failures>0?"FAIL":warnings>0?"WARN":"PASS"},
    semantics:"read-only projection of Agent Task Registry v1 and Worker Lease v1 truth; dashboard status is derived and never written back to the registry",
  };
}

/** @param {ReturnType<typeof buildAgentTaskDashboard>} dashboard */
export function formatAgentTaskDashboard(dashboard){
  const lines=["Agent Operator Task Dashboard v1","",
    "Evaluated at: "+dashboard.evaluatedAt,
    "Tasks: "+dashboard.summary.tasks,
    "Consistency: "+dashboard.summary.technicalStatus,
    "Filters: repository="+(dashboard.filters.repository??"*")+" status="+(dashboard.filters.status??"*"),
    ""];
  for(const status of AGENT_DASHBOARD_STATUSES){const count=Number(dashboard.counts[status]??0);if(count>0)lines.push(status.padEnd(16)+" "+String(count).padStart(4));}
  lines.push("");
  for(const task of dashboard.tasks){
    const lease=task.lease?" lease="+task.lease.workerId+"/"+task.lease.mode:"";
    lines.push(task.dashboardStatus.padEnd(16)+" "+task.id+"  "+task.repository+"@"+task.commit+"  "+task.role+"  "+task.risk+lease);
    for(const issue of task.consistency)lines.push("  "+issue.severity.padEnd(4)+" "+issue.id+"  "+issue.detail);
  }
  lines.push("","Semantics: "+dashboard.semantics);
  return lines.join("\n");
}

/** @param {string[]} argv */
function parse(argv){
  const values=new Map(),flags=new Set(),allowed=new Set(["--db","--evaluated-at","--repository","--status"]);
  for(let index=0;index<argv.length;index+=1){
    const arg=argv[index];if(arg==="--json"){if(flags.has(arg))return null;flags.add(arg);continue;}
    if(!allowed.has(arg??"")||values.has(arg))return null;
    const next=argv[index+1];if(typeof next!=="string"||next.startsWith("--"))return null;
    values.set(arg,next);index+=1;
  }
  if(!values.has("--db")||!values.has("--evaluated-at"))return null;
  return{db:values.get("--db"),evaluatedAt:values.get("--evaluated-at"),repository:values.get("--repository")??null,status:values.get("--status")??null,json:flags.has("--json")};
}

export function main(argv=process.argv.slice(2)){
  const options=parse(argv);
  if(!options){console.error("Usage: node scripts/agent-task-dashboard.js --db <registry.sqlite> --evaluated-at <ISO> [--repository <id>] [--status <dashboard-status>] [--json]");return 1;}
  let db;
  try{
    db=openAgentDashboardDatabase(options.db);
    const dashboard=buildAgentTaskDashboard(db,options.evaluatedAt,{repository:options.repository,status:options.status});
    console.log(options.json?JSON.stringify(dashboard):formatAgentTaskDashboard(dashboard));
    return dashboard.summary.technicalStatus==="FAIL"?1:0;
  }catch(error){console.error(error instanceof Error?error.message:"operator task dashboard failed");return 1;}
  finally{try{db?.close();}catch{/* no-op */}}
}

if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();
