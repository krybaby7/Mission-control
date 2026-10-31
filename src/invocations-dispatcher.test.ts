import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MissionHarness, feature } from "../test/fixtures/mission-harness.js";
import type { Mission } from "./types.js";
import { cleanInvocation, observeInvocation, reserveInvocation } from "./invocations.js";
import * as files from "./util/fs.js";
let h: MissionHarness | undefined;
afterEach(() => { vi.restoreAllMocks(); h?.cleanup(); h = undefined; });
function harness() { h = new MissionHarness({ features: [feature("greet")] }); return h; }
describe("dispatcher durable invocation lifecycle", () => {
  it("persists reservation and count before a stand-in sees the job", async () => {
    const hh = harness(); const id = hh.createMission("greenfield").id;
    hh.config.limits.maxAgentRunsPerMission = 1;
    hh.agents.architect = (job, call) => {
      const saved = hh.load(id);
      expect(saved.agentRuns).toBe(1);
      expect(saved.invocations?.entries).toHaveLength(1);
      expect(saved.invocations?.entries[0]).toMatchObject({ jobId: job.id, candidate: { provider: job.provider, model: job.model } });
      expect(saved.invocations?.entries[0]?.observation).toBeUndefined();
      return hh.defaults.architect(job, call);
    };
    const m = await hh.run(id);
    expect(hh.jobs).toHaveLength(1);
    expect(m.invocations?.entries[0]?.observation?.outcome).toBe("ok");
    expect(m.invocations?.entries[0]?.cleanedAt).toBeTruthy();
  });
  it("enforces the cap inside auth failover instead of counting only the final answer", async () => {
    const hh = harness(); hh.config.limits.maxAgentRunsPerMission = 1;
    hh.agents.architect = () => ({ outcome: "auth", error: "fake login unavailable" });
    const m = await hh.run(hh.createMission("greenfield").id);
    expect(hh.jobs).toHaveLength(1); expect(m.agentRuns).toBe(1);
    expect(m.invocations?.entries[0]?.observation?.outcome).toBe("auth");
    expect(m.status).toBe("partial");
  });
  it.each(["reserve", "observe", "clean"] as const)("keeps the stage and pending state after a %s save failure", async phase => {
    const hh = harness(); const id = hh.createMission("greenfield").id;
    const real = hh.store.save.bind(hh.store); let failed = false;
    vi.spyOn(hh.store, "save").mockImplementation((m: Mission, now?: number) => {
      const entry = m.invocations?.entries[0];
      if (!failed && entry && (phase === "reserve" ? !entry.observation : phase === "observe" ? !!entry.observation : !!entry.cleanedAt)) {
        failed = true; throw Error("synthetic write failure");
      }
      return real(m, now);
    });
    const m = await hh.run(id);
    expect(failed).toBe(true); expect(m.status).toBe("stopped"); expect(m.stage).toBe("spec");
    expect(hh.jobs).toHaveLength(phase === "reserve" ? 0 : 1);
    expect(m.agentRuns).toBe(phase === "reserve" ? 0 : 1);
    if (phase !== "reserve") {
      if (phase === "observe") expect(m.invocations?.entries[0]?.observation).toBeUndefined();
      else expect(m.invocations?.entries[0]?.observation?.outcome).toBe("ok");
      expect(m.invocations?.entries[0]?.cleanedAt).toBeUndefined();
      const scratch = JSON.parse(readFileSync(join(hh.store.missionDir(id), "dispatch.json"), "utf8"));
      expect(scratch.inflight.jobId).toBe(hh.jobs[0]?.id);
    }
  });
  it("blocks a corrupt journal before any model work and preserves it", async () => {
    const hh = harness(); const initial = hh.createMission("greenfield");
    (initial as unknown as { invocations: unknown }).invocations = { version: 999 };
    hh.store.save(initial);
    const m = await hh.run(initial.id);
    expect(hh.jobs).toHaveLength(0); expect(m.status).toBe("stopped");
    expect(m.invocations).toEqual({ version: 999 });
  });
  it("does not recast an unknown durable scratch job as a legacy extra attempt", async () => {
    const hh = harness(); const initial = hh.createMission("greenfield");
    writeFileSync(join(hh.store.missionDir(initial.id), "dispatch.json"), JSON.stringify({ units: {}, inflight: {
      jobId: "lost-1", label: "lost", at: "2026-10-31T00:00:00.000Z",
    } }));
    const m = await hh.run(initial.id);
    expect(hh.jobs).toHaveLength(0); expect(m.status).toBe("stopped"); expect(m.agentRuns).toBe(0);
  });
  it("clears a stale marker for a cleaned reservation without counting an interruption", async () => {
    const hh = harness(); const m = hh.createMission("greenfield");
    const at = "2026-10-30T00:00:00.000Z";
    const identity = { provider: "claude", family: "claude", model: "existing-model" } as const;
    reserveInvocation(m, { jobId: "spec-1", label: "spec", role: "architect", access: "read-only", scope: { kind: "controller" }, stage: "other", candidate: identity, reservedAt: at }, 10, () => hh.store.save(m));
    observeInvocation(m, "spec-1", identity, "ok", at, () => hh.store.save(m));
    cleanInvocation(m, "spec-1", at, () => hh.store.save(m));
    writeFileSync(join(hh.store.missionDir(m.id), "dispatch.json"), JSON.stringify({ units: {}, inflight: { jobId: "spec-1", label: "spec", at } }));
    hh.config.limits.maxAgentRunsPerMission = 1;
    const resumed = await hh.run(m.id);
    expect(resumed.agentRuns).toBe(1); expect(resumed.invocations?.recoveries).toEqual([]); expect(hh.jobs).toHaveLength(0);
  });
  it("replays a threshold decision after its acknowledgement save failed, without recounting", async () => {
    const hh = harness(); const m = hh.createMission("greenfield");
    writeFileSync(join(hh.store.missionDir(m.id), "dispatch.json"), JSON.stringify({ units: {}, interruptions: { spec: 2 }, inflight: { label: "spec", at: "2026-10-30T00:00:00.000Z" } }));
    const real = hh.store.save.bind(hh.store); let failed = false;
    vi.spyOn(hh.store, "save").mockImplementation((next: Mission, now?: number) => {
      if (!failed && next.invocations?.recoveries[0]?.handled) { failed = true; throw Error("synthetic acknowledgement failure"); }
      return real(next, now);
    });
    const first = await hh.run(m.id);
    expect(first.status).toBe("stopped"); expect(first.agentRuns).toBe(1);
    expect(first.invocations?.recoveries[0]?.handled).toBeUndefined();
    const second = await hh.run(m.id);
    expect(second.status).toBe("failed"); expect(second.agentRuns).toBe(1);
    expect(second.invocations?.recoveries[0]?.handled).toBe(true);
    expect(second.invocations?.interruptionCounts.spec).toBe(0); expect(hh.jobs).toHaveLength(0);
  });
  it.each([1, 2, 3])("stops on scratch recovery write %i failure and retries without double accounting", async failureAt => {
    const hh = harness(); const m = hh.createMission("greenfield");
    const scratchPath = join(hh.store.missionDir(m.id), "dispatch.json");
    writeFileSync(scratchPath, JSON.stringify({ units: {}, interruptions: { spec: 2 }, inflight: { label: "spec", at: "2026-10-30T00:00:00.000Z" } }));
    const real = files.writeJsonAtomic; let writes = 0;
    vi.spyOn(files, "writeJsonAtomic").mockImplementation((path, data) => {
      if (path === scratchPath && ++writes === failureAt) throw Error("synthetic scratch failure");
      return real(path, data);
    });
    const first = await hh.run(m.id);
    expect(first.status).toBe("stopped"); expect(first.stage).toBe("spec"); expect(first.agentRuns).toBe(1);
    expect(first.invocations?.recoveries).toHaveLength(1);
    hh.config.limits.maxAgentRunsPerMission = 1;
    const second = await hh.run(m.id);
    expect(second.agentRuns).toBe(1); expect(second.invocations?.recoveries).toHaveLength(1);
    expect(second.invocations?.interruptionCounts.spec).toBe(0); expect(hh.jobs).toHaveLength(0);
  });
});

