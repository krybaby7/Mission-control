import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "./config.js";
import { type DoctorCheck, isSupportedNode, runDoctor } from "./doctor.js";
import { type MockBehavior, MockRunner } from "./runners/mock.js";
import type { AgentJob, Config } from "./types.js";

const BILLING_VARS = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
];
const IS_ROOT = process.getuid?.() === 0;
/** A second filesystem for the disk check, when this machine has one. */
const OTHER_DISK = "/dev/shm";
const HAS_OTHER_DISK = existsSync(OTHER_DISK) && statSync(OTHER_DISK).dev !== statSync(tmpdir()).dev;

/** argv joined by spaces → what the fake CLI prints and its exit code. */
type FakeTable = Record<string, { out?: string; code?: number }>;

const CLAUDE_OK: FakeTable = {
  "--version": { out: "2.1.295 (Claude Code)\n" },
  "auth status": { out: "Logged in\n" },
};
const CODEX_OK: FakeTable = {
  "--version": { out: "codex-cli 0.162.0\n" },
  "login status": { out: "Logged in using ChatGPT\n" },
  "debug models": { out: "gpt-6-astra (frontier)\ngpt-6.1-sol\n" },
};

let root: string;
let bin: string;
let claudeDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mc-doctor-"));
  bin = join(root, "bin");
  claudeDir = join(root, "claude-config");
  mkdirSync(bin);
  mkdirSync(claudeDir);
  vi.stubEnv("MC_HOME", join(root, "home"));
  vi.stubEnv("MC_CONFIG", "");
  vi.stubEnv("CLAUDE_CONFIG_DIR", claudeDir);
  vi.stubEnv("MC_IN_CONTAINER", "1");
  // Defaults such as ~/mc-apps must never reach the real home folder (the doctor writes a probe file there).
  vi.stubEnv("HOME", join(root, "user-home"));
  for (const name of BILLING_VARS) vi.stubEnv(name, "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function writeFakeCli(name: string, table: FakeTable): string {
  const file = join(bin, name);
  const script = `#!/usr/bin/env node
const table = ${JSON.stringify(table)};
const hit = table[process.argv.slice(2).join(" ")];
if (!hit) { process.stderr.write("fake ${name}: unknown arguments\\n"); process.exit(2); }
process.stdout.write(hit.out ?? "");
process.exit(hit.code ?? 0);
`;
  writeFileSync(file, script);
  chmodSync(file, 0o755);
  return file;
}

/** The folders the container keeps (mc-docker.sh mounts them): ~/.mission-control and ~/mc-apps in the test's home. */
const keptHome = () => join(root, "user-home", ".mission-control");
const keptApps = () => join(root, "user-home", "mc-apps");

function makeConfig(opts: { claude?: FakeTable; codex?: FakeTable } = {}): Config {
  const c = defaultConfig();
  c.home = keptHome();
  c.workspaceRoot = keptApps();
  c.notify.ntfyUrl = "https://ntfy.sh/secret-topic-123";
  c.cli.claudeCommand = writeFakeCli("claude", opts.claude ?? CLAUDE_OK);
  c.cli.codexCommand = writeFakeCli("codex", opts.codex ?? CODEX_OK);
  return c;
}

