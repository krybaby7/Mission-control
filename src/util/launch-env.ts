// Trusted controller adapters for the pure positive environment policy.
// A private HOME reduces inherited configuration; it does not restrict file access.
import { mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { buildChildEnv, type ChildEnvContext } from "./child-env.js";

export interface ToolPathOptions { path?: readonly string[]; }
export interface ProviderLaunchOptions extends ToolPathOptions {
  /** Controller-selected config home for this provider only. */
  configHome?: string;
}
type Provider = "claude" | "codex";
type GitContext = Extract<ChildEnvContext, { purpose: "controller-git" }>;
export type ControllerGitOptions = Partial<Omit<GitContext, "purpose">>;

/** Node's native directory and approved native locations, never the inherited PATH. */
export function nativeToolPath(ownerHome = homedir(), executable = process.execPath): string[] {
  const path = [...new Set([
    dirname(executable), join(ownerHome, ".local", "bin"),
    "/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin",
  ])];
  buildChildEnv({ purpose: "diagnostic", path, home: ownerHome, tmpDir: "/tmp" });
  return path;
}

export function providerLaunchEnv(options: ProviderLaunchOptions & {
  purpose: "worker" | "provider-metadata"; provider: Provider; ownedDir: string;
}): Record<string, string> {
  const configHome = options.configHome ?? (options.provider === "claude" ? process.env.CLAUDE_CONFIG_DIR : process.env.CODEX_HOME)
    ?? join(homedir(), options.provider === "claude" ? ".claude" : ".codex");
  return ownedEnvironment({
    purpose: options.purpose, provider: options.provider, configHome,
    path: options.path ?? nativeToolPath(), home: options.ownedDir + "/home", tmpDir: options.ownedDir + "/tmp",
  });
}

export function localLaunchEnv(options: ToolPathOptions & {
  purpose: "verification" | "rendering" | "diagnostic"; ownedDir: string;
}): Record<string, string> {
  return ownedEnvironment({
    purpose: options.purpose, path: options.path ?? nativeToolPath(),
    home: options.ownedDir + "/home", tmpDir: options.ownedDir + "/tmp",
  });
}

/** Controller Git keeps the owner's intended config view, without inherited GIT/SSH variables. */
export function controllerGitEnv(options: ControllerGitOptions = {}): Record<string, string> {
  return buildChildEnv({
    ...options, purpose: "controller-git", path: options.path ?? nativeToolPath(),
    home: options.home ?? homedir(), tmpDir: options.tmpDir ?? "/tmp",
  });
}

function ownedEnvironment(context: ChildEnvContext): Record<string, string> {
  const env = buildChildEnv(context); // Validate every setting before touching the filesystem.
  try {
    mkdirSync(env.HOME!, { mode: 0o700 });
    mkdirSync(env.TMPDIR!, { mode: 0o700 });
  } catch {
    // Do not reuse an existing path or follow an existing link, and do not echo its contents.
    throw new Error("Invalid child environment setting: ownedDir (fresh home/tmp required)");
  }
  return env;
}

/** Cleanup of controller-created temporary directories must not replace a structured outcome. */
export function cleanupLaunchDir(ownedDir: string | undefined): void {
  if (ownedDir === undefined) return;
  try { rmSync(ownedDir, { recursive: true, force: true }); } catch { /* retain the original outcome */ }
}

/** Validate a controller-selected temporary root before mkdir/join can normalize it. */
export function validateTempRoot(tmpDir: string): void {
  buildChildEnv({ purpose: "diagnostic", path: ["/usr/bin", "/bin"], home: "/tmp", tmpDir });
}
