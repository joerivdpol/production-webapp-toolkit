import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  aggregateAgentTelemetry,
  formatAgentTelemetry,
  main,
  validateAgentTelemetryEvidence,
} from "../scripts/agent-resource-telemetry.js";

const COMMIT="a".repeat(40);
const T0="2026-09-18T08:00:00Z";
const T1="2026-09-18T08:00:02Z";
const COLLECTED="2026-09-18T08:10:00Z";

/** @param {Partial<any>} [overrides] @returns {any} */
function run(overrides={}){
  return{
    runId:"run:one",taskId:"task:diagnose",role:"diagnose",
    repository:{id:"demo",commit:COMMIT},
    worker:{id:"worker:persistent",class:"PERSISTENT"},
    model:{id:"small-local",class:"SMALL",backend:"ollama"},
    startedAt:T0,completedAt:T1,latencyMs:2000,
    resources:{cpuTimeMs:1500,gpuTimeMs:null},
    usage:{inputTokens:120,outputTokens:40},
    proposal:{outcome:"ACCEPTED"},
    review:{effortSeconds:90},
    defect:{reopened:false},
    evaluation:{corpusId:"agent-corpus-v1",status:"PASS"},
    ...overrides,
  };
}
/** @param {any[]} runs */
function evidence(runs){
  return{version:1,evidence:{source:"agent-runner",authenticated:false,collectedAt:COLLECTED},runs};
}

test("validates one explicit model run with exact resource and outcome telemetry",()=>{
  const result=validateAgentTelemetryEvidence(evidence([run()]));
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(result.evidence?.runs[0].latencyMs,2000);
  assert.equal(result.evidence?.runs[0].usage.inputTokens,120);
  assert.equal(result.evidence?.runs[0].evaluation.status,"PASS");
});

test("latency must equal completedAt minus startedAt exactly",()=>{
  const mismatch=run({latencyMs:1999});
  let result=validateAgentTelemetryEvidence(evidence([mismatch]));
  assert.equal(result.valid,false);
  assert.equal(result.errors.some((e)=>e.id==="latency-binding-invalid"),true);
  const reverse=run({startedAt:T1,completedAt:T0,latencyMs:0});
  result=validateAgentTelemetryEvidence(evidence([reverse]));
  assert.equal(result.valid,false);
});

test("invalid non-null token or GPU values fail instead of becoming missing",()=>{
  const tokens=run();tokens.usage.inputTokens="120";
  assert.equal(validateAgentTelemetryEvidence(evidence([tokens])).valid,false);
  const gpu=run();gpu.resources.gpuTimeMs=-1;
  assert.equal(validateAgentTelemetryEvidence(evidence([gpu])).valid,false);
  const missing=run();missing.usage.inputTokens=null;missing.usage.outputTokens=null;missing.resources.gpuTimeMs=null;
  assert.equal(validateAgentTelemetryEvidence(evidence([missing])).valid,true);
});
test("reopened defects require an accepted proposal",()=>{
  const rejected=run();rejected.proposal.outcome="REJECTED";rejected.defect.reopened=true;
  const result=validateAgentTelemetryEvidence(evidence([rejected]));
  assert.equal(result.valid,false);
  assert.equal(result.errors.some((e)=>e.id==="defect-outcome-invalid"),true);
});

test("evaluation status and corpus id are bound explicitly",()=>{
  const missingCorpus=run();missingCorpus.evaluation={corpusId:null,status:"PASS"};
  assert.equal(validateAgentTelemetryEvidence(evidence([missingCorpus])).valid,false);
  const notEvaluated=run();notEvaluated.evaluation={corpusId:null,status:"NOT_EVALUATED"};
  assert.equal(validateAgentTelemetryEvidence(evidence([notEvaluated])).valid,true);
  const inconsistent=run();inconsistent.evaluation={corpusId:"agent-corpus-v1",status:"NOT_EVALUATED"};
  assert.equal(validateAgentTelemetryEvidence(evidence([inconsistent])).valid,false);
});

test("runs cannot complete after telemetry collectedAt",()=>{
  const future=run({startedAt:"2026-09-18T08:11:00Z",completedAt:"2026-09-18T08:11:01Z",latencyMs:1000});
  const result=validateAgentTelemetryEvidence(evidence([future]));
  assert.equal(result.valid,false);
  assert.equal(result.errors.some((e)=>e.id==="run-future-invalid"),true);
});

