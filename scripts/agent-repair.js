#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { globToRegExp } from "./analyze-changed-surface.js";
import { validateAgentTask } from "./agent-task.js";
import { validateAgentRolePolicy, inspectAgentTaskRolePolicy } from "./agent-role-policy.js";
import { openAgentTaskRegistry, getAgentTask } from "./agent-task-registry.js";
import { expireAgentWorkerLeases, getAgentWorkerLease } from "./agent-worker-lease.js";
import { readAgentModelConfigFile, validateAgentModelRequest, invokeAgentLocalModel } from "./agent-local-model.js";
import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const OPERATIONS=new Set(["MODIFY","CREATE"]);
const APPLY_MODES=new Set(["PROPOSE_ONLY","ALLOW_LOW_RISK_WORKTREE"]);
const EVIDENCE_STATUS=new Set(["INFO","PASS","WARN","FAIL","UNVERIFIED"]);
const MAX_INPUT_BYTES=8*1024*1024;
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {unknown} value @param {number} [max] @param {boolean} [singleLine] */
function text(value,max=2048,singleLine=true){if(typeof value!=="string")return null;const v=value.trim();if(!v||v.length>max||v.includes("\u0000"))return null;if(singleLine&&/[\r\n]/.test(v))return null;return v;}
/** @param {unknown} value */
function id(value){const v=text(value,128);return v&&ID.test(v)?v:null;}
/** @param {unknown} value */
function safePath(value){const v=text(value,512);if(!v||path.isAbsolute(v)||v.includes("\\"))return null;const n=path.posix.normalize(v);return n!=="."&&n!==".."&&!n.startsWith("../")&&n===v?v:null;}
/** @param {unknown} value */
function safePattern(value){const v=text(value,512);if(!v||path.isAbsolute(v)||v.includes("\\")||v.split("/").includes(".."))return null;return v;}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${key}"`});}
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value,min,max){return typeof value==="number"&&Number.isSafeInteger(value)&&value>=min&&value<=max?value:null;}
/** @param {string} value */
function sha256(value){return crypto.createHash("sha256").update(value).digest("hex");}
/** @param {string} file @param {string[]} patterns */
function matches(file,patterns){return patterns.some((pattern)=>globToRegExp(pattern).test(file));}
/** @param {unknown} value @param {(v:unknown)=>string|null} validate @param {number} max @param {boolean} [allowEmpty] */
function list(value,validate,max,allowEmpty=false){if(!Array.isArray(value)||value.length>max||(!allowEmpty&&value.length===0))return null;const out=value.map(validate);if(out.some((v)=>v===null)||new Set(out).size!==out.length)return null;return /** @type {string[]} */(out).sort();}
/** @param {unknown} value */
export function validateAgentRepairPolicy(value){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,policy:null,errors:[{id:"policy-invalid",detail:"repair policy must be an object"}]};
  unknown(value,["version","repository","allowedPathPatterns","deniedPathPatterns","allowedOperations","applyMode","maxFiles","maxFileBytes","maxTotalBytes","requiredChecks"],"policy",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"repair policy version must be exactly 1"});
  const repository=id(value.repository);if(!repository)errors.push({id:"repository-invalid",detail:"repository must be a portable id"});
  const allowedPathPatterns=list(value.allowedPathPatterns,safePattern,64),deniedPathPatterns=list(value.deniedPathPatterns,safePattern,64,true);
  const allowedOperations=list(value.allowedOperations,(v)=>{const x=text(v,32);return x&&OPERATIONS.has(x)?x:null;},2);
  const applyMode=text(value.applyMode,64),maxFiles=integer(value.maxFiles,1,32),maxFileBytes=integer(value.maxFileBytes,64,512*1024),maxTotalBytes=integer(value.maxTotalBytes,64,2*1024*1024),requiredChecks=list(value.requiredChecks,id,64);
  if(!allowedPathPatterns||!deniedPathPatterns||!allowedOperations||!applyMode||!APPLY_MODES.has(applyMode)||!maxFiles||!maxFileBytes||!maxTotalBytes||!requiredChecks||maxFileBytes>maxTotalBytes)errors.push({id:"policy-fields-invalid",detail:"repair policy contains invalid bounded fields"});
  if(errors.length>0||!repository||!allowedPathPatterns||!deniedPathPatterns||!allowedOperations||!applyMode||!maxFiles||!maxFileBytes||!maxTotalBytes||!requiredChecks)return{valid:false,policy:null,errors};
  return{valid:true,policy:{version:1,repository,allowedPathPatterns,deniedPathPatterns,allowedOperations,applyMode,maxFiles,maxFileBytes,maxTotalBytes,requiredChecks},errors:[]};
}
/** @param {unknown} value */
export function validateAgentRepairInput(value){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,input:null,errors:[{id:"input-invalid",detail:"repair input must be an object"}]};
  unknown(value,["version","taskId","repository","sourceTaskIds","evidence","contextFiles","unknowns"],"input",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"repair input version must be exactly 1"});
  const taskId=id(value.taskId);if(!taskId)errors.push({id:"task-id-invalid",detail:"taskId must be portable"});
  const sourceTaskIds=list(value.sourceTaskIds,id,32);if(!sourceTaskIds)errors.push({id:"source-task-ids-invalid",detail:"sourceTaskIds must be a non-empty unique portable id list"});
  let repository=null;
  if(!object(value.repository))errors.push({id:"repository-invalid",detail:"repository must be an object"});
  else{unknown(value.repository,["id","commit"],"repository",errors);const repositoryId=id(value.repository.id),commit=text(value.repository.commit,128)?.toLowerCase()??null;if(!repositoryId||!commit||!isFullObjectId(commit))errors.push({id:"repository-fields-invalid",detail:"repository binding is invalid"});else repository={id:repositoryId,commit};}
  /** @type {Array<any>} */const evidence=[];const evidenceIds=new Set();
  if(!Array.isArray(value.evidence)||value.evidence.length===0||value.evidence.length>256)errors.push({id:"evidence-invalid",detail:"evidence must be a non-empty bounded array"});
  else for(const [index,raw]of value.evidence.entries()){if(!object(raw)){errors.push({id:"evidence-entry-invalid",detail:`evidence[${index}] must be an object`});continue;}unknown(raw,["id","source","status","summary","path"],"evidence-entry",errors);const evidenceId=id(raw.id),source=id(raw.source),status=text(raw.status,32),summary=text(raw.summary,2048),evidencePath=raw.path===undefined?null:safePath(raw.path);if(!evidenceId||evidenceIds.has(evidenceId)||!source||!status||!EVIDENCE_STATUS.has(status)||!summary||(raw.path!==undefined&&!evidencePath)){errors.push({id:"evidence-fields-invalid",detail:`evidence[${index}] is invalid`});continue;}evidenceIds.add(evidenceId);evidence.push({id:evidenceId,source,status,summary,...(evidencePath?{path:evidencePath}:{})});}
  /** @type {Array<any>} */const contextFiles=[];const contextPaths=new Set();let totalBytes=0;
  if(!Array.isArray(value.contextFiles)||value.contextFiles.length===0||value.contextFiles.length>64)errors.push({id:"context-files-invalid",detail:"contextFiles must be a non-empty bounded array"});
  else for(const [index,raw]of value.contextFiles.entries()){if(!object(raw)){errors.push({id:"context-file-invalid",detail:`contextFiles[${index}] must be an object`});continue;}unknown(raw,["path","sha256","content"],"context-file",errors);const filePath=safePath(raw.path),digest=text(raw.sha256,64)?.toLowerCase()??null,content=typeof raw.content==="string"&&raw.content.length>0&&!raw.content.includes("\u0000")?raw.content:null;const bytes=content?Buffer.byteLength(content,"utf8"):0;if(!filePath||contextPaths.has(filePath)||!digest||!HASH.test(digest)||!content||bytes>512*1024||sha256(content)!==digest){errors.push({id:"context-file-fields-invalid",detail:`contextFiles[${index}] path, hash, or content is invalid`});continue;}contextPaths.add(filePath);totalBytes+=bytes;contextFiles.push({path:filePath,sha256:digest,content});}
  if(totalBytes>2*1024*1024)errors.push({id:"context-total-bytes-invalid",detail:"contextFiles exceed total bounded input size"});
  const inputUnknowns=[];
  if(!Array.isArray(value.unknowns)||value.unknowns.length>64)errors.push({id:"unknowns-invalid",detail:"unknowns must be a bounded array"});
  else for(const raw of value.unknowns){const item=text(raw,1024);if(!item)errors.push({id:"unknown-invalid",detail:"unknowns contains invalid text"});else inputUnknowns.push(item);}
  if(errors.length>0||!taskId||!sourceTaskIds||!repository||evidence.length===0||contextFiles.length===0)return{valid:false,input:null,errors};
  return{valid:true,input:{version:1,taskId,repository,sourceTaskIds,evidence:evidence.sort((a,b)=>a.id.localeCompare(b.id)),contextFiles:contextFiles.sort((a,b)=>a.path.localeCompare(b.path)),unknowns:inputUnknowns},errors:[]};
}
/** @param {string} root @param {string[]} args */
function git(root,args){const result=spawnSync("git",args,{cwd:root,encoding:"utf8",maxBuffer:8*1024*1024,timeout:10000,env:{PATH:process.env.PATH??""}});if(result.status!==0)throw new Error("read-only Git worktree inspection failed");return result.stdout;}

