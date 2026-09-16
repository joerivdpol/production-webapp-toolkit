import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatReleaseRisk, inspectReleaseRisk, main, validateReleaseRiskPolicy } from "../scripts/audit-release-risk.js";
import { validateChangeSurfaceEvidence } from "../scripts/change-surface-evidence.js";
const BASE="0123456789abcdef0123456789abcdef01234567",HEAD="1123456789abcdef0123456789abcdef01234567";
/** @returns {any} */
function evidenceRaw(){return{version:1,source:{baseCommit:BASE,headCommit:HEAD},metrics:{filesChanged:4,additions:120,deletions:30},surfaces:["frontend"],flags:{testsChanged:true,environmentChanged:false,majorDependencyUpgrade:false},evidence:{source:"synthetic",authenticated:false,collectedAt:"2026-09-16T16:20:00Z"}};}
/** @returns {any} */
function policyRaw(){return{version:1,surfaceLevels:{high:["database","auth","payment","deployment"],medium:["api","infrastructure"]},largeDiff:{filesChanged:50,totalLines:1000,level:"MEDIUM"},majorDependencyUpgrade:"MEDIUM",environmentChange:"HIGH",missingTests:{surfaces:["database","auth","payment","api","infrastructure"],level:"HIGH"}};}
function pair(e=evidenceRaw(),p=policyRaw()){const er=validateChangeSurfaceEvidence(e),pr=validateReleaseRiskPolicy(p);assert.equal(er.valid,true);assert.equal(pr.valid,true);if(!er.valid||!pr.valid)throw new Error("fixture invalid");return{e:er.evidence,p:pr.policy};}
/** @param {string} prefix @param {any} value */
function temp(prefix,value){const f=path.join(os.tmpdir(),`${prefix}-${process.pid}-${Math.random()}.json`);fs.writeFileSync(f,typeof value==="string"?value:JSON.stringify(value));return f;}
test("ordinary frontend change classifies LOW with no drivers",()=>{const {e,p}=pair();const r=inspectReleaseRisk(e,p);assert.equal(r.risk,"LOW");assert.equal(r.drivers.length,0);});
test("explicit surface policy classifies highest matching level",()=>{const raw=evidenceRaw();raw.surfaces=["api","database"];const{e,p}=pair(raw);const r=inspectReleaseRisk(e,p);assert.equal(r.risk,"HIGH");assert.equal(r.drivers.some(x=>x.id==="surface:database"),true);});
test("large diff is policy driven without numeric scoring",()=>{const raw=evidenceRaw();raw.metrics.filesChanged=50;const{e,p}=pair(raw);const r=inspectReleaseRisk(e,p);assert.equal(r.risk,"MEDIUM");assert.equal(r.drivers.find(x=>x.id==="large-diff")?.level,"MEDIUM");});
test("major dependency and environment flags use explicit levels",()=>{const raw=evidenceRaw();raw.flags.majorDependencyUpgrade=true;raw.flags.environmentChanged=true;const{e,p}=pair(raw);assert.equal(inspectReleaseRisk(e,p).risk,"HIGH");});
test("missing tests only triggers for explicitly scoped surfaces",()=>{const a=evidenceRaw();a.flags.testsChanged=false;const pa=pair(a);assert.equal(inspectReleaseRisk(pa.e,pa.p).risk,"LOW");const b=evidenceRaw();b.surfaces=["api"];b.flags.testsChanged=false;const pb=pair(b);assert.equal(inspectReleaseRisk(pb.e,pb.p).risk,"HIGH");});
test("policy rejects overlapping surfaces invalid levels and zero thresholds",()=>{const a=policyRaw();a.surfaceLevels.medium.push("database");assert.equal(validateReleaseRiskPolicy(a).valid,false);const b=policyRaw();b.environmentChange="CRITICAL";assert.equal(validateReleaseRiskPolicy(b).valid,false);const c=policyRaw();c.largeDiff.filesChanged=0;assert.equal(validateReleaseRiskPolicy(c).valid,false);});
test("evidence authentication never changes risk truth",()=>{const raw=evidenceRaw();raw.surfaces=["payment"];raw.evidence.authenticated=true;const{e,p}=pair(raw);assert.equal(inspectReleaseRisk(e,p).risk,"HIGH");});
test("human report lists concrete drivers not an artificial score",()=>{const raw=evidenceRaw();raw.surfaces=["database"];const{e,p}=pair(raw);const text=formatReleaseRisk(inspectReleaseRisk(e,p));assert.match(text,/Risk: HIGH/);assert.match(text,/surface:database/);assert.doesNotMatch(text,/score/i);});
test("CLI emits JSON and rejects invalid input",()=>{const ef=temp("risk-evidence",evidenceRaw()),pf=temp("risk-policy",policyRaw()),original=console.log;let out="";console.log=(...v)=>{out+=`${v.join(" ")}\n`;};try{assert.equal(main(["--evidence-file",ef,"--policy",pf,"--json"]),0);}finally{console.log=original;}assert.equal(JSON.parse(out).risk,"LOW");assert.equal(main(["--unknown"]),1);fs.rmSync(ef,{force:true});fs.rmSync(pf,{force:true});});
test("risk audit core stays offline and delegates canonical evidence",()=>{const source=fs.readFileSync(new URL("../scripts/audit-release-risk.js",import.meta.url),"utf8");assert.match(source,/validateChangeSurfaceEvidence/);assert.doesNotMatch(source,/node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);});
