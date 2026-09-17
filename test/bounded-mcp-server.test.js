import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";

import {
  BOUNDED_MCP_TOOL_NAMES,
  createBoundedMcpServer,
  invokeBoundedToolkitOperation,
} from "../scripts/bounded-mcp-server.js";

const COMMIT = "a".repeat(40);

/** @returns {any} */
function rawTask(){return{version:1,id:"task:mcp",role:"diagnose",repository:{id:"demo",baseCommit:COMMIT},createdAt:"2026-09-17T15:00:00Z",risk:"LOW",objective:"Validate bounded MCP behavior",authority:{filesystem:"READ_ONLY",shell:"NONE",network:"NONE",merge:false,deploy:false,productionMutation:false},scope:{allowedPaths:["src/**"],deniedPaths:[],requiredChecks:["test"]},dependsOn:[]};}
/** @returns {any} */
function rawRoles(){return{version:1,roles:[{id:"diagnose",maxRisk:"CRITICAL",authority:{filesystem:"READ_ONLY",shell:"BOUNDED",network:"NONE"},writeMode:"NONE"}]};}
/** @param {string} repository @param {string} version */
function inventory(repository,version){return{version:1,repository,contracts:[{id:"example-contract",version}]};}
/** @returns {any} */
function crossPolicy(){return{version:1,requirements:[{contractId:"example-contract",repositories:["provider","consumer"],expectedVersion:"v2"}]};}
test("bounded MCP allowlist contains only five deterministic read-only operations",()=>{
  assert.deepEqual(BOUNDED_MCP_TOOL_NAMES,["evaluate-agent-corpus","inspect-agent-role-policy","inspect-cross-repository-contracts","validate-agent-task","validate-contract-inventory"]);
  assert.equal(BOUNDED_MCP_TOOL_NAMES.some((name)=>/shell|exec|file|network|write|deploy|merge|package/.test(name)),false);
});

test("direct dispatcher validates Agent Task without filesystem input",()=>{
  const result=invokeBoundedToolkitOperation("validate-agent-task",{task:rawTask()});
  assert.equal(result.ok,true,JSON.stringify(result.errors));assert.equal(result.operation,"validate-agent-task");const output=/** @type {any} */(result.result);assert.equal(output.id,"task:mcp");
});

test("direct dispatcher composes task and role policy deterministically",()=>{
  const result=invokeBoundedToolkitOperation("inspect-agent-role-policy",{task:rawTask(),policy:rawRoles()});
  assert.equal(result.ok,true,JSON.stringify(result.errors));const output=/** @type {any} */(result.result);assert.equal(output.overallStatus,"PASS");assert.equal(output.leaseRequired,false);
});

test("contract inventory and cross-repository audit are pure bounded operations",()=>{
  const one=invokeBoundedToolkitOperation("validate-contract-inventory",{inventory:inventory("provider","v2")});assert.equal(one.ok,true);
  const cross=invokeBoundedToolkitOperation("inspect-cross-repository-contracts",{policy:crossPolicy(),inventories:[inventory("provider","v2"),inventory("consumer","v1")]});
  assert.equal(cross.ok,true);const output=/** @type {any} */(cross.result);assert.equal(output.overallStatus,"FAIL");assert.equal(output.checks[0].id,"contract-version-mismatch");
});
test("agent evaluation corpus remains deterministic through MCP operation wrapper",()=>{
  const corpus=JSON.parse(fs.readFileSync(new URL("../evaluation/agent-corpus.v1.json",import.meta.url),"utf8"));
  const run=JSON.parse(fs.readFileSync(new URL("../evaluation/agent-reference-run.v1.json",import.meta.url),"utf8"));
  const result=invokeBoundedToolkitOperation("evaluate-agent-corpus",{corpus,run});
  assert.equal(result.ok,true,JSON.stringify(result.errors));const output=/** @type {any} */(result.result);assert.equal(output.overallStatus,"PASS");assert.deepEqual(output.summary,{pass:3,fail:0});
});

