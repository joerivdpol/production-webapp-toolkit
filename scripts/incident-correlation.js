#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { validateAgentIncidentInput, incidentEvidenceIds } from "./agent-incident-analysis.js";
import { validateAgentDependencyMaintenanceInput } from "./agent-dependency-maintenance.js";
import { validateAgentContractImpactInput } from "./agent-contract-impact.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const HASH=/^[a-f0-9]{64}$/;
const MAX_FILE_BYTES=8*1024*1024;

/** @param {unknown} v @returns {v is Record<string,unknown>} */
function object(v){return typeof v==="object"&&v!==null&&!Array.isArray(v)&&(Object.getPrototypeOf(v)===Object.prototype||Object.getPrototypeOf(v)===null);}
/** @param {unknown} v @param {number} [max] */
function text(v,max=512){if(typeof v!=="string")return null;const s=v.trim();return s.length>0&&s.length<=max&&!/[\u0000\r\n]/.test(s)?s:null;}
/** @param {unknown} v */
function id(v){const s=text(v,128);return s&&ID.test(s)?s:null;}
/** @param {unknown} v @param {number} min @param {number} max */
function integer(v,min,max){return Number.isSafeInteger(v)&&Number(v)>=min&&Number(v)<=max?Number(v):null;}
/** @param {Record<string,unknown>} v @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(v,allowed,scope,errors){for(const k of Object.keys(v))if(!allowed.includes(k))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${k}"`});}
/** @param {unknown} value */
export function validateIncidentCorrelationPolicy(value){
  if(!object(value))return{valid:false,policy:null,errors:[{id:"policy-invalid",detail:"correlation policy must be an object"}]};
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  unknown(value,["version","maxReleaseWindowSeconds","maxKnownFailureAgeSeconds"],"policy",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"policy version must be exactly 1"});
  const maxReleaseWindowSeconds=integer(value.maxReleaseWindowSeconds,1,7*24*3600);
  const maxKnownFailureAgeSeconds=integer(value.maxKnownFailureAgeSeconds,1,365*24*3600);
  if(maxReleaseWindowSeconds===null||maxKnownFailureAgeSeconds===null)errors.push({id:"policy-bounds-invalid",detail:"correlation windows are invalid"});
  if(errors.length||maxReleaseWindowSeconds===null||maxKnownFailureAgeSeconds===null)return{valid:false,policy:null,errors};
  return{valid:true,policy:{version:1,maxReleaseWindowSeconds,maxKnownFailureAgeSeconds},errors:[]};
}

