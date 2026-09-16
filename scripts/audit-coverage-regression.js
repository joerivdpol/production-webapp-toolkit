#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { COVERAGE_METRICS, validateCoverageComparisonEvidence } from "./coverage-comparison-evidence.js";

/** @typedef {{ lines:number,statements:number,functions:number,branches:number }} Percentages */
/** @typedef {{ id:string,paths:string[],required:boolean,minimums:Percentages }} CriticalRule */
/** @typedef {{ version:1,changed:{includePaths:string[],minimums:Percentages,maxRegressionPoints:Percentages},criticalModules:CriticalRule[] }} CoveragePolicy */
/** @typedef {{ id:string,status:"PASS"|"FAIL",scope:string,metric:string,detail:string }} CoverageCheck */

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {unknown} value */
function text(value){return typeof value==="string"&&value.trim()?value.trim():null;}
/** @param {Record<string,unknown>} value @param {readonly string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${key}"`});}
/** @param {unknown} value */
function safePattern(value){return typeof value==="string"&&value.length>0&&value.length<=256&&!value.startsWith("/")&&!value.includes("\\")&&!value.includes("\0")&&!value.split("/").includes("..");}
/** @param {unknown} value */
function patternList(value){return Array.isArray(value)&&value.length>0&&value.every(safePattern)&&new Set(value).size===value.length?[...value].sort():null;}
/** @param {string} pattern */
function glob(pattern){let out="^";for(let i=0;i<pattern.length;i+=1){const c=pattern[i];if(c===undefined)break;if(c==="*"){if(pattern[i+1]==="*"){out+=".*";i+=1;}else out+="[^/]*";}else if(c==="?")out+="[^/]";else out+=/[\\^$.*+?()[\]{}|]/.test(c)?`\\${c}`:c;}return new RegExp(`${out}$`);}
/** @param {string} file @param {string[]} patterns */
function matches(file,patterns){return patterns.some(pattern=>glob(pattern).test(file));}

/** @param {unknown} value @param {string} scope @param {Array<{id:string,detail:string}>} errors @returns {Percentages|null} */
function percentages(value,scope,errors){
  if(!object(value)){errors.push({id:"percentages-invalid",detail:`${scope} must be an object`});return null;}
  const source=/** @type {Record<string,unknown>} */(value);
  unknown(source,COVERAGE_METRICS,scope,errors);
  /** @type {Record<string,number>} */
  const out={};
  for(const metric of COVERAGE_METRICS){const v=source[metric];if(typeof v!=="number"||!Number.isFinite(v)||v<0||v>100)errors.push({id:"percentage-invalid",detail:`${scope}.${metric} must be between 0 and 100`});else out[metric]=v;}
  return COVERAGE_METRICS.every(metric=>out[metric]!==undefined)?/** @type {Percentages} */(out):null;
}

/** @param {unknown} value */
export function validateCoveragePolicy(value){
  /** @type {Array<{id:string,detail:string}>} */ const errors=[];
  if(!object(value))return{valid:false,policy:null,errors:[{id:"policy-invalid",detail:"coverage policy must be an object"}]};
  unknown(value,["version","changed","criticalModules"],"policy",errors);if(value.version!==1)errors.push({id:"version-invalid",detail:"version must be exactly 1"});
  let changed=null;
  if(!object(value.changed))errors.push({id:"changed-invalid",detail:"changed must be an object"});else{
    unknown(value.changed,["includePaths","minimums","maxRegressionPoints"],"changed",errors);const includePaths=patternList(value.changed.includePaths),minimums=percentages(value.changed.minimums,"changed.minimums",errors),maxRegressionPoints=percentages(value.changed.maxRegressionPoints,"changed.maxRegressionPoints",errors);
    if(!includePaths)errors.push({id:"changed-include-paths-invalid",detail:"changed.includePaths must be a non-empty unique safe pattern array"});else if(minimums&&maxRegressionPoints)changed={includePaths,minimums,maxRegressionPoints};
  }
  /** @type {CriticalRule[]} */ const criticalModules=[];const ids=new Set();
  if(!Array.isArray(value.criticalModules))errors.push({id:"critical-modules-invalid",detail:"criticalModules must be an array"});else for(const [index,raw] of value.criticalModules.entries()){
    if(!object(raw)){errors.push({id:"critical-module-invalid",detail:`criticalModules[${index}] must be an object`});continue;}
    unknown(raw,["id","paths","required","minimums"],"critical-module",errors);const id=text(raw.id),paths=patternList(raw.paths),minimums=percentages(raw.minimums,`criticalModules[${index}].minimums`,errors);
    if(!id||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)){errors.push({id:"critical-module-id-invalid",detail:`criticalModules[${index}].id is invalid`});continue;}
    if(ids.has(id)){errors.push({id:"critical-module-id-duplicate",detail:`criticalModules contains duplicate id "${id}"`});continue;}ids.add(id);
    if(!paths){errors.push({id:"critical-module-paths-invalid",detail:`criticalModules[${index}].paths is invalid`});continue;}
    if(typeof raw.required!=="boolean"){errors.push({id:"critical-module-required-invalid",detail:`criticalModules[${index}].required must be boolean`});continue;}
    if(minimums)criticalModules.push({id,paths,required:raw.required,minimums});
  }
  if(errors.length||!changed)return{valid:false,policy:null,errors};return{valid:true,policy:/** @type {CoveragePolicy} */({version:1,changed,criticalModules:criticalModules.sort((a,b)=>a.id.localeCompare(b.id))}),errors:[]};
}

