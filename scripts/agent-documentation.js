#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { globToRegExp } from "./analyze-changed-surface.js";
import { validateAgentTask } from "./agent-task.js";
import { validateAgentRolePolicy, inspectAgentTaskRolePolicy } from "./agent-role-policy.js";
import { openAgentTaskRegistry, getAgentTask } from "./agent-task-registry.js";
import { expireAgentWorkerLeases, getAgentWorkerLease } from "./agent-worker-lease.js";
import { readAgentModelConfigFile, validateAgentModelRequest, invokeAgentLocalModel } from "./agent-local-model.js";
import { validateAgentRepairInput, validateAgentRepairProposal, inspectAgentRepairWorktree, verifyAgentWorktreeContext, getAgentWorktreeChangedPaths } from "./agent-repair.js";
import { isAbsoluteIsoTimestamp } from "./runtime-evidence.js";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;
const DOC_EXTENSIONS=new Set([".md",".mdx",".txt",".rst",".adoc"]);
const APPLY_MODES=new Set(["PROPOSE_ONLY","ALLOW_LOW_RISK_WORKTREE"]);
const MAX_INPUT_BYTES=8*1024*1024;

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {unknown} value @param {number} [max] */
function text(value,max=2048){if(typeof value!=="string")return null;const v=value.trim();return v&&v.length<=max&&!/[\u0000\r\n]/.test(v)?v:null;}
/** @param {unknown} value */
function id(value){const v=text(value,128);return v&&ID.test(v)?v:null;}
/** @param {unknown} value */
function safePattern(value){const v=text(value,512);if(!v||path.isAbsolute(v)||v.includes("\\")||v.split("/").includes(".."))return null;return v;}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function unknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:`${scope}-field-unknown`,detail:`${scope} contains unsupported field "${key}"`});}
/** @param {unknown} value @param {(v:unknown)=>string|null} validate @param {number} max @param {boolean} [allowEmpty] */
function list(value,validate,max,allowEmpty=false){if(!Array.isArray(value)||value.length>max||(!allowEmpty&&value.length===0))return null;const out=value.map(validate);if(out.some((v)=>v===null)||new Set(out).size!==out.length)return null;return /** @type {string[]} */(out).sort();}
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value,min,max){return typeof value==="number"&&Number.isSafeInteger(value)&&value>=min&&value<=max?value:null;}
/** @param {string} value */
function sha256(value){return crypto.createHash("sha256").update(value).digest("hex");}
/** @param {string} file @param {string[]} patterns */
function matches(file,patterns){return patterns.some((pattern)=>globToRegExp(pattern).test(file));}
/** @param {unknown} value */
export function validateAgentDocumentationPolicy(value){
  /** @type {Array<{id:string,detail:string}>} */const errors=[];
  if(!object(value))return{valid:false,policy:null,errors:[{id:"policy-invalid",detail:"documentation policy must be an object"}]};
  unknown(value,["version","repository","allowedPathPatterns","humanReviewPathPatterns","applyMode","maxFiles","maxFileBytes","maxTotalBytes","requiredChecks"],"policy",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"documentation policy version must be exactly 1"});
  const repository=id(value.repository);if(!repository)errors.push({id:"repository-invalid",detail:"repository must be a portable id"});
  const allowedPathPatterns=list(value.allowedPathPatterns,safePattern,64),humanReviewPathPatterns=list(value.humanReviewPathPatterns,safePattern,64);
  const applyMode=text(value.applyMode,64),maxFiles=integer(value.maxFiles,1,32),maxFileBytes=integer(value.maxFileBytes,64,512*1024),maxTotalBytes=integer(value.maxTotalBytes,64,2*1024*1024),requiredChecks=list(value.requiredChecks,id,64);
  if(!allowedPathPatterns||!humanReviewPathPatterns||!applyMode||!APPLY_MODES.has(applyMode)||!maxFiles||!maxFileBytes||!maxTotalBytes||maxFileBytes>maxTotalBytes||!requiredChecks)errors.push({id:"policy-fields-invalid",detail:"documentation policy contains invalid bounded fields"});
  if(errors.length>0||!repository||!allowedPathPatterns||!humanReviewPathPatterns||!applyMode||!maxFiles||!maxFileBytes||!maxTotalBytes||!requiredChecks)return{valid:false,policy:null,errors};
  return{valid:true,policy:{version:1,repository,allowedPathPatterns,humanReviewPathPatterns,applyMode,maxFiles,maxFileBytes,maxTotalBytes,requiredChecks},errors:[]};
}

