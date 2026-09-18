#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ROLES=new Set(["diagnose","reproduce","review","repair","docs","contract","dependency","incident"]);
const WORKER_CLASSES=new Set(["PERSISTENT","COMPUTE"]);
const MODEL_CLASSES=new Set(["SMALL","STANDARD","STRONG","REVIEW"]);
const PROPOSAL_OUTCOMES=new Set(["ACCEPTED","REJECTED","NOT_APPLICABLE"]);
const EVALUATION_STATUSES=new Set(["PASS","FAIL","NOT_EVALUATED"]);
const MAX_FILE_BYTES=16*1024*1024;

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
/** @param {unknown} v */
function nullableCounter(v){
  if(v===null)return null;
  const parsed=integer(v,0,Number.MAX_SAFE_INTEGER);
  return parsed===null?undefined:parsed;
}
/** @param {unknown} value @param {number} index @param {Array<{id:string,detail:string}>} errors */
function validateRun(value,index,errors){
  if(!object(value)){errors.push({id:"run-invalid",detail:`runs[${index}] must be an object`});return null;}
  unknown(value,["runId","taskId","role","repository","worker","model","startedAt","completedAt","latencyMs","resources","usage","proposal","review","defect","evaluation"],"run",errors);
  const runId=id(value.runId),taskId=id(value.taskId),role=text(value.role,32);
  if(!runId||!taskId||!role||!ROLES.has(role))errors.push({id:"run-identity-invalid",detail:`runs[${index}] identity or role is invalid`});

  let repository=null;
  if(!object(value.repository))errors.push({id:"repository-invalid",detail:`runs[${index}].repository must be an object`});
  else{
    unknown(value.repository,["id","commit"],"repository",errors);
    const repositoryId=id(value.repository.id),commit=text(value.repository.commit,128)?.toLowerCase()??null;
    if(!repositoryId||!commit||!isFullObjectId(commit))errors.push({id:"repository-fields-invalid",detail:`runs[${index}] repository binding is invalid`});
    else repository={id:repositoryId,commit};
  }

  let worker=null;
  if(!object(value.worker))errors.push({id:"worker-invalid",detail:`runs[${index}].worker must be an object`});
  else{
    unknown(value.worker,["id","class"],"worker",errors);
    const workerId=id(value.worker.id),workerClass=text(value.worker.class,32);
    if(!workerId||!workerClass||!WORKER_CLASSES.has(workerClass))errors.push({id:"worker-fields-invalid",detail:`runs[${index}] worker identity is invalid`});
    else worker={id:workerId,class:workerClass};
  }
  let model=null;
  if(!object(value.model))errors.push({id:"model-invalid",detail:`runs[${index}].model must be an object`});
  else{
    unknown(value.model,["id","class","backend"],"model",errors);
    const modelId=id(value.model.id),modelClass=text(value.model.class,32),backend=id(value.model.backend);
    if(!modelId||!modelClass||!MODEL_CLASSES.has(modelClass)||!backend)errors.push({id:"model-fields-invalid",detail:`runs[${index}] model identity is invalid`});
    else model={id:modelId,class:modelClass,backend};
  }

  const startedAt=text(value.startedAt,64),completedAt=text(value.completedAt,64),latencyMs=integer(value.latencyMs,0,24*3600*1000);
  if(!startedAt||!completedAt||!isAbsoluteIsoTimestamp(startedAt)||!isAbsoluteIsoTimestamp(completedAt)||latencyMs===null){
    errors.push({id:"timing-invalid",detail:`runs[${index}] timing is invalid`});
  }else{
    const exact=Date.parse(completedAt)-Date.parse(startedAt);
    if(exact<0||exact!==latencyMs)errors.push({id:"latency-binding-invalid",detail:`runs[${index}] latencyMs must exactly equal completedAt-startedAt`});
  }

  let resources=null;
  if(!object(value.resources))errors.push({id:"resources-invalid",detail:`runs[${index}].resources must be an object`});
  else{
    unknown(value.resources,["cpuTimeMs","gpuTimeMs"],"resources",errors);
    const cpuTimeMs=integer(value.resources.cpuTimeMs,0,24*3600*1000);
    const gpuTimeMs=value.resources.gpuTimeMs===null?null:(()=>{const parsed=integer(value.resources.gpuTimeMs,0,24*3600*1000);return parsed===null?undefined:parsed;})();
    if(cpuTimeMs===null||gpuTimeMs===undefined)errors.push({id:"resource-fields-invalid",detail:`runs[${index}] CPU/GPU time is invalid`});
    else resources={cpuTimeMs,gpuTimeMs};
  }

  let usage=null;
  if(!object(value.usage))errors.push({id:"usage-invalid",detail:`runs[${index}].usage must be an object`});
  else{
    unknown(value.usage,["inputTokens","outputTokens"],"usage",errors);
    const inputTokens=nullableCounter(value.usage.inputTokens),outputTokens=nullableCounter(value.usage.outputTokens);
    if(inputTokens===undefined||outputTokens===undefined)errors.push({id:"usage-fields-invalid",detail:`runs[${index}] token usage must be non-negative integers or null`});
    else usage={inputTokens,outputTokens};
  }
  let proposal=null;
  if(!object(value.proposal))errors.push({id:"proposal-invalid",detail:`runs[${index}].proposal must be an object`});
  else{
    unknown(value.proposal,["outcome"],"proposal",errors);
    const outcome=text(value.proposal.outcome,32);
    if(!outcome||!PROPOSAL_OUTCOMES.has(outcome))errors.push({id:"proposal-fields-invalid",detail:`runs[${index}] proposal outcome is invalid`});
    else proposal={outcome};
  }

  let review=null;
  if(!object(value.review))errors.push({id:"review-invalid",detail:`runs[${index}].review must be an object`});
  else{
    unknown(value.review,["effortSeconds"],"review",errors);
    const effortSeconds=integer(value.review.effortSeconds,0,7*24*3600);
    if(effortSeconds===null)errors.push({id:"review-fields-invalid",detail:`runs[${index}] review effort is invalid`});
    else review={effortSeconds};
  }

  let defect=null;
  if(!object(value.defect))errors.push({id:"defect-invalid",detail:`runs[${index}].defect must be an object`});
  else{
    unknown(value.defect,["reopened"],"defect",errors);
    if(typeof value.defect.reopened!=="boolean")errors.push({id:"defect-fields-invalid",detail:`runs[${index}] reopened must be boolean`});
    else if(value.defect.reopened&&proposal?.outcome!=="ACCEPTED")errors.push({id:"defect-outcome-invalid",detail:`runs[${index}] reopened defect requires ACCEPTED proposal outcome`});
    else defect={reopened:value.defect.reopened};
  }

  let evaluation=null;
  if(!object(value.evaluation))errors.push({id:"evaluation-invalid",detail:`runs[${index}].evaluation must be an object`});
  else{
    unknown(value.evaluation,["corpusId","status"],"evaluation",errors);
    const status=text(value.evaluation.status,32),corpusId=value.evaluation.corpusId===null?null:id(value.evaluation.corpusId);
    if(!status||!EVALUATION_STATUSES.has(status)||(status==="NOT_EVALUATED"&&corpusId!==null)||(status!=="NOT_EVALUATED"&&!corpusId))errors.push({id:"evaluation-fields-invalid",detail:`runs[${index}] evaluation status/corpus binding is invalid`});
    else evaluation={corpusId,status};
  }
  if(!runId||!taskId||!role||!ROLES.has(role)||!repository||!worker||!model||!startedAt||!completedAt||latencyMs===null||!resources||!usage||!proposal||!review||!defect||!evaluation)return null;
  return{runId,taskId,role,repository,worker,model,startedAt,completedAt,latencyMs,resources,usage,proposal,review,defect,evaluation};
}

