import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";
import { missionEvidenceView } from "./mission-evidence.js";
import { initializeTracking, beginWriter, finishWriter, adoptRetained, frozenSetId, type WorkCapture, type TrackingPlan } from "./retained-work.js";
import type { InvocationEntry, InvocationJournal } from "./invocations.js";
const A="a".repeat(40), P="b".repeat(40), M="c".repeat(40), H="d".repeat(64), T="e".repeat(64), AT="2026-10-31T00:00:00.000Z";
const scope={kind:"feature",featureId:"one"} as const;
const identity=(family:"claude"|"codex")=>({provider:family,family,model:"recorded-model"});
const j=(entries:InvocationEntry[]):InvocationJournal=>({version:1,legacyAgentRuns:0,legacyInterruptionCounts:{},entries,recoveries:[],interruptionCounts:{}});
function okay<T extends object>(result:TrackingPlan<T>): Extract<TrackingPlan<T>,{ok:true}> { if(!result.ok) throw Error(result.reason);return result; }
function fixture(complete = true) {
 const spec={appName:"Example",features:[]}, planHash=createHash("sha256").update(JSON.stringify(spec)).digest("hex");
 const cap=(files:WorkCapture["files"]=[],head=A):WorkCapture=>({scope,root:"/work/feature",universe:"git-source-v1",head,complete:true,files});
 const build:InvocationEntry={jobId:"builder",label:"build",role:"engineer",access:"workspace-write",scope,stage:"build",reservedAt:AT,candidate:identity("claude"),observation:{actual:identity("claude"),outcome:"ok",at:AT},cleanedAt:AT,writeDisposition:"pending"};
 const author:InvocationEntry={...build,jobId:"author",role:"test_author",stage:"test_author",candidate:identity("codex"),observation:{actual:identity("codex"),outcome:"ok",at:AT}};
 const code=cap([{path:"app.ts",sha256:H,mode:"100644"}]), tests=cap([...code.files,{path:"unit.test.ts",sha256:T,mode:"100644"}]);
 let state=okay(initializeTracking(cap(),complete?{freshBaseline:{head:A,beforeMissionWrites:true,noRetainedAiWriters:true}}:{})).state;
 for(const [entry,before,after] of [[build,cap(),code],[author,code,tests]] as const) {
  state=okay(beginWriter(state,{jobId:entry.jobId,scope,stage:entry.stage,before,frozenPaths:[]})).state;
  state=okay(finishWriter(state,{jobId:entry.jobId,after,journal:j([entry]),testPaths:["unit.test.ts"]})).state;
 }
 const frozen=[{path:"unit.test.ts",sha256:T}], accepted={...tests,head:P};
 const adopted=okay(adoptRetained(state,{scope,capture:accepted,committed:accepted,subject:{kind:"frozen_tests",featureId:"one",testSetId:frozenSetId(frozen)},at:AT,journal:j([build,author]),provenance:undefined,frozenMembers:frozen}));
 build.writeDisposition="adopted";author.writeDisposition="adopted";
 const review={jobId:"feature-review",scope,stage:"review",actual:identity("codex"),outcome:"completed",at:AT,subject:{kind:"feature_commit",featureId:"one",commit:P}};
 const provenance={...adopted.provenance,entries:[...adopted.provenance.entries,review]};
 const appCap:WorkCapture={...cap(),scope:{kind:"application"},root:"/work/integration"};
 const appState=okay(initializeTracking(appCap,{state:adopted.state,freshBaseline:{head:A,beforeMissionWrites:true,noRetainedAiWriters:true}})).state;
 const featureRefs=[{featureId:"one",passingCommit:P,mergeCommit:M,snapshotRevision:1}];
 const entries=[
  {jobId:"plan-review",scope:{kind:"plan"},stage:"plan_review",actual:identity("codex"),outcome:"completed",at:AT,subject:{kind:"plan",planHash}},
  {jobId:"final-review",scope:{kind:"application"},stage:"final_review",actual:identity("claude"),outcome:"completed",at:AT,subject:{kind:"application_commit",commit:M}},
 ];
 const readers = [review, ...entries].map(e => ({jobId:e.jobId,label:e.stage,role:"reviewer",access:"read-only",scope:e.scope,stage:e.stage,
  baseSubject:e.subject,reservedAt:AT,candidate:e.actual,observation:{at:AT,actual:e.actual,outcome:"ok"},cleanedAt:AT,writeDisposition:"none"} as InvocationEntry));
 return {spec,baseSha:A,repoPath:"/work/repo",integrationWorktree:"/work/integration",agentRuns:2+readers.length,invocations:j([build,author,...readers]),workTracking:appState,
  applicationLedger:{version:1,root:"/work/integration",baseline:{kind:"recorded_baseline",commit:A},head:M,scaffold:{commit:A,snapshotRevision:null,hasRetainedAiWork:false},features:featureRefs},
  provenance:{version:1,entries,retained:[{kind:"writes",subject:{kind:"application_commit",commit:M},complete:true,jobIds:[],baseline:{kind:"recorded_baseline",commit:A},featureRefs,revision:1,supersedes:null}]},
  features:[{id:"one",status:"done",passingCommit:P,commit:M,frozenTests:frozen,provenance}]
 };
}
const text=(lines:string[])=>lines.join("\n");
const independent=(lines:string[])=>text(lines).includes("belongs to another AI family")||text(lines).includes("belong to different AI families");
describe("canonical mission owner evidence",()=>{
 it("shows exact plan, feature review, frozen test authors and retained application overlap",()=>{
  const view=missionEvidenceView(fixture());
  expect(text(view.plan)).toContain("Plan reviewed by Codex.");
  expect(text(view.features[0]!.review)).toContain("Reviewed by Codex in a separate job");
  expect(text(view.features[0]!.tests)).toContain("Recorded authors of the frozen tests: Codex.");
  expect(text(view.application)).toContain("Final review of this version: Claude.");
  expect(text(view.application)).toContain("also contributed to the retained mission work");
  expect(text(view.application)).toContain("recorded version");
 });
 it("whole cumulative graph overflow cannot leave a feature-prefix positive",()=>{
  const raw:any=fixture();
  raw.features.push({id:"unreferenced",provenance:{version:999,entries:Array.from({length:10001},(_,i)=>({jobId:"unused-"+i}))}});
  const view=missionEvidenceView(raw);
  expect(text(view.plan)).not.toContain("Plan reviewed");
  expect(view.features).toEqual([]);
  expect(text(view.application)).not.toContain("contributors to this mission's retained work:");
 });
 it.each(["absent","unsupported","count-drift","damaged-tracking"] as const)("invalid current journal/tracking %s masks all current review identities",kind=>{
  const raw:any=fixture();
  if(kind==="absent")delete raw.invocations;
  if(kind==="unsupported")raw.invocations.version=999;
  if(kind==="count-drift")raw.agentRuns++;
  if(kind==="damaged-tracking")raw.workTracking.scopes[0].members=[];
  const view=missionEvidenceView(raw);
  if(kind==="damaged-tracking")expect(text(view.plan)).toContain("Plan reviewed by Codex.");
  else expect(text(view.plan)).not.toContain("Plan reviewed");
  expect(text(view.application)).toContain("Final review identity not recorded");
  expect(text(view.features[0]!.review)).toContain("Review identity not recorded");
 });
 it("final same-family overlap stays explicit with partial contributor history",()=>{
  const raw:any=fixture(false);
  const view=missionEvidenceView(raw);
  expect(text(view.application)).toContain("Final review of this version: Claude.");
  expect(text(view.application)).toContain("also contributed to the retained mission work");
  expect(independent(view.application)).toBe(false);
 });
 it("changing the exact frozen set cannot reuse older author credit",()=>{
  const raw:any=fixture();raw.features[0].frozenTests[0].sha256=H;
  const view=missionEvidenceView(raw);
  expect(text(view.features[0]!.tests)).toContain("Frozen test author identity not recorded.");
  expect(independent(view.features[0]!.tests)).toBe(false);
 });
 it.each(["correct","incomplete-source","source-missing","revision","forbidden-no-ai"] as const)("binds retained AI scaffold independently (%s)",kind=>{
  const raw:any=fixture(), K="f".repeat(40), appScope={kind:"application"} as const;
  if(kind==="incomplete-source")raw.workTracking.scopes[1].complete=false;
  const before=raw.workTracking.scopes[1].capture as WorkCapture;
  const after:WorkCapture={...before,files:[{path:"scaffold.ts",sha256:H,mode:"100644"}]};
  const entry:InvocationEntry={jobId:"scaffold",label:"scaffold",role:"engineer",access:"workspace-write",scope:appScope,stage:"build",reservedAt:AT,candidate:identity("codex"),observation:{at:AT,actual:identity("codex"),outcome:"ok"},cleanedAt:AT,writeDisposition:"pending"};
  let state=okay(beginWriter(raw.workTracking,{jobId:entry.jobId,scope:appScope,stage:"build",before,frozenPaths:[]})).state;
  state=okay(finishWriter(state,{jobId:entry.jobId,after,journal:j([entry])})).state;
  const committed={...after,head:K};
  const adopted=okay(adoptRetained(state,{scope:appScope,capture:committed,committed,subject:{kind:"application_commit",commit:K},at:AT,journal:j([entry]),provenance:undefined}));
  entry.writeDisposition="adopted";raw.invocations.entries.push(entry);raw.agentRuns++;
  raw.workTracking=adopted.state;raw.applicationLedger.scaffold={commit:K,snapshotRevision:1,hasRetainedAiWork:true};
  raw.provenance.entries.push(...adopted.provenance.entries);
  raw.provenance.retained[0].jobIds=["scaffold"];raw.provenance.retained.unshift(...adopted.provenance.retained!);
  if(kind==="source-missing")raw.provenance.retained.shift();
  if(kind==="revision")raw.applicationLedger.scaffold.snapshotRevision=2;
  if(kind==="forbidden-no-ai")raw.applicationLedger.scaffold={commit:A,snapshotRevision:null,hasRetainedAiWork:false};
  const view=missionEvidenceView(raw);
  if(kind==="correct"||kind==="incomplete-source")expect(text(view.application)).toContain("Final review of this version: Claude.");
  else expect(text(view.application)).toContain("Final review identity not recorded");
  if(kind==="incomplete-source")expect(text(view.application)).toContain("Some retained mission AI contributions have no recorded identity.");
 });
 it.each([undefined,{}, {scope:{kind:"feature",featureId:"elsewhere"},checkpointId:H,head:P,at:AT}])("own reset intent blocks current reviews even without pending writers: %j",intent=>{
  const raw:any=fixture();raw.workRestore=intent;
  const view=missionEvidenceView(raw);
  expect(text(view.plan)).not.toContain("Plan reviewed");
  expect(text(view.application)).toContain("Final review identity not recorded");
  expect(text(view.features[0]!.review)).toContain("Review identity not recorded");
  expect(text(view.features[0]!.review)).toContain("contributors: Claude.");
  expect(independent(view.features[0]!.tests)).toBe(false);
 });
 it.each([undefined,{}, {scope:{kind:"feature",featureId:"elsewhere"}}])("own restack intent blocks current review credit even when malformed: %j",intent=>{
  const raw:any=fixture();raw.workRestack=intent;
  const view=missionEvidenceView(raw);
  expect(text(view.application)).toContain("Final review identity not recorded");
  expect(text(view.features[0]!.review)).toContain("Review identity not recorded");
  expect(text(view.features[0]!.review)).toContain("contributors: Claude.");
  expect(independent(view.features[0]!.tests)).toBe(false);
 });
 it("a changed plan cannot reuse a prior exact plan review",()=>{
  const raw:any=fixture();raw.spec.appName="Changed";
  expect(text(missionEvidenceView(raw).plan)).toContain("Plan review identity not recorded");
 });
 it.each(["legacy","unattributed"] as const)("does not trust a fresh-looking scope over prior %s writer history",kind=>{
  const raw:any=fixture();raw.agentRuns++;
  if(kind==="legacy")raw.invocations.legacyAgentRuns++;
  else raw.invocations.entries.push({...raw.invocations.entries[0],jobId:"unattributed",scope:{kind:"controller"},stage:"other",writeDisposition:"adopted"});
  const view=missionEvidenceView(raw);
  expect(text(view.features[0]!.review)).toContain("Reviewed by Codex;");
  expect(text(view.features[0]!.review)).toContain("contributors: Claude.");
  expect(independent(view.features[0]!.tests)).toBe(false);
 });
 it.each(["missing","identity","stage","scope","baseSubject","outcome","time","uncleaned"] as const)("unbound review %s cannot receive current identity",kind=>{
  const raw:any=fixture(), row=raw.invocations.entries.find((e:any)=>e.jobId==="feature-review");
  if(kind==="missing"){raw.invocations.entries=raw.invocations.entries.filter((e:any)=>e!==row);raw.agentRuns--;}
  if(kind==="identity")raw.features[0].provenance.entries.at(-1).actual=identity("claude");
  if(kind==="stage")row.stage="other";
  if(kind==="scope"){row.scope={kind:"feature",featureId:"different"};row.baseSubject={...row.baseSubject,featureId:"different"};}
  if(kind==="baseSubject")row.baseSubject.commit=A;
  if(kind==="outcome")row.observation.outcome="failed";
  if(kind==="time")raw.features[0].provenance.entries.at(-1).at="2026-10-31T00:01:00.000Z";
  if(kind==="uncleaned")delete row.cleanedAt;
  expect(text(missionEvidenceView(raw).features[0]!.review)).toContain("Review identity not recorded");
 });
 it.each(["missing","identity","outcome","time","stage"] as const)("unbound writer %s cannot receive contributor identity",kind=>{
  const raw:any=fixture(), row=raw.invocations.entries.find((e:any)=>e.jobId==="builder");
  if(kind==="missing"){raw.invocations.entries=raw.invocations.entries.filter((e:any)=>e!==row);raw.agentRuns--;}
  if(kind==="identity")raw.features[0].provenance.entries[0].actual=identity("codex");
  if(kind==="outcome")row.observation.outcome="failed";
  if(kind==="time")raw.features[0].provenance.entries[0].at="2026-10-31T00:01:00.000Z";
  if(kind==="stage")row.stage="fix";
  const view=missionEvidenceView(raw);expect(text(view.features[0]!.review)).not.toContain("contributors: Claude.");
  expect(independent(view.features[0]!.review)).toBe(false);
 });
 it("allows a bound exact plan review before the first writer or tracking scope",()=>{
  const raw:any=fixture(), plan=raw.provenance.entries.find((e:any)=>e.stage==="plan_review");
  raw.invocations.entries=raw.invocations.entries.filter((e:any)=>e.stage==="plan_review");raw.agentRuns=1;
  raw.provenance={version:1,entries:[plan]};raw.features=[];delete raw.workTracking;delete raw.applicationLedger;
  expect(text(missionEvidenceView(raw).plan)).toContain("Plan reviewed by Codex.");
 });
 it.each(["missing","undefined"] as const)("legacy %s tracking keeps a bound reviewer but no independence claim",kind=>{
  const raw:any=fixture();if(kind==="missing")delete raw.workTracking;else raw.workTracking=undefined;
  const view=missionEvidenceView(raw);expect(text(view.features[0]!.review)).toContain("Reviewed by Codex;");
  expect(independent(view.features[0]!.review)).toBe(false);
 });
 it.each(["writer-selection","member-authors","member-hash"] as const)("contradictory current checkpoint %s blocks current review",kind=>{
  const raw:any=fixture();
  if(kind==="writer-selection")raw.features[0].provenance.retained[0].jobIds=[];
  if(kind==="member-authors"){raw.features[0].provenance.retained[1].members[0].jobIds=[];raw.features[0].provenance.retained[1].jobIds=[];}
  if(kind==="member-hash")raw.features[0].provenance.retained[1].members[0].sha256=H;
  const view=missionEvidenceView(raw);expect(text(view.features[0]!.review)).toContain("Review identity not recorded");
  expect(independent(view.features[0]!.tests)).toBe(false);
 });
 it.each(["legacy","collision"] as const)("retains known same-family current review with unrelated historical %s gaps",kind=>{
  const raw:any=fixture();raw.features[0].provenance.entries.at(-1).actual=identity("claude");
  raw.invocations.entries.find((e:any)=>e.jobId==="feature-review").observation.actual=identity("claude");
  raw.invocations.entries.find((e:any)=>e.jobId==="feature-review").candidate=identity("claude");
  if(kind==="legacy"){raw.invocations.legacyAgentRuns++;raw.agentRuns++;}
  else raw.features.push({id:"unreferenced",provenance:{version:999,entries:[{jobId:"unrelated"},{jobId:"unrelated"}]}});
  const view=missionEvidenceView(raw);expect(text(view.features[0]!.review)).toContain("Built and reviewed by Claude");
  expect(text(view.application)).toContain("Final review of this version: Claude.");
  expect(independent(view.features[0]!.review)).toBe(false);
 });
 it.each(["undefined","reload"] as const)("normal cleaned worktree fields preserve recorded-version identity (%s)",kind=>{
  const raw:any=fixture();raw.integrationWorktree=undefined;raw.features[0].worktree=undefined;
  const view=missionEvidenceView(kind==="reload"?JSON.parse(JSON.stringify(raw)):raw);
  expect(text(view.application)).toContain("Final review of this version: Claude.");
  expect(text(view.features[0]!.review)).toContain("Reviewed by Codex in a separate job");
 });
 it("writer first accepted subject need not equal its pre-write reservation subject",()=>{
  const raw:any=fixture();raw.invocations.entries.find((e:any)=>e.jobId==="builder").baseSubject={kind:"feature_commit",featureId:"one",commit:A};
  expect(text(missionEvidenceView(raw).features[0]!.review)).toContain("Reviewed by Codex in a separate job");
 });
 it("retained failed writer outcome stays credited when journal and evidence agree",()=>{
  const raw:any=fixture();raw.invocations.entries.find((e:any)=>e.jobId==="builder").observation.outcome="failed";
  raw.features[0].provenance.entries[0].outcome="failed";
  expect(text(missionEvidenceView(raw).features[0]!.review)).toContain("Recorded build and repair contributors: Claude.");
 });
 it.each(["baseline","references"] as const)("malformed optional checkpoint snapshot %s is an inconsistency",kind=>{
  const raw:any=fixture();raw.features[0].provenance.retained[0][kind==="baseline"?"baseline":"featureRefs"]=undefined;
  expect(text(missionEvidenceView(raw).features[0]!.review)).toContain("Review identity not recorded");
 });
 it.each(["writes","tests"] as const)("untracked newer same-subject %s terminal revision is inconsistent",kind=>{
  const raw:any=fixture(), prior=raw.features[0].provenance.retained.find((r:any)=>r.kind===kind);
  const next=structuredClone(prior);next.revision=2;next.supersedes=1;
  raw.features[0].provenance.retained.push(next);
  const view=missionEvidenceView(raw);
  expect(text(view.features[0]!.review)).toContain("Review identity not recorded");
  expect(independent(view.features[0]!.tests)).toBe(false);
 });
 it.each(["ok","failed","thrown"] as const)("uncredited incomplete review audit after %s does not poison later valid independence",outcome=>{
  const raw:any=fixture(), valid=raw.invocations.entries.find((e:any)=>e.jobId==="feature-review");
  const invalid={...structuredClone(valid),jobId:"incomplete-review",observation:{at:AT,actual:identity("claude"),outcome},candidate:identity("claude")};
  raw.invocations.entries.push(invalid);raw.agentRuns++;
  raw.features[0].provenance.entries.push({jobId:invalid.jobId,scope,stage:"review",actual:identity("claude"),outcome:"incomplete",at:AT,subject:valid.baseSubject});
  const view=missionEvidenceView(raw);
  expect(text(view.features[0]!.review)).toContain("Reviewed by Codex in a separate job");
  expect(text(view.features[0]!.review)).not.toContain("reviewed by Claude");
  expect(text(view.features[0]!.review)).not.toContain("Some retained build");
 });
 it("an unrelated malformed review record cannot by itself remove complete builder coverage",()=>{
  const raw:any=fixture();raw.features[0].provenance.entries.push({jobId:"broken-review",stage:"review",actual:{family:"claude"}});
  const view=missionEvidenceView(raw);
  expect(text(view.features[0]!.review)).toContain("Reviewed by Codex in a separate job");
 });
 it("application refs still select an older merged revision after a tracked newer metadata revision",()=>{
  const raw:any=fixture();raw.workTracking.scopes[0].complete=false;
  const cap=raw.workTracking.scopes[0].capture, frozen=raw.features[0].frozenTests;
  const next=okay(adoptRetained(raw.workTracking,{scope,capture:cap,committed:cap,
   subject:{kind:"frozen_tests",featureId:"one",testSetId:frozenSetId(frozen)},at:AT,journal:raw.invocations,
   provenance:raw.features[0].provenance,frozenMembers:frozen}));
  raw.workTracking=next.state;raw.features[0].provenance=next.provenance;
  expect(raw.features[0].provenance.retained.filter((r:any)=>r.kind==="writes").at(-1).revision).toBe(2);
  expect(raw.applicationLedger.features[0].snapshotRevision).toBe(1);
  expect(text(missionEvidenceView(raw).application)).toContain("Final review of this version: Claude.");
 });
 it("does not mutate the raw mission",()=>{const raw=fixture(),before=JSON.stringify(raw);missionEvidenceView(raw);expect(JSON.stringify(raw)).toBe(before);});
 it("missing legacy data stays unknown despite routing and requested reviewer names",()=>{
  const view=missionEvidenceView({spec:{},agentRuns:10,features:[{id:"one",passingCommit:P,frozenTests:[],builtBy:"claude",checked:{reviewer:"codex"}}],profile:"codex"});
  expect(text(view.features[0]!.review)).toContain("Review identity not recorded");
  expect(independent(view.features[0]!.review)).toBe(false);
  expect(text(view.plan)).toContain("not recorded");
 });
 it.each(["provenanceUncertain","invocations"] as const)("own undefined %s masks feature current identity",field=>{
  const raw:any=fixture();raw[field]=undefined;const view=missionEvidenceView(raw);
  expect(text(view.features[0]!.review)).toContain("Review identity not recorded");expect(independent(view.features[0]!.review)).toBe(false);
 });
 it.each([true,undefined,false])("own feature uncertainty=%s masks review but preserves known contributors",value=>{
  const raw:any=fixture();raw.features[0].provenanceUncertain=value;const view=missionEvidenceView(raw);
  expect(text(view.features[0]!.review)).toContain("Recorded build and repair contributors: Claude.");
  expect(text(view.features[0]!.review)).toContain("Review identity not recorded");expect(independent(view.features[0]!.tests)).toBe(false);
 });
 it("global duplicate in an unsupported unreferenced envelope poisons a recorded review",()=>{
  const raw:any=fixture();raw.features.push({id:"unreferenced",status:"pending",provenance:{version:999,entries:[{jobId:"feature-review"}]}});
  const view=missionEvidenceView(raw);expect(text(view.features[0]!.review)).toContain("Review identity not recorded");
  expect(independent(view.features[0]!.review)).toBe(false);
 });
 it("global duplicate contributor removes its family rather than preserving overlap under ambiguous identity",()=>{
  const raw:any=fixture();raw.features.push({id:"unreferenced",provenance:{version:2,entries:[{jobId:"builder"}]}});
  const view=missionEvidenceView(raw);expect(text(view.features[0]!.review)).not.toContain("contributors: Claude");
  expect(independent(view.application)).toBe(false);
 });
 it.each(["missing-ledger","pending-merge","baseline","root","missing-delivery","extra-delivery","source","merge","revision","sticky"] as const)("masks final identity for %s",kind=>{
  const raw:any=fixture();
  if(kind==="missing-ledger")delete raw.applicationLedger;
  if(kind==="pending-merge")raw.applicationLedger.pendingMerge={attemptId:"merge-2",featureId:"two",passingCommit:P,snapshotRevision:1,beforeHead:M};
  if(kind==="baseline")raw.baseSha=P;
  if(kind==="root")raw.integrationWorktree="/wrong";
  if(kind==="missing-delivery")raw.features[0].status="blocked";
  if(kind==="extra-delivery")raw.features.push({id:"two",status:"done",passingCommit:P,commit:M,frozenTests:[]});
  if(kind==="source")raw.features[0].passingCommit=A;
  if(kind==="merge")raw.features[0].commit=A;
  if(kind==="revision")raw.applicationLedger.features[0].snapshotRevision=2;
  if(kind==="sticky")raw.provenanceUncertain=undefined;
  const view=missionEvidenceView(raw);expect(text(view.application)).toContain("Final review identity not recorded");
  expect(independent(view.application)).toBe(false);
 });
 it("stale tracked feature head masks current review",()=>{
  const raw:any=fixture();raw.workTracking.scopes[0].capture.head=A;
  const view=missionEvidenceView(raw);expect(text(view.features[0]!.review)).toContain("Review identity not recorded");
 });
 it("a pending feature writer blocks final review without erasing known retained overlap",()=>{
  const raw:any=fixture();raw.invocations.entries[0].writeDisposition="pending";
  const view=missionEvidenceView(raw);expect(text(view.application)).toContain("Final review identity not recorded");
  expect(text(view.features[0]!.review)).toContain("contributors: Claude");
 });
 it("same-family review remains explicit with an incomplete contribution record",()=>{
  const raw:any=fixture(false);raw.features[0].provenance.entries.at(-1).actual=identity("claude");
  raw.invocations.entries.find((e:any)=>e.jobId==="feature-review").observation.actual=identity("claude");
  raw.invocations.entries.find((e:any)=>e.jobId==="feature-review").candidate=identity("claude");
  const view=missionEvidenceView(raw);expect(text(view.features[0]!.review)).toContain("Built and reviewed by Claude");
  expect(independent(view.features[0]!.review)).toBe(false);
 });
 it.each(["duplicate-id","bad-id","oversized","nested-budget","getter","cyclic"] as const)("fails closed on %s",kind=>{
  const raw:any=fixture();
  if(kind==="duplicate-id")raw.features.push({...raw.features[0]});
  if(kind==="bad-id")raw.features[0].id="raw\nprivate";
  if(kind==="oversized")raw.features=Array.from({length:2001},(_,i)=>({id:"f"+i}));
  if(kind==="nested-budget")raw.features[0].provenance.retained[0].jobIds=Array(250001).fill("builder");
  if(kind==="getter")Object.defineProperty(raw,"provenance",{get(){throw Error("must not read");}});
  if(kind==="cyclic")raw.spec.self=raw.spec;
  const view=missionEvidenceView(raw);expect(text(view.plan)).toContain("not recorded");expect(text(view.application)).toContain("not recorded");
  expect(JSON.stringify(view)).not.toContain("raw\\nprivate");expect(JSON.stringify(view)).not.toContain("another AI family");
 });
});

// Reading-only features do not acquire a fictional frozen-test workflow from missing fields.
it.each(["review","owner"])("omits frozen-test disclosure for %s mode",mode=>{
 const view=missionEvidenceView({features:[{id:"reading",mode,frozenTests:[]}]});
 expect(view.features[0]?.tests).toEqual([]);
 expect(view.features[0]?.review.join(" ")).toContain("identity not recorded");
});
