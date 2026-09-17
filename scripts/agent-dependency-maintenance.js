#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateAgentTask } from "./agent-task.js";
import { validateAgentRolePolicy, inspectAgentTaskRolePolicy } from "./agent-role-policy.js";
import { readAgentModelConfigFile, validateAgentModelRequest, invokeAgentLocalModel } from "./agent-local-model.js";
import { isFullObjectId } from "./runtime-evidence.js";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const GENERATORS=new Set(["RENOVATE","DEPENDABOT","OTHER_DETERMINISTIC"]);
const ECOSYSTEMS=new Set(["NPM","PYTHON"]);
const RELATIONSHIPS=new Set(["PRODUCTION","DEVELOPMENT","TRANSITIVE"]);
const EVIDENCE_STATUS=new Set(["INFO","PASS","WARN","FAIL","UNVERIFIED"]);
const SEVERITIES=new Set(["BLOCKER","WARN","INFO"]);
const VERIFY_KINDS=new Set(["INSPECT","TEST","QUERY"]);
const MAX_INPUT_BYTES=8*1024*1024;

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {unknown} value @param {number} [max] */
function text(value,max=2048){if(typeof value!=="string")return null;const v=value.trim();return v&&v.length<=max&&!/[\u0000\r\n]/.test(v)?v:null;}
/** @param {unknown} value */
function id(value){const v=text(value,192);return v&&ID.test(v)?v:null;}
/** @param {unknown} value */
function safePath(value){const v=text(value,512);if(!v||path.isAbsolute(v)||v.includes("\\"))return null;const n=path.posix.normalize(v);return n!=="."&&n!==".."&&!n.startsWith("../")&&n===v?v:null;}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${key}"`});}
/** @param {unknown} value @param {(v:unknown)=>string|null} validate @param {number} max @param {boolean} [allowEmpty] */
function list(value,validate,max,allowEmpty=false){if(!Array.isArray(value)||value.length>max||(!allowEmpty&&value.length===0))return null;const out=value.map(validate);if(out.some((v)=>v===null)||new Set(out).size!==out.length)return null;return /** @type {string[]} */(out).sort();}
/** @param {string} value */
function exactSemver(value){const match=/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);return match?{major:Number(match[1]),minor:Number(match[2]),patch:Number(match[3])}:null;}
/** @param {string} fromVersion @param {string} toVersion */
export function classifyDependencyVersionChange(fromVersion,toVersion){const from=exactSemver(fromVersion),to=exactSemver(toVersion);if(!from||!to)return"NON_SEMVER";if(to.major<from.major||to.major===from.major&&to.minor<from.minor||to.major===from.major&&to.minor===from.minor&&to.patch<from.patch)return"DOWNGRADE";if(to.major>from.major)return"MAJOR";if(to.minor>from.minor)return"MINOR";if(to.patch>from.patch)return"PATCH";return"SAME";}

