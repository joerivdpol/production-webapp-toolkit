#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { CHANGE_SURFACES, validateChangeSurfaceEvidence } from "./change-surface-evidence.js";
import { isAbsoluteIsoTimestamp, isFullObjectId } from "./runtime-evidence.js";

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${key}"`});}
/** @param {unknown} value */
function safePattern(value){return typeof value==="string"&&value.length>0&&value.length<=256&&!value.startsWith("/")&&!value.includes("\\")&&!value.includes("\0")&&!value.split("/").includes("..");}
/** @param {unknown} value */
function safeRelativeFile(value){return safePattern(value)&&typeof value==="string"&&!/[?*[\]{}:]/.test(value)&&!value.endsWith("/");}
/** @param {unknown} value */
function patternList(value){return Array.isArray(value)&&value.length>0&&value.every(safePattern)&&new Set(value).size===value.length?[...value].sort():null;}

/** @param {unknown} value */
export function validateChangedSurfacePolicy(value){
  /** @type {Array<{id:string,detail:string}>} */ const errors=[];
  if(!object(value))return{valid:false,policy:null,errors:[{id:"policy-invalid",detail:"changed surface policy must be an object"}]};
  unknown(value,["version","surfaceRules","testPaths","environmentPaths","majorDependencies"],"policy",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"version must be exactly 1"});
  const rules=[];const seen=new Set();
  if(!Array.isArray(value.surfaceRules)||value.surfaceRules.length===0)errors.push({id:"surface-rules-invalid",detail:"surfaceRules must be a non-empty array"});
  else for(const [index,raw] of value.surfaceRules.entries()){
    if(!object(raw)){errors.push({id:"surface-rule-invalid",detail:`surfaceRules[${index}] must be an object`});continue;}
    unknown(raw,["surface","paths"],"surface-rule",errors);const surface=typeof raw.surface==="string"?raw.surface:null,paths=patternList(raw.paths);
    if(!surface||!CHANGE_SURFACES.includes(surface)||!paths){errors.push({id:"surface-rule-fields-invalid",detail:`surfaceRules[${index}] has invalid surface or paths`});continue;}
    if(seen.has(surface)){errors.push({id:"surface-rule-duplicate",detail:`surface ${surface} is configured more than once`});continue;}seen.add(surface);rules.push({surface,paths});
  }
  const testPaths=patternList(value.testPaths),environmentPaths=patternList(value.environmentPaths);if(!testPaths)errors.push({id:"test-paths-invalid",detail:"testPaths must be a non-empty unique pattern array"});if(!environmentPaths)errors.push({id:"environment-paths-invalid",detail:"environmentPaths must be a non-empty unique pattern array"});
  let majorDependencies=null;
  if(!object(value.majorDependencies))errors.push({id:"major-dependencies-invalid",detail:"majorDependencies must be an object"});else{
    unknown(value.majorDependencies,["mode","paths"],"major-dependencies",errors);const mode=value.majorDependencies.mode;
    if(mode==="disabled"){if("paths" in value.majorDependencies)errors.push({id:"major-dependencies-paths-invalid",detail:"disabled major dependency analysis must not declare paths"});else majorDependencies={mode:"disabled",paths:[]};}
    else if(mode==="npm-package-json"){
      const paths=value.majorDependencies.paths;if(!Array.isArray(paths)||paths.length===0||paths.some(x=>!safeRelativeFile(x))||new Set(paths).size!==paths.length)errors.push({id:"major-dependencies-paths-invalid",detail:"npm-package-json mode requires unique safe package.json paths"});else majorDependencies={mode,paths:[...paths].sort()};
    }else errors.push({id:"major-dependencies-mode-invalid",detail:"majorDependencies.mode must be disabled or npm-package-json"});
  }
  if(errors.length||!testPaths||!environmentPaths||!majorDependencies)return{valid:false,policy:null,errors};return{valid:true,policy:{version:1,surfaceRules:rules.sort((a,b)=>a.surface.localeCompare(b.surface)),testPaths,environmentPaths,majorDependencies},errors:[]};
}