describe("allowance pause integration", () => {
  it("stops before model launch with stage and owner decisions preserved", async () => {
    const hh = harness(); hh.config.pacing.unknownAllowance = "stop";
    const initial = hh.createMission("greenfield"); initial.decisionsNeeded = ["Existing owner decision"]; hh.store.save(initial);
    const m = await hh.run(initial.id);
    expect(m.status).toBe("stopped"); expect(m.stage).toBe("spec");
    expect(m.allowancePolicy).toBe("stop");
    expect(m.pause).toMatchObject({ kind: "allowance_unknown", providers: ["claude", "codex"] });
    expect(m.decisionsNeeded).toEqual(["Existing owner decision"]);
    expect(m.failure).toBeUndefined(); expect(m.agentRuns).toBe(0); expect(hh.jobs).toHaveLength(0);
    expect(readFileSync(hh.store.reportPath(m.id), "utf8")).toContain("allowance could not be confirmed");
  });
  it("deliberate warn invocation clears only the allowance pause when admitted", async () => {
    const hh = harness(); hh.config.pacing.unknownAllowance = "stop";
    const paused = await hh.run(hh.createMission("greenfield").id);
    expect(paused.pause?.kind).toBe("allowance_unknown");
    hh.config.pacing.unknownAllowance = "warn"; hh.config.limits.maxAgentRunsPerMission = 1;
    const resumed = await hh.run(paused.id);
    expect(resumed.allowancePolicy).toBe("warn"); expect(resumed.pause).toBeUndefined();
    expect(hh.jobs).toHaveLength(1);
  });
  it("a failed reservation save retains the original allowance pause", async () => {
    const hh = harness(); const initial = hh.createMission("greenfield");
    initial.pause = { kind: "allowance_unknown", providers: ["codex"], reason: "old missing readings", at: "2026-10-30T00:00:00.000Z" };
    hh.store.save(initial);
    const real = hh.store.save.bind(hh.store); let failed = false;
    vi.spyOn(hh.store, "save").mockImplementation((m: Mission, now?: number) => {
      if (!failed && m.invocations?.entries.length) { failed = true; throw Error("synthetic reservation failure"); }
      return real(m, now);
    });
    const m = await hh.run(initial.id);
    expect(m.pause).toEqual(initial.pause); expect(hh.jobs).toHaveLength(0); expect(m.agentRuns).toBe(0);
  });
});
