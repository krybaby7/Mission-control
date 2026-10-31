import { execFileSync } from "node:child_process";
import * as captures from "./work-capture.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionHarness, feature, writeFile, implementFeature, buildOutput, writeFeatureTest, featureTestPath, writeScaffold, FIXTURE_VERIFY } from "../test/fixtures/mission-harness.js";
import { interpretProvenance } from "./provenance.js";
import { journalOf } from "./invocations.js";
import { finishWriter, pendingWrites, frozenSetId } from "./retained-work.js";
import type { Mission } from "./types.js";
let h:MissionHarness|undefined;
afterEach(()=>{vi.restoreAllMocks();h?.cleanup();h=undefined;});
function harness(){h=new MissionHarness({features:[feature("greet")]});return h;}
function facts(m:Mission) {
 const f=m.features[0]!;
 return interpretProvenance(f.provenance,{subject:{kind:"feature_commit",featureId:f.id,commit:f.passingCommit??""},hasPendingWrites:false,maxEntries:1000,maxSnapshots:1000});
}
describe("controller writer capture and retained adoption",()=>{
 it("records actual scaffold, test author and builder without making helpers contributors",async()=>{
  const hh=harness();const m=await hh.run(hh.createMission("greenfield").id),f=m.features[0]!;
  expect(m.status).toBe("done");
  const writes=m.invocations?.entries.filter(e=>e.access==="workspace-write")??[];
  expect(writes.map(e=>[e.label,e.scope.kind,e.stage])).toEqual([["init","application","build"],["test-greet","feature","test_author"],["build-greet","feature","build"]]);
  expect(writes.every(e=>e.writeDisposition==="adopted")).toBe(true);
  expect(facts(m)).toMatchObject({contributionsComplete:true,contributorJobIds:[hh.jobsLabeled("build-greet")[0]!.id]});
  const pending=pendingWrites(m.workTracking,journalOf(m),{kind:"feature",featureId:f.id});
  expect(pending.ok && pending.complete).toBe(true);
  const members=[...f.frozenTests].sort((a,b)=>a.path<b.path?-1:1);
  const authored=interpretProvenance(f.provenance,{subject:{kind:"frozen_tests",featureId:f.id,testSetId:frozenSetId(members)},frozenMembers:members,hasPendingWrites:false,maxEntries:1000,maxSnapshots:1000});
  expect(authored.contributionsComplete).toBe(true);expect(authored.contributorJobIds).toEqual([hh.jobsLabeled("test-greet")[0]!.id]);
 });
 it("durably saves exact intent before the writing stand-in sees its job",async()=>{
  const hh=harness(),id=hh.createMission("greenfield").id;
  hh.agents.engineer=(job,call)=>{
   const saved=hh.load(id),entry=saved.invocations?.entries.find(e=>e.jobId===job.id);
   expect(entry?.writeDisposition).toBe("pending");
   expect(saved.workTracking?.scopes.flatMap(s=>s.intents).find(i=>i.jobId===job.id)).toMatchObject({phase:"active",before:{complete:true}});
   return hh.defaults.engineer(job,call);
  };
  expect((await hh.run(id)).status).toBe("done");
 });
 it("retains failed fallback contributions from both actual families",async()=>{
  const hh=harness();hh.agents.engineer=(job,call)=>call.label==="build-greet"&&call.n===1?
   {outcome:"auth",edit:cwd=>writeFile(cwd,"retained-first.txt","Retained first writer")} :hh.defaults.engineer(job,call);
  const m=await hh.run(hh.createMission("greenfield").id),jobs=hh.jobsLabeled("build-greet");
  expect(jobs).toHaveLength(2);expect(jobs[0]?.provider).not.toBe(jobs[1]?.provider);
  expect(facts(m).contributorJobIds.sort()).toEqual(jobs.map(j=>j.id).sort());
  expect(facts(m).contributorFamilies.sort()).toEqual(["claude","codex"]);expect(facts(m).contributionsComplete).toBe(true);
 });
 it("does not credit a failed no-delta fallback call",async()=>{
  const hh=harness();hh.agents.engineer=(job,call)=>call.label==="build-greet"&&call.n===1?{outcome:"auth"}:hh.defaults.engineer(job,call);
  const m=await hh.run(hh.createMission("greenfield").id),jobs=hh.jobsLabeled("build-greet");
  expect(facts(m).contributorJobIds).toEqual([jobs[1]!.id]);
  expect(m.invocations?.entries.find(e=>e.jobId===jobs[0]?.id)?.writeDisposition).toBe("reverted");
 });
 it("narrows discarded failed builders only after the diagnosis resets to the frozen checkpoint",async()=>{
  const hh=harness();hh.agents.engineer=(job,call)=>call.label==="build-greet"&&call.n<=2?
   {structured:buildOutput(),edit:cwd=>{implementFeature(cwd,"greet","wrong");writeFile(cwd,"discarded.txt","old");}}:hh.defaults.engineer(job,call);
  const m=await hh.run(hh.createMission("greenfield").id),jobs=hh.jobsLabeled("build-greet");
  expect(hh.jobsLabeled("diagnose-greet").length).toBeGreaterThan(0);expect(jobs.length).toBeGreaterThan(2);
  expect(facts(m).contributorJobIds).toEqual([jobs.at(-1)!.id]);expect(facts(m).contributionsComplete).toBe(true);
  for(const job of jobs.slice(0,-1))expect(m.invocations?.entries.find(e=>e.jobId===job.id)?.writeDisposition).toBe("reverted");
  expect(m.workRestore).toBeUndefined();
 });
 it.each(["reservation","cleanup","content_adoption","passing_adoption"])("a %s save failure preserves its prior evidence and prevents a false passing stage",async phase=>{
  const hh=harness(),save=hh.store.save.bind(hh.store);let failed=false;let beforeFailure:Mission|undefined;
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   const e=m.invocations?.entries.find(e=>e.label==="build-greet");
   if(!failed&&e&&(phase==="reservation"?!e.observation:phase==="cleanup"?!!e.cleanedAt:e.writeDisposition==="adopted"&&m.features[0]?.status===(phase==="content_adoption"?"building":"reviewing"))){
    failed=true;beforeFailure=hh.load(m.id);throw Error("fixture joint save failure");
   }
   return save(m,now);
  });
  const m=await hh.run(hh.createMission("greenfield").id);expect(failed).toBe(true);expect(m.status).toBe("stopped");
  expect(m.features[0]?.status).toBe("building");expect(m.features[0]?.passingCommit).toBeUndefined();
  const e=m.invocations?.entries.find(e=>e.label==="build-greet");
  if(phase==="reservation"){expect(e).toBeUndefined();expect(hh.jobsLabeled("build-greet")).toEqual([]);}
  else {
   expect(m.invocations).toEqual(beforeFailure?.invocations);
   expect(m.workTracking).toEqual(beforeFailure?.workTracking);
   expect(m.features[0]?.provenance).toEqual(beforeFailure?.features[0]?.provenance);
   expect(e?.writeDisposition).toBe(phase==="passing_adoption"?"adopted":"pending");
   if(phase==="cleanup")expect(e?.cleanedAt).toBeUndefined();
  }
 });
 it("replays an interrupted controller reset before allowing any further AI job",async()=>{
  const hh=harness(),id=hh.createMission("greenfield").id,save=hh.store.save.bind(hh.store);let hadIntent=false,failed=false;
  hh.agents.engineer=(job,call)=>call.label==="build-greet"&&call.n<=2?
    {structured:buildOutput(),edit:cwd=>implementFeature(cwd,"greet","wrong")}:hh.defaults.engineer(job,call);
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   if(m.workRestore)hadIntent=true;
   if(hadIntent&&!m.workRestore&&!failed){failed=true;throw Error("fixture reset completion save failure");}
   return save(m,now);
  });
  const stopped=await hh.run(id);expect(failed).toBe(true);expect(stopped.status).toBe("stopped");expect(stopped.workRestore).toBeDefined();
  let jobSawPending=false;
  hh.agents.architect=(job,call)=>{jobSawPending ||= Object.hasOwn(hh.load(id),"workRestore");return hh.defaults.architect(job,call);};
  const result=await hh.run(id);
  expect(jobSawPending).toBe(false);expect(result.workRestore).toBeUndefined();expect(result.status).toBe("done");
 });
 it("blocks malformed saved reset intent before Git or an AI job",async()=>{
  const hh=harness(),m=hh.createMission("greenfield");m.workRestore={} as never;hh.store.save(m);
  const reset=vi.spyOn(hh.git,"resetHard");const restored=await hh.run(m.id);
  expect(hh.jobs).toEqual([]);expect(reset).not.toHaveBeenCalled();expect(restored.status).toBe("stopped");
  expect(restored.workRestore).toEqual({});
 });
 it("persists uncertainty before rewriting protected package scripts",async()=>{
  const hh=harness(),save=hh.store.save.bind(hh.store);let failed=false,beforeRewrite:boolean|undefined;
  const good='node --test "tests/**/*.test.mjs"',bad='node -e ""';
  hh.agents.engineer=(job,call)=>{
   if(call.label==="init")return {structured:{summary:"scaffold",verify:{...FIXTURE_VERIFY,full:"npm run verify"},notes:[]},
    edit:cwd=>{writeScaffold(cwd);writeFile(cwd,"package.json",JSON.stringify({scripts:{verify:good}}));}};
   if(call.label==="build-greet")return {structured:buildOutput(),edit:cwd=>{implementFeature(cwd,"greet");writeFile(cwd,"package.json",JSON.stringify({scripts:{verify:bad}}));}};
   return hh.defaults.engineer(job,call);
  };
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   const f=m.features[0];
   if(!failed&&f?.provenanceUncertain&&f.status==="building"){
    failed=true;beforeRewrite=JSON.parse(readFileSync(join(f.worktree!,"package.json"),"utf8")).scripts.verify===bad;
    throw Error("fixture protected-script barrier save failure");
   }
   return save(m,now);
  });
  const result=await hh.run(hh.createMission("greenfield").id);
  expect(failed).toBe(true);expect(beforeRewrite).toBe(true);expect(result.status).toBe("stopped");
 });
 it("stops when a completed Git reset has no complete post-reset proof",async()=>{
  const hh=harness(),id=hh.createMission("greenfield").id,capture=captures.captureWorktree;
  let failed=false,callsAtFailure=0;
  hh.agents.engineer=(job,call)=>call.label==="build-greet"&&call.n<=2?
    {structured:buildOutput(),edit:cwd=>implementFeature(cwd,"greet","wrong")}:hh.defaults.engineer(job,call);
  vi.spyOn(captures,"captureWorktree").mockImplementation(async(...args)=>{
   const result=await capture(...args);
   if(!failed&&hh.load(id).workRestore){failed=true;callsAtFailure=hh.jobs.length;return {...result,complete:false};}
   return result;
  });
  const stopped=await hh.run(id);expect(failed).toBe(true);expect(stopped.status).toBe("stopped");
  expect(stopped.workRestore).toBeDefined();expect(hh.jobs).toHaveLength(callsAtFailure);
  const resumed=await hh.run(id);expect(resumed.workRestore).toBeUndefined();expect(resumed.status).toBe("done");
 });
 it.each(["freeze","passing"])("rejects a moved HEAD during %s adoption before saving mismatched commit markers",async boundary=>{
  const hh=harness(),id=hh.createMission("greenfield").id,capture=captures.captureWorktree;
  let moved=false;
  vi.spyOn(captures,"captureWorktree").mockImplementation(async(...args)=>{
   const saved=hh.load(id),f=saved.features[0],entry=saved.invocations?.entries.at(-1);
   const ready=boundary==="freeze"?f?.status==="testing"&&entry?.stage==="test_author"&&!!entry.cleanedAt:
    f?.status==="building"&&entry?.stage==="build"&&entry.writeDisposition==="adopted"&&f.attempts.some(a=>a.outcome==="pass");
   if(!moved&&args[1].kind==="feature"&&ready){
    moved=true;execFileSync("git",["-c","core.hooksPath=/dev/null","-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-qm","fixture identical tree"],{cwd:args[0]});
   }
   return capture(...args);
  });
  const result=await hh.run(id);expect(moved).toBe(true);expect(result.status).toBe("stopped");
  expect(result.features[0]?.passingCommit).toBeUndefined();
  const scope=result.workTracking?.scopes.find(s=>s.scope.kind==="feature"),cp=scope?.checkpoints.find(c=>c.id===scope.baseCheckpointId);
  if(boundary==="freeze")expect(result.features[0]?.testsCommit).toBe(cp?.capture.head);
 });
 it.each(["observation","cleanup","half_cleanup"])("keeps an interrupted test author's unknown retained files and later known author after %s save failure",async phase=>{
  const hh=harness(),id=hh.createMission("greenfield").id,save=hh.store.save.bind(hh.store);let failed=false;
  hh.agents.test_author=(job,call)=>call.n===1?{structured:{testFiles:[featureTestPath("greet")],notes:""},edit:cwd=>{
   writeFeatureTest(cwd,"greet");writeFile(cwd,"tests/retained.test.mjs",'import {test} from "node:test"; test("retained",()=>{});');
  }}:{structured:{testFiles:[featureTestPath("greet"),"tests/later.test.mjs"],notes:""},edit:cwd=>{
   writeFeatureTest(cwd,"greet");writeFile(cwd,"tests/later.test.mjs",'import {test} from "node:test"; test("later",()=>{});');
  }};
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   const e=m.invocations?.entries.find(e=>e.label==="test-greet");
   if(!failed&&e&&(phase==="observation"?!!e.observation:!!e.cleanedAt)){failed=true;throw Error("fixture interrupted author");}
   return save(m,now);
  });
  const stopped=await hh.run(id);expect(stopped.status).toBe("stopped");expect(failed).toBe(true);
  const first=hh.jobsLabeled("test-greet")[0]!;
  if(phase==="half_cleanup"){
   const after=await captures.captureWorktree(stopped.features[0]!.worktree!,{kind:"feature",featureId:"greet"});
   const result=finishWriter(stopped.workTracking,{jobId:first.id,after,journal:journalOf(stopped),testPaths:after.files.filter(f=>f.path.startsWith("tests/")).map(f=>f.path)});
   expect(result.ok).toBe(true);if(result.ok)stopped.workTracking=result.state;
  }
  stopped.roleOverrides=[{role:"test_author",family:first.provider==="claude"?"codex":"claude"}];hh.store.save(stopped);
  const resumed=await hh.run(id);expect(resumed.status).toBe("done");
  const later=hh.jobsLabeled("test-greet").slice(1);expect(later[0]?.provider).not.toBe(first.provider);
  const f=resumed.features[0]!,known=later.map(job=>job.id);
  const members=[...f.frozenTests].sort((a,b)=>a.path<b.path?-1:1);
  const authored=interpretProvenance(f.provenance,{subject:{kind:"frozen_tests",featureId:f.id,testSetId:frozenSetId(members)},
   frozenMembers:members,hasPendingWrites:true,maxEntries:1000,maxSnapshots:1000});
  expect(authored.contributorJobIds.some(id=>known.includes(id))).toBe(true);
  expect(authored.contributionsComplete).toBe(false);expect(authored.contributorJobIds).not.toContain(first.id);
  const lost=resumed.invocations?.entries.find(e=>e.jobId===first.id)!;
  expect(lost.cleanedAt).toBeUndefined();if(phase==="observation")expect(lost.observation).toBeUndefined();
  expect(lost.writeDisposition).toBe("uncertain");expect(lost.restoration).toBeUndefined();
  expect(resumed.workTracking?.scopes.flatMap(s=>s.intents).find(i=>i.jobId===first.id)?.recovery).toBeDefined();
  expect(resumed.provenanceUncertain).toBeUndefined();expect(f.provenanceUncertain).toBeUndefined();
  expect(readFileSync(join(resumed.repoPath,"tests/retained.test.mjs"),"utf8")).toContain("retained");
 });
 it("keeps active recovery evidence and launches no job when saving the recovered capture fails",async()=>{
  const hh=harness(),id=hh.createMission("greenfield").id,save=hh.store.save.bind(hh.store);
  let initial=false,recovery=false;
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   const e=m.invocations?.entries.find(e=>e.label==="test-greet");
   if(!initial&&e?.observation){initial=true;throw Error("fixture observe failure");}
   if(initial&&!recovery&&m.workTracking?.scopes.flatMap(s=>s.intents).some(i=>i.recovery)){recovery=true;throw Error("fixture recovery save failure");}
   return save(m,now);
  });
  expect((await hh.run(id)).status).toBe("stopped");const count=hh.jobs.length;
  const again=await hh.run(id);expect(recovery).toBe(true);expect(again.status).toBe("stopped");expect(hh.jobs).toHaveLength(count);
  expect(again.workTracking?.scopes.flatMap(s=>s.intents).find(i=>i.jobId===hh.jobsLabeled("test-greet")[0]?.id)?.phase).toBe("active");
  expect(again.invocations?.recoveries).toHaveLength(1);
  const resumed=await hh.run(id);expect(resumed.status).toBe("done");expect(resumed.invocations?.recoveries).toHaveLength(1);
 });
 it("does not create complete evidence for a progressed legacy mission",async()=>{
  const hh=harness(),m=hh.createMission("greenfield");m.agentRuns=1;hh.store.save(m);
  const result=await hh.run(m.id);expect(result.workEvidenceVersion).toBeUndefined();
  expect(facts(result).contributionsComplete).toBe(false);
 });
});
