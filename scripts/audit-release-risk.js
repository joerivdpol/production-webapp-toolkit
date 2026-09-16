#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { CHANGE_SURFACES, validateChangeSurfaceEvidence } from "./change-surface-evidence.js";

const LEVELS={LOW:0,MEDIUM:1,HIGH:2};
/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value === "object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${key}"`});}
/** @param {unknown} value @returns {"LOW"|"MEDIUM"|"HIGH"|null} */
function level(value){return typeof value==="string"&&value in LEVELS?/** @type {"LOW"|"MEDIUM"|"HIGH"} */(value):null;}
/** @param {unknown} value */
function surfaces(value){return Array.isArray(value)&&value.every(x=>typeof x==="string"&&CHANGE_SURFACES.includes(x))&&new Set(value).size===value.length?[...value].sort():null;}

/** @param {unknown} value */
export function validateReleaseRiskPolicy(value){
  /** @type {Array<{id:string,detail:string}>} */
  const errors=[];if(!object(value))return{valid:false,policy:null,errors:[{id:"policy-invalid",detail:"policy must be an object"}]};unknown(value,["version","surfaceLevels","largeDiff","majorDependencyUpgrade","environmentChange","missingTests"],"policy",errors);if(value.version!==1)errors.push({id:"version-invalid",detail:"version must be exactly 1"});
  let surfaceLevels=null;if(!object(value.surfaceLevels))errors.push({id:"surface-levels-invalid",detail:"surfaceLevels must be an object"});else{unknown(value.surfaceLevels,["high","medium"],"surface-levels",errors);const high=surfaces(value.surfaceLevels.high),medium=surfaces(value.surfaceLevels.medium);if(!high||!medium||high.some(x=>medium.includes(x)))errors.push({id:"surface-levels-fields-invalid",detail:"high and medium surfaces must be unique supported non-overlapping arrays"});else surfaceLevels={high,medium};}
  let largeDiff=null;if(!object(value.largeDiff))errors.push({id:"large-diff-invalid",detail:"largeDiff must be an object"});else{unknown(value.largeDiff,["filesChanged","totalLines","level"],"large-diff",errors);const files=typeof value.largeDiff.filesChanged === "number" ? value.largeDiff.filesChanged : NaN,lines=typeof value.largeDiff.totalLines === "number" ? value.largeDiff.totalLines : NaN,lvl=level(value.largeDiff.level);if(!Number.isSafeInteger(files)||files<1||!Number.isSafeInteger(lines)||lines<1||!lvl||lvl==="LOW")errors.push({id:"large-diff-fields-invalid",detail:"largeDiff thresholds must be positive integers and level MEDIUM or HIGH"});else largeDiff={filesChanged:files,totalLines:lines,level:lvl};}
  const major=level(value.majorDependencyUpgrade),environment=level(value.environmentChange);if(!major||!environment)errors.push({id:"flag-level-invalid",detail:"majorDependencyUpgrade and environmentChange must be LOW, MEDIUM, or HIGH"});
  let missingTests=null;if(!object(value.missingTests))errors.push({id:"missing-tests-invalid",detail:"missingTests must be an object"});else{unknown(value.missingTests,["surfaces","level"],"missing-tests",errors);const scoped=surfaces(value.missingTests.surfaces),lvl=level(value.missingTests.level);if(!scoped||!lvl||lvl==="LOW")errors.push({id:"missing-tests-fields-invalid",detail:"missingTests requires supported surfaces and MEDIUM or HIGH level"});else missingTests={surfaces:scoped,level:lvl};}
  if(errors.length||!surfaceLevels||!largeDiff||!major||!environment||!missingTests)return{valid:false,policy:null,errors};return{valid:true,policy:{version:1,surfaceLevels,largeDiff,majorDependencyUpgrade:major,environmentChange:environment,missingTests},errors:[]};
}

/** @param {any} evidence @param {any} policy */
export function inspectReleaseRisk(evidence,policy){
  /** @type {Array<{id:string,level:"MEDIUM"|"HIGH",detail:string}>} */
  const drivers=[];
  /** @param {string} id @param {"LOW"|"MEDIUM"|"HIGH"} lvl @param {string} detail */
  const add=(id,lvl,detail)=>{if(lvl!=="LOW")drivers.push({id,level:lvl,detail});};
  for(const surface of evidence.surfaces){if(policy.surfaceLevels.high.includes(surface))add(`surface:${surface}`,"HIGH",`${surface} is explicitly high risk`);else if(policy.surfaceLevels.medium.includes(surface))add(`surface:${surface}`,"MEDIUM",`${surface} is explicitly medium risk`);}
  const totalLines=evidence.metrics.additions+evidence.metrics.deletions;if(evidence.metrics.filesChanged>=policy.largeDiff.filesChanged||totalLines>=policy.largeDiff.totalLines)add("large-diff",policy.largeDiff.level,`diff is ${evidence.metrics.filesChanged} files and ${totalLines} changed lines`);
  if(evidence.flags.majorDependencyUpgrade)add("major-dependency-upgrade",policy.majorDependencyUpgrade,"change declares a major dependency upgrade");if(evidence.flags.environmentChanged)add("environment-change",policy.environmentChange,"change declares environment configuration changes");
  const missingScoped=evidence.surfaces.filter((/** @type {string} */ x)=>policy.missingTests.surfaces.includes(x));if(!evidence.flags.testsChanged&&missingScoped.length)add("missing-tests",policy.missingTests.level,`tests did not change for scoped surfaces: ${missingScoped.join(", ")}`);
  /** @type {"LOW"|"MEDIUM"|"HIGH"} */
  let risk="LOW";for(const driver of drivers)if(LEVELS[driver.level]>LEVELS[risk])risk=driver.level;
  return{source:evidence.source,metrics:evidence.metrics,surfaces:evidence.surfaces,flags:evidence.flags,drivers,risk,technicalStatus:"PASS",overallStatus:"PASS"};
}
/** @param {ReturnType<typeof inspectReleaseRisk>} report */
export function formatReleaseRisk(report){const lines=["Release risk classification","",`Risk: ${report.risk}`,`Files changed: ${report.metrics.filesChanged}`,`Lines changed: ${report.metrics.additions+report.metrics.deletions}`,`Surfaces: ${report.surfaces.join(", ")||"(none)"}`,""];if(!report.drivers.length)lines.push("Drivers: none above LOW policy");else{lines.push("Drivers:");for(const d of report.drivers)lines.push(`  ${d.level}  ${d.id}  ${d.detail}`);}lines.push("","Technical: PASS","Overall: PASS");return lines.join("\n");}
/** @param {string} file */
function read(file){try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return null;}}
/** @param {string[]} argv */
function parse(argv){let evidenceFile=null,policyFile=null,json=false;for(let i=0;i<argv.length;i+=1){const arg=argv[i];if(arg==="--json"){json=true;continue;}if(arg!=="--evidence-file"&&arg!=="--policy")return null;const v=argv[i+1];if(typeof v!=="string"||v.startsWith("--"))return null;i+=1;if(arg==="--evidence-file"){if(evidenceFile)return null;evidenceFile=v;}else{if(policyFile)return null;policyFile=v;}}return evidenceFile&&policyFile?{evidenceFile,policyFile,json}:null;}
export function main(argv=process.argv.slice(2)){const options=parse(argv);if(!options){console.error("Usage: node scripts/audit-release-risk.js --evidence-file <change-evidence.json> --policy <policy.json> [--json]");return 1;}const rawEvidence=read(options.evidenceFile),rawPolicy=read(options.policyFile);if(!rawEvidence||!rawPolicy){console.error("Release risk input cannot be read or parsed");return 1;}const e=validateChangeSurfaceEvidence(rawEvidence),p=validateReleaseRiskPolicy(rawPolicy);if(!e.valid||!e.evidence||!p.valid||!p.policy){console.error("Release risk input is invalid");return 1;}const report=inspectReleaseRisk(e.evidence,p.policy);console.log(options.json?JSON.stringify(report):formatReleaseRisk(report));return 0;}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();
