#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateAgentTask } from "./agent-task.js";
import { validateAgentRolePolicy, inspectAgentTaskRolePolicy } from "./agent-role-policy.js";
import { readAgentModelConfigFile, validateAgentModelRequest, invokeAgentLocalModel } from "./agent-local-model.js";
import { validateContractInventory, validContractId, validRepositoryId } from "./contract-inventory.js";
import { validateCrossContractPolicy, inspectCrossRepositoryContracts } from "./audit-cross-repository-contracts.js";
import { isFullObjectId } from "./runtime-evidence.js";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const EVIDENCE_STATUS=new Set(["INFO","PASS","WARN","FAIL","UNVERIFIED"]);
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

/** @param {unknown} value */
export function validateAgentContractImpactInput(value){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,input:null,errors:[{id:"input-invalid",detail:"contract impact input must be an object"}]};
  unknown(value,["version","taskId","repositories","crossContractPolicy","inventories","evidence","relationships","unknowns"],"input",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"contract impact input version must be exactly 1"});
  const taskId=id(value.taskId);if(!taskId)errors.push({id:"task-id-invalid",detail:"taskId must be portable"});
  /** @type {Array<{id:string,commit:string}>} */const repositories=[];const repositoryIds=new Set();
  if(!Array.isArray(value.repositories)||value.repositories.length<2||value.repositories.length>64)errors.push({id:"repositories-invalid",detail:"repositories must contain at least two bounded entries"});
  else for(const [index,raw]of value.repositories.entries()){
    if(!object(raw)){errors.push({id:"repository-invalid",detail:`repositories[${index}] must be an object`});continue;}
    unknown(raw,["id","commit"],"repository",errors);const repositoryId=text(raw.id,128),commit=text(raw.commit,128)?.toLowerCase()??null;
    if(!repositoryId||!validRepositoryId(repositoryId)||repositoryIds.has(repositoryId)||!commit||!isFullObjectId(commit)){errors.push({id:"repository-fields-invalid",detail:`repositories[${index}] has invalid or duplicate identity`});continue;}
    repositoryIds.add(repositoryId);repositories.push({id:repositoryId,commit});
  }
  const crossResult=validateCrossContractPolicy(value.crossContractPolicy);if(!crossResult.ok||!crossResult.policy)errors.push({id:"cross-contract-policy-invalid",detail:"crossContractPolicy must validate as Cross Repository Contract Policy v1"});
  /** @type {Array<any>} */const inventories=[];const inventoryIds=new Set();
  if(!Array.isArray(value.inventories)||value.inventories.length===0||value.inventories.length>64)errors.push({id:"inventories-invalid",detail:"inventories must be a non-empty bounded array"});
  else for(const [index,raw]of value.inventories.entries()){const result=validateContractInventory(raw);if(!result.ok||!result.inventory){errors.push({id:"inventory-invalid",detail:`inventories[${index}] is invalid`});continue;}if(inventoryIds.has(result.inventory.repository)){errors.push({id:"inventory-duplicate",detail:`inventory repository ${result.inventory.repository} is duplicated`});continue;}inventoryIds.add(result.inventory.repository);inventories.push(result.inventory);}
  /** @type {Array<any>} */const evidence=[];const evidenceIds=new Set();
  if(!Array.isArray(value.evidence)||value.evidence.length===0||value.evidence.length>256)errors.push({id:"evidence-invalid",detail:"evidence must be a non-empty bounded array"});
  else for(const [index,raw]of value.evidence.entries()){
    if(!object(raw)){errors.push({id:"evidence-entry-invalid",detail:`evidence[${index}] must be an object`});continue;}
    unknown(raw,["id","source","status","summary","repository","path"],"evidence-entry",errors);
    const evidenceId=id(raw.id),source=id(raw.source),status=text(raw.status,32),summary=text(raw.summary,2048),repository=text(raw.repository,128),evidencePath=raw.path===undefined?null:safePath(raw.path);
    if(!evidenceId||evidenceIds.has(evidenceId)||!source||!status||!EVIDENCE_STATUS.has(status)||!summary||!repository||!repositoryIds.has(repository)||(raw.path!==undefined&&!evidencePath)){errors.push({id:"evidence-fields-invalid",detail:`evidence[${index}] has invalid or duplicate fields`});continue;}
    evidenceIds.add(evidenceId);evidence.push({id:evidenceId,source,status,summary,repository,...(evidencePath?{path:evidencePath}:{})});
  }

  /** @type {Array<any>} */const relationships=[];const relationshipIds=new Set();
  if(!Array.isArray(value.relationships)||value.relationships.length===0||value.relationships.length>256)errors.push({id:"relationships-invalid",detail:"relationships must be a non-empty bounded array"});
  else for(const [index,raw]of value.relationships.entries()){
    if(!object(raw)){errors.push({id:"relationship-invalid",detail:`relationships[${index}] must be an object`});continue;}
    unknown(raw,["id","contractId","providerRepository","consumerRepository","providerPaths","consumerPaths","evidenceIds"],"relationship",errors);
    const relationshipId=id(raw.id),contractId=text(raw.contractId,192),providerRepository=text(raw.providerRepository,128),consumerRepository=text(raw.consumerRepository,128),providerPaths=list(raw.providerPaths,safePath,64),consumerPaths=list(raw.consumerPaths,safePath,64),relationshipEvidenceIds=list(raw.evidenceIds,id,64);
    const requirement=crossResult.ok&&crossResult.policy&&contractId?crossResult.policy.requirements.find((/** @type {any} */ item)=>item.contractId===contractId):null;
    const evidenceValid=relationshipEvidenceIds?.every((evidenceId)=>evidenceIds.has(evidenceId))??false;
    if(!relationshipId||relationshipIds.has(relationshipId)||!contractId||!validContractId(contractId)||!providerRepository||!consumerRepository||providerRepository===consumerRepository||!repositoryIds.has(providerRepository)||!repositoryIds.has(consumerRepository)||!providerPaths||!consumerPaths||!relationshipEvidenceIds||!evidenceValid||!requirement||!requirement.repositories.includes(providerRepository)||!requirement.repositories.includes(consumerRepository)){errors.push({id:"relationship-fields-invalid",detail:`relationships[${index}] has invalid, unbound, or non-policy fields`});continue;}
    relationshipIds.add(relationshipId);relationships.push({id:relationshipId,contractId,providerRepository,consumerRepository,providerPaths,consumerPaths,evidenceIds:relationshipEvidenceIds});
  }
  const inputUnknowns=[];
  if(!Array.isArray(value.unknowns)||value.unknowns.length>64)errors.push({id:"unknowns-invalid",detail:"unknowns must be a bounded array"});
  else for(const raw of value.unknowns){const item=text(raw,1024);if(!item)errors.push({id:"unknown-invalid",detail:"unknowns contains invalid text"});else inputUnknowns.push(item);}

  if(crossResult.ok&&crossResult.policy){
    for(const requirement of crossResult.policy.requirements){
      for(const repository of requirement.repositories){if(!repositoryIds.has(repository))errors.push({id:"policy-repository-missing",detail:`cross-contract policy repository ${repository} is missing from repository bindings`});if(!inventoryIds.has(repository))errors.push({id:"policy-inventory-missing",detail:`cross-contract policy repository ${repository} is missing a contract inventory`});}
      const contractRelationships=relationships.filter((relationship)=>relationship.contractId===requirement.contractId),covered=new Set(contractRelationships.flatMap((relationship)=>[relationship.providerRepository,relationship.consumerRepository]));
      for(const repository of requirement.repositories)if(!covered.has(repository))errors.push({id:"relationship-coverage-missing",detail:`contract ${requirement.contractId} lacks explicit relationship coverage for repository ${repository}`});
    }
  }
  for(const inventory of inventories)if(!repositoryIds.has(inventory.repository))errors.push({id:"inventory-repository-unbound",detail:`inventory ${inventory.repository} has no exact repository commit binding`});

  if(errors.length>0||!taskId||!crossResult.ok||!crossResult.policy)return{valid:false,input:null,errors};
  const audit=inspectCrossRepositoryContracts(crossResult.policy,inventories);
  const auditFindings=audit.checks.map((check)=>({id:`audit:${check.contractId}:${check.id}`,contractId:check.contractId,status:check.status,checkId:check.id,repositories:[...check.repositories].sort(),detail:check.detail}));
  return{valid:true,input:{version:1,taskId,repositories:repositories.sort((a,b)=>a.id.localeCompare(b.id)),crossContractPolicy:crossResult.policy,inventories:inventories.sort((a,b)=>a.repository.localeCompare(b.repository)),evidence:evidence.sort((a,b)=>a.id.localeCompare(b.id)),relationships:relationships.sort((a,b)=>a.id.localeCompare(b.id)),unknowns:inputUnknowns,audit:{overallStatus:audit.overallStatus,summary:audit.summary,findings:auditFindings}},errors:[]};
}

