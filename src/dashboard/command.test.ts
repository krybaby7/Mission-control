// Tests for `mc dashboard` (docs/dashboard-spec.md, 2.5 and 15: T-CLI, T-EDGE-35, T-EDGE-40). The page file belongs to
// another part of the build, so the tests give the command a page of their own.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main } from "../cli.js";
import { builtInSettings, type DashboardSettings } from "./snapshot.js";
import { assertSnapshotShape, copyHome, emptyHome, hashTree, missingHome, withLock } from "../../test/dashboard-helpers.js";
import { parsePort, runDashboard } from "./command.js";
import type { Snapshot } from "./types.js";

const pageState = vi.hoisted(() => ({ load: (): string => "" }));
vi.mock("./page.js", () => ({ loadPage: () => pageState.load(), PAGE_FILE: "dashboard/index.html" }));

const PAGE = "<!doctype html><html><head><title>Mission Control</title></head><body><p>Now</p></body></html>";

let root: string;
let out: string;
let err: string;
const open: net.Server[] = [];

beforeEach(() => {
  pageState.load = () => PAGE;
  root = mkdtempSync(join(tmpdir(), "mc-dash-cmd-"));
  out = "";
  err = "";
  vi.stubEnv("MC_CONFIG", "");
  vi.stubEnv("MC_IN_CONTAINER", "");
  // Defaults such as ~/.claude must never reach the real home folder.
  vi.stubEnv("HOME", join(root, "user-home"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(root, "claude-config"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(open.splice(0).map((server) => new Promise((done) => server.close(done))));
  rmSync(root, { recursive: true, force: true });
});

/** A port nothing listens on right now. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((done) => server.close(done));
  return port;
}

/** Takes a port, so that starting on it fails. */
async function takenPort(): Promise<number> {
  const server = net.createServer();
  open.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as net.AddressInfo).port;
}

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function until(what: string, ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready(); waited += 10) {
    if (waited > 5_000) throw new Error(`timed out waiting for ${what}`);
    await sleep(10);
  }
}

async function getJson(port: number, path: string): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`);
  return { status: res.status, json: await res.json() };
}

interface Started {
  port: number;
  lines: string[];
  stop(): Promise<void>;
  done: Promise<void>;
}

/** Starts the dashboard on a free port and waits until it says it is ready. */
async function start(home: string, extra: Partial<Parameters<typeof runDashboard>[0]> = {}): Promise<Started> {
  const port = await freePort();
  const stop = new AbortController();
  const lines: string[] = [];
  const done = runDashboard({
    home,
    settings: builtInSettings(),
    host: "127.0.0.1",
    port,
    say: (line) => lines.push(line),
    signal: stop.signal,
    ...extra,
  });
  await Promise.race([until("the dashboard to start", () => lines.length >= 2), done]);
  return { port, lines, done, stop: async () => (stop.abort(), done) };
}

describe("T-CLI: runDashboard", () => {
  it("serves the page and the snapshot of the home, says where, and stops when told to", async () => {
    const home = copyHome("done");
    const s = await start(home);
    expect(s.lines).toEqual([`Dashboard ready: http://localhost:${s.port}`, "It only reads Mission Control's files. Press Ctrl+C to stop it."]);
    expect(await (await fetch(`http://127.0.0.1:${s.port}/`)).text()).toBe(PAGE);
    const snapshot = await getJson(s.port, "/api/snapshot");
    expect(snapshot.status).toBe(200);
    assertSnapshotShape(snapshot.json);
    expect((snapshot.json as Snapshot).missions.map((m) => m.title)).toContain("Habit tracker");
    await s.stop();
    await expect(fetch(`http://127.0.0.1:${s.port}/healthz`)).rejects.toThrow();
  });

  it("resolves at once when the signal is already aborted, after freeing the port", async () => {
    const port = await freePort();
    const stop = new AbortController();
    stop.abort();
    await runDashboard({ home: emptyHome(), settings: builtInSettings(), host: "127.0.0.1", port, say: () => {}, signal: stop.signal });
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("leaves the Mission Control folder byte-identical", async () => {
    const home = copyHome("multi-mission");
    withLock(home, { at: new Date(Date.now() - 3_600_000).toISOString(), ageMs: 10_000, now: Date.now() });
    const before = hashTree(home);
    const s = await start(home, { until: "07:00" });
    for (const path of ["/", "/api/snapshot", "/healthz", "/api/snapshot", "/nope"]) await fetch(`http://127.0.0.1:${s.port}${path}`);
    await fetch(`http://127.0.0.1:${s.port}/api/snapshot`, { method: "POST", body: "{}" });
    await s.stop();
    expect(hashTree(home)).toBe(before);
  });

  it("counts down to --until only while a run is live, with the engine's own time parsing", async () => {
    const home = emptyHome();
    const none = await start(home, { until: "07:00" });
    expect(((await getJson(none.port, "/api/snapshot")).json as Snapshot).run.deadline).toBeNull();
    await none.stop();

    withLock(home, { at: new Date(Date.now() - 600_000).toISOString(), ageMs: 5_000, now: Date.now() });
    const given = await start(home, { until: "07:00" });
    const run = ((await getJson(given.port, "/api/snapshot")).json as Snapshot).run;
    expect(run.active).toBe(true);
    expect(run.deadline?.atText).toBe("07:00");
    await given.stop();

    const notGiven = await start(home);
    expect(((await getJson(notGiven.port, "/api/snapshot")).json as Snapshot).run.deadline).toBeNull();
    await notGiven.stop();
  });

  it("answers /healthz with where the settings came from and whether the home can be read (E1, E3, E40)", async () => {
    const saved: DashboardSettings = { ...builtInSettings(), source: "saved" };
    const file = join(root, "a-file");
    writeFileSync(file, "not a folder");
    for (const [home, settings, expected] of [
      [copyHome("done"), builtInSettings(), { settings: "built_in", home: "readable" }],
      [emptyHome(), saved, { settings: "saved", home: "readable" }],
      [missingHome(), saved, { settings: "saved", home: "missing" }],
      [file, builtInSettings(), { settings: "built_in", home: "unreadable" }],
    ] as const) {
      const s = await start(home, { settings });
      expect((await getJson(s.port, "/healthz")).json).toEqual({ ok: true, schemaVersion: 1, ...expected });
      // A home that is missing or cannot be read still gets a snapshot, never an error.
      const snapshot = await getJson(s.port, "/api/snapshot");
      expect(snapshot.status).toBe(200);
      assertSnapshotShape(snapshot.json);
      await s.stop();
    }
  });

  it.each([0, 65_536, -1, 80.5, Number.NaN])("refuses the port %s with a plain sentence", async (port) => {
    await expect(runDashboard({ home: emptyHome(), settings: builtInSettings(), host: "127.0.0.1", port, say: () => {} })).rejects.toThrow("is not a port number");
  });

  it("refuses a bad --until with the engine's own message, before anything listens", async () => {
    const say = vi.fn();
    await expect(runDashboard({ home: emptyHome(), settings: builtInSettings(), host: "127.0.0.1", port: await freePort(), until: "25:99", say })).rejects.toThrow(
      '"25:99" is not a time of day. Write it as HH:MM',
    );
    expect(say).not.toHaveBeenCalled();
  });

  it("refuses a missing page before it listens", async () => {
    pageState.load = () => {
      throw new Error("The dashboard page file is missing (dashboard/index.html). Rebuild the image: mc build.");
    };
    const port = await freePort();
    await expect(runDashboard({ home: emptyHome(), settings: builtInSettings(), host: "127.0.0.1", port, say: () => {} })).rejects.toThrow("page file is missing");
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("says when the port is in use, and which flag to use", async () => {
    const port = await takenPort();
    await expect(runDashboard({ home: emptyHome(), settings: builtInSettings(), host: "127.0.0.1", port, say: () => {} })).rejects.toThrow(
      `Port ${port} is already in use. Choose another with --port.`,
    );
  });

  it("explains an address it cannot listen on", async () => {
    await expect(runDashboard({ home: emptyHome(), settings: builtInSettings(), host: "203.0.113.1", port: await freePort(), say: () => {} })).rejects.toThrow(
      /^The dashboard could not start on 203\.0\.113\.1 port \d+: /,
    );
  });
});

describe("T-CLI: parsePort", () => {
  it.each([["1", 1], ["8787", 8787], [" 80 ", 80], ["65535", 65535]])("accepts %j", (text, port) => {
    expect(parsePort(text)).toBe(port);
  });

  it.each(["", "abc", "0", "65536", "80.5", "-1", "1e3", "0x50", "99999", "123456"])("refuses %j", (text) => {
    expect(() => parsePort(text)).toThrow(`"${text}" is not a port number. Use a whole number from 1 to 65535`);
  });
});

describe("T-CLI: mc dashboard", () => {
  async function mc(...args: string[]): Promise<number> {
    out = "";
    err = "";
    return main(["node", "mc", ...args], { stdout: (t) => (out += t), stderr: (t) => (err += t) });
  }

  /** Records the handlers the command puts on SIGINT and SIGTERM instead of installing them, so a test can "press Ctrl+C". */
  function captureSignals(): Record<string, () => void> {
    const handlers: Record<string, () => void> = {};
    const once = process.once.bind(process) as (event: string, fn: (...args: never[]) => void) => NodeJS.Process;
    vi.spyOn(process, "once").mockImplementation(((event: string, fn: () => void) => {
      if (event === "SIGINT" || event === "SIGTERM") {
        handlers[event] = fn;
        return process;
      }
      return once(event, fn);
    }) as never);
    return handlers;
  }

  it("is described in mc --help and has its own help", async () => {
    expect(await mc("--help")).toBe(0);
    expect(out).toMatch(/^\s+dashboard \[options\]\s+show the team's progress on a web page \(read-only\)$/m);
    expect(await mc("dashboard", "--help")).toBe(0);
    expect(out).toContain("show the team's progress on a web page (read-only)");
    for (const option of ["--host <address>", "--port <number>", "--until <HH:MM>"]) expect(out).toContain(option);
    const flat = out.replace(/\s+/g, " ");
    expect(flat).toContain("a stop time to show");
    expect(flat).toContain("give the same time you gave mc run");
    expect(flat).toContain("default: 8787");
  });

  it.each(["abc", "0", "65536", "80.5"])("says what is wrong with the port %j and exits 1", async (port) => {
    expect(await mc("dashboard", "--port", port)).toBe(1);
    expect(err).toContain(`"${port}" is not a port number. Use a whole number from 1 to 65535`);
    expect(out).toBe("");
  });

  it("gives the engine's message for a bad --until and exits 1", async () => {
    vi.stubEnv("MC_HOME", emptyHome());
    expect(await mc("dashboard", "--host", "127.0.0.1", "--port", String(await freePort()), "--until", "7pm")).toBe(1);
    expect(err).toContain('"7pm" is not a time of day');
    expect(out).toBe("");
  });

  it("says when the page file is missing and exits 1", async () => {
    vi.stubEnv("MC_HOME", emptyHome());
    pageState.load = () => {
      throw new Error("The dashboard page file is missing (dashboard/index.html). Rebuild the image: mc build.");
    };
    expect(await mc("dashboard", "--host", "127.0.0.1", "--port", String(await freePort()))).toBe(1);
    expect(err).toContain("The dashboard page file is missing");
    expect(out).toBe("");
  });

  it("says when the port is in use and exits 1", async () => {
    vi.stubEnv("MC_HOME", emptyHome());
    const port = await takenPort();
    expect(await mc("dashboard", "--host", "127.0.0.1", "--port", String(port))).toBe(1);
    expect(err).toContain(`Port ${port} is already in use. Choose another with --port.`);
    expect(out).toBe("");
  });

  it("serves the folder $MC_HOME names, prints two lines, stops on Ctrl+C with exit 0, and changes nothing", async () => {
    const home = copyHome("done");
    vi.stubEnv("MC_HOME", home);
    const before = hashTree(home);
    const handlers = captureSignals();
    const port = await freePort();
    const running = mc("dashboard", "--host", "127.0.0.1", "--port", String(port));
    await until("the dashboard to start", () => out.includes("Press Ctrl+C"));
    expect(out).toBe(`Dashboard ready: http://localhost:${port}\nIt only reads Mission Control's files. Press Ctrl+C to stop it.\n`);
    expect(err).toBe("");
    const snapshot = (await getJson(port, "/api/snapshot")).json as Snapshot;
    assertSnapshotShape(snapshot);
    expect(snapshot.missions.map((m) => m.title)).toContain("Habit tracker");
    // No settings file here: the defaults load fine, so /healthz says the settings are the saved ones.
    expect((await getJson(port, "/healthz")).json).toMatchObject({ settings: "saved", home: "readable" });
    handlers.SIGINT?.();
    expect(await running).toBe(0);
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    expect(hashTree(home)).toBe(before);
  });

  it("still starts when the settings file has a problem: it warns, uses the built-in settings, and /healthz says so (E40)", async () => {
    const home = copyHome("done");
    vi.stubEnv("MC_HOME", home);
    const settingsFile = join(root, "config.yaml");
    writeFileSync(settingsFile, "pacing: [this is not valid\n");
    vi.stubEnv("MC_CONFIG", settingsFile);
    const handlers = captureSignals();
    const port = await freePort();
    const running = mc("dashboard", "--host", "127.0.0.1", "--port", String(port));
    await until("the dashboard to start", () => out.includes("Press Ctrl+C"));
    expect((await getJson(port, "/healthz")).json).toMatchObject({ settings: "built_in", home: "readable" });
    expect(err).toContain("Warning:");
    expect(((await getJson(port, "/api/snapshot")).json as Snapshot).missions.length).toBeGreaterThan(0);
    handlers.SIGINT?.();
    expect(await running).toBe(0);
  });

  it("stops on SIGTERM too (docker stop), and takes the stop time from --until", async () => {
    const home = emptyHome();
    vi.stubEnv("MC_HOME", home);
    withLock(home, { at: new Date(Date.now() - 600_000).toISOString(), ageMs: 5_000, now: Date.now() });
    const handlers = captureSignals();
    const port = await freePort();
    const running = mc("dashboard", "--host", "127.0.0.1", "--port", String(port), "--until", "06:45");
    await until("the dashboard to start", () => out.includes("Press Ctrl+C"));
    expect(((await getJson(port, "/api/snapshot")).json as Snapshot).run.deadline?.atText).toBe("06:45");
    handlers.SIGTERM?.();
    expect(await running).toBe(0);
  });

  // Linux answers on all of 127.0.0.0/8, so 127.0.0.2 tells a server bound to 127.0.0.1 from one bound to every address.
  it.skipIf(process.platform !== "linux")("listens on this computer only by default, and on every address inside the container", async () => {
    vi.stubEnv("MC_HOME", emptyHome());
    const handlers = captureSignals();
    const reachableOnOtherAddress: boolean[] = [];
    for (const inside of ["", "1"]) {
      vi.stubEnv("MC_IN_CONTAINER", inside);
      const port = await freePort();
      const running = mc("dashboard", "--port", String(port));
      await until("the dashboard to start", () => out.includes("Press Ctrl+C"));
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
      reachableOnOtherAddress.push(await fetch(`http://127.0.0.2:${port}/healthz`).then((r) => r.status === 200, () => false));
      handlers.SIGINT?.();
      expect(await running).toBe(0);
    }
    expect(reachableOnOtherAddress).toEqual([false, true]);
  });
});
