import { describe,it,expect } from "vitest";
import { preflightRetainedRestack,planRetainedRestack,type RestackPlan } from "./retained-restack.js";
import { initializeTracking,beginWriter,finishWriter,adoptRetained,reconcileRestore,recoverInterruptedWriter,frozenSetId,type WorkCapture,type TrackingPlan,type TrackingState } from "./retained-work.js";
import { recoverInvocations,type InvocationEntry,type InvocationJournal } from "./invocations.js";
const A="a".repeat(40),O="b".repeat(40),R="c".repeat(40),T="d".repeat(40),F="e".repeat(40);
const H="1".repeat(64),I="2".repeat(64),J="3".repeat(64),AT="2026-10-31T00:00:00.000Z";
const SCOPE={kind:"feature",featureId:"one"} as const;
const identity=(family:"claude"|"codex")=>({provider:family,family,model:"recorded"});
const sorted=(files:WorkCapture["files"])=>[...files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
const capture=(files:WorkCapture["files"],head=A):WorkCapture=>({scope:SCOPE,root:"/work/feature",universe:"git-source-v1",complete:true,head,files:sorted(files)});
const journal=(entries:InvocationEntry[]):InvocationJournal=>({version:1,legacyAgentRuns:0,legacyInterruptionCounts:{},entries,recoveries:[],interruptionCounts:{}});
function ok<T extends object>(v:TrackingPlan<T>):Extract<TrackingPlan<T>,{ok:true}>{if(!v.ok)throw Error(v.reason);return v;}
const entry=(id:string,stage:"build"|"test_author",family:"claude"|"codex"):InvocationEntry=>({jobId:id,label:id,role:stage==="build"?"engineer":"test_author",scope:SCOPE,stage,access:"workspace-write",reservedAt:AT,candidate:identity(family),observation:{at:AT,actual:identity(family),outcome:"ok"},cleanedAt:AT,writeDisposition:"pending"});
function run(state:TrackingState,before:WorkCapture,after:WorkCapture,e:InvocationEntry){
 state=ok(beginWriter(state,{jobId:e.jobId,scope:SCOPE,stage:e.stage,before,frozenPaths:[]})).state;
 return ok(finishWriter(state,{jobId:e.jobId,after,journal:journal([e]),testPaths:[...new Set([...before.files,...after.files].filter(f=>f.path.endsWith(".test.ts")).map(f=>f.path))]})).state;
}
function freeze(state:TrackingState,cap:WorkCapture,j:InvocationJournal,prior:unknown){
 const members=cap.files.filter(f=>f.path.endsWith(".test.ts")).map(f=>({path:f.path,sha256:f.sha256}));
 return ok(adoptRetained(state,{scope:SCOPE,capture:cap,committed:structuredClone(cap),subject:{kind:"frozen_tests",featureId:"one",testSetId:frozenSetId(members)},at:AT,journal:j,provenance:prior,frozenMembers:members}));
}
function fixture(opts:{unknown?:boolean;emptyCarried?:boolean;deletions?:boolean;modes?:boolean;discardOld?:boolean;partial?:boolean}={}){
 const baseline=capture(opts.deletions?[{path:"remove.ts",sha256:H,mode:"100644"}]:[]);
 let state=ok(initializeTracking(baseline,opts.partial?{}:{freshBaseline:{head:A,beforeMissionWrites:true,noRetainedAiWriters:true}})).state;
 const bootstrap=ok(adoptRetained(state,{scope:SCOPE,capture:baseline,committed:structuredClone(baseline),subject:{kind:"feature_commit",featureId:"one",commit:A},at:AT,journal:journal([]),provenance:undefined}));
 const first=entry("first","test_author","claude");
 const oldFiles=sorted([...baseline.files,{path:"check.test.ts",sha256:H,mode:"100644"},...(opts.deletions?[{path:"gone.test.ts",sha256:H,mode:"100755" as const}]:[])]);
 state=run(bootstrap.state,baseline,capture(oldFiles),first);
 const old=freeze(state,capture(oldFiles,O),journal([first]),bootstrap.provenance);first.writeDisposition="adopted";
 let before=old.state.scopes[0]!.capture, provenance=old.provenance,j=journal([first]);state=old.state;
 if(opts.discardOld){state=ok(reconcileRestore(state,{scope:SCOPE,checkpointId:bootstrap.checkpointId,after:baseline,provenance})).state;first.writeDisposition="reverted";before=baseline;}
 if(opts.unknown){
  const unknown=entry("unknown","test_author","claude");delete unknown.observation;delete unknown.cleanedAt;
  state=ok(beginWriter(state,{jobId:unknown.jobId,scope:SCOPE,stage:"test_author",before,frozenPaths:[]})).state;
  const m={agentRuns:j.entries.length+1,invocations:{...j,entries:[...j.entries,unknown]}};recoverInvocations(m,undefined,{},AT,()=>{});j=m.invocations;
  const after=capture(before.files.map(f=>f.path==="check.test.ts"?{...f,sha256:I}:f),before.head!);
  state=ok(recoverInterruptedWriter(state,{jobId:unknown.jobId,after,journal:j,reap:{jobId:unknown.jobId,recoveryKey:"job:unknown",at:AT},testPaths:["check.test.ts"]})).state;before=after;
 }
 if(!opts.emptyCarried){
  const builder=entry("builder","build","codex");
  const after=capture([...before.files.filter(f=>f.path!=="remove.ts"),{path:"app.ts",sha256:H,mode:opts.modes?"100755":"100644"}],before.head!);
  state=run(state,before,after,builder);j.entries.push(builder);before=after;
 }
 const last=entry("last","test_author","codex");
 const newCheck={path:"check.test.ts",sha256:opts.unknown?J:I,mode:opts.modes?"100755":"100644"} as const;
 const after=capture([...before.files.filter(f=>f.path!=="check.test.ts"&&f.path!=="gone.test.ts"),newCheck],before.head!);
 state=run(state,before,after,last);j.entries.push(last);
 const rewrite=freeze(state,capture(after.files,R),j,provenance);
 for(const d of rewrite.dispositions){const row=j.entries.find(e=>e.jobId===d.jobId)!;row.writeDisposition=d.disposition;}
 const frozen=after.files.filter(f=>f.path.endsWith(".test.ts")).map(f=>({path:f.path,sha256:f.sha256}));
 const testFiles=sorted([...old.state.scopes[0]!.capture.files.filter(f=>!f.path.endsWith(".test.ts")),...after.files.filter(f=>f.path.endsWith(".test.ts"))]);
 const testsCapture=capture(testFiles,T), finalCapture=capture(after.files,opts.emptyCarried?T:F);
 const args={scope:SCOPE,journal:j,provenance:rewrite.provenance,oldTestsCheckpointId:old.checkpointId,rewriteCheckpointId:rewrite.checkpointId,
  testPaths:opts.deletions?["check.test.ts","gone.test.ts"]:["check.test.ts"],
  carriedPaths:opts.emptyCarried?[]:opts.deletions?["app.ts","remove.ts"]:["app.ts"],
  frozenMembers:frozen,at:AT,tests:{capture:testsCapture,committed:structuredClone(testsCapture)},final:{capture:finalCapture,committed:structuredClone(finalCapture)}};
 return {state:rewrite.state,args,rewrite,old,first,last};
}
function selectedTests(plan:Extract<RestackPlan,{ok:true}>["final"]){
 const cp=plan.state.scopes[0]!.checkpoints.find(c=>c.id===plan.checkpointId)!;
 const row=plan.provenance.retained!.find(r=>r.kind==="tests"&&JSON.stringify(r.subject)===JSON.stringify(cp.selection.subject)
  &&(Object.hasOwn(r,"revision")?r.revision:null)===cp.selection.revision);
 if(!row||row.kind!=="tests")throw Error("missing selected test snapshot");return row;
}
describe("pure retained test restack",()=>{
 it("preflights exact geometry without inventing an observed future capture",()=>{
  const f=fixture(), result=preflightRetainedRestack(f.state,f.args);
  expect(result.ok).toBe(true);
  if(result.ok){expect(result.geometry.oldTestsCommit).toBe(O);expect(result.geometry.rewriteCommit).toBe(R);
   expect(result.geometry.expectedTestFiles).toEqual(f.args.tests.capture.files);
   expect(result.geometry.expectedFinalFiles).toEqual(f.args.final.capture.files);expect(result.geometry.requiresIndependentCaptures).toBe(true);}
 });
 it("retains builder and both authors, with conservative intermediate and original final certainty",()=>{
  const f=fixture(), before=JSON.stringify(f), result=planRetainedRestack(f.state,f.args);
  expect(result.ok).toBe(true);
  if(result.ok){
   expect(result.testCommit).toBe(T);expect(result.tests.state.scopes[0]!.complete).toBe(false);
   const final=selectedTests(result.final);expect(final.kind).toBe("tests");expect(final.jobIds).toEqual(["first","last"]);expect(final.complete).toBe(true);
   expect(result.final.state.scopes[0]!.liveWriterIds).toEqual(["first","builder","last"]);
   expect(result.final.provenance.entries.find((e:any)=>e.jobId==="first")!.subject).toEqual(f.old.provenance.entries[0]!.subject);
   expect(result.final.state.scopes[0]!.capture.files).toEqual(f.args.final.capture.files);
  }
  expect(JSON.stringify(f)).toBe(before);
 });
 it("unknown surviving writers remain unresolved and partial, never reverted",()=>{
  const f=fixture({unknown:true}),result=planRetainedRestack(f.state,f.args);expect(result.ok).toBe(true);
  if(result.ok){expect(result.final.state.scopes[0]!.complete).toBe(false);
   expect(result.final.state.scopes[0]!.intents.map((i:any)=>i.jobId)).toEqual(["unknown"]);
   expect(selectedTests(result.final).jobIds).toEqual(["first","last"]);
   expect(selectedTests(result.final).complete).toBe(false);
   expect(result.dispositions.some((d:any)=>d.jobId==="unknown")).toBe(false);}
 });
 it("handles deletion in both partitions and exact executable modes",()=>{
  const f=fixture({deletions:true,modes:true}),result=planRetainedRestack(f.state,f.args);expect(result.ok).toBe(true);
  if(result.ok){expect(result.tests.state.scopes[0]!.capture.files).toEqual(f.args.tests.capture.files);
   expect(result.final.state.scopes[0]!.capture.files).toEqual(f.args.final.capture.files);
   expect(result.final.state.scopes[0]!.capture.files.find((p:any)=>p.path==="check.test.ts")!.mode).toBe("100755");}
 });
 it("allows an empty carried partition with the same final test-only commit",()=>{
  const f=fixture({emptyCarried:true}),r=planRetainedRestack(f.state,f.args);expect(r.ok).toBe(true);
  if(r.ok){expect(r.testCommit).toBe(T);expect(r.final.state.scopes[0]!.capture.head).toBe(T);}
 });
 it.each(["missing","overlap","duplicate","extra","escape","order"] as const)("rejects invalid %s partition before Git",kind=>{
  const f:any=fixture();
  if(kind==="missing")f.args.carriedPaths=[];
  if(kind==="overlap")f.args.carriedPaths=["app.ts","check.test.ts"];
  if(kind==="duplicate")f.args.testPaths.push("check.test.ts");
  if(kind==="extra")f.args.testPaths.push("unchanged.test.ts");
  if(kind==="escape")f.args.testPaths=["../outside"];
  if(kind==="order")f.args.carriedPaths=["z.ts","app.ts"];
  expect(preflightRetainedRestack(f.state,f.args).ok).toBe(false);expect(planRetainedRestack(f.state,f.args).ok).toBe(false);
 });
 it.each(["tests-tree","final-tree","committed","root","scope","frozen","selector","rewrite-basis","revision","provenance"] as const)("rejects %s without modifying caller state",kind=>{
  const f:any=fixture();
  if(kind==="tests-tree")f.args.tests.capture.files=f.args.tests.committed.files=[];
  if(kind==="final-tree")f.args.final.capture.files=f.args.final.committed.files=[];
  if(kind==="committed")f.args.final.committed.files=[];
  if(kind==="root")f.args.tests.capture.root=f.args.tests.committed.root="/elsewhere";
  if(kind==="scope")f.args.final.capture.scope=f.args.final.committed.scope={kind:"feature",featureId:"other"};
  if(kind==="frozen")f.args.frozenMembers[0].sha256=H;
  if(kind==="selector")f.args.oldTestsCheckpointId=H;
  if(kind==="rewrite-basis")f.args.rewriteCheckpointId=f.old.checkpointId;
  if(kind==="revision")f.args.provenance.retained.find((r:any)=>r.kind==="tests").revision=999;
  if(kind==="provenance")f.args.provenance.version=999;
  const before=JSON.stringify(f);expect(planRetainedRestack(f.state,f.args).ok).toBe(false);expect(JSON.stringify(f)).toBe(before);
 });
 it("refuses to resurrect old test authors discarded before the rewrite",()=>{
  const f=fixture({discardOld:true});expect(planRetainedRestack(f.state,f.args).ok).toBe(false);
 });
 it("preflight rejects unrecorded member links even under a partial current flag",()=>{
  const f=fixture(),scope=f.state.scopes[0]!;
  scope.complete=false;const member=scope.members.find(m=>m.path==="app.ts")!;member.jobIds=[...member.jobIds,"last"];
  expect(preflightRetainedRestack(f.state,f.args).ok).toBe(false);
 });
 it("preserves a legacy incomplete rewrite even without pending writers",()=>{
  const f=fixture({partial:true}),result=planRetainedRestack(f.state,f.args);expect(result.ok).toBe(true);
  if(result.ok){expect(result.final.state.scopes[0]!.complete).toBe(false);expect(selectedTests(result.final).complete).toBe(false);}
 });
 it("an elevated raw current flag cannot heal an incomplete rewrite snapshot",()=>{
  const f=fixture({partial:true});f.state.scopes[0]!.complete=true;
  expect(planRetainedRestack(f.state,f.args).ok).toBe(false);
 });
 it("rejects damaged tracking and strict cumulative bounds",()=>{
  const f:any=fixture();f.state.scopes[0]!.members=[];
  expect(planRetainedRestack(f.state,f.args).ok).toBe(false);
  const valid=fixture();expect(planRetainedRestack(valid.state,valid.args,{maxFiles:1}).ok).toBe(false);
 });
});