/** @param {{covered:number,total:number}} value */
function percent(value){return value.total===0?null:(value.covered/value.total)*100;}
/** @param {number|null} value */
function display(value){return value===null?"N/A":`${value.toFixed(2)}%`;}
/** @param {CoverageCheck[]} checks @param {string} id @param {string} scope @param {string} metric @param {string} detail */
function fail(checks,id,scope,metric,detail){checks.push({id,status:"FAIL",scope,metric,detail});}
/** @param {CoverageCheck[]} checks @param {string} id @param {string} scope @param {string} metric @param {string} detail */
function pass(checks,id,scope,metric,detail){checks.push({id,status:"PASS",scope,metric,detail});}

/** @param {any} baseline @param {any} candidate @param {string} scope @param {Percentages} minimums @param {Percentages|null} regressions @param {CoverageCheck[]} checks */
function evaluateMetrics(baseline,candidate,scope,minimums,regressions,checks){
  for(const metric of COVERAGE_METRICS){
    const candidateCount=candidate.metrics[metric],candidatePct=percent(candidateCount),minimum=minimums[metric];
    if(candidatePct!==null&&candidatePct+1e-9<minimum)fail(checks,"coverage-minimum",scope,metric,`candidate ${display(candidatePct)} is below minimum ${minimum.toFixed(2)}%`);else pass(checks,"coverage-minimum",scope,metric,candidatePct===null?"no coverable units for this metric":`candidate ${display(candidatePct)} meets minimum ${minimum.toFixed(2)}%`);
    if(!baseline||!regressions)continue;
    const baselineCount=baseline.metrics[metric],baselinePct=percent(baselineCount);
    if(baselineCount.total>0&&candidateCount.total===0){fail(checks,"coverage-total-disappeared",scope,metric,"baseline had coverable units but candidate reports zero total");continue;}
    if(baselinePct===null||candidatePct===null){pass(checks,"coverage-regression",scope,metric,"regression is not applicable because one side has zero coverable units");continue;}
    const drop=baselinePct-candidatePct,maxDrop=regressions[metric];
    if(drop>maxDrop+1e-9)fail(checks,"coverage-regression",scope,metric,`coverage dropped ${drop.toFixed(2)} points from ${display(baselinePct)} to ${display(candidatePct)}; maximum ${maxDrop.toFixed(2)}`);else pass(checks,"coverage-regression",scope,metric,`coverage drop ${Math.max(0,drop).toFixed(2)} points is within maximum ${maxDrop.toFixed(2)}`);
  }
}