/** @param {string} root @param {string} expectedCommit @param {boolean} [requireClean] */
export function inspectAgentRepairWorktree(root,expectedCommit,requireClean=true){
  const resolved=path.resolve(root);let stat;try{stat=fs.lstatSync(resolved);}catch{throw new Error("repair worktree is unavailable");}
  if(!stat.isDirectory()||stat.isSymbolicLink()||fs.realpathSync(resolved)!==resolved)throw new Error("repair worktree must be a regular non-symlink directory");
  let gitStat;try{gitStat=fs.lstatSync(path.join(resolved,".git"));}catch{throw new Error("repair root is not a linked Git worktree");}
  if(!gitStat.isFile()||gitStat.isSymbolicLink())throw new Error("repair root must be a linked Git worktree, not the primary checkout");
  if(path.resolve(git(resolved,["rev-parse","--show-toplevel"]).trim())!==resolved)throw new Error("repair worktree top-level does not match supplied root");
  const head=git(resolved,["rev-parse","HEAD"]).trim().toLowerCase();if(!isFullObjectId(head)||head!==expectedCommit)throw new Error("repair worktree HEAD does not match task baseCommit");
  const status=git(resolved,["status","--porcelain=v1","-z","--untracked-files=all"]);if(requireClean&&status!=="")throw new Error("repair worktree must be clean");
  return{root:resolved,head,clean:status==="",linkedWorktree:true};
}
/** @param {string} root @param {string} relativePath */
function resolveInside(root,relativePath){const target=path.resolve(root,...relativePath.split("/"));if(target!==path.join(root,relativePath)||!target.startsWith(`${root}${path.sep}`))throw new Error("repair path escapes worktree");return target;}

