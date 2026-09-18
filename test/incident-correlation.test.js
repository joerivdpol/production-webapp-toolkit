import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  correlateIncidentEvidence,
  formatIncidentCorrelation,
  main,
  validateIncidentCorrelationInput,
  validateIncidentCorrelationPolicy,
} from "../scripts/incident-correlation.js";

const COMMIT="a".repeat(40);
const OTHER="b".repeat(40);
const DEPLOYED="2026-09-18T06:05:00Z";
const OBSERVED="2026-09-18T06:10:00Z";
const EVALUATED="2026-09-18T06:15:00Z";
const SIG="c".repeat(64);

/** @returns {any} */
function runtime(){return{version:1,runtime:{name:"web",environment:"production"},deployment:{commit:COMMIT},evidence:{source:"runtime",authenticated:false,collectedAt:OBSERVED}};}
/** @returns {any} */
function health(){return{version:1,runtime:{name:"web",environment:"production"},evidence:{source:"health",authenticated:false,collectedAt:OBSERVED},checks:[{id:"database",category:"database",status:"DEGRADED",latencyMs:420}]};}
/** @returns {any} */
function incident(){
  return{
    version:1,taskId:"task:incident",repository:{id:"example-webapp",commit:COMMIT},evaluatedAt:EVALUATED,
    release:{id:"release:current",commit:COMMIT,deployedAt:DEPLOYED,artifactSha256:"d".repeat(64)},
    runtimeEvidence:runtime(),runtimeHealthEvidence:health(),
    errors:[{id:"database-timeout",source:"runtime-errors",observedAt:OBSERVED,count:12,summary:"Database requests exceeded the configured timeout",path:"src/database.js"}],
    metrics:[{id:"db-latency",source:"runtime-metrics",observedAt:OBSERVED,name:"database_latency_ms",value:420,unit:"ms",status:"WARN"}],
    unknowns:[]
  };
}
/** @returns {any} */
function dependency(commit=COMMIT){
  return{
    version:1,taskId:"task:dependency",repository:{id:"example-webapp",commit},
    generator:{id:"renovate-run",type:"RENOVATE",authenticated:false},
    changes:[{id:"change-db",ecosystem:"NPM",package:"db-client",fromVersion:"1.2.3",toVersion:"1.3.0",relationship:"PRODUCTION",manifestPath:"package.json",lockfilePath:"bun.lock"}],
    changedPaths:["package.json","bun.lock"],
    evidence:[{id:"dep-evidence",source:"deterministic-updater",status:"INFO",summary:"Updater proposed the exact dependency version",changeIds:["change-db"],path:"package.json"}],
    unknowns:[]
  };
}
/** @returns {any} */
function contract(providerCommit=COMMIT){
  return{
    version:1,taskId:"task:contract",
    repositories:[{id:"example-webapp",commit:providerCommit},{id:"consumer",commit:OTHER}],
    crossContractPolicy:{version:1,requirements:[{contractId:"public-api",repositories:["example-webapp","consumer"],expectedVersion:"v2"}]},
    inventories:[{version:1,repository:"example-webapp",contracts:[{id:"public-api",version:"v2"}]},{version:1,repository:"consumer",contracts:[{id:"public-api",version:"v1"}]}],
    evidence:[{id:"edge-evidence",source:"consumer-import",status:"INFO",summary:"Consumer uses the explicit public API contract",repository:"consumer",path:"src/client.ts"}],
    relationships:[{id:"edge-one",contractId:"public-api",providerRepository:"example-webapp",consumerRepository:"consumer",providerPaths:["src/api.ts"],consumerPaths:["src/client.ts"],evidenceIds:["edge-evidence"]}],
    unknowns:[]
  };
}
/** @returns {any} */
function policy(){return{version:1,maxReleaseWindowSeconds:3600,maxKnownFailureAgeSeconds:30*24*3600};}
/** @returns {any} */
function input(){
  return{
    version:1,incident:incident(),dependencyInputs:[dependency()],contractInputs:[contract()],
    incidentSignatures:[{errorId:"database-timeout",signatureSha256:SIG}],
    knownFailures:[{id:"known-db-timeout",sourceRef:"failure-db:42",repository:{id:"example-webapp"},lastObservedAt:"2026-09-10T06:10:00Z",signatureSha256:[SIG],evidenceRefs:["prior:error:42","prior:run:42"]}],
    policy:policy()
  };
}
test("policy validates explicit bounded correlation windows",()=>{
  assert.equal(validateIncidentCorrelationPolicy(policy()).valid,true);
  assert.equal(validateIncidentCorrelationPolicy({version:1,maxReleaseWindowSeconds:0,maxKnownFailureAgeSeconds:1}).valid,false);
  assert.equal(validateIncidentCorrelationPolicy({...policy(),unknown:true}).valid,false);
});