/** @param {unknown} value */
export function validateAgentDependencyMaintenanceInput(value){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,input:null,errors:[{id:"input-invalid",detail:"dependency maintenance input must be an object"}]};
  unknown(value,["version","taskId","repository","generator","changes","changedPaths","evidence","unknowns"],"input",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"dependency maintenance input version must be exactly 1"});
  const taskId=id(value.taskId);if(!taskId)errors.push({id:"task-id-invalid",detail:"taskId must be portable"});
  let repository=null;
  if(!object(value.repository))errors.push({id:"repository-invalid",detail:"repository must be an object"});
  else{unknown(value.repository,["id","commit"],"repository",errors);const repositoryId=id(value.repository.id),commit=text(value.repository.commit,128)?.toLowerCase()??null;if(!repositoryId||!commit||!isFullObjectId(commit))errors.push({id:"repository-fields-invalid",detail:"repository binding is invalid"});else repository={id:repositoryId,commit};}
  let generator=null;
  if(!object(value.generator))errors.push({id:"generator-invalid",detail:"generator must be an object"});
  else{unknown(value.generator,["id","type","authenticated"],"generator",errors);const generatorId=id(value.generator.id),type=text(value.generator.type,32),authenticated=value.generator.authenticated;if(!generatorId||!type||!GENERATORS.has(type)||typeof authenticated!=="boolean")errors.push({id:"generator-fields-invalid",detail:"generator id, type, or authentication metadata is invalid"});else generator={id:generatorId,type,authenticated};}
  const changedPaths=list(value.changedPaths,safePath,256);if(!changedPaths)errors.push({id:"changed-paths-invalid",detail:"changedPaths must be a non-empty unique bounded path list"});
  /** @type {Array<any>} */const changes=[];const changeIds=new Set();
  if(!Array.isArray(value.changes)||value.changes.length===0||value.changes.length>128)errors.push({id:"changes-invalid",detail:"changes must be a non-empty bounded array"});
  else for(const [index,raw]of value.changes.entries()){
    if(!object(raw)){errors.push({id:"change-invalid",detail:`changes[${index}] must be an object`});continue;}
    unknown(raw,["id","ecosystem","package","fromVersion","toVersion","relationship","manifestPath","lockfilePath"],"change",errors);
    const changeId=id(raw.id),ecosystem=text(raw.ecosystem,32),packageName=text(raw.package,256),fromVersion=text(raw.fromVersion,128),toVersion=text(raw.toVersion,128),relationship=text(raw.relationship,32),manifestPath=safePath(raw.manifestPath),lockfilePath=raw.lockfilePath===undefined?null:safePath(raw.lockfilePath);
    const updateClass=fromVersion&&toVersion?classifyDependencyVersionChange(fromVersion,toVersion):null;
    const pathsBound=changedPaths&&manifestPath&&changedPaths.includes(manifestPath)&&(lockfilePath===null||changedPaths.includes(lockfilePath));
    if(!changeId||changeIds.has(changeId)||!ecosystem||!ECOSYSTEMS.has(ecosystem)||!packageName||!fromVersion||!toVersion||fromVersion===toVersion||!relationship||!RELATIONSHIPS.has(relationship)||!manifestPath||(raw.lockfilePath!==undefined&&!lockfilePath)||!pathsBound||updateClass==="SAME"){errors.push({id:"change-fields-invalid",detail:`changes[${index}] has invalid, duplicate, unchanged, or unbound fields`});continue;}
    changeIds.add(changeId);changes.push({id:changeId,ecosystem,package:packageName,fromVersion,toVersion,updateClass,relationship,manifestPath,...(lockfilePath?{lockfilePath}:{})});
  }

  /** @type {Array<any>} */const evidence=[];const evidenceIds=new Set(),coveredChanges=new Set();
  if(!Array.isArray(value.evidence)||value.evidence.length===0||value.evidence.length>256)errors.push({id:"evidence-invalid",detail:"evidence must be a non-empty bounded array"});
  else for(const [index,raw]of value.evidence.entries()){
    if(!object(raw)){errors.push({id:"evidence-entry-invalid",detail:`evidence[${index}] must be an object`});continue;}
    unknown(raw,["id","source","status","summary","changeIds","path"],"evidence-entry",errors);
    const evidenceId=id(raw.id),source=id(raw.source),status=text(raw.status,32),summary=text(raw.summary,2048),boundChanges=list(raw.changeIds,id,128),evidencePath=raw.path===undefined?null:safePath(raw.path);
    const changesValid=boundChanges?.every((changeId)=>changeIds.has(changeId))??false;
    if(!evidenceId||evidenceIds.has(evidenceId)||!source||!status||!EVIDENCE_STATUS.has(status)||!summary||!boundChanges||!changesValid||(raw.path!==undefined&&!evidencePath)){errors.push({id:"evidence-fields-invalid",detail:`evidence[${index}] has invalid, duplicate, or unbound fields`});continue;}
    evidenceIds.add(evidenceId);for(const changeId of boundChanges)coveredChanges.add(changeId);evidence.push({id:evidenceId,source,status,summary,changeIds:boundChanges,...(evidencePath?{path:evidencePath}:{})});
  }
  for(const change of changes)if(!coveredChanges.has(change.id))errors.push({id:"change-evidence-missing",detail:`dependency change ${change.id} lacks explicit evidence coverage`});
  const inputUnknowns=[];
  if(!Array.isArray(value.unknowns)||value.unknowns.length>64)errors.push({id:"unknowns-invalid",detail:"unknowns must be a bounded array"});else for(const raw of value.unknowns){const item=text(raw,1024);if(!item)errors.push({id:"unknown-invalid",detail:"unknowns contains invalid text"});else inputUnknowns.push(item);}
  if(errors.length>0||!taskId||!repository||!generator||!changedPaths)return{valid:false,input:null,errors};
  const summary={patch:changes.filter((/** @type {any} */ item)=>item.updateClass==="PATCH").length,minor:changes.filter((/** @type {any} */ item)=>item.updateClass==="MINOR").length,major:changes.filter((/** @type {any} */ item)=>item.updateClass==="MAJOR").length,downgrade:changes.filter((/** @type {any} */ item)=>item.updateClass==="DOWNGRADE").length,nonSemver:changes.filter((/** @type {any} */ item)=>item.updateClass==="NON_SEMVER").length};
  return{valid:true,input:{version:1,taskId,repository,generator,changes:changes.sort((a,b)=>a.id.localeCompare(b.id)),changedPaths,evidence:evidence.sort((a,b)=>a.id.localeCompare(b.id)),unknowns:inputUnknowns,summary},errors:[]};
}

