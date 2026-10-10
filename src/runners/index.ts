// Builds the real CLI runners from the config, with the permission modes this environment allows.
import { effectivePermissions } from "../config.js";
import type { Config, Logger } from "../types.js";
import { nullLogger } from "../util/logger.js";
import { ClaudeRunner } from "./claude.js";
import { CodexRunner } from "./codex.js";

/** The concrete runners, so callers can reach `buildArgs`; assignable to `Record<"claude" | "codex", AgentRunner>`. */
export interface Runners {
  claude: ClaudeRunner;
  codex: CodexRunner;
}

export interface CreateRunnersOptions {
  logger?: Logger;
  /** Whether Mission Control runs inside its container. Default: detected (see `inContainer`). */
  containerized?: boolean;
}

/**
 * One runner per CLI family. Write modes come from `effectivePermissions`, so the full-autonomy modes are only
 * used where the config allows them; a downgrade is logged as a warning.
 */
export function createRunners(c: Config, opts: CreateRunnersOptions = {}): Runners {
  const logger = opts.logger ?? nullLogger;
  const permissions = effectivePermissions(c, opts.containerized);
  if (permissions.downgraded) {
    logger.warn(`Agent permissions downgraded: ${permissions.reason}`, {
      claudeWriteMode: permissions.claudeWriteMode,
      codexWriteSandbox: permissions.codexWriteSandbox,
    });
  }
  return {
    claude: new ClaudeRunner({ command: c.cli.claudeCommand, logger, writeMode: permissions.claudeWriteMode }),
    codex: new CodexRunner({ command: c.cli.codexCommand, logger, writeSandbox: permissions.codexWriteSandbox }),
  };
}