function check(checks: DoctorCheck[], name: string): DoctorCheck {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named "${name}" in: ${checks.map((c) => c.name).join(", ")}`);
  return found;
}

function names(checks: DoctorCheck[]): string[] {
  return checks.map((c) => c.name);
}

describe("isSupportedNode", () => {
  it.each([
    ["22.12.0", true],
    ["v22.12.1", true],
    ["22.22.0", true],
    ["23.0.0", true],
    ["22.11.9", false],
    ["20.18.0", false],
  ])("%s → %s", (version, expected) => {
    expect(isSupportedNode(version)).toBe(expected);
  });
});

describe("runDoctor: tools and settings", () => {
  it("runs every check in display order, and only adds live checks when asked", async () => {
    const checks = await runDoctor({ config: makeConfig() });
    expect(names(checks)).toEqual([
      "Node.js",
      "Git",
      "Git identity",
      "Settings",
      "Claude Code",
      "Claude login",
      "Codex",
      "Codex login",
      "Codex models",
      "API keys",
      "Container",
      "Mission Control folder",
      "Apps folder",
      "Disk space",
      "Notifications",
    ]);
    for (const c of checks) expect(c.severity === "error" || c.severity === "warn").toBe(true);
  });

  it("passes the checks a healthy setup controls", async () => {
    const checks = await runDoctor({ config: makeConfig() });
    for (const name of ["Node.js", "Git", "Settings", "Claude Code", "Codex", "Codex login", "Codex models", "API keys", "Notifications"]) {
      expect(check(checks, name), name).toMatchObject({ ok: true });
    }
    expect(check(checks, "Claude Code").detail).toBe("version 2.1.295");
    expect(check(checks, "Codex").detail).toBe("version 0.162.0");
    expect(check(checks, "Codex models").detail).toContain("gpt-6-astra and gpt-6.1-sol");
    expect(check(checks, "Git identity").severity).toBe("warn");
  });

  it("warns, with the install command, when a CLI version differs from the pinned one", async () => {
    const config = makeConfig({ claude: { ...CLAUDE_OK, "--version": { out: "2.1.300 (Claude Code)\n" } } });
    vi.stubEnv("MC_IN_CONTAINER", "");
    const claude = check(await runDoctor({ config }), "Claude Code");
    expect(claude).toMatchObject({ ok: false, severity: "warn" });
    expect(claude.detail).toContain("2.1.300");
    expect(claude.detail).toContain("2.1.295");
    if (!existsSync("/.dockerenv")) expect(claude.fix).toContain("npm install -g @anthropic-ai/claude-code@2.1.295");
  });

  it("suggests rebuilding the image inside the container", async () => {
    const config = makeConfig({ codex: { ...CODEX_OK, "--version": { out: "codex-cli 0.170.0\n" } } });
    const codex = check(await runDoctor({ config }), "Codex");
    expect(codex).toMatchObject({ ok: false, severity: "warn" });
    expect(codex.fix).toContain("mc build");
  });

  it("reports a missing CLI as an error, and its login and models as not checkable", async () => {
    const config = makeConfig();
    config.cli.codexCommand = join(bin, "no-such-codex");
    const checks = await runDoctor({ config });
    expect(check(checks, "Codex")).toMatchObject({ ok: false, severity: "error" });
    expect(check(checks, "Codex").detail).toContain("isn't installed");
    expect(check(checks, "Codex login")).toMatchObject({ ok: false, severity: "error" });
    expect(check(checks, "Codex login").detail).toContain("isn't installed");
    expect(check(checks, "Codex models")).toMatchObject({ ok: false, severity: "warn" });
  });

  it("reports a failing --version as an error", async () => {
    const config = makeConfig({ claude: { "--version": { out: "boom\n", code: 3 } } });
    const claude = check(await runDoctor({ config }), "Claude Code");
    expect(claude).toMatchObject({ ok: false, severity: "error" });
    expect(claude.detail).toContain("boom");
  });

  it("treats a stored Claude credentials file as logged in, even when auth status fails", async () => {
    writeFileSync(join(claudeDir, ".credentials.json"), '{"token":"x"}');
    const config = makeConfig({ claude: { ...CLAUDE_OK, "auth status": { code: 1 } } });
    expect(check(await runDoctor({ config }), "Claude login")).toMatchObject({ ok: true });
  });

  it("falls back to `claude auth status`, and explains how to log in when it fails", async () => {
    expect(check(await runDoctor({ config: makeConfig() }), "Claude login")).toMatchObject({ ok: true });

    const config = makeConfig({ claude: { ...CLAUDE_OK, "auth status": { out: "Not logged in\n", code: 1 } } });
    const login = check(await runDoctor({ config }), "Claude login");
    expect(login).toMatchObject({ ok: false, severity: "error" });
    expect(login.fix).toContain("mc login-claude");
  });

  it("errors on a Codex API-key login (the runner refuses it) without echoing the key", async () => {
    const config = makeConfig({ codex: { ...CODEX_OK, "login status": { out: "Logged in using an API key - sk-proj-SECRET\n" } } });
    const login = check(await runDoctor({ config }), "Codex login");
    expect(login).toMatchObject({ ok: false, severity: "error" });
    expect(JSON.stringify(login)).not.toContain("SECRET");
  });

  it("reports a Codex that is not logged in", async () => {
    const config = makeConfig({ codex: { ...CODEX_OK, "login status": { out: "Not logged in\n", code: 1 } } });
    const login = check(await runDoctor({ config }), "Codex login");
    expect(login).toMatchObject({ ok: false, severity: "error" });
    expect(login.fix).toContain("mc login-codex");
  });

  it("flags configured Codex models that `codex debug models` doesn't list, matching whole names only", async () => {
    const config = makeConfig({ codex: { ...CODEX_OK, "debug models": { out: "gpt-6-astra-mini\ngpt-6.1-sol\n" } } });
    const models = check(await runDoctor({ config }), "Codex models");
    expect(models).toMatchObject({ ok: false, severity: "error" });
    expect(models.detail).toContain("gpt-6-astra");
    expect(models.detail).not.toContain("gpt-6.1-sol");
  });

  it("warns when the model list can't be read, and skips it for a non-Codex provider", async () => {
    const failing = makeConfig({ codex: { ...CODEX_OK, "debug models": { out: "network down\n", code: 1 } } });
    expect(check(await runDoctor({ config: failing }), "Codex models")).toMatchObject({ ok: false, severity: "warn" });

    const mock = makeConfig();
    mock.families.codex.provider = "mock";
    expect(names(await runDoctor({ config: mock }))).not.toContain("Codex models");
  });

  it("errors on API-key variables, naming them but never showing their values", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-very-secret");
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-secret");
    const keys = check(await runDoctor({ config: makeConfig() }), "API keys");
    expect(keys).toMatchObject({ ok: false, severity: "error" });
    expect(keys.detail).toContain("ANTHROPIC_API_KEY, OPENAI_API_KEY are set");
    expect(keys.detail).toContain("subscriptions");
    expect(JSON.stringify(keys)).not.toContain("secret");
  });

  it("is happy in the container when nothing needs downgrading", async () => {
    const config = makeConfig();
    config.permissions.claudeWriteMode = "auto";
    expect(check(await runDoctor({ config }), "Container")).toMatchObject({ ok: true, severity: "warn" });
  });

  it.skipIf(existsSync("/.dockerenv"))("warns outside the container and explains the downgrade", async () => {
    vi.stubEnv("MC_IN_CONTAINER", "");
    const container = check(await runDoctor({ config: makeConfig() }), "Container");
    expect(container).toMatchObject({ ok: false, severity: "warn" });
    expect(container.detail).toContain("Not running inside the Mission Control container");
    expect(container.detail).toContain('Codex uses "workspace-write" instead of "danger-full-access"');
    expect(container.fix).toContain("mc-docker.sh");
  });

  it.skipIf(existsSync("/.dockerenv"))("warns loudly when the container safety switch is off outside the container", async () => {
    vi.stubEnv("MC_IN_CONTAINER", "");
    const config = makeConfig();
    config.permissions.requireContainerForBypass = false;
    const container = check(await runDoctor({ config }), "Container");
    expect(container).toMatchObject({ ok: false, severity: "warn" });
    // As root, Claude's bypass mode is downgraded anyway, which the detail then explains instead.
    expect(container.detail).toMatch(IS_ROOT ? /root/ : /requireContainerForBypass is false/);
  });

  it("checks folders: writable, not created yet, or blocked by a file", async () => {
    const config = makeConfig();
    mkdirSync(config.home, { recursive: true });
    let checks = await runDoctor({ config });
    expect(check(checks, "Mission Control folder")).toMatchObject({ ok: true });
    expect(check(checks, "Mission Control folder").detail).toContain("is writable");
    expect(check(checks, "Apps folder").detail).toContain("will be created");

    mkdirSync(keptApps(), { recursive: true });
    writeFileSync(join(keptApps(), "a-file"), "");
    config.workspaceRoot = join(keptApps(), "a-file", "apps");
    checks = await runDoctor({ config });
    expect(check(checks, "Apps folder")).toMatchObject({ ok: false, severity: "error" });
    expect(check(checks, "Apps folder").detail).toContain("is a file, not a folder");
    expect(check(checks, "Apps folder").fix).toContain("chown");
  });

  it("reports free disk space once when the apps and the Mission Control folder share a disk", async () => {
    const disk = check(await runDoctor({ config: makeConfig() }), "Disk space");
    expect(disk.severity).toBe("warn");
    expect(disk.detail).toMatch(/\d+\.\d GB free in /);
    expect(disk.detail).toContain(root); // the nearest folder that exists
  });

  it.skipIf(!HAS_OTHER_DISK)("reports free disk space for each disk when the Mission Control folder is on another one", async () => {
    const otherHome = mkdtempSync(join(OTHER_DISK, "mc-doctor-"));
    try {
      const config = makeConfig();
      config.home = otherHome;
      const checks = await runDoctor({ config });
      expect(names(checks)).not.toContain("Disk space");
      expect(check(checks, "Disk space (apps folder)").detail).toContain(`GB free in ${root}`);
      expect(check(checks, "Disk space (Mission Control folder)").detail).toContain(`GB free in ${otherHome}`);
    } finally {
      rmSync(otherHome, { recursive: true, force: true });
    }
  });

  it("warns when notifications are off, and never shows the secret topic", async () => {
    const on = check(await runDoctor({ config: makeConfig() }), "Notifications");
    expect(on).toMatchObject({ ok: true });
    expect(on.detail).toContain("ntfy.sh");
    expect(on.detail).not.toContain("secret-topic");

    const config = makeConfig();
    config.notify.ntfyUrl = "";
    const off = check(await runDoctor({ config }), "Notifications");
    expect(off).toMatchObject({ ok: false, severity: "warn" });
    expect(off.fix).toContain("mc config set notify.ntfyUrl");
  });

  it("lists the problems of invalid given settings and still checks that setup's folders", async () => {
    const config = makeConfig();
    config.light.model = "gpt-6-luna";
    const checks = await runDoctor({ config });
    const settings = check(checks, "Settings");
    expect(settings).toMatchObject({ ok: false, severity: "error" });
    expect(settings.detail).toContain("Luna models are disabled");
    expect(check(checks, "Apps folder").detail).toContain(keptApps());
  });

  it("in the container, refuses folders it doesn't keep, where a night's work would be deleted when the command ends", async () => {
    const config = makeConfig();
    config.workspaceRoot = join(root, "user-home", "apps");
    config.home = join(root, "elsewhere", "records");
    const checks = await runDoctor({ config });
    const apps = check(checks, "Apps folder");
    expect(apps).toMatchObject({ ok: false, severity: "error" });
    expect(apps.detail).toContain(`workspaceRoot is ${join(root, "user-home", "apps")}, which the Mission Control container doesn't keep`);
    expect(apps.fix).toBe("Put it back: mc config set workspaceRoot ~/mc-apps");
    const home = check(checks, "Mission Control folder");
    expect(home).toMatchObject({ ok: false, severity: "error" });
    expect(home.detail).toContain("Mission Control's records (missions, reports) would be deleted");
    expect(home.fix).toContain("MC_HOME"); // the tests set it

    // Folders inside the kept ones are fine.
    config.workspaceRoot = join(keptApps(), "work");
    config.home = join(keptHome(), "nested");
    const fine = await runDoctor({ config });
    expect(check(fine, "Apps folder")).toMatchObject({ ok: true });
    expect(check(fine, "Mission Control folder")).toMatchObject({ ok: true });
  });

  it.skipIf(existsSync("/.dockerenv"))("lets folders be anywhere outside the container", async () => {
    vi.stubEnv("MC_IN_CONTAINER", "");
    const config = makeConfig();
    config.workspaceRoot = join(root, "apps");
    config.home = join(root, "home");
    const checks = await runDoctor({ config });
    expect(check(checks, "Apps folder")).toMatchObject({ ok: true });
    expect(check(checks, "Mission Control folder")).toMatchObject({ ok: true });
  });

  it("reads the settings file: missing, valid, or broken", async () => {
    // The default settings run "claude" and "codex" from PATH: make sure those are the fakes.
    writeFakeCli("claude", CLAUDE_OK);
    writeFakeCli("codex", CODEX_OK);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    let settings = check(await runDoctor(), "Settings");
    expect(check(await runDoctor(), "Claude Code")).toMatchObject({ ok: true, detail: "version 2.1.295" });
    expect(settings).toMatchObject({ ok: false, severity: "warn" });
    expect(settings.fix).toContain("mc init");

    const home = join(root, "home");
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, "config.yaml"), "git:\n  push: true\n");
    const checks = await runDoctor();
    settings = check(checks, "Settings");
    expect(settings).toMatchObject({ ok: true });
    expect(settings.detail).toContain(join(home, "config.yaml"));
    expect(check(checks, "Apps folder").detail).toContain(join(root, "user-home", "mc-apps")); // the default, in the test's home

    writeFileSync(join(home, "config.yaml"), "git: [unclosed\n");
    const broken = await runDoctor();
    expect(check(broken, "Settings")).toMatchObject({ ok: false, severity: "error" });
    expect(check(broken, "Settings").detail).toContain("not valid YAML");
    expect(check(broken, "Mission Control folder").detail).toContain(home);
  });

  it("never crashes: a check that throws becomes a failed check", async () => {
    const config = makeConfig();
    (config as { families: unknown }).families = {};
    const checks = await runDoctor({ config });
    expect(check(checks, "Codex models")).toMatchObject({ ok: false, severity: "error" });
    expect(check(checks, "Codex models").detail).toContain("could not run this check");
    expect(check(checks, "Settings")).toMatchObject({ ok: false });
    expect(check(checks, "Node.js")).toMatchObject({ ok: true });
  });
});