/** @param {string} root @param {any} input */
export function verifyAgentWorktreeContext(root,input){
  for(const item of input.contextFiles){const target=resolveInside(root,item.path);let stat;try{stat=fs.lstatSync(target);}catch{throw new Error(`repair context file is unavailable: ${item.path}`);}if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<=0||stat.size>512*1024)throw new Error(`repair context file is not a bounded single-link regular file: ${item.path}`);const content=fs.readFileSync(target,"utf8");if(content.includes("\u0000")||sha256(content)!==item.sha256||content!==item.content)throw new Error(`repair context file does not match exact supplied content/hash: ${item.path}`);}
}

/** @param {any} task @param {any} policy @param {any} input */
function validateRepairBindings(task,policy,input){
  if(task.role!=="repair")throw new Error("Agent Repair v1 requires task role repair");
  if(task.authority.filesystem!=="WORKTREE_WRITE"||task.authority.shell!=="NONE"||task.authority.network!=="NONE")throw new Error("Agent Repair v1 requires WORKTREE_WRITE with shell NONE and network NONE");
  if(policy.repository!==task.repository.id||input.repository.id!==task.repository.id||input.repository.commit!==task.repository.baseCommit||input.taskId!==task.id)throw new Error("repair policy/input do not match exact Agent Task repository identity");
  for(const check of policy.requiredChecks)if(!task.scope.requiredChecks.includes(check))throw new Error(`repair task is missing policy-required check ${check}`);
  if(input.sourceTaskIds.some((/** @type {string} */ sourceTaskId)=>!task.dependsOn.includes(sourceTaskId)))throw new Error("repair input sourceTaskIds must all be explicit Agent Task dependencies");
}
/** @param {unknown} value @param {any} task @param {any} policy @param {any} input */
export function validateAgentRepairProposal(value,task,policy,input){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,proposal:null,errors:[{id:"proposal-invalid",detail:"repair proposal must be an object"}]};
  unknown(value,["version","taskId","evidenceIds","rationale","files"],"proposal",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"repair proposal version must be exactly 1"});
  if(value.taskId!==task.id)errors.push({id:"task-binding-invalid",detail:"proposal taskId must equal repair task"});
  const inputEvidenceIds=new Set(input.evidence.map((/** @type {any} */ item)=>item.id));
  const evidenceIds=list(value.evidenceIds,id,64);if(!evidenceIds||evidenceIds.some((evidenceId)=>!inputEvidenceIds.has(evidenceId)))errors.push({id:"evidence-binding-invalid",detail:"proposal evidenceIds must be non-empty and come from Repair Input v1"});
  const rationale=text(value.rationale,4096,false);if(!rationale)errors.push({id:"rationale-invalid",detail:"proposal rationale is invalid"});
  const contextByPath=new Map(input.contextFiles.map((/** @type {any} */ item)=>[item.path,item]));
  /** @type {Array<any>} */const files=[];const paths=new Set();let totalBytes=0;
  if(!Array.isArray(value.files)||value.files.length===0||value.files.length>policy.maxFiles)errors.push({id:"files-invalid",detail:"proposal files must be non-empty and within policy maxFiles"});
  else for(const [index,raw]of value.files.entries()){
    if(!object(raw)){errors.push({id:"file-invalid",detail:`files[${index}] must be an object`});continue;}
    unknown(raw,["path","operation","beforeSha256","content"],"file",errors);
    const filePath=safePath(raw.path),operation=text(raw.operation,32),content=typeof raw.content==="string"&&!raw.content.includes("\u0000")?raw.content:null,before=raw.beforeSha256===null?null:text(raw.beforeSha256,64)?.toLowerCase()??null;
    const bytes=content===null?0:Buffer.byteLength(content,"utf8");
    if(!filePath||paths.has(filePath)||!operation||!OPERATIONS.has(operation)||!policy.allowedOperations.includes(operation)||content===null||bytes<=0||bytes>policy.maxFileBytes){errors.push({id:"file-fields-invalid",detail:`files[${index}] has invalid path, operation, or content`});continue;}
    if(!matches(filePath,policy.allowedPathPatterns)||matches(filePath,policy.deniedPathPatterns)||!matches(filePath,task.scope.allowedPaths)||matches(filePath,task.scope.deniedPaths)){errors.push({id:"file-path-denied",detail:`files[${index}] path is outside repair policy or task scope`});continue;}
    const context=contextByPath.get(filePath);
    if(operation==="MODIFY"&&(!before||!HASH.test(before)||!context||before!==context.sha256||sha256(content)===before)){errors.push({id:"modify-binding-invalid",detail:`files[${index}] MODIFY requires exact context beforeSha256 and changed content`});continue;}
    if(operation==="CREATE"&&(before!==null||context)){errors.push({id:"create-binding-invalid",detail:`files[${index}] CREATE requires beforeSha256 null and no existing context file`});continue;}
    paths.add(filePath);totalBytes+=bytes;files.push({path:filePath,operation,beforeSha256:before,content,contentSha256:sha256(content)});
  }
  if(totalBytes>policy.maxTotalBytes)errors.push({id:"files-total-bytes-invalid",detail:"proposal content exceeds policy maxTotalBytes"});
  if(errors.length>0||!evidenceIds||!rationale||files.length===0)return{valid:false,proposal:null,errors};
  return{valid:true,proposal:{version:1,taskId:task.id,evidenceIds,rationale,files:files.sort((a,b)=>a.path.localeCompare(b.path)),requiredChecks:[...new Set([...policy.requiredChecks,...task.scope.requiredChecks])].sort()},errors:[]};
}
/** @param {any} task @param {any} policy @param {any} input */
function buildRepairPrompt(task,policy,input){
  const payload={task:{id:task.id,objective:task.objective,repository:task.repository,risk:task.risk,requiredChecks:task.scope.requiredChecks},evidence:input.evidence,contextFiles:input.contextFiles,unknowns:input.unknowns,repairPolicy:{allowedPathPatterns:policy.allowedPathPatterns,deniedPathPatterns:policy.deniedPathPatterns,allowedOperations:policy.allowedOperations,maxFiles:policy.maxFiles,maxFileBytes:policy.maxFileBytes,maxTotalBytes:policy.maxTotalBytes,requiredChecks:policy.requiredChecks}};
  const system=[
    "You are a bounded software repair proposer operating against an exact isolated worktree snapshot.",
    "Return JSON only. Do not run commands, tests, network calls, package managers, migrations, deployments, payments, bookings, or production actions.",
    "Use only the supplied evidence and contextFiles. Do not invent business rules or canonical truth.",
    "Propose MODIFY or CREATE only when allowed. Never delete, rename, weaken tests, modify policy to make checks pass, or add lint/type/coverage bypasses.",
    "For MODIFY, beforeSha256 must exactly equal the supplied context file SHA256. CREATE requires beforeSha256 null.",
    "Schema: {version:1,taskId:string,evidenceIds:string[],rationale:string,files:[{path:string,operation:'MODIFY'|'CREATE',beforeSha256:string|null,content:string}]}"
  ].join(" ");
  return{system,user:JSON.stringify(payload)};
}

