#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { validateAgentTask } from "./agent-task.js";
import { validateAgentRolePolicy, inspectAgentTaskRolePolicy } from "./agent-role-policy.js";
import { getAgentTask, openAgentTaskRegistry } from "./agent-task-registry.js";
import { expireAgentWorkerLeases, getAgentWorkerLease } from "./agent-worker-lease.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const BWRAP = "/usr/bin/bwrap";
const PRLIMIT = "/usr/bin/prlimit";
const GIT = "/usr/bin/git";
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const TARGET = /^\/runtime\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const COMMAND_PATH = /^(?:\/usr\/|\/bin\/|\/sbin\/|\/runtime\/)[^\u0000\r\n]{1,500}$/;
const MAX_METADATA_BYTES = 64 * 1024;

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {unknown} value @param {number} [max] */
function text(value,max=512){if(typeof value!=="string")return null;const v=value.trim();return v.length>0&&v.length<=max&&!/[\u0000\r\n]/.test(v)?v:null;}
/** @param {unknown} value */
function id(value){const v=text(value,128);return v&&ID.test(v)?v:null;}
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value,min,max){return Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=max?Number(value):null;}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${key}"`});}
/** @param {string|Buffer} value */
function sha256(value){return crypto.createHash("sha256").update(value).digest("hex");}
const LIMIT_FIELDS=["wallTimeMs","cpuSeconds","addressSpaceBytes","fileSizeBytes","openFiles","processes","maxOutputBytes","maxWorkspaceBytes","maxWorkspaceFiles"];

/** @param {unknown} value */
export function validateAgentSandboxPolicy(value){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,policy:null,errors:[{id:"policy-invalid",detail:"sandbox policy must be an object"}]};
  unknown(value,["version","repository","backend","network","runtimeReadOnlyBinds","commands","limits"],"policy",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"sandbox policy version must be exactly 1"});
  const repository=id(value.repository),backend=text(value.backend,32),network=text(value.network,32);
  if(!repository||backend!=="BWRAP"||network!=="NONE")errors.push({id:"policy-identity-invalid",detail:"sandbox policy requires repository, BWRAP backend, and network NONE"});

  /** @type {Array<any>} */const runtimeReadOnlyBinds=[];const bindIds=new Set(),bindTargets=new Set();
  if(!Array.isArray(value.runtimeReadOnlyBinds)||value.runtimeReadOnlyBinds.length>32)errors.push({id:"runtime-binds-invalid",detail:"runtimeReadOnlyBinds must be a bounded array"});
  else for(const [index,raw]of value.runtimeReadOnlyBinds.entries()){
    if(!object(raw)){errors.push({id:"runtime-bind-invalid",detail:`runtimeReadOnlyBinds[${index}] must be an object`});continue;}
    unknown(raw,["id","source","target"],"runtime-bind",errors);
    const bindId=id(raw.id),source=text(raw.source,4096),target=text(raw.target,512);
    if(!bindId||bindIds.has(bindId)||!source||!path.isAbsolute(source)||!target||!TARGET.test(target)||bindTargets.has(target)){errors.push({id:"runtime-bind-fields-invalid",detail:`runtimeReadOnlyBinds[${index}] is invalid or duplicate`});continue;}
    bindIds.add(bindId);bindTargets.add(target);runtimeReadOnlyBinds.push({id:bindId,source:path.resolve(source),target});
  }

  /** @type {Array<any>} */const commands=[];const commandIds=new Set();
  if(!Array.isArray(value.commands)||value.commands.length===0||value.commands.length>64)errors.push({id:"commands-invalid",detail:"commands must be a non-empty bounded array"});
  else for(const [index,raw]of value.commands.entries()){
    if(!object(raw)){errors.push({id:"command-invalid",detail:`commands[${index}] must be an object`});continue;}
    unknown(raw,["id","argv"],"command",errors);const commandId=id(raw.id);
    const argv=Array.isArray(raw.argv)?raw.argv.map((item)=>text(item,512)):null;
    if(!commandId||commandIds.has(commandId)||!argv||argv.length===0||argv.length>64||argv.some((item)=>item===null)||!COMMAND_PATH.test(argv[0]??"")){errors.push({id:"command-fields-invalid",detail:`commands[${index}] has invalid id or exact argv`});continue;}
    commandIds.add(commandId);commands.push({id:commandId,argv:/** @type {string[]} */(argv)});
  }
  let limits=null;
  if(!object(value.limits))errors.push({id:"limits-invalid",detail:"limits must be an object"});
  else{
    unknown(value.limits,LIMIT_FIELDS,"limits",errors);
    const wallTimeMs=integer(value.limits.wallTimeMs,100,300000),cpuSeconds=integer(value.limits.cpuSeconds,1,300),addressSpaceBytes=integer(value.limits.addressSpaceBytes,64*1024*1024,32*1024*1024*1024),fileSizeBytes=integer(value.limits.fileSizeBytes,1024,1024*1024*1024),openFiles=integer(value.limits.openFiles,16,4096),processes=integer(value.limits.processes,1,512),maxOutputBytes=integer(value.limits.maxOutputBytes,1024,16*1024*1024),maxWorkspaceBytes=integer(value.limits.maxWorkspaceBytes,1024,20*1024*1024*1024),maxWorkspaceFiles=integer(value.limits.maxWorkspaceFiles,1,500000);
    if([wallTimeMs,cpuSeconds,addressSpaceBytes,fileSizeBytes,openFiles,processes,maxOutputBytes,maxWorkspaceBytes,maxWorkspaceFiles].some((item)=>item===null))errors.push({id:"limit-fields-invalid",detail:"sandbox resource limits are missing or outside hard bounds"});
    else limits={wallTimeMs,cpuSeconds,addressSpaceBytes,fileSizeBytes,openFiles,processes,maxOutputBytes,maxWorkspaceBytes,maxWorkspaceFiles};
  }
  if(errors.length>0||!repository||backend!=="BWRAP"||network!=="NONE"||!limits)return{valid:false,policy:null,errors};
  return{valid:true,policy:{version:1,repository,backend:"BWRAP",network:"NONE",runtimeReadOnlyBinds:runtimeReadOnlyBinds.sort((a,b)=>a.id.localeCompare(b.id)),commands:commands.sort((a,b)=>a.id.localeCompare(b.id)),limits},errors:[]};
}