/** @param {unknown} value */
export function validateIncidentCorrelationInput(value){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,input:null,errors:[{id:"input-invalid",detail:"correlation input must be an object"}]};
  unknown(value,["version","incident","dependencyInputs","contractInputs","incidentSignatures","knownFailures","policy"],"input",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"correlation input version must be exactly 1"});

  const incidentResult=validateAgentIncidentInput(value.incident);
  if(!incidentResult.valid||!incidentResult.input)errors.push({id:"incident-invalid",detail:"incident must satisfy Agent Incident Input v1"});
  const policyResult=validateIncidentCorrelationPolicy(value.policy);
  if(!policyResult.valid||!policyResult.policy)errors.push({id:"policy-invalid",detail:"correlation policy is invalid"});
  /** @type {any[]} */const dependencyInputs=[];
  const depTaskIds=new Set();
  if(!Array.isArray(value.dependencyInputs)||value.dependencyInputs.length>64)errors.push({id:"dependency-inputs-invalid",detail:"dependencyInputs must be bounded"});
  else for(const [index,raw] of value.dependencyInputs.entries()){
    const result=validateAgentDependencyMaintenanceInput(raw);
    if(!result.valid||!result.input||depTaskIds.has(result.input.taskId)){errors.push({id:"dependency-input-invalid",detail:`dependencyInputs[${index}] is invalid or duplicated`});continue;}
    depTaskIds.add(result.input.taskId);dependencyInputs.push(result.input);
  }

  /** @type {any[]} */const contractInputs=[];
  const contractTaskIds=new Set();
  if(!Array.isArray(value.contractInputs)||value.contractInputs.length>64)errors.push({id:"contract-inputs-invalid",detail:"contractInputs must be bounded"});
  else for(const [index,raw] of value.contractInputs.entries()){
    const result=validateAgentContractImpactInput(raw);
    if(!result.valid||!result.input||contractTaskIds.has(result.input.taskId)){errors.push({id:"contract-input-invalid",detail:`contractInputs[${index}] is invalid or duplicated`});continue;}
    contractTaskIds.add(result.input.taskId);contractInputs.push(result.input);
  }

  /** @type {Array<{errorId:string,signatureSha256:string}>} */const incidentSignatures=[];
  const signatureErrorIds=new Set();
  if(!Array.isArray(value.incidentSignatures)||value.incidentSignatures.length>128)errors.push({id:"incident-signatures-invalid",detail:"incidentSignatures must be bounded"});
  else for(const [index,raw] of value.incidentSignatures.entries()){
    if(!object(raw)){errors.push({id:"incident-signature-invalid",detail:`incidentSignatures[${index}] must be an object`});continue;}
    unknown(raw,["errorId","signatureSha256"],"incident-signature",errors);
    const errorId=id(raw.errorId),signatureSha256=text(raw.signatureSha256,64)?.toLowerCase()??null;
    const exists=incidentResult.valid&&incidentResult.input&&incidentResult.input.errors.some((/** @type {any} */ item)=>item.id===errorId);
    if(!errorId||signatureErrorIds.has(errorId)||!signatureSha256||!HASH.test(signatureSha256)||!exists){errors.push({id:"incident-signature-fields-invalid",detail:`incidentSignatures[${index}] is invalid, duplicate, or unbound`});continue;}
    signatureErrorIds.add(errorId);incidentSignatures.push({errorId,signatureSha256});
  }
  /** @type {any[]} */const knownFailures=[];
  const failureIds=new Set();
  if(!Array.isArray(value.knownFailures)||value.knownFailures.length>128)errors.push({id:"known-failures-invalid",detail:"knownFailures must be bounded"});
  else for(const [index,raw] of value.knownFailures.entries()){
    if(!object(raw)){errors.push({id:"known-failure-invalid",detail:`knownFailures[${index}] must be an object`});continue;}
    unknown(raw,["id","sourceRef","repository","lastObservedAt","signatureSha256","evidenceRefs"],"known-failure",errors);
    const failureId=id(raw.id),sourceRef=id(raw.sourceRef),lastObservedAt=text(raw.lastObservedAt,64);
    let repository=null;
    if(object(raw.repository)){
      unknown(raw.repository,["id"],"known-failure-repository",errors);
      const repositoryId=id(raw.repository.id);if(repositoryId)repository={id:repositoryId};
    }
    const signatures=Array.isArray(raw.signatureSha256)?raw.signatureSha256.map((item)=>text(item,64)?.toLowerCase()??null):null;
    const refs=Array.isArray(raw.evidenceRefs)?raw.evidenceRefs.map(id):null;
    const signaturesValid=signatures&&signatures.length>0&&signatures.length<=64&&signatures.every((item)=>item&&HASH.test(item))&&new Set(signatures).size===signatures.length;
    const refsValid=refs&&refs.length>0&&refs.length<=64&&refs.every(Boolean)&&new Set(refs).size===refs.length;
    if(!failureId||failureIds.has(failureId)||!sourceRef||!repository||!lastObservedAt||!isAbsoluteIsoTimestamp(lastObservedAt)||!signaturesValid||!refsValid){errors.push({id:"known-failure-fields-invalid",detail:`knownFailures[${index}] is invalid or duplicate`});continue;}
    failureIds.add(failureId);knownFailures.push({id:failureId,sourceRef,repository,lastObservedAt,signatureSha256:/** @type {string[]} */(signatures).sort(),evidenceRefs:/** @type {string[]} */(refs).sort()});
  }

  if(errors.length||!incidentResult.valid||!incidentResult.input||!policyResult.valid||!policyResult.policy)return{valid:false,input:null,errors};
  return{valid:true,input:{version:1,incident:incidentResult.input,dependencyInputs:dependencyInputs.sort((a,b)=>a.taskId.localeCompare(b.taskId)),contractInputs:contractInputs.sort((a,b)=>a.taskId.localeCompare(b.taskId)),incidentSignatures:incidentSignatures.sort((a,b)=>a.errorId.localeCompare(b.errorId)),knownFailures:knownFailures.sort((a,b)=>a.id.localeCompare(b.id)),policy:policyResult.policy},errors:[]};
}
/** @param {any} input */
export function correlateIncidentEvidence(input){
  const incident=input.incident,policy=input.policy;
  /** @type {Array<any>} */const correlations=[];
  const evidenceIds=incidentEvidenceIds(incident);
  const observed=[...incident.errors.map((/** @type {any} */ e)=>e.observedAt),...incident.metrics.map((/** @type {any} */ m)=>m.observedAt)].sort();
  const firstObserved=observed[0]??incident.runtimeHealthEvidence.evidence.collectedAt;
  const releaseAgeSeconds=Math.floor((Date.parse(firstObserved)-Date.parse(incident.release.deployedAt))/1000);
  if(releaseAgeSeconds>=0&&releaseAgeSeconds<=policy.maxReleaseWindowSeconds){
    const refs=["release","runtime-deployment",...incident.errors.map((/** @type {any} */e)=>`error:${e.id}`),...incident.metrics.map((/** @type {any} */m)=>`metric:${m.id}`)].filter((ref)=>evidenceIds.has(ref)).sort();
    correlations.push({id:"correlation:release-window",kind:"RELEASE_TEMPORAL",hypothesis:"The incident evidence was observed within the configured post-release window; inspect release-scoped changes without treating timing as causation.",sourceRefs:refs,details:{releaseId:incident.release.id,releaseAgeSeconds}});
  }

  for(const dep of input.dependencyInputs){
    if(dep.repository.id!==incident.repository.id||dep.repository.commit!==incident.repository.commit)continue;
    for(const change of dep.changes){
      const depEvidence=dep.evidence.filter((/** @type {any} */e)=>e.changeIds.includes(change.id)).map((/** @type {any} */e)=>`dependency-evidence:${dep.taskId}:${e.id}`);
      correlations.push({id:`correlation:dependency:${dep.taskId}:${change.id}`,kind:"DEPENDENCY_CHANGE",hypothesis:"A dependency change is explicitly bound to the same repository commit as the incident release; inspect its supplied evidence and verification surface.",sourceRefs:[`dependency-change:${dep.taskId}:${change.id}`,...depEvidence].sort(),details:{taskId:dep.taskId,changeId:change.id,package:change.package,fromVersion:change.fromVersion,toVersion:change.toVersion,updateClass:change.updateClass}});
    }
  }
  for(const contract of input.contractInputs){
    const repo=contract.repositories.find((/** @type {any} */r)=>r.id===incident.repository.id&&r.commit===incident.repository.commit);
    if(!repo)continue;
    for(const finding of contract.audit.findings.filter((/** @type {any} */f)=>f.status==="FAIL")){
      const related=contract.relationships.filter((/** @type {any} */r)=>r.contractId===finding.contractId&&(r.providerRepository===incident.repository.id||r.consumerRepository===incident.repository.id));
      if(related.length===0)continue;
      const relationshipRefs=related.map((/** @type {any} */r)=>`contract-relationship:${contract.taskId}:${r.id}`);
      correlations.push({id:`correlation:contract:${contract.taskId}:${finding.id}`,kind:"CONTRACT_FAILURE",hypothesis:"A deterministic cross-repository contract failure is connected to the incident repository through an explicit provider-consumer relationship at the evaluated commit; inspect compatibility without inferring canonical business truth.",sourceRefs:[`contract-audit:${contract.taskId}:${finding.id}`,...relationshipRefs].sort(),details:{taskId:contract.taskId,contractId:finding.contractId,checkId:finding.checkId,mismatchRepositories:[...finding.repositories]}});
    }
  }

  const signatures=new Map(input.incidentSignatures.map((/** @type {any} */s)=>[s.signatureSha256,s.errorId]));
  for(const prior of input.knownFailures){
    if(prior.repository.id!==incident.repository.id)continue;
    const ageSeconds=Math.floor((Date.parse(incident.evaluatedAt)-Date.parse(prior.lastObservedAt))/1000);
    if(ageSeconds<0||ageSeconds>policy.maxKnownFailureAgeSeconds)continue;
    const matches=prior.signatureSha256.filter((/** @type {string} */sig)=>signatures.has(sig));
    for(const signature of matches){
      const errorId=signatures.get(signature);
      correlations.push({id:`correlation:known-failure:${prior.id}:${errorId}`,kind:"PRIOR_FAILURE_MATCH",hypothesis:"An opaque incident error signature exactly matches a caller-supplied prior known-failure signature; compare the referenced evidence before drawing any causal conclusion.",sourceRefs:[`error:${errorId}`,`known-failure:${prior.id}`,prior.sourceRef,...prior.evidenceRefs].sort(),details:{knownFailureId:prior.id,errorId,signatureSha256:signature,ageSeconds}});
    }
  }

  const byKind={releaseTemporal:0,dependencyChange:0,contractFailure:0,priorFailureMatch:0};
  for(const item of correlations){if(item.kind==="RELEASE_TEMPORAL")byKind.releaseTemporal++;else if(item.kind==="DEPENDENCY_CHANGE")byKind.dependencyChange++;else if(item.kind==="CONTRACT_FAILURE")byKind.contractFailure++;else if(item.kind==="PRIOR_FAILURE_MATCH")byKind.priorFailureMatch++;}
  return{version:1,repository:incident.repository,release:incident.release,evaluatedAt:incident.evaluatedAt,correlations:correlations.sort((a,b)=>a.id.localeCompare(b.id)),summary:{total:correlations.length,...byKind},rootCauseEstablished:false,incidentResolved:false,executionAuthorized:false,rollbackAuthorized:false,deployAuthorized:false,sourceMutationAuthorized:false,semantics:"deterministic correlation evidence only; temporal, commit, contract, dependency, and exact-signature matches are investigation hypotheses with source references and do not establish causation or root cause"};
}
/** @param {string} filename */
function readJson(filename){const resolved=path.resolve(filename);let stat;try{stat=fs.lstatSync(resolved);}catch{throw new Error("incident correlation input cannot be read");}if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>MAX_FILE_BYTES)throw new Error("incident correlation input must be a bounded regular non-symlink file");try{return JSON.parse(fs.readFileSync(resolved,"utf8"));}catch{throw new Error("incident correlation input JSON cannot be parsed");}}
/** @param {any} report */
export function formatIncidentCorrelation(report){
  const lines=["Incident Correlation Evidence v1","",`Repository: ${report.repository.id}@${report.repository.commit}`,`Release: ${report.release.id}`,`Correlations: ${report.summary.total}`,""];
  for(const item of report.correlations)lines.push(`${item.kind.padEnd(20)}  ${item.id}  refs=${item.sourceRefs.join(",")}`);
  lines.push("",`Semantics: ${report.semantics}`);
  return lines.join("\n");
}
/** @param {string[]} argv */
function parse(argv){let file=null,json=false;for(let i=0;i<argv.length;i++){const arg=argv[i];if(arg==="--json"){if(json)return null;json=true;continue;}if(arg!=="--file"||file!==null)return null;const next=argv[i+1];if(typeof next!=="string"||next.startsWith("--"))return null;file=next;i++;}return file?{file,json}:null;}
export function main(argv=process.argv.slice(2)){const options=parse(argv);if(!options){console.error("Usage: node scripts/incident-correlation.js --file <correlation-input.json> [--json]");return 1;}try{const validated=validateIncidentCorrelationInput(readJson(options.file));if(!validated.valid||!validated.input)throw new Error("Incident Correlation Input v1 is invalid");const report=correlateIncidentEvidence(validated.input);console.log(options.json?JSON.stringify(report):formatIncidentCorrelation(report));return 0;}catch(error){console.error(error instanceof Error?error.message:"incident correlation failed");return 1;}}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();
