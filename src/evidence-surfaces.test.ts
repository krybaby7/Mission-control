import { afterEach,describe,expect,it,vi } from "vitest";
import { MissionHarness,feature,writeFile,review } from "../test/fixtures/mission-harness.js";
import { missionEvidenceView } from "./mission-evidence.js";
import { renderReport } from "./report.js";
import { main } from "./cli.js";
import { buildSnapshot,builtInSettings } from "./dashboard/snapshot.js";
import { clearReadCache } from "./dashboard/read.js";
let h:MissionHarness|undefined;
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllEnvs();clearReadCache();h?.cleanup();h=undefined;});
describe("one recorded evidence interpretation on owner surfaces",()=>{
 it.each(["ordinary","fallback","repair","legacy","damaged"])("%s records agree across report, CLI details, dashboard features and final summary",async kind=>{
  h=new MissionHarness({features:[feature("greet")]});const hh=h,id=hh.createMission("greenfield").id;
  if(kind==="fallback")hh.agents.engineer=(job,call)=>call.label==="build-greet"&&call.n===1?
   {outcome:"auth",edit:cwd=>writeFile(cwd,"first-writer.txt","Retained")}:hh.defaults.engineer(job,call);
  if(kind==="repair")hh.agents.reviewer=(job,call)=>call.label==="review-greet"&&call.n===1?
   {structured:review([{severity:"major",file:"src/greet.mjs",description:"Add the requested note",suggestedTest:null}])}:hh.defaults.reviewer(job,call);
  const m=await hh.run(id);
  if(kind==="legacy"){delete m.invocations;delete m.workTracking;delete m.provenance;delete m.applicationLedger;for(const f of m.features)delete f.provenance;}
  if(kind==="damaged")m.features[0]!.provenance={version:99,entries:[]} as never;
  // A forged cached view is never authoritative.
  (m as unknown as Record<string,unknown>).reviewRecord={application:["Forged independent review"]};
  hh.store.save(m);const expected=missionEvidenceView(m);
  const report=renderReport(m,{usage:[],screenshots:[],generatedAt:m.updatedAt,inContainer:false});
  let out="";vi.stubEnv("MC_CONFIG","");expect(await main(["node","mc","plan","show",id],{stdout:t=>out+=t,stderr:t=>out+=t})).toBe(0);
  const snapshot=buildSnapshot({home:hh.home,now:Date.parse(m.updatedAt)+1000,timeZone:"UTC",settings:builtInSettings()});
  const mission=snapshot.missions.find(row=>row.id===id)!;
  const evidence=(mission as unknown as {reviewRecord:{plan:string[];application:string[]}}).reviewRecord;
  expect(evidence).toEqual({plan:expected.plan,application:expected.application});
  for(const f of expected.features){
   const shown=mission.features.find(row=>row.id===f.id) as unknown as {reviewRecord:{review:string[];tests:string[]}};
   expect(shown.reviewRecord).toEqual({review:f.review,tests:f.tests});
   for(const line of [...f.review,...f.tests]){expect(report).toContain(line);expect(out).toContain(line);}
  }
  for(const line of [...expected.plan,...expected.application]){expect(report).toContain(line);expect(out).toContain(line);}
  const debrief=snapshot.debrief?.missions.find(row=>row.missionId===id) as unknown as {reviewRecord:{plan:string[];application:string[]}};
  expect(debrief.reviewRecord).toEqual(evidence);
  expect(report+out+JSON.stringify(snapshot)).not.toContain("Forged independent review");
 });
});