/** @param {unknown} value */
export function validateAgentTelemetryEvidence(value){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,evidence:null,errors:[{id:"evidence-invalid",detail:"agent telemetry evidence must be an object"}]};
  unknown(value,["version","evidence","runs"],"evidence",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"evidence version must be exactly 1"});

  let source=null;
  if(!object(value.evidence))errors.push({id:"source-invalid",detail:"evidence metadata must be an object"});
  else{
    unknown(value.evidence,["source","authenticated","collectedAt"],"source",errors);
    const sourceId=id(value.evidence.source),collectedAt=text(value.evidence.collectedAt,64);
    if(!sourceId||typeof value.evidence.authenticated!=="boolean"||!collectedAt||!isAbsoluteIsoTimestamp(collectedAt))errors.push({id:"source-fields-invalid",detail:"evidence metadata is invalid"});
    else source={source:sourceId,authenticated:value.evidence.authenticated,collectedAt};
  }

  /** @type {any[]} */const runs=[];const runIds=new Set();
  if(!Array.isArray(value.runs)||value.runs.length===0||value.runs.length>10000)errors.push({id:"runs-invalid",detail:"runs must be a non-empty bounded array"});
  else for(const [index,raw]of value.runs.entries()){
    const run=validateRun(raw,index,errors);if(!run)continue;
    if(runIds.has(run.runId)){errors.push({id:"run-duplicate",detail:`run id ${run.runId} is duplicated`});continue;}
    if(source&&Date.parse(run.completedAt)>Date.parse(source.collectedAt))errors.push({id:"run-future-invalid",detail:`run ${run.runId} completes after evidence collectedAt`});
    runIds.add(run.runId);runs.push(run);
  }
  if(errors.length||!source)return{valid:false,evidence:null,errors};
  return{valid:true,evidence:{version:1,evidence:source,runs:runs.sort((a,b)=>a.runId.localeCompare(b.runId))},errors:[]};
}
/** @param {any[]} runs */
function aggregateRuns(runs){
  const totals={
    runs:runs.length,latencyMs:0,cpuTimeMs:0,gpuTimeMs:0,gpuTimeReported:0,
    inputTokens:0,outputTokens:0,tokenUsageReported:0,tokenUsageMissing:0,
    proposals:{accepted:0,rejected:0,notApplicable:0},
    reopenedDefects:0,reviewEffortSeconds:0,
    evaluation:{pass:0,fail:0,notEvaluated:0},
  };
  for(const run of runs){
    totals.latencyMs+=run.latencyMs;totals.cpuTimeMs+=run.resources.cpuTimeMs;
    if(run.resources.gpuTimeMs!==null){totals.gpuTimeMs+=run.resources.gpuTimeMs;totals.gpuTimeReported++;}
    if(run.usage.inputTokens!==null&&run.usage.outputTokens!==null){totals.inputTokens+=run.usage.inputTokens;totals.outputTokens+=run.usage.outputTokens;totals.tokenUsageReported++;}else totals.tokenUsageMissing++;
    if(run.proposal.outcome==="ACCEPTED")totals.proposals.accepted++;else if(run.proposal.outcome==="REJECTED")totals.proposals.rejected++;else totals.proposals.notApplicable++;
    if(run.defect.reopened)totals.reopenedDefects++;
    totals.reviewEffortSeconds+=run.review.effortSeconds;
    if(run.evaluation.status==="PASS")totals.evaluation.pass++;else if(run.evaluation.status==="FAIL")totals.evaluation.fail++;else totals.evaluation.notEvaluated++;
  }
  return totals;
}
/** @param {any[]} runs @param {(run:any)=>string} keyOf */
function grouped(runs,keyOf){
  const map=new Map();
  for(const run of runs){const key=keyOf(run),bucket=map.get(key)??[];bucket.push(run);map.set(key,bucket);}
  return[...map.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([key,bucket])=>({key,totals:aggregateRuns(bucket)}));
}