/** @param {string} contractId @param {any} input */
function deterministicImpactKind(contractId,input){
  const failing=input.audit.findings.filter((/** @type {any} */ finding)=>finding.contractId===contractId&&finding.status==="FAIL");
  if(failing.some((/** @type {any} */ finding)=>finding.checkId==="contract-missing"))return"CONTRACT_MISSING";
  if(failing.some((/** @type {any} */ finding)=>finding.checkId==="contract-version-mismatch"))return"VERSION_MISMATCH";
  if(failing.some((/** @type {any} */ finding)=>finding.checkId==="contract-version-drift"))return"VERSION_DRIFT";
  return"COMPATIBILITY_REVIEW";
}

/** @param {string} repository @param {string} file @param {any[]} relationships */
function pathDeclaredByRelationships(repository,file,relationships){
  return relationships.some((relationship)=>relationship.providerRepository===repository&&relationship.providerPaths.includes(file)||relationship.consumerRepository===repository&&relationship.consumerPaths.includes(file));
}

/** @param {unknown} value @param {any} input */
export function validateAgentContractImpactResult(value,input){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,result:null,errors:[{id:"result-invalid",detail:"contract impact result must be an object"}]};
  unknown(value,["version","taskId","impacts","unknowns"],"result",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"contract impact result version must be exactly 1"});
  if(value.taskId!==input.taskId)errors.push({id:"task-binding-invalid",detail:"result taskId must equal contract impact task"});
  const evidenceIds=new Set(input.evidence.map((/** @type {any} */ item)=>item.id)),relationshipById=new Map(input.relationships.map((/** @type {any} */ item)=>[item.id,item])),auditById=new Map(input.audit.findings.map((/** @type {any} */ item)=>[item.id,item]));
  /** @type {Array<any>} */const impacts=[];const impactIds=new Set();
  if(!Array.isArray(value.impacts)||value.impacts.length>64)errors.push({id:"impacts-invalid",detail:"impacts must be a bounded array"});
  else for(const [index,raw]of value.impacts.entries()){
    if(!object(raw)){errors.push({id:"impact-invalid",detail:`impacts[${index}] must be an object`});continue;}
    unknown(raw,["id","contractId","relationshipIds","auditIds","evidenceIds","affected","verification"],"impact",errors);
    const impactId=id(raw.id),contractId=text(raw.contractId,192),relationshipIds=list(raw.relationshipIds,id,64),auditIds=list(raw.auditIds,id,64),impactEvidenceIds=list(raw.evidenceIds,id,64);
    const relationships=relationshipIds?relationshipIds.map((relationshipId)=>relationshipById.get(relationshipId)).filter(Boolean):[];
    const relationshipValid=relationshipIds&&relationships.length===relationshipIds.length&&relationships.every((relationship)=>relationship.contractId===contractId);
    const auditValid=auditIds&&auditIds.every((auditId)=>{const finding=auditById.get(auditId);return finding&&finding.contractId===contractId;});
    const relationshipEvidenceIds=new Set(relationships.flatMap((relationship)=>relationship.evidenceIds));
    const evidenceValid=impactEvidenceIds&&impactEvidenceIds.every((evidenceId)=>evidenceIds.has(evidenceId))&&impactEvidenceIds.some((evidenceId)=>relationshipEvidenceIds.has(evidenceId));
    /** @type {Array<any>} */const affected=[];const affectedKeys=new Set();
    if(!Array.isArray(raw.affected)||raw.affected.length===0||raw.affected.length>64)errors.push({id:"affected-invalid",detail:`impacts[${index}].affected must be non-empty and bounded`});
    else for(const [affectedIndex,entry]of raw.affected.entries()){
      if(!object(entry)){errors.push({id:"affected-entry-invalid",detail:`impacts[${index}].affected[${affectedIndex}] must be an object`});continue;}
      unknown(entry,["repository","paths"],"affected-entry",errors);const repository=text(entry.repository,128),paths=list(entry.paths,safePath,64);
      const key=repository??"";
      if(!repository||affectedKeys.has(key)||!paths||paths.some((file)=>!pathDeclaredByRelationships(repository,file,relationships))){errors.push({id:"affected-fields-invalid",detail:`impacts[${index}].affected[${affectedIndex}] is not bound to referenced relationship paths`});continue;}
      affectedKeys.add(key);affected.push({repository,paths});
    }
    /** @type {Array<any>} */const verification=[];
    if(!Array.isArray(raw.verification)||raw.verification.length===0||raw.verification.length>16)errors.push({id:"verification-invalid",detail:`impacts[${index}].verification must be non-empty and bounded`});
    else for(const [stepIndex,step]of raw.verification.entries()){
      if(!object(step)){errors.push({id:"verification-entry-invalid",detail:`impacts[${index}].verification[${stepIndex}] must be an object`});continue;}
      unknown(step,["kind","repository","instruction"],"verification-entry",errors);const kind=text(step.kind,32),repository=text(step.repository,128),instruction=text(step.instruction,2048);
      if(!kind||!VERIFY_KINDS.has(kind)||!repository||!affectedKeys.has(repository)||!instruction)errors.push({id:"verification-fields-invalid",detail:`impacts[${index}].verification[${stepIndex}] is invalid or not affected-repository bound`});else verification.push({kind,repository,instruction});
    }
    if(!impactId||impactIds.has(impactId)||!contractId||!validContractId(contractId)||!relationshipIds||!auditIds||!impactEvidenceIds||!relationshipValid||!auditValid||!evidenceValid||affected.length===0){errors.push({id:"impact-fields-invalid",detail:`impacts[${index}] has invalid or unbound contract, relationship, audit, or evidence fields`});continue;}
    impactIds.add(impactId);const requirement=input.crossContractPolicy.requirements.find((/** @type {any} */ item)=>item.contractId===contractId);impacts.push({id:impactId,contractId,kind:deterministicImpactKind(contractId,input),expectedVersion:requirement?.expectedVersion??null,relationshipIds,auditIds,evidenceIds:impactEvidenceIds,affected:affected.sort((a,b)=>a.repository.localeCompare(b.repository)),verification});
  }
  const resultUnknowns=[];
  if(!Array.isArray(value.unknowns)||value.unknowns.length>64)errors.push({id:"unknowns-invalid",detail:"result unknowns must be a bounded array"});
  else for(const raw of value.unknowns){const item=text(raw,1024);if(!item)errors.push({id:"unknown-invalid",detail:"result unknown is invalid"});else resultUnknowns.push(item);}
  for(const finding of input.audit.findings.filter((/** @type {any} */ item)=>item.status==="FAIL"))if(!impacts.some((/** @type {any} */ impact)=>impact.auditIds.includes(finding.id)))errors.push({id:"deterministic-failure-uncovered",detail:`deterministic cross-contract failure ${finding.id} is not covered by an impact`});
  if(errors.length>0)return{valid:false,result:null,errors};
  return{valid:true,result:{version:1,taskId:input.taskId,status:impacts.length>0?"IMPACTS_REPORTED":"NO_IMPACTS_REPORTED",deterministicAudit:{overallStatus:input.audit.overallStatus,summary:input.audit.summary,findings:input.audit.findings},impacts:impacts.sort((a,b)=>a.id.localeCompare(b.id)),unknowns:resultUnknowns,executionAuthorized:false,sourceMutationAuthorized:false,mergeAuthorized:false,deployAuthorized:false,productionMutationAuthorized:false,canonicalVersionSelectedByAgent:false,semantics:"read-only impact proposal over explicit contract inventories, policy, provider-consumer relationships, and evidence; deterministic cross-contract audit remains authoritative and the agent never selects a canonical version"},errors:[]};
}

