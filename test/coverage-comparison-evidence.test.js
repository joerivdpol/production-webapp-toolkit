import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatCoverageComparisonEvidence,
  main,
  safeCoveragePath,
  validateCoverageComparisonEvidence,
} from "../scripts/coverage-comparison-evidence.js";

function metric(covered=8,total=10){return{covered,total};}
function metrics(covered=8,total=10){return{lines:metric(covered,total),statements:metric(covered,total),functions:metric(covered,total),branches:metric(covered,total)};}
/** @returns {any} */
function rawEvidence(){return{
  version:1,
  source:{baseCommit:"A".repeat(40),headCommit:"B".repeat(40)},
  evidence:{source:"synthetic-coverage",authenticated:false,collectedAt:"2026-09-16T17:00:00Z"},
  changes:[{path:"src/core.js",status:"MODIFIED"},{path:"src/new.js",status:"ADDED"}],
  baseline:[{path:"src/core.js",metrics:metrics(9,10)}],
  candidate:[{path:"src/new.js",metrics:metrics(8,10)},{path:"src/core.js",metrics:metrics(8,10)}],
};}
/** @param {unknown} value */
function tempJson(value){const file=path.join(os.tmpdir(),`coverage-evidence-${process.pid}-${Math.random().toString(16).slice(2)}.json`);fs.writeFileSync(file,typeof value==="string"?value:JSON.stringify(value));return file;}

test("normalizes valid comparison evidence deterministically",()=>{
  const result=validateCoverageComparisonEvidence(rawEvidence());assert.equal(result.valid,true);if(!result.valid||!result.evidence)return;
  assert.equal(result.evidence.source.baseCommit,"a".repeat(40));
  assert.deepEqual(result.evidence.candidate.map(file=>file.path),["src/core.js","src/new.js"]);
  assert.match(formatCoverageComparisonEvidence(result.evidence),/Result: VALID/);
});

test("coverage counts require integer covered less than or equal to total",()=>{
  for(const invalid of [{covered:11,total:10},{covered:-1,total:10},{covered:1.5,total:10},{covered:0,total:-1}]){
    const value=rawEvidence();value.candidate[0].metrics.lines=invalid;assert.equal(validateCoverageComparisonEvidence(value).valid,false);
  }
  const zero=rawEvidence();zero.candidate[0].metrics.lines={covered:0,total:0};assert.equal(validateCoverageComparisonEvidence(zero).valid,true);
});

test("paths are safe repository-relative paths",()=>{
  assert.equal(safeCoveragePath("src/a.ts"),true);
  for(const value of ["/src/a.ts","../src/a.ts","src/../a.ts","src\\a.ts","src/a.ts/",""])assert.equal(safeCoveragePath(value),false,value);
});

test("rejects duplicate baseline candidate and changed paths",()=>{
  const baseline=rawEvidence();baseline.baseline.push(structuredClone(baseline.baseline[0]));assert.equal(validateCoverageComparisonEvidence(baseline).valid,false);
  const candidate=rawEvidence();candidate.candidate.push(structuredClone(candidate.candidate[0]));assert.equal(validateCoverageComparisonEvidence(candidate).valid,false);
  const changes=rawEvidence();changes.changes.push(structuredClone(changes.changes[0]));assert.equal(validateCoverageComparisonEvidence(changes).valid,false);
});

test("rename and copy require a distinct previous path",()=>{
  const renamed=rawEvidence();renamed.changes=[{path:"src/new-name.js",status:"RENAMED",previousPath:"src/old-name.js"}];assert.equal(validateCoverageComparisonEvidence(renamed).valid,true);
  const missing=rawEvidence();missing.changes=[{path:"src/new-name.js",status:"RENAMED"}];assert.equal(validateCoverageComparisonEvidence(missing).valid,false);
  const unnecessary=rawEvidence();unnecessary.changes=[{path:"src/core.js",status:"MODIFIED",previousPath:"src/old.js"}];assert.equal(validateCoverageComparisonEvidence(unnecessary).valid,false);
});

test("source commits must be distinct full object ids",()=>{
  const same=rawEvidence();same.source.headCommit=same.source.baseCommit;assert.equal(validateCoverageComparisonEvidence(same).valid,false);
  const short=rawEvidence();short.source.baseCommit="HEAD";assert.equal(validateCoverageComparisonEvidence(short).valid,false);
});

test("rejects unknown fields throughout the contract",()=>{
  const top=rawEvidence();top.extra=true;assert.equal(validateCoverageComparisonEvidence(top).valid,false);
  const file=rawEvidence();file.candidate[0].extra=true;assert.equal(validateCoverageComparisonEvidence(file).valid,false);
  const count=rawEvidence();count.candidate[0].metrics.lines.extra=true;assert.equal(validateCoverageComparisonEvidence(count).valid,false);
});

test("CLI emits canonical JSON and leaves input unchanged",()=>{
  const file=tempJson(rawEvidence()),before=fs.readFileSync(file,"utf8"),original=console.log;let stdout="";console.log=(...values)=>{stdout+=`${values.join(" ")}\n`;};
  try{assert.equal(main(["--file",file,"--json"]),0);}finally{console.log=original;}
  assert.equal(JSON.parse(stdout).version,1);assert.equal(fs.readFileSync(file,"utf8"),before);fs.rmSync(file,{force:true});
});

test("CLI rejects malformed missing invalid and unknown input",()=>{
  const malformed=tempJson("{"),invalid=tempJson({version:1});
  assert.equal(main(["--file",malformed]),1);assert.equal(main(["--file",invalid]),1);assert.equal(main(["--file","/tmp/missing-coverage-comparison.json"]),1);assert.equal(main(["--unknown"]),1);
  fs.rmSync(malformed,{force:true});fs.rmSync(invalid,{force:true});
});

test("coverage evidence validator stays offline and read only",()=>{
  const source=fs.readFileSync(new URL("../scripts/coverage-comparison-evidence.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);
});
