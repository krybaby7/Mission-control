import { describe, expect, it } from "vitest";
import { buildChildEnv, type ChildEnvContext } from "./child-env.js";
import { runProcess } from "./process.js";

const base = {
  path: ["/usr/local/bin", "/usr/bin", "/bin"],
  home: "/tmp/mc-fixture/home",
  tmpDir: "/tmp/mc-fixture/tmp",
};
const baseline = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: base.home,
  TMPDIR: base.tmpDir,
  TERM: "dumb",
  FORCE_COLOR: "0",
  NO_COLOR: "1",
};
const context = (value: unknown): ChildEnvContext => value as ChildEnvContext;
const forbidden = {
  ARBITRARY_UNRELATED_SECRET: "synthetic-unrelated-value",
  ANTHROPIC_API_KEY: "synthetic-anthropic-key",
  ANTHROPIC_AUTH_TOKEN: "synthetic-anthropic-token",
  ANTHROPIC_BASE_URL: "https://synthetic.invalid",
  CLAUDE_CODE_USE_BEDROCK: "1",
  CLAUDE_CODE_USE_VERTEX: "1",
  CLAUDE_CODE_USE_FOUNDRY: "1",
  OPENAI_API_KEY: "synthetic-openai-key",
  OPENAI_BASE_URL: "https://synthetic.invalid",
  CODEX_API_KEY: "synthetic-codex-key",
  CLAUDECODE: "1",
  CLAUDE_CODE_ENTRYPOINT: "synthetic-entrypoint",
  GH_TOKEN: "synthetic-github-token",
  GITHUB_TOKEN: "synthetic-github-token",
  SSH_AUTH_SOCK: "/tmp/synthetic-agent.sock",
  SSH_ASKPASS: "/tmp/synthetic-askpass",
  GIT_DIR: "/tmp/synthetic-repository",
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "core.hooksPath",
  GIT_CONFIG_VALUE_0: "/tmp/synthetic-hooks",
  GIT_SSH_COMMAND: "synthetic-ssh-command",
  GIT_AUTHOR_NAME: "synthetic-author",
  BASH_ENV: "/tmp/synthetic-bash-injection",
  ENV: "/tmp/synthetic-shell-injection",
  NODE_OPTIONS: "--require=/tmp/synthetic-missing-loader.cjs",
  NODE_PATH: "/tmp/synthetic-node-modules",
  LD_PRELOAD: "/tmp/synthetic-loader.so",
  LD_LIBRARY_PATH: "/tmp/synthetic-libraries",
  PYTHONPATH: "/tmp/synthetic-python",
  PERL5LIB: "/tmp/synthetic-perl",
  RUBYOPT: "-r/tmp/synthetic-ruby",
  HTTP_PROXY: "http://synthetic.invalid",
  HTTPS_PROXY: "http://synthetic.invalid",
  ALL_PROXY: "http://synthetic.invalid",
  NODE_EXTRA_CA_CERTS: "/tmp/synthetic-cert",
  SSL_CERT_FILE: "/tmp/synthetic-cert",
  XDG_CONFIG_HOME: "/tmp/synthetic-xdg",
  MC_CHROMIUM: "/tmp/synthetic-browser",
  PLAYWRIGHT_BROWSERS_PATH: "/tmp/synthetic-browsers",
};

