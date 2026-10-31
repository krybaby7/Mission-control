// Positive environment construction only. These lexical checks do not restrict
// filesystem access or establish an operating-system isolation boundary.

export interface ChildEnvBase {
  /** Trusted controller-selected native Linux search directories, never inherited PATH. */
  path: readonly string[];
  /** Intended child home and controlled temporary directory. */
  home: string;
  tmpDir: string;
  lang?: string;
  lcAll?: string;
  timezone?: string;
}

export type ChildEnvContext = ChildEnvBase & (
  | {
      purpose: "worker" | "provider-metadata";
      provider: "claude" | "codex";
      /** Only the selected provider's controller-selected configuration location. */
      configHome?: string;
    }
  | { purpose: "verification" | "rendering" | "diagnostic" }
  | {
      purpose: "controller-git";
      /** Constructed by protected controller code, never copied from worker environment. */
      indexFile?: string;
      ceilingDirectory?: string;
      isolatedConfig?: boolean;
      /** Explicit trusted controller global configuration, not an inherited GIT variable. */
      globalConfig?: string;
    }
);

const PURPOSES = new Set(["worker", "provider-metadata", "verification", "rendering", "diagnostic", "controller-git"]);

/**
 * Starts empty and adds documented settings only. No process.env reads, arbitrary
 * environment overrides, proxy/certificate forwarding, or inherited Git controls.
 * Errors name settings without including their supplied values.
 */
export function buildChildEnv(context: ChildEnvContext): Record<string, string> {
  if (context === null || typeof context !== "object" || !PURPOSES.has(context.purpose)) invalid("purpose");
  if (!Array.isArray(context.path) || context.path.length === 0) invalid("path");
  const path = Array.from(context.path, (entry: unknown, index: number) => nativePath(entry, `path[${index}]`));
  const env: Record<string, string> = {};
  env.PATH = path.join(":");
  env.HOME = nativePath(context.home, "home");
  env.TMPDIR = nativePath(context.tmpDir, "tmpDir");
  env.TERM = "dumb";
  env.FORCE_COLOR = "0";
  env.NO_COLOR = "1";
  if (context.lang !== undefined) env.LANG = locale(context.lang, "lang");
  if (context.lcAll !== undefined) env.LC_ALL = locale(context.lcAll, "lcAll");
  if (context.timezone !== undefined) env.TZ = timezone(context.timezone);

  switch (context.purpose) {
    case "worker":
    case "provider-metadata":
      if (context.provider !== "claude" && context.provider !== "codex") invalid("provider");
      if (context.configHome !== undefined) {
        const name = context.provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
        env[name] = nativePath(context.configHome, "configHome");
      }
      break;
    case "verification":
      env.CI = "1";
      break;
    case "controller-git":
      env.GIT_TERMINAL_PROMPT = "0";
      env.GIT_EDITOR = "true";
      env.GIT_MERGE_AUTOEDIT = "no";
      env.GIT_OPTIONAL_LOCKS = "0";
      env.LC_ALL = "C";
      if (context.indexFile !== undefined) env.GIT_INDEX_FILE = nativePath(context.indexFile, "indexFile");
      if (context.ceilingDirectory !== undefined) env.GIT_CEILING_DIRECTORIES = nativePath(context.ceilingDirectory, "ceilingDirectory");
      if (context.isolatedConfig !== undefined && typeof context.isolatedConfig !== "boolean") invalid("isolatedConfig");
      if (context.globalConfig !== undefined) {
        if (context.isolatedConfig) invalid("globalConfig");
        env.GIT_CONFIG_GLOBAL = nativePath(context.globalConfig, "globalConfig");
        env.GIT_CONFIG_NOSYSTEM = "1";
      }
      if (context.isolatedConfig) {
        env.GIT_CONFIG_NOSYSTEM = "1";
        env.GIT_CONFIG_GLOBAL = "/dev/null";
      }
      break;
    case "rendering":
    case "diagnostic":
      break;
  }
  return env;
}

/** Preserve native symlink spellings; resolving paths here would falsely imply isolation. */
function nativePath(value: unknown, setting: string): string {
  if (
    typeof value !== "string" || !value.startsWith("/") || value.includes("//") ||
    /[\\:\u0000-\u001f\u007f]/u.test(value) || value.split("/").some((part) => part === "." || part === "..") ||
    /^\/mnt\/[a-z](?:\/|$)/iu.test(value) || /^\/run\/desktop\/mnt\/host\/[a-z](?:\/|$)/iu.test(value)
  ) invalid(setting);
  return value;
}

function locale(value: unknown, setting: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.@-]{0,127}$/u.test(value)) invalid(setting);
  return value;
}

/** Zone names and simple UTC offsets only; no path-based timezone-file selection. */
function timezone(value: unknown): string {
  if (
    typeof value !== "string" || value.length > 128 ||
    !/^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)*$/u.test(value)
  ) invalid("timezone");
  return value;
}

function invalid(setting: string): never {
  throw new Error(`Invalid child environment setting: ${setting}`);
}