/** @param {unknown} value @param {any} input */
export function validateAgentDependencyMaintenanceResult(value,input){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,result:null,errors:[{id:"result-invalid",detail:"dependency maintenance result must be an object"}]};
  unknown(value,["version","taskId","updates","unknowns"],"result",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"dependency maintenance result version must be exactly 1"});
  if(value.taskId!==input.taskId)errors.push({id:"task-binding-invalid",detail:"result taskId must equal dependency maintenance task"});
  const changeById=new Map(input.changes.map((/** @type {any} */ item)=>[item.id,item])),evidenceById=new Map(input.evidence.map((/** @type {any} */ item)=>[item.id,item]));
  /** @type {Array<any>} */const updates=[];const updateIds=new Set();
  if(!Array.isArray(value.updates)||value.updates.length===0||value.updates.length>input.changes.length)errors.push({id:"updates-invalid",detail:"updates must cover the bounded dependency change set"});
  else for(const [index,raw]of value.updates.entries()){
    if(!object(raw)){errors.push({id:"update-invalid",detail:`updates[${index}] must be an object`});continue;}
    unknown(raw,["changeId","evidenceIds","concerns","verification"],"update",errors);const changeId=id(raw.changeId),change=changeId?changeById.get(changeId):null,boundEvidenceIds=list(raw.evidenceIds,id,64);
    const evidenceValid=change&&boundEvidenceIds&&boundEvidenceIds.every((evidenceId)=>{const evidence=evidenceById.get(evidenceId);return evidence&&evidence.changeIds.includes(changeId);});
    /** @type {Array<any>} */const concerns=[];const concernIds=new Set();
    if(!Array.isArray(raw.concerns)||raw.concerns.length>16)errors.push({id:"concerns-invalid",detail:`updates[${index}].concerns must be bounded`});
    else for(const [concernIndex,concernRaw]of raw.concerns.entries()){
      if(!object(concernRaw)){errors.push({id:"concern-invalid",detail:`updates[${index}].concerns[${concernIndex}] must be an object`});continue;}
      unknown(concernRaw,["id","severity","statement","evidenceIds"],"concern",errors);const concernId=id(concernRaw.id),severity=text(concernRaw.severity,32),statement=text(concernRaw.statement,2048),concernEvidenceIds=list(concernRaw.evidenceIds,id,64);
      const concernEvidenceValid=change&&concernEvidenceIds&&concernEvidenceIds.every((evidenceId)=>{const evidence=evidenceById.get(evidenceId);return evidence&&evidence.changeIds.includes(changeId);});
      if(!concernId||concernIds.has(concernId)||!severity||!SEVERITIES.has(severity)||!statement||!concernEvidenceIds||!concernEvidenceValid){errors.push({id:"concern-fields-invalid",detail:`updates[${index}].concerns[${concernIndex}] has invalid or unbound fields`});continue;}
      concernIds.add(concernId);concerns.push({id:concernId,severity,statement,evidenceIds:concernEvidenceIds});
    }
    /** @type {Array<any>} */const verification=[];
    if(!Array.isArray(raw.verification)||raw.verification.length===0||raw.verification.length>16)errors.push({id:"verification-invalid",detail:`updates[${index}].verification must be non-empty and bounded`});
    else for(const [stepIndex,step]of raw.verification.entries()){
      if(!object(step)){errors.push({id:"verification-entry-invalid",detail:`updates[${index}].verification[${stepIndex}] must be an object`});continue;}
      unknown(step,["kind","instruction"],"verification-entry",errors);const kind=text(step.kind,32),instruction=text(step.instruction,2048);if(!kind||!VERIFY_KINDS.has(kind)||!instruction)errors.push({id:"verification-fields-invalid",detail:`updates[${index}].verification[${stepIndex}] is invalid`});else verification.push({kind,instruction});
    }
    if(!changeId||updateIds.has(changeId)||!change||!boundEvidenceIds||!evidenceValid){errors.push({id:"update-fields-invalid",detail:`updates[${index}] does not bind exactly to one declared dependency change and its evidence`});continue;}
    updateIds.add(changeId);updates.push({changeId,change,evidenceIds:boundEvidenceIds,concerns:concerns.sort((a,b)=>a.id.localeCompare(b.id)),verification});
  }
  for(const change of input.changes)if(!updateIds.has(change.id))errors.push({id:"change-analysis-missing",detail:`dependency change ${change.id} is missing from maintenance analysis`});
  const resultUnknowns=[];if(!Array.isArray(value.unknowns)||value.unknowns.length>64)errors.push({id:"unknowns-invalid",detail:"result unknowns must be bounded"});else for(const raw of value.unknowns){const item=text(raw,1024);if(!item)errors.push({id:"unknown-invalid",detail:"result unknown is invalid"});else resultUnknowns.push(item);}
  if(errors.length>0)return{valid:false,result:null,errors};
  const concernCount=updates.reduce((/** @type {number} */ count,/** @type {any} */ update)=>count+update.concerns.length,0);
  return{valid:true,result:{version:1,taskId:input.taskId,status:concernCount>0?"MAINTENANCE_NOTES_REPORTED":"MAINTENANCE_VERIFICATION_ONLY",repository:input.repository,generator:{id:input.generator.id,type:input.generator.type,authenticated:input.generator.authenticated},deterministicSummary:input.summary,updates:updates.sort((a,b)=>a.changeId.localeCompare(b.changeId)),unknowns:resultUnknowns,packageMutationPerformed:false,sourceMutationAuthorized:false,executionAuthorized:false,mergeAuthorized:false,deployAuthorized:false,productionMutationAuthorized:false,approvalEstablished:false,semantics:"read-only analysis of an explicitly supplied deterministic dependency-update proposal; version-change class is toolkit-derived and model output does not execute or approve updates"},errors:[]};
}

