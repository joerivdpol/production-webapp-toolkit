#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CHANGE_SURFACES, validateChangeSurfaceEvidence } from "./change-surface-evidence.js";

const FLAG_NAMES = new Set(["environmentChanged", "majorDependencyUpgrade"]);

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {unknown} value */
function text(value){return typeof value==="string"&&value.trim()?value.trim():null;}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${key}"`});}
/** @param {unknown} value */
function id(value){const v=text(value);return v&&/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(v)?v:null;}
/** @param {unknown} value */
function idList(value){if(!Array.isArray(value)||value.length===0)return null;const items=value.map(id);return items.every(Boolean)&&new Set(items).size===items.length?/** @type {string[]} */(items).sort():null;}
/** @param {unknown} value */
function surfaceList(value){return Array.isArray(value)&&value.length>0&&value.every(x=>typeof x==="string"&&CHANGE_SURFACES.includes(x))&&new Set(value).size===value.length?[...value].sort():null;}
/** @param {unknown} value */
function flagList(value){return Array.isArray(value)&&value.length>0&&value.every(x=>typeof x==="string"&&FLAG_NAMES.has(x))&&new Set(value).size===value.length?[...value].sort():null;}

/** @param {unknown} value */
export function validateTestSelectionPolicy(value){
  /** @type {Array<{id:string,detail:string}>} */ const errors=[];
  if(!object(value))return{valid:false,policy:null,errors:[{id:"policy-invalid",detail:"test selection policy must be an object"}]};
  unknown(value,["version","tests","rules"],"policy",errors);if(value.version!==1)errors.push({id:"version-invalid",detail:"version must be exactly 1"});
  const tests=[];const seenTests=new Set();
  if(!Array.isArray(value.tests)||value.tests.length===0)errors.push({id:"tests-invalid",detail:"tests must be a non-empty array"});else for(const [index,raw] of value.tests.entries()){
    if(!object(raw)){errors.push({id:"test-invalid",detail:`tests[${index}] must be an object`});continue;}unknown(raw,["id","command","blocking"],"test",errors);const testId=id(raw.id),command=text(raw.command);if(!testId||!command||typeof raw.blocking!=="boolean"){errors.push({id:"test-fields-invalid",detail:`tests[${index}] requires id, command, and blocking boolean`});continue;}if(command.length>512||/[\r\n\0]/.test(command)){errors.push({id:"test-command-invalid",detail:`tests[${index}].command must be a bounded single line string`});continue;}if(seenTests.has(testId)){errors.push({id:"test-id-duplicate",detail:`test ${testId} is configured more than once`});continue;}seenTests.add(testId);tests.push({id:testId,command,blocking:raw.blocking});
  }
  if(tests.length>0&&!tests.some(x=>x.blocking))errors.push({id:"blocking-test-missing",detail:"policy must declare at least one blocking test"});
  const rules=[];const seenRules=new Set();
  if(!Array.isArray(value.rules))errors.push({id:"rules-invalid",detail:"rules must be an array"});else for(const [index,raw] of value.rules.entries()){
    if(!object(raw)){errors.push({id:"rule-invalid",detail:`rules[${index}] must be an object`});continue;}unknown(raw,["id","surfaces","flags","tests"],"rule",errors);const ruleId=id(raw.id),selectedTests=idList(raw.tests);const surfaces=raw.surfaces===undefined?[]:surfaceList(raw.surfaces),flags=raw.flags===undefined?[]:flagList(raw.flags);if(!ruleId||!selectedTests||surfaces===null||flags===null||(surfaces.length===0&&flags.length===0)){errors.push({id:"rule-fields-invalid",detail:`rules[${index}] requires id, tests, and at least one valid surface or flag condition`});continue;}if(seenRules.has(ruleId)){errors.push({id:"rule-id-duplicate",detail:`rule ${ruleId} is configured more than once`});continue;}const missing=selectedTests.filter(testId=>!seenTests.has(testId));if(missing.length){errors.push({id:"rule-test-unknown",detail:`rule ${ruleId} references unknown tests: ${missing.join(", ")}`});continue;}seenRules.add(ruleId);rules.push({id:ruleId,surfaces,flags,tests:selectedTests});
  }
  if(errors.length)return{valid:false,policy:null,errors};return{valid:true,policy:{version:1,tests:tests.sort((a,b)=>a.id.localeCompare(b.id)),rules:rules.sort((a,b)=>a.id.localeCompare(b.id))},errors:[]};
}

