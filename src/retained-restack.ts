// Detached test-restack composition. Root supplies completed Git-operation captures and owns atomic persistence.
import { isDeepStrictEqual } from "node:util";
import { adoptRetained, pendingWrites, frozenSetId, type WorkCapture, type TrackingState, type TrackingLimits,
  type RetainedCheckpoint, type ScopeTracking, type Disposition, type TrackingPlan, type TrackedMember } from "./retained-work.js";
import type { InvocationJournal } from "./invocations.js";
import type { FrozenMember, Provenance, WorkScope } from "./provenance.js";

type FeatureScope = Extract<WorkScope,{kind:"feature"}>;
type Files = WorkCapture["files"];
export interface RestackSelectors {
  scope: FeatureScope; journal: InvocationJournal;
  oldTestsCheckpointId: string; rewriteCheckpointId: string;
  testPaths: string[]; carriedPaths: string[]; frozenMembers: FrozenMember[];
}
export interface RestackInput extends RestackSelectors {
  provenance: unknown; at: string;
  tests: {capture:WorkCapture;committed:WorkCapture};
  final: {capture:WorkCapture;committed:WorkCapture};
}
type Failure = {ok:false;reason:string};
type Adoption = Extract<TrackingPlan<{provenance:Provenance;dispositions:Disposition[];checkpointId:string}>,{ok:true}>;
export interface RestackGeometry {
  oldTestsCommit:string; rewriteCommit:string; testPaths:string[]; carriedPaths:string[];
  expectedTestFiles:Files; expectedFinalFiles:Files; requiresIndependentCaptures:true;
}
export type RestackPreflight = {ok:true;geometry:RestackGeometry}|Failure;
export type RestackPlan = {ok:true;tests:Adoption;final:Adoption;testCommit:string;dispositions:Disposition[]}|Failure;
type Obj=Record<string,unknown>;
const record=(v:unknown):v is Obj=>!!v&&typeof v==="object"&&!Array.isArray(v);
const hash=(v:unknown):v is string=>typeof v==="string"&&/^[a-f0-9]{64}$/u.test(v);
const commit=(v:unknown):v is string=>typeof v==="string"&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v);
const path=(v:unknown):v is string=>typeof v==="string"&&v.length>0&&v.length<=4096&&!/[\\\u0000-\u001f\u007f-\u009f]/u.test(v)
  &&!v.startsWith("/")&&!/^[a-z]:/iu.test(v)&&v.split("/").every(p=>p!==""&&p!=="."&&p!==".."&&p!==".git");