/** @param {any} task @param {any} input */
function buildPrompt(task,input){
  const payload={task:{id:task.id,objective:task.objective,repository:task.repository,risk:task.risk,requiredChecks:task.scope.requiredChecks},generator:input.generator,changes:input.changes,changedPaths:input.changedPaths,evidence:input.evidence,unknowns:input.unknowns,deterministicSummary:input.summary};
  const system=[
    "You are a read-only dependency-maintenance analyst reviewing a deterministic updater proposal.",
    "Do not edit package manifests, lockfiles, source files, CI, policies, or tests. Do not run package managers, commands, networks, merges, or deployments.",
    "Use only supplied changes and evidence. Do not rely on unstated package knowledge, changelogs, release notes, vulnerabilities, or compatibility claims.",
    "The toolkit already derives PATCH/MINOR/MAJOR/DOWNGRADE/NON_SEMVER from exact versions. Do not override or replace that classification.",
    "Analyze every declared change exactly once. Every update and concern must cite evidence ids already bound to that change.",
    "Verification proposals may use only INSPECT, TEST, or QUERY and are not executed here.",
    "Do not approve, merge, deploy, or claim an update is safe merely because no concern was found.",
    "Return JSON only: {version:1,taskId:string,updates:[{changeId,evidenceIds,concerns:[{id,severity:'BLOCKER'|'WARN'|'INFO',statement,evidenceIds}],verification:[{kind:'INSPECT'|'TEST'|'QUERY',instruction}]}],unknowns:string[]}"
  ].join(" ");
  return{system,user:JSON.stringify(payload)};
}