/** @param {any} evidence @param {any} policy */
export function selectTests(evidence,policy){
  const reasons=new Map();
  for(const test of policy.tests)if(test.blocking)reasons.set(test.id,new Set(["required-blocking"]));
  for(const rule of policy.rules){const surfaceMatch=rule.surfaces.length===0||rule.surfaces.some((/** @type {string} */ s)=>evidence.surfaces.includes(s));const flagMatch=rule.flags.length===0||rule.flags.every((/** @type {string} */ f)=>evidence.flags[f]===true);if(!surfaceMatch||!flagMatch)continue;for(const testId of rule.tests){const set=reasons.get(testId)??new Set();set.add(`rule:${rule.id}`);reasons.set(testId,set);}}
  const selected=policy.tests.filter((/** @type {any} */ test)=>reasons.has(test.id)).map((/** @type {any} */ test)=>({...test,reasons:[...reasons.get(test.id)].sort()}));
  const unselected=policy.tests.filter((/** @type {any} */ test)=>!reasons.has(test.id)).map((/** @type {any} */ test)=>test.id);
  return{source:evidence.source,surfaces:evidence.surfaces,flags:evidence.flags,selected,unselected,summary:{selected:selected.length,blocking:selected.filter((/** @type {any} */ t)=>t.blocking).length,unselected:unselected.length},technicalStatus:"PASS",overallStatus:"PASS"};
}
/** @param {ReturnType<typeof selectTests>} report */
export function formatTestSelection(report){const lines=["Policy-driven test selection","",`Surfaces: ${report.surfaces.join(", ")||"(none)"}`,`Selected: ${report.summary.selected}`,`Blocking selected: ${report.summary.blocking}`,""];for(const test of report.selected)lines.push(`${test.blocking?"BLOCK":"ADVISORY"}  ${test.id}  ${test.command}  ${test.reasons.join(",")}`);lines.push("",`Unselected: ${report.unselected.join(", ")||"(none)"}`,"Technical: PASS","Overall: PASS");return lines.join("\n");}
/** @param {string} file */
function read(file){try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return null;}}
/** @param {string[]} argv */
function parse(argv){let evidenceFile=null,policyFile=null,json=false;for(let i=0;i<argv.length;i+=1){const arg=argv[i];if(arg==="--json"){json=true;continue;}if(arg!=="--evidence-file"&&arg!=="--policy")return null;const v=argv[i+1];if(typeof v!=="string"||v.startsWith("--"))return null;i+=1;if(arg==="--evidence-file"){if(evidenceFile)return null;evidenceFile=v;}else{if(policyFile)return null;policyFile=v;}}return evidenceFile&&policyFile?{evidenceFile,policyFile,json}:null;}
export function main(argv=process.argv.slice(2)){const options=parse(argv);if(!options){console.error("Usage: node scripts/select-tests.js --evidence-file <change-evidence.json> --policy <policy.json> [--json]");return 1;}const rawEvidence=read(options.evidenceFile),rawPolicy=read(options.policyFile);if(!rawEvidence||!rawPolicy){console.error("Test selection input cannot be read or parsed");return 1;}const evidence=validateChangeSurfaceEvidence(rawEvidence),policy=validateTestSelectionPolicy(rawPolicy);if(!evidence.valid||!evidence.evidence||!policy.valid||!policy.policy){console.error("Test selection input is invalid");return 1;}const report=selectTests(evidence.evidence,policy.policy);console.log(options.json?JSON.stringify(report):formatTestSelection(report));return 0;}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();