/** @param {unknown} value */
export function validateAgentDocumentationInput(value){const result=validateAgentRepairInput(value);if(!result.valid||!result.input)return{valid:false,input:null,errors:result.errors};return{valid:true,input:result.input,errors:[]};}

/** @param {string} file */
export function documentationPathRequiresHumanReview(file){
  const normalized=file.toLowerCase(),segments=normalized.split("/"),base=path.posix.basename(normalized);
  if(base==="agents.md"||base==="codeowners")return true;
  if(segments.includes(".github")||segments.includes("policy")||segments.includes("policies")||segments.includes("governance"))return true;
  if(base.includes("policy")||base==="security.md")return true;
  return false;
}
/** @param {unknown} value @param {any} task @param {any} policy @param {any} input */
export function validateAgentDocumentationProposal(value,task,policy,input){
  const repairPolicy={version:1,repository:policy.repository,allowedPathPatterns:policy.allowedPathPatterns,deniedPathPatterns:[],allowedOperations:["MODIFY","CREATE"],applyMode:"PROPOSE_ONLY",maxFiles:policy.maxFiles,maxFileBytes:policy.maxFileBytes,maxTotalBytes:policy.maxTotalBytes,requiredChecks:policy.requiredChecks};
  const base=validateAgentRepairProposal(value,task,repairPolicy,input);if(!base.valid||!base.proposal)return{valid:false,proposal:null,errors:base.errors};
  /** @type {Array<{id:string,detail:string}>} */const errors=[];const files=[];
  for(const file of base.proposal.files){const extension=path.posix.extname(file.path).toLowerCase();if(!DOC_EXTENSIONS.has(extension)){errors.push({id:"document-extension-invalid",detail:`documentation path is not an allowed text-document type: ${file.path}`});continue;}const humanReviewRequired=documentationPathRequiresHumanReview(file.path)||matches(file.path,policy.humanReviewPathPatterns);files.push({...file,humanReviewRequired});}
  if(errors.length>0)return{valid:false,proposal:null,errors};
  const humanReviewRequired=files.some((file)=>file.humanReviewRequired);
  return{valid:true,proposal:{...base.proposal,files,humanReviewRequired,status:humanReviewRequired?"HUMAN_REVIEW_REQUIRED":"PROPOSAL_READY"},errors:[]};
}

/** @param {any} task @param {any} policy @param {any} input */
function validateDocumentationBindings(task,policy,input){
  if(task.role!=="docs")throw new Error("Documentation Agent v1 requires task role docs");
  if(task.authority.filesystem!=="WORKTREE_WRITE"||task.authority.shell!=="NONE"||task.authority.network!=="NONE")throw new Error("Documentation Agent v1 requires WORKTREE_WRITE with shell NONE and network NONE");
  if(policy.repository!==task.repository.id||input.repository.id!==task.repository.id||input.repository.commit!==task.repository.baseCommit||input.taskId!==task.id)throw new Error("documentation policy/input do not match exact Agent Task repository identity");
  if(input.sourceTaskIds.some((/** @type {string} */ sourceTaskId)=>!task.dependsOn.includes(sourceTaskId)))throw new Error("documentation input sourceTaskIds must all be explicit Agent Task dependencies");
  for(const check of policy.requiredChecks)if(!task.scope.requiredChecks.includes(check))throw new Error(`documentation task is missing policy-required check ${check}`);
}
/** @param {any} task @param {any} policy @param {any} input */
function buildDocumentationPrompt(task,policy,input){
  const payload={task:{id:task.id,objective:task.objective,repository:task.repository,risk:task.risk,requiredChecks:task.scope.requiredChecks},evidence:input.evidence,contextFiles:input.contextFiles,unknowns:input.unknowns,documentationPolicy:{allowedPathPatterns:policy.allowedPathPatterns,humanReviewPathPatterns:policy.humanReviewPathPatterns,maxFiles:policy.maxFiles,maxFileBytes:policy.maxFileBytes,maxTotalBytes:policy.maxTotalBytes,requiredChecks:policy.requiredChecks}};
  const system=[
    "You are a bounded documentation-maintenance agent operating against an exact isolated worktree snapshot.",
    "Return JSON only. Use only supplied evidence and contextFiles; do not invent commands, architecture, business rules, release facts, or runtime truth.",
    "Propose MODIFY or CREATE document changes only. Never delete or rename files and never weaken tests or policy to make checks pass.",
    "AGENTS, governance, policy, security, CODEOWNERS, and .github changes may be proposed but are always human-review-only and cannot be auto-applied.",
    "For MODIFY, beforeSha256 must equal the supplied context SHA256. CREATE requires beforeSha256 null.",
    "Schema: {version:1,taskId:string,evidenceIds:string[],rationale:string,files:[{path:string,operation:'MODIFY'|'CREATE',beforeSha256:string|null,content:string}]}"
  ].join(" ");
  return{system,user:JSON.stringify(payload)};
}

