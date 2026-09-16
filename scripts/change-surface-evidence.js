#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

export const CHANGE_SURFACES = ["frontend","database","auth","payment","deployment","api","infrastructure"];
const SURFACE_SET = new Set(CHANGE_SURFACES);

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value === "object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {unknown} value */
function text(value){return typeof value === "string"&&value.trim()?value.trim():null;}
/** @param {unknown} value */
function integer(value){return Number.isSafeInteger(value)&&Number(value)>=0?Number(value):null;}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${key}"`});}

/** @param {unknown} value */
export function validateChangeSurfaceEvidence(value){
  /** @type {Array<{id:string,detail:string}>} */
  const errors=[];
  if(!object(value))return{valid:false,evidence:null,errors:[{id:"input-invalid",detail:"change surface evidence must be an object"}]};
  unknown(value,["version","source","metrics","surfaces","flags","evidence"],"top-level",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"version must be exactly 1"});
  let source=null;
  if(!object(value.source))errors.push({id:"source-invalid",detail:"source must be an object"});else{unknown(value.source,["baseCommit","headCommit"],"source",errors);const base=text(value.source.baseCommit),head=text(value.source.headCommit);if(!base||!head||!isFullObjectId(base)||!isFullObjectId(head))errors.push({id:"source-commit-invalid",detail:"baseCommit and headCommit must be full Git object ids"});else source={baseCommit:base.toLowerCase(),headCommit:head.toLowerCase()};}
  let metrics=null;
  if(!object(value.metrics))errors.push({id:"metrics-invalid",detail:"metrics must be an object"});else{unknown(value.metrics,["filesChanged","additions","deletions"],"metrics",errors);const filesChanged=integer(value.metrics.filesChanged),additions=integer(value.metrics.additions),deletions=integer(value.metrics.deletions);if(filesChanged===null||additions===null||deletions===null)errors.push({id:"metrics-fields-invalid",detail:"metrics values must be non-negative safe integers"});else metrics={filesChanged,additions,deletions};}
  let surfaces=null;
  if(!Array.isArray(value.surfaces)||value.surfaces.some(x=>typeof x!=="string"||!SURFACE_SET.has(x))||new Set(value.surfaces).size!==value.surfaces.length)errors.push({id:"surfaces-invalid",detail:"surfaces must be a unique array of supported change surfaces"});else surfaces=[...value.surfaces].sort();
  let flags=null;
  if(!object(value.flags))errors.push({id:"flags-invalid",detail:"flags must be an object"});else{unknown(value.flags,["testsChanged","environmentChanged","majorDependencyUpgrade"],"flags",errors);if(typeof value.flags.testsChanged!=="boolean"||typeof value.flags.environmentChanged!=="boolean"||typeof value.flags.majorDependencyUpgrade!=="boolean")errors.push({id:"flags-fields-invalid",detail:"all flags must be booleans"});else flags={testsChanged:value.flags.testsChanged,environmentChanged:value.flags.environmentChanged,majorDependencyUpgrade:value.flags.majorDependencyUpgrade};}
  let trust=null;
  if(!object(value.evidence))errors.push({id:"evidence-invalid",detail:"evidence must be an object"});else{unknown(value.evidence,["source","authenticated","collectedAt"],"evidence",errors);const sourceName=text(value.evidence.source),collectedAt=text(value.evidence.collectedAt);if(!sourceName||typeof value.evidence.authenticated!=="boolean"||!collectedAt||!isAbsoluteIsoTimestamp(collectedAt))errors.push({id:"evidence-fields-invalid",detail:"evidence requires source, authenticated, and absolute collectedAt"});else trust={source:sourceName,authenticated:value.evidence.authenticated,collectedAt};}
  if(errors.length||!source||!metrics||!surfaces||!flags||!trust)return{valid:false,evidence:null,errors};
  return{valid:true,evidence:{version:1,source,metrics,surfaces,flags,evidence:trust},errors:[]};
}

/** @param {any} evidence */
export function formatChangeSurfaceEvidence(evidence){return["Change Surface Evidence v1","",`Base: ${evidence.source.baseCommit}`,`Head: ${evidence.source.headCommit}`,`Files changed: ${evidence.metrics.filesChanged}`,`Lines changed: ${evidence.metrics.additions+evidence.metrics.deletions}`,`Surfaces: ${evidence.surfaces.join(", ")||"(none)"}`,`Tests changed: ${evidence.flags.testsChanged}`,"Result: VALID"].join("\n");}

/** @param {string[]} argv */
function parse(argv){let file=null,json=false;for(let i=0;i<argv.length;i+=1){const arg=argv[i];if(arg==="--json"){json=true;continue;}if(arg!=="--file"||file)return null;const v=argv[i+1];if(typeof v!=="string"||v.startsWith("--"))return null;file=v;i+=1;}return file?{file,json}:null;}
export function main(argv=process.argv.slice(2)){const options=parse(argv);if(!options){console.error("Usage: node scripts/change-surface-evidence.js --file <evidence.json> [--json]");return 1;}let raw;try{raw=JSON.parse(fs.readFileSync(options.file,"utf8"));}catch{console.error("Change surface evidence file cannot be read or parsed");return 1;}const result=validateChangeSurfaceEvidence(raw);if(!result.valid||!result.evidence){console.error("Change surface evidence is invalid");return 1;}console.log(options.json?JSON.stringify(result.evidence):formatChangeSurfaceEvidence(result.evidence));return 0;}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();
