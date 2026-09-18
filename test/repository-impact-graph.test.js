import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  formatRepositoryImpactQuery,
  main,
  queryRepositoryImpactGraph,
  validateRepositoryImpactGraph,
} from "../scripts/repository-impact-graph.js";

const APP="a".repeat(40);
const API="b".repeat(40);
const SHARED="c".repeat(40);

/** @returns {any} */
function rawGraph(){
  return{
    version:1,
    repositories:[
      {id:"app",commit:APP},
      {id:"api",commit:API},
      {id:"shared",commit:SHARED},
    ],
    nodes:[
      {id:"contract:booking",kind:"CONTRACT",repository:"api",locator:"booking-v1",sourcePath:"contracts/booking.json"},
      {id:"api:booking",kind:"API",repository:"api",locator:"POST /bookings",sourcePath:"openapi.json"},
      {id:"module:booking-handler",kind:"CANONICAL_MODULE",repository:"api",locator:"booking-handler",sourcePath:"src/booking.js"},
      {id:"consumer:checkout",kind:"CONSUMER",repository:"app",locator:"checkout-client",sourcePath:"src/checkout.js"},
      {id:"route:checkout",kind:"ROUTE",repository:"app",locator:"/checkout",sourcePath:"src/routes/checkout.js"},
      {id:"test:checkout",kind:"TEST",repository:"app",locator:"checkout regression",sourcePath:"test/checkout.test.js"},
      {id:"module:pricing",kind:"CANONICAL_MODULE",repository:"shared",locator:"canonical-pricing",sourcePath:"src/pricing.js"},
    ],
    edges:[
      edge("edge:api-contract","IMPLEMENTS","api:booking","contract:booking","api",API,"openapi.json","openapi-operation"),
      edge("edge:consumer-api","CONSUMES","consumer:checkout","api:booking","app",APP,"src/checkout.js","client-call"),
      edge("edge:route-consumer","ROUTES_TO","route:checkout","consumer:checkout","app",APP,"src/routes/checkout.js","route-call"),
      edge("edge:test-route","TESTS","test:checkout","route:checkout","app",APP,"test/checkout.test.js","test-coverage"),
      edge("edge:api-handler","DEPENDS_ON","api:booking","module:booking-handler","api",API,"src/booking.js","handler-call"),
      edge("edge:handler-pricing","IMPORTS","module:booking-handler","module:pricing","api",API,"src/booking.js","import-edge"),
    ],
  };
}

/** @param {string} id @param {string} kind @param {string} from @param {string} to @param {string} repository @param {string} commit @param {string} sourcePath @param {string} evidenceId */
function edge(id,kind,from,to,repository,commit,sourcePath,evidenceId){
  return{id,kind,from,to,provenance:{repository,commit,path:sourcePath,evidenceId}};
}

test("valid graph normalizes explicit repositories nodes and provenance edges",()=>{
  const result=validateRepositoryImpactGraph(rawGraph());
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.equal(result.graph?.repositories.length,3);
  assert.equal(result.graph?.nodes.length,7);
  assert.equal(result.graph?.edges.length,6);
  assert.deepEqual(result.graph?.repositories.map((repo)=>repo.id),["api","app","shared"]);
  assert.equal(result.graph?.edges.find((item)=>item.id==="edge:consumer-api")?.provenance.commit,APP);
});

test("repository ids and full commits are mandatory and unique",()=>{
  const duplicate=rawGraph();duplicate.repositories.push({...duplicate.repositories[0]});
  assert.equal(validateRepositoryImpactGraph(duplicate).valid,false);
  const commit=rawGraph();commit.repositories[0].commit="short";
  assert.equal(validateRepositoryImpactGraph(commit).valid,false);
});

test("nodes require supported kinds declared repository and safe optional path",()=>{
  const kind=rawGraph();kind.nodes[0].kind="DATABASE";assert.equal(validateRepositoryImpactGraph(kind).valid,false);
  const repo=rawGraph();repo.nodes[0].repository="missing";assert.equal(validateRepositoryImpactGraph(repo).valid,false);
  const source=rawGraph();source.nodes[0].sourcePath="../outside";assert.equal(validateRepositoryImpactGraph(source).valid,false);
});

