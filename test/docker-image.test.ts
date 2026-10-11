// Tests for the container image: docker/entrypoint.sh run directly with a temp HOME, and the Dockerfile's
// requirements from the spec (pins, user, entrypoint), checked as text because tests can't use Docker.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultConfig } from "../src/config.js";

const REPO_DIR = fileURLToPath(new URL("..", import.meta.url));
const ENTRYPOINT = path.join(REPO_DIR, "docker", "entrypoint.sh");
const DOCKERFILE = fs.readFileSync(path.join(REPO_DIR, "docker", "Dockerfile"), "utf8");
const BASH = ["/usr/bin/bash", "/bin/bash"].find((p) => fs.existsSync(p)) ?? "bash";
const IS_ROOT = process.getuid?.() === 0;

let home: string;
let bin: string;

function entrypoint(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(BASH, [ENTRYPOINT, ...args], {
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ...env },
    input: "",
    encoding: "utf8",
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A home where every folder exists and both CLIs are logged in. */
function setUpReadyHome(): void {
  for (const dir of [".claude", ".codex", ".mission-control", "mc-apps"]) fs.mkdirSync(path.join(home, dir));
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{}");
  fs.writeFileSync(path.join(home, ".codex", "auth.json"), "{}");
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mc-entrypoint-test-"));
  bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  for (const cli of ["claude", "codex"]) {
    fs.writeFileSync(path.join(bin, cli), `#!/bin/sh\necho "${cli} $*"\n`, { mode: 0o755 });
  }
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("entrypoint.sh", () => {
  it("runs the command quietly when everything is ready, passing its exit status through", () => {
    setUpReadyHome();
    const r = entrypoint(["bash", "-c", 'echo "ran $1"; exit 7', "_", "with args"]);
    expect(r.status).toBe(7);
    expect(r.stdout).toBe("ran with args\n");
    expect(r.stderr).toBe("");
  });

  it("hints at every missing folder and login, and still runs the command", () => {
    const r = entrypoint(["echo", "ran"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("ran\n");
    for (const dir of [".claude", ".codex", ".mission-control"]) {
      expect(r.stderr).toContain(`cannot write to ${home}/${dir}. Fix: in Ubuntu, run: mc fix-permissions`);
    }
    expect(r.stderr).toContain(`cannot write to ${home}/mc-apps. Fix: in Ubuntu, run: sudo chown -R "$USER": ~/mc-apps && mc build`);
    expect(r.stderr).toContain("not logged in to Claude yet. In Ubuntu, run: mc login-claude");
    expect(r.stderr).toContain("not logged in to Codex yet. In Ubuntu, run: mc login-codex");
  });

  it("treats empty credential files as not logged in", () => {
    setUpReadyHome();
    fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "");
    fs.writeFileSync(path.join(home, ".codex", "auth.json"), "");
    const r = entrypoint(["true"]);
    expect(r.stderr).toContain("not logged in to Claude yet");
    expect(r.stderr).toContain("not logged in to Codex yet");
    expect(r.stderr).not.toContain("cannot write");
  });

  it("flags a file where a folder should be", () => {
    setUpReadyHome();
    fs.rmSync(path.join(home, "mc-apps"), { recursive: true });
    fs.writeFileSync(path.join(home, "mc-apps"), "");
    expect(entrypoint(["true"]).stderr).toBe(`mission-control: cannot write to ${home}/mc-apps. Fix: in Ubuntu, run: sudo chown -R "$USER": ~/mc-apps && mc build\n`);
  });

  it.skipIf(IS_ROOT)("flags a folder it cannot write to", () => {
    setUpReadyHome();
    fs.chmodSync(path.join(home, ".codex"), 0o500);
    try {
      expect(entrypoint(["true"]).stderr).toContain(`cannot write to ${home}/.codex.`);
    } finally {
      fs.chmodSync(path.join(home, ".codex"), 0o700);
    }
  });

  it.each(["claude", "codex"])("skips the login hints when running %s, which is how you log in", (cli) => {
    for (const dir of [".claude", ".codex", ".mission-control", "mc-apps"]) fs.mkdirSync(path.join(home, dir));
    const r = entrypoint([cli, "login"]);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe(`${cli} login\n`);
    expect(r.stderr).toBe("");
  });

  it("checks the folders that CLAUDE_CONFIG_DIR, CODEX_HOME and MC_HOME point to", () => {
    setUpReadyHome();
    const elsewhere = path.join(home, "elsewhere");
    const r = entrypoint(["true"], {
      CLAUDE_CONFIG_DIR: path.join(elsewhere, "claude"),
      CODEX_HOME: path.join(elsewhere, "codex"),
      MC_HOME: path.join(elsewhere, "mc"),
    });
    for (const dir of ["claude", "codex", "mc"]) expect(r.stderr).toContain(`cannot write to ${elsewhere}/${dir}.`);
    expect(r.stderr).toContain("not logged in to Claude yet");
  });
});

describe("Dockerfile", () => {
  it("starts from a pinned Playwright Ubuntu image", () => {
    expect(DOCKERFILE).toMatch(/^FROM mcr\.microsoft\.com\/playwright:v\d+\.\d+\.\d+-noble$/m);
  });

  it("installs the CLI versions Mission Control checks for", () => {
    const { claudeVersion, codexVersion } = defaultConfig().cli;
    expect(DOCKERFILE).toContain(`@anthropic-ai/claude-code@${claudeVersion} @openai/codex@${codexVersion}`);
  });

  it("builds and links mc, and fails the build when mc can't start", () => {
    expect(DOCKERFILE).toMatch(/RUN npm ci\b/);
    expect(DOCKERFILE).toMatch(/RUN npm run build \\\n && npm link \\\n[\s\S]*&& mc --help >\/dev\/null\n/);
  });

  it("copies the dashboard page into the image, and the package lists it", () => {
    expect(DOCKERFILE).toContain("COPY dashboard ./dashboard");
    const { files } = JSON.parse(fs.readFileSync(path.join(REPO_DIR, "package.json"), "utf8")) as { files: string[] };
    expect(files).toContain("dashboard");
  });

  it("has the page the image copies: without it `mc dashboard` has nothing to serve", () => {
    expect(fs.existsSync(path.join(REPO_DIR, "dashboard", "index.html"))).toBe(true);
  });

  it("keeps Playwright from deleting browsers other apps still use", () => {
    expect(DOCKERFILE).toMatch(/^\s+PLAYWRIGHT_SKIP_BROWSER_GC=1$/m);
  });

  it("runs as pwuser in its home, marked as the container, through the entrypoint", () => {
    expect(DOCKERFILE).toMatch(/^ENV MC_IN_CONTAINER=1 /m);
    expect(DOCKERFILE).toContain("COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/mc-entrypoint.sh");
    expect(DOCKERFILE.trimEnd().split("\n").slice(-4)).toEqual([
      "USER pwuser",
      "WORKDIR /home/pwuser",
      'ENTRYPOINT ["/usr/local/bin/mc-entrypoint.sh"]',
      'CMD ["mc", "--help"]',
    ]);
  });
});