/** @param {any} task @param {any} rolePolicy @param {any} policy @param {any} input @param {string} worktree @param {any} modelConfig @param {string} backend @param {string} model @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function proposeAgentRepair(task,rolePolicy,policy,input,worktree,modelConfig,backend,model,deps={}){
  validateRepairBindings(task,policy,input);
  const roleAudit=inspectAgentTaskRolePolicy(task,rolePolicy);if(roleAudit.overallStatus!=="PASS"||!roleAudit.leaseRequired)throw new Error("repair task is not authorized by Agent Role Policy v1");
  const state=inspectAgentRepairWorktree(worktree,task.repository.baseCommit,true);verifyAgentWorktreeContext(state.root,input);
  const prompt=buildRepairPrompt(task,policy,input);
  const request=validateAgentModelRequest({version:1,backend,model,messages:[{role:"system",content:prompt.system},{role:"user",content:prompt.user}],temperature:0,maxOutputTokens:8192,timeoutMs:60000});if(!request.valid||!request.request)throw new Error("repair model request is invalid");
  const response=await(deps.invoke??invokeAgentLocalModel)(modelConfig,request.request);let raw;try{raw=JSON.parse(response.content);}catch{throw new Error("repair model returned non-JSON output");}
  const proposal=validateAgentRepairProposal(raw,task,policy,input);if(!proposal.valid||!proposal.proposal)throw new Error("repair model output failed Repair Proposal v1 validation");
  return{version:1,taskId:task.id,status:"PROPOSAL_READY",repository:task.repository,sourceTaskIds:input.sourceTaskIds,proposal:proposal.proposal,worktreeApplyPolicyEligible:policy.applyMode==="ALLOW_LOW_RISK_WORKTREE"&&task.risk==="LOW",worktreeMutationPerformed:false,checksExecuted:false,executionAuthorized:false,mergeAuthorized:false,deployAuthorized:false,productionMutationAuthorized:false,model:{backend:response.backend,model:response.model},semantics:"bounded repair proposal over exact supplied context; no source mutation or check execution occurred"};
}
/** @param {any} task @param {any} rolePolicy @param {import("node:sqlite").DatabaseSync} db @param {string} leaseId @param {string} workerId @param {string} evaluatedAt */
function requireActiveRepairLease(task,rolePolicy,db,leaseId,workerId,evaluatedAt){
  if(!isAbsoluteIsoTimestamp(evaluatedAt))throw new Error("repair evaluatedAt must be an absolute ISO timestamp");
  const roleAudit=inspectAgentTaskRolePolicy(task,rolePolicy);if(roleAudit.overallStatus!=="PASS"||!roleAudit.leaseRequired)throw new Error("repair task is not authorized for leased worktree writes");
  expireAgentWorkerLeases(db,evaluatedAt);const lease=getAgentWorkerLease(db,leaseId),registered=getAgentTask(db,task.id);
  if(!lease||!registered)throw new Error("repair task or lease is not registered");
  if(JSON.stringify(registered.task)!==JSON.stringify(task)||registered.state!=="RUNNING")throw new Error("registered repair task must match input exactly and be RUNNING");
  if(lease.releasedAt!==null||lease.mode!=="WRITE"||lease.taskId!==task.id||lease.workerId!==workerId||lease.repositoryId!==task.repository.id)throw new Error("active WRITE lease does not match repair task, worker, and repository");
  if(Date.parse(lease.expiresAt)<=Date.parse(evaluatedAt))throw new Error("repair WRITE lease is expired");
  return{roleAudit,lease};
}