test("dispatcher rejects unknown operations strict extra fields and oversized payloads",()=>{
  assert.equal(invokeBoundedToolkitOperation("shell",{}).ok,false);
  assert.equal(invokeBoundedToolkitOperation("validate-agent-task",{task:rawTask(),command:"rm -rf /"}).ok,false);
  const huge="x".repeat(1024*1024+1);const bounded=invokeBoundedToolkitOperation("validate-agent-task",{task:{...rawTask(),objective:huge}});assert.equal(bounded.ok,false);assert.equal(bounded.errors[0]?.id,"input-bounds-invalid");
});

test("dispatcher rejects excessive nesting before toolkit validation",()=>{
  let nested={};for(let i=0;i<40;i+=1)nested={value:nested};
  const result=invokeBoundedToolkitOperation("validate-agent-task",{task:nested});assert.equal(result.ok,false);assert.equal(result.errors[0]?.id,"input-bounds-invalid");
});

async function connectedPair(){
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  const server=createBoundedMcpServer();const client=new Client({name:"bounded-mcp-test",version:"1.0.0"});
  await server.connect(serverTransport);await client.connect(clientTransport);
  return{server,client};
}
test("real MCP tools/list exposes exact allowlist with read-only annotations",async()=>{
  const pair=await connectedPair();
  try{
    const listed=await pair.client.listTools();
    assert.deepEqual(listed.tools.map((tool)=>tool.name).sort(),BOUNDED_MCP_TOOL_NAMES);
    for(const tool of listed.tools){assert.equal(tool.annotations?.readOnlyHint,true);assert.equal(tool.annotations?.destructiveHint,false);assert.equal(tool.annotations?.idempotentHint,true);assert.equal(tool.annotations?.openWorldHint,false);}
  }finally{await pair.client.close();await pair.server.close();}
});

test("real MCP tools/call runs through SDK schema and toolkit validation",async()=>{
  const pair=await connectedPair();
  try{
    await pair.client.listTools();
    const called=await pair.client.callTool({name:"validate-agent-task",arguments:{task:rawTask()}});
    assert.equal(called.isError,false);const structured=/** @type {any} */(called.structuredContent);assert.equal(structured.ok,true);assert.equal(structured.operation,"validate-agent-task");assert.equal(structured.result.id,"task:mcp");
  }finally{await pair.client.close();await pair.server.close();}
});

test("real MCP schema rejects extra command-like fields",async()=>{
  const pair=await connectedPair();
  try{
    await pair.client.listTools();
    const called=await pair.client.callTool({name:"validate-agent-task",arguments:{task:rawTask(),command:"whoami"}});
    assert.equal(called.isError,true);assert.match(called.content[0]?.type==="text"?called.content[0].text:"",/Unrecognized key/);
  }finally{await pair.client.close();await pair.server.close();}
});
test("bounded MCP source has no shell filesystem network env or mutation executor",()=>{
  const source=fs.readFileSync(new URL("../scripts/bounded-mcp-server.js",import.meta.url),"utf8");
  assert.doesNotMatch(source,/node:child_process|spawnSync|execSync|execFileSync/);assert.doesNotMatch(source,/node:fs|readFileSync|writeFileSync|unlinkSync|renameSync/);assert.doesNotMatch(source,/process\.env|fetch\(|https?:\/\//);assert.doesNotMatch(source,/deployAuthorized:\s*true|mergeAuthorized:\s*true|productionMutationAuthorized:\s*true/);
  assert.match(source,/serveStdio/);assert.doesNotMatch(source,/StreamableHTTP|createMcpHandler|WebStandard/);
});

test("MCP runtime dependencies are exactly pinned and client is test-only",()=>{
  const pkg=JSON.parse(fs.readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  assert.equal(pkg.dependencies?.["@modelcontextprotocol/server"],"2.0.0");assert.equal(pkg.dependencies?.zod,"4.6.5");assert.equal(pkg.devDependencies?.["@modelcontextprotocol/client"],"2.0.0");
});