/** @param {any} task @param {any} rolePolicy @param {any} input @param {any} modelConfig @param {string} backend @param {string} model @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function runAgentDependencyMaintenance(task,rolePolicy,input,modelConfig,backend,model,deps={}){
  if(task.role!=="dependency")throw new Error("Dependency Maintenance Agent v1 requires task role dependency");
  if(task.authority.filesystem!=="READ_ONLY"||task.authority.shell!=="NONE"||task.authority.network!=="NONE")throw new Error("Dependency Maintenance Agent v1 requires READ_ONLY filesystem with shell NONE and network NONE");
  if(task.id!==input.taskId||task.repository.id!==input.repository.id||task.repository.baseCommit!==input.repository.commit)throw new Error("dependency maintenance input is not bound to exact Agent Task repository identity");
  const roleAudit=inspectAgentTaskRolePolicy(task,rolePolicy);if(roleAudit.overallStatus!=="PASS"||roleAudit.leaseRequired)throw new Error("dependency maintenance task is not authorized by read-only Agent Role Policy v1");
  const prompt=buildPrompt(task,input),request=validateAgentModelRequest({version:1,backend,model,messages:[{role:"system",content:prompt.system},{role:"user",content:prompt.user}],temperature:0,maxOutputTokens:6144,timeoutMs:60000});if(!request.valid||!request.request)throw new Error("dependency maintenance model request is invalid");
  const response=await(deps.invoke??invokeAgentLocalModel)(modelConfig,request.request);let raw;try{raw=JSON.parse(response.content);}catch{throw new Error("dependency maintenance model returned non-JSON output");}
  const validated=validateAgentDependencyMaintenanceResult(raw,input);if(!validated.valid||!validated.result)throw new Error("dependency maintenance model output failed Maintenance Result v1 validation");
  return{...validated.result,model:{backend:response.backend,model:response.model},rolePolicyStatus:roleAudit.overallStatus};
}

/** @param {string} filename */
function readJson(filename){const resolved=path.resolve(filename);let stat;try{stat=fs.lstatSync(resolved);}catch{throw new Error("dependency maintenance input file is unavailable");}if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||stat.size>MAX_INPUT_BYTES)throw new Error("dependency maintenance input must be a bounded regular non-symlink file");try{return JSON.parse(fs.readFileSync(resolved,"utf8"));}catch{throw new Error("dependency maintenance input cannot be parsed");}}
/** @param {string[]} argv */
function parse(argv){const values=new Map(),flags=new Set(),allowed=new Set(["--task","--role-policy","--input","--model-config","--backend","--model"]);for(let i=0;i<argv.length;i+=1){const arg=argv[i];if(arg==="--json"){if(flags.has(arg))return null;flags.add(arg);continue;}if(!allowed.has(arg??"")||values.has(arg))return null;const next=argv[i+1];if(typeof next!=="string"||next.startsWith("--"))return null;values.set(arg,next);i+=1;}for(const key of allowed)if(!values.has(key))return null;return{values,json:flags.has("--json")};}
/** @param {string[]} argv @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function main(argv=process.argv.slice(2),deps={}){const options=parse(argv);if(!options){console.error("Usage: node scripts/agent-dependency-maintenance.js --task <task.json> --role-policy <roles.json> --input <dependency-maintenance-input.json> --model-config <models.json> --backend <id> --model <id> [--json]");return 1;}try{const taskResult=validateAgentTask(readJson(options.values.get("--task"))),roleResult=validateAgentRolePolicy(readJson(options.values.get("--role-policy"))),inputResult=validateAgentDependencyMaintenanceInput(readJson(options.values.get("--input")));if(!taskResult.valid||!taskResult.task||!roleResult.valid||!roleResult.policy||!inputResult.valid||!inputResult.input)throw new Error("dependency maintenance task, role policy, or input is invalid");const modelConfig=readAgentModelConfigFile(options.values.get("--model-config"));const result=await runAgentDependencyMaintenance(taskResult.task,roleResult.policy,inputResult.input,modelConfig,options.values.get("--backend"),options.values.get("--model"),deps);console.log(options.json?JSON.stringify(result):JSON.stringify(result,null,2));return 0;}catch(error){console.error(error instanceof Error?error.message:"dependency maintenance agent failed");return 1;}}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=await main();