describe("buildChildEnv", () => {
  it.each(["worker", "provider-metadata"] as const)("builds %s environment from explicit inputs only", (purpose) => {
    const input = { ...base, ...forbidden, purpose, provider: "claude" as const, PATH: "/mnt/c/synthetic-windows" };
    expect(buildChildEnv(input)).toEqual(baseline);
    expect(input.ARBITRARY_UNRELATED_SECRET).toBe("synthetic-unrelated-value");
  });

  it.each(["claude", "codex"] as const)("passes only the explicitly selected %s configuration home", (provider) => {
    const env = buildChildEnv({
      ...base, purpose: "worker", provider, configHome: "/tmp/selected-provider",
      CLAUDE_CONFIG_DIR: "/tmp/unselected-claude", CODEX_HOME: "/tmp/unselected-codex",
    } as ChildEnvContext);
    expect(env).toEqual({ ...baseline, [provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"]: "/tmp/selected-provider" });
  });

  it.each(["verification", "rendering", "diagnostic"] as const)("%s omits all provider configuration", (purpose) => {
    const env = buildChildEnv(context({ ...base, ...forbidden, purpose, provider: "claude", configHome: "/tmp/provider", CLAUDE_CONFIG_DIR: "/tmp/claude", CODEX_HOME: "/tmp/codex" }));
    expect(env).toEqual({ ...baseline, ...(purpose === "verification" ? { CI: "1" } : {}) });
  });

  it("passes explicit locale and timezone without accepting arbitrary language variables", () => {
    expect(buildChildEnv({ ...base, purpose: "rendering", lang: "en_US.UTF-8", lcAll: "C.UTF-8", timezone: "Africa/Cairo" }))
      .toEqual({ ...baseline, LANG: "en_US.UTF-8", LC_ALL: "C.UTF-8", TZ: "Africa/Cairo" });
  });

  it("keeps paths with spaces and native symlink spellings without filesystem access", () => {
    expect(buildChildEnv({ ...base, purpose: "diagnostic", path: ["/home/fixture/.local/bin", "/opt/native link/bin"], home: "/tmp/a home", tmpDir: "/tmp/a tmp" }))
      .toMatchObject({ PATH: "/home/fixture/.local/bin:/opt/native link/bin", HOME: "/tmp/a home", TMPDIR: "/tmp/a tmp" });
  });

  it("leaves frozen inputs untouched and returns a fresh object each time", () => {
    const input = Object.freeze({ ...base, path: Object.freeze([...base.path]), purpose: "verification" as const });
    const first = buildChildEnv(input);
    first.HOME = "/tmp/changed";
    expect(buildChildEnv(input)).toEqual({ ...baseline, CI: "1" });
    expect(input.home).toBe(base.home);
  });

  it("constructs Git control constants and ignores inherited Git settings", () => {
    expect(buildChildEnv({ ...base, ...forbidden, purpose: "controller-git", lang: "en_US.UTF-8", lcAll: "fr_FR.UTF-8" })).toEqual({
      ...baseline, LANG: "en_US.UTF-8", LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no", GIT_OPTIONAL_LOCKS: "0",
    });
  });

  it("accepts only typed controller Git paths and the isolated-config switch", () => {
    expect(buildChildEnv({ ...base, purpose: "controller-git", indexFile: "/tmp/guard/index", ceilingDirectory: "/tmp/project-parent", isolatedConfig: true })).toEqual({
      ...baseline, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true", GIT_MERGE_AUTOEDIT: "no", GIT_OPTIONAL_LOCKS: "0",
      GIT_INDEX_FILE: "/tmp/guard/index", GIT_CEILING_DIRECTORIES: "/tmp/project-parent", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
    });
  });

  it("does not add isolated Git config controls when the switch is false", () => {
    const env = buildChildEnv({ ...base, purpose: "controller-git", isolatedConfig: false });
    expect(env).not.toHaveProperty("GIT_CONFIG_NOSYSTEM");
    expect(env).not.toHaveProperty("GIT_CONFIG_GLOBAL");
  });

  it.each([
    "", "relative/bin", "./bin", "../bin", "/usr/../bin", "/usr/./bin", "/usr/bin:/bin", "C:/Windows",
    "C:\\Windows", "\\\\server\\share", "//server/share", "/mnt/c/Windows", "/mnt/C/Windows",
    "/run/desktop/mnt/host/c/Windows", "/mnt//c/Windows", "/mnt///C/Windows", "/run//desktop/mnt/host/c/Windows", "/bin\u0000other", "/bin\nother", "/bin\rother", "/bin\\other",
  ])("rejects non-native or malformed PATH entry %j", (entry) => {
    expect(() => buildChildEnv({ ...base, purpose: "verification", path: ["/bin", entry] })).toThrow("path[1]");
  });

  it("rejects sparse PATH arrays whose empty search components would select cwd", () => {
    expect(() => buildChildEnv({ ...base, purpose: "verification", path: Array<string>(1) })).toThrow("path[0]");
    expect(() => buildChildEnv({ ...base, purpose: "verification", path: ["/bin", , "/usr/bin"] as string[] })).toThrow("path[1]");
  });

  it.each(["home", "tmpDir"] as const)("validates required %s independently of PATH", (key) => {
    for (const value of ["", "relative", "/mnt/d/Windows", "/tmp/../outside", "/tmp\nunsafe"]) {
      expect(() => buildChildEnv(context({ ...base, purpose: "rendering", [key]: value }))).toThrow(key);
    }
  });

  it.each(["path", "home", "tmpDir"] as const)("fails clearly when %s is missing", (key) => {
    const input: Record<string, unknown> = { ...base, purpose: "diagnostic" };
    delete input[key];
    expect(() => buildChildEnv(context(input))).toThrow(key);
  });

  it.each([{ path: [] }, { path: "/usr/bin:/bin" }, { path: [null] }, { path: [1] }, { path: ["/bin", undefined] }])("rejects malformed PATH container $path", ({ path }) => {
    expect(() => buildChildEnv(context({ ...base, purpose: "diagnostic", path }))).toThrow("path");
  });

  it.each(["worker", "provider-metadata"] as const)("requires a valid selected provider for %s", (purpose) => {
    for (const provider of [undefined, "other", 1]) {
      expect(() => buildChildEnv(context({ ...base, purpose, provider }))).toThrow("provider");
    }
  });

  it.each(["", "relative", "/mnt/c/config", "/tmp/../config"])("validates selected provider config path %j", (configHome) => {
    expect(() => buildChildEnv({ ...base, purpose: "worker", provider: "codex", configHome })).toThrow("configHome");
  });

  it.each(["indexFile", "ceilingDirectory"] as const)("validates controller Git %s", (key) => {
    expect(() => buildChildEnv(context({ ...base, purpose: "controller-git", [key]: "relative" }))).toThrow(key);
  });

  it("rejects a malformed Git isolation switch", () => {
    expect(() => buildChildEnv(context({ ...base, purpose: "controller-git", isolatedConfig: "yes" }))).toThrow("isolatedConfig");
  });

  it.each(["lang", "lcAll", "timezone"] as const)("validates explicit %s", (key) => {
    for (const value of ["", "bad\nvalue", "/tmp/injection", "bad value", 42]) {
      expect(() => buildChildEnv(context({ ...base, purpose: "rendering", [key]: value }))).toThrow(key);
    }
  });

  it.each([null, undefined, {}, { ...base, purpose: "unknown-synthetic-purpose" }])("rejects missing or unknown purpose without printing it", (input) => {
    expect(() => buildChildEnv(context(input))).toThrow("purpose");
    try { buildChildEnv(context(input)); } catch (error) {
      expect(String(error)).not.toContain("unknown-synthetic-purpose");
    }
  });

  it("errors identify the bad setting without revealing its value", () => {
    try {
      buildChildEnv({ ...base, purpose: "verification", home: "synthetic-private-value" });
      expect.fail("expected invalid home to fail");
    } catch (error) {
      expect(String(error)).toContain("home");
      expect(String(error)).not.toContain("synthetic-private-value");
    }
  });

  it("starts a local Node child with only the controlled environment and no injected loader", async () => {
    const env = buildChildEnv({ ...base, ...forbidden, purpose: "verification" });
    const child = await runProcess({
      command: process.execPath, args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      cwd: process.cwd(), env, timeoutMs: 5_000,
    });
    expect(child).toMatchObject({ exitCode: 0, timedOut: false, aborted: false, stderr: "" });
    expect(JSON.parse(child.stdout)).toEqual({ ...baseline, CI: "1" });
  });
});

describe("explicit controller Git config selection", () => {
  it("accepts a native controller-selected global config without inheritance", () => {
    expect(buildChildEnv({ ...base, purpose: "controller-git", globalConfig: "/tmp/controller.gitconfig" } as ChildEnvContext))
      .toMatchObject({ GIT_CONFIG_GLOBAL: "/tmp/controller.gitconfig", GIT_CONFIG_NOSYSTEM: "1" });
  });
  it("rejects an explicit global config combined with isolated config", () => {
    expect(() => buildChildEnv({ ...base, purpose: "controller-git", globalConfig: "/tmp/controller.gitconfig", isolatedConfig: true } as ChildEnvContext))
      .toThrow("globalConfig");
  });
  it("rejects a malformed explicit global config without echoing it", () => {
    expect(() => buildChildEnv({ ...base, purpose: "controller-git", globalConfig: "synthetic-private-relative" } as ChildEnvContext))
      .toThrow("globalConfig");
  });
});
