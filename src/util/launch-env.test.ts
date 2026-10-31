import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupLaunchDir, controllerGitEnv, localLaunchEnv, nativeToolPath, providerLaunchEnv } from "./launch-env.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

const dirs: string[] = [];
const owned = () => { const dir = mkdtempSync(join(tmpdir(), "mc-launch-env-test-")); dirs.push(dir); return dir; };
afterEach(() => { vi.unstubAllEnvs(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("controller launch environment adapters", () => {
  it("constructs native tool search paths without reading parent PATH", () => {
    vi.stubEnv("PATH", "/mnt/c/synthetic/Windows");
    const path = nativeToolPath("/home/fixture", "/opt/node/bin/node");
    expect(path).toEqual(["/opt/node/bin", "/home/fixture/.local/bin", "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin"]);
    expect(nativeToolPath("/home/fixture", "/usr/bin/node").filter((p) => p === "/usr/bin")).toHaveLength(1);
  });
  it.each(["claude", "codex"] as const)("uses a private home/tmp and only selected %s config", (provider) => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/claude-selected");
    vi.stubEnv("CODEX_HOME", "/tmp/codex-selected");
    vi.stubEnv("OPENAI_API_KEY", "synthetic-key");
    vi.stubEnv("NODE_OPTIONS", "--require=/tmp/synthetic-missing");
    const ownedDir = owned();
    const env = providerLaunchEnv({ purpose: "worker", provider, ownedDir, path: [dirname(process.execPath), "/usr/bin", "/bin"] });
    expect(env.HOME).toBe(join(ownedDir, "home"));
    expect(env.TMPDIR).toBe(join(ownedDir, "tmp"));
    expect(existsSync(env.HOME!)).toBe(true);
    expect(existsSync(env.TMPDIR!)).toBe(true);
    expect(env[provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]).toBe("/tmp/" + provider + "-selected");
    expect(env).not.toHaveProperty(provider === "claude" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty("OPENAI_API_KEY");
    expect(env).not.toHaveProperty("NODE_OPTIONS");
  });
  it("explicit selected config overrides the controller setting", () => {
    vi.stubEnv("CODEX_HOME", "/tmp/controller-config");
    expect(providerLaunchEnv({ purpose: "provider-metadata", provider: "codex", ownedDir: owned(), configHome: "/tmp/explicit-config" }).CODEX_HOME).toBe("/tmp/explicit-config");
  });
  it.each(["verification", "rendering", "diagnostic"] as const)("%s excludes provider config and arbitrary settings", (purpose) => {
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/claude");
    vi.stubEnv("CODEX_HOME", "/tmp/codex");
    vi.stubEnv("BASH_ENV", "/tmp/synthetic-injection");
    const env = localLaunchEnv({ purpose, ownedDir: owned() });
    expect(env).not.toHaveProperty("CLAUDE_CONFIG_DIR");
    expect(env).not.toHaveProperty("CODEX_HOME");
    expect(env).not.toHaveProperty("BASH_ENV");
    expect(env.CI).toBe(purpose === "verification" ? "1" : undefined);
  });
  it("fails before creating home/tmp for an invalid native search path", () => {
    const ownedDir = owned();
    expect(() => localLaunchEnv({ purpose: "rendering", ownedDir, path: ["/mnt/c/Windows"] })).toThrow("path[0]");
    expect(existsSync(join(ownedDir, "home"))).toBe(false);
    expect(existsSync(join(ownedDir, "tmp"))).toBe(false);
  });
  it("does not reuse an existing or linked child home", () => {
    const ownedDir = owned();
    writeFileSync(join(ownedDir, "home"), "synthetic-existing-file");
    expect(() => localLaunchEnv({ purpose: "rendering", ownedDir })).toThrow();
    expect(readFileSync(join(ownedDir, "home"), "utf8")).toBe("synthetic-existing-file");
  });
  it("rejects traversal in the owned directory before normalizing child paths", () => {
    const root = owned();
    expect(() => localLaunchEnv({ purpose: "verification", ownedDir: root + "/../" + basename(root) })).toThrow();
    expect(existsSync(join(root, "home"))).toBe(false);
  });
  it("does not replace an outcome when owned temporary cleanup fails", () => {
    const root = owned();
    vi.mocked(rmSync).mockImplementationOnce(() => { throw new Error("synthetic cleanup failure"); });
    expect(() => cleanupLaunchDir(root)).not.toThrow();
    expect(existsSync(root)).toBe(true);
  });
  it("constructs controller Git controls without inherited Git config", () => {
    vi.stubEnv("GIT_CONFIG_GLOBAL", "/tmp/untrusted-config");
    vi.stubEnv("GIT_SSH_COMMAND", "synthetic-command");
    const env = controllerGitEnv({ globalConfig: "/tmp/explicit-config", home: "/tmp/controller-home", tmpDir: "/tmp" });
    expect(env).toMatchObject({ HOME: "/tmp/controller-home", GIT_CONFIG_GLOBAL: "/tmp/explicit-config", GIT_CONFIG_NOSYSTEM: "1" });
    expect(env).not.toHaveProperty("GIT_SSH_COMMAND");
  });
});
