import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { readCodexAccount } from "./codex-app-server.js";
import { killTree } from "../util/process.js";

const roots: string[] = [];
const pids: number[] = [];
afterEach(() => {
  for (const pid of pids.splice(0)) killTree(pid, "SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "mc-metadata-test-"));
  roots.push(root);
  const command = join(root, "codex");
  copyFileSync(fileURLToPath(new URL("./fixtures/fake-codex.mjs", import.meta.url)), command);
  chmodSync(command, 0o755);
  const configHome = join(root, "config");
  const ownedDir = join(root, "session");
  mkdirSync(configHome);
  mkdirSync(ownedDir);
  const record = join(root, "env.ndjson");
  writeFileSync(join(configHome, "mc-fixture.json"), JSON.stringify({ FAKE_CODEX_APP_SERVER: mode, FAKE_CODEX_ENV_RECORD: record }));
  return { command, cwd: ownedDir, launch: { ownedDir, configHome, path: [dirname(process.execPath), "/usr/bin", "/bin"] }, timeoutMs: 1000, account: true, record };
}
function recorded(path: string) {
  const entry = JSON.parse(readFileSync(path, "utf8").trim().split("\n")[0]!);
  pids.push(entry.pid);
  return entry;
}
describe("Codex metadata controlled-home lifecycle", () => {
  it("kills an EOF-ignoring app server before resolving to its cleanup owner", async () => {
    const query = fixture("ignore-eof");
    const start = Date.now();
    expect(await readCodexAccount(query)).toMatchObject({ accountType: "chatgpt", complete: false });
    expect(Date.now() - start).toBeGreaterThanOrEqual(900);
    expect(Date.now() - start).toBeLessThan(1600);
    const entry = recorded(query.record);
    expect(() => process.kill(entry.pid, 0)).toThrow();
    expect(existsSync(entry.env.HOME)).toBe(true);
    expect(existsSync(entry.env.TMPDIR)).toBe(true);
  });
  it("waits for a timed-out fake server to die before resolving", async () => {
    const query = fixture("hang");
    expect(await readCodexAccount({ ...query, timeoutMs: 150 })).toBeUndefined();
    const entry = recorded(query.record);
    expect(() => process.kill(entry.pid, 0)).toThrow();
    expect(existsSync(entry.env.HOME)).toBe(true);
  });
  it("rejects invalid metadata launch settings distinctly without exposing supplied values", async () => {
    const query = fixture("answer");
    await expect(readCodexAccount({ ...query, launch: { ...query.launch, configHome: "/mnt/c/synthetic-private-value" } }))
      .rejects.toThrow("configHome");
    expect(existsSync(query.record)).toBe(false);
    expect(existsSync(join(query.launch.ownedDir, "home"))).toBe(false);
  });
});

describe("Codex metadata transport admission bounds", () => {
  it("does not start even a fake child when already aborted", async () => {
    const query = fixture("answer");
    const controller = new AbortController();
    controller.abort();
    expect(await readCodexAccount({ ...query, signal: controller.signal })).toBeUndefined();
    expect(existsSync(query.record)).toBe(false);
    expect(existsSync(join(query.launch.ownedDir, "home"))).toBe(false);
  });
  it("kills an active query promptly when the admission signal aborts", async () => {
    const query = fixture("hang");
    const controller = new AbortController();
    const begun = Date.now();
    const pending = readCodexAccount({ ...query, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await pending;
    expect(Date.now() - begun).toBeLessThan(700);
    const entry = recorded(query.record);
    expect(() => process.kill(entry.pid, 0)).toThrow();
  });
  it.each([0, -1, Number.NaN, Infinity])("does not allocate environment or spawn for invalid timeout %s", async (timeoutMs) => {
    const query = fixture("answer");
    expect(await readCodexAccount({ ...query, timeoutMs })).toBeUndefined();
    expect(existsSync(query.record)).toBe(false);
    expect(existsSync(join(query.launch.ownedDir, "home"))).toBe(false);
  });
});
