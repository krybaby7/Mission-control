import { preflightRetainedRestack, planRetainedRestack } from "./retained-restack.js";
// One authoritative MissionStore transaction around the detached evidence transitions.
// This module does no filesystem/Git/process work. The dispatcher supplies observed captures and fresh operation receipts.
import { isDeepStrictEqual } from "node:util";
import { cleanInvocation, InvocationPersistenceError, journalOf, reserveInvocation, restoreUnsettledInvocations, type Reservation } from "./invocations.js";
import { adoptRetained, frozenSetId, beginWriter, finishWriter, initializeTracking, pendingWrites, reconcileRestore, recoverInterruptedWriter, type Disposition, type RetainedCheckpoint } from "./retained-work.js";
import type { FrozenMember, WorkScope, WorkSubject } from "./provenance.js";
import type { WorkCapture } from "./work-capture.js";
import type { Mission, Feature } from "./types.js";

export interface WorkRestoreIntent { scope: WorkScope; checkpointId: string; head: string; at: string; paths?: string[]; }
export interface WorkRestackIntent {
  scope:Extract<WorkScope,{kind:"feature"}>;oldTestsCommit:string;rewriteCommit:string;rewriteCapture:WorkCapture;
  oldTestsCheckpointId?:string;rewriteCheckpointId?:string;
  testPaths:string[];carriedPaths:string[];frozenMembers:FrozenMember[];at:string;
}
const sameScope = (a: WorkScope, b: WorkScope): boolean => isDeepStrictEqual(a,b);
const writerScope = (s: WorkScope): boolean => s.kind === "feature" || s.kind === "application";
const noSave = () => {};
function replaceOwn(target: object, source: object): void {
  for (const key of Object.keys(target)) if (!Object.hasOwn(source,key)) Reflect.deleteProperty(target,key);
  Object.assign(target,source);
}
/** No nested real saves or async updates. Restore objects retained by the dispatcher's current stack. */
export function atomicMissionEvidence<T>(m: Mission, save: () => void, edit: () => T): T {
  const before = structuredClone(m), features = [...m.features];
  try {
    const value = edit();
    if (value instanceof Promise) throw new Error("Evidence transaction must be synchronous");
    journalOf(m); save(); return value;
  } catch (cause) {
    for (let i=0;i<features.length;i++) replaceOwn(features[i]!,before.features[i]!);
    replaceOwn(m,before); m.features=features;
    throw cause instanceof InvocationPersistenceError ? cause : new InvocationPersistenceError("Mission paused: retained work could not be saved together.",{cause});
  }
}
export class RetainedController {
  constructor(private readonly m: Mission, private readonly save: () => void, private readonly now: () => string) {}
  private target(scope: WorkScope): Mission | Feature {
    if (scope.kind !== "feature") return this.m;
    const rows=this.m.features.filter(f=>f.id===scope.featureId);
    if(rows.length!==1) throw new InvocationPersistenceError("Retained work has an ambiguous feature scope.");
    return rows[0]!;
  }
  private uncertain(scope: WorkScope): void { this.target(scope).provenanceUncertain=true; }
  private transact<T>(edit:()=>T):T { return atomicMissionEvidence(this.m,this.save,edit); }
  private fresh(scope: WorkScope, requested: boolean): boolean {
    if (!requested || this.m.workEvidenceVersion!==1 || (Object.hasOwn(this.m,"workRestore")||Object.hasOwn(this.m,"workRestack"))) return false;
    const j=journalOf(this.m);
    if(j.legacyAgentRuns!==0 || j.recoveries.some(r=>r.legacyMarker!==undefined) || j.entries.some(e=>e.access==="workspace-write" &&
      (e.scope.kind==="controller" || e.scope.kind==="plan" || sameScope(e.scope,scope)))) return false;
    if(scope.kind==="feature") {
      const f=this.target(scope) as Feature;
      return f.status==="pending" && f.attempts.length===0 && f.passingCommit===undefined && f.frozenTests.length===0;
    }
    return scope.kind==="application";
  }
  initialize(capture:WorkCapture, committed:WorkCapture, requestedFresh:boolean):boolean {
    const scope=capture.scope;
    const existing=pendingWrites(this.m.workTracking,journalOf(this.m),scope);
    if(existing.ok) return true; // no replacement/re-baselining of an existing scope
    return this.transact(()=>{
      const fresh=this.fresh(scope,requestedFresh) && capture.complete && isDeepStrictEqual(capture,committed);
      const initialized=initializeTracking(capture,{...(Object.hasOwn(this.m,"workTracking") && {state:this.m.workTracking}),
        ...(fresh && capture.head && {freshBaseline:{head:capture.head,beforeMissionWrites:true as const,noRetainedAiWriters:true as const}})});
      if(!initialized.ok) { this.uncertain(scope); return false; }
      this.m.workTracking=initialized.state;
      if(!capture.head || !writerScope(scope)) {this.uncertain(scope);return false;}
      const subject:WorkSubject=scope.kind==="feature"?{kind:"feature_commit",featureId:scope.featureId,commit:capture.head}:{kind:"application_commit",commit:capture.head};
      const target=this.target(scope);
      const adopted=adoptRetained(initialized.state,{scope,capture,committed,subject,at:this.now(),journal:journalOf(this.m),provenance:target.provenance});
      if(!adopted.ok) {this.uncertain(scope);return false;}
      this.m.workTracking=adopted.state; target.provenance=adopted.provenance;
      return true;
    });
  }
  reserve(reservation:Reservation, cap:number, before:WorkCapture, frozenPaths:string[]):boolean {
    return this.transact(()=>{
      if(!reserveInvocation(this.m,reservation,cap,noSave)) return false;
      const scope=before.scope;
      if(reservation.access!=="workspace-write" || reservation.scope.kind==="controller" || !sameScope(reservation.scope,scope) || !writerScope(scope)) {
        this.uncertain(scope); return true;
      }
      const begun=beginWriter(this.m.workTracking,{jobId:reservation.jobId,scope,stage:reservation.stage,before,frozenPaths});
      if(begun.ok) this.m.workTracking=begun.state; else this.uncertain(scope);
      return true;
    });
  }
  clean(jobId:string,after:WorkCapture,testPaths:string[]):void {
    this.transact(()=>{
      const finished=finishWriter(this.m.workTracking,{jobId,after,testPaths,journal:journalOf(this.m)});
      if(finished.ok) this.m.workTracking=finished.state; else this.uncertain(after.scope);
      cleanInvocation(this.m,jobId,this.now(),noSave);
    });
  }
  recover(jobId:string,recoveryKey:string,after:WorkCapture,testPaths:string[]):boolean {
    return this.transact(()=>{
      const result=recoverInterruptedWriter(this.m.workTracking,{jobId,after,journal:journalOf(this.m),testPaths,
        reap:{jobId,recoveryKey,at:this.now()}});
      if(!result.ok){this.uncertain(after.scope);return false;}
      this.m.workTracking=result.state;return true;
    });
  }
  private dispositions(rows:Disposition[], proof?:{checkpointId:string;subject:Extract<WorkSubject,{kind:"feature_commit"|"application_commit"}>}):void {
    const journal=journalOf(this.m), uncleaned:string[]=[];
    for(const row of rows) {
      const e=journal.entries.find(e=>e.jobId===row.jobId);
      if(!e || e.access!=="workspace-write") throw new InvocationPersistenceError("Retained disposition has no matching writer.");
      if(e.cleanedAt===undefined) {
        if(row.disposition!=="reverted" || !proof) throw new InvocationPersistenceError("Unobserved work cannot be adopted.");
        uncleaned.push(e.jobId);
      } else {if(!e.observation) throw new InvocationPersistenceError(); e.writeDisposition=row.disposition;}
    }
    this.m.invocations=journal;
    if(uncleaned.length && proof) restoreUnsettledInvocations(this.m,uncleaned,{at:this.now(),checkpointId:proof.checkpointId,subject:proof.subject,cleanupComplete:true},noSave);
    journalOf(this.m);
  }
  adopt(capture:WorkCapture,committed:WorkCapture,subject:WorkSubject,frozenMembers?:FrozenMember[],accept?:()=>void):boolean {
    return this.transact(()=>{
      const scope=capture.scope,target=this.target(scope);
      const adopted=adoptRetained(this.m.workTracking,{scope,capture,committed,subject,at:this.now(),journal:journalOf(this.m),provenance:target.provenance,
        ...(frozenMembers!==undefined && {frozenMembers})});
      if(adopted.ok) {
        this.m.workTracking=adopted.state; target.provenance=adopted.provenance; this.dispositions(adopted.dispositions);
      } else this.uncertain(scope);
      accept?.(); // Option A keeps prior checking behavior even when provenance is unknown.
      return adopted.ok;
    });
  }
  private restackIntent(raw:unknown):raw is WorkRestackIntent {
    try {
      if(!raw||typeof raw!=="object"||Array.isArray(raw))return false;
      const v=raw as WorkRestackIntent,keys=Object.keys(v),required=["scope","oldTestsCommit","rewriteCommit","rewriteCapture","testPaths","carriedPaths","frozenMembers","at"];
      if(!required.every(k=>Object.hasOwn(v,k))||keys.some(k=>![...required,"oldTestsCheckpointId","rewriteCheckpointId"].includes(k))||
        !v.scope||v.scope.kind!=="feature"||Object.keys(v.scope).length!==2||
        !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v.oldTestsCommit)||!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v.rewriteCommit)||
        typeof v.at!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v.at)||new Date(v.at).toISOString()!==v.at||v.at>this.now())return false;
      const f=this.target(v.scope) as Feature;
      if(f.status!=="building"||f.testsCommit!==v.oldTestsCommit||!f.worktree||v.rewriteCapture?.root!==f.worktree||
        !sameScope(v.rewriteCapture.scope,v.scope)||!v.rewriteCapture.complete||v.rewriteCapture.head!==v.rewriteCommit||
        v.rewriteCapture.files.length>20000||!initializeTracking(v.rewriteCapture).ok)return false;
      const validPaths=(paths:unknown):paths is string[]=>{
        if(!Array.isArray(paths)||paths.length>20000)return false;
        let prior="";for(const p of paths){
          if(typeof p!=="string"||!p||p.length>4096||p<=prior||p.startsWith("/")||/^[a-z]:/iu.test(p)||
            /[\\\u0000-\u001f\u007f-\u009f\ufffd]/u.test(p)||p.split("/").some(x=>!x||x==="."||x===".."||x===".git"))return false;
          prior=p;
        }return true;
      };
      if(!validPaths(v.testPaths)||!validPaths(v.carriedPaths)||v.testPaths.length+v.carriedPaths.length>20000||
        v.testPaths.some(p=>v.carriedPaths.includes(p))||!Array.isArray(v.frozenMembers)||v.frozenMembers.length>20000)return false;
      frozenSetId(v.frozenMembers);
      const files=new Map(v.rewriteCapture.files.map(f=>[f.path,f]));
      if(v.frozenMembers.some(m=>files.get(m.path)?.sha256!==m.sha256))return false;
      const old=Object.hasOwn(v,"oldTestsCheckpointId"),rewrite=Object.hasOwn(v,"rewriteCheckpointId");
      if(old!==rewrite)return false;
      if(old) {
        const preflight=preflightRetainedRestack(this.m.workTracking,{scope:v.scope,journal:journalOf(this.m),
          oldTestsCheckpointId:v.oldTestsCheckpointId!,rewriteCheckpointId:v.rewriteCheckpointId!,
          testPaths:v.testPaths,carriedPaths:v.carriedPaths,frozenMembers:v.frozenMembers});
        if(!preflight.ok||preflight.geometry.oldTestsCommit!==v.oldTestsCommit||preflight.geometry.rewriteCommit!==v.rewriteCommit||
          !isDeepStrictEqual(preflight.geometry.expectedFinalFiles,v.rewriteCapture.files))return false;
      } else if(!Object.hasOwn(f,"provenanceUncertain"))return false; // legacy path cannot earn recovered attribution
      return true;
    } catch {return false;}
  }
  prepareRestack(intent:WorkRestackIntent):boolean {
    if(!this.restackIntent(intent)||Object.hasOwn(this.m,"workRestore"))return false;
    return this.transact(()=>{
      if(Object.hasOwn(this.m,"workRestack"))return this.restackIntent(this.m.workRestack)&&isDeepStrictEqual(this.m.workRestack,intent);
      this.m.workRestack=structuredClone(intent);return true;
    });
  }
  finishRestack(tests:WorkCapture,testsCommitted:WorkCapture,final:WorkCapture,finalCommitted:WorkCapture,operationCompleted:boolean):boolean {
    const intent=this.m.workRestack;
    if(!operationCompleted||!this.restackIntent(intent))return false;
    const pair=(a:WorkCapture,b:WorkCapture)=>a.complete&&isDeepStrictEqual(a,b)&&initializeTracking(a).ok&&
      sameScope(a.scope,intent.scope)&&a.root===intent.rewriteCapture.root;
    if(!pair(tests,testsCommitted)||!pair(final,finalCommitted)||!isDeepStrictEqual(final.files,intent.rewriteCapture.files)||
      intent.frozenMembers.some(m=>tests.files.find(f=>f.path===m.path)?.sha256!==m.sha256))return false;
    return this.transact(()=>{
      const f=this.target(intent.scope) as Feature;
      if(intent.oldTestsCheckpointId!==undefined&&intent.rewriteCheckpointId!==undefined) {
        const plan=planRetainedRestack(this.m.workTracking,{scope:intent.scope,journal:journalOf(this.m),provenance:f.provenance,
          oldTestsCheckpointId:intent.oldTestsCheckpointId,rewriteCheckpointId:intent.rewriteCheckpointId,
          testPaths:intent.testPaths,carriedPaths:intent.carriedPaths,frozenMembers:intent.frozenMembers,at:this.now(),
          tests:{capture:tests,committed:testsCommitted},final:{capture:final,committed:finalCommitted}});
        if(!plan.ok)throw new InvocationPersistenceError("Rewritten work could not be bound to its retained authors.");
        this.m.workTracking=plan.final.state;f.provenance=plan.final.provenance;this.dispositions(plan.dispositions);
      } else f.provenanceUncertain=true;
      f.testsCommit=tests.head!;f.frozenTests=structuredClone(intent.frozenMembers);
      delete this.m.workRestack;return true;
    });
  }
  checkpoint(scope:WorkScope,head:string):RetainedCheckpoint|undefined {
    const valid=pendingWrites(this.m.workTracking,journalOf(this.m),scope);
    if(!valid.ok) return undefined;
    const selected=valid.state.scopes.find(s=>sameScope(s.scope,scope));
    const candidates=selected?.checkpoints.filter(cp=>cp.capture.head===head)??[];
    // A known current basis wins; otherwise an ambiguous same-commit history cannot narrow authors.
    const cp=candidates.find(cp=>cp.id===selected?.baseCheckpointId) ?? (candidates.length===1?candidates[0]:undefined);
    if(!cp) return undefined;
    const checked=reconcileRestore(valid.state,{scope,checkpointId:cp.id,after:cp.capture,provenance:this.target(scope).provenance});
    return checked.ok?structuredClone(cp):undefined;
  }
  private restoreIntent(raw:unknown):raw is WorkRestoreIntent {
    if(!raw || typeof raw!=="object" || Array.isArray(raw))return false;
    const v=raw as Record<string,unknown>, keys=Object.keys(v);
    if(!["scope","checkpointId","head","at"].every(k=>Object.hasOwn(v,k)) || keys.some(k=>!["scope","checkpointId","head","at","paths"].includes(k)) ||
      typeof v.checkpointId!=="string" || !/^[a-f0-9]{64}$/u.test(v.checkpointId) || typeof v.head!=="string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(v.head) ||
      typeof v.at!=="string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(v.at) ||
      !Number.isFinite(Date.parse(v.at)) || new Date(v.at).toISOString()!==v.at || v.at>this.now())return false;
    if(!v.scope || typeof v.scope!=="object" || Array.isArray(v.scope))return false;
    const scope=v.scope as Record<string,unknown>;
    if(scope.kind==="application") {if(Object.keys(scope).length!==1)return false;}
    else if(scope.kind==="feature") {
      if(Object.keys(scope).length!==2 || typeof scope.featureId!=="string" || !scope.featureId || scope.featureId.length>200 || /[\u0000-\u001f\u007f-\u009f]/u.test(scope.featureId))return false;
    } else return false;
    if(Object.hasOwn(v,"paths") && (!Array.isArray(v.paths) || v.paths.length>20000 || new Set(v.paths).size!==v.paths.length ||
      v.paths.some(p=>typeof p!=="string" || !p || p.length>4096 || p.startsWith("/") || /^[a-z]:/iu.test(p) ||
        /[\\\u0000-\u001f\u007f-\u009f\ufffd]/u.test(p) || p.split("/").some(s=>!s || s==="." || s===".." || s===".git"))))return false;
    const checked=pendingWrites(this.m.workTracking,journalOf(this.m),v.scope as WorkScope);
    if(!checked.ok)return false;
    const cp=checked.state.scopes.find(s=>sameScope(s.scope,v.scope as WorkScope))?.checkpoints.find(cp=>cp.id===v.checkpointId);
    return !!cp && cp.capture.head===v.head && reconcileRestore(checked.state,{scope:cp.capture.scope,checkpointId:cp.id,after:cp.capture,
      provenance:this.target(cp.capture.scope).provenance}).ok;
  }
  prepareRestore(scope:WorkScope,checkpointId:string,paths?:string[]):boolean {
    const valid=pendingWrites(this.m.workTracking,journalOf(this.m),scope);
    const cp=valid.ok?valid.state.scopes.find(s=>sameScope(s.scope,scope))?.checkpoints.find(c=>c.id===checkpointId):undefined;
    if(!cp?.capture.head || !reconcileRestore(this.m.workTracking,{scope,checkpointId,after:cp.capture,provenance:this.target(scope).provenance}).ok || (paths!==undefined &&
      (paths.length>20000 || new Set(paths).size!==paths.length || paths.some(p=>!p || p.length>4096 || p.startsWith("/") || /[\\\u0000-\u001f\u007f-\u009f]/u.test(p) || p.split("/").some(s=>!s || s==="." || s===".."))))) {
      return this.transact(()=>{this.uncertain(scope);return false;});
    }
    return this.transact(()=>{
      const next:WorkRestoreIntent={scope:structuredClone(scope),checkpointId,head:cp.capture.head!,at:this.now(),...(paths!==undefined&&{paths:[...paths]})};
      if(!this.restoreIntent(next)){this.uncertain(scope);return false;}
      if(Object.hasOwn(this.m,"workRestore")) {
        const prior=this.m.workRestore;
        if(!this.restoreIntent(prior) || !isDeepStrictEqual({...next,at:prior.at},prior)) {this.uncertain(scope);return false;}
        return true;
      }
      this.m.workRestore=next;return true;
    });
  }
  /** operationCompleted means root just reaped children and successfully executed this exact Git restoration. */
  restore(after:WorkCapture,committed:WorkCapture|undefined,operationCompleted:boolean,accept?:()=>void):boolean {
    const intent=this.m.workRestore;
    if(!operationCompleted) return false;
    return this.transact(()=>{
      if(!this.restoreIntent(intent) || !sameScope(intent.scope,after.scope) ||
        (intent.paths===undefined && (!committed || !after.complete || !isDeepStrictEqual(after,committed) || after.head!==intent.head))) {
        this.uncertain(after.scope);return false;
      }
      const result=reconcileRestore(this.m.workTracking,{scope:after.scope,checkpointId:intent.checkpointId,after,provenance:this.target(after.scope).provenance,
        ...(Object.hasOwn(intent,"paths") && {paths:intent.paths})});
      if(!result.ok) {this.uncertain(after.scope);return false;}
      if(after.scope.kind==="plan") {this.uncertain(after.scope);return false;}
      const subject=after.scope.kind==="feature"?{kind:"feature_commit" as const,featureId:after.scope.featureId,commit:intent.head}:{kind:"application_commit" as const,commit:intent.head};
      this.m.workTracking=result.state; this.dispositions(result.dispositions,{checkpointId:intent.checkpointId,subject});
      if(intent.paths===undefined) {
        const selected=result.state.scopes.find(s=>sameScope(s.scope,after.scope))!;
        const cp=selected.checkpoints.find(c=>c.id===intent.checkpointId)!;
        const target=this.target(after.scope);
        const snapshot=target.provenance?.retained?.find(row=>isDeepStrictEqual(row.subject,cp.selection.subject) &&
          (row.revision??null)===cp.selection.revision);
        const frozenMembers=snapshot?.kind==="tests"?snapshot.members.map(m=>({path:m.path,sha256:m.sha256})).sort((a,b)=>a.path<b.path?-1:1):undefined;
        const published=adoptRetained(result.state,{scope:after.scope,capture:after,committed:committed!,subject:cp.selection.subject,
          at:this.now(),journal:journalOf(this.m),provenance:target.provenance,...(frozenMembers!==undefined&&{frozenMembers})});
        if(!published.ok) throw new InvocationPersistenceError("Restored work could not publish its current retained selection.");
        this.m.workTracking=published.state;target.provenance=published.provenance;this.dispositions(published.dispositions);
      }
      delete this.m.workRestore; accept?.();return true;
    });
  }
}
