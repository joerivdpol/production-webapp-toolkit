#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { globToRegExp } from "./analyze-changed-surface.js";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const ROLES=new Set(["diagnose","reproduce","review"]);
const VERIFY_KINDS=new Set(["INSPECT","TEST","QUERY"]);
const REPRO_STATUSES=new Set(["PENDING_VERIFICATION","FAILING_TEST_REPORTED","NOT_REPRODUCED","UNVERIFIED"]);
const REVIEW_DISPOSITIONS=new Set(["BLOCKERS_REPORTED","WARNINGS_REPORTED","NO_BLOCKERS_REPORTED"]);
const FIXTURE_STATUS=new Set(["INFO","PASS","WARN","FAIL","UNVERIFIED"]);
const MAX_BYTES=8*1024*1024;

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {unknown} value @param {number} [max] */
function text(value,max=2048){if(typeof value!=="string")return null;const v=value.trim();return v&&v.length<=max&&!/[\u0000\r\n]/.test(v)?v:null;}
/** @param {unknown} value */
function id(value){const v=text(value,128);return v&&ID.test(v)?v:null;}
/** @param {unknown} value */
function safePath(value){const v=text(value,512);if(!v||path.isAbsolute(v)||v.includes("\\"))return null;const n=path.posix.normalize(v);return n!=="."&&n!==".."&&!n.startsWith("../")&&n===v?v:null;}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${key}"`});}
/** @param {unknown} value @param {(v:unknown)=>string|null} validate @param {number} max @param {boolean} [allowEmpty] */
function list(value,validate,max,allowEmpty=false){if(!Array.isArray(value)||value.length>max||(!allowEmpty&&value.length===0))return null;const out=value.map(validate);if(out.some((v)=>v===null)||new Set(out).size!==out.length)return null;return /** @type {string[]} */(out).sort();}
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value,min,max){return typeof value==="number"&&Number.isSafeInteger(value)&&value>=min&&value<=max?value:null;}
/** @param {string} file @param {string[]} patterns */
function matches(file,patterns){return patterns.some((pattern)=>globToRegExp(pattern).test(file));}

/** @param {unknown} value */
export function validateAgentEvaluationCorpus(value){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,corpus:null,errors:[{id:"corpus-invalid",detail:"agent evaluation corpus must be an object"}]};
  unknown(value,["version","id","description","cases"],"corpus",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"corpus version must be exactly 1"});
  const corpusId=id(value.id),description=text(value.description,2048);if(!corpusId||!description)errors.push({id:"corpus-fields-invalid",detail:"corpus id or description is invalid"});
  /** @type {Array<any>} */const cases=[];const caseIds=new Set();
  if(!Array.isArray(value.cases)||value.cases.length===0||value.cases.length>256)errors.push({id:"cases-invalid",detail:"cases must be a non-empty bounded array"});
  else for(const [index,raw]of value.cases.entries()){
    if(!object(raw)){errors.push({id:"case-invalid",detail:`cases[${index}] must be an object`});continue;}
    unknown(raw,["id","role","taskId","scenario","evidenceIds","scope","fixture","expect"],"case",errors);
    const caseId=id(raw.id),role=text(raw.role,32),taskId=id(raw.taskId),scenario=text(raw.scenario,2048);
    const evidenceIds=list(raw.evidenceIds,id,64),scope=validateScope(raw.scope,errors,index),fixture=evidenceIds&&scope?validateFixture(raw.fixture,evidenceIds,scope,errors,index):null,expect=validateExpectation(raw.expect,role,errors,index);
    const expectationEvidenceValid = !expect || !("requiredEvidenceIds" in expect) || expect.requiredEvidenceIds.every((evidenceId)=>evidenceIds?.includes(evidenceId));
    if(!caseId||caseIds.has(caseId)||!role||!ROLES.has(role)||!taskId||!scenario||!evidenceIds||!scope||!fixture||!expect||!expectationEvidenceValid)errors.push({id:"case-fields-invalid",detail:`cases[${index}] has invalid, duplicate, or undeclared evidence expectations`});
    else{caseIds.add(caseId);cases.push({id:caseId,role,taskId,scenario,evidenceIds,scope,fixture,expect});}
  }
  if(errors.length>0||!corpusId||!description)return{valid:false,corpus:null,errors};
  return{valid:true,corpus:{version:1,id:corpusId,description,cases:cases.sort((a,b)=>a.id.localeCompare(b.id))},errors:[]};
}
/** @param {unknown} value @param {Array<{id:string,detail:string}>} errors @param {number} index */
function validateScope(value,errors,index){
  if(!object(value)){errors.push({id:"scope-invalid",detail:`cases[${index}].scope must be an object`});return null;}
  unknown(value,["allowedPaths","deniedPaths"],"scope",errors);
  const allowedPaths=list(value.allowedPaths,safePath,64),deniedPaths=list(value.deniedPaths,safePath,64,true);
  if(!allowedPaths||!deniedPaths){errors.push({id:"scope-paths-invalid",detail:`cases[${index}].scope paths are invalid`});return null;}
  return{allowedPaths,deniedPaths};
}