/** @param {any} evidence */
export function aggregateAgentTelemetry(evidence){
  return{
    version:1,evidence:evidence.evidence,totals:aggregateRuns(evidence.runs),
    byRole:grouped(evidence.runs,(run)=>run.role),
    byModel:grouped(evidence.runs,(run)=>`${run.model.backend}:${run.model.id}:${run.model.class}`),
    byWorker:grouped(evidence.runs,(run)=>`${run.worker.id}:${run.worker.class}`),
    qualityScore:null,
    semantics:"observational agent resource and outcome telemetry only; acceptance, rejection, corpus status, review effort, reopened defects, resource time, latency, and token counts are caller-supplied measurements and are not combined into a model-quality score",
  };
}
/** @param {string} filename */
function readJson(filename){const resolved=path.resolve(filename);let stat;try{stat=fs.lstatSync(resolved);}catch{throw new Error("agent telemetry input cannot be read");}if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>MAX_FILE_BYTES)throw new Error("agent telemetry input must be a bounded regular non-symlink file");try{return JSON.parse(fs.readFileSync(resolved,"utf8"));}catch{throw new Error("agent telemetry input JSON cannot be parsed");}}
/** @param {any} report */
export function formatAgentTelemetry(report){
  const t=report.totals;
  return["Agent Resource & Model Quality Telemetry v1","",`Runs: ${t.runs}`,`Latency ms: ${t.latencyMs}`,`CPU ms: ${t.cpuTimeMs}`,`GPU ms: ${t.gpuTimeMs} (${t.gpuTimeReported} reported)`,`Tokens: ${t.inputTokens} input / ${t.outputTokens} output (${t.tokenUsageMissing} missing)`,`Proposals: ${t.proposals.accepted} accepted / ${t.proposals.rejected} rejected / ${t.proposals.notApplicable} n/a`,`Reopened defects: ${t.reopenedDefects}`,`Review effort seconds: ${t.reviewEffortSeconds}`,`Evaluation: ${t.evaluation.pass} pass / ${t.evaluation.fail} fail / ${t.evaluation.notEvaluated} not evaluated`,"",`Semantics: ${report.semantics}`].join("\n");
}
/** @param {string[]} argv */
function parse(argv){let file=null,json=false;for(let i=0;i<argv.length;i++){const a=argv[i];if(a==="--json"){if(json)return null;json=true;continue;}if(a!=="--file"||file!==null)return null;const v=argv[i+1];if(typeof v!=="string"||v.startsWith("--"))return null;file=v;i++;}return file?{file,json}:null;}
export function main(argv=process.argv.slice(2)){const options=parse(argv);if(!options){console.error("Usage: node scripts/agent-resource-telemetry.js --file <telemetry.json> [--json]");return 1;}try{const result=validateAgentTelemetryEvidence(readJson(options.file));if(!result.valid||!result.evidence)throw new Error("Agent Telemetry Evidence v1 is invalid");const report=aggregateAgentTelemetry(result.evidence);console.log(options.json?JSON.stringify(report):formatAgentTelemetry(report));return 0;}catch(error){console.error(error instanceof Error?error.message:"agent telemetry failed");return 1;}}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();
