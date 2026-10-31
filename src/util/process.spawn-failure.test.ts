// Spawn failures that cannot be provoked safely inside the test runner, simulated at the spawn() boundary.
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { controllerGitEnv } from "./launch-env.js";
import { runProcess } from "./process.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

/** What Node's spawn() returns on EMFILE/ENFILE: no pid, no stdio streams, and an "error" on the next tick. */
function childWithoutStdio(code: string): ChildProcess {
  const child = new EventEmitter();
  process.nextTick(() => child.emit("error", Object.assign(new Error(`spawn node ${code}`), { code, syscall: "spawn node" })));
  return child as ChildProcess;
}

describe("runProcess: out of file descriptors", () => {
  it.each(["EMFILE", "ENFILE"])("reports %s as a spawnError instead of rejecting or crashing", async (code) => {
    vi.mocked(spawn).mockImplementationOnce(() => childWithoutStdio(code));
    const r = await runProcess({ env: controllerGitEnv(), command: "node", args: [], cwd: tmpdir(), timeoutMs: 5_000 });
    expect(r).toMatchObject({ exitCode: null, signal: null, timedOut: false, aborted: false, stdout: "", stderr: "" });
    expect(r.spawnError).toBe(`${code}: spawn node ${code}`);
  });

  it("still runs real commands afterwards", async () => {
    const r = await runProcess({ env: controllerGitEnv(), command: process.execPath, args: ["-e", "console.log('ok')"], cwd: tmpdir(), timeoutMs: 10_000 });
    expect(r).toMatchObject({ exitCode: 0, stdout: "ok\n" });
  });
});