/** @param {any} task @param {any} rolePolicy @param {any} policy @param {any} input @param {string} worktree @param {any} modelConfig @param {string} backend @param {string} model @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function proposeAgentDocumentation(task,rolePolicy,policy,input,worktree,modelConfig,backend,model,deps={}){
  validateDocumentationBindings(task,policy,input);const roleAudit=inspectAgentTaskRolePolicy(task,rolePolicy);if(roleAudit.overallStatus!=="PASS"||!roleAudit.leaseRequired)throw new Error("documentation task is not authorized by Agent Role Policy v1");
  const state=inspectAgentRepairWorktree(worktree,task.repository.baseCommit,true);verifyAgentWorktreeContext(state.root,input);
  const prompt=buildDocumentationPrompt(task,policy,input),request=validateAgentModelRequest({version:1,backend,model,messages:[{role:"system",content:prompt.system},{role:"user",content:prompt.user}],temperature:0,maxOutputTokens:8192,timeoutMs:60000});if(!request.valid||!request.request)throw new Error("documentation model request is invalid");
  const response=await(deps.invoke??invokeAgentLocalModel)(modelConfig,request.request);let raw;try{raw=JSON.parse(response.content);}catch{throw new Error("documentation model returned non-JSON output");}
  const proposal=validateAgentDocumentationProposal(raw,task,policy,input);if(!proposal.valid||!proposal.proposal)throw new Error("documentation model output failed Documentation Proposal v1 validation");
  const applyEligible=policy.applyMode==="ALLOW_LOW_RISK_WORKTREE"&&task.risk==="LOW"&&!proposal.proposal.humanReviewRequired;
  return{version:1,taskId:task.id,status:proposal.proposal.status,repository:task.repository,sourceTaskIds:input.sourceTaskIds,proposal:proposal.proposal,worktreeApplyPolicyEligible:applyEligible,worktreeMutationPerformed:false,checksExecuted:false,executionAuthorized:false,mergeAuthorized:false,deployAuthorized:false,productionMutationAuthorized:false,model:{backend:response.backend,model:response.model},semantics:"documentation proposal over exact supplied evidence/context; governance-sensitive paths remain human-review-only and no source mutation occurred"};
}
/** @param {any} task @param {any} rolePolicy @param {import("node:sqlite").DatabaseSync} db @param {string} leaseId @param {string} workerId @param {string} evaluatedAt */
function requireDocumentationLease(task,rolePolicy,db,leaseId,workerId,evaluatedAt){if(!isAbsoluteIsoTimestamp(evaluatedAt))throw new Error("documentation evaluatedAt must be an absolute ISO timestamp");const roleAudit=inspectAgentTaskRolePolicy(task,rolePolicy);if(roleAudit.overallStatus!=="PASS"||!roleAudit.leaseRequired)throw new Error("documentation task is not authorized for leased worktree writes");expireAgentWorkerLeases(db,evaluatedAt);const lease=getAgentWorkerLease(db,leaseId),registered=getAgentTask(db,task.id);if(!lease||!registered)throw new Error("documentation task or lease is not registered");if(JSON.stringify(registered.task)!==JSON.stringify(task)||registered.state!=="RUNNING")throw new Error("registered documentation task must match input exactly and be RUNNING");if(lease.releasedAt!==null||lease.mode!=="WRITE"||lease.taskId!==task.id||lease.workerId!==workerId||lease.repositoryId!==task.repository.id)throw new Error("active WRITE lease does not match documentation task, worker, and repository");if(Date.parse(lease.expiresAt)<=Date.parse(evaluatedAt))throw new Error("documentation WRITE lease is expired");return{roleAudit,lease};}
/** @param {string} root @param {string} relativePath */
function resolveInside(root,relativePath){const target=path.resolve(root,...relativePath.split("/"));if(target!==path.join(root,relativePath)||!target.startsWith(`${root}${path.sep}`))throw new Error("documentation path escapes worktree");return target;}
/** @param {string} root @param {string[]} expectedPaths */
function requireOnlyDocumentationChanges(root,expectedPaths){const paths=getAgentWorktreeChangedPaths(root),expected=[...expectedPaths].sort();if(paths.length!==expected.length||paths.some((value,index)=>value!==expected[index]))throw new Error("documentation worktree changed outside declared proposal paths");}
/** @param {string} root @param {any} proposal */
function prepareDocumentationWrites(root,proposal){const prepared=[];for(const file of proposal.files){const target=resolveInside(root,file.path),parent=path.dirname(target);let parentStat;try{parentStat=fs.lstatSync(parent);}catch{throw new Error(`documentation parent directory is unavailable: ${file.path}`);}if(!parentStat.isDirectory()||parentStat.isSymbolicLink()||fs.realpathSync(parent)!==parent)throw new Error(`documentation parent directory is unsafe: ${file.path}`);if(file.operation==="MODIFY"){let stat;try{stat=fs.lstatSync(target);}catch{throw new Error(`documentation MODIFY target is unavailable: ${file.path}`);}if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>512*1024)throw new Error(`documentation MODIFY target is not a bounded single-link regular file: ${file.path}`);const original=fs.readFileSync(target,"utf8");if(original.includes("\u0000")||sha256(original)!==file.beforeSha256)throw new Error(`documentation MODIFY beforeSha256 is stale: ${file.path}`);prepared.push({path:file.path,target,operation:file.operation,original,mode:stat.mode,content:file.content,contentSha256:file.contentSha256});}else{try{fs.lstatSync(target);throw new Error(`documentation CREATE target already exists: ${file.path}`);}catch(error){if(error instanceof Error&&error.message.startsWith("documentation CREATE target already exists"))throw error;if(!(error&&typeof error==="object"&&"code" in error&&error.code==="ENOENT"))throw new Error(`documentation CREATE target cannot be safely inspected: ${file.path}`);}prepared.push({path:file.path,target,operation:file.operation,original:null,mode:0o600,content:file.content,contentSha256:file.contentSha256});}}return prepared;}
/** @param {Array<any>} prepared */
function rollbackDocumentationWrites(prepared){for(const file of [...prepared].reverse()){try{if(file.operation==="CREATE"){if(fs.existsSync(file.target))fs.unlinkSync(file.target);}else fs.writeFileSync(file.target,file.original,{encoding:"utf8",mode:file.mode});}catch{/* preserve original failure */}}}
/** @param {any} task @param {any} rolePolicy @param {any} policy @param {any} input @param {unknown} rawProposal @param {import("node:sqlite").DatabaseSync} db @param {string} leaseId @param {string} workerId @param {string} evaluatedAt @param {string} worktree */
export function applyAgentDocumentation(task,rolePolicy,policy,input,rawProposal,db,leaseId,workerId,evaluatedAt,worktree){
  validateDocumentationBindings(task,policy,input);if(policy.applyMode!=="ALLOW_LOW_RISK_WORKTREE")throw new Error("documentation policy is proposal-only and does not authorize worktree apply");if(task.risk!=="LOW")throw new Error("documentation worktree apply is limited to LOW risk tasks");
  const proposalResult=validateAgentDocumentationProposal(rawProposal,task,policy,input);if(!proposalResult.valid||!proposalResult.proposal)throw new Error("Documentation Proposal v1 is invalid");if(proposalResult.proposal.humanReviewRequired)throw new Error("documentation proposal contains human-review-required paths and cannot be auto-applied");
  const authorization=requireDocumentationLease(task,rolePolicy,db,leaseId,workerId,evaluatedAt),state=inspectAgentRepairWorktree(worktree,task.repository.baseCommit,true);verifyAgentWorktreeContext(state.root,input);
  const prepared=prepareDocumentationWrites(state.root,proposalResult.proposal);let touched=false;
  try{for(const file of prepared){if(file.operation==="CREATE")fs.writeFileSync(file.target,file.content,{encoding:"utf8",flag:"wx",mode:0o600});else fs.writeFileSync(file.target,file.content,{encoding:"utf8",flag:"w"});touched=true;}for(const file of prepared){let stat;try{stat=fs.lstatSync(file.target);}catch{throw new Error(`documentation output file is unavailable: ${file.path}`);}if(!stat.isFile()||stat.isSymbolicLink()||sha256(fs.readFileSync(file.target,"utf8"))!==file.contentSha256)throw new Error(`documentation output hash mismatch: ${file.path}`);}requireOnlyDocumentationChanges(state.root,prepared.map((file)=>file.path));}catch(error){if(touched)rollbackDocumentationWrites(prepared);throw error;}
  return{version:1,taskId:task.id,status:"DOCUMENTATION_APPLIED_IN_WORKTREE",repository:task.repository,files:prepared.map((file)=>({path:file.path,operation:file.operation,beforeSha256:file.operation==="MODIFY"?sha256(/** @type {string} */ (file.original)):null,contentSha256:file.contentSha256})),requiredChecks:proposalResult.proposal.requiredChecks,checksExecuted:false,humanReviewRequired:false,worktreeMutationPerformed:true,executionAuthorized:false,mergeAuthorized:false,deployAuthorized:false,productionMutationAuthorized:false,lease:{leaseId:authorization.lease.leaseId,workerId:authorization.lease.workerId,mode:authorization.lease.mode,expiresAt:authorization.lease.expiresAt},semantics:"LOW-risk documentation change was applied only inside the leased linked worktree; protected governance paths cannot enter this apply path and required checks remain unexecuted"};
}
/** @param {string} filename */
function readJsonFile(filename){const resolved=path.resolve(filename);let stat;try{stat=fs.lstatSync(resolved);}catch{throw new Error("documentation input file is unavailable");}if(!stat.isFile()||stat.isSymbolicLink()||stat.size<=0||stat.size>MAX_INPUT_BYTES)throw new Error("documentation input must be a bounded regular non-symlink file");try{return JSON.parse(fs.readFileSync(resolved,"utf8"));}catch{throw new Error("documentation input cannot be parsed");}}
/** @param {string[]} argv */
function parse(argv){const command=argv[0];if(!command||!["propose","apply"].includes(command))return null;const values=new Map(),flags=new Set(),allowed=new Set(["--task","--role-policy","--policy","--input","--worktree","--model-config","--backend","--model","--proposal","--registry","--lease-id","--worker-id","--evaluated-at"]);for(let i=1;i<argv.length;i+=1){const arg=argv[i];if(arg==="--json"){if(flags.has(arg))return null;flags.add(arg);continue;}if(!allowed.has(arg??"")||values.has(arg))return null;const next=argv[i+1];if(typeof next!=="string"||next.startsWith("--"))return null;values.set(arg,next);i+=1;}const common=["--task","--role-policy","--policy","--input","--worktree"],required=command==="propose"?[...common,"--model-config","--backend","--model"]:[...common,"--proposal","--registry","--lease-id","--worker-id","--evaluated-at"];if(required.some((key)=>!values.has(key)))return null;const permitted=new Set(required);if([...values.keys()].some((key)=>!permitted.has(key)))return null;return{command,values,json:flags.has("--json")};}
/** @param {string[]} argv @param {{invoke?:typeof invokeAgentLocalModel}} [deps] */
export async function main(argv=process.argv.slice(2),deps={}){const options=parse(argv);if(!options){console.error("Usage: node scripts/agent-documentation.js propose --task <task.json> --role-policy <roles.json> --policy <documentation-policy.json> --input <documentation-input.json> --worktree <path> --model-config <models.json> --backend <id> --model <id> [--json] | apply --task <task.json> --role-policy <roles.json> --policy <documentation-policy.json> --input <documentation-input.json> --worktree <path> --proposal <proposal.json> --registry <registry.sqlite> --lease-id <id> --worker-id <id> --evaluated-at <ISO> [--json]");return 1;}try{const taskResult=validateAgentTask(readJsonFile(options.values.get("--task"))),roleResult=validateAgentRolePolicy(readJsonFile(options.values.get("--role-policy"))),policyResult=validateAgentDocumentationPolicy(readJsonFile(options.values.get("--policy"))),inputResult=validateAgentDocumentationInput(readJsonFile(options.values.get("--input")));if(!taskResult.valid||!taskResult.task||!roleResult.valid||!roleResult.policy||!policyResult.valid||!policyResult.policy||!inputResult.valid||!inputResult.input)throw new Error("documentation task, role policy, documentation policy, or input is invalid");if(options.command==="propose"){const modelConfig=readAgentModelConfigFile(options.values.get("--model-config")),report=await proposeAgentDocumentation(taskResult.task,roleResult.policy,policyResult.policy,inputResult.input,options.values.get("--worktree"),modelConfig,options.values.get("--backend"),options.values.get("--model"),deps);console.log(options.json?JSON.stringify(report):JSON.stringify(report,null,2));return 0;}const proposalRaw=readJsonFile(options.values.get("--proposal")),db=openAgentTaskRegistry(options.values.get("--registry"));try{const report=applyAgentDocumentation(taskResult.task,roleResult.policy,policyResult.policy,inputResult.input,proposalRaw,db,options.values.get("--lease-id"),options.values.get("--worker-id"),options.values.get("--evaluated-at"),options.values.get("--worktree"));console.log(options.json?JSON.stringify(report):JSON.stringify(report,null,2));return 0;}finally{db.close();}}catch(error){console.error(error instanceof Error?error.message:"documentation agent failed");return 1;}}
if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=await main();