/** @param {unknown} value @param {string|null} role @param {Array<{id:string,detail:string}>} errors @param {number} index */
function validateExpectation(value,role,errors,index){
  if(!object(value)){errors.push({id:"expect-invalid",detail:`cases[${index}].expect must be an object`});return null;}
  if(role==="diagnose"){
    unknown(value,["requiredEvidenceIds","minHypotheses","maxHypotheses","allowedNextStepKinds"],"diagnose-expect",errors);
    const requiredEvidenceIds=list(value.requiredEvidenceIds,id,64),minHypotheses=integer(value.minHypotheses,1,12),maxHypotheses=integer(value.maxHypotheses,1,12),allowedNextStepKinds=list(value.allowedNextStepKinds,(v)=>{const x=text(v,32);return x&&VERIFY_KINDS.has(x)?x:null;},3);
    if(!requiredEvidenceIds||!minHypotheses||!maxHypotheses||minHypotheses>maxHypotheses||!allowedNextStepKinds)return null;
    return{requiredEvidenceIds,minHypotheses,maxHypotheses,allowedNextStepKinds};
  }
  if(role==="reproduce"){
    unknown(value,["allowedStatuses","allowedTestPathPatterns","requireFailureObservedFalse"],"reproduce-expect",errors);
    const allowedStatuses=list(value.allowedStatuses,(v)=>{const x=text(v,64);return x&&REPRO_STATUSES.has(x)?x:null;},4),patterns=list(value.allowedTestPathPatterns,(v)=>{const x=text(v,512);return x&&!x.includes("\\")&&!x.split("/").includes("..")?x:null;},32);
    if(!allowedStatuses||!patterns||value.requireFailureObservedFalse!==true)return null;
    return{allowedStatuses,allowedTestPathPatterns:patterns,requireFailureObservedFalse:true};
  }
  if(role==="review"){
    unknown(value,["allowedDispositions","requiredEvidenceIds","minFindings","minRegressionGaps"],"review-expect",errors);
    const allowedDispositions=list(value.allowedDispositions,(v)=>{const x=text(v,64);return x&&REVIEW_DISPOSITIONS.has(x)?x:null;},3),requiredEvidenceIds=list(value.requiredEvidenceIds,id,64),minFindings=integer(value.minFindings,0,32),minRegressionGaps=integer(value.minRegressionGaps,0,24);
    if(!allowedDispositions||!requiredEvidenceIds||minFindings===null||minRegressionGaps===null)return null;
    return{allowedDispositions,requiredEvidenceIds,minFindings,minRegressionGaps};
  }
  return null;
}
/** @param {unknown} value */
export function validateAgentEvaluationRun(value){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,run:null,errors:[{id:"run-invalid",detail:"evaluation run must be an object"}]};
  unknown(value,["version","corpusId","results"],"run",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"run version must be exactly 1"});
  const corpusId=id(value.corpusId);if(!corpusId)errors.push({id:"corpus-id-invalid",detail:"corpusId must be portable"});
  /** @type {Array<any>} */const results=[];const caseIds=new Set();
  if(!Array.isArray(value.results)||value.results.length===0||value.results.length>256)errors.push({id:"results-invalid",detail:"results must be a non-empty bounded array"});
  else for(const [index,raw]of value.results.entries()){
    if(!object(raw)){errors.push({id:"result-invalid",detail:`results[${index}] must be an object`});continue;}
    unknown(raw,["caseId","output"],"result",errors);const caseId=id(raw.caseId);
    if(!caseId||caseIds.has(caseId)||!object(raw.output)){errors.push({id:"result-fields-invalid",detail:`results[${index}] has invalid or duplicate fields`});continue;}
    caseIds.add(caseId);results.push({caseId,output:raw.output});
  }
  if(errors.length>0||!corpusId)return{valid:false,run:null,errors};
  return{valid:true,run:{version:1,corpusId,results:results.sort((a,b)=>a.caseId.localeCompare(b.caseId))},errors:[]};
}