/** @param {string} root */
export function getAgentWorktreeChangedPaths(root){
  const records=git(root,["status","--porcelain=v1","-z","--untracked-files=all"]).split("\0").filter(Boolean);
  return records.map((record)=>record.length>=4?record.slice(3):"").sort();
}

/** @param {string} root @param {string[]} expectedPaths */
function requireOnlyRepairChanges(root,expectedPaths){
  const paths=getAgentWorktreeChangedPaths(root),expected=[...expectedPaths].sort();
  if(paths.length!==expected.length||paths.some((value,index)=>value!==expected[index]))throw new Error("repair worktree changed outside declared proposal paths");
}
/** @param {string} root @param {any} proposal */
function prepareRepairWrites(root,proposal){
  /** @type {Array<any>} */const prepared=[];
  for(const file of proposal.files){
    const target=resolveInside(root,file.path),parent=path.dirname(target);let parentStat;try{parentStat=fs.lstatSync(parent);}catch{throw new Error(`repair parent directory is unavailable: ${file.path}`);}
    if(!parentStat.isDirectory()||parentStat.isSymbolicLink()||fs.realpathSync(parent)!==parent)throw new Error(`repair parent directory is unsafe: ${file.path}`);
    if(file.operation==="MODIFY"){
      let stat;try{stat=fs.lstatSync(target);}catch{throw new Error(`repair MODIFY target is unavailable: ${file.path}`);}
      if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>512*1024)throw new Error(`repair MODIFY target is not a bounded single-link regular file: ${file.path}`);
      const original=fs.readFileSync(target,"utf8");if(original.includes("\u0000")||sha256(original)!==file.beforeSha256)throw new Error(`repair MODIFY beforeSha256 is stale: ${file.path}`);
      prepared.push({path:file.path,target,operation:file.operation,original,mode:stat.mode,content:file.content,contentSha256:file.contentSha256});
    }else{
      try{fs.lstatSync(target);throw new Error(`repair CREATE target already exists: ${file.path}`);}catch(error){if(error instanceof Error&&error.message.startsWith("repair CREATE target already exists"))throw error;if(!(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT"))throw new Error(`repair CREATE target cannot be safely inspected: ${file.path}`);}
      prepared.push({path:file.path,target,operation:file.operation,original:null,mode:0o600,content:file.content,contentSha256:file.contentSha256});
    }
  }
  return prepared;
}

/** @param {Array<any>} prepared */
function rollbackRepairWrites(prepared){
  for(const file of [...prepared].reverse()){
    try{if(file.operation==="CREATE"){if(fs.existsSync(file.target))fs.unlinkSync(file.target);}else fs.writeFileSync(file.target,file.original,{encoding:"utf8",mode:file.mode});}catch{/* preserve original apply failure */}
  }
}
/** @param {any} task @param {any} rolePolicy @param {any} policy @param {any} input @param {unknown} rawProposal @param {import("node:sqlite").DatabaseSync} db @param {string} leaseId @param {string} workerId @param {string} evaluatedAt @param {string} worktree */
export function applyAgentRepair(task,rolePolicy,policy,input,rawProposal,db,leaseId,workerId,evaluatedAt,worktree){
  validateRepairBindings(task,policy,input);
  if(policy.applyMode!=="ALLOW_LOW_RISK_WORKTREE")throw new Error("repair policy is proposal-only and does not authorize worktree apply");
  if(task.risk!=="LOW")throw new Error("worktree apply is limited to LOW risk repair tasks");
  const proposalResult=validateAgentRepairProposal(rawProposal,task,policy,input);if(!proposalResult.valid||!proposalResult.proposal)throw new Error("Repair Proposal v1 is invalid");
  const authorization=requireActiveRepairLease(task,rolePolicy,db,leaseId,workerId,evaluatedAt);
  const state=inspectAgentRepairWorktree(worktree,task.repository.baseCommit,true);verifyAgentWorktreeContext(state.root,input);
  const prepared=prepareRepairWrites(state.root,proposalResult.proposal);let applied=false;
  try{
    for(const file of prepared){if(file.operation==="CREATE")fs.writeFileSync(file.target,file.content,{encoding:"utf8",flag:"wx",mode:0o600});else fs.writeFileSync(file.target,file.content,{encoding:"utf8",flag:"w"});}
    applied=true;
    for(const file of prepared){let stat;try{stat=fs.lstatSync(file.target);}catch{throw new Error(`repair output file is unavailable: ${file.path}`);}if(!stat.isFile()||stat.isSymbolicLink()||sha256(fs.readFileSync(file.target,"utf8"))!==file.contentSha256)throw new Error(`repair output hash mismatch: ${file.path}`);}
    requireOnlyRepairChanges(state.root,prepared.map((file)=>file.path));
  }catch(error){if(applied||prepared.some((file)=>fs.existsSync(file.target)))rollbackRepairWrites(prepared);throw error;}
  return{version:1,taskId:task.id,status:"PATCH_APPLIED_IN_WORKTREE",repository:task.repository,proposalSha256:sha256(JSON.stringify(proposalResult.proposal)),files:prepared.map((file)=>({path:file.path,operation:file.operation,beforeSha256:file.operation==="MODIFY"?sha256(file.original):null,contentSha256:file.contentSha256})),requiredChecks:proposalResult.proposal.requiredChecks,checksExecuted:false,worktreeMutationPerformed:true,executionAuthorized:false,mergeAuthorized:false,deployAuthorized:false,productionMutationAuthorized:false,lease:{leaseId:authorization.lease.leaseId,workerId:authorization.lease.workerId,mode:authorization.lease.mode,expiresAt:authorization.lease.expiresAt},semantics:"LOW-risk repair content was applied only inside the leased linked worktree; required checks were not executed and merge/deploy remain unauthorized"};
}
/** @param {string} filename */
function readJsonFile(filename){const resolved=path.resolve(filename);let stat;try{stat=fs.lstatSync(resolved);}catch{throw new Error("repair input file is unavailable");}if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||stat.size>MAX_INPUT_BYTES)throw new Error("repair input must be a bounded regular non-symlink file");try{return JSON.parse(fs.readFileSync(resolved,"utf8"));}catch{throw new Error("repair input cannot be parsed");}}

/** @param {string[]} argv */
function parse(argv){
  const command=argv[0];if(!command||!["propose","apply"].includes(command))return null;
  const values=new Map(),flags=new Set();
  const allowed=new Set(["--task","--role-policy","--policy","--input","--worktree","--model-config","--backend","--model","--proposal","--registry","--lease-id","--worker-id","--evaluated-at"]);
  for(let i=1;i<argv.length;i+=1){const arg=argv[i];if(arg==="--json"){if(flags.has(arg))return null;flags.add(arg);continue;}if(!allowed.has(arg??"")||values.has(arg))return null;const next=argv[i+1];if(typeof next!=="string"||next.startsWith("--"))return null;values.set(arg,next);i+=1;}
  const common=["--task","--role-policy","--policy","--input","--worktree"];
  const required=command==="propose"?[...common,"--model-config","--backend","--model"]:[...common,"--proposal","--registry","--lease-id","--worker-id","--evaluated-at"];
  if(required.some((key)=>!values.has(key)))return null;
  const allowedForCommand=new Set(required);if([...values.keys()].some((key)=>!allowedForCommand.has(key)))return null;
  return{command,values,json:flags.has("--json")};
}

/** @param {string[]} argv @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function main(argv=process.argv.slice(2),deps={}){
  const options=parse(argv);if(!options){console.error("Usage: node scripts/agent-repair.js propose --task <task.json> --role-policy <roles.json> --policy <repair-policy.json> --input <repair-input.json> --worktree <path> --model-config <models.json> --backend <id> --model <id> [--json] | apply --task <task.json> --role-policy <roles.json> --policy <repair-policy.json> --input <repair-input.json> --worktree <path> --proposal <proposal.json> --registry <registry.sqlite> --lease-id <id> --worker-id <id> --evaluated-at <ISO> [--json]");return 1;}
  try{
    const taskResult=validateAgentTask(readJsonFile(options.values.get("--task"))),roleResult=validateAgentRolePolicy(readJsonFile(options.values.get("--role-policy"))),policyResult=validateAgentRepairPolicy(readJsonFile(options.values.get("--policy"))),inputResult=validateAgentRepairInput(readJsonFile(options.values.get("--input")));
    if(!taskResult.valid||!taskResult.task||!roleResult.valid||!roleResult.policy||!policyResult.valid||!policyResult.policy||!inputResult.valid||!inputResult.input)throw new Error("repair task, role policy, repair policy, or input is invalid");
    if(options.command==="propose"){
      const modelConfig=readAgentModelConfigFile(options.values.get("--model-config"));const report=await proposeAgentRepair(taskResult.task,roleResult.policy,policyResult.policy,inputResult.input,options.values.get("--worktree"),modelConfig,options.values.get("--backend"),options.values.get("--model"),deps);console.log(options.json?JSON.stringify(report):JSON.stringify(report,null,2));return 0;
    }
    const proposalRaw=readJsonFile(options.values.get("--proposal")),db=openAgentTaskRegistry(options.values.get("--registry"));
    try{const report=applyAgentRepair(taskResult.task,roleResult.policy,policyResult.policy,inputResult.input,proposalRaw,db,options.values.get("--lease-id"),options.values.get("--worker-id"),options.values.get("--evaluated-at"),options.values.get("--worktree"));console.log(options.json?JSON.stringify(report):JSON.stringify(report,null,2));return 0;}finally{db.close();}
  }catch(error){console.error(error instanceof Error?error.message:"agent repair failed");return 1;}
}

if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=await main();