const sorted=(files:Files):Files=>[...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
const unique=(ids:string[]):string[]=>[...new Set(ids)];
class InvalidRestack extends Error {constructor(readonly reason:string){super(reason);}}
function requireValid(value:unknown,reason="invalid_restack"):asserts value {if(!value)throw new InvalidRestack(reason);}
function fail(error:unknown):Failure{return {ok:false,reason:error instanceof InvalidRestack?error.reason:"invalid_restack"};}
function paths(raw:unknown,bound:number):asserts raw is string[]{
  requireValid(Array.isArray(raw)&&raw.length<=bound,"restack_budget");
  let prior="";for(const p of raw){requireValid(path(p)&&p>prior,"invalid_restack_partition");prior=p;}
}
function sameFile(a:Files[number]|undefined,b:Files[number]|undefined):boolean{
  return a===undefined||b===undefined?a===b:a.path===b.path&&a.sha256===b.sha256&&a.mode===b.mode;
}
function sameIds(a:string[],b:string[]):boolean{
  const left=new Set(a),right=new Set(b);return left.size===a.length&&right.size===b.length&&left.size===right.size&&a.every(id=>right.has(id));
}
interface Prepared {state:TrackingState;index:number;scope:ScopeTracking;old:RetainedCheckpoint;rewrite:RetainedCheckpoint;geometry:RestackGeometry;}
function prepare(raw:unknown,args:RestackSelectors,limits?:Partial<TrackingLimits>):Prepared{
  const checked=pendingWrites(raw,args.journal,args.scope,limits);requireValid(checked.ok,checked.ok?"invalid_restack":checked.reason);
  requireValid(record(args.scope)&&Object.keys(args.scope).length===2&&args.scope.kind==="feature","invalid_restack_scope");
  const index=checked.state.scopes.findIndex(s=>isDeepStrictEqual(s.scope,args.scope)),scope=checked.state.scopes[index];
  requireValid(scope&&hash(args.oldTestsCheckpointId)&&hash(args.rewriteCheckpointId),"invalid_restack_selector");
  const old=scope.checkpoints.find(c=>c.id===args.oldTestsCheckpointId),rewrite=scope.checkpoints.find(c=>c.id===args.rewriteCheckpointId);
  requireValid(old&&rewrite&&scope.baseCheckpointId===rewrite.id&&isDeepStrictEqual(scope.capture,rewrite.capture)
    &&old.selection.subject.kind==="frozen_tests"&&rewrite.selection.subject.kind==="frozen_tests","invalid_restack_selector");
  requireValid(old.capture.complete&&rewrite.capture.complete&&commit(old.capture.head)&&commit(rewrite.capture.head)
    &&old.capture.root===rewrite.capture.root&&old.capture.universe===rewrite.capture.universe&&isDeepStrictEqual(old.capture.scope,rewrite.capture.scope),"invalid_restack_capture");
  requireValid(!scope.intents.some(i=>i.phase==="active")&&sameIds(scope.intents.map(i=>i.jobId),rewrite.unresolvedWriterIds??[]),"restack_pending_gap");
  const eligible=new Set(rewrite.liveWriterIds);
  const recorded=new Map(rewrite.members.map(m=>[m.path,m]));
  requireValid(scope.members.length===rewrite.members.length&&scope.members.every(m=>{
    const prior=recorded.get(m.path),known=m.jobIds.filter(id=>eligible.has(id));
    return prior&&prior.sha256===m.sha256&&prior.mode===m.mode&&sameIds(prior.jobIds,known)
      &&prior.complete===(m.complete&&known.length===m.jobIds.length);
  }),"restack_member_gap");
  const live=new Set(scope.liveWriterIds),pending=new Set(scope.intents.map(i=>i.jobId));
  requireValid(old.liveWriterIds.every(id=>live.has(id))&&old.members.every(m=>m.jobIds.every(id=>live.has(id)))
    &&(old.unresolvedWriterIds??[]).every(id=>pending.has(id)),"restack_author_gap");
  const bound=limits?.maxFiles??100_000,refs=limits?.maxReferences??200_000;
  paths(args.testPaths,bound);paths(args.carriedPaths,bound);
  requireValid(Array.isArray(args.frozenMembers)&&args.frozenMembers.length<=bound
    &&args.testPaths.length+args.carriedPaths.length+args.frozenMembers.length<=refs,"restack_budget");
  const testSet=frozenSetId(args.frozenMembers);
  requireValid(rewrite.selection.subject.testSetId===testSet,"invalid_restack_frozen_set");
  const before=new Map(old.capture.files.map(f=>[f.path,f])),after=new Map(rewrite.capture.files.map(f=>[f.path,f]));
  const changed=[...new Set([...before.keys(),...after.keys()])].filter(p=>!sameFile(before.get(p),after.get(p)));
  const tests=new Set(args.testPaths),carried=new Set(args.carriedPaths);
  requireValid(args.testPaths.every(p=>!carried.has(p))&&changed.length===tests.size+carried.size
    &&changed.every(p=>tests.has(p)||carried.has(p)),"invalid_restack_partition");
  const changedSet=new Set(changed);
  requireValid(args.frozenMembers.every(m=>!changedSet.has(m.path)||tests.has(m.path)),"invalid_restack_test_partition");
  const expected=new Map(before);
  for(const p of tests){const next=after.get(p);if(next)expected.set(p,next);else expected.delete(p);}
  return {state:checked.state,index,scope,old,rewrite,geometry:{
    oldTestsCommit:old.capture.head,rewriteCommit:rewrite.capture.head,testPaths:[...args.testPaths],carriedPaths:[...args.carriedPaths],
    expectedTestFiles:sorted([...expected.values()]),expectedFinalFiles:structuredClone(rewrite.capture.files),requiresIndependentCaptures:true,
  }};
}
/** Geometry only. Does not certify prior provenance, Git completion, a future capture, or reviewer identity. */
export function preflightRetainedRestack(raw:unknown,args:RestackSelectors,limits?:Partial<TrackingLimits>):RestackPreflight{
  try{return {ok:true,geometry:prepare(raw,args,limits).geometry};}catch(error){return fail(error);}
}
function capturePair(pair:RestackInput["tests"],source:WorkCapture,expected:Files,bound:number):void{
  requireValid(record(pair)&&Object.keys(pair).length===2&&record(pair.capture)&&record(pair.committed),"invalid_restack_capture");
  let count=0;
  for(const capture of [pair.capture,pair.committed]){
    requireValid(capture.complete===true&&commit(capture.head)&&capture.root===source.root&&capture.universe===source.universe
      &&isDeepStrictEqual(capture.scope,source.scope)&&Array.isArray(capture.files)&&capture.files.length<=bound,"invalid_restack_capture");
    count+=capture.files.length;
    requireValid(isDeepStrictEqual(capture.files,expected),"restack_tree_mismatch");
  }
  requireValid(count<=bound&&isDeepStrictEqual(pair.capture,pair.committed),"commit_capture_mismatch");
}
function intermediateMembers(source:ScopeTracking,old:RetainedCheckpoint,capture:WorkCapture,frozen:FrozenMember[]):TrackedMember[]{
  const members=new Map<string,TrackedMember>(),files=new Map(capture.files.map(f=>[f.path,f]));
  for(const member of [...old.members,...source.members]){
    const prior=members.get(member.path),file=files.get(member.path);
    members.set(member.path,{path:member.path,sha256:file?.sha256??null,mode:file?.mode??null,
      jobIds:unique([...(prior?.jobIds??[]),...member.jobIds]),complete:false});
  }
  for(const member of frozen)if(!members.has(member.path)){
    const file=files.get(member.path);members.set(member.path,{path:member.path,sha256:file?.sha256??null,mode:file?.mode??null,jobIds:[],complete:false});
  }
  return [...members.values()].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
/** Consumes independent real tests-only/final capture pairs after the controller's exact reaped Git sequence. */
export function planRetainedRestack(raw:unknown,args:RestackInput,limits?:Partial<TrackingLimits>):RestackPlan{
  try{
    const prepared=prepare(raw,args,limits),bound=limits?.maxFiles??100_000;
    capturePair(args.tests,prepared.rewrite.capture,prepared.geometry.expectedTestFiles,bound);
    capturePair(args.final,prepared.rewrite.capture,prepared.geometry.expectedFinalFiles,bound);
    requireValid(args.tests.capture.files.length+args.tests.committed.files.length+args.final.capture.files.length+args.final.committed.files.length<=bound,"restack_budget");
    const middle=structuredClone(prepared.state),scope=middle.scopes[prepared.index]!;
    scope.capture=structuredClone(args.tests.capture);scope.complete=false;
    scope.members=intermediateMembers(prepared.scope,prepared.old,args.tests.capture,args.frozenMembers);
    const subject={kind:"frozen_tests" as const,featureId:args.scope.featureId,testSetId:frozenSetId(args.frozenMembers)};
    const tests=adoptRetained(middle,{scope:args.scope,capture:args.tests.capture,committed:args.tests.committed,subject,
      at:args.at,journal:args.journal,provenance:args.provenance,frozenMembers:args.frozenMembers},limits);
    requireValid(tests.ok,tests.ok?"invalid_restack":tests.reason);
    // Full strict prior/checkpoint validation has now happened through the real intermediate proof.
    const oldTests=tests.provenance.retained?.find(row=>row.kind==="tests"&&isDeepStrictEqual(row.subject,prepared.old.selection.subject)
      &&(Object.hasOwn(row,"revision")?row.revision:null)===prepared.old.selection.revision);
    requireValid(oldTests?.kind==="tests","invalid_restack_selector");
    const rewriteWriteSelection=prepared.rewrite.writesSelection;
    const rewriteWrites=tests.provenance.retained?.find(row=>row.kind==="writes"&&rewriteWriteSelection
      &&isDeepStrictEqual(row.subject,rewriteWriteSelection.subject)
      &&(Object.hasOwn(row,"revision")?row.revision:null)===rewriteWriteSelection.revision);
    requireValid(rewriteWrites?.kind==="writes"&&(!prepared.scope.complete||rewriteWrites.complete),"restack_certainty_increase");
    const changed=new Set([...args.testPaths,...args.carriedPaths]),testPaths=new Set(args.testPaths);
    requireValid(oldTests.members.every(m=>!changed.has(m.path)||testPaths.has(m.path)),"invalid_restack_test_partition");
    const restored=structuredClone(prepared.state);
    restored.scopes[prepared.index]!.checkpoints=structuredClone(tests.state.scopes[prepared.index]!.checkpoints);
    const final=adoptRetained(restored,{scope:args.scope,capture:args.final.capture,committed:args.final.committed,subject,
      at:args.at,journal:args.journal,provenance:tests.provenance,frozenMembers:args.frozenMembers},limits);
    requireValid(final.ok,final.ok?"invalid_restack":final.reason);
    requireValid(!final.state.scopes[prepared.index]!.complete||prepared.scope.complete,"restack_certainty_increase");
    const sourceTests=tests.provenance.retained?.find(row=>row.kind==="tests"&&isDeepStrictEqual(row.subject,prepared.rewrite.selection.subject)
      &&(Object.hasOwn(row,"revision")?row.revision:null)===prepared.rewrite.selection.revision);
    const finalCp=final.state.scopes[prepared.index]!.checkpoints.find(c=>c.id===final.checkpointId)!;
    const finalTests=final.provenance.retained?.find(row=>row.kind==="tests"&&isDeepStrictEqual(row.subject,finalCp.selection.subject)
      &&(Object.hasOwn(row,"revision")?row.revision:null)===finalCp.selection.revision);
    requireValid(sourceTests?.kind==="tests"&&finalTests?.kind==="tests"&&sameIds(sourceTests.jobIds,finalTests.jobIds)
      &&sourceTests.members.length===finalTests.members.length&&(!finalTests.complete||sourceTests.complete),"restack_author_gap");
    const sourceMembers=new Map(sourceTests.members.map(m=>[m.path,m]));
    requireValid(finalTests.members.every(m=>{
      const source=sourceMembers.get(m.path);return source&&source.sha256===m.sha256&&sameIds(source.jobIds,m.jobIds)&&(!m.complete||source.complete);
    }),"restack_certainty_increase");
    const dispositions=[...tests.dispositions,...final.dispositions];
    requireValid(dispositions.every(d=>d.disposition!=="reverted"),"restack_discarded_writer");
    const uniqueDispositions=new Map(dispositions.map(d=>[d.jobId,d]));
    return {ok:true,tests,final,testCommit:args.tests.capture.head!,dispositions:[...uniqueDispositions.values()]};
  }catch(error){return fail(error);}
}