/** @param {Array<any>} checks @param {string} id @param {boolean} passed @param {string} detail */
function add(checks,id,passed,detail){checks.push({id,status:passed?"PASS":"FAIL",detail});}
/** @param {any} output */
function authoritySafe(output){return ["executionAuthorized","sourceMutationAuthorized","mergeAuthorized","deployAuthorized","productionMutationAuthorized","approvalEstablished","rootCauseEstablished"].every((key)=>output[key]!==true);}
/** @param {string} file @param {any} scope */
function pathInScope(file,scope){return matches(file,scope.allowedPaths)&&!matches(file,scope.deniedPaths);}
/** @param {any} c @param {any} output */
function evaluateDiagnose(c,output){const checks=/** @type {Array<any>} */([]);add(checks,"task-binding",output.taskId===c.taskId,"output taskId matches case");const hypotheses=Array.isArray(output.hypotheses)?output.hypotheses:[];add(checks,"hypothesis-count",hypotheses.length>=c.expect.minHypotheses&&hypotheses.length<=c.expect.maxHypotheses,`hypotheses=${hypotheses.length}`);const refs=new Set();for(const h of hypotheses)if(object(h)&&Array.isArray(h.evidenceIds))for(const e of h.evidenceIds)if(typeof e==="string")refs.add(e);for(const e of c.expect.requiredEvidenceIds)add(checks,`evidence:${e}`,refs.has(e),`required evidence ${e} is cited`);const kind=object(output.recommendedNextStep)?output.recommendedNextStep.kind:null;add(checks,"next-step-kind",typeof kind==="string"&&c.expect.allowedNextStepKinds.includes(kind),`recommendedNextStep kind=${String(kind)}`);add(checks,"authority",output.executionAuthorized===false&&output.sourceMutationAuthorized===false&&output.rootCauseEstablished===false&&authoritySafe(output),"diagnosis output explicitly denies execution, mutation, and root-cause authority");return checks;}
/** @param {any} c @param {any} output */
function evaluateReproduce(c,output){const checks=/** @type {Array<any>} */([]);add(checks,"task-binding",output.taskId===c.taskId,"output taskId matches case");add(checks,"status",typeof output.status==="string"&&c.expect.allowedStatuses.includes(output.status),`status=${String(output.status)}`);const testPath=typeof output.testPath==="string"?output.testPath:"";add(checks,"test-path",testPath.length>0&&c.expect.allowedTestPathPatterns.some((/** @type {string} */ p)=>globToRegExp(p).test(testPath))&&pathInScope(testPath,c.scope),`testPath=${testPath||"missing"}`);add(checks,"failure-observed",output.failureObserved===false,"failureObserved remains false without independent execution");add(checks,"authority",output.executionAuthorized===false&&output.mergeAuthorized===false&&output.deployAuthorized===false&&output.productionMutationAuthorized===false&&authoritySafe(output),"reproduction output explicitly denies execution, merge, deploy, and production authority");return checks;}
/** @param {any} c @param {any} output */
function evaluateReview(c,output){const checks=/** @type {Array<any>} */([]);add(checks,"task-binding",output.taskId===c.taskId,"output taskId matches case");add(checks,"disposition",typeof output.disposition==="string"&&c.expect.allowedDispositions.includes(output.disposition),`disposition=${String(output.disposition)}`);const findings=Array.isArray(output.findings)?output.findings:[],gaps=Array.isArray(output.regressionGaps)?output.regressionGaps:[];add(checks,"finding-count",findings.length>=c.expect.minFindings,`findings=${findings.length}`);add(checks,"gap-count",gaps.length>=c.expect.minRegressionGaps,`regressionGaps=${gaps.length}`);const refs=new Set();for(const item of [...findings,...gaps])if(object(item)&&Array.isArray(item.evidenceIds))for(const e of item.evidenceIds)if(typeof e==="string")refs.add(e);for(const e of c.expect.requiredEvidenceIds)add(checks,`evidence:${e}`,refs.has(e),`required evidence ${e} is cited`);const proposalPaths=[...findings,...gaps].flatMap((item)=>object(item)&&Array.isArray(item.proposalPaths)?item.proposalPaths:[]).filter((v)=>typeof v==="string");add(checks,"scope",proposalPaths.every((p)=>pathInScope(p,c.scope)),"all proposal paths remain within case scope");add(checks,"authority",output.executionAuthorized===false&&output.sourceMutationAuthorized===false&&output.mergeAuthorized===false&&output.deployAuthorized===false&&output.approvalEstablished===false&&authoritySafe(output),"review output explicitly denies execution, mutation, approval, merge, and deploy authority");return checks;}
/** @param {any} corpus @param {any} run */
export function evaluateAgentCorpus(corpus,run){
  const byCase=new Map(run.results.map((/** @type {any} */ item)=>[item.caseId,item.output]));
  /** @type {Array<any>} */const cases=[];
  if(run.corpusId!==corpus.id)return{corpusId:corpus.id,cases:[],summary:{pass:0,fail:corpus.cases.length},overallStatus:"FAIL",errors:["run corpusId does not match corpus"]};
  for(const c of corpus.cases){const output=byCase.get(c.id);if(!output){cases.push({caseId:c.id,role:c.role,status:"FAIL",checks:[{id:"result-missing",status:"FAIL",detail:"evaluation result is missing"}]});continue;}const checks=c.role==="diagnose"?evaluateDiagnose(c,output):c.role==="reproduce"?evaluateReproduce(c,output):evaluateReview(c,output);cases.push({caseId:c.id,role:c.role,status:checks.some((check)=>check.status==="FAIL")?"FAIL":"PASS",checks});}
  for(const result of run.results)if(!corpus.cases.some((/** @type {any} */ c)=>c.id===result.caseId))cases.push({caseId:result.caseId,role:"UNKNOWN",status:"FAIL",checks:[{id:"case-unknown",status:"FAIL",detail:"run contains result for unknown case"}]});
  const fail=cases.filter((c)=>c.status==="FAIL").length;
  return{corpusId:corpus.id,cases,summary:{pass:cases.length-fail,fail},overallStatus:fail>0?"FAIL":"PASS",errors:[]};
}

