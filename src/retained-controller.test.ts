import { describe, expect, it } from "vitest";
import { RetainedController, atomicMissionEvidence } from "./retained-controller.js";
import { observeInvocation, journalOf, recoverInvocations, InvocationPersistenceError, type Reservation } from "./invocations.js";
import { pendingWrites } from "./retained-work.js";
import { interpretProvenance } from "./provenance.js";
import type { Mission, Feature } from "./types.js";
import type { WorkCapture } from "./work-capture.js";
const scope = { kind: "feature", featureId: "one" } as const;
const head = "a".repeat(40), next = "b".repeat(40), at = "2026-10-31T00:00:00.000Z";
const capture: WorkCapture = { scope, root: "/fixture/unit", universe: "git-source-v1", head, files: [], complete: true };
const subject = { kind: "feature_commit", featureId: "one", commit: head } as const;
const actual = { provider: "codex", family: "codex", model: "actual-model" } as const;
const reservation = (id = "writer"): Reservation => ({ jobId: id, label: "build-one", role: "engineer", access: "workspace-write", feature: "one", scope,
  stage: "build", baseSubject: subject, reservedAt: at, candidate: actual });
function fixture() {
  const f = { id: "one", title: "One", story: "One", acceptance: [], deps: [], kind: "standard", status: "pending",
    rung: 0, attempts: [], frozenTests: [], reviewRounds: 0, openFindings: [] } as Feature;
  const m = { agentRuns: 0, features: [f], stage: "features", status: "running", notes: [], workEvidenceVersion: 1 } as unknown as Mission;
  let disk = structuredClone(m), fail = false, saves = 0;
  const save = () => { saves++; if (fail) throw Error("fixture save failure"); disk = structuredClone(m); };
  const ctl = new RetainedController(m, save, () => at);
  return { m, f, ctl, save, fail: () => { fail = true; }, disk: () => disk, saves: () => saves };
}
function started() {
  const x = fixture(); expect(x.ctl.initialize(capture, capture, true)).toBe(true);
  expect(x.ctl.reserve(reservation(), 100, capture, [])).toBe(true);
  return x;
}
const written: WorkCapture = { ...capture, files: [{ path: "a.ts", sha256: "c".repeat(64), mode: "100644" }] };
function cleaned() {
  const x = started(); observeInvocation(x.m, "writer", actual, "failed", at, x.save);
  x.ctl.clean("writer", written, []); return x;
}
describe("root retained evidence transactions", () => {
  it("rolls back every own field and preserves original Feature references", () => {
    const x = fixture(); (x.f as unknown as Record<string,unknown>).explicit = undefined;
    const before = structuredClone(x.m); x.fail();
    expect(() => atomicMissionEvidence(x.m, x.save, () => {
      delete (x.f as unknown as Record<string,unknown>).explicit; x.f.passingCommit = next; x.f.status = "reviewing";
      x.m.stage = "gate_c"; x.m.notes.push("unsaved"); x.m.features = [];
      x.m.provenanceUncertain = true;
    })).toThrow(InvocationPersistenceError);
    expect(x.m).toEqual(before); expect(x.m.features[0]).toBe(x.f); expect(Object.hasOwn(x.f, "explicit")).toBe(true);
  });
  it("saves the reservation and before intent together exactly once", () => {
    const x = fixture(); x.ctl.initialize(capture, capture, true); const before = x.saves();
    x.ctl.reserve(reservation(), 100, capture, []);
    expect(x.saves()).toBe(before + 1); expect(x.disk().invocations?.entries[0]?.writeDisposition).toBe("pending");
    expect(x.disk().workTracking?.scopes[0]?.intents[0]?.jobId).toBe("writer");
  });
  it("leaves no reservation, count or intent after reserve-save failure", () => {
    const x = fixture(); x.ctl.initialize(capture, capture, true); const before = structuredClone(x.m); x.fail();
    expect(() => x.ctl.reserve(reservation(), 100, capture, [])).toThrow(InvocationPersistenceError);
    expect(x.m).toEqual(before); expect(x.m.agentRuns).toBe(0);
  });
  it("preserves damaged tracking while counting and cleaning the actual call", () => {
    const x = fixture(); (x.m as unknown as {workTracking:unknown}).workTracking = {version:999, raw:"preserve"};
    x.ctl.reserve(reservation(), 100, capture, []);
    observeInvocation(x.m, "writer", actual, "failed", at, x.save); x.ctl.clean("writer", written, []);
    expect(x.m.workTracking).toEqual({version:999, raw:"preserve"}); expect(x.f.provenanceUncertain).toBe(true);
    expect(x.m.agentRuns).toBe(1); expect(x.m.invocations?.entries[0]?.cleanedAt).toBe(at);
    expect(x.m.invocations?.entries[0]?.writeDisposition).toBe("pending");
  });
  it("saves finish bookkeeping with cleanup and rolls both back on failure", () => {
    const x = started(); observeInvocation(x.m, "writer", actual, "failed", at, x.save);
    const before = structuredClone(x.m); x.fail();
    expect(() => x.ctl.clean("writer", written, [])).toThrow(InvocationPersistenceError);
    expect(x.m).toEqual(before); expect(x.m.invocations?.entries[0]?.cleanedAt).toBeUndefined();
    expect(x.m.workTracking?.scopes[0]?.intents[0]?.phase).toBe("active");
  });
  it("adopts retained failed-call writes atomically with the accepted Feature state", () => {
    const x = cleaned(), accepted = {...written, head:next};
    const before = x.saves();
    expect(x.ctl.adopt(accepted, accepted, {...subject,commit:next}, undefined, () => {
      x.f.passingCommit = next; x.f.status = "reviewing";
    })).toBe(true);
    expect(x.saves()).toBe(before + 1); expect(x.disk().features[0]?.passingCommit).toBe(next);
    expect(x.disk().invocations?.entries[0]?.writeDisposition).toBe("adopted");
    const facts = interpretProvenance(x.f.provenance, {subject:{...subject,commit:next},hasPendingWrites:false,maxEntries:100,maxSnapshots:100});
    expect(facts.contributorJobIds).toEqual(["writer"]); expect(facts.contributionsComplete).toBe(true);
    expect(x.f.provenance?.entries[0]?.outcome).toBe("failed");
  });
  it("rolls adoption, dispositions and accepted stage back together on failure", () => {
    const x = cleaned(), accepted = {...written, head:next}, before = structuredClone(x.m); x.fail();
    expect(() => x.ctl.adopt(accepted, accepted, {...subject,commit:next}, undefined, () => {
      x.f.passingCommit = next; x.f.status = "reviewing";
    })).toThrow(InvocationPersistenceError);
    expect(x.m).toEqual(before); expect(x.m.features[0]).toBe(x.f);
    expect(x.m.invocations?.entries[0]?.writeDisposition).toBe("pending");
  });
  it("a content checkpoint for a failed attempt does not mark the feature passed", () => {
    const x = cleaned(), accepted = {...written, head:next}; x.ctl.adopt(accepted, accepted, {...subject,commit:next});
    expect(x.f.passingCommit).toBeUndefined(); expect(x.f.status).toBe("pending");
  });
  it.each(["missing_bootstrap", "legacy_count", "unattributed_writer", "feature_attempt"])("does not infer a fresh baseline from pending status with %s", kind => {
    const x = fixture();
    if (kind === "missing_bootstrap") delete x.m.workEvidenceVersion;
    if (kind === "legacy_count") x.m.agentRuns = 1;
    if (kind === "unattributed_writer") {
      const r = {...reservation(),scope:{kind:"controller"} as const,stage:"other" as const}; delete r.baseSubject;
      x.ctl.reserve(r,100,capture,[]);
    }
    if (kind === "feature_attempt") x.f.attempts.push({} as never);
    x.ctl.initialize(capture,capture,true);
    expect(x.m.workTracking?.scopes[0]?.complete).not.toBe(true);
  });
  it("persists reset intent even for already-adopted work with no pending writer", () => {
    const x = cleaned(), accepted = {...written,head:next}; x.ctl.adopt(accepted,accepted,{...subject,commit:next});
    const cp = x.ctl.checkpoint(scope,head)!; expect(cp).toBeDefined();
    expect(x.ctl.prepareRestore(scope,cp.id)).toBe(true);
    expect(x.disk().workRestore).toMatchObject({scope,checkpointId:cp.id,head});
    expect(x.m.invocations?.entries[0]?.writeDisposition).toBe("adopted");
  });
  it("retains reset intent and previous adopted state when final restoration save fails", () => {
    const x = cleaned(), accepted = {...written,head:next}; x.ctl.adopt(accepted,accepted,{...subject,commit:next});
    const cp = x.ctl.checkpoint(scope,head)!; x.ctl.prepareRestore(scope,cp.id);
    const before = structuredClone(x.m); x.fail();
    expect(() => x.ctl.restore(capture,capture,true)).toThrow(InvocationPersistenceError);
    expect(x.m).toEqual(before); expect(x.m.workRestore).toBeDefined();
  });
  it("settles an unobserved crashed writer only after explicit fresh full restoration", () => {
    const x = started(); recoverInvocations(x.m,undefined,{},at,x.save);
    const cp = x.ctl.checkpoint(scope,head)!; x.ctl.prepareRestore(scope,cp.id);
    expect(x.ctl.restore(capture,capture,false)).toBe(false); expect(x.m.workRestore).toBeDefined();
    expect(x.ctl.restore(capture,capture,true)).toBe(true);
    expect(x.m.workRestore).toBeUndefined(); expect(x.m.invocations?.entries[0]).toMatchObject({writeDisposition:"reverted",restoration:{checkpointId:cp.id}});
    expect(x.m.invocations?.entries[0]?.observation).toBeUndefined(); expect(x.m.invocations?.entries[0]?.cleanedAt).toBeUndefined();
    const p=pendingWrites(x.m.workTracking,journalOf(x.m),scope); expect(p.ok && p.complete).toBe(true);
  });
  it.each([false,true])("full restore republishes the narrowed terminal same-SHA selection atomically, save fails=%s", fail => {
    const x=cleaned(), b={...written,head:next};x.ctl.adopt(b,b,{...subject,commit:next});
    const old=x.ctl.checkpoint(scope,next)!;
    const c={...written,head:"d".repeat(40),files:[{path:"a.ts",sha256:"e".repeat(64),mode:"100644" as const}]};
    x.ctl.reserve(reservation("second"),100,b,[]);observeInvocation(x.m,"second",actual,"ok",at,x.save);x.ctl.clean("second",c,[]);
    x.ctl.adopt(c,c,{...subject,commit:c.head});
    x.ctl.reserve(reservation("third"),100,c,[]);observeInvocation(x.m,"third",actual,"ok",at,x.save);x.ctl.clean("third",b,[]);
    x.ctl.adopt(b,b,{...subject,commit:next});
    const ctx={subject:{...subject,commit:next},hasPendingWrites:false,maxEntries:100,maxSnapshots:100};
    expect(interpretProvenance(x.f.provenance,ctx).contributorJobIds.sort()).toEqual(["second","third","writer"]);
    expect(x.ctl.prepareRestore(scope,old.id)).toBe(true);
    const before=structuredClone(x.m);
    if(fail) {
      x.fail();expect(()=>x.ctl.restore(b,b,true)).toThrow(InvocationPersistenceError);
      expect(x.m).toEqual(before);expect(x.m.workRestore).toBeDefined();
      expect(interpretProvenance(x.f.provenance,ctx).contributorJobIds.sort()).toEqual(["second","third","writer"]);
    } else {
      expect(x.ctl.restore(b,b,true)).toBe(true);expect(x.m.workRestore).toBeUndefined();
      expect(interpretProvenance(x.f.provenance,ctx).contributorJobIds).toEqual(["writer"]);
      expect(interpretProvenance(x.f.provenance,ctx).contributionsComplete).toBe(true);
    }
  });
  it.each(["not-time","2026-99-99T00:00:00.000Z","2027-01-01T00:00:00.000Z"])("refuses malformed or future reset intent replay before Git: %s", time => {
    const x=cleaned();const cp=x.ctl.checkpoint(scope,head)!;x.ctl.prepareRestore(scope,cp.id);
    x.m.workRestore!.at=time;
    expect(x.ctl.prepareRestore(scope,cp.id)).toBe(false);
    expect(x.m.workRestore?.at).toBe(time);expect(x.f.provenanceUncertain).toBe(true);
  });
  it.each(["bad",next])("does not clear a partial restore whose intent head is not the selected checkpoint: %s", badHead => {
    const x=cleaned();const cp=x.ctl.checkpoint(scope,head)!;x.ctl.prepareRestore(scope,cp.id,["a.ts"]);
    x.m.workRestore!.head=badHead;
    expect(x.ctl.restore(capture,undefined,true)).toBe(false);
    expect(x.m.workRestore?.head).toBe(badHead);expect(x.m.invocations?.entries[0]?.writeDisposition).toBe("pending");
  });
  it.each(["undefined_paths","future_time","invalid_time","extra_key"])("retains malformed restore intent without settling it: %s", kind => {
    const x=cleaned();const cp=x.ctl.checkpoint(scope,head)!;x.ctl.prepareRestore(scope,cp.id);
    const raw=x.m.workRestore as unknown as Record<string,unknown>;
    if(kind==="undefined_paths") raw.paths=undefined;
    if(kind==="future_time") raw.at="2027-01-01T00:00:00.000Z";
    if(kind==="invalid_time") raw.at="2026-99-99T00:00:00.000Z";
    if(kind==="extra_key") raw.extra=true;
    expect(x.ctl.restore(capture,capture,true)).toBe(false);expect(x.m.workRestore).toBeDefined();
    expect(x.m.invocations?.entries[0]?.writeDisposition).toBe("pending");
  });
  it("keeps mismatched reset capture pending without discarding writers", () => {
    const x = cleaned(); const cp=x.ctl.checkpoint(scope,head)!; x.ctl.prepareRestore(scope,cp.id);
    expect(x.ctl.restore(written,written,true)).toBe(false);
    expect(x.m.workRestore).toBeDefined(); expect(x.m.invocations?.entries[0]?.writeDisposition).toBe("pending");
  });
});
