#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

export const COVERAGE_METRICS = /** @type {const} */ (["lines", "statements", "functions", "branches"]);
const CHANGE_STATUSES = new Set(["ADDED", "MODIFIED", "DELETED", "RENAMED", "COPIED"]);

/** @typedef {{ covered:number,total:number }} CoverageCount */
/** @typedef {{ lines:CoverageCount,statements:CoverageCount,functions:CoverageCount,branches:CoverageCount }} CoverageMetrics */
/** @typedef {{ path:string,metrics:CoverageMetrics }} CoverageFile */
/** @typedef {{ path:string,status:"ADDED"|"MODIFIED"|"DELETED"|"RENAMED"|"COPIED",previousPath?:string }} ChangedFile */
/** @typedef {{ version:1,source:{baseCommit:string,headCommit:string},evidence:{source:string,authenticated:boolean,collectedAt:string},changes:ChangedFile[],baseline:CoverageFile[],candidate:CoverageFile[] }} CoverageComparisonEvidence */

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {unknown} value */
function text(value){return typeof value==="string"&&value.trim()?value.trim():null;}
/** @param {Record<string,unknown>} value @param {readonly string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${key}"`});}
/** @param {unknown} value */
export function safeCoveragePath(value){return typeof value==="string"&&value.length>0&&value.length<=512&&!value.startsWith("/")&&!value.includes("\\")&&!value.includes("\0")&&!value.endsWith("/")&&!value.split("/").includes("..");}

/** @param {unknown} value @param {string} scope @param {Array<{id:string,detail:string}>} errors @returns {CoverageMetrics|null} */
function metrics(value,scope,errors){
  if(!object(value)){errors.push({id:"coverage-metrics-invalid",detail:`${scope} must be an object`});return null;}
  unknown(value,COVERAGE_METRICS,scope,errors);
  /** @type {Record<string,CoverageCount>} */ const out={};
  for(const name of COVERAGE_METRICS){
    const raw=value[name];
    if(!object(raw)){errors.push({id:"coverage-count-invalid",detail:`${scope}.${name} must be an object`});continue;}
    unknown(raw,["covered","total"],`${scope}.${name}`,errors);
    const covered=raw.covered,total=raw.total;
    if(!Number.isSafeInteger(covered)||!Number.isSafeInteger(total)||Number(covered)<0||Number(total)<0||Number(covered)>Number(total)){
      errors.push({id:"coverage-count-invalid",detail:`${scope}.${name} requires non-negative integer covered <= total`});continue;
    }
    out[name]={covered:Number(covered),total:Number(total)};
  }
  return COVERAGE_METRICS.every(name=>out[name]!==undefined)?/** @type {CoverageMetrics} */(out):null;
}

/** @param {unknown} value @param {string} scope @param {Array<{id:string,detail:string}>} errors @returns {CoverageFile[]} */
function coverageFiles(value,scope,errors){
  if(!Array.isArray(value)){errors.push({id:"coverage-files-invalid",detail:`${scope} must be an array`});return [];}
  /** @type {CoverageFile[]} */ const out=[];const seen=new Set();
  for(const [index,raw] of value.entries()){
    if(!object(raw)){errors.push({id:"coverage-file-invalid",detail:`${scope}[${index}] must be an object`});continue;}
    unknown(raw,["path","metrics"],"coverage-file",errors);
    const file=text(raw.path);
    if(!file||!safeCoveragePath(file)){errors.push({id:"coverage-path-invalid",detail:`${scope}[${index}].path is invalid`});continue;}
    if(seen.has(file)){errors.push({id:"coverage-path-duplicate",detail:`${scope} contains duplicate path "${file}"`});continue;}seen.add(file);
    const normalized=metrics(raw.metrics,`${scope}[${index}].metrics`,errors);if(normalized)out.push({path:file,metrics:normalized});
  }
  return out.sort((a,b)=>a.path.localeCompare(b.path));
}