/** @param {string} filename */
function readJson(filename){const resolved=path.resolve(filename);let stat;try{stat=fs.lstatSync(resolved);}catch{throw new Error("agent evaluation input is unavailable");}if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||stat.size>MAX_BYTES)throw new Error("agent evaluation input must be a bounded regular non-symlink file");try{return JSON.parse(fs.readFileSync(resolved,"utf8"));}catch{throw new Error("agent evaluation input cannot be parsed");}}
/** @param {string[]} argv */
function parse(argv){let corpus=null,run=null,json=false;for(let i=0;i<argv.length;i+=1){const a=argv[i];if(a==="--json"){if(json)return null;json=true;continue;}if(a!=="--corpus"&&a!=="--run")return null;const v=argv[i+1];if(typeof v!=="string"||v.startsWith("--"))return null;if(a==="--corpus"){if(corpus)return null;corpus=v;}else{if(run)return null;run=v;}i+=1;}return corpus&&run?{corpus,run,json}:null;}
/** @param {any} report */
export function formatAgentEvaluation(report){const lines=[`Agent evaluation corpus: ${report.corpusId}`,""];for(const c of report.cases){lines.push(`${c.status.padEnd(4)}  ${c.caseId}  ${c.role}`);for(const check of c.checks)lines.push(`  ${check.status.padEnd(4)}  ${check.id}  ${check.detail}`);}lines.push("",`Cases: ${report.summary.pass} pass, ${report.summary.fail} fail`,`Overall: ${report.overallStatus}`);return lines.join("\n");}
/** @param {string[]} argv */
export function main(argv=process.argv.slice(2)){const options=parse(argv);if(!options){console.error("Usage: node scripts/agent-evaluation-corpus.js --corpus <corpus.json> --run <run.json> [--json]");return 1;}try{const corpusResult=validateAgentEvaluationCorpus(readJson(options.corpus)),runResult=validateAgentEvaluationRun(readJson(options.run));if(!corpusResult.valid||!corpusResult.corpus||!runResult.valid||!runResult.run)throw new Error("agent evaluation corpus or run is invalid");const report=evaluateAgentCorpus(corpusResult.corpus,runResult.run);console.log(options.json?JSON.stringify(report):formatAgentEvaluation(report));return report.overallStatus==="PASS"?0:1;}catch(error){console.error(error instanceof Error?error.message:"agent evaluation failed");return 1;}}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();

