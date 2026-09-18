#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isFullObjectId } from "./runtime-evidence.js";

const ID=/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/;
const NODE_KINDS=new Set(["API","CONTRACT","CANONICAL_MODULE","TEST","ROUTE","CONSUMER"]);
const EDGE_KINDS=new Set(["CONSUMES","IMPLEMENTS","TESTS","ROUTES_TO","IMPORTS","DEPENDS_ON"]);
const DIRECTIONS=new Set(["DEPENDENTS","DEPENDENCIES"]);
const MAX_FILE_BYTES=8*1024*1024;

/** @param {unknown} value @returns {value is Record<string,unknown>} */
function object(value){return typeof value==="object"&&value!==null&&!Array.isArray(value)&&(Object.getPrototypeOf(value)===Object.prototype||Object.getPrototypeOf(value)===null);}
/** @param {unknown} value @param {number} [max] */
function text(value,max=512){if(typeof value!=="string")return null;const normalized=value.trim();return normalized.length>0&&normalized.length<=max&&!/[\u0000\r\n]/.test(normalized)?normalized:null;}
/** @param {unknown} value @param {number} [max] */
function portableId(value,max=192){const normalized=text(value,max);return normalized&&ID.test(normalized)?normalized:null;}
/** @param {unknown} value */
function safePath(value){const normalized=text(value,1024);if(!normalized||path.isAbsolute(normalized)||normalized.includes("\\"))return null;const posix=path.posix.normalize(normalized);return posix!=="."&&posix!==".."&&!posix.startsWith("../")&&posix===normalized?normalized:null;}
/** @param {Record<string,unknown>} value @param {string[]} allowed @param {string} scope @param {Array<{id:string,detail:string}>} errors */
function rejectUnknown(value,allowed,scope,errors){for(const key of Object.keys(value))if(!allowed.includes(key))errors.push({id:scope+"-field-unknown",detail:scope+" contains unsupported field \""+key+"\""});}
/** @param {unknown} value @param {number} min @param {number} max */
function integer(value,min,max){return Number.isSafeInteger(value)&&Number(value)>=min&&Number(value)<=max?Number(value):null;}