/** @param {unknown} value @param {Array<{id:string,detail:string}>} errors @returns {ChangedFile[]} */
function changes(value,errors){
  if(!Array.isArray(value)){errors.push({id:"changes-invalid",detail:"changes must be an array"});return [];}
  /** @type {ChangedFile[]} */ const out=[];const seen=new Set();
  for(const [index,raw] of value.entries()){
    if(!object(raw)){errors.push({id:"change-invalid",detail:`changes[${index}] must be an object`});continue;}
    unknown(raw,["path","status","previousPath"],"change",errors);
    const file=text(raw.path),status=text(raw.status)?.toUpperCase()??null,previous=text(raw.previousPath);
    if(!file||!safeCoveragePath(file)){errors.push({id:"change-path-invalid",detail:`changes[${index}].path is invalid`});continue;}
    if(seen.has(file)){errors.push({id:"change-path-duplicate",detail:`changes contains duplicate path "${file}"`});continue;}seen.add(file);
    if(!status||!CHANGE_STATUSES.has(status)){errors.push({id:"change-status-invalid",detail:`changes[${index}].status is invalid`});continue;}
    const needsPrevious=status==="RENAMED"||status==="COPIED";
    if(needsPrevious&&(!previous||!safeCoveragePath(previous)||previous===file)){errors.push({id:"change-previous-path-invalid",detail:`changes[${index}] requires a distinct safe previousPath`});continue;}
    if(!needsPrevious&&raw.previousPath!==undefined){errors.push({id:"change-previous-path-invalid",detail:`changes[${index}] must not declare previousPath for ${status}`});continue;}
    out.push({path:file,status:/** @type {ChangedFile["status"]} */(status),...(needsPrevious?{previousPath:/** @type {string} */(previous)}:{})});
  }
  return out.sort((a,b)=>a.path.localeCompare(b.path));
}

/** @param {unknown} value */
export function validateCoverageComparisonEvidence(value){
  /** @type {Array<{id:string,detail:string}>} */ const errors=[];
  if(!object(value))return{valid:false,evidence:null,errors:[{id:"input-invalid",detail:"coverage comparison evidence must be an object"}]};
  unknown(value,["version","source","evidence","changes","baseline","candidate"],"top-level",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"version must be exactly 1"});
  let source=null;
  if(!object(value.source))errors.push({id:"source-invalid",detail:"source must be an object"});else{
    unknown(value.source,["baseCommit","headCommit"],"source",errors);const base=text(value.source.baseCommit),head=text(value.source.headCommit);
    if(!base||!head||!isFullObjectId(base)||!isFullObjectId(head)||base.toLowerCase()===head.toLowerCase())errors.push({id:"source-commit-invalid",detail:"baseCommit and headCommit must be distinct full Git object ids"});else source={baseCommit:base.toLowerCase(),headCommit:head.toLowerCase()};
  }
  let trust=null;
  if(!object(value.evidence))errors.push({id:"evidence-invalid",detail:"evidence must be an object"});else{
    unknown(value.evidence,["source","authenticated","collectedAt"],"evidence",errors);const sourceName=text(value.evidence.source),collectedAt=text(value.evidence.collectedAt);
    if(!sourceName||typeof value.evidence.authenticated!=="boolean"||!collectedAt||!isAbsoluteIsoTimestamp(collectedAt))errors.push({id:"evidence-fields-invalid",detail:"evidence requires source, authenticated, and absolute collectedAt"});else trust={source:sourceName,authenticated:value.evidence.authenticated,collectedAt};
  }
  const normalizedChanges=changes(value.changes,errors),baseline=coverageFiles(value.baseline,"baseline",errors),candidate=coverageFiles(value.candidate,"candidate",errors);
  if(errors.length||!source||!trust)return{valid:false,evidence:null,errors};
  return{valid:true,evidence:/** @type {CoverageComparisonEvidence} */({version:1,source,evidence:trust,changes:normalizedChanges,baseline,candidate}),errors:[]};
}

/** @param {CoverageComparisonEvidence} evidence */
export function formatCoverageComparisonEvidence(evidence){return["Coverage Comparison Evidence v1","",`Base: ${evidence.source.baseCommit}`,`Head: ${evidence.source.headCommit}`,`Changes: ${evidence.changes.length}`,`Baseline files: ${evidence.baseline.length}`,`Candidate files: ${evidence.candidate.length}`,`Source: ${evidence.evidence.source}`,`Authenticated: ${evidence.evidence.authenticated}`,`Collected at: ${evidence.evidence.collectedAt}`,"Result: VALID"].join("\n");}

/** @param {string[]} argv */
function parse(argv){let file=null,json=false;for(let i=0;i<argv.length;i+=1){const arg=argv[i];if(arg==="--json"){json=true;continue;}if(arg!=="--file"||file!==null)return null;const v=argv[i+1];if(typeof v!=="string"||v.startsWith("--"))return null;file=v;i+=1;}return file?{file,json}:null;}
export function main(argv=process.argv.slice(2)){const options=parse(argv);if(!options){console.error("Usage: node scripts/coverage-comparison-evidence.js --file <coverage-comparison.json> [--json]");return 1;}let raw;try{raw=JSON.parse(fs.readFileSync(options.file,"utf8"));}catch{console.error("Coverage comparison evidence file cannot be read or parsed");return 1;}const result=validateCoverageComparisonEvidence(raw);if(!result.valid||!result.evidence){console.error("Coverage comparison evidence is invalid");return 1;}console.log(options.json?JSON.stringify(result.evidence):formatCoverageComparisonEvidence(result.evidence));return 0;}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();
