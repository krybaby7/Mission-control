// Historical fixture bytes stay fixed. Assert the new explicit unknown disclosure,
// then remove only the additive evidence fields for the old whole-output comparison.
import { expect } from "vitest";
import { missionEvidenceView } from "../src/mission-evidence.js";
import type { Snapshot,FeatureView,DebriefFeature } from "../src/dashboard/types.js";
export function evidenceHistoricalView(snapshot:Snapshot):Snapshot {
 const copy=structuredClone(snapshot);
 const unknown=missionEvidenceView({features:[{id:"legacy",frozenTests:[]}]});
 const feature=(f:FeatureView|DebriefFeature)=>{
  if(f.reviewRecord){expect(f.reviewRecord).toEqual({review:unknown.features[0]!.review,tests:unknown.features[0]!.tests});delete f.reviewRecord;}
 };
 for(const m of copy.missions){
  if(m.reviewRecord){expect(m.reviewRecord).toEqual({plan:unknown.plan,application:unknown.application});delete m.reviewRecord;}
  m.features.forEach(feature);
 }
 for(const m of copy.debrief?.missions??[]){
  if(m.reviewRecord){expect(m.reviewRecord).toEqual({plan:unknown.plan,application:unknown.application});delete m.reviewRecord;}
  [...m.got,...m.leftOut,...m.recovered].forEach(feature);
 }
 return copy;
}