describe("runDoctor: live checks", () => {
  function liveRunners(behaviors: { claude?: (job: AgentJob) => MockBehavior; codex?: (job: AgentJob) => MockBehavior } = {}) {
    const okAnswer = (): MockBehavior => ({ structured: { ok: true } });
    return {
      claude: new MockRunner((job) => (behaviors.claude ?? okAnswer)(job), { provider: "claude" }),
      codex: new MockRunner((job) => (behaviors.codex ?? okAnswer)(job), { provider: "codex" }),
    };
  }

  it("makes one tiny structured request per family plus Haiku", async () => {
    const runners = liveRunners();
    const checks = await runDoctor({ config: makeConfig(), live: true, runners });
    const live = checks.filter((c) => c.name.startsWith("Live: "));
    expect(names(live)).toEqual(["Live: Claude (claude-sonnet-5-5)", "Live: Codex (gpt-6.1-sol)", "Live: Haiku (claude-haiku-5-5)"]);
    for (const c of live) expect(c, c.name).toMatchObject({ ok: true, severity: "error" });

    const jobs = [...runners.claude.calls, ...runners.codex.calls];
    expect(jobs.map((j) => j.model).sort()).toEqual(["claude-haiku-5-5", "claude-sonnet-5-5", "gpt-6.1-sol"]);
    for (const job of jobs) {
      expect(job).toMatchObject({ effort: "low", access: "read-only", noTools: true, prompt: 'Return {"ok": true}' });
      expect(job.outputSchema).toMatchObject({ required: ["ok"] });
    }
  });

  it("doesn't call any AI without --live", async () => {
    const runners = liveRunners();
    const checks = await runDoctor({ config: makeConfig(), runners });
    expect(checks.some((c) => c.name.startsWith("Live"))).toBe(false);
    expect(runners.claude.calls).toHaveLength(0);
    expect(runners.codex.calls).toHaveLength(0);
  });

  it("reports a login problem without falling back to another model", async () => {
    const runners = liveRunners({ claude: () => ({ outcome: "auth", error: "Please run /login" }) });
    const checks = await runDoctor({ config: makeConfig(), live: true, runners });
    const claude = check(checks, "Live: Claude (claude-sonnet-5-5)");
    expect(claude).toMatchObject({ ok: false, severity: "error" });
    expect(claude.detail).toContain("Not logged in");
    expect(claude.fix).toContain("mc login-claude");
    expect(check(checks, "Live: Haiku (claude-haiku-5-5)")).toMatchObject({ ok: false, severity: "error" });
    expect(check(checks, "Live: Codex (gpt-6.1-sol)")).toMatchObject({ ok: true });
    expect(runners.codex.calls.map((j) => j.model)).toEqual(["gpt-6.1-sol"]);
  });

  it("treats a usage limit as a warning with its reset time, without waiting for it", async () => {
    const resetsAt = Date.now() + 2 * 60 * 60_000;
    const runners = liveRunners({ codex: () => ({ outcome: "limited", limit: { kind: "session", resetsAt } }) });
    const codex = check(await runDoctor({ config: makeConfig(), live: true, runners }), "Live: Codex (gpt-6.1-sol)");
    expect(codex).toMatchObject({ ok: false, severity: "warn" });
    expect(codex.detail).toContain("usage limit until");
    expect(runners.codex.calls).toHaveLength(1);
  });

  it("reports failed requests and wrong answers as errors pointing at the logs", async () => {
    const runners = liveRunners({ claude: (job) => (job.model === "claude-haiku-5-5" ? { structured: { ok: false } } : { outcome: "crashed", error: "claude CLI not found" }) });
    const checks = await runDoctor({ config: makeConfig(), live: true, runners });
    const claude = check(checks, "Live: Claude (claude-sonnet-5-5)");
    expect(claude).toMatchObject({ ok: false, severity: "error" });
    expect(claude.detail).toContain("claude CLI not found");
    expect(claude.fix).toContain(join(keptHome(), "doctor"));
    expect(check(checks, "Live: Haiku (claude-haiku-5-5)").detail).toContain("not with the expected reply");
  });

  it("leaves Codex and both AIs alone while a night run is working, since they share its logins", async () => {
    const config = makeConfig({ codex: { ...CODEX_OK, "login status": { out: "should not run\n", code: 1 } } });
    mkdirSync(config.home, { recursive: true });
    // The night run's lock, written in its own container: fresh heartbeat, another host.
    writeFileSync(join(config.home, "mc.lock"), JSON.stringify({ pid: 7, at: new Date().toISOString(), host: "mission-control-run-other" }));
    const runners = liveRunners();
    const checks = await runDoctor({ config, live: true, runners });

    const login = check(checks, "Codex login");
    expect(login).toMatchObject({ ok: false, severity: "warn" });
    expect(login.detail).toContain("a run is working right now (pid 7 on host mission-control-run-other)");
    expect(login.fix).toContain('Run "mc doctor" again after the run ends');
    expect(names(checks)).not.toContain("Codex models");
    const live = check(checks, "Live check");
    expect(live).toMatchObject({ ok: false, severity: "warn" });
    expect(live.fix).toContain('"mc doctor --live"');
    expect(runners.claude.calls).toHaveLength(0);
    expect(runners.codex.calls).toHaveLength(0);
    expect(checks.filter((c) => !c.ok && c.severity === "error")).toEqual([]);
    expect(check(checks, "Codex")).toMatchObject({ ok: true }); // --version doesn't touch the login

    // Once the run's heartbeat is old, it ended: everything is checked again.
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(join(config.home, "mc.lock"), old, old);
    const after = await runDoctor({ config, live: true, runners });
    expect(check(after, "Codex login")).toMatchObject({ ok: false, severity: "error" });
    expect(runners.codex.calls).toHaveLength(1);
  });

  it("reports a provider without a runner", async () => {
    const runners = { claude: liveRunners().claude };
    const checks = await runDoctor({ config: makeConfig(), live: true, runners });
    expect(check(checks, "Live: Codex (gpt-6.1-sol)")).toMatchObject({ ok: false, severity: "error" });
    expect(check(checks, "Live: Claude (claude-sonnet-5-5)")).toMatchObject({ ok: true });
  });
});