/** @param {any} task @param {any} policy */
export function deriveAgentSandboxId(task,policy){
  const payload=JSON.stringify({version:1,taskId:task.id,repository:task.repository.id,baseCommit:task.repository.baseCommit,policy});
  return`sandbox:${sha256(payload).slice(0,32)}`;
}

/** @param {string} absolute */
function assertNoSymlinkAncestors(absolute){
  const resolved=path.resolve(absolute),parsed=path.parse(resolved),parts=resolved.slice(parsed.root.length).split(path.sep).filter(Boolean);let current=parsed.root;
  for(const part of parts){current=path.join(current,part);let stat;try{stat=fs.lstatSync(current);}catch{throw new Error(`required path does not exist: ${current}`);}if(stat.isSymbolicLink())throw new Error(`symlinked host path is not allowed: ${current}`);}
  return resolved;
}

/** @param {string} parent @param {string} child */
function within(parent,child){const rel=path.relative(parent,child);return rel!==""&&!rel.startsWith(`..${path.sep}`)&&rel!==".."&&!path.isAbsolute(rel);}
/** @param {string} filename @param {string} label */
function requirePrimitive(filename,label){let stat;try{stat=fs.lstatSync(filename);}catch{throw new Error(`${label} primitive is unavailable`);}if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o111)===0)throw new Error(`${label} primitive is not a regular executable`);}

/** @param {string} root @param {string[]} args @param {number} [timeout] */
function git(root,args,timeout=15000){const result=spawnSync(GIT,["-C",root,...args],{encoding:"utf8",timeout,maxBuffer:8*1024*1024,env:{PATH:"/usr/bin:/bin",LANG:"C"}});if(result.status!==0)throw new Error("sandbox Git operation failed");return result.stdout;}

/** @param {string} repositoryRoot @param {string} expectedCommit */
function inspectRepositoryRoot(repositoryRoot,expectedCommit){
  requirePrimitive(GIT,"Git");const root=assertNoSymlinkAncestors(repositoryRoot);const stat=fs.lstatSync(root);if(!stat.isDirectory())throw new Error("repository root must be a directory");
  const top=path.resolve(git(root,["rev-parse","--show-toplevel"]).trim());if(top!==root)throw new Error("repository root does not match Git top-level");
  const headObject=git(root,["rev-parse",`${expectedCommit}^{commit}`]).trim().toLowerCase();if(headObject!==expectedCommit)throw new Error("task baseCommit is not the exact locally available commit");
  return root;
}