/** @param {CoveragePolicy} policy @param {import("./coverage-comparison-evidence.js").CoverageComparisonEvidence} evidence */
export function inspectCoverageRegression(policy,evidence){
  /** @type {CoverageCheck[]} */ const checks=[];const baseline=new Map(evidence.baseline.map(file=>[file.path,file])),candidate=new Map(evidence.candidate.map(file=>[file.path,file]));
  for(const change of evidence.changes){
    if(change.status==="DELETED"||!matches(change.path,policy.changed.includePaths))continue;
    const candidateFile=candidate.get(change.path),scope=`changed:${change.path}`;
    if(!candidateFile){fail(checks,"changed-coverage-missing",scope,"all","candidate coverage does not contain this changed file");continue;}
    const baselinePath=(change.status==="RENAMED"||change.status==="COPIED")?change.previousPath:change.path;
    const needsBaseline=change.status!=="ADDED";const baselineFile=baselinePath?baseline.get(baselinePath):undefined;
    if(needsBaseline&&!baselineFile){fail(checks,"baseline-coverage-missing",scope,"all",`baseline coverage is missing for ${baselinePath}`);evaluateMetrics(null,candidateFile,scope,policy.changed.minimums,null,checks);continue;}
    evaluateMetrics(baselineFile??null,candidateFile,scope,policy.changed.minimums,needsBaseline?policy.changed.maxRegressionPoints:null,checks);
  }

  for(const rule of policy.criticalModules){
    const files=evidence.candidate.filter(file=>matches(file.path,rule.paths));const scope=`critical:${rule.id}`;
    if(files.length===0){if(rule.required)fail(checks,"critical-module-missing",scope,"all","no candidate coverage files match this required critical module");else pass(checks,"critical-module-not-present",scope,"all","optional critical module is not present in candidate coverage");continue;}
    const aggregate={lines:{covered:0,total:0},statements:{covered:0,total:0},functions:{covered:0,total:0},branches:{covered:0,total:0}};
    for(const file of files)for(const metric of COVERAGE_METRICS){aggregate[metric].covered+=file.metrics[metric].covered;aggregate[metric].total+=file.metrics[metric].total;}
    evaluateMetrics(null,{metrics:aggregate},scope,rule.minimums,null,checks);
  }
  const failCount=checks.filter(check=>check.status==="FAIL").length;return{checks,summary:{pass:checks.length-failCount,fail:failCount},technicalStatus:"PASS",overallStatus:failCount>0?"FAIL":"PASS"};
}

/** @param {ReturnType<typeof inspectCoverageRegression>} report */
export function formatCoverageAudit(report){const lines=["Coverage regression audit",""];for(const check of report.checks)lines.push(`${check.status.padEnd(4)}  ${check.id}  ${check.scope}  ${check.metric}  ${check.detail}`);lines.push("",`Checks: ${report.summary.pass} pass, ${report.summary.fail} fail`,`Technical: ${report.technicalStatus}`,`Overall: ${report.overallStatus}`);return lines.join("\n");}
/** @param {string} file */
function read(file){try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return null;}}
/** @param {string[]} argv */
function parse(argv){let evidenceFile=null,policyFile=null,json=false;for(let i=0;i<argv.length;i+=1){const arg=argv[i];if(arg==="--json"){json=true;continue;}if(arg!=="--evidence-file"&&arg!=="--policy")return null;const v=argv[i+1];if(typeof v!=="string"||v.startsWith("--"))return null;i+=1;if(arg==="--evidence-file"){if(evidenceFile)return null;evidenceFile=v;}else{if(policyFile)return null;policyFile=v;}}return evidenceFile&&policyFile?{evidenceFile,policyFile,json}:null;}
export function main(argv=process.argv.slice(2)){const options=parse(argv);if(!options){console.error("Usage: node scripts/audit-coverage-regression.js --evidence-file <coverage-comparison.json> --policy <coverage-policy.json> [--json]");return 1;}const rawEvidence=read(options.evidenceFile),rawPolicy=read(options.policyFile);if(!rawEvidence){console.error("Coverage comparison evidence cannot be read or parsed");return 1;}if(!rawPolicy){console.error("Coverage policy cannot be read or parsed");return 1;}const evidenceResult=validateCoverageComparisonEvidence(rawEvidence),policyResult=validateCoveragePolicy(rawPolicy);if(!evidenceResult.valid||!evidenceResult.evidence){console.error("Coverage comparison evidence is invalid");return 1;}if(!policyResult.valid||!policyResult.policy){console.error("Coverage policy is invalid");return 1;}const report=inspectCoverageRegression(policyResult.policy,evidenceResult.evidence);console.log(options.json?JSON.stringify(report):formatCoverageAudit(report));return report.overallStatus==="FAIL"?1:0;}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();
