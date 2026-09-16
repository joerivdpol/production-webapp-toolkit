import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { formatArtifactProvenance, main, validateArtifactProvenance } from "../scripts/artifact-provenance.js";

const COMMIT="0123456789abcdef0123456789abcdef01234567";
const HASH="a".repeat(64);

/** @returns {any} */
function raw() {
  return {version:1,source:{commit:COMMIT},build:{ci:{provider:"github-actions",workflow:"CI",runId:"123"},artifact:{name:"web-dist.tar.gz",sha256:HASH}},deployment:{target:"production",artifactSha256:HASH,runtime:{name:"web",environment:"production"}},evidence:{source:"synthetic",authenticated:false,collectedAt:"2026-09-16T16:00:00Z"}};
}
/** @param {any} value */
function temp(value) { const f=path.join(os.tmpdir(),`artifact-prov-${process.pid}-${Math.random()}.json`); fs.writeFileSync(f,typeof value==="string"?value:JSON.stringify(value)); return f; }

test("validates and normalizes artifact provenance",()=>{ const result=validateArtifactProvenance(raw()); assert.equal(result.valid,true); if(!result.valid||!result.provenance)return; assert.equal(result.provenance.source.commit,COMMIT); assert.match(formatArtifactProvenance(result.provenance),/Result: VALID/); });
test("requires exact CI build identity",()=>{ const value=raw(); delete value.build.ci.runId; assert.equal(validateArtifactProvenance(value).valid,false); });
test("requires full source commit and SHA256 artifact identities",()=>{ const a=raw(); a.source.commit="abc"; assert.equal(validateArtifactProvenance(a).valid,false); const b=raw(); b.build.artifact.sha256="abc"; assert.equal(validateArtifactProvenance(b).valid,false); const c=raw(); c.deployment.artifactSha256="abc"; assert.equal(validateArtifactProvenance(c).valid,false); });
test("requires explicit deployment runtime and target",()=>{ const a=raw(); a.deployment.target=""; assert.equal(validateArtifactProvenance(a).valid,false); const b=raw(); b.deployment.runtime.environment=""; assert.equal(validateArtifactProvenance(b).valid,false); });
test("rejects unknown fields rather than inventing semantics",()=>{ const value=raw(); value.build.builder={name:"unknown"}; assert.equal(validateArtifactProvenance(value).valid,false); });
test("requires explicit trust metadata without generating timestamps",()=>{ const value=raw(); value.evidence.collectedAt="today"; assert.equal(validateArtifactProvenance(value).valid,false); });
test("CLI emits JSON and leaves source unchanged",()=>{ const f=temp(raw()),before=fs.readFileSync(f,"utf8"),original=console.log; let output=""; console.log=(...v)=>{output+=`${v.join(" ")}\n`;}; try{assert.equal(main(["--file",f,"--json"]),0);}finally{console.log=original;} assert.equal(JSON.parse(output).build.artifact.sha256,HASH); assert.equal(fs.readFileSync(f,"utf8"),before); fs.rmSync(f,{force:true}); });
test("CLI rejects malformed missing invalid and unknown input",()=>{ const malformed=temp("{"),invalid=temp({version:1}); assert.equal(main(["--file",malformed]),1); assert.equal(main(["--file",invalid]),1); assert.equal(main(["--file","/tmp/missing-prov.json"]),1); assert.equal(main(["--unknown"]),1); fs.rmSync(malformed,{force:true}); fs.rmSync(invalid,{force:true}); });
test("provenance validator stays offline and read only",()=>{ const source=fs.readFileSync(new URL("../scripts/artifact-provenance.js",import.meta.url),"utf8"); assert.doesNotMatch(source,/node:child_process|spawnSync|execFile|\bfetch\s*\(|process\.env|https?:\/\/|writeFile/); });