/** @param {any} task @param {any} rolePolicy @param {import("node:sqlite").DatabaseSync|null} db @param {string|null} leaseId @param {string|null} workerId @param {string} evaluatedAt */
function authorizeSandbox(task,rolePolicy,db,leaseId,workerId,evaluatedAt){
  if(!isAbsoluteIsoTimestamp(evaluatedAt))throw new Error("sandbox authorization time must be an absolute ISO timestamp");
  const roleAudit=inspectAgentTaskRolePolicy(task,rolePolicy);if(roleAudit.overallStatus!=="PASS")throw new Error("sandbox task is not authorized by Agent Role Policy v1");
  if(task.authority.network!=="NONE")throw new Error("Task Sandbox v1 only supports network NONE");
  if(task.authority.filesystem!=="WORKTREE_WRITE")return{roleAudit,lease:null};
  if(!db||!leaseId||!workerId)throw new Error("write sandbox requires an explicit registry, lease, and worker");
  expireAgentWorkerLeases(db,evaluatedAt);const record=getAgentTask(db,task.id);if(!record||JSON.stringify(record.task)!==JSON.stringify(task)||record.state!=="RUNNING")throw new Error("write sandbox requires the exact RUNNING registered Agent Task");
  const lease=getAgentWorkerLease(db,leaseId);if(!lease||lease.releasedAt!==null||lease.taskId!==task.id||lease.workerId!==workerId||lease.repositoryId!==task.repository.id||lease.mode!=="WRITE"||Date.parse(lease.expiresAt)<=Date.parse(evaluatedAt))throw new Error("write sandbox requires the exact active WRITE lease");
  return{roleAudit,lease};
}

/** @param {any} task @param {any} policy */
function controlName(task,policy){return`agent-sandbox-${deriveAgentSandboxId(task,policy).slice("sandbox:".length)}`;}
/** @param {string} filename @returns {any} */
function readMetadata(filename){let stat;try{stat=fs.lstatSync(filename);}catch{throw new Error("sandbox metadata is unavailable");}if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||stat.size>MAX_METADATA_BYTES)throw new Error("sandbox metadata must be a bounded regular file");let value;try{value=JSON.parse(fs.readFileSync(filename,"utf8"));}catch{throw new Error("sandbox metadata cannot be parsed");}if(!object(value))throw new Error("sandbox metadata must be an object");return value;}

/** @param {any} task @param {any} policy @param {string} repositoryRoot @param {string} sandboxParent */
function sandboxLocations(task,policy,repositoryRoot,sandboxParent){
  const sourceRoot=inspectRepositoryRoot(repositoryRoot,task.repository.baseCommit),parent=assertNoSymlinkAncestors(sandboxParent);if(!fs.lstatSync(parent).isDirectory())throw new Error("sandbox parent must be a directory");
  const controlRoot=path.join(parent,controlName(task,policy));if(controlRoot===sourceRoot||within(sourceRoot,controlRoot))throw new Error("sandbox control directory cannot be inside the source repository");
  return{sourceRoot,parent,controlRoot,worktreeRoot:path.join(controlRoot,"worktree"),metadataFile:path.join(controlRoot,"sandbox.json")};
}

/** @param {any} task @param {any} policy @param {ReturnType<typeof sandboxLocations>} locations @param {string} createdAt */
function sandboxMetadata(task,policy,locations,createdAt){return{version:1,sandboxId:deriveAgentSandboxId(task,policy),taskId:task.id,repository:task.repository.id,baseCommit:task.repository.baseCommit,filesystem:task.authority.filesystem,sourceRoot:locations.sourceRoot,sandboxParent:locations.parent,controlRoot:locations.controlRoot,worktreeRoot:locations.worktreeRoot,metadataFile:locations.metadataFile,policySha256:sha256(JSON.stringify(policy)),createdAt};}

/** @param {any} task @param {any} policy @param {string} repositoryRoot @param {string} sandboxParent @returns {any} */
function loadSandboxMetadata(task,policy,repositoryRoot,sandboxParent){
  if(policy.repository!==task.repository.id)throw new Error("sandbox policy repository does not match task repository");
  const locations=sandboxLocations(task,policy,repositoryRoot,sandboxParent),metadata=readMetadata(locations.metadataFile),expected=sandboxMetadata(task,policy,locations,metadata.createdAt);
  if(!isAbsoluteIsoTimestamp(metadata.createdAt)||JSON.stringify(metadata)!==JSON.stringify(expected))throw new Error("sandbox metadata does not match exact task, policy, or paths");
  return{locations,metadata};
}