test("edges reject dangling self duplicate relation and unsupported relation",()=>{
  const dangling=rawGraph();dangling.edges[0].to="missing";assert.equal(validateRepositoryImpactGraph(dangling).valid,false);
  const self=rawGraph();self.edges[0].to=self.edges[0].from;assert.equal(validateRepositoryImpactGraph(self).valid,false);
  const duplicate=rawGraph();duplicate.edges.push({...duplicate.edges[0],id:"edge:duplicate"});assert.equal(validateRepositoryImpactGraph(duplicate).valid,false);
  const kind=rawGraph();kind.edges[0].kind="OWNS";assert.equal(validateRepositoryImpactGraph(kind).valid,false);
});

test("edge provenance must come from from-node repository at exact declared commit",()=>{
  const repository=rawGraph();repository.edges[1].provenance.repository="api";assert.equal(validateRepositoryImpactGraph(repository).valid,false);
  const commit=rawGraph();commit.edges[1].provenance.commit=API;assert.equal(validateRepositoryImpactGraph(commit).valid,false);
  const source=rawGraph();source.edges[1].provenance.path="../secret";assert.equal(validateRepositoryImpactGraph(source).valid,false);
  const evidence=rawGraph();evidence.edges[1].provenance.evidenceId="bad id";assert.equal(validateRepositoryImpactGraph(evidence).valid,false);
});

test("cross repository dependency is valid when provenance is consumer side",()=>{
  const result=validateRepositoryImpactGraph(rawGraph());assert.equal(result.valid,true);
  const edge=result.graph?.edges.find((item)=>item.id==="edge:consumer-api");
  assert.equal(edge?.from,"consumer:checkout");assert.equal(edge?.to,"api:booking");
  assert.equal(edge?.provenance.repository,"app");assert.equal(edge?.provenance.commit,APP);
});

test("DEPENDENTS reports blast radius through explicit reverse edges",()=>{
  const report=queryRepositoryImpactGraph(rawGraph(),{roots:["contract:booking"],direction:"DEPENDENTS",maxDepth:5});
  const depths=Object.fromEntries(report.nodes.map((node)=>[node.id,node.depth]));
  assert.equal(depths["contract:booking"],0);
  assert.equal(depths["api:booking"],1);
  assert.equal(depths["consumer:checkout"],2);
  assert.equal(depths["route:checkout"],3);
  assert.equal(depths["test:checkout"],4);
  assert.equal("module:pricing" in depths,false);
  assert.equal(report.summary.repositories,2);
  assert.equal(report.edges.every((item)=>item.provenance.commit.length===40),true);
});

test("DEPENDENCIES follows only declared outgoing dependencies",()=>{
  const report=queryRepositoryImpactGraph(rawGraph(),{roots:["test:checkout"],direction:"DEPENDENCIES",maxDepth:6});
  const ids=new Set(report.nodes.map((node)=>node.id));
  for(const expected of ["test:checkout","route:checkout","consumer:checkout","api:booking","contract:booking","module:booking-handler","module:pricing"])assert.equal(ids.has(expected),true);
  assert.equal(report.summary.repositories,3);
});

test("max depth bounds traversal without inventing farther impact",()=>{
  const report=queryRepositoryImpactGraph(rawGraph(),{roots:["contract:booking"],direction:"DEPENDENTS",maxDepth:2});
  assert.deepEqual(report.nodes.map((node)=>[node.id,node.depth]),[["contract:booking",0],["api:booking",1],["consumer:checkout",2]]);
});

test("edge kind filter narrows traversal explicitly",()=>{
  const report=queryRepositoryImpactGraph(rawGraph(),{roots:["api:booking"],direction:"DEPENDENCIES",maxDepth:3,edgeKinds:["IMPLEMENTS"]});
  assert.deepEqual(report.nodes.map((node)=>node.id),["api:booking","contract:booking"]);
  assert.deepEqual(report.edges.map((item)=>item.kind),["IMPLEMENTS"]);
});

test("cycles terminate and retain minimum node depth",()=>{
  const graph=rawGraph();
  graph.edges.push(edge("edge:contract-test","DEPENDS_ON","contract:booking","test:checkout","api",API,"contracts/booking.json","cycle-fixture"));
  const result=validateRepositoryImpactGraph(graph);assert.equal(result.valid,true,JSON.stringify(result.errors));
  const report=queryRepositoryImpactGraph(graph,{roots:["contract:booking"],direction:"DEPENDENTS",maxDepth:12});
  const ids=report.nodes.map((node)=>node.id);
  assert.equal(new Set(ids).size,ids.length);
  assert.equal(report.nodes.find((node)=>node.id==="contract:booking")?.depth,0);
});

