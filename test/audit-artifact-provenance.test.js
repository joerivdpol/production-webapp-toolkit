import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatArtifactProvenanceAudit, inspectArtifactProvenance, main } from "../scripts/audit-artifact-provenance.js";
import { validateArtifactProvenance } from "../scripts/artifact-provenance.js";
import { validateCiEvidence } from "../scripts/ci-evidence.js";
import { validateRuntimeEvidence } from "../scripts/runtime-evidence.js";

const COMMIT="0123456789abcdef0123456789abcdef01234567", OTHER="1123456789abcdef0123456789abcdef01234567", HASH="b".repeat(64);
/** @returns {any} */
function provRaw(){return {version:1,source:{commit:COMMIT},build:{ci:{provider:"github-actions",workflow:"CI",runId:"123"},artifact:{name:"dist.tgz",sha256:HASH}},deployment:{target:"production",artifactSha256:HASH,runtime:{name:"web",environment:"production"}},evidence:{source:"deploy-manifest",authenticated:true,collectedAt:"2026-09-16T16:02:00Z"}};}
/** @returns {any} */
function ciRaw(){return {version:1,commit:COMMIT,ci:{provider:"github-actions",workflow:"CI",runId:"123"},evidence:{source:"github",authenticated:true,collectedAt:"2026-09-16T16:01:00Z"},checks:[{name:"quality",status:"PASS"}]};}
/** @returns {any} */
function runtimeRaw(){return {version:1,runtime:{name:"web",environment:"production"},deployment:{commit:COMMIT},evidence:{source:"runtime",authenticated:false,collectedAt:"2026-09-16T16:03:00Z"}};}
function validated(){const p=validateArtifactProvenance(provRaw()),c=validateCiEvidence(ciRaw()),r=validateRuntimeEvidence(runtimeRaw()); assert.equal(p.valid,true);assert.equal(c.valid,true);assert.equal(r.valid,true); if(!p.valid||!p.provenance||!c.valid||!c.evidence||!r.valid||!r.evidence)throw new Error("fixture invalid"); return {p:p.provenance,c:c.evidence,r:r.evidence};}
/** @param {any} value */
function temp(value){const f=path.join(os.tmpdir(),`artifact-audit-${process.pid}-${Math.random()}.json`);fs.writeFileSync(f,typeof value==="string"?value:JSON.stringify(value));return f;}

test("matching source CI artifact deployment and runtime is PASS",()=>{const {p,c,r}=validated();const report=inspectArtifactProvenance(p,c,r);assert.equal(report.overallStatus,"PASS");assert.equal(report.summary.fail,0);});
test("source commit must match CI exact commit",()=>{const {p,c,r}=validated();c.commit=OTHER;const report=inspectArtifactProvenance(p,c,r);assert.equal(report.overallStatus,"FAIL");assert.equal(report.checks.find(x=>x.id==="source-ci-commit")?.status,"FAIL");});
test("CI provider workflow and run identity are independently bound",()=>{for(const field of /** @type {Array<"provider"|"workflow"|"runId">} */ (["provider","workflow","runId"])){const {p,c,r}=validated();c.ci[field]="other";assert.equal(inspectArtifactProvenance(p,c,r).overallStatus,"FAIL");}});
test("built artifact hash must equal deployment artifact hash",()=>{const {p,c,r}=validated();p.deployment.artifactSha256="c".repeat(64);const report=inspectArtifactProvenance(p,c,r);assert.equal(report.overallStatus,"FAIL");assert.equal(report.checks.find(x=>x.id==="artifact-deployment-hash")?.status,"FAIL");});
test("runtime commit name and environment are independently bound",()=>{const a=validated();a.r.deployment.commit=OTHER;assert.equal(inspectArtifactProvenance(a.p,a.c,a.r).overallStatus,"FAIL");const b=validated();b.r.runtime.name="other";assert.equal(inspectArtifactProvenance(b.p,b.c,b.r).overallStatus,"FAIL");const c=validated();c.r.runtime.environment="staging";assert.equal(inspectArtifactProvenance(c.p,c.c,c.r).overallStatus,"FAIL");});
test("trust metadata is reported but never changes provenance equality truth",()=>{const {p,c,r}=validated();p.evidence.authenticated=false;c.evidence.authenticated=false;r.evidence.authenticated=false;const report=inspectArtifactProvenance(p,c,r);assert.equal(report.overallStatus,"PASS");assert.deepEqual(report.trust,{provenanceAuthenticated:false,ciAuthenticated:false,runtimeAuthenticated:false});});
test("human output distinguishes provenance match from authentication",()=>{const {p,c,r}=validated();const text=formatArtifactProvenanceAudit(inspectArtifactProvenance(p,c,r));assert.match(text,/Provenance: MATCH/);assert.match(text,/Provenance authenticated: true/);assert.match(text,/Runtime authenticated: false/);});
test("CLI returns zero for match and one for mismatch",()=>{const pf=temp(provRaw()),cf=temp(ciRaw()),rf=temp(runtimeRaw()),original=console.log;console.log=()=>{};try{assert.equal(main(["--provenance-file",pf,"--ci-evidence-file",cf,"--runtime-evidence-file",rf,"--json"]),0);const bad=runtimeRaw();bad.deployment.commit=OTHER;fs.writeFileSync(rf,JSON.stringify(bad));assert.equal(main(["--provenance-file",pf,"--ci-evidence-file",cf,"--runtime-evidence-file",rf]),1);}finally{console.log=original;}for(const f of [pf,cf,rf])fs.rmSync(f,{force:true});});
test("CLI rejects malformed invalid missing and incomplete inputs",()=>{const bad=temp("{"),cf=temp(ciRaw()),rf=temp(runtimeRaw());assert.equal(main(["--provenance-file",bad,"--ci-evidence-file",cf,"--runtime-evidence-file",rf]),1);assert.equal(main(["--unknown"]),1);for(const f of [bad,cf,rf])fs.rmSync(f,{force:true});});
test("audit core delegates canonical validators and stays offline",()=>{const source=fs.readFileSync(new URL("../scripts/audit-artifact-provenance.js",import.meta.url),"utf8");assert.match(source,/validateArtifactProvenance/);assert.match(source,/validateCiEvidence/);assert.match(source,/validateRuntimeEvidence/);assert.doesNotMatch(source,/node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);});