/** @param {any} task @param {any} input */
function buildPrompt(task,input){
  const payload={task:{id:task.id,objective:task.objective,repository:task.repository,risk:task.risk},repositories:input.repositories,crossContractPolicy:input.crossContractPolicy,inventories:input.inventories,deterministicAudit:input.audit,evidence:input.evidence,relationships:input.relationships,unknowns:input.unknowns};
  const system=[
    "You are a read-only cross-repository contract impact analyst.",
    "Deterministic cross-contract audit findings are authoritative. Do not change, reinterpret, suppress, or replace them.",
    "Use only supplied repositories, inventories, relationships, paths, audit ids, and evidence ids. Do not infer private business rules or a canonical repository.",
    "When expectedVersion is null in policy, do not choose a target version. When expectedVersion is explicit, treat it only as caller-supplied policy truth.",
    "Every impact must cite relationshipIds, auditIds, and evidenceIds; every affected path must come from those relationships.",
    "Every deterministic FAIL audit id must be covered by at least one impact. Verification may use only INSPECT, TEST, or QUERY.",
    "Do not modify source, run commands, access networks, merge, deploy, migrate, or perform provider actions.",
    "Return JSON only: {version:1,taskId:string,impacts:[{id,contractId,relationshipIds,auditIds,evidenceIds,affected:[{repository,paths}],verification:[{kind:'INSPECT'|'TEST'|'QUERY',repository,instruction}]}],unknowns:string[]}"
  ].join(" ");
  return{system,user:JSON.stringify(payload)};
}
/** @param {any} task @param {any} rolePolicy @param {any} input @param {any} modelConfig @param {string} backend @param {string} model @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function runAgentContractImpact(task,rolePolicy,input,modelConfig,backend,model,deps={}){
  if(task.role!=="contract")throw new Error("Contract Impact Agent v1 requires task role contract");
  if(task.authority.filesystem!=="READ_ONLY"||task.authority.shell!=="NONE"||task.authority.network!=="NONE")throw new Error("Contract Impact Agent v1 requires READ_ONLY filesystem with shell NONE and network NONE");
  if(task.id!==input.taskId)throw new Error("contract impact input taskId does not match Agent Task");
  const taskRepository=input.repositories.find((/** @type {any} */ repository)=>repository.id===task.repository.id);
  if(!taskRepository||taskRepository.commit!==task.repository.baseCommit)throw new Error("Agent Task repository identity is not bound to contract impact repository set");
  const roleAudit=inspectAgentTaskRolePolicy(task,rolePolicy);if(roleAudit.overallStatus!=="PASS"||roleAudit.leaseRequired)throw new Error("contract impact task is not authorized by read-only Agent Role Policy v1");
  const prompt=buildPrompt(task,input),request=validateAgentModelRequest({version:1,backend,model,messages:[{role:"system",content:prompt.system},{role:"user",content:prompt.user}],temperature:0,maxOutputTokens:6144,timeoutMs:60000});
  if(!request.valid||!request.request)throw new Error("contract impact model request is invalid");
  const response=await(deps.invoke??invokeAgentLocalModel)(modelConfig,request.request);let raw;try{raw=JSON.parse(response.content);}catch{throw new Error("contract impact model returned non-JSON output");}
  const validated=validateAgentContractImpactResult(raw,input);if(!validated.valid||!validated.result)throw new Error("contract impact model output failed Contract Impact Result v1 validation");
  return{...validated.result,model:{backend:response.backend,model:response.model},rolePolicyStatus:roleAudit.overallStatus};
}