/** @param {string} pattern */
export function globToRegExp(pattern){let out="^";for(let i=0;i<pattern.length;i+=1){const c=pattern[i];if(c===undefined)break;if(c==="*"){if(pattern[i+1]==="*"){out+=".*";i+=1;}else out+="[^/]*";}else if(c==="?")out+="[^/]";else out+=/[\\^$.*+?()[\]{}|]/.test(c)?`\\${c}`:c;}return new RegExp(`${out}$`);}
/** @param {string} file @param {string[]} patterns */
function matches(file,patterns){return patterns.some(pattern=>globToRegExp(pattern).test(file));}
/** @param {string} root @param {string[]} args */
function git(root,args){const result=spawnSync("git",args,{cwd:root,encoding:"utf8",maxBuffer:8*1024*1024});if(result.status!==0)throw new Error("read-only Git inspection failed");return result.stdout;}
/** @param {string} root @param {string} commit */
function requireCommit(root,commit){git(root,["cat-file","-e",`${commit}^{commit}`]);}
/** @param {string} root @param {string} base @param {string} head */
function diffPaths(root,base,head){return git(root,["diff","--name-only","-z","--no-renames",base,head,"--"]).split("\0").filter(Boolean);}
/** @param {string} root @param {string} base @param {string} head */
function diffMetrics(root,base,head){const records=git(root,["diff","--numstat","-z","--no-renames",base,head,"--"]).split("\0").filter(Boolean);let additions=0,deletions=0;for(const record of records){const first=record.indexOf("\t"),second=record.indexOf("\t",first+1);if(first<0||second<0)throw new Error("Git numstat output is malformed");const a=record.slice(0,first),d=record.slice(first+1,second);if(a!=="-"&&d!=="-"){const av=Number(a),dv=Number(d);if(!Number.isSafeInteger(av)||!Number.isSafeInteger(dv)||av<0||dv<0)throw new Error("Git numstat output is malformed");additions+=av;deletions+=dv;}}return{additions,deletions};}
/** @param {string} root @param {string} commit @param {string} file */
function fileAtCommit(root,commit,file){return git(root,["show",`${commit}:${file}`]);}
/** @param {unknown} value */
function semverMajor(value){if(typeof value!=="string")return null;const m=/^[~^]?v?(\d+)(?:\.\d+){0,2}(?:-[0-9A-Za-z.-]+)?$/.exec(value.trim());return m?Number(m[1]):null;}
/** @param {string} text */
function dependencyMap(text){let pkg;try{pkg=JSON.parse(text);}catch{throw new Error("package.json evidence cannot be parsed");}if(!object(pkg))throw new Error("package.json evidence must be an object");const out=new Map();for(const field of ["dependencies","devDependencies","optionalDependencies","peerDependencies"]){const group=pkg[field];if(group===undefined)continue;if(!object(group))throw new Error(`package.json ${field} must be an object`);for(const [name,spec] of Object.entries(group)){if(typeof spec!=="string")throw new Error("dependency spec must be a string");out.set(name,spec);}}return out;}
/** @param {string} root @param {string} base @param {string} head @param {{mode:string,paths:string[]}} config */
function majorUpgrade(root,base,head,config){if(config.mode==="disabled")return false;for(const file of config.paths){const before=dependencyMap(fileAtCommit(root,base,file)),after=dependencyMap(fileAtCommit(root,head,file));for(const [name,newSpec] of after){const oldSpec=before.get(name);if(oldSpec===undefined||oldSpec===newSpec)continue;const oldMajor=semverMajor(oldSpec),newMajor=semverMajor(newSpec);if(oldMajor===null||newMajor===null)throw new Error(`changed dependency ${name} uses an unsupported version expression`);if(newMajor>oldMajor)return true;}}return false;}

/** @param {string} root @param {{baseCommit:string,headCommit:string,collectedAt:string,policy:any}} options */
export function analyzeChangedSurface(root,options){const base=options.baseCommit.toLowerCase(),head=options.headCommit.toLowerCase();if(!isFullObjectId(base)||!isFullObjectId(head))throw new Error("base and head commits must be full Git object ids");if(!isAbsoluteIsoTimestamp(options.collectedAt))throw new Error("collectedAt must be an absolute ISO timestamp");requireCommit(root,base);requireCommit(root,head);const files=diffPaths(root,base,head),metrics=diffMetrics(root,base,head);const detected=[];for(const rule of options.policy.surfaceRules)if(files.some(file=>matches(file,rule.paths)))detected.push(rule.surface);const raw={version:1,source:{baseCommit:base,headCommit:head},metrics:{filesChanged:new Set(files).size,...metrics},surfaces:[...new Set(detected)].sort(),flags:{testsChanged:files.some(file=>matches(file,options.policy.testPaths)),environmentChanged:files.some(file=>matches(file,options.policy.environmentPaths)),majorDependencyUpgrade:majorUpgrade(root,base,head,options.policy.majorDependencies)},evidence:{source:"local-git-diff",authenticated:false,collectedAt:options.collectedAt}};const validated=validateChangeSurfaceEvidence(raw);if(!validated.valid||!validated.evidence)throw new Error("generated change surface evidence is invalid");return validated.evidence;}

/** @param {string} file */
function read(file){try{return JSON.parse(fs.readFileSync(file,"utf8"));}catch{return null;}}
/** @param {string[]} argv */
function parse(argv){let root=null,baseCommit=null,headCommit=null,collectedAt=null,policyFile=null,json=false;for(let i=0;i<argv.length;i+=1){const arg=argv[i];if(arg==="--json"){json=true;continue;}if(!["--root","--base-commit","--head-commit","--collected-at","--policy"].includes(arg??""))return null;const v=argv[i+1];if(typeof v!=="string"||v.startsWith("--"))return null;i+=1;if(arg==="--root"){if(root)return null;root=v;}else if(arg==="--base-commit"){if(baseCommit)return null;baseCommit=v;}else if(arg==="--head-commit"){if(headCommit)return null;headCommit=v;}else if(arg==="--collected-at"){if(collectedAt)return null;collectedAt=v;}else{if(policyFile)return null;policyFile=v;}}return root&&baseCommit&&headCommit&&collectedAt&&policyFile?{root,baseCommit,headCommit,collectedAt,policyFile,json}:null;}
export function main(argv=process.argv.slice(2)){const options=parse(argv);if(!options){console.error("Usage: node scripts/analyze-changed-surface.js --root <repo> --base-commit <sha> --head-commit <sha> --collected-at <ISO> --policy <policy.json> [--json]");return 1;}const rawPolicy=read(options.policyFile);if(!rawPolicy){console.error("Changed surface policy cannot be read or parsed");return 1;}const policy=validateChangedSurfacePolicy(rawPolicy);if(!policy.valid||!policy.policy){console.error("Changed surface policy is invalid");return 1;}try{const evidence=analyzeChangedSurface(path.resolve(options.root),{baseCommit:options.baseCommit,headCommit:options.headCommit,collectedAt:options.collectedAt,policy:policy.policy});console.log(options.json?JSON.stringify(evidence):JSON.stringify(evidence,null,2));return 0;}catch(error){console.error(error instanceof Error?error.message:"Changed surface analysis failed");return 1;}}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();