/** @param {unknown} value */
export function validateRepositoryImpactGraph(value){
  /** @type {Array<{id:string,detail:string}>} */ const errors=[];
  if(!object(value))return{valid:false,graph:null,errors:[{id:"graph-invalid",detail:"repository impact graph must be an object"}]};
  rejectUnknown(value,["version","repositories","nodes","edges"],"graph",errors);
  if(value.version!==1)errors.push({id:"version-invalid",detail:"graph version must be exactly 1"});

  /** @type {Array<{id:string,commit:string}>} */ const repositories=[];
  const repositoryMap=new Map();
  if(!Array.isArray(value.repositories)||value.repositories.length===0||value.repositories.length>256)errors.push({id:"repositories-invalid",detail:"repositories must be a non-empty bounded array"});
  else for(const [index,raw] of value.repositories.entries()){
    if(!object(raw)){errors.push({id:"repository-invalid",detail:"repositories["+index+"] must be an object"});continue;}
    rejectUnknown(raw,["id","commit"],"repository",errors);
    const repositoryId=portableId(raw.id,128),commit=text(raw.commit,128)?.toLowerCase()??null;
    if(!repositoryId||repositoryMap.has(repositoryId)||!commit||!isFullObjectId(commit)){errors.push({id:"repository-fields-invalid",detail:"repositories["+index+"] requires unique id and full commit"});continue;}
    const repository={id:repositoryId,commit};repositories.push(repository);repositoryMap.set(repositoryId,repository);
  }

  /** @type {Array<any>} */ const nodes=[];
  const nodeMap=new Map();
  if(!Array.isArray(value.nodes)||value.nodes.length===0||value.nodes.length>4096)errors.push({id:"nodes-invalid",detail:"nodes must be a non-empty bounded array"});
  else for(const [index,raw] of value.nodes.entries()){
    if(!object(raw)){errors.push({id:"node-invalid",detail:"nodes["+index+"] must be an object"});continue;}
    rejectUnknown(raw,["id","kind","repository","locator","sourcePath"],"node",errors);
    const nodeId=portableId(raw.id),kind=text(raw.kind,32),repository=portableId(raw.repository,128),locator=text(raw.locator,512);
    const sourcePath=raw.sourcePath===null?null:safePath(raw.sourcePath);
    if(!nodeId||nodeMap.has(nodeId)||!kind||!NODE_KINDS.has(kind)||!repository||!repositoryMap.has(repository)||!locator||(raw.sourcePath!==null&&!sourcePath)){errors.push({id:"node-fields-invalid",detail:"nodes["+index+"] has invalid identity, kind, repository, locator, or sourcePath"});continue;}
    const node={id:nodeId,kind,repository,locator,sourcePath};nodes.push(node);nodeMap.set(nodeId,node);
  }

  /** @type {Array<any>} */ const edges=[];
  const edgeIds=new Set(),edgeTuples=new Set();
  if(!Array.isArray(value.edges)||value.edges.length===0||value.edges.length>16384)errors.push({id:"edges-invalid",detail:"edges must be a non-empty bounded array"});
  else for(const [index,raw] of value.edges.entries()){
    if(!object(raw)){errors.push({id:"edge-invalid",detail:"edges["+index+"] must be an object"});continue;}
    rejectUnknown(raw,["id","kind","from","to","provenance"],"edge",errors);
    const edgeId=portableId(raw.id),kind=text(raw.kind,32),from=portableId(raw.from),to=portableId(raw.to);
    if(!edgeId||edgeIds.has(edgeId)||!kind||!EDGE_KINDS.has(kind)||!from||!to||from===to||!nodeMap.has(from)||!nodeMap.has(to)){errors.push({id:"edge-fields-invalid",detail:"edges["+index+"] has invalid or duplicate identity, relation, or node references"});continue;}
    const tuple=kind+"\u0000"+from+"\u0000"+to;
    if(edgeTuples.has(tuple)){errors.push({id:"edge-duplicate",detail:"edges["+index+"] duplicates the same relation"});continue;}
    let provenance=null;
    if(!object(raw.provenance))errors.push({id:"edge-provenance-invalid",detail:"edges["+index+"].provenance must be an object"});
    else{
      rejectUnknown(raw.provenance,["repository","commit","path","evidenceId"],"edge-provenance",errors);
      const repository=portableId(raw.provenance.repository,128),commit=text(raw.provenance.commit,128)?.toLowerCase()??null;
      const sourcePath=safePath(raw.provenance.path),evidenceId=portableId(raw.provenance.evidenceId);
      const fromNode=nodeMap.get(from),declared=repository?repositoryMap.get(repository):null;
      if(!repository||!declared||!commit||!isFullObjectId(commit)||commit!==declared.commit||!sourcePath||!evidenceId||fromNode?.repository!==repository){
        errors.push({id:"edge-provenance-fields-invalid",detail:"edges["+index+"] provenance must bind the from-node repository, exact declared commit, safe source path, and evidence id"});
      }else provenance={repository,commit,path:sourcePath,evidenceId};
    }
    if(provenance){edgeIds.add(edgeId);edgeTuples.add(tuple);edges.push({id:edgeId,kind,from,to,provenance});}
  }
  if(errors.length||repositories.length===0||nodes.length===0||edges.length===0)return{valid:false,graph:null,errors};
  return{valid:true,graph:{version:1,repositories:repositories.sort((a,b)=>a.id.localeCompare(b.id)),nodes:nodes.sort((a,b)=>a.id.localeCompare(b.id)),edges:edges.sort((a,b)=>a.id.localeCompare(b.id))},errors:[]};
}