/** @param {string} filename */
function readJson(filename){const resolved=path.resolve(filename);let stat;try{stat=fs.lstatSync(resolved);}catch{throw new Error("contract impact input file is unavailable");}if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||stat.size>MAX_INPUT_BYTES)throw new Error("contract impact input must be a bounded regular non-symlink file");try{return JSON.parse(fs.readFileSync(resolved,"utf8"));}catch{throw new Error("contract impact input cannot be parsed");}}
/** @param {string[]} argv */
function parse(argv){const values=new Map(),flags=new Set(),allowed=new Set(["--task","--role-policy","--input","--model-config","--backend","--model"]);for(let i=0;i<argv.length;i+=1){const arg=argv[i];if(arg==="--json"){if(flags.has(arg))return null;flags.add(arg);continue;}if(!allowed.has(arg??"")||values.has(arg))return null;const next=argv[i+1];if(typeof next!=="string"||next.startsWith("--"))return null;values.set(arg,next);i+=1;}for(const key of allowed)if(!values.has(key))return null;return{values,json:flags.has("--json")};}
/** @param {string[]} argv @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function main(argv=process.argv.slice(2),deps={}){const options=parse(argv);if(!options){console.error("Usage: node scripts/agent-contract-impact.js --task <task.json> --role-policy <roles.json> --input <contract-impact-input.json> --model-config <models.json> --backend <id> --model <id> [--json]");return 1;}try{const taskResult=validateAgentTask(readJson(options.values.get("--task"))),roleResult=validateAgentRolePolicy(readJson(options.values.get("--role-policy"))),inputResult=validateAgentContractImpactInput(readJson(options.values.get("--input")));if(!taskResult.valid||!taskResult.task||!roleResult.valid||!roleResult.policy||!inputResult.valid||!inputResult.input)throw new Error("contract impact task, role policy, or input is invalid");const modelConfig=readAgentModelConfigFile(options.values.get("--model-config"));const result=await runAgentContractImpact(taskResult.task,roleResult.policy,inputResult.input,modelConfig,options.values.get("--backend"),options.values.get("--model"),deps);console.log(options.json?JSON.stringify(result):JSON.stringify(result,null,2));return 0;}catch(error){console.error(error instanceof Error?error.message:"contract impact agent failed");return 1;}}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=await main();