/** @param {any} task @param {any} policy @param {string} repositoryRoot @param {string} sandboxParent @returns {any} */
export function inspectAgentTaskSandbox(task,policy,repositoryRoot,sandboxParent){
  const loaded=loadSandboxMetadata(task,policy,repositoryRoot,sandboxParent),locations=loaded.locations,metadata=loaded.metadata;
  let worktreeStat;try{worktreeStat=fs.lstatSync(locations.worktreeRoot);}catch{throw new Error("sandbox worktree is unavailable");}if(!worktreeStat.isDirectory()||worktreeStat.isSymbolicLink())throw new Error("sandbox worktree must be a regular directory");
  const dotGit=fs.lstatSync(path.join(locations.worktreeRoot,".git"));if(!dotGit.isFile()||dotGit.isSymbolicLink())throw new Error("sandbox must be a linked Git worktree");
  const top=path.resolve(git(locations.worktreeRoot,["rev-parse","--show-toplevel"]).trim()),head=git(locations.worktreeRoot,["rev-parse","HEAD"]).trim().toLowerCase();if(top!==locations.worktreeRoot||head!==task.repository.baseCommit)throw new Error("sandbox worktree identity does not match exact task commit");
  const status=git(locations.worktreeRoot,["status","--porcelain=v1","-z","--untracked-files=all"]);
  return{...metadata,clean:status==="",changed:status!==""};
}
/** @param {any} policy */
function inspectRuntimeBinds(policy){
  /** @type {Array<any>} */const inspected=[];
  for(const bind of policy.runtimeReadOnlyBinds){const source=assertNoSymlinkAncestors(bind.source),stat=fs.lstatSync(source);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o111)===0)throw new Error(`runtime bind ${bind.id} must be one regular executable file`);inspected.push({...bind,source});}
  for(const command of policy.commands){const executable=command.argv[0];if(executable.startsWith("/runtime/")&&!inspected.some((bind)=>executable===bind.target))throw new Error(`command ${command.id} executable is outside declared runtime binds`);}
  return inspected;
}

/** @param {any} task @param {any} rolePolicy @param {any} policy @param {{repositoryRoot:string,sandboxParent:string,createdAt:string,db?:import("node:sqlite").DatabaseSync|null,leaseId?:string|null,workerId?:string|null}} options */
export function createAgentTaskSandbox(task,rolePolicy,policy,options){
  if(policy.repository!==task.repository.id)throw new Error("sandbox policy repository does not match task repository");
  requirePrimitive(BWRAP,"Bubblewrap");requirePrimitive(PRLIMIT,"prlimit");inspectRuntimeBinds(policy);
  const authorization=authorizeSandbox(task,rolePolicy,options.db??null,options.leaseId??null,options.workerId??null,options.createdAt),locations=sandboxLocations(task,policy,options.repositoryRoot,options.sandboxParent);
  if(fs.existsSync(locations.controlRoot))throw new Error("deterministic task sandbox already exists");
  fs.mkdirSync(locations.controlRoot,{mode:0o700});let worktreeCreated=false;
  try{
    git(locations.sourceRoot,["worktree","add","--detach",locations.worktreeRoot,task.repository.baseCommit],30000);worktreeCreated=true;
    const metadata=sandboxMetadata(task,policy,locations,options.createdAt);fs.writeFileSync(locations.metadataFile,`${JSON.stringify(metadata,null,2)}\n`,{encoding:"utf8",flag:"wx",mode:0o600});
    const inspected=inspectAgentTaskSandbox(task,policy,locations.sourceRoot,locations.parent);if(!inspected.clean)throw new Error("new task sandbox must start clean");
    return{...inspected,lease:authorization.lease?{leaseId:authorization.lease.leaseId,workerId:authorization.lease.workerId,expiresAt:authorization.lease.expiresAt}:null,network:"NONE",executionPerformed:false};
  }catch(error){
    if(worktreeCreated){try{git(locations.sourceRoot,["worktree","remove","--force",locations.worktreeRoot]);}catch{/* preserve create error */}}
    try{fs.rmSync(locations.controlRoot,{recursive:true,force:true});}catch{/* preserve create error */}
    throw error;
  }
}
/** @param {string} root @param {any} limits */
function measureWorkspace(root,limits){let files=0,bytes=0;const stack=[root];while(stack.length>0){const current=stack.pop();if(!current)continue;const stat=fs.lstatSync(current);files+=1;if(stat.isFile()||stat.isSymbolicLink())bytes+=stat.size;if(files>limits.maxWorkspaceFiles||bytes>limits.maxWorkspaceBytes)return{files,bytes,exceeded:true};if(stat.isDirectory()&&!stat.isSymbolicLink())for(const name of fs.readdirSync(current))stack.push(path.join(current,name));}return{files,bytes,exceeded:false};}