/** @param {any} graph @param {{roots:string[],direction:string,maxDepth:number,edgeKinds?:string[]}} query */
export function queryRepositoryImpactGraph(graph,query){
  const validated=validateRepositoryImpactGraph(graph);
  if(!validated.valid||!validated.graph)throw new Error("repository impact graph is invalid");
  const normalized=validated.graph,direction=text(query.direction,32),maxDepth=integer(query.maxDepth,1,12);
  if(!direction||!DIRECTIONS.has(direction)||maxDepth===null||!Array.isArray(query.roots)||query.roots.length===0||query.roots.length>64)throw new Error("impact query direction, roots, or maxDepth is invalid");
  const nodeMap=/** @type {Map<string,any>} */(new Map(normalized.nodes.map((node)=>[node.id,node])));
  const repositoryMap=/** @type {Map<string,any>} */(new Map(normalized.repositories.map((repo)=>[repo.id,repo])));
  const roots=query.roots.map((root)=>portableId(root));
  if(roots.some((root)=>!root||!nodeMap.has(root))||new Set(roots).size!==roots.length)throw new Error("impact query roots must be unique existing node ids");
  const allowedKinds=query.edgeKinds===undefined?[...EDGE_KINDS]:query.edgeKinds.map((kind)=>text(kind,32));
  if(allowedKinds.length===0||allowedKinds.some((kind)=>!kind||!EDGE_KINDS.has(kind))||new Set(allowedKinds).size!==allowedKinds.length)throw new Error("impact query edgeKinds is invalid");
  const kindSet=new Set(allowedKinds);
  const adjacency=/** @type {Map<string,Array<{edge:any,next:string}>>} */(new Map());
  for(const edge of normalized.edges){
    if(!kindSet.has(edge.kind))continue;
    const key=direction==="DEPENDENCIES"?edge.from:edge.to;
    const next=direction==="DEPENDENCIES"?edge.to:edge.from;
    const bucket=adjacency.get(key);
    if(bucket)bucket.push({edge,next});else adjacency.set(key,[{edge,next}]);
  }
  for(const values of adjacency.values())values.sort((a,b)=>a.edge.id.localeCompare(b.edge.id));
  const depths=/** @type {Map<string,number>} */(new Map());
  const queue=/** @type {string[]} */([]);
  for(const root of /** @type {string[]} */(roots)){depths.set(root,0);queue.push(root);}
  /** @type {Map<string,any>} */ const traversedEdges=new Map();
  for(let cursor=0;cursor<queue.length;cursor+=1){
    const current=queue[cursor];if(!current)continue;const depth=depths.get(current)??0;
    if(depth>=maxDepth)continue;
    for(const item of adjacency.get(current)??[]){
      traversedEdges.set(item.edge.id,item.edge);
      const nextDepth=depth+1,previous=depths.get(item.next);
      if(previous===undefined||nextDepth<previous){depths.set(item.next,nextDepth);queue.push(item.next);}
    }
  }
  const impactedNodes=[...depths.entries()].map(([nodeId,depth])=>{
    const node=nodeMap.get(nodeId);if(!node)throw new Error("impact query node lookup failed");
    const repository=repositoryMap.get(node.repository);if(!repository)throw new Error("impact query repository lookup failed");
    return{...node,commit:repository.commit,depth,root:depth===0};
  }).sort((a,b)=>a.depth-b.depth||a.id.localeCompare(b.id));
  const edges=[...traversedEdges.values()].sort((a,b)=>a.id.localeCompare(b.id));
  return{
    version:1,direction,roots:/** @type {string[]} */(roots).sort(),maxDepth,edgeKinds:/** @type {string[]} */(allowedKinds).sort(),
    nodes:impactedNodes,edges,
    summary:{roots:roots.length,impactedNodes:impactedNodes.filter((node)=>!node.root).length,traversedEdges:edges.length,repositories:new Set(impactedNodes.map((node)=>node.repository)).size},
    technicalStatus:"PASS",
    semantics:"deterministic traversal of explicit graph edges only; no dependency, canonicality, ownership, or business relationship is inferred beyond caller-supplied validated edges",
  };
}