test("duplicate run ids fail closed",()=>{
  const second=run({taskId:"task:other"});
  const result=validateAgentTelemetryEvidence(evidence([run(),second]));
  assert.equal(result.valid,false);
  assert.equal(result.errors.some((e)=>e.id==="run-duplicate"),true);
});
test("aggregates counts time tokens review and evaluations without a quality score",()=>{
  const one=run();
  const two=run({
    runId:"run:two",taskId:"task:review",role:"review",
    worker:{id:"worker:compute",class:"COMPUTE"},
    model:{id:"strong-local",class:"STRONG",backend:"llama"},
    startedAt:"2026-09-18T08:01:00Z",completedAt:"2026-09-18T08:01:03Z",latencyMs:3000,
    resources:{cpuTimeMs:2200,gpuTimeMs:2600},
    usage:{inputTokens:null,outputTokens:null},
    proposal:{outcome:"REJECTED"},review:{effortSeconds:300},defect:{reopened:false},
    evaluation:{corpusId:"agent-corpus-v1",status:"FAIL"},
  });
  const three=run({
    runId:"run:three",taskId:"task:docs",role:"docs",
    startedAt:"2026-09-18T08:02:00Z",completedAt:"2026-09-18T08:02:01Z",latencyMs:1000,
    resources:{cpuTimeMs:800,gpuTimeMs:null},usage:{inputTokens:50,outputTokens:20},
    proposal:{outcome:"NOT_APPLICABLE"},review:{effortSeconds:0},defect:{reopened:false},
    evaluation:{corpusId:null,status:"NOT_EVALUATED"},
  });
  const validated=validateAgentTelemetryEvidence(evidence([one,two,three]));
  assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(!validated.valid||!validated.evidence)return;
  const report=aggregateAgentTelemetry(validated.evidence);
  assert.deepEqual(report.totals.proposals,{accepted:1,rejected:1,notApplicable:1});
  assert.equal(report.totals.latencyMs,6000);
  assert.equal(report.totals.cpuTimeMs,4500);
  assert.equal(report.totals.gpuTimeMs,2600);
  assert.equal(report.totals.gpuTimeReported,1);
  assert.equal(report.totals.inputTokens,170);
  assert.equal(report.totals.outputTokens,60);
  assert.equal(report.totals.tokenUsageReported,2);
  assert.equal(report.totals.tokenUsageMissing,1);
  assert.equal(report.totals.reviewEffortSeconds,390);
  assert.deepEqual(report.totals.evaluation,{pass:1,fail:1,notEvaluated:1});
  assert.equal(report.qualityScore,null);
});
test("reopened accepted defect is counted observationally",()=>{
  const reopened=run();reopened.defect.reopened=true;
  const validated=validateAgentTelemetryEvidence(evidence([reopened]));
  assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(validated.valid&&validated.evidence){
    const report=aggregateAgentTelemetry(validated.evidence);
    assert.equal(report.totals.reopenedDefects,1);
    assert.equal(report.totals.proposals.accepted,1);
  }
});

test("groups deterministically by role model and worker",()=>{
  const second=run({runId:"run:two",taskId:"task:two"});
  const third=run({
    runId:"run:review",taskId:"task:review",role:"review",
    worker:{id:"worker:compute",class:"COMPUTE"},
    model:{id:"review-local",class:"REVIEW",backend:"llama"},
  });
  const validated=validateAgentTelemetryEvidence(evidence([third,second,run()]));
  assert.equal(validated.valid,true,JSON.stringify(validated.errors));
  if(!validated.valid||!validated.evidence)return;
  const report=aggregateAgentTelemetry(validated.evidence);
  assert.deepEqual(report.byRole.map((x)=>[x.key,x.totals.runs]),[["diagnose",2],["review",1]]);
  assert.deepEqual(report.byWorker.map((x)=>x.key),["worker:compute:COMPUTE","worker:persistent:PERSISTENT"]);
  assert.deepEqual(report.byModel.map((x)=>x.key),["llama:review-local:REVIEW","ollama:small-local:SMALL"]);
});
test("authenticated metadata is retained but does not create a quality claim",()=>{
  const raw=evidence([run()]);raw.evidence.authenticated=true;
  const validated=validateAgentTelemetryEvidence(raw);
  assert.equal(validated.valid,true);
  if(validated.valid&&validated.evidence){
    const report=aggregateAgentTelemetry(validated.evidence);
    assert.equal(report.evidence.authenticated,true);
    assert.equal(report.qualityScore,null);
    assert.match(report.semantics,/caller-supplied measurements/);
  }
});

test("human format exposes totals without prompts outputs or provider model names",()=>{
  const validated=validateAgentTelemetryEvidence(evidence([run()]));
  assert.equal(validated.valid,true);
  if(!validated.valid||!validated.evidence)return;
  const output=formatAgentTelemetry(aggregateAgentTelemetry(validated.evidence));
  assert.match(output,/Runs: 1/);
  assert.match(output,/Proposals: 1 accepted/);
  assert.doesNotMatch(output,/prompt|providerModel|model output/i);
});
test("CLI validates one local evidence file and rejects symlinks",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"agent-telemetry-"));
  const file=path.join(root,"telemetry.json"),link=path.join(root,"link.json");
  fs.writeFileSync(file,JSON.stringify(evidence([run()])));
  fs.symlinkSync(file,link);
  const originalLog=console.log,originalError=console.error;let stdout="";
  console.log=(...values)=>{stdout+=`${values.join(" ")}\n`;};console.error=()=>{};
  try{
    assert.equal(main(["--file",file,"--json"]),0);
    assert.equal(JSON.parse(stdout.trim()).totals.runs,1);
    assert.equal(main(["--file",link]),1);
    assert.equal(main(["--unknown","x"]),1);
  }finally{console.log=originalLog;console.error=originalError;fs.rmSync(root,{recursive:true,force:true});}
});

test("source remains offline read-only with no implicit clock or model invocation",()=>{
  const source=fs.readFileSync(new URL("../scripts/agent-resource-telemetry.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/node:child_process|spawnSync|execSync|writeFile|appendFile|\bfetch\s*\(|https?:\/\/|process\.env|Date\.now\(\)/);
  assert.doesNotMatch(source,/invokeAgentLocalModel|providerModel|messages/);
});


test("public telemetry template is valid and contains no private deployment fields",()=>{
  const file=new URL("../templates/agent-resource-telemetry.v1.json",import.meta.url);
  const rawText=fs.readFileSync(file,"utf8"),raw=JSON.parse(rawText);
  const result=validateAgentTelemetryEvidence(raw);
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.doesNotMatch(rawText,/endpoint|providerModel|hostname|ssh|tailscale|ubuntu-dev|lenovo|192\.168\./i);
});