/** @param {any} task @param {any} policy @param {any} sandbox @param {string} commandId */
export function buildAgentSandboxInvocation(task,policy,sandbox,commandId){
  const command=policy.commands.find((/** @type {any} */ item)=>item.id===commandId);if(!command)throw new Error("sandbox command id is not declared by policy");const binds=inspectRuntimeBinds(policy);
  const bwrap=["--die-with-parent","--new-session","--unshare-all","--hostname","agent-sandbox","--cap-drop","ALL","--ro-bind","/usr","/usr","--symlink","usr/bin","/bin","--symlink","usr/sbin","/sbin","--symlink","usr/lib","/lib","--symlink","usr/lib64","/lib64","--proc","/proc","--dev","/dev","--tmpfs","/tmp","--dir","/runtime"];
  for(const bind of binds)bwrap.push("--ro-bind",bind.source,bind.target);
  const l=policy.limits,prlimitArgs=[`--cpu=${l.cpuSeconds}`,`--as=${l.addressSpaceBytes}`,`--fsize=${l.fileSizeBytes}`,`--nofile=${l.openFiles}`,`--nproc=${l.processes}`,"--",...command.argv];
  bwrap.push(task.authority.filesystem==="WORKTREE_WRITE"?"--bind":"--ro-bind",sandbox.worktreeRoot,"/workspace","--chdir","/workspace","--clearenv","--setenv","PATH","/usr/bin:/bin","--setenv","HOME","/nonexistent","--setenv","TMPDIR","/tmp","--setenv","LANG","C.UTF-8","--",PRLIMIT,...prlimitArgs);
  return{executable:BWRAP,args:bwrap,commandId,commandSha256:sha256(JSON.stringify(command.argv)),network:"NONE",workspaceMode:task.authority.filesystem==="WORKTREE_WRITE"?"WRITE":"READ_ONLY"};
}

/** @param {any} task @param {any} rolePolicy @param {any} policy @param {{repositoryRoot:string,sandboxParent:string,commandId:string,evaluatedAt:string,db?:import("node:sqlite").DatabaseSync|null,leaseId?:string|null,workerId?:string|null}} options */
export function runAgentSandboxCommand(task,rolePolicy,policy,options){
  requirePrimitive(BWRAP,"Bubblewrap");requirePrimitive(PRLIMIT,"prlimit");const sandbox=inspectAgentTaskSandbox(task,policy,options.repositoryRoot,options.sandboxParent),authorization=authorizeSandbox(task,rolePolicy,options.db??null,options.leaseId??null,options.workerId??null,options.evaluatedAt);
  const before=measureWorkspace(sandbox.worktreeRoot,policy.limits);if(before.exceeded)throw new Error("sandbox workspace already exceeds configured resource limits");
  const invocation=buildAgentSandboxInvocation(task,policy,sandbox,options.commandId),result=spawnSync(invocation.executable,invocation.args,{cwd:sandbox.controlRoot,encoding:"utf8",timeout:policy.limits.wallTimeMs,maxBuffer:policy.limits.maxOutputBytes,killSignal:"SIGKILL",env:{PATH:"/usr/bin:/bin",LANG:"C"}});
  const code=result.error&&typeof result.error==="object"&&"code" in result.error?String(result.error.code):null,timedOut=code==="ETIMEDOUT",outputLimitExceeded=code==="ENOBUFS";
  if(result.error&&!timedOut&&!outputLimitExceeded)throw new Error("sandbox execution primitive failed");
  const stdout=typeof result.stdout==="string"?result.stdout:"",stderr=typeof result.stderr==="string"?result.stderr:"",after=measureWorkspace(sandbox.worktreeRoot,policy.limits),success=result.status===0&&!timedOut&&!outputLimitExceeded&&!after.exceeded;
  return{version:1,sandboxId:sandbox.sandboxId,taskId:task.id,repository:task.repository,commandId:options.commandId,commandSha256:invocation.commandSha256,evaluatedAt:options.evaluatedAt,status:success?"PASS":"FAIL",exitCode:result.status===null?null:Number(result.status),signal:result.signal??null,timedOut,outputLimitExceeded,workspaceLimitExceeded:after.exceeded,workspace:{before,after},output:{stdoutBytes:Buffer.byteLength(stdout,"utf8"),stderrBytes:Buffer.byteLength(stderr,"utf8"),stdoutSha256:sha256(stdout),stderrSha256:sha256(stderr)},limits:policy.limits,filesystem:task.authority.filesystem,network:"NONE",lease:authorization.lease?{leaseId:authorization.lease.leaseId,workerId:authorization.lease.workerId,expiresAt:authorization.lease.expiresAt}:null,executionPerformed:true,mergeAuthorized:false,deployAuthorized:false,productionMutationAuthorized:false,semantics:"exact policy command executed inside Bubblewrap through prlimit; host runtime is read-only, only the task workspace may be writable, network is unshared, and raw command output is not returned"};
}