test("input composes canonical incident dependency and contract validators",()=>{
  const result=validateIncidentCorrelationInput(input());
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(result.input?.dependencyInputs[0].changes[0].updateClass,"MINOR");
  assert.equal(result.input?.contractInputs[0].audit.overallStatus,"FAIL");
  assert.equal(result.input?.incident.repository.commit,COMMIT);
});

test("correlator emits all four evidence-backed hypothesis classes",()=>{
  const validated=validateIncidentCorrelationInput(input());
  assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(!validated.valid||!validated.input)throw new Error("fixture invalid");
  const result=correlateIncidentEvidence(validated.input);
  assert.deepEqual(result.summary,{total:4,releaseTemporal:1,dependencyChange:1,contractFailure:1,priorFailureMatch:1});
  assert.deepEqual(new Set(result.correlations.map((item)=>item.kind)),new Set(["RELEASE_TEMPORAL","DEPENDENCY_CHANGE","CONTRACT_FAILURE","PRIOR_FAILURE_MATCH"]));
  assert.equal(result.rootCauseEstablished,false);
  assert.equal(result.incidentResolved,false);
  assert.equal(result.rollbackAuthorized,false);
  assert.equal(result.deployAuthorized,false);
});
test("release correlation only occurs inside explicit post-release window",()=>{
  const raw=input();raw.policy.maxReleaseWindowSeconds=60;
  const validated=validateIncidentCorrelationInput(raw);assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(!validated.valid||!validated.input)return;
  const result=correlateIncidentEvidence(validated.input);
  assert.equal(result.correlations.some((item)=>item.kind==="RELEASE_TEMPORAL"),false);
  const before=input();before.incident.errors[0].observedAt="2026-09-18T06:00:00Z";before.incident.metrics[0].observedAt="2026-09-18T06:00:00Z";
  const checked=validateIncidentCorrelationInput(before);assert.equal(checked.valid,true,JSON.stringify(checked.errors));
  if(checked.valid&&checked.input)assert.equal(correlateIncidentEvidence(checked.input).correlations.some((item)=>item.kind==="RELEASE_TEMPORAL"),false);
});

test("dependency correlation requires exact incident repository and release commit",()=>{
  const wrong=input();wrong.dependencyInputs=[dependency(OTHER)];
  const validated=validateIncidentCorrelationInput(wrong);assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(!validated.valid||!validated.input)return;
  assert.equal(correlateIncidentEvidence(validated.input).correlations.some((item)=>item.kind==="DEPENDENCY_CHANGE"),false);
});
test("contract correlation requires exact incident repository commit and deterministic FAIL",()=>{
  const wrong=input();wrong.contractInputs=[contract("e".repeat(40))];
  const validated=validateIncidentCorrelationInput(wrong);assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(!validated.valid||!validated.input)return;
  assert.equal(correlateIncidentEvidence(validated.input).correlations.some((item)=>item.kind==="CONTRACT_FAILURE"),false);

  const clean=input();clean.contractInputs[0].inventories[1].contracts[0].version="v2";
  const checked=validateIncidentCorrelationInput(clean);assert.equal(checked.valid,true,JSON.stringify(checked.errors));
  if(checked.valid&&checked.input)assert.equal(correlateIncidentEvidence(checked.input).correlations.some((item)=>item.kind==="CONTRACT_FAILURE"),false);
});

test("prior failure correlation requires exact opaque signature repository and age",()=>{
  const mismatch=input();mismatch.knownFailures[0].signatureSha256=["f".repeat(64)];
  let validated=validateIncidentCorrelationInput(mismatch);assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(validated.valid&&validated.input)assert.equal(correlateIncidentEvidence(validated.input).correlations.some((item)=>item.kind==="PRIOR_FAILURE_MATCH"),false);

  const otherRepo=input();otherRepo.knownFailures[0].repository.id="other";
  validated=validateIncidentCorrelationInput(otherRepo);assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(validated.valid&&validated.input)assert.equal(correlateIncidentEvidence(validated.input).correlations.some((item)=>item.kind==="PRIOR_FAILURE_MATCH"),false);
});
test("future or too-old known failures never match",()=>{
  const future=input();future.knownFailures[0].lastObservedAt="2026-09-19T00:00:00Z";
  let validated=validateIncidentCorrelationInput(future);assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(validated.valid&&validated.input)assert.equal(correlateIncidentEvidence(validated.input).correlations.some((item)=>item.kind==="PRIOR_FAILURE_MATCH"),false);

  const old=input();old.policy.maxKnownFailureAgeSeconds=3600;old.knownFailures[0].lastObservedAt="2026-09-17T00:00:00Z";
  validated=validateIncidentCorrelationInput(old);assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(validated.valid&&validated.input)assert.equal(correlateIncidentEvidence(validated.input).correlations.some((item)=>item.kind==="PRIOR_FAILURE_MATCH"),false);
});

