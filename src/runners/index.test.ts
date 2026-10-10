import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../config.js";
import type { AgentJob, Config, Logger } from "../types.js";
import { ClaudeRunner } from "./claude.js";
import { CodexRunner } from "./codex.js";
import { createRunners } from "./index.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mc-runners-index-"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function writeJob(overrides: Partial<AgentJob> = {}): AgentJob {
  return {
    id: "build-1",
    role: "engineer",
    provider: "claude",
    model: "claude-sonnet-5-5",
    effort: "medium",
    cwd: dir,
    systemPrompt: "system",
    prompt: "prompt",
    access: "workspace-write",
    limits: { maxTurns: 5, timeoutMs: 10_000 },
    ...overrides,
  };
}

function config(permissions: Partial<Config["permissions"]> = {}, cli: Partial<Config["cli"]> = {}): Config {
  const c = defaultConfig();
  return { ...c, permissions: { ...c.permissions, ...permissions }, cli: { ...c.cli, ...cli } };
}

function recordingLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() } satisfies Logger;
}

/** The value following `flag` in args. */
function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function claudeMode(runner: ClaudeRunner, job: AgentJob = writeJob()): string | undefined {
  return flagValue(runner.buildArgs(job, join(dir, "system.md")), "--permission-mode");
}

function codexArgs(runner: CodexRunner, job: AgentJob = writeJob({ provider: "codex" })): string[] {
  return runner.buildArgs(job, { lastMessageFile: join(dir, "last.txt") });
}

const runningAsRoot = process.getuid?.() === 0;

describe("createRunners", () => {
  it("returns a ClaudeRunner and a CodexRunner", () => {
    const runners = createRunners(config(), { containerized: true });
    expect(runners.claude).toBeInstanceOf(ClaudeRunner);
    expect(runners.claude.provider).toBe("claude");
    expect(runners.codex).toBeInstanceOf(CodexRunner);
    expect(runners.codex.provider).toBe("codex");
  });

  it("keeps the configured full-autonomy modes inside a container", () => {
    const logger = recordingLogger();
    const runners = createRunners(config(), { containerized: true, logger });
    expect(flagValue(codexArgs(runners.codex), "-s")).toBe("danger-full-access");
    // Claude Code refuses bypassPermissions as root, so effectivePermissions always downgrades it there.
    expect(claudeMode(runners.claude)).toBe(runningAsRoot ? "auto" : "bypassPermissions");
    expect(logger.warn).toHaveBeenCalledTimes(runningAsRoot ? 1 : 0);
  });

  it("downgrades both write modes outside a container and warns once with the reason", () => {
    const logger = recordingLogger();
    const runners = createRunners(config(), { containerized: false, logger });
    const args = codexArgs(runners.codex);
    expect(flagValue(args, "-s")).toBe("workspace-write");
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    expect(claudeMode(runners.claude)).toBe("auto");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, data] = logger.warn.mock.calls[0] ?? [];
    expect(message).toMatch(/^Agent permissions downgraded: /);
    expect(message).toContain("not running inside its container");
    expect(data).toEqual({ claudeWriteMode: "auto", codexWriteSandbox: "workspace-write" });
  });

  it("uses the configured modes outside a container when no container is required", () => {
    const logger = recordingLogger();
    const runners = createRunners(config({ requireContainerForBypass: false }), { containerized: false, logger });
    expect(flagValue(codexArgs(runners.codex), "-s")).toBe("danger-full-access");
    expect(claudeMode(runners.claude)).toBe(runningAsRoot ? "auto" : "bypassPermissions");
  });

  it("passes safer configured modes through unchanged, without a warning", () => {
    const logger = recordingLogger();
    const c = config({ claudeWriteMode: "acceptEdits", codexWriteSandbox: "workspace-write" });
    const runners = createRunners(c, { containerized: false, logger });
    expect(claudeMode(runners.claude)).toBe("acceptEdits");
    expect(flagValue(codexArgs(runners.codex), "-s")).toBe("workspace-write");
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("keeps read-only jobs read-only whatever the write modes", () => {
    const runners = createRunners(config(), { containerized: true });
    const readOnly = writeJob({ access: "read-only" });
    expect(claudeMode(runners.claude, readOnly)).toBe("dontAsk");
    expect(flagValue(codexArgs(runners.codex, { ...readOnly, provider: "codex" }), "-s")).toBe("read-only");
  });

  it("detects the container when containerized is not given", () => {
    vi.stubEnv("MC_IN_CONTAINER", "1");
    const runners = createRunners(config());
    expect(flagValue(codexArgs(runners.codex), "-s")).toBe("danger-full-access");
  });

  it.skipIf(existsSync("/.dockerenv"))("assumes no container when none is detected", () => {
    vi.stubEnv("MC_IN_CONTAINER", "");
    const logger = recordingLogger();
    const runners = createRunners(config(), { logger });
    const args = codexArgs(runners.codex);
    expect(flagValue(args, "-s")).toBe("workspace-write");
    expect(args).toContain("sandbox_workspace_write.network_access=true");
    expect(claudeMode(runners.claude)).toBe("auto");
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toContain("not running inside its container");
  });

  it("runs the configured CLI commands and logs through the given logger", async () => {
    const logger = recordingLogger();
    const claudeCommand = join(dir, "missing-claude");
    const codexCommand = join(dir, "missing-codex");
    const runners = createRunners(config({}, { claudeCommand, codexCommand }), { containerized: true, logger });

    const claude = await runners.claude.run(writeJob());
    expect(claude.outcome).toBe("crashed");
    expect(claude.error).toContain(`${claudeCommand} not found`);

    const codex = await runners.codex.run(writeJob({ provider: "codex", model: "gpt-6.1-sol" }));
    expect(codex.outcome).toBe("crashed");
    expect(codex.error).toContain(`${codexCommand} not found`);

    const logged = logger.info.mock.calls.map(([msg]) => String(msg));
    expect(logged.some((msg) => msg.startsWith("claude run build-1"))).toBe(true);
    expect(logged.some((msg) => msg.startsWith("codex run"))).toBe(true);
  });
});
