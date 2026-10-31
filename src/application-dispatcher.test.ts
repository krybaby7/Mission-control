import { afterEach,describe,expect,it,vi } from "vitest";
import { MissionHarness,feature,writeFile,writeScaffold,implementFeature,FIXTURE_VERIFY } from "../test/fixtures/mission-harness.js";
import { RetainedController } from "./retained-controller.js";
import { missionEvidenceView } from "./mission-evidence.js";
import { retainFindings, assessFindings, findingId } from "./finding-resolution.js";
import { readApplicationLedger } from "./application-ledger.js";
import type { Mission } from "./types.js";
let h:MissionHarness|undefined;
afterEach(()=>{vi.restoreAllMocks();h?.cleanup();h=undefined;});
function harness(two=false){h=new MissionHarness({features:two?[feature("greet"),feature("farewell")]:[feature("greet")]});return h;}
describe("retained application merge ledger",()=>{
 it("binds actual scaffold and both delivered feature revisions after normal cleanup",async()=>{
  const hh=harness(true),m=await hh.run(hh.createMission("greenfield").id);
  expect(m.status).toBe("done");
  const ledger=readApplicationLedger(m.applicationLedger);expect(ledger.ok).toBe(true);if(!ledger.ok)return;
  expect(ledger.ledger.pendingMerge).toBeUndefined();expect(ledger.ledger.features).toHaveLength(2);
  for(const ref of ledger.ledger.features){
   const f=m.features.find(f=>f.id===ref.featureId)!;expect(ref.passingCommit).toBe(f.passingCommit);expect(ref.mergeCommit).toBe(f.commit);
   const snapshot=f.provenance?.retained?.find(s=>s.kind==="writes"&&s.subject.kind==="feature_commit"&&s.subject.commit===ref.passingCommit&&(s.revision??null)===ref.snapshotRevision);
   expect(snapshot).toBeDefined();
  }
  const view=missionEvidenceView(m);
  expect(view.application.join(" ")).toContain("Claude");expect(view.application.join(" ")).not.toContain("could not be established");
  expect(m.provenanceUncertain).toBeUndefined();
 });
 it("saves pending intent before invoking Git and done state before removing the feature worktree",async()=>{
  const hh=harness(),id=hh.createMission("greenfield").id,merge=hh.git.merge.bind(hh.git),remove=hh.git.removeWorktree.bind(hh.git);
  let sawPending=false,sawDone=false;
  vi.spyOn(hh.git,"merge").mockImplementation(async(...args)=>{
   const m=hh.load(id);sawPending=!!m.applicationLedger?.pendingMerge;expect(m.features[0]?.status).not.toBe("done");return merge(...args);
  });
  vi.spyOn(hh.git,"removeWorktree").mockImplementation(async(...args)=>{
   const m=hh.load(id);if(m.features[0]?.status==="done"){
    sawDone=true;expect(m.applicationLedger?.features).toHaveLength(1);expect(m.applicationLedger?.pendingMerge).toBeUndefined();
   }return remove(...args);
  });
  expect((await hh.run(id)).status).toBe("done");expect(sawPending).toBe(true);expect(sawDone).toBe(true);
 });
 it.each(["intent","accepted"])("rolls back a %s merge evidence save failure and keeps delivered state unaccepted",async phase=>{
  const hh=harness(),save=hh.store.save.bind(hh.store),id=hh.createMission("greenfield").id;
  let failed=false,before:Mission|undefined;const merge=vi.spyOn(hh.git,"merge");
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   const matches=phase==="intent"?!!m.applicationLedger?.pendingMerge:m.applicationLedger?.features.length===1&&m.features[0]?.status==="done";
   if(!failed&&matches){failed=true;before=hh.load(id);throw Error("fixture merge state save");}return save(m,now);
  });
  const stopped=await hh.run(id);expect(failed).toBe(true);expect(stopped.status).toBe("stopped");
  expect(stopped.applicationLedger).toEqual(before?.applicationLedger);expect(stopped.features[0]?.status).not.toBe("done");expect(stopped.features[0]?.commit).toBeUndefined();
  if(phase==="intent")expect(merge).not.toHaveBeenCalled();else{
   expect(stopped.applicationLedger?.pendingMerge).toBeDefined();
   const resumed=await hh.run(id);expect(resumed.status).toBe("done");expect(resumed.applicationLedger?.pendingMerge).toBeDefined();
   expect(resumed.provenanceUncertain).toBe(true);expect(missionEvidenceView(resumed).application.join(" ")).toContain("identity not recorded for this version");
  }
 });
 it("does not treat a later descendant as the exact merge receipt",async()=>{
  const hh=harness(),merge=hh.git.merge.bind(hh.git);
  vi.spyOn(hh.git,"merge").mockImplementation(async(...args)=>{
   const result=await merge(...args);if(result.ok){writeFile(args[0],"extra.txt","unexplained after merge");await hh.git.commitAll(args[0],"fixture descendant");}
   return result;
  });
  const m=await hh.run(hh.createMission("greenfield").id);expect(m.provenanceUncertain).toBe(true);
  expect(m.applicationLedger?.pendingMerge).toBeDefined();expect(m.applicationLedger?.features).toEqual([]);
  expect(missionEvidenceView(m).application.join(" ")).toContain("identity not recorded for this version");
 });
 it.each([false,true])("reopens stale resolved concerns in the same merge transaction (save fails: %s)",async fail=>{
  const hh=harness(true),id=hh.createMission("greenfield").id,save=hh.store.save.bind(hh.store);
  const finding={severity:"major" as const,file:"src/greet.mjs",description:"Retained concern",suggestedTest:null};
  let seeded=false,seen=false,failed=false;let before:Mission|undefined;
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   if(!seeded&&m.applicationLedger?.pendingMerge?.featureId==="farewell"){
    seeded=true;const f=m.features[0]!,head=m.applicationLedger.head;
    f.findingHistory=assessFindings(retainFindings(undefined,f.id,[finding]),f.id,[{id:findingId(f.id,finding),outcome:"resolved",evidence:"Checked prior version"}],
      {currentCommit:head,reviewedCommit:head,completed:true,unchanged:true,clean:true,jobId:"fixture-review",
       actual:{provider:"claude",family:"claude",model:"fixture"},at:"2026-10-31T00:00:00.000Z",verification:{commit:head,passed:true}});
    f.openFindings=[];
   }
   if(seeded&&m.applicationLedger?.features.length===2&&!seen){
    seen=true;expect(m.features[0]?.openFindings).toEqual([finding]);expect(m.features[1]?.status).toBe("done");
    if(fail){before=hh.load(id);failed=true;throw Error("fixture atomic merge projection save");}
   }
   return save(m,now);
  });
  const result=await hh.run(id);expect(seeded).toBe(true);expect(seen).toBe(true);
  if(fail){expect(failed).toBe(true);expect(result.status).toBe("stopped");
   expect(result.features[0]?.findingHistory).toEqual(before?.features[0]?.findingHistory);
   expect(result.features[0]?.openFindings).toEqual([finding]);expect(result.features[0]?.findingHistoryUncertain).toBe(true);
   expect(hh.load(id).features[0]?.openFindings).toEqual([finding]);
   expect(result.applicationLedger).toEqual(before?.applicationLedger);expect(result.features[1]?.status).not.toBe("done");
  }else expect(result.features[0]?.openFindings).toEqual([finding]);
 });
 it("cannot start an evidentiary merge when the exact passing checkpoint is missing",async()=>{
  const hh=harness(),cp=RetainedController.prototype.checkpoint;
  vi.spyOn(RetainedController.prototype,"checkpoint").mockImplementation(function(this:RetainedController,scope,head){
   const result=cp.call(this,scope,head);
   return result?.selection.subject.kind==="feature_commit"&&result.liveWriterIds.some(id=>id.startsWith("build-"))?undefined:result;
  });
  const m=await hh.run(hh.createMission("greenfield").id);
  expect(m.status).toBe("done");expect(m.provenanceUncertain).toBe(true);expect(m.applicationLedger?.features).toEqual([]);
 });
 it("reopens a prior concern when a no-op merge receipt is followed by an observed descendant",async()=>{
  const hh=harness(),id=hh.createMission("greenfield").id,save=hh.store.save.bind(hh.store),merge=hh.git.merge.bind(hh.git);
  const finding={severity:"major" as const,file:"src/greet.mjs",description:"Prior resolved concern",suggestedTest:null};
  let seeded=false,noOp=false;
  hh.agents.test_author=()=>({structured:{testFiles:[],notes:"Already present"}});
  hh.agents.engineer=(job,call)=>call.label==="init"?
   {structured:{summary:"scaffold",verify:FIXTURE_VERIFY,notes:[]},edit:cwd=>{writeScaffold(cwd);implementFeature(cwd,"greet");}}:hh.defaults.engineer(job,call);
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   if(!seeded&&m.applicationLedger?.pendingMerge){seeded=true;const f=m.features[0]!,head=m.applicationLedger.head;
    f.findingHistory=assessFindings(retainFindings(undefined,f.id,[finding]),f.id,[{id:findingId(f.id,finding),outcome:"resolved",evidence:"Prior version"}],
     {currentCommit:head,reviewedCommit:head,completed:true,unchanged:true,clean:true,jobId:"fixture-review",
      actual:{provider:"claude",family:"claude",model:"fixture"},at:"2026-10-31T00:00:00.000Z",verification:{commit:head,passed:true}});
    f.openFindings=[];
   }return save(m,now);
  });
  vi.spyOn(hh.git,"merge").mockImplementation(async(...args)=>{
   const before=await hh.git.headSha(args[0]),result=await merge(...args);
   if(result.ok){noOp=result.sha===before;writeFile(args[0],"extra.txt","later descendant");await hh.git.commitAll(args[0],"fixture descendant");}
   return result;
  });
  const m=await hh.run(id);expect(noOp).toBe(true);expect(seeded).toBe(true);
  expect(m.features[0]?.openFindings).toEqual([finding]);expect(m.provenanceUncertain).toBe(true);
 });
 it.each(["provenance","workTracking"])("preserves malformed %s during scaffold adoption",async field=>{
  const hh=harness(),save=hh.store.save.bind(hh.store);let damaged=false;
  const raw=field==="provenance"?{version:99,retained:{keep:"raw"}}:{version:99,scopes:{keep:"raw"}};
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   const entry=m.invocations?.entries.at(-1);
   if(!damaged&&entry?.label==="init"&&entry.observation&&!entry.cleanedAt){
    damaged=true;(m as unknown as Record<string,unknown>)[field]=raw;
   }return save(m,now);
  });
  const result=await hh.run(hh.createMission("greenfield").id);
  expect(damaged).toBe(true);expect(result.status).toBe("done");expect((result as unknown as Record<string,unknown>)[field]).toEqual(raw);
  expect(result.provenanceUncertain).toBe(true);
 });
 it.each(["provenance","workTracking"])("preserves malformed %s containers during merge without crashing compatibility",async field=>{
  const hh=harness(),save=hh.store.save.bind(hh.store);let damaged=false;
  const raw=field==="provenance"?{version:99,retained:{keep:"raw"}}:{version:99,scopes:{keep:"raw"}};
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   if(!damaged&&m.applicationLedger?.pendingMerge){damaged=true;(m as unknown as Record<string,unknown>)[field]=raw;}
   return save(m,now);
  });
  const result=await hh.run(hh.createMission("greenfield").id);
  expect(damaged).toBe(true);expect(result.status).toBe("done");expect((result as unknown as Record<string,unknown>)[field]).toEqual(raw);
  expect(result.provenanceUncertain).toBe(true);
 });
 it("preserves malformed ledger bytes and remains explicit about unknown application coverage",async()=>{
  const hh=harness(),id=hh.createMission("greenfield").id;
  hh.agents.engineer=(job,call)=>hh.defaults.engineer(job,call);
  const save=hh.store.save.bind(hh.store);let damaged=false;
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   if(!damaged&&m.features[0]?.status==="reviewing"){damaged=true;m.applicationLedger={version:99} as never;}
   return save(m,now);
  });
  const m=await hh.run(id);expect(m.status).toBe("done");expect(m.applicationLedger).toEqual({version:99});expect(m.provenanceUncertain).toBe(true);
  expect(missionEvidenceView(m).application.join(" ")).toContain("identity not recorded for this version");
 });
});
