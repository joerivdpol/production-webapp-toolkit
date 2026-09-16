import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { main, validateChangeSurfaceEvidence } from "../scripts/change-surface-evidence.js";
const BASE="0123456789abcdef0123456789abcdef01234567",HEAD="1123456789abcdef0123456789abcdef01234567";
/** @returns {any} */
function raw(){return{version:1,source:{baseCommit:BASE,headCommit:HEAD},metrics:{filesChanged:4,additions:120,deletions:30},surfaces:["api","frontend"],flags:{testsChanged:true,environmentChanged:false,majorDependencyUpgrade:false},evidence:{source:"synthetic",authenticated:false,collectedAt:"2026-09-16T16:20:00Z"}};}
/** @param {any} value */
function temp(value){const f=path.join(os.tmpdir(),`change-evidence-${process.pid}-${Math.random()}.json`);fs.writeFileSync(f,typeof value==="string"?value:JSON.stringify(value));return f;}
test("validates and sorts explicit surfaces",()=>{const v=raw();v.surfaces=["frontend","api"];const r=validateChangeSurfaceEvidence(v);assert.equal(r.valid,true);if(r.valid&&r.evidence)assert.deepEqual(r.evidence.surfaces,["api","frontend"]);});
test("rejects unsupported and duplicate surfaces",()=>{const a=raw();a.surfaces=["api","unknown"];assert.equal(validateChangeSurfaceEvidence(a).valid,false);const b=raw();b.surfaces=["api","api"];assert.equal(validateChangeSurfaceEvidence(b).valid,false);});
test("requires non-negative safe diff metrics",()=>{const a=raw();a.metrics.filesChanged=-1;assert.equal(validateChangeSurfaceEvidence(a).valid,false);const b=raw();b.metrics.additions=1.2;assert.equal(validateChangeSurfaceEvidence(b).valid,false);});
test("requires exact booleans and full commits",()=>{const a=raw();a.flags.testsChanged="yes";assert.equal(validateChangeSurfaceEvidence(a).valid,false);const b=raw();b.source.headCommit="abc";assert.equal(validateChangeSurfaceEvidence(b).valid,false);});
test("trust metadata is explicit and unknown fields fail closed",()=>{const a=raw();a.evidence.collectedAt="today";assert.equal(validateChangeSurfaceEvidence(a).valid,false);const b=raw();b.files=["x"];assert.equal(validateChangeSurfaceEvidence(b).valid,false);});
test("CLI emits canonical JSON and leaves source unchanged",()=>{const f=temp(raw()),before=fs.readFileSync(f,"utf8"),original=console.log;let out="";console.log=(...v)=>{out+=`${v.join(" ")}\n`;};try{assert.equal(main(["--file",f,"--json"]),0);}finally{console.log=original;}assert.equal(JSON.parse(out).metrics.filesChanged,4);assert.equal(fs.readFileSync(f,"utf8"),before);fs.rmSync(f,{force:true});});
test("validator stays local and read only",()=>{const source=fs.readFileSync(new URL("../scripts/change-surface-evidence.js",import.meta.url),"utf8");assert.doesNotMatch(source,/node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/);});