/** @param {any} task @param {any} policy @param {{repositoryRoot:string,sandboxParent:string,cleanedAt:string}} options */
export function cleanupAgentTaskSandbox(task,policy,options){
  if(!isAbsoluteIsoTimestamp(options.cleanedAt))throw new Error("sandbox cleanup time must be an absolute ISO timestamp");
  const loaded=loadSandboxMetadata(task,policy,options.repositoryRoot,options.sandboxParent),locations=loaded.locations,metadata=loaded.metadata;
  let dirtyBeforeCleanup=null,worktreePresent=false;
  try{
    const stat=fs.lstatSync(locations.worktreeRoot);if(stat.isSymbolicLink()||!stat.isDirectory())throw new Error("sandbox worktree path is not a regular directory");worktreePresent=true;
    const top=path.resolve(git(locations.worktreeRoot,["rev-parse","--show-toplevel"]).trim()),head=git(locations.worktreeRoot,["rev-parse","HEAD"]).trim().toLowerCase();
    if(top!==locations.worktreeRoot||head!==task.repository.baseCommit)throw new Error("sandbox cleanup refuses mismatched worktree identity");
    dirtyBeforeCleanup=git(locations.worktreeRoot,["status","--porcelain=v1","-z","--untracked-files=all"])!=="";
  }catch(error){
    if(error instanceof Error&&/required path does not exist|ENOENT|no such file/i.test(error.message)){worktreePresent=false;}else if(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT"){worktreePresent=false;}else throw error;
  }
  if(worktreePresent)git(locations.sourceRoot,["worktree","remove","--force",locations.worktreeRoot],30000);
  git(locations.sourceRoot,["worktree","prune"]);
  fs.rmSync(locations.controlRoot,{recursive:true,force:true});
  if(fs.existsSync(locations.controlRoot))throw new Error("sandbox cleanup did not remove deterministic control directory");
  return{version:1,sandboxId:metadata.sandboxId,taskId:task.id,repository:task.repository,cleanedAt:options.cleanedAt,status:"CLEANED",worktreeWasPresent:worktreePresent,dirtyBeforeCleanup,cleanupPerformed:true,leaseRequired:false,semantics:"exact metadata-bound task sandbox cleanup removed the linked worktree and deterministic control directory; cleanup does not require an active worker lease"};
}

/** @param {string} filename @param {number} [maxBytes] */
function readJsonFile(filename,maxBytes=1024*1024){const resolved=path.resolve(filename);let stat;try{stat=fs.lstatSync(resolved);}catch{throw new Error("sandbox input file is unavailable");}if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||stat.size>maxBytes)throw new Error("sandbox input must be a bounded regular non-symlink file");try{return JSON.parse(fs.readFileSync(resolved,"utf8"));}catch{throw new Error("sandbox input cannot be parsed");}}

/** @param {any} result */
function formatSandboxResult(result){return[`Agent task sandbox`,"",`Status: ${result.status??(result.clean?"READY":"CHANGED")}`,`Sandbox: ${result.sandboxId}`,`Task: ${result.taskId}`,`Repository: ${result.repository?.id??result.repository}`,`Network: ${result.network??"NONE"}`,`Execution performed: ${result.executionPerformed??false}`,`Cleanup performed: ${result.cleanupPerformed??false}`].join("\n");}