test("multiple roots are unique explicit existing nodes",()=>{
  const report=queryRepositoryImpactGraph(rawGraph(),{roots:["contract:booking","module:pricing"],direction:"DEPENDENTS",maxDepth:2});
  assert.equal(report.summary.roots,2);
  assert.equal(report.nodes.filter((node)=>node.root).length,2);
  assert.throws(()=>queryRepositoryImpactGraph(rawGraph(),{roots:["contract:booking","contract:booking"],direction:"DEPENDENTS",maxDepth:2}),/roots/);
  assert.throws(()=>queryRepositoryImpactGraph(rawGraph(),{roots:["missing"],direction:"DEPENDENTS",maxDepth:2}),/roots/);
});

test("invalid direction depth and edge filters fail closed",()=>{
  assert.throws(()=>queryRepositoryImpactGraph(rawGraph(),{roots:["api:booking"],direction:"BOTH",maxDepth:2}),/direction/);
  assert.throws(()=>queryRepositoryImpactGraph(rawGraph(),{roots:["api:booking"],direction:"DEPENDENTS",maxDepth:0}),/maxDepth/);
  assert.throws(()=>queryRepositoryImpactGraph(rawGraph(),{roots:["api:booking"],direction:"DEPENDENTS",maxDepth:2,edgeKinds:["OWNS"]}),/edgeKinds/);
});

test("human output carries provenance without source contents",()=>{
  const report=queryRepositoryImpactGraph(rawGraph(),{roots:["api:booking"],direction:"DEPENDENTS",maxDepth:2});
  const output=formatRepositoryImpactQuery(report);
  assert.match(output,/Repository Impact Graph Query v1/);
  assert.match(output,/src\/checkout\.js/);
  assert.match(output,new RegExp(APP));
  assert.doesNotMatch(output,/function |source payload|business rule/i);
});

test("CLI validates and queries one explicit graph file",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"impact-graph-")),file=path.join(root,"graph.json");
  fs.writeFileSync(file,JSON.stringify(rawGraph()));
  const original=console.log;let stdout="";console.log=(...values)=>{stdout+=values.join(" ")+"\n";};
  try{
    assert.equal(main(["validate","--file",file,"--json"]),0);
    assert.equal(JSON.parse(stdout.trim()).edges.length,6);stdout="";
    assert.equal(main(["query","--file",file,"--root","contract:booking","--direction","DEPENDENTS","--max-depth","3","--json"]),0);
    assert.equal(JSON.parse(stdout.trim()).summary.impactedNodes,3);
  }finally{console.log=original;fs.rmSync(root,{recursive:true,force:true});}
});

test("CLI rejects symlinked graph and malformed command surface",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"impact-graph-link-")),target=path.join(root,"target.json"),link=path.join(root,"graph.json");
  fs.writeFileSync(target,JSON.stringify(rawGraph()));fs.symlinkSync(target,link);
  const original=console.error;console.error=()=>{};
  try{
    assert.equal(main(["validate","--file",link]),1);
    assert.equal(main([]),1);
    assert.equal(main(["query","--file",target,"--root","api:booking"]),1);
  }finally{console.error=original;fs.rmSync(root,{recursive:true,force:true});}
});

test("graph source stays offline read only and has no inference engine",()=>{
  const source=fs.readFileSync(new URL("../scripts/repository-impact-graph.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/node:child_process|spawnSync|execSync|fetch\(|https?:\/\//);
  assert.doesNotMatch(source,/process\.env|Date\.now\(\)/);
  assert.match(source,/caller-supplied validated edges/);
});

test("no relation appears unless an explicit edge exists",()=>{
  const graph=rawGraph();
  graph.edges=graph.edges.filter((/** @type {any} */ item)=>item.id!=="edge:consumer-api");
  const report=queryRepositoryImpactGraph(graph,{roots:["api:booking"],direction:"DEPENDENTS",maxDepth:5});
  assert.deepEqual(report.nodes.map((node)=>node.id),["api:booking"]);
  assert.equal(report.edges.length,0);
});

test("public impact graph template is valid and contains no infrastructure endpoints",()=>{
  const file=new URL("../templates/repository-impact-graph.v1.json",import.meta.url);
  const rawText=fs.readFileSync(file,"utf8"),raw=JSON.parse(rawText);
  const result=validateRepositoryImpactGraph(raw);
  assert.equal(result.valid,true,JSON.stringify(result.errors));
  assert.doesNotMatch(rawText,/endpoint|hostname|remoteAccess|privateNetwork|privateInfrastructure|maintainerService/i);
});