/** @param {any} report */
export function formatRepositoryImpactQuery(report){
  const lines=["Repository Impact Graph Query v1","",
    "Direction: "+report.direction,
    "Roots: "+report.roots.join(", "),
    "Max depth: "+report.maxDepth,
    "Impacted nodes: "+report.summary.impactedNodes,
    "Repositories: "+report.summary.repositories,""];
  for(const node of report.nodes)lines.push(String(node.depth).padStart(2)+"  "+node.kind.padEnd(16)+"  "+node.id+"  "+node.repository+"@"+node.commit);
  lines.push("","Edges: "+report.edges.length);
  for(const edge of report.edges)lines.push(edge.kind.padEnd(12)+"  "+edge.from+" -> "+edge.to+"  "+edge.provenance.repository+"@"+edge.provenance.commit+" "+edge.provenance.path+" ["+edge.provenance.evidenceId+"]");
  lines.push("","Semantics: "+report.semantics);
  return lines.join("\n");
}

/** @param {string} filename */
function readGraphFile(filename){
  const resolved=path.resolve(filename);let stat;
  try{stat=fs.lstatSync(resolved);}catch{throw new Error("impact graph file cannot be read");}
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size<1||stat.size>MAX_FILE_BYTES)throw new Error("impact graph input must be a bounded regular non-symlink file");
  try{return JSON.parse(fs.readFileSync(resolved,"utf8"));}catch{throw new Error("impact graph input cannot be parsed");}
}

/** @param {string[]} argv */
function parse(argv){
  const mode=argv[0];if(!["validate","query"].includes(mode??""))return null;
  const values=new Map(),roots=[],edgeKinds=[];let json=false;
  const allowed=new Set(["--file","--direction","--max-depth","--root","--edge-kind"]);
  for(let index=1;index<argv.length;index+=1){
    const arg=argv[index];
    if(arg==="--json"){if(json)return null;json=true;continue;}
    if(!allowed.has(arg??""))return null;
    const next=argv[index+1];if(typeof next!=="string"||next.startsWith("--"))return null;
    index+=1;
    if(arg==="--root"){roots.push(next);continue;}
    if(arg==="--edge-kind"){edgeKinds.push(next);continue;}
    if(values.has(arg))return null;values.set(arg,next);
  }
  if(!values.has("--file"))return null;
  if(mode==="query"&&(!values.has("--direction")||!values.has("--max-depth")||roots.length===0))return null;
  if(mode==="validate"&&(values.size!==1||roots.length||edgeKinds.length))return null;
  return{mode,file:values.get("--file"),direction:values.get("--direction"),maxDepth:values.get("--max-depth"),roots,edgeKinds,json};
}

export function main(argv=process.argv.slice(2)){
  const options=parse(argv);
  if(!options){console.error("Usage: node scripts/repository-impact-graph.js validate --file <graph.json> [--json] | query --file <graph.json> --root <node-id> [--root <node-id> ...] --direction <DEPENDENTS|DEPENDENCIES> --max-depth <1-12> [--edge-kind <kind> ...] [--json]");return 1;}
  try{
    const raw=readGraphFile(options.file);
    if(options.mode==="validate"){
      const result=validateRepositoryImpactGraph(raw);
      if(!result.valid||!result.graph)throw new Error("repository impact graph is invalid");
      const output=["Repository Impact Graph v1","",
        "Repositories: "+result.graph.repositories.length,
        "Nodes: "+result.graph.nodes.length,
        "Edges: "+result.graph.edges.length,
        "Result: VALID"].join("\n");
      console.log(options.json?JSON.stringify(result.graph):output);return 0;
    }
    const report=queryRepositoryImpactGraph(raw,{roots:options.roots,direction:options.direction,maxDepth:Number(options.maxDepth),...(options.edgeKinds.length?{edgeKinds:options.edgeKinds}:{})});
    console.log(options.json?JSON.stringify(report):formatRepositoryImpactQuery(report));return 0;
  }catch(error){console.error(error instanceof Error?error.message:"repository impact graph operation failed");return 1;}
}

if(import.meta.url===pathToFileURL(path.resolve(process.argv[1]??"")).href)process.exitCode=main();
