import {readFileSync} from "node:fs";
import {join} from "node:path";
import {afterEach,describe,expect,it,vi} from "vitest";
import {MissionHarness,feature,writeFeatureTest,featureTestPath,implementFeature,buildOutput,diagnosis} from "../test/fixtures/mission-harness.js";
import {interpretProvenance} from "./provenance.js";
import {frozenSetId} from "./retained-work.js";
import * as files from "./util/fs.js";
import * as captures from "./work-capture.js";
let h:MissionHarness|undefined;
afterEach(()=>{vi.restoreAllMocks();h?.cleanup();h=undefined;});
function harness(){
 h=new MissionHarness({features:[feature("greet")]});const hh=h;
 hh.agents.test_author=(job,call)=>call.n===1?{structured:{testFiles:[featureTestPath("greet")],notes:""},
  edit:cwd=>writeFeatureTest(cwd,"greet","GREET")}:hh.defaults.test_author(job,call);
 hh.agents.engineer=(job,call)=>call.label==="build-greet"?{edit:cwd=>implementFeature(cwd,"greet"),
  structured:buildOutput("implemented",call.n===1?{file:featureTestPath("greet"),reason:"The answer is lowercase"}:null)}:hh.defaults.engineer(job,call);
 hh.agents.architect=(job,call)=>call.label==="diagnose-greet"?{structured:diagnosis("amend_tests","Keep the code","The test expects uppercase")}:hh.defaults.architect(job,call);
 return hh;
}
describe("durable test amendment restack",()=>{
 it("keeps earlier code authors and retained test authors through the exact content-preserving restack",async()=>{
  const hh=harness(),m=await hh.run(hh.createMission("greenfield").id),f=m.features[0]!;
  expect(m.status).toBe("done");expect(f.provenanceUncertain).toBeUndefined();
  const members=[...f.frozenTests].sort((a,b)=>a.path<b.path?-1:1);
  const tests=interpretProvenance(f.provenance,{subject:{kind:"frozen_tests",featureId:f.id,testSetId:frozenSetId(members)},frozenMembers:members,hasPendingWrites:false,maxEntries:1000,maxSnapshots:1000});
  expect(tests.contributionsComplete).toBe(true);expect(tests.contributorJobIds.sort()).toEqual(hh.jobsLabeled("test-greet").map(j=>j.id).sort());
  const writes=interpretProvenance(f.provenance,{subject:{kind:"feature_commit",featureId:f.id,commit:f.passingCommit!},hasPendingWrites:false,maxEntries:1000,maxSnapshots:1000});
  expect(writes.contributionsComplete).toBe(true);expect(writes.contributorJobIds).toContain(hh.jobsLabeled("build-greet")[0]!.id);
  expect(readFileSync(join(m.repoPath,featureTestPath("greet")),"utf8")).toContain('"greet"');
 });
 it.each(["intent","middle","acceptance","proof","final-proof","scratch"])("preserves work and resumes after a %s boundary failure",async phase=>{
  const hh=harness(),id=hh.createMission("greenfield").id,save=hh.store.save.bind(hh.store),commit=hh.git.commitAll.bind(hh.git),capture=captures.captureWorktree;
  let hadIntent=false,failed=false,restackCaptures=0;let oldTests:string|undefined;
  const writeJson=files.writeJsonAtomic;
  vi.spyOn(files,"writeJsonAtomic").mockImplementation((path,data)=>{
   if(!failed&&phase==="scratch"&&path===join(hh.store.missionDir(id),"dispatch.json")&&hadIntent&&
      (data as {units?:{greet?:{pendingDiagnosis?:unknown}}}).units?.greet?.pendingDiagnosis===undefined){failed=true;throw Error("fixture scratch acknowledgement failure");}
   return writeJson(path,data);
  });
  vi.spyOn(hh.store,"save").mockImplementation((m,now)=>{
   const pending=(m as unknown as Record<string,unknown>).workRestack;
   if(pending){hadIntent=true;oldTests??=m.features[0]?.testsCommit;}
   if(!failed&&((phase==="intent"&&pending)||(phase==="acceptance"&&hadIntent&&!pending))){failed=true;throw Error("fixture restack save");}
   return save(m,now);
  });
  vi.spyOn(hh.git,"commitAll").mockImplementation(async(...args)=>{
   if(!failed&&phase==="middle"&&(hh.load(id) as unknown as Record<string,unknown>).workRestack&&args[1].includes("acceptance tests")){
    failed=true;throw Error("fixture test-only commit gap");
   }return commit(...args);
  });
  vi.spyOn(captures,"captureWorktree").mockImplementation(async(...args)=>{
   const result=await capture(...args);
   if((hh.load(id) as unknown as Record<string,unknown>).workRestack&&args[1].kind==="feature"){
    restackCaptures++;
    if(!failed&&((phase==="proof"&&restackCaptures===1)||(phase==="final-proof"&&restackCaptures===2))){
     failed=true;return {...result,complete:false};
    }
   }return result;
  });
  const stopped=await hh.run(id);expect(failed).toBe(true);expect(stopped.status).toBe("stopped");expect(stopped.features[0]?.testsCommit).toBe(oldTests);
  const calls=hh.jobsLabeled("test-greet").length;
  if(phase!=="intent"){
   expect((stopped as unknown as Record<string,unknown>).workRestack).toBeDefined();
   const resumed=await hh.run(id);expect(resumed.status).toBe("done");
   expect((resumed as unknown as Record<string,unknown>).workRestack).toBeUndefined();
   expect(hh.jobsLabeled("test-greet")).toHaveLength(calls);expect(resumed.features[0]?.provenanceUncertain).toBeUndefined();
  }
 });
 it("continues a legacy test rewrite without inventing recovered author identities",async()=>{
  const hh=harness(),id=hh.createMission("greenfield").id,stop=new AbortController();
  hh.agents.scout=(job,call)=>{
   if(call.label==="digest-greet")stop.abort();
   return hh.defaults.scout(job,call);
  };
  const first=await hh.run(id,{signal:stop.signal});expect(first.status).toBe("stopped");
  const legacy=hh.load(id);
  for(const key of ["invocations","workEvidenceVersion","workTracking","applicationLedger","provenance","provenanceUncertain","workRestore","workRestack"] as const)delete legacy[key];
  for(const f of legacy.features){delete f.provenance;delete f.provenanceUncertain;}
  hh.store.save(legacy);delete hh.agents.scout;
  const result=await hh.run(id),f=result.features[0]!;
  expect(result.status).toBe("done");expect(f.provenanceUncertain).toBe(true);
  expect(result.workRestack).toBeUndefined();
  const view=interpretProvenance(f.provenance,{subject:{kind:"feature_commit",featureId:f.id,commit:f.passingCommit!},hasPendingWrites:false,maxEntries:1000,maxSnapshots:1000});
  expect(view.contributionsComplete).toBe(false);
  expect(readFileSync(join(result.repoPath,featureTestPath("greet")),"utf8")).toContain('"greet"');
 });
 it("rejects a malformed restack marker before Git or model entry",async()=>{
  const hh=harness(),m=hh.createMission("greenfield");(m as unknown as Record<string,unknown>).workRestack={keep:"raw"};hh.store.save(m);
  const reset=vi.spyOn(hh.git,"resetHard");const result=await hh.run(m.id);
  expect(result.status).toBe("stopped");expect(reset).not.toHaveBeenCalled();expect(hh.jobs).toEqual([]);
  expect((result as unknown as Record<string,unknown>).workRestack).toEqual({keep:"raw"});
 });
});