/** @param {string[]} argv */
function parse(argv){
  const command=argv[0];if(!command||!["create","run","inspect","cleanup"].includes(command))return null;
  const values=new Map(),flags=new Set(),allowed=new Set(["--task","--role-policy","--policy","--repository-root","--sandbox-parent","--created-at","--evaluated-at","--cleaned-at","--command-id","--db","--lease-id","--worker-id"]);
  for(let index=1;index<argv.length;index+=1){const arg=argv[index];if(arg==="--json"){if(flags.has(arg))return null;flags.add(arg);continue;}if(!allowed.has(arg??"")||values.has(arg))return null;const value=argv[index+1];if(typeof value!=="string"||value.startsWith("--"))return null;values.set(arg,value);index+=1;}
  const common=["--task","--policy","--repository-root","--sandbox-parent"];
  const required=command==="create"?[...common,"--role-policy","--created-at"]:command==="run"?[...common,"--role-policy","--command-id","--evaluated-at"]:command==="cleanup"?[...common,"--cleaned-at"]:common;
  if(required.some((key)=>!values.has(key)))return null;
  const optional=new Set(required);if(command==="create"||command==="run")for(const key of ["--db","--lease-id","--worker-id"])optional.add(key);if([...values.keys()].some((key)=>!optional.has(key)))return null;
  return{command,values,json:flags.has("--json")};
}

/** @param {Map<string,string>} values */
function registryOptions(values){
  const dbFile=values.get("--db")??null,leaseId=values.get("--lease-id")??null,workerId=values.get("--worker-id")??null;
  if([dbFile,leaseId,workerId].filter((item)=>item!==null).length!==0&&[dbFile,leaseId,workerId].some((item)=>item===null))throw new Error("sandbox registry, lease, and worker options must be supplied together");
  return{dbFile,leaseId,workerId};
}

/** @param {string[]} argv */
export function main(argv=process.argv.slice(2)){
  const options=parse(argv);if(!options){console.error("Usage: node scripts/agent-task-sandbox.js <create|run|inspect|cleanup> --task <task.json> --policy <sandbox-policy.json> --repository-root <repo> --sandbox-parent <dir> [command options] [--json]");return 1;}
  let db=null;
  try{
    const taskResult=validateAgentTask(readJsonFile(options.values.get("--task")??"")),policyResult=validateAgentSandboxPolicy(readJsonFile(options.values.get("--policy")??""));
    if(!taskResult.valid||!taskResult.task||!policyResult.valid||!policyResult.policy)throw new Error("sandbox task or policy is invalid");
    const task=taskResult.task,policy=policyResult.policy,repositoryRoot=options.values.get("--repository-root")??"",sandboxParent=options.values.get("--sandbox-parent")??"";
    /** @type {any} */let result;
    if(options.command==="inspect")result=inspectAgentTaskSandbox(task,policy,repositoryRoot,sandboxParent);
    else if(options.command==="cleanup")result=cleanupAgentTaskSandbox(task,policy,{repositoryRoot,sandboxParent,cleanedAt:options.values.get("--cleaned-at")??""});
    else{
      const roleResult=validateAgentRolePolicy(readJsonFile(options.values.get("--role-policy")??""));if(!roleResult.valid||!roleResult.policy)throw new Error("sandbox role policy is invalid");
      const registry=registryOptions(options.values);if(registry.dbFile)db=openAgentTaskRegistry(registry.dbFile);
      if(options.command==="create")result=createAgentTaskSandbox(task,roleResult.policy,policy,{repositoryRoot,sandboxParent,createdAt:options.values.get("--created-at")??"",db,leaseId:registry.leaseId,workerId:registry.workerId});
      else result=runAgentSandboxCommand(task,roleResult.policy,policy,{repositoryRoot,sandboxParent,commandId:options.values.get("--command-id")??"",evaluatedAt:options.values.get("--evaluated-at")??"",db,leaseId:registry.leaseId,workerId:registry.workerId});
    }
    console.log(options.json?JSON.stringify(result):formatSandboxResult(result));return result.status==="FAIL"?1:0;
  }catch(error){console.error(error instanceof Error?error.message:"agent task sandbox failed");return 1;}finally{try{db?.close();}catch{/* no-op */}}
}

if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();