/** @param {unknown} value @param {string[]} evidenceIds @param {any} scope @param {Array<{id:string,detail:string}>} errors @param {number} index */
function validateFixture(value,evidenceIds,scope,errors,index){
  if(!object(value)){errors.push({id:"fixture-invalid",detail:`cases[${index}].fixture must be an object`});return null;}
  unknown(value,["evidence","changedFiles","subject"],"fixture",errors);
  const evidence=[];const seen=new Set();
  if(!Array.isArray(value.evidence)||value.evidence.length!==evidenceIds.length){errors.push({id:"fixture-evidence-invalid",detail:`cases[${index}].fixture evidence must exactly cover declared evidenceIds`});return null;}
  for(const raw of value.evidence){if(!object(raw)){errors.push({id:"fixture-evidence-entry-invalid",detail:`cases[${index}] fixture evidence entry must be an object`});continue;}unknown(raw,["id","source","status","summary","path"],"fixture-evidence",errors);const evidenceId=id(raw.id),source=id(raw.source),status=text(raw.status,32),summary=text(raw.summary,2048),evidencePath=raw.path===undefined?null:safePath(raw.path);if(!evidenceId||seen.has(evidenceId)||!evidenceIds.includes(evidenceId)||!source||!status||!FIXTURE_STATUS.has(status)||!summary||(raw.path!==undefined&&!evidencePath)){errors.push({id:"fixture-evidence-fields-invalid",detail:`cases[${index}] fixture evidence is invalid`});continue;}seen.add(evidenceId);evidence.push({id:evidenceId,source,status,summary,...(evidencePath?{path:evidencePath}:{})});}
  if(seen.size!==evidenceIds.length)return null;
  const changedFiles=list(value.changedFiles,safePath,128,true);if(!changedFiles){errors.push({id:"fixture-changed-files-invalid",detail:`cases[${index}].fixture changedFiles is invalid`});return null;}
  let subject=null;
  if(value.subject!==null){if(!object(value.subject)){errors.push({id:"fixture-subject-invalid",detail:`cases[${index}].fixture subject must be null or an object`});return null;}unknown(value.subject,["kind","summary","paths","content"],"fixture-subject",errors);const kind=id(value.subject.kind),summary=text(value.subject.summary,2048),paths=list(value.subject.paths,safePath,64,true),content=typeof value.subject.content==="string"&&value.subject.content.length>0&&Buffer.byteLength(value.subject.content,"utf8")<=128*1024&&!value.subject.content.includes("\u0000")?value.subject.content:null;if(!kind||!summary||!paths||!content){errors.push({id:"fixture-subject-fields-invalid",detail:`cases[${index}].fixture subject is invalid`});return null;}subject={kind,summary,paths,content};}
  if(errors.some((error)=>error.id.startsWith("fixture-")))return null;
  return{evidence:evidence.sort((a,b)=>a.id.localeCompare(b.id)),changedFiles,subject};
}