test("incident signatures must bind declared incident errors",()=>{
  const raw=input();raw.incidentSignatures[0].errorId="missing-error";
  const result=validateIncidentCorrelationInput(raw);
  assert.equal(result.valid,false);
  assert.equal(result.errors.some((item)=>item.id==="incident-signature-fields-invalid"),true);
});

test("known failure signatures must be canonical SHA256 and source-referenced",()=>{
  const raw=input();raw.knownFailures[0].signatureSha256=["not-a-hash"];
  assert.equal(validateIncidentCorrelationInput(raw).valid,false);
  const refs=input();refs.knownFailures[0].evidenceRefs=[];
  assert.equal(validateIncidentCorrelationInput(refs).valid,false);
});
test("source references are explicit and output never includes raw incident summaries",()=>{
  const validated=validateIncidentCorrelationInput(input());assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(!validated.valid||!validated.input)return;
  const result=correlateIncidentEvidence(validated.input),serialized=JSON.stringify(result);
  assert.match(serialized,/dependency-change:task:dependency:change-db/);
  assert.match(serialized,/contract-audit:task:contract:audit:public-api:contract-version-mismatch/);
  assert.match(serialized,/failure-db:42/);
  assert.doesNotMatch(serialized,/Database requests exceeded the configured timeout/);
  assert.doesNotMatch(serialized,/Consumer uses the explicit public API contract/);
});

test("human report remains hypotheses-only and bounded",()=>{
  const validated=validateIncidentCorrelationInput(input());assert.equal(validated.valid,true);
  if(!validated.valid||!validated.input)return;
  const output=formatIncidentCorrelation(correlateIncidentEvidence(validated.input));
  assert.match(output,/Incident Correlation Evidence v1/);
  assert.match(output,/DEPENDENCY_CHANGE/);
  assert.match(output,/Semantics: deterministic correlation evidence only/);
  assert.doesNotMatch(output,/Database requests exceeded/);
});
/** @param {string} prefix @param {any} value */
function tempJson(prefix,value){const file=path.join(os.tmpdir(),`${prefix}-${process.pid}-${Math.random().toString(16).slice(2)}.json`);fs.writeFileSync(file,JSON.stringify(value));return file;}
test("CLI validates and correlates one explicit local input file",()=>{
  const file=tempJson("incident-correlation",input()),original=console.log;let stdout="";console.log=(...values)=>{stdout+=`${values.join(" ")}\n`;};
  try{assert.equal(main(["--file",file,"--json"]),0);}finally{console.log=original;fs.rmSync(file,{force:true});}
  const parsed=JSON.parse(stdout);assert.equal(parsed.summary.total,4);assert.equal(parsed.rootCauseEstablished,false);
});

test("CLI rejects malformed symlinked and unknown input",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"incident-correlation-link-")),target=path.join(root,"input.json"),link=path.join(root,"link.json");
  fs.writeFileSync(target,JSON.stringify(input()));fs.symlinkSync(target,link);
  const original=console.error;console.error=()=>{};
  try{assert.equal(main([]),1);assert.equal(main(["--unknown","x"]),1);assert.equal(main(["--file",link]),1);}finally{console.error=original;fs.rmSync(root,{recursive:true,force:true});}
});

test("correlator source is offline read-only and delegates canonical validators",()=>{
  const source=fs.readFileSync(new URL("../scripts/incident-correlation.js",import.meta.url),"utf8");
  assert.match(source,/validateAgentIncidentInput/);assert.match(source,/validateAgentDependencyMaintenanceInput/);assert.match(source,/validateAgentContractImpactInput/);
  assert.doesNotMatch(source,/node:child_process|spawnSync|execSync|writeFile|appendFile|rmSync|renameSync|\bfetch\s*\(|https?:\/\/|process\.env|Date\.now\(\)/);
});


test("public correlation template is valid and contains no maintainer infrastructure",()=>{
  const file=new URL("../templates/incident-correlation-input.v1.json",import.meta.url);
  const rawText=fs.readFileSync(file,"utf8"),raw=JSON.parse(rawText),result=validateIncidentCorrelationInput(raw);
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.doesNotMatch(rawText,/ubuntu-dev|lenovo|tailscale|192\.168\.|endpoint|sshHost|maintainerService/i);
});
