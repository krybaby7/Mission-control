# Mission Control MVP: implementation spec

This is the build contract for the first working version. Every module codes against `src/types.ts`; **do not change `src/types.ts`**. If a contract is wrong, report it, don't patch around it. Background: `docs/design-v1.md`.

**Runtime:** Node ≥ 22.12, TypeScript (strict, NodeNext ESM: relative imports end in `.js`), Vitest for tests.
**Dependencies available:** `commander`, `yaml`, `ajv`. **Do not add dependencies.** Use `node:` built-ins for everything else.
**Target OS:** Linux (WSL2 Ubuntu on the user's Windows PC, normally inside Docker). POSIX-only code is fine. Never require a TTY.

## Facts verified on the real CLIs (2026-10-09)

**Claude Code 2.1.295** (`claude -p`):
- **Flags:** `-p`, `--output-format stream-json`, `--verbose` (required with stream-json), `--model <id>`, `--effort low|medium|high|xhigh|max`, `--max-turns <n>` (hidden but supported), `--append-system-prompt-file <path>`, `--json-schema '<json>'`, `--permission-mode acceptEdits|auto|bypassPermissions|manual|dontAsk|plan`, `--permission-prompts none`, `--tools <list>` (`""` disables all tools, e.g. `Read,Grep,Glob`), `--resume <id>`, `--no-session-persistence`.
- **Prompt:** reads it from **stdin** when no positional prompt is given. Always pass prompts via stdin; Linux caps a single argv string at 128 KiB.
- **`--bare` needs an API key: never use it.**
- **stream-json lines** are JSON objects with a `type`:
  - `{"type":"system","subtype":"init","session_id":"…","model":"…",…}`
  - `{"type":"assistant","message":{"content":[{"type":"text","text":"…"},{"type":"tool_use","name":"Edit","input":{…}}]},"session_id":"…"}`
  - `{"type":"user",…}` (tool results; ignore apart from progress)
  - `{"type":"system","subtype":"api_retry","attempt":1,"max_retries":10,"retry_delay_ms":2000,"error_status":429,"error":…}`
  - `{"type":"rate_limit_event","rate_limit_info":{…},"uuid":"…","session_id":"…"}`. The `rate_limit_info` object has:
    - `status`: `"allowed"|"allowed_warning"|"rejected"`
    - `resetsAt`: unix **seconds**, optional
    - `rateLimitType`: `"five_hour"|"seven_day"|"seven_day_opus"|"seven_day_sonnet"|"seven_day_overage_included"|"overage"`, optional
    - `utilization`: 0..1, optional
    - `unifiedWindows`: `{five_hour?:{utilization,resetsAt}, seven_day?:{…}, seven_day_overage_included?:{…}}`, optional
  - Final message: `{"type":"result","subtype":"success"|"error_during_execution"|"error_max_turns"|"error_max_budget_usd"|"error_max_structured_output_retries","is_error":bool,"api_error_status":number|null?,"num_turns":n,"result":"<final text>","structured_output":<json>?,"total_cost_usd":n,"usage":{"input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens"},"session_id":"…","errors":[…]?}`
- **Usage limits** come as a `rate_limit_event` with `status:"rejected"`, and/or `result.is_error` with text like `You've hit your session limit · resets 3:45pm` (variants: weekly / Opus / Sonnet / Fable limit). Users report events occasionally glued mid-line, so parse defensively. `--fallback-model` does NOT trigger on usage limits.
- **Environment:** if `ANTHROPIC_API_KEY` is set, the CLI silently bills the API instead of the subscription. Scrub it (see `scrubEnv`).

**Codex CLI 0.162.0** (`codex exec`):
- **Flags:** `-m <model>`, `-C <dir>`, `-s read-only|workspace-write|danger-full-access`, `-c key=value` (TOML value, e.g. `-c model_reasoning_effort="high"`), `--json`, `--output-schema <file>`, `-o <file>` (last message), `--skip-git-repo-check`, `--ephemeral`, `--dangerously-bypass-approvals-and-sandbox`.
- **Prompt:** `-` or no prompt reads it from stdin. If stdin is a pipe and is never closed, it **waits for input**. Always provide stdin and close it.
- **Profiles** are `-p <name>` → `$CODEX_HOME/<name>.config.toml`. Don't use them; pass `-c` overrides.
- **`--json` events** (one JSON per line on stdout):
  - `{"type":"thread.started","thread_id":"…"}`
  - `{"type":"turn.started"}`
  - `{"type":"item.started"|"item.updated"|"item.completed","item":{"id":"…","type":"agent_message"|"reasoning"|"command_execution"|"file_change"|"mcp_tool_call"|"collab_tool_call"|"web_search"|"todo_list"|"error",…}}`. An `agent_message` item has `text`; a `command_execution` item has `command`.
  - `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","cache_write_input_tokens","output_tokens","reasoning_output_tokens"}}`. Usage is the **thread total**. As in the OpenAI Responses API, `cached_input_tokens` is part of `input_tokens` and `reasoning_output_tokens` is part of `output_tokens` (a server reply with output 50, of which reasoning 30, prints `"output_tokens":50,"reasoning_output_tokens":30`).
  - `{"type":"turn.failed","error":{"message":"…"}}`
  - `{"type":"error","message":"Reconnecting... 2/5 (…)"}`. These are retries and often recover; never treat them as final.
- **Exit codes:** 0 on success. **Exit 1** on failure, including usage limit and auth. Example observed auth failure: `turn.failed` with `unexpected status 401 Unauthorized: Missing bearer or basic authentication…`.
- **Usage-limit text:** `You've hit your usage limit. … Try again at 3:45 PM.` or `… Try again at Oct 10th, 2026 3:45 PM.` The time is local. There is no structured reset time in exec output.
- **Models** (`codex debug models`): `gpt-6-astra` (frontier), `gpt-6.1-sol` (standard). Effort: `low|medium|high|xhigh|max|ultra`. **Never use `ultra`**: it fans out to subagents.
- **Sandbox:** `workspace-write` has no network by default; enable it with `-c sandbox_workspace_write.network_access=true`. In exec mode, approval requests are auto-rejected.
- **Environment:** scrub `OPENAI_API_KEY` and `CODEX_API_KEY` so the ChatGPT login is used.

**User rules:**
- Light-tier work is always Claude **Haiku 5.5** (`claude-haiku-5-5`). Never GPT Luna.
- The frontier tier is Opus 5.5 (`claude-opus-5-5`) or GPT-6 Astra (`gpt-6-astra`).
- The standard tier is Sonnet 5.5 (`claude-sonnet-5-5`) or GPT-6.1 Sol (`gpt-6.1-sol`).

## Layout

```
src/
  types.ts                 (contract, owned by integrator)
  util/process.ts          runProcess, scrubEnv, killTree
  util/ndjson.ts           LineSplitter, parseJsonLine
  util/clock.ts            systemClock, FakeClock
  util/logger.ts           createLogger, nullLogger
  util/fs.ts               writeJsonAtomic, readJson, appendJsonl, readJsonl, expandHome, ensureDir, sha256File
  limits.ts                parseResetTime, detectLimitText, limitKindFromClaudeType
  config.ts                defaultConfig, configTemplateYaml, loadConfig, validateConfig, parseRoleOverride, resolveModel, resolveFamily, otherFamily, inContainer, effectivePermissions
  state.ts                 MissionStore, slugify
  git.ts                   Git
  verify.ts                Verifier, failureSignature, stripAnsi, tailLines, hashFiles, checkFrozen, scanAntiCheat, matchesGlob
  schemas.ts               SCHEMAS, validateOutput, assertStrictCompatible
  prompts.ts               loadRolePrompt, loadStack, *Prompt builders, truncation helpers
  report.ts                buildReportFacts, renderReport, collectScreenshots
  notify.ts                createNotifier
  runners/claude.ts        ClaudeRunner
  runners/codex.ts         CodexRunner
  runners/mock.ts          MockRunner
  runners/index.ts         createRunners
  quota.ts                 QuotaGovernor
  executor.ts              RoleExecutor (+ errors)
  dispatcher.ts            Dispatcher
  run.ts                   runNight (composition root used by CLI)
  doctor.ts                runDoctor
  cli.ts                   `mc` entrypoint (commander)
prompts/                   architect.md engineer.md test_author.md reviewer.md scout.md
stacks/nextjs.md           house stack for greenfield apps
test/                      cross-module integration tests (+ fixtures)
docker/                    Dockerfile, entrypoint.sh
scripts/                   mc-docker.sh
```

**Module conventions:**
- Each module has a colocated `*.test.ts`.
- Tests must not need network, real `claude`/`codex` binaries, or a TTY. Use temp dirs (`fs.mkdtempSync(os.tmpdir()+…)`) and clean them up.
- Use fake executables (small `#!/usr/bin/env node` scripts written into a temp dir, `chmod 755`) for CLI runners.
- `git` is available in tests.

## Schemas (strict-compatible JSON Schema)

Codex `--output-schema` uses OpenAI strict structured outputs, and Claude `--json-schema` accepts the same. Every schema in `src/schemas.ts` must be **strict-compatible**:
- Every `type: "object"` has `additionalProperties: false`, and `required` lists **every** key in `properties`.
- Optional values are expressed as nullable: `{"type": ["string","null"]}`, or `anyOf: [{…}, {"type":"null"}]` for objects.
- Allowed keywords only: `type, properties, required, additionalProperties, items, enum, anyOf, description`. No `minLength`, `pattern`, `format`, `minItems`, `maxItems`, `oneOf`, `allOf`, `$ref`, or `default`.
- The root is an object.

`assertStrictCompatible(schema)` throws when a rule is broken. The schema test must check every schema with it.

---

## W1-A: `util/*`, `limits.ts`

### `util/process.ts`

```ts
export interface SpawnSpec {
  command: string; args: string[]; cwd: string;
  env?: NodeJS.ProcessEnv;           // default: process.env
  stdin?: string;                    // written then closed; when undefined, stdin is closed immediately (never left open)
  timeoutMs: number;
  signal?: AbortSignal;
  onStdoutLine?: (line: string) => void;   // complete lines, no trailing \n; \r\n handled
  onStderrLine?: (line: string) => void;
  teeStdoutTo?: string;              // append raw stdout to this file
  maxBufferBytes?: number;           // cap for captured stdout/stderr (keep the LAST bytes); default 8 MiB / 256 KiB
}
export interface SpawnResult {
  exitCode: number | null; signal: NodeJS.Signals | null;
  timedOut: boolean; aborted: boolean;
  stdout: string; stderr: string;     // capped tails
  durationMs: number;
  spawnError?: string;               // e.g. "ENOENT: claude not found"
}
export function runProcess(spec: SpawnSpec): Promise<SpawnResult>;   // never rejects
export function scrubEnv(env?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function killTree(pid: number, signal?: NodeJS.Signals): void;
```

- **Spawning:** spawn with `detached: true` (its own process group). On timeout or abort, SIGTERM the **group** (`process.kill(-pid)`), then SIGKILL after 5 s if still alive.
- **No shell:** `shell: false`.
- **`scrubEnv`** removes these vars (case-sensitive): `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `CODEX_API_KEY`, `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT`. It keeps everything else, including PATH and HOME. It returns a new object.

### `util/ndjson.ts`

```ts
export class LineSplitter { push(chunk: string): string[]; flush(): string[]; }
export function parseJsonLine(line: string): unknown[];
```

`parseJsonLine` behavior:
- Empty line → `[]`.
- Normal JSON object → `[obj]`.
- Several objects glued together (`{…}{…}`) or with junk text before them → every top-level object found. Use a brace-depth scanner that respects strings and escapes, and try `JSON.parse` on each balanced segment.
- No valid JSON → `[]`.

### `util/clock.ts`

```ts
export const systemClock: Clock;
export class FakeClock implements Clock {
  constructor(startMs?: number);
  now(): number;
  sleep(ms, signal?): Promise<void>;    // resolves when advance() passes its deadline
  advance(ms: number): Promise<void>;   // moves time, resolves due sleepers in order, awaits microtasks
  pendingSleeps(): number;
}
```

Aborting a sleep rejects with an `Error` whose `name` is `"AbortError"`.

### `util/logger.ts`

```ts
export function createLogger(opts: { file?: string; console?: boolean; level?: "debug"|"info"|"warn"|"error" }): Logger & { debug(msg: string, data?: Record<string, unknown>): void };
export const nullLogger: Logger & { debug(...): void };
```

- File output is JSON lines `{at, level, msg, ...data}`.
- Console output is one concise human line: `HH:MM:SS level msg`.

### `util/fs.ts`

`writeJsonAtomic(path, data)` writes a temp file in the same directory, fsyncs it, then renames. Also: `readJson<T>(path): T`, `readJsonOr<T>(path, fallback)`, `appendJsonl(path, obj)`, `readJsonl<T>(path): T[]` (skips corrupt lines), `expandHome(p)`, `ensureDir(p)`, `sha256File(path)`, `sha256(text)`.

### `limits.ts`

```ts
export function parseResetTime(text: string, nowMs: number, timeZone?: string): number | undefined;
export function detectLimitText(text: string, provider: Provider, nowMs: number): LimitInfo | undefined;
export function limitKindFromClaudeType(rateLimitType: string | undefined): LimitKind;
```

**`parseResetTime`** must handle:
- `resets 3:45pm`, `resets 3pm`, `resets at 15:45`
- `Try again at 3:45 PM`, `Try again at Oct 10th, 2026 3:45 PM`
- `resets Oct 10, 3pm`, `resets Oct 10 at 3:45 PM`
- an optional trailing IANA zone in parentheses, e.g. `resets 3pm (Europe/Paris)`, which overrides `timeZone`
- `resets in 2 hours`, `in 45 minutes`, `in 1h 30m`

Rules:
- A time without a date means the next occurrence strictly after `nowMs` in the given zone (default: the process local zone).
- A date without a year means the next occurrence.
- Return epoch ms, or `undefined` if not parseable.
- Implement zone math with `Intl.DateTimeFormat` offsets. No libraries.

**`detectLimitText`**: case-insensitive. Returns `undefined` for unrelated text, such as an ordinary test failure that mentions "limit".

| Pattern | Kind |
|---|---|
| `hit your session limit` / `5-hour limit` | session |
| `hit your weekly limit` | weekly |
| `hit your (opus\|sonnet\|fable\|haiku) limit` | model, with `model` = the lowercased word |
| `hit your usage limit` (Codex) | session if the reset is < 6 h away or unknown, else weekly |
| `extra usage` / `spend limit` / `out of credits` | spend |
| `rate limit` / `429` / `overloaded` / `529` with no "hit your" | throttle |

Include `resetsAt` from `parseResetTime`.

**`limitKindFromClaudeType`**:
- `five_hour` → session
- `seven_day` → weekly
- `seven_day_opus` / `seven_day_sonnet` → model
- `overage` / `seven_day_overage_included` → spend
- anything else → unknown

---

## W1-B: `config.ts`

```ts
export function defaultConfig(): Config;
export function configTemplateYaml(): string;              // commented YAML; loading it yields a config deep-equal to defaultConfig()
export function configPath(): string;                      // $MC_CONFIG, else <home>/config.yaml where home = $MC_HOME or ~/.mission-control
export function loadConfig(path?: string): Config;         // missing file → defaultConfig(); else deep-merge YAML over defaults (arrays replace); expandHome on paths; throws Error listing validateConfig errors
export function validateConfig(c: Config): string[];
export function parseRoleOverride(s: string): RoleOverride; // "engineer=codex" | "engineer=codex:frontier" | "reviewer=claude:standard:high" | "engineer=frontier" (tier only) ; throws on bad input
export function otherFamily(f: Family): Family;
export function resolveFamily(choice: FamilyChoice, relativeTo: Family, profile: Profile): Family; // "other" → otherFamily(relativeTo) when profile.crossFamily, else relativeTo
export function resolveModel(c: Config, family: Family, tier: Tier): ModelRef;  // light → c.light regardless of family
export function inContainer(): boolean;                     // MC_IN_CONTAINER=1 or /.dockerenv exists
export function effectivePermissions(c: Config, containerized?: boolean): { claudeWriteMode: Config["permissions"]["claudeWriteMode"]; codexWriteSandbox: Config["permissions"]["codexWriteSandbox"]; downgraded: boolean };
```

**`defaultConfig()`** (exact values):

| Field | Default |
|---|---|
| `home` | `~/.mission-control` |
| `workspaceRoot` | `~/mc-apps` |
| `families.claude` | `{provider:"claude", frontier:"claude-opus-5-5", standard:"claude-sonnet-5-5"}` |
| `families.codex` | `{provider:"codex", frontier:"gpt-6-astra", standard:"gpt-6.1-sol"}` |
| `light` | `{provider:"claude", model:"claude-haiku-5-5"}` |
| `allowedModels` | the 5 ids above |
| `defaultProfile` | `"mixed"` |
| `profiles.claude` | all four roles `"claude"`, `crossFamily:false` |
| `profiles.codex` | all four roles `"codex"`, `crossFamily:false` |
| `profiles.mixed` | `{architect:"claude", engineer:"codex", test_author:"other", reviewer:"other", crossFamily:true}` |
| `roles` | architect `{frontier,high}`, test_author `{standard,high}`, reviewer `{frontier,high}`, scout `{light,low}` |
| `limits` | `buildMaxTurns:80, otherMaxTurns:40, agentTimeoutMs:45*60_000, verifyTimeoutMs:20*60_000, maxReviewRounds:2, maxGateCRounds:1, maxAgentRunsPerMission:150` |
| `failover` | `{enabled:true}` |
| `pacing` | `{maxFiveHourUtilization:0.97, maxWeeklyUtilization:0.85}` |
| `notify` | `{ntfyUrl:""}` |
| `git` | `{push:false, branchPrefix:"mc"}` |
| `permissions` | `{claudeWriteMode:"bypassPermissions", codexWriteSandbox:"danger-full-access", requireContainerForBypass:true}` |
| `cli` | `{claudeCommand:"claude", codexCommand:"codex", claudeVersion:"2.1.295", codexVersion:"0.162.0"}` |

`ladders.standard`:
1. build standard/medium/same
2. build standard/high/same
3. diagnose
4. build frontier/high/other
5. build frontier/high/same

`ladders.mechanical`:
1. build light/medium/same
2. build standard/medium/same
3. build standard/high/same
4. diagnose
5. build frontier/high/other

**`validateConfig`** rules:
- Every model in `families` and `light` is in `allowedModels`.
- Any model containing `luna` is an error: "Luna models are disabled by user preference".
- `light.provider === "claude"`, unless it is `"mock"` in tests.
- `defaultProfile` exists, and every profile field is valid.
- Ladders are non-empty, and each rung is valid.
- Tiers and efforts are valid. `ultra` is not an effort.
- Utilization thresholds are in (0, 1.5].
- Numeric limits are positive integers.
- `branchPrefix` is a non-empty string without `/`.

**`effectivePermissions`**: when `requireContainerForBypass` is set and not containerized, downgrade `bypassPermissions` → `auto` and `danger-full-access` → `workspace-write`, with `downgraded:true`.

---

## W1-C: `state.ts`

```ts
export function slugify(s: string, maxLen?: number): string;   // lowercase ascii, [a-z0-9-], collapse dashes, trim, default max 40, never empty ("mission")
export class MissionStore {
  constructor(home: string);   // absolute (already expanded)
  readonly home: string;
  createMission(init: { kind: MissionKind; title: string; request: string; repoPath: string; baseBranch: string; profile: string; roleOverrides?: RoleOverride[]; nowMs: number }): Mission;
  load(id: string): Mission;
  save(m: Mission, nowMs?: number): void;          // sets updatedAt, atomic write to <home>/missions/<id>/mission.json
  list(): Mission[];                               // all missions sorted by createdAt asc; skips unreadable dirs
  missionDir(id: string): string;
  logsDir(id: string): string;                     // created on demand
  reportPath(id: string): string;                  // <missionDir>/report.md
  appendEvent(missionId: string, type: string, data?: Record<string, unknown>, nowMs?: number): void;
  readEvents(missionId: string): MissionEvent[];
  appendUsage(rec: UsageRecord): void;             // <home>/usage.jsonl
  readUsage(sinceMs?: number): UsageRecord[];
  stopRequested(): boolean;                        // <home>/STOP exists
  requestStop(): void; clearStop(): void;
  acquireLock(): () => void;                       // <home>/mc.lock containing {pid, at}; if held by a LIVE other pid → throw Error("another mc run is active (pid N)"); stale → take over; returns release fn
  worktreesDir(missionId: string): string;         // <home>/worktrees/<missionId>
}
```

**`createMission`** sets these fields:
- `id`: `YYYY-MM-DD-<slug(title)>` (date in local time), with `-2`, `-3`… on collision
- `status`: `"queued"`
- `stage`: `"spec"` for greenfield, `"onboard"` for feature
- `integrationBranch`: `"mc/<id>"`
- empty arrays: `features`, `decisionsNeeded`, `notes`, `baselineFailures`, `roleOverrides` (unless given)
- `baselineBroken: false`, `gateCRounds: 0`, `agentRuns: 0`
- timestamps as ISO strings

---

## W1-D: `git.ts`

The class shells out to `git` through `runProcess`. Every method is async and throws `GitError` (exported, with `.stderr`) on unexpected failure.

```ts
export class GitError extends Error { stderr: string; }
export class Git {
  constructor(opts?: { logger?: Logger; timeoutMs?: number });
  ensureRepo(path: string, opts?: { initialBranch?: string }): Promise<void>;  // mkdir -p; git init -b main if not a repo; set local user.name "Mission Control"/user.email "mission-control@localhost" if unset; create an initial commit (empty, --allow-empty) if HEAD missing
  isRepo(path: string): Promise<boolean>;
  isShallow(repo: string): Promise<boolean>;
  currentBranch(repo: string): Promise<string>;
  headSha(cwd: string, ref?: string): Promise<string>;
  branchExists(repo: string, branch: string): Promise<boolean>;
  ensureBranch(repo: string, branch: string, fromRef: string): Promise<void>;
  addWorktree(repo: string, path: string, branch: string, fromRef: string): Promise<void>;   // if path exists as a registered worktree → remove it first; if branch exists → `git worktree add path branch` (reuse); else `-b branch path fromRef`
  removeWorktree(repo: string, path: string): Promise<void>;  // `worktree remove --force`, then `worktree prune`; tolerant if missing
  isClean(cwd: string): Promise<boolean>;
  commitAll(cwd: string, message: string): Promise<string | null>;   // add -A; commit --no-verify if staged changes; returns new sha or null
  changedFiles(cwd: string, fromRef: string): Promise<string[]>;     // union: diff --name-only fromRef (incl. working tree) + untracked (ls-files --others --exclude-standard); repo-relative, sorted, unique
  diff(cwd: string, fromRef: string, toRef?: string, maxChars?: number): Promise<string>; // unified diff fromRef..(toRef|working tree incl. untracked via intent-to-add-free approach: commit first is the caller's job); truncated with a "[diff truncated: N chars omitted]" marker
  restorePaths(cwd: string, ref: string, paths: string[]): Promise<void>;  // checkout ref -- paths; paths absent at ref are deleted
  resetHard(cwd: string, ref: string): Promise<void>;                // reset --hard ref + clean -fd (keeps ignored files like node_modules)
  merge(cwd: string, source: string, message: string): Promise<{ ok: true; sha: string } | { ok: false; conflict: boolean; error: string }>; // merge --no-ff --no-edit -m message; on conflict: merge --abort
  fastForward(repo: string, branch: string, toRef: string): Promise<void>;   // used to move greenfield main to the integration head; works when branch is checked out in `repo` (merge --ff-only) or not (branch -f)
  checkout(repo: string, branch: string): Promise<void>;
  hasRemote(repo: string, name?: string): Promise<boolean>;
  push(repo: string, branch: string, prefix: string): Promise<{ ok: boolean; error?: string }>; // refuses unless branch starts with `${prefix}/`; never force; returns ok:false error "no remote" when origin missing
  log(cwd: string, range: string, max?: number): Promise<{ sha: string; subject: string }[]>;
}
```

Always run git with `-c core.quotepath=off` and `GIT_TERMINAL_PROMPT=0`. Never open an editor.

---

## W1-E: `verify.ts`

```ts
export class Verifier {
  constructor(opts: { logsDir: string; timeoutMs: number; logger?: Logger; env?: NodeJS.ProcessEnv });
  install(cwd: string, vc: VerifyConfig): Promise<VerifyResult>;          // runs vc.install (ok:true immediately when unset)
  runFull(cwd: string, vc: VerifyConfig, label?: string): Promise<VerifyResult>;
  runTests(cwd: string, vc: VerifyConfig, files: string[], label?: string): Promise<VerifyResult>; // vc.tests with {files} (shell-quoted); falls back to runFull when vc.tests unset or files empty
}
export function stripAnsi(s: string): string;
export function tailLines(s: string, n: number): string;
export function failureSignature(output: string): string;   // "" for empty; else 12-hex sha1 of normalized failure lines
export function hashFiles(cwd: string, paths: string[]): Promise<FrozenFile[]>;
export function checkFrozen(cwd: string, frozen: FrozenFile[]): Promise<{ ok: boolean; modified: string[]; missing: string[] }>;
export interface AntiCheatFinding { file: string; line: string; rule: string; severity: "blocker" | "warn" }
export function scanAntiCheat(diff: string, testGlobs: string[]): AntiCheatFinding[];
export function matchesGlob(path: string, glob: string): boolean;   // supports **, *, ?, and dir/** ; path uses '/'
export function isTestPath(path: string, testGlobs: string[]): boolean;
```

**Running commands:**
- Commands run with `bash -lc "<cmd>"` in `cwd` and `CI=1`, `FORCE_COLOR=0`, plus scrubbed env.
- The timeout is `opts.timeoutMs`.
- Full output is written to `<logsDir>/verify-<label|timestamp>.log`.
- `outputTail` is the last 200 lines, ANSI-stripped.
- `ok` means exit code 0 and not timed out.

**`failureSignature` normalization:**
- Strip ANSI.
- Replace these with placeholders: durations (`\d+(\.\d+)?\s?(ms|s|m)\b`), ISO timestamps / clock times, hex ≥ 8 chars, absolute paths (keep the basename), tmp dirs, ports (`:\d{4,5}\b`), and line:col (`:\d+:\d+` → `:L:C`).
- Keep only lines matching `/(error|fail|failed|assert|expected|received|exception|cannot|undefined|not found|timeout)/i`, up to 60.
- If no line matches, use the last 30 lines.
- The signature is the sha1 of the kept lines, first 12 hex chars.

**`scanAntiCheat`** parses the unified diff (`diff --git a/x b/x`, `+`/`-` lines).

Blockers:
- In **test files**, added lines matching: `.skip(`, `.only(`, `xit(`, `xdescribe(`, `xtest(`, `it.todo(`, `test.todo(`, `test.fixme(`, `@pytest.mark.skip`, `@pytest.mark.xfail`, `expect(true)`, `assert True`, `assert(true)`.
- In test files, a net removal of assertion lines: more than 2 removed lines containing `expect(` / `assert` than added.
- In **any file**, added lines changing test discovery: `testIgnore`, `exclude:` inside `vitest`/`playwright`/`jest` config files, `--passWithNoTests`, `passWithNoTests: true`.

Warnings:
- Added `@ts-nocheck`, `eslint-disable`, `istanbul ignore`.

---

## W1-F: `schemas.ts`, `prompts.ts`, `prompts/*.md`, `stacks/nextjs.md`

### `schemas.ts`

```ts
export const SCHEMAS: {
  spec: JsonSchema; gate: JsonSchema; onboard: JsonSchema; init: JsonSchema; testAuthor: JsonSchema;
  build: JsonSchema; review: JsonSchema; diagnosis: JsonSchema; contextPack: JsonSchema; failureDigest: JsonSchema; reportProse: JsonSchema;
};
export type SchemaName = keyof typeof SCHEMAS;
export function validateOutput<T>(schema: JsonSchema, value: unknown): { ok: true; value: T } | { ok: false; errors: string };  // Ajv (allErrors, strict:false), compiled schemas cached by identity
export function assertStrictCompatible(schema: JsonSchema): void;
export function normalizeVerifyConfig(v: { install: string | null; full: string; tests: string | null; testGlobs: string[] }): VerifyConfig; // null → undefined
```

The schemas mirror the output interfaces in `types.ts`. Within the schemas:
- `VerifyConfig.install` and `VerifyConfig.tests` are `string|null`.
- `Finding.file` and `Finding.suggestedTest` are `string|null`.
- `BuildOutput.testDispute` is `{file, reason} | null`.
- Spec features use the `SpecFeature` shape, with `kind` enum and `deps` an array of strings.

### `prompts.ts`

Every builder is a pure function that returns a string. Briefs should be compact and high-signal, using markdown headings.

```ts
export function packageRoot(): string;               // directory containing package.json (works from src/ and dist/)
export function loadRolePrompt(role: Role): string;  // prompts/<role>.md
export function loadStack(name?: string): string;    // stacks/<name>.md, default "nextjs"
export function truncateMiddle(s: string, maxChars: number): string;
export function formatFileList(paths: string[], max?: number): string;  // default max 1500 entries, notes omitted count
export function specPrompt(m: Mission, stackDoc: string | null, revise?: { previous: SpecOutput; issues: string[] }): string;
export function gateAPrompt(m: Mission): string;
export function onboardPrompt(m: Mission, fileList: string[]): string;
export function initPrompt(m: Mission, stackDoc: string, failure?: { outputTail: string; attempt: number }): string;
export function testAuthorPrompt(m: Mission, f: Feature, ctx: { fileList: string[]; amendReason?: string; previousTestFiles?: string[]; vacuous?: boolean }): string;
export function buildPrompt(m: Mission, f: Feature, ctx: {
  rung: number; fileList: string[]; contextPack?: ContextPackOutput | null; hint?: string | null;
  lastFailure?: { outputTail: string; digest?: FailureDigestOutput | null; antiCheat?: string[]; frozenViolations?: string[] } | null;
  reviewFindings?: Finding[] | null;
}): string;
export function reviewPrompt(m: Mission, f: Feature, ctx: { diff: string; verifyTail: string }): string;
export function diagnosisPrompt(m: Mission, f: Feature, ctx: { lastOutputTail: string; diff: string; dispute?: { file: string; reason: string } | null }): string;
export function gateCPrompt(m: Mission, ctx: { diff: string; verifyTail: string; features: Feature[] }): string;
export function contextPackPrompt(m: Mission, f: Feature, fileList: string[]): string;
export function failureDigestPrompt(outputTail: string): string;
export function reportProsePrompt(m: Mission, facts: string): string;
```

**Size caps:**
- diffs: 60 000 chars
- output tails: 15 000 chars
- file lists: 1 500 entries
- scout prompts: under 250 000 chars total, so Haiku stays in its ≤100K-token price band

**What each brief must include:**
- **All briefs:** the mission title and the user's request.
- **Feature briefs:** feature id, title, story, acceptance criteria, `spec.uiContract`, and the frozen test file paths. The text "**You must not modify these files**" appears for engineers.
- **`buildPrompt`:** the verify commands the engineer may run (`m.verify.tests` with files, `m.verify.full`).

### `prompts/*.md` (role system prompts, provider-neutral, ≤ ~60 lines each)

- **architect.md**
  - Plan small, independently testable features. Each should fit one focused session (≈ ≤ 300 changed lines). The first feature is the core user flow.
  - Acceptance criteria are observable behavior (UI or HTTP).
  - Write a `uiContract` (routes, visible labels, `data-testid`s) that test authors and engineers share.
  - No external paid services or API keys unless the request provides them.
  - Record every assumption. Write a plain-language summary for a non-programmer.
  - Mark narrow boilerplate features `kind:"mechanical"`.
  - For gates and diagnosis: be decisive and concrete.
- **test_author.md**
  - Write acceptance tests only, only under the test directories (`testGlobs`).
  - Test behavior through public interfaces, using the uiContract selectors.
  - Tests must fail now and pass once the feature is correctly implemented. Deterministic: no arbitrary sleeps, no network.
  - Don't test implementation details. Don't mock the subject under test. Keep them fast.
  - Return the exact file list.
- **engineer.md**
  - Implement exactly the assigned feature. Follow AGENTS.md.
  - Never modify the frozen test files, never skip or weaken tests, never change test discovery config.
  - Run the given test command yourself and iterate until green, then run the full verify.
  - If a frozen test is genuinely wrong, finish what you can and report `testDispute`, explaining why.
  - Keep changes focused. No new external services.
  - The orchestrator commits, so don't run `git commit`/`push`, change branches or rewrite history.
- **reviewer.md**
  - Read-only. Check spec compliance first, then correctness, security (injection, authz, secrets), data loss and error handling.
  - Every finding is concrete: file, what's wrong, and a suggested test.
  - Severity: blocker = feature broken / security hole / data loss; major = likely bug; minor = style or nit.
  - Approve when there is no blocker or major. Don't nitpick. Don't propose rewrites.
- **scout.md**
  - A fast helper doing one bounded task. Answer only with the requested JSON. Be terse and exact.

### `stacks/nextjs.md`: the house stack for greenfield apps

The initializer reads this doc. It must specify:
- **Stack:** Next.js (latest stable, App Router, TypeScript, `src/` dir), Tailwind CSS, ESLint.
- **Persistence:** SQLite via `better-sqlite3` + Drizzle ORM. The DB file goes in `./data/app.db` (gitignored). Migrations or push run on start.
- **Auth when needed:** local email + password with `bcryptjs`, plus httpOnly cookie sessions stored in SQLite.
- **Tests:** Vitest (`tests/unit/**`), Playwright (`tests/e2e/**`, chromium only).
  - `webServer` runs `npm run build && npm run start -- -p 3100` (or `next dev -p 3100` when faster), using a dedicated test DB file.
  - Set `screenshot: "on"`, `outputDir: "test-results"`, `reporter: "line"`.
- **Required package.json scripts:** `dev`, `build`, `start`, `lint`, `typecheck` (`tsc --noEmit`), `test:unit`, `test:e2e`, `verify` (lint && typecheck && test:unit && test:e2e).
- **`scripts/mc-test.mjs <files…>`:** routes files under `tests/unit/` to `vitest run <files>` and files under `tests/e2e/` to `playwright test <files>`. It runs both groups and exits non-zero if either fails, or when a given file doesn't exist.
- **VerifyConfig to return:**

  ```json
  {"install":"npm install","full":"npm run verify","tests":"node scripts/mc-test.mjs {files}","testGlobs":["tests/**"]}
  ```

- **AGENTS.md** (short, table-of-contents style): commands, folder layout, test conventions, the uiContract, and "do not edit tests/ unless you are the test author".
- **A smoke e2e test** that the home page renders.
- **Playwright browsers:** `npx playwright install chromium` is NOT needed inside the provided container (browsers are preinstalled); otherwise run it during init.

---

## W1-G: `report.ts`, `notify.ts`

```ts
export function buildReportFacts(m: Mission, usage: UsageRecord[]): string; // plain text facts: features with status + reasons, assumptions, decisions, open findings, totals
export function usageSummary(usage: UsageRecord[]): { byModel: { provider: Provider; model: string; runs: number; inputTokens: number; outputTokens: number; estCostUsd: number }[]; totalRuns: number; limitedRuns: number };
export function howToRun(m: Mission): string[];   // greenfield nextjs: ["cd <repoPath>", "npm install", "npm run dev", "open http://localhost:3000"]; feature: ["cd <repoPath>", "git checkout <integrationBranch>", ...]
export function renderReport(m: Mission, opts: { prose?: ReportProseOutput | null; usage: UsageRecord[]; screenshots: string[]; generatedAt: string }): string;
export function collectScreenshots(fromDir: string, destDir: string, max?: number): Promise<string[]>; // recursively finds *.png under fromDir/test-results and fromDir/playwright-report, copies (flattened, unique names) to destDir, returns dest paths (max 12, newest first)
```

**Report audience: a non-programmer.** Lead with:
1. a one-line status: Done / Partly done / Stopped, plus features done/total
2. the narrative (prose, or a template fallback when prose is null)
3. "What you can do now"
4. "How to try it" (numbered commands)
5. "Needs your decision"
6. a features table (✅ / ⛔ with a plain reason)
7. "Choices I made for you" (the assumptions)
8. "Review notes" (open findings)
9. "Usage" (per model)
10. a "Technical details" section at the end: branches, commits, log paths, mission id

Screenshots are embedded with relative markdown image links.

```ts
export interface Notifier { notify(title: string, message: string, opts?: { priority?: "default" | "high"; tags?: string[] }): Promise<void>; }
export function createNotifier(ntfyUrl: string | undefined, logger?: Logger, fetchImpl?: typeof fetch): Notifier;
```

The ntfy request is `POST url`, with the body set to the message and headers `Title`, `Priority` (default 3, high 4) and `Tags`. Use a 10 s timeout. The notifier **never throws**: it logs a warning instead. It is a no-op when the URL is empty.

---

## W1-H: container and setup docs

- **`docker/Dockerfile`:**
  - Base `mcr.microsoft.com/playwright:v<X>-noble`, pinned to the current stable Playwright version from `npm view playwright version`; it includes Node and browsers.
  - `npm i -g @anthropic-ai/claude-code@2.1.295 @openai/codex@0.162.0`.
  - Runs as the non-root `pwuser` (rename the home appropriately), with `ENV MC_IN_CONTAINER=1`.
  - Copies the repo and runs `npm ci && npm run build && npm link`.
  - Workdir `/home/pwuser`. Entrypoint `docker/entrypoint.sh`.
- **`docker/entrypoint.sh`:** checks that `~/.claude` and `~/.codex` are writable and prints a short hint when not logged in. Then `exec "$@"`; the default command is `mc --help`.
- **`scripts/mc-docker.sh`:** the wrapper the user runs from WSL.
  - `mc-docker.sh build` builds the image `mission-control:local`.
  - `mc-docker.sh login-claude` runs `claude` interactively once (`/login`).
  - `mc-docker.sh login-codex` runs `codex login --device-auth`.
  - `mc-docker.sh <mc args…>` runs `docker run --rm -it` with named volumes `mc-claude:/home/pwuser/.claude`, `mc-codex:/home/pwuser/.codex`, `mc-home:/home/pwuser/.mission-control`, and a bind mount `$HOME/mc-apps:/home/pwuser/mc-apps`, plus `--init` and `--shm-size=1g`.
  - Also `mc-docker.sh shell`.
- **`docs/setup-windows.md`:** step-by-step for a **non-programmer** on Windows 11. Every step gives the exact command to paste and what you should see.
  1. Enable WSL2 + Ubuntu.
  2. Install Docker Desktop (WSL2 backend, enable Ubuntu integration).
  3. In Ubuntu: `git clone`, then `scripts/mc-docker.sh build`.
  4. Log in to both (`login-claude`, `login-codex`; device-code login must be enabled in ChatGPT security settings).
  5. `mc doctor` and `mc doctor --live`.
  6. Install the ntfy app on the iPad, pick a secret topic, and put the URL in the config (`mc config set notify.ntfyUrl …`, or edit `~/.mission-control/config.yaml` via `mc-docker.sh shell`).
  7. Windows power settings: never sleep when plugged in.
  8. Queue work: `mc new "…"`.
  9. Before bed: `mc run --until 07:00`. Optionally schedule it with Windows Task Scheduler at 23:00, calling `wsl.exe -d Ubuntu -- bash -lc "~/Mission-control/scripts/mc-docker.sh run --until 07:00"` (non-interactive: no `-it`).
  10. Morning: read the ntfy notification and open the report; try the app.
  11. Troubleshooting: limits, login expired, `mc stop`.

  Also explain plainly what the container protects against and what it doesn't. Agents can read the mounted CLI logins, so never mount real secrets or SSH keys.

---

## W2-A: `runners/claude.ts`

```ts
export interface ClaudeRunnerOptions { command?: string; logger?: Logger; writeMode: "bypassPermissions" | "acceptEdits" | "auto"; env?: NodeJS.ProcessEnv; tmpDir?: string; }
export class ClaudeRunner implements AgentRunner {
  readonly provider: "claude";
  constructor(opts: ClaudeRunnerOptions);
  buildArgs(job: AgentJob, systemPromptFile: string): string[];
  run(job: AgentJob, opts?: RunOptions): Promise<RunResult>;
}
```

**Args:**

```
-p --output-format stream-json --verbose --model <job.model> --effort <job.effort> --max-turns <n> --append-system-prompt-file <file>
```

then:
- `[--json-schema <JSON.stringify(schema)>]`
- `[--resume <id>]`
- workspace-write: `--permission-mode <writeMode>`
- read-only: `--permission-mode dontAsk --tools Read,Grep,Glob`
- `noTools`: `--tools ""`
- always `--permission-prompts none`

**Running:**
- The prompt goes on stdin. The system prompt is written to a temp file, deleted afterwards.
- `env = scrubEnv(opts.env ?? process.env)`.
- Tee stdout to `job.logFile`.

**Parsing** (each stdout line through `parseJsonLine`):
- `system/init`: emit `started` with session_id.
- `assistant`: text → `progress` (first 300 chars); tool_use → `progress` as `"<Tool> <file_path|command|pattern>"`.
- `rate_limit_event`:
  - For each window in `unifiedWindows` and the top-level `utilization`, emit `utilization` (`resetsAt`×1000).
  - If `status === "rejected"`, emit `limit` with kind `limitKindFromClaudeType(rateLimitType)` and `resetsAt`, and remember it.
- `system/api_retry`: emit `progress` `"API retry n/m (status)"`.
- `result`: keep it.

**Outcome:**
1. A rejected rate-limit event was seen, or the `result` text / errors / stderr matches `detectLimitText` → `limited` (prefer the event's `resetsAt`, else parsed text).
2. `result.subtype==="success" && !is_error`:
   - Without an outputSchema → `ok`.
   - With one: take `structured_output`, else try `JSON.parse(result)`, else the last `{…}` in the result. Validate with `validateOutput`. Valid → `ok` + structured; invalid → `failed` ("invalid structured output: …").
3. `is_error` and (`api_error_status` 401/403, or text matching `/(not logged in|please run \/login|authentication|unauthorized|oauth|invalid api key)/i`) → `auth`.
4. `error_max_turns` → `failed` ("max turns reached").
5. Other `is_error` → `failed` with the error text.
6. No result event:
   - timed out → `timeout`
   - aborted → `aborted`
   - `spawnError` → `crashed` ("claude CLI not found or failed to start: …")
   - stderr matching the auth pattern → `auth`
   - otherwise `crashed`, with the stderr tail

**Usage** comes from the `result` event: `total_cost_usd` → `estCostUsd`, `num_turns` → `turns`. Emit a `usage` event.

**Tests:** a fake `claude` executable that echoes canned NDJSON chosen by an env var, covering success + structured, invalid structured, glued lines, rate-limit rejected, limit text in result, auth, max turns, crash, timeout, and abort. Also assert the args for read-only, write and noTools, that the prompt arrives on stdin, and that `ANTHROPIC_API_KEY` is scrubbed: the fake prints its env.

## W2-B: `runners/codex.ts`

```ts
export interface CodexRunnerOptions { command?: string; logger?: Logger; writeSandbox: "danger-full-access" | "workspace-write"; env?: NodeJS.ProcessEnv; tmpDir?: string; }
export class CodexRunner implements AgentRunner {
  readonly provider: "codex";
  constructor(opts: CodexRunnerOptions);
  buildArgs(job: AgentJob, files: { schemaFile?: string; lastMessageFile: string }): string[];
  run(job: AgentJob, opts?: RunOptions): Promise<RunResult>;
}
```

**Args:**

```
exec --json --skip-git-repo-check -C <cwd> -m <model> -c model_reasoning_effort="<effort>" -c approval_policy="never" -s <sandbox> [--output-schema <schemaFile>] -o <lastMessageFile> -
```

then:
- workspace-write job: `-s <writeSandbox>`. When that is `workspace-write`, also `-c sandbox_workspace_write.network_access=true`.
- read-only job: `-s read-only`.
- A `max` effort stays `max`. Codex has no turn limit flag: rely on the timeout.
- `resumeSessionId` → `exec resume <id> -` with the same `-c`/`-m` flags. The sandbox flag isn't accepted on resume; pass `-c sandbox_mode="…"` instead.

**Running:**
- **Stdin is the full prompt:** the system prompt, then `\n\n---\n\n`, then the job prompt. Close stdin.
- `env = scrubEnv(...)`.

**Parsing:**
- `thread.started` → `started` (sessionId = thread_id).
- `item.completed`:
  - `agent_message` → remember its text as the final text, and emit `progress`.
  - `command_execution` → `progress` `"$ <command>"`.
  - `file_change` → `progress`.
- `error` events → `progress` (they are retries); keep the last one.
- `turn.completed` → usage: inputTokens = `input_tokens` − `cached_input_tokens` (Codex counts cached input inside `input_tokens`; Usage follows Claude's meaning), outputTokens = `output_tokens` alone (it already includes `reasoning_output_tokens`, which is a breakdown: adding it would count reasoning twice), `cached_input_tokens` → cacheRead, `cache_write_input_tokens` → cacheWrite.
- `turn.failed` → remember `error.message`.

**Outcome:**
1. `turn.failed`, or exit≠0 with text (failure message, last error, stderr) matching `detectLimitText` → `limited`.
2. Auth pattern `/(401|unauthorized|not logged in|login required|authentication)/i` → `auth`.
3. Exit 0 and `turn.completed`:
   - Without a schema → `ok`.
   - With one: read the `-o` file (fall back to the final agent_message), `JSON.parse`, validate. Valid → `ok`; invalid → `failed`.
4. `turn.failed` otherwise → `failed`.
5. Timeout / abort / spawnError → as for Claude.
6. Otherwise → `crashed`.

**Tests:** a fake `codex` executable covering the same scenarios. Assert that stdin is consumed and closed: the fake must hang if stdin is left open, so the test proves we close it.

## W2-C: `runners/mock.ts`, `runners/index.ts`

```ts
export interface MockBehavior { outcome?: RunOutcome; structured?: unknown; text?: string; limit?: Partial<LimitInfo>; usage?: Partial<Usage>; delayMs?: number;
  edit?: (cwd: string, job: AgentJob) => void | Promise<void>; }
export type MockScript = (job: AgentJob, callIndex: number) => MockBehavior | Promise<MockBehavior>;
export class MockRunner implements AgentRunner {
  constructor(script: MockScript, opts?: { provider?: Provider });   // provider default "mock"; tests may impersonate "claude"/"codex"
  readonly provider: Provider;
  readonly calls: AgentJob[];
  run(job: AgentJob, opts?: RunOptions): Promise<RunResult>;
}
export function createRunners(c: Config, opts: { logger?: Logger; containerized?: boolean }): Record<"claude" | "codex", AgentRunner>;
```

**MockRunner behavior:**
- Applies `edit` (when the access is read-only, it still runs it, so tests can catch read-only violations).
- With `outcome:"limited"`, emits a `limit` event and returns `limit` filled: provider = this provider, kind default `"session"`.
- When the outcome is ok and the job has an outputSchema, it validates `structured` with `validateOutput`. Invalid → `failed`, so dispatcher tests catch schema drift.
- Honors abort.

**`createRunners`** uses `effectivePermissions`.

## W2-D: `quota.ts`, `executor.ts`

```ts
export type ProviderState =
  | { status: "ok" }
  | { status: "limited"; kind: LimitKind; until: number; raw: string }
  | { status: "auth"; raw: string };
export class QuotaGovernor {
  constructor(opts: { clock: Clock; config: Config; statePath?: string; logger?: Logger });  // statePath: persist/restore JSON so a restart remembers limits
  recordLimit(info: LimitInfo): void;
  recordAuthFailure(provider: Provider, raw: string): void;
  clearAuth(provider: Provider): void;
  recordUtilization(u: Utilization): void;
  recordSuccess(provider: Provider): void;
  isAvailable(provider: Provider, model?: string): boolean;
  availableAt(provider: Provider, model?: string): number | null;    // now if available; epoch ms when it frees up; null if blocked on auth
  state(provider: Provider): ProviderState;
  snapshot(): { providers: Record<string, ProviderState>; modelBlocks: Record<string, number>; utilization: Utilization[] };
}
```

**Limit rules:**
- **throttle:** cooldown with exponential backoff per provider: 60 s, 120 s, 240 s… capped at 15 min. It resets on `recordSuccess`.
- **session / weekly / spend / unknown:** limited until `resetsAt`. If unknown: session → now+60 min, weekly → now+6 h, spend → now+12 h, unknown → now+30 min.
- **model:** a block for that model only (match `model` as a substring of the model id, e.g. "opus" blocks `claude-opus-5-5`), until `resetsAt` (else +6 h).
- **Pacing:** if the latest utilization for window `five_hour` ≥ `maxFiveHourUtilization` → unavailable until that window's `resetsAt`. The same applies to `seven_day` ≥ `maxWeeklyUtilization`.
- Expired limits clear themselves lazily.

```ts
export class AuthUnavailableError extends Error {}  // every candidate provider needs a human login
export class DeadlineError extends Error { constructor(public until: number) }
export class StopRequestedError extends Error {}
export interface ExecRequest {
  missionId: string; role: Role; label: string;
  family: Family; tier: Tier; effort: Effort;
  allowFailover: boolean;     // honored only if config.failover.enabled
  optional?: boolean;         // if no candidate is available right now → return {skipped:true} (never waits)
  cwd: string; systemPrompt: string; prompt: string; outputSchema?: JsonSchema;
  access: Access; noTools?: boolean; maxTurns: number; timeoutMs?: number;
}
export interface ExecResult { skipped: boolean; result: RunResult | null; provider: Provider | null; model: string | null; family: Family | null; }
export class RoleExecutor {
  constructor(deps: { config: Config; runners: Partial<Record<Provider, AgentRunner>>; quota: QuotaGovernor; clock: Clock; store: MissionStore; logger: Logger;
    signal?: AbortSignal; deadline?: number; onWaiting?: (until: number, reason: string) => void; stopCheck?: () => boolean });
  exec(req: ExecRequest): Promise<ExecResult>;
}
```

**Candidates, in order** (each is `{family, tier}` → `resolveModel`):
- `light`: the light model. Then, if not optional, `(family, standard)` and, when failover is allowed, `(other, standard)`.
- Otherwise: `(family, tier)`, then `(other, tier)` when failover is allowed.

**Loop:**
1. Pick the first candidate with a runner and `quota.isAvailable(provider, model)`.
2. If there is none:
   - optional → return `{skipped:true}`
   - every candidate `availableAt === null` → throw `AuthUnavailableError`
   - otherwise `until = min(availableAt) + 45 s` jitter-free. If `deadline` and `until > deadline` → throw `DeadlineError`.
   - Call `onWaiting`, then `clock.sleep(until-now, signal)`. Wake every ≤ 60 s to check `stopCheck` and throw `StopRequestedError`. Repeat.
3. Build the `AgentJob`:
   - `id = <label>-<n>`
   - `logFile = store.logsDir(missionId)/<id>.ndjson`
   - timeout: `req.timeoutMs ?? config.limits.agentTimeoutMs`
4. Run it with `onEvent`, routing `limit` → `quota.recordLimit`, `utilization` → `quota.recordUtilization`, and `progress` → `logger.debug`.
5. Append a `UsageRecord` and a `run.end` mission event `{label, provider, model, outcome, durationMs}`.
6. Handle the outcome:
   - `limited` → `recordLimit` (if not already recorded by the event), then loop again; the attempt is not counted.
   - `auth` → `recordAuthFailure`, then loop.
   - `aborted` → throw `StopRequestedError`.
   - Anything else → `recordSuccess` when ok, and return.

Check `stopCheck` before each run.

---

## W3-A: `dispatcher.ts`

```ts
export interface DispatcherDeps {
  config: Config; store: MissionStore; git: Git; executor: RoleExecutor; quota: QuotaGovernor;
  clock: Clock; logger: Logger; notifier: Notifier;
  verifierFor: (missionId: string) => Verifier;
  stopCheck: () => boolean; deadline?: number;
  stackName?: string;                      // default "nextjs"
}
export class Dispatcher {
  constructor(deps: DispatcherDeps);
  runMission(id: string): Promise<Mission>;  // resumable: drives from the persisted stage until complete/stopped/failed; saves after EVERY state change
}
```

Helpers: `roleFamily(m, role, relativeTo?)` applies `m.roleOverrides` over the profile, and `assign(m, role)` returns `{family, tier, effort}`. Overrides for role engineer change the ladder's base family and/or force a tier.

The **engineer base family** `E` = override family, else `profile.engineer`.

**Guards before every agent run:**
- `stopCheck()` → set status `stopped`, save, return.
- `m.agentRuns ≥ maxAgentRunsPerMission` → note, status `partial`, go to finalize.
- `DeadlineError` / `StopRequestedError` from the executor → status `stopped`, save, return. Resume later continues the same stage.
- `AuthUnavailableError` → status `failed`, `decisionsNeeded.push("Log in again: …")`, notify high, return.

Increment `m.agentRuns` per executed (non-skipped) run.

**Worktrees:**
- integration: `<store.worktreesDir(id)>/_integration` on `m.integrationBranch`
- unit: `<worktreesDir>/<featureId>` on branch `<integrationBranch>-<featureId>`, from the integration head

Git refs cannot nest under an existing ref name, so use `mc/<id>--<fid>` for unit branches.

### Stages

**`onboard`** (feature missions):
1. If the repo is not a git repo, or is shallow → `failed` with a plain decision.
2. Ensure the integration branch from `baseBranch`, plus the integration worktree.
3. Architect (`assign`, read-only, cwd = integration worktree, outputSchema `onboard`) → `m.verify = normalizeVerifyConfig(out.verify)`.
4. `install` + `runFull` → when not ok: `baselineBroken = true`, `baselineFailures = [tail summary ≤ 20 lines]`, plus a note.
5. → `spec`.

**`spec`:**
1. Architect (read-only; `noTools` when greenfield, because the repo doesn't exist yet), `specPrompt` with the stack doc for greenfield → `SpecOutput`.
2. **Semantic validation:** 1–25 features; unique kebab ids; deps exist; no cycles. On failure: retry once with the errors appended to the request, then `failed`.
3. Store the spec. `m.features` = spec features with `status pending, rung 0, attempts [], frozenTests [], reviewRounds 0, openFindings []`. Append assumptions to the notes.
4. → `gate_a`.

**`gate_a`:**
1. Reviewer family = `resolveFamily(profile.reviewer, architectFamily)`, at `roles.reviewer` tier and effort, read-only `noTools` → `GateOutput`.
2. `revise` → architect re-spec with the issues (once). Accept the result if valid; otherwise keep the original spec and note the issues.
3. → `init` (greenfield) or `features`.

**`init`** (greenfield only):
1. `repoPath = <workspaceRoot>/<slug(spec.appName)>` (with `-2`… if it exists and isn't ours), then `git.ensureRepo` (main + initial commit).
2. Integration branch + worktree.
3. Treat it as a pseudo-feature `_init` running ladder `standard`, but without a test author: engineer (workspace-write in the integration worktree, `initPrompt`) → `InitOutput` → `m.verify`.
4. `install` + `runFull`.
   - Pass → commit `"chore: scaffold app"`, then → `features`.
   - Fail → next rung, with the tail. Diagnose rungs are skipped for init.
   - Exhausted → `failed` + notify.

**`features`:**
- Loop: pick the first feature (spec order) whose status ∉ {done, blocked, skipped} and whose deps are all `done`.
  - A dep `blocked`/`skipped` → mark it `skipped` with "waiting on X, which was blocked".
  - Nothing runnable → `gate_c`.
- A feature walks `pending → testing → building → reviewing → done`.
- Every sub-step persists, so a resume continues where it was. Whenever a unit's worktree is missing on resume, recreate it from its branch.
- Steps in order:
  1. **pending:**
     - Add the unit worktree (from the integration head) and set `f.branch`/`f.worktree`.
     - Run `install`.
     - Set `testsCommit` = the base sha. → `testing`.
  2. **testing:** test author, with family `resolveFamily(profile.test_author, E)` at `roles.test_author`, workspace-write in the unit worktree, `testAuthorPrompt` → `TestAuthorOutput`.
     - Changed files that are not test paths → restore them from base, and note it.
     - `testFiles` = output files ∩ changed test paths.
     - Empty → retry once. Then continue without frozen tests (note it).
     - `runTests(testFiles)` must **fail** (red). If it passes → retry once with `vacuous:true`; the second time, accept with a note.
     - Commit `"test(<fid>): acceptance tests"`. Set `testsCommit`, then `frozenTests = hashFiles(testFiles)`. → `building`.
  3. **building:** `rung = ladder[f.rung]`, where the ladder is `mechanical` when `kind === "mechanical"`, else `standard`. Undefined → block with "tried every escalation step".
     - **`diagnose`:** architect, read-only in the unit worktree, `diagnosisPrompt` (last attempt tail + diff from `testsCommit`) → `DiagnosisOutput`.
       - `retry_with_hint` → `f.hint`.
       - `amend_tests` → re-run the test author with `amendReason` (step 2 logic, replacing the frozen tests), then `resetHard` to the new `testsCommit`.
       - `block` → blocked.
       - In all cases `rung++`. If the previous attempt's code is being abandoned (`retry_with_hint`), also `resetHard(testsCommit)`.
     - **`build`:**
       - Family = rung.family `same` → E, `other` → `resolveFamily("other", E, profile)`. Tier, effort and model from the rung.
       - On the first build attempt only: a scout context pack (optional, read-only noTools, `contextPackPrompt` with the file list).
       - Engineer: workspace-write, `buildPrompt` with the last failure, hint and contextPack; `maxTurns = buildMaxTurns`.
       - Then `commitAll("wip(<fid>): attempt <n>")`.
       - `checkFrozen`: on violations, `restorePaths(testsCommit, modified+missing)` and commit `"revert frozen test edits"`. Record the violations; this counts as a failure **unless** verify then passes. Restoring makes the cheat moot.
       - `scanAntiCheat(diff testsCommit..HEAD)`: blockers → failure.
       - Agent outcome not ok (failed/timeout/crashed) → record the attempt as `error`, `rung++`, continue. Still verify: partial work may pass.
       - **Verify:** `runTests(frozen paths)` (when there are frozen tests), then `runFull` unless `baselineBroken`.
         - Both ok and no anticheat blockers → attempt `pass`, set `passingCommit` and `builtBy = family`, → `reviewing`.
         - Otherwise:
           - optional scout `failureDigest`
           - attempt `fail` with signature
           - if this signature equals the previous attempt's signature and the next rung is not `diagnose`, jump `f.rung` to the next diagnose rung index if one exists ahead, else `rung++`
           - when the build output carries a `testDispute`, the next step is a diagnose (run it now, with the dispute)
  4. **reviewing:**
     - Reviewer family = `resolveFamily(profile.reviewer, f.builtBy)`, at `roles.reviewer`, read-only (tools allowed), cwd unit worktree, `reviewPrompt` with diff `base..HEAD` + verify tail → `ReviewOutput`.
     - Blocking findings = severity blocker/major.
       - None → merge.
       - Some, with `reviewRounds < maxReviewRounds` → engineer fix: same family/tier/effort as the passing attempt, `buildPrompt` with `reviewFindings`. Then commit, frozen + anticheat checks, verify.
         - Green → `passingCommit` = HEAD, `reviewRounds++`, review again.
         - Red → `resetHard(passingCommit)`, keep the findings open, merge.
       - Rounds exhausted → keep the findings in `openFindings` and merge.
     - Minor findings always go to `openFindings`.
  5. **merge:**
     - In the integration worktree: `git.merge(unitBranch, "feat(<fid>): <title>")`.
       - ok → `f.commit`, status `done`, remove the unit worktree.
       - conflict → blocked ("merge conflict").
     - Blocked features: remove the worktree, keep the branch, set `blockedReason` (plain language).

**`gate_c`:**
1. No done features → `finalize`.
2. `install` + `runFull` in the integration worktree.
3. Reviewer: frontier tier at `roles.reviewer` effort; family = other than the family that built most done features (ties → reviewer profile default). Read-only tools, `gateCPrompt` with the diff (mission base sha → integration HEAD) + verify tail → `ReviewOutput`.
4. If (blockers/majors or verify red) and `gateCRounds < maxGateCRounds`:
   - append one new feature `gate-c-fix-<n>` (kind standard, acceptance = finding descriptions and/or "full verification passes", deps [])
   - `gateCRounds++` → `features`
5. Otherwise record the findings as notes → `finalize`.

**`finalize`:**
1. Greenfield: `fastForward(repoPath, "main", integrationBranch)` and check out main in the repo, so `cd repo && npm run dev` just works. Keep the integration branch too.
2. If `config.git.push`: push the integration branch.
3. Status:
   - every feature `done` and the final verify ok → `done`
   - otherwise → `partial`
   - keep `stopped` / `failed` if already set
4. **Report:**
   - `facts = buildReportFacts`
   - prose = optional scout (`reportProsePrompt`)
   - screenshots = `collectScreenshots(integrationWorktree, missionDir/screenshots)`
   - Write `renderReport` to `store.reportPath(id)`.
5. Notify, e.g. `"<title>: done (5/6 features)"`, with the report path. Priority high if failed or partial.
6. Remove the integration worktree only when the status is done.
7. stage `complete`.

**Errors:** an unexpected exception inside a feature step → log it, block that feature with `"internal error: <msg>"`, and continue. An exception in a mission-level stage → status `failed`, note it, notify, return. Never leave the mission `running`.

**Events:** append a mission event on every stage change, feature status change, attempt, verify and limit wait.

## W3-B: `run.ts`, `doctor.ts`, `cli.ts`

```ts
export interface NightOptions { until?: string /* "HH:MM" local */ ; missionId?: string; profile?: string; roleOverrides?: RoleOverride[]; config?: Config; clock?: Clock; logger?: Logger; runners?: Partial<Record<Provider, AgentRunner>> /* tests */ }
export function parseUntil(hhmm: string, nowMs: number): number;   // next occurrence of HH:MM after now (local)
export async function runNight(opts: NightOptions): Promise<{ missions: Mission[]; summaryPath: string }>;
```

**`runNight`:**
1. Load the config, create the store, and `acquireLock`. Clear STOP at start.
2. Install a SIGINT/SIGTERM handler that requests a graceful stop. The second signal exits.
3. Build the quota (statePath `<home>/quota.json`), runners, executor and dispatcher.
4. Run the missions (status in queued/running/waiting/stopped, or the given id) sequentially, in creation order.
5. Write `<home>/reports/night-<date>.md`, linking each mission report, and copy each mission report to `<home>/reports/latest.md` (the last one).
6. Notify "Night finished". Release the lock.

```ts
export interface DoctorCheck { name: string; ok: boolean; detail: string; fix?: string; severity: "error" | "warn" }
export async function runDoctor(opts: { config?: Config; live?: boolean }): Promise<DoctorCheck[]>;
```

**Doctor checks:**
- Node ≥ 22.12, `git` present and its user identity.
- `claude --version` vs pinned version; `codex --version` vs pinned version.
- `codex login status`; for Claude login: `~/.claude/.credentials.json` exists, or `claude auth status` exits 0.
- **No API key vars set (error, with explanation).**
- In container (warn if not, and explain the downgrade).
- Config valid.
- Configured codex models present in `codex debug models` output.
- workspaceRoot and home writable.
- ntfy URL set (warn).
- Disk free ≥ 5 GB (warn).
- `--live`: one tiny real call per family, plus Haiku. Use `RoleExecutor` with a trivial schema `{ok:boolean}` and prompt "Return {\"ok\": true}", at low effort.

**CLI (`mc`, commander):**

| Command | What it does |
|---|---|
| `mc init` | Writes the config template if missing and prints the path |
| `mc config get <dotted.key>` / `mc config set <dotted.key> <value>` | Edits the YAML, preserving comments where possible |
| `mc doctor [--live]` | Prints ✓/✗ lines with plain-language fixes; exit 1 on any error |
| `mc new "<idea>" [--name <title>] [--profile <p>] [--role <spec>...]` | Creates a greenfield mission. `repoPath` is determined at init; store `""` until then. Prints the id |
| `mc feature <repoPath> "<request>" [--base <branch>] [--profile] [--role]` | Creates a feature mission |
| `mc run [--until HH:MM] [--mission <id>] [--profile <p>] [--role <spec>...]` | Calls `runNight` |
| `mc status [--json]` | Table of missions: id, kind, status, stage, done/total, blocked count, waiting-until if any |
| `mc report [<id>]` | Prints the report path and the first ~40 lines |
| `mc stop` | Creates STOP. The run stops after the current agent run (the agent is aborted) |
| `mc logs <id> [--follow]` | Prints events.jsonl in human-readable form |

All commands print plain language. Exit codes: 0 ok, 1 error.

## Integration tests (`test/`)

`test/e2e-mock.test.ts` drives `Dispatcher` with two `MockRunner`s impersonating `claude` and `codex`, a `FakeClock` or the real clock with tiny timeouts, a temp home and a temp workspace. The fixture verify config uses `node --test` (no npm):

```json
{"install": null, "full": "node --test tests/", "tests": "node --test {files}", "testGlobs": ["tests/**"]}
```

Scenarios:
1. **Happy greenfield:** spec(2 features) → gate approve → init writes `tests/smoke.test.mjs` + `app.mjs` → for each feature the test author writes a failing test, then the engineer implements → review approve → gate C approve → status `done`, main fast-forwarded, report exists, usage recorded.
2. **Escalation:**
   - The engineer fails twice with the same signature → diagnose (`retry_with_hint`) → the frontier rung in the other family passes. Assert the families/models used per rung.
   - An engineer that edits a frozen test is reverted and doesn't pass by cheating.
3. **Limits:** the codex runner returns `limited` (resetsAt +10 min) → the executor fails over to claude (failover on), and the quota shows codex limited. With failover off and a FakeClock: it waits, then resumes after `advance`.
4. **Stop & resume:** STOP during building → status `stopped`. Clear STOP, `runMission` again → completes.
5. **Blocked feature:** the ladder is exhausted → the feature is blocked, its dependents are skipped, the mission is `partial`, and the report lists the reasons.

---

## Decisions after wave 1 (binding for W2/W3)

1. **Limit detection only on error text.**
   - Runners call `detectLimitText` only on: failed or `is_error` result text, `errors[]`, stderr, `turn.failed.error.message`, and Codex `error` events once the run has failed.
   - Never call it on a successful result or agent message: "added rate limiting, returns 429" must not read as a limit.
   - A rejected `rate_limit_event` is authoritative on its own.
2. **Agent verify output is `VerifyConfigOutput`** (nullable fields, in `types.ts`). `OnboardOutput.verify` and `InitOutput.verify` use it. Always convert with `normalizeVerifyConfig` before storing `Mission.verify`.
3. **Branch names honor `config.git.branchPrefix`.**
   - `MissionStore.createMission` sets `mc/<id>`. When the dispatcher first runs a mission, it sets `m.integrationBranch = <prefix>/<id>` if that differs.
   - Unit branches are `<integrationBranch>--<featureId>`.
4. **`MC_HOME`** sets both the config location and `config.home` (`loadConfig` handles this). Tests must set `MC_HOME` to a temp dir and never touch the real home.
5. **Git identity:** `Git.commitAll` and `Git.merge` already pass a fallback identity, so feature missions work without a global git config.
6. **Reports in Docker:** `scripts/mc-docker.sh copy-reports` copies reports out of the volume, so the CLI doesn't need that command. Night summary links must be relative to `<home>/reports/`, e.g. `../missions/<id>/report.md`.
7. **The lock** is pid-based. The Docker wrapper gives the `run` container a fixed name, so only one runs. No extra work is needed in `run.ts`.
8. **`renderReport` / `buildReportFacts`** filter usage by `m.id` themselves. Pass the whole ledger.
9. **`Verifier.install`** returns `ok:true` with `logFile:""` when there is no install command.

## Decisions after wave 4

### Exec/quota: runs that fail for reasons outside the job, and Codex per-model limits

1. **A run that never answered for reasons outside the job is never the job's result.** In `RoleExecutor.exec`:
   - Outside failures are `crashed` (the CLI crashed, could not start, or exited without a result) and `timeout` with no `progress` event during the run (a hung CLI or dead connection). A timeout after progress stays the agent's own failure (it was too slow), and `failed` (it answered, but invalid output, max turns, an error) stays as it was.
   - For required work, an outside failure calls the new `QuotaGovernor.recordFailure(provider, raw)`: the provider rests 60 s, 120 s, 240 s… (capped at 15 min, in memory only, reset by `recordSuccess`), so the other family takes over when failover allows, else the executor waits as for a limit. `ProviderState` gains `{ status: "failing"; until; raw }`.
   - The job gives up once 30 min have passed since its first outside failure (or after 16 of them) and throws the new `ProvidersFailingError(message, providers, detail)`, `detail` being the real error (first and last line). The same error replaces handing back the last result after `MAX_LIMITED_RUNS` (8) limited runs.
   - Optional work (scouts, `mc doctor --live`) still gets the failed result back and marks nothing in the quota.
   - `onWaiting` gets a third argument `cause: "limits" | "trouble"`: "trouble" when the provider waited for is failing or throttled (overload, network), so the night run no longer reports a network outage as "at its usage limit" (`announceWait` sends "Waiting for the AIs to respond" instead).
   - This changes W3-A's "agent outcome not ok (failed/timeout/crashed) → record as error, rung++": only runs that answered (or timed out while working) reach the dispatcher, so outages never use up a rung, a diagnose step, or a spec, onboard or init attempt.
2. **The dispatcher pauses on `ProvidersFailingError`:** status `stopped` (a plain `mc run` resumes it), a note naming the real error, a high-priority "<title>: paused, the AI isn't working" notification. `Dispatcher.noWorkPossible()` reports "the AI command lines keep failing (…)" when every provider has failed at least 3 times in a row since it last worked (`QuotaGovernor.failureStreak(provider)`, which outlasts the backoff) or needs a login, so the night ends instead of starting the next mission only to wait out the same failures.
3. **No "rephrase your request" advice for runs that never gave a usable answer.** When no spec (or onboarding) run produced a parseable answer, the mission still fails after its attempts, but the decision says the AI didn't give a usable answer, names the problem, and gives `mc run --mission <id>`; the rephrase advice is kept for plans that were produced but unusable.
4. **Codex per-model usage limit** (`You’ve hit your usage limit for GPT-6-Astra. Switch to another model now, or try again at …`) is `kind: "model"` with `model` = the display name as a model id (`gpt-6-astra`; "GPT-6 Astra" and "GPT-6.1 Sol" map to `gpt-6-astra` and `gpt-6.1-sol`, parenthesized notes dropped). It is checked before the generic `hit your usage limit` rule, so only that model is blocked and the provider's other model keeps working (design-v1 §4). A name is read up to codex's ". Switch to another model"; without that sentence only a single word containing a digit counts ("usage limit for this week" stays provider-wide).
5. **Codex network loss and server errors are throttles**, as the Claude runner already reports them: `turn.failed` (or a retry notice nothing recovered from) with "stream disconnected before completion", "error sending request for url", DNS/connection errors or "unexpected status 5xx" is `limited` with a `throttle` limit, not `failed`. Before this, a Codex network outage used up rungs and spec attempts as if the agent had failed.

### Dispatcher: integrity of merged work, failed missions, guards, and unattended-night safety

1. **Agents that switch branches.** After every agent run that can write (test author, build, fix, init) and whenever a worktree is reused, `Git.keepOnBranch(wt, branch)` puts a worktree whose HEAD an agent moved (`git checkout -b`, `git switch`, a detached HEAD) back on its branch (the unit branch, or the integration branch for init) without touching files or index, so the next commit records the work there; event `branch.restored`. `merge()` merges `f.passingCommit` (the checked and reviewed sha), not the branch name, and blocks the feature unless that commit is an ancestor of the integration head afterwards (`Git.isAncestor` is public). This replaces W3-A merge's "`git.merge(unitBranch, …)`".
2. **Failed missions.** `Mission.failure?: { reason; decision?; retryable }` (additive in `types.ts`) records the note and decision a failure added. Running a failed mission again removes both (event `mission.retry`), so a mission that then finishes no longer asks the owner to fix anything. Every failure decision names the exact command: `mc login-claude` / `mc login-codex`, `mc run --mission <id>`, or `mc new "<your idea>"`; an internal error also gets a decision. `AuthUnavailableError` failures are `retryable`: `run.ts`'s queue now takes missions that are queued/running/waiting/stopped **or failed with `failure.retryable`** (W3-B runNight step 4), because a login is fixed outside Mission Control and the scheduled run should simply carry on. Other failed missions wait for `mc run --mission <id>`: `NightResult.waitingForYou` lists them, the night summary gets a "Waiting for you" section with `mc report <id>` and `mc run --mission <id>`, it no longer says "Nothing was queued" while one waits, and `mc run` / `mc status` print the same commands.
3. **Notifications name commands, not paths.** The mission report path is inside the container, so the finished and failed notifications say `Read the report: mc report <id>` (plus what got stuck and the decision, when there is one) instead of W3-A finalize step 5's report path.
4. **What the engineer must leave alone** (`checkUnit`), besides its own frozen tests: every other test file present at the tests commit (earlier features' acceptance tests, the scaffold's smoke tests, the project's own tests), the files the verify commands name (`scripts/mc-test.mjs`, a checks script), test runner configs (`vitest|playwright|jest` `*.config.*`/`*.workspace.*`), and the `package.json` scripts the verify commands call, directly or through each other (with their pre/post scripts). All of it is recorded per unit in `<missionDir>/guards/<feature>.json` when the tests are frozen, restored from the tests commit when changed (scripts are rewritten in place; new scripts stay) and committed as "revert frozen test edits"; it counts as a frozen violation (a failure only if verification still fails). New test files stay the anti-cheat scan's business. The test author's edits to finished features' acceptance tests are undone like edits outside the test folders. A diagnosis's `amend_tests` keeps the feature's earlier frozen files frozen (those still present) alongside the rewritten ones.
5. **Verify shells read no profile.** `Verifier` runs `bash --noprofile --norc -c "<cmd>"` instead of W1-E's `bash -lc`: login and rc files live outside the repository, where agents can write and no diff or reviewer looks. PATH comes from Mission Control's own environment.
6. **A red baseline still catches regressions.** With `baselineBroken`, a unit's check runs its frozen tests together with every done feature's frozen tests, and gate C runs all done features' frozen tests on the integration head (verify label `gate-c-features`). That result is gate C's `ok` (a failure adds a fix feature like a red full verification), and `finalVerifyPassed` is `head matches && ok`: a red baseline no longer counts as passed by itself.
7. **Diffs in prompts** (review, gate C, diagnosis) go through `condenseDiff(diff, CAPS.diff)`: lockfiles and generated files (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, `*.snap`, `*.map`, drizzle/migrations `meta/*.json`, …) shrink to one line, and when the rest is still too long every file gets an equal share (smaller files whole), in git's order. Keeping only the head showed gate C a greenfield scaffold's configs and lockfile and none of the app.
8. **Test disputes survive a stop.** `failBuild` saves `pendingDiagnosis {dispute, rung}` with the new rung; `buildStep` runs a pending diagnosis (with the dispute) before anything else, ladder rung or not, and clears it once it ran.
9. **"Done" means nothing serious is open.** `settleStatus` sets `done` only when every feature is done, gate C's checks passed on the current head, the final review finished, and no blocker/major finding is left open (on a feature, or from gate C's last round). Otherwise `partial`, with a note and the decision "Have someone check the app before you rely on it: <what is open>. …". `dispatch.json`'s `finalVerify` gains `reviewed` and `blocking`. This tightens W3-A finalize step 3.
10. **Finalize removes the integration worktree for every status** (W3-A finalize step 6 said only when done): a finalized mission never runs again, its branch keeps the work, and while the checkout exists it holds disk space (node_modules) and git refuses to check the branch out in the app folder.
11. **Between missions** `run.ts` asks `Dispatcher.noWorkPossible()` and ends the night (summary: "Ended early because …") when every login has expired, no AI is free before the deadline (`availableAt + 45 s > deadline` for every provider), or the disk is almost full, instead of starting the next mission (worktrees, installs) only for it to stop again.
12. **Mission Control dying.** Each agent run leaves an in-flight marker in `dispatch.json` for its duration. On the next start a marker means the process died during that run: it counts toward the run cap, gets a note and event `run.interrupted`, and after 3 interruptions of the same (non-optional) run the feature is blocked, or a mission-level step fails the mission, with a plain reason. At start, `runNight` sends a high-priority "Mission Control stopped unexpectedly" notification when a mission was left `running`/`waiting`. `mc` sets `process.title = "mission-control"`, so an agent's `pkill node` does not match it.
13. **Disk space.** Before every agent run, verification and stage step, the dispatcher checks free space where the home and the app live (`DispatcherDeps.freeBytes`, default `statfs`); below 2 GiB, or when a check's output says "no space left on device", the mission is `stopped` (not failed, nothing counted against the feature) with a note and a high-priority notification.
14. **Leftover processes.** `src/util/reap.ts`: inside the container (`MC_IN_CONTAINER=1` and mc a direct child of pid 1, i.e. `docker run --init`), every other child of init is something an agent or a check left running (a server holding port 3100, an orphaned Playwright web server), and is killed with its descendants (SIGTERM, SIGKILL after 2 s) before and after every agent run and before every verification (`DispatcherDeps.reapOrphans`; event `processes.reaped`). Nothing is reaped outside the container.
15. **The app repository's `.git`.** At mission start, git lock files at least 60 s old (left by a killed git) are removed from the common git dir, its `refs/` and each worktree's admin dir (event `git.locks.removed`). `Git` and the file listing pass `-c core.fsmonitor=false`. The repository's config and hooks are recorded (in `dispatch.json`) before any agent works there; after every writing agent run, every verification and at finalize, a config that gained an entry that makes git run a command or read other config (`core.fsmonitor`, `core.hooksPath`, `core.sshCommand`, `include*.path`, filter/merge/diff drivers, `credential.*`, `alias.*`, `protocol.*`, `url.*.insteadOf`, …) is put back, and added or changed hooks are removed or put back (note, event `git.settings.restored`). Harmless changes (a remote the owner adds) become the new baseline.

### CLI, night run, doctor and report: what the owner sees and types

1. **Run lock.** The lock records `start` (boot id and process start time from `/proc/<pid>/stat`), additive to `{pid, at, host}`: a live process with the holder's pid but another start time took the pid over after the holder died, so the lock is stale (Linux; elsewhere, and for older locks, the pid probe alone decides). `mc-docker.sh` gives the night-run container a fixed `--hostname mission-control-run`, so a lock left by a killed run (`docker stop`, a crash, a restart) is judged by its pid in the next run's container instead of blocking it for 5 minutes as another host's lock. `MissionStore.activeRun(): string | undefined` is a read-only probe with the same liveness rules (it describes the holder like the refusal does). `mc status` shows a mission saved as running or waiting while no run holds the lock as `interrupted` (JSON: `interrupted: true`), and the "already active" error for another host's lock adds "wait 5 minutes" when `docker ps` shows no run.
2. **`--until` must be at most 18 hours away.** `parseUntil` still returns the next occurrence, but `runNight` refuses a deadline more than 18 h after the start (a time that passed a little while ago: 07:20 with `--until 07:00` would work about 24 h through the owner's day) before taking the lock, saying so and suggesting a later time. Every night logs "Working until HH:MM today/tomorrow (…)" (or "until the queue is done") when it starts.
3. **`mc doctor` leaves the logins alone during a night run.** When `activeRun()` finds a run, the Codex login and model checks and the `--live` checks are skipped with a warning (`Not checked: a night run is working right now`), because two processes refreshing Codex's `auth.json` at once can log it out (design-v1 §2.1). Otherwise `codex login status` and `codex debug models` run one after the other, never at once.
4. **Inside the container, `home` must be inside `~/.mission-control` and `workspaceRoot` inside `~/mc-apps`** (the only folders `mc-docker.sh` mounts): the doctor's folder checks are errors otherwise (`unkeptFolderProblems`), `mc config set` refuses such a value, and the settings template says so.
5. **`mc config set` messages.** `loadConfig` throws `ConfigProblemsError { file, problems }` (message unchanged) for invalid settings. A rejected value lists only the problems the new value adds, ending "Your settings file is as it was. Correct the value and try again." A value that adds no problem is saved even while the file has older problems, which are then listed, so they can be fixed one at a time.
6. **Terminal safety.** `mc` strips C0/C1 control characters (keeping newline and tab) from everything it prints, and `renderReport` / `buildReportFacts` from what they return (`src/util/terminal.ts`): agent text can no longer drive the terminal (OSC 52 writes the clipboard).
7. **`mc new` / `mc feature` take the description as several words** (`new <idea...>`, `feature <app-folder> <request...>`, joined with spaces), so forgotten quotes still work.
8. **`mc feature` folder help.** `mc-docker.sh` stops `feature` when its folder exists on the host outside `~/mc-apps`, saying to move or copy it there; in the container, "There is no folder at …" adds the same hint. On a folder without a branch checked out, the error names the way back: `git -C <folder> checkout <branch>` (the last mission there's base branch, else main/master), besides `--base`.
9. **`mc report` with no id** shows the latest night summary when it is newer than the latest mission report and links two or more missions (each summary line now also gives `mc report <id>`); otherwise the latest mission report as before. The Windows hint says copy-reports puts the screenshots next to the reports as picture files (Notepad shows no pictures).
10. **Report (W1-G) changes.**
    - Header words match the night summary: "Paused, continues on the next run" (stopped) and "Stopped, needs your help" (failed).
    - "What it looks like" (screenshots) comes after the features table, so the 40-line `mc report` preview keeps the decisions and the table.
    - "Needs your decision" also lists, once a mission is finished (stage `complete`), its blocked and skipped features with the command that queues them again (`mc feature <folder> '<titles and stories>' --base <main for a new app, else the mission's branch>`), and, for a partial mission whose features are all done without any decision, that the final whole-app check failed.
    - "How to try it": inside the container (`RenderReportOptions.inContainer` / `howToRun(m, { inContainer })`, default `inContainer()`), the steps start with `mc shell` (Ubuntu has no Node), paths in the container's home are written `~/…` (valid in `mc shell` and in Ubuntu), and the app's folder is named with its File Explorer address. The steps end with how to leave: Ctrl+C, `git checkout <baseBranch>` after a checkout step, `exit`. A finished feature mission says how to keep the change (`git checkout <base> && git merge <branch>`) or leave it. A feature mission's app is started with its package.json `dev` (or `start`) script when it has one, instead of running its checks.

### Runners: billing guards, tools that reach the account, Codex's sandbox in Docker, and pacing both families

1. **Claude write jobs get an allowlist** instead of W2-A's `--disallowedTools` list: `--tools Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,WebFetch,WebSearch,Task,TaskCreate,TaskGet,TaskList,TaskUpdate,TaskStop,Monitor,Skill,ToolSearch` (names a CLI version lacks are ignored; checked on 2.1.295). Everything else stays off, including tools that act on the user's account beyond the run (`RemoteTrigger`: cloud routines; `DesignSync`: claude.ai designs; scheduling, other sessions, push notifications), which the account can switch on server-side even for a pinned CLI. Read-only and `noTools` jobs keep `Read,Grep,Glob` and `""`.
2. **No settings file and no MCP server configure a Claude run.** Every job also gets `--setting-sources "" --strict-mcp-config` (both accepted by 2.1.295). A settings file's `env` (`ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL`), `apiKeyHelper`, hooks and MCP approvals are ignored, whether the file comes from the repository or the login folder, and no MCP server is connected, claude.ai connectors included. As a second check, an `init` event whose `apiKeySource` is present and not `"none"` (`ANTHROPIC_API_KEY`, `apiKeyHelper`, `/login managed key`) stops the CLI at once; the outcome is `auth`, with an error saying the login would bill API credits and to log in with the Claude subscription.
3. **No run continues on paid extra usage.** A rejected `rate_limit_event` that extra usage would cover (`isUsingOverage`, or `overageStatus` `allowed`/`allowed_warning`) now stops the CLI at once and is `limited` with the rejected window's limit (W2-A's rule; before, such runs went on billing extra usage, and later runs did too when the event carried no utilization). A later rejection without a reset time keeps the reset an earlier one gave for the same limit. There is no opt-in for extra usage.
4. **A Claude CLI that stays alive after its result is stopped** after `ClaudeRunnerOptions.exitGraceMs` (default 30 s) of no new turn, and the result stands (print mode waits on background shells for up to 10 minutes, and on a hung child for the whole 45-minute timeout). An `assistant` or `user` event after the result (a background shell woke the model) holds the timer off until that turn's own result.
5. **More Codex failures are throttles** (extends Exec/quota 5), as codex 0.162.0 words them: "We’re currently experiencing high demand" (its text for an HTTP 500), "exceeded retry limit, last status: 5xx", "Reconnecting... waiting for network (Connection failed: error sending request)". Codex waits for the network indefinitely, so a codex whose pending error has been such a failure for `CodexRunnerOptions.stallMs` (default 5 min) without progress is stopped; the outcome is that `limited` throttle, not a 45-minute timeout.
6. **Codex read-only jobs inside the container.** Codex's read-only sandbox runs every command through bubblewrap, which needs user namespaces, and Docker's default seccomp profile blocks them: every command a read-only Codex agent ran failed and the run still returned `ok`. When the write sandbox is `danger-full-access` (the container is the boundary), each `CodexRunner` probes once with `codex sandbox -c sandbox_mode="read-only" -- true`. If that fails, read-only jobs with tools run with `-s danger-full-access`, the brief tells the agent that writes are not blocked and must not happen, and `src/runners/worktree-guard.ts` snapshots the git working tree before the run (`HEAD`, its branch, the index, and the content of tracked and untracked files as a tree, through a copy of the index) and afterwards puts back whatever changed (files, index, branch and its commits; ignored files are left alone, and with more than 2000 untracked files only tracked ones are guarded), with a warning and a progress line naming the paths. `noTools` jobs keep `-s read-only`. Outside the container nothing changes. `buildArgs` gains an optional third parameter, the sandbox read-only jobs get (default `read-only`).
7. **Codex logins that bill elsewhere are refused.** Before a runner's first run, one short `codex app-server` session (JSON-RPC over stdio; `initialize`, `account/read`, `account/rateLimits/read`, stdin kept open until both answer, 15 s at most) reads the login. An `apiKey` or `amazonBedrock` account makes every run return `auth` without starting codex, with an error naming `codex logout` and `codex login --device-auth`. A missing or silent app server lets runs go ahead. `mc doctor` reports a Codex API-key login as an error (was a warning).
8. **Codex usage windows feed pacing.** The same session, and one after each run (at most every 60 s, `usagePollIntervalMs`), emit `utilization` events from `account/rateLimits/read`'s main bucket: `usedPercent / 100`, `resetsAt × 1000`, the window named by its length (4 to 6 hours `five_hour`, 6 to 8 days `seven_day`, else `<minutes>_minutes`, a window of unknown length skipped). The W2-D caps now apply to Codex too; before, nothing paced it until its hard limit.
9. **A night's share of the weekly limit.** `Config.pacing.maxWeeklySharePerNight?: number` (additive in `types.ts`; default 0.35 as in design-v1 §2; `(0, 1]`; absent means no cap). `QuotaGovernor` remembers, per provider and in memory only, the first `seven_day` utilization it records (lowered whenever a reading is lower: the window reset or usage rolled out of it). Once the latest reading is at least the share above it, the provider is blocked like a weekly limit until that window's reset ("this night's work used N% of the weekly limit"). Each night run has its own governor, so the next night starts afresh; with `--until`, the waiting mission stops and continues then. A provider that reports no `seven_day` reading is not capped this way.
10. **Agents still run as the orchestrator's user** (design-v1 §5 says otherwise). An agent's `pkill node` / `killall node` / `pkill -f node` no longer matches `mc` (Dispatcher 12: `process.title`, which sets both `/proc/<pid>/comm` and the command line), but a same-user agent can still signal it in other ways (`kill -9 -1`, `pkill -u`) and write `~/.mission-control` (config, quota, STOP, mission state). A separate agent uid is left to its own change: it needs a privileged spawn wrapper (sudo or setpriv) for agents and verify commands in `runProcess`, a kill path that works across users (SIGKILL to a sudo parent does not reach its child), shared group or ACL ownership for worktrees, git objects and the CLI login folders, worktrees moved out of the home folder, and Dockerfile and wrapper changes that unit tests cannot exercise.

### Container and setup: limits, the outbound allowlist (deferred), and night runs that can't start

1. **Every container is limited** (W1-H listed only `--init` and `--shm-size=1g`). `mc-docker.sh` adds `--cap-drop ALL --security-opt no-new-privileges --pids-limit 8192` to every `docker run`, and `--memory <75% of docker info's MemTotal, in MiB>m --memory-swap -1` when Docker reports at least 1 GiB (otherwise no memory flag). Agents run as `pwuser` and need no capability; the limits make a runaway build, test or fork bomb fail inside the container instead of exhausting Docker Desktop's WSL2 VM. `--memory-swap -1` leaves swap to WSL (a quarter of its memory by default, below the limit anyway) and keeps Docker from printing a swap-accounting warning on every command. 8192 tasks leaves ample room for a Playwright run with a browser per worker plus vitest forks, the dev server and both CLIs. `fix-permissions`, the one root container, adds back only `CHOWN` and `DAC_OVERRIDE`.
2. **The outbound allowlist (design-v1 §5, §6 item 8) is deferred, not built.** An allowlist that holds needs either iptables rules set at container start (`NET_ADMIN` for a root entrypoint that then drops to `pwuser`, the devcontainer `init-firewall.sh` pattern) or an allowlisting proxy on an internal Docker network. Neither can be exercised by unit tests or verified here without Docker, and both would break an unattended night in ways that look like agent failures: IP snapshots of CDN-hosted hosts (npm, GitHub, Cloudflare) go stale during a night; apps legitimately reach hosts outside any fixed list (`next/font/google` at build time, postinstall binary downloads from GitHub releases or vendor CDNs, an app's own APIs in its e2e tests, documentation through WebFetch); and Node 22's `fetch` ignores `HTTPS_PROXY`, so behind a proxy Mission Control's own ntfy notifications would stop. Until then, `docs/setup-windows.md` says plainly that agents can reach the internet and the home network and could send out the logins. The capability, privilege and resource limits above don't depend on it.
3. **"Docker isn't available" names the likelier cause first.** With Docker Desktop stopped, the WSL integration's `docker` link points nowhere, so the command looks missing, as when the integration is off. The message says to start Docker Desktop and, only if it is already running, to turn on WSL integration; the setup guide's troubleshooting row matches.
4. **A night run that can't start still notifies.** The ntfy address lives in the `mc-home` volume, out of the wrapper's reach while Docker is down. So before every night run's container, `mc-docker.sh run` reads it with `mc config get notify.ntfyUrl` in a short container of its own and keeps a copy at `~/.config/mission-control/ntfy-url` (mode 600). An address replaces the copy, `(not set)` removes it, and a failure or any other output leaves it as it was. When an unattended `run` (no terminal: Task Scheduler) stops before its container starts, because Docker never became ready within the 5-minute wait or the image is missing, the wrapper posts the same message it prints, with curl (title "Mission Control: the night run didn't start", priority 4, tag `warning`), to the copied address. This is best effort: no copy, no curl or a failed post changes nothing else. "A Mission Control run is already active" is not pushed, because the run already working sends its own notifications. A run started at a terminal prints its problem and pushes nothing.

### Git push: no hooks, and what the push credential exposes

1. **`Git.push` runs no hook** (it passes `-c core.hooksPath=/dev/null` like every other `Git` command; W1-D's "the repository's pre-push hook runs" is withdrawn). Agents can write `.git/hooks` and the config naming the hooks folder, and a hook run by the push would run with the push's credentials in reach (a planted pre-push hook could force-push `main` with them). A repository whose effective pre-push hook exists and is executable (`git rev-parse --git-path hooks/pre-push`, which honors `core.hooksPath`: `.git/hooks/pre-push`, husky's `.husky/_/pre-push`, Git LFS's) is not pushed at all, since skipping the hook could push something it would have stopped (LFS files): `{ ok: false, error: "the repository has a pre-push hook (<path>), which Mission Control does not run, so it did not push. To push, run in the app's folder: git push origin <branch>" }`, which finalize records as the usual "Could not push …" note. The `RunOptions.hooks` opt-in is gone; `repoHooksPath` only lets `rev-parse` read where the hooks are.
2. **The push credential is readable by agents, and the setup guide says so.** The orchestrator and the agents run as the same user in the same container, which has no SSH key, no credential helper and `GIT_TERMINAL_PROMPT=0`, so a working push needs a token stored in the app's folder (the remote URL in `.git/config`), where every agent can read it and push with it directly. "Only `mc/*`, never forced, never `main`" therefore binds only Mission Control's own push; `main` is safe only through GitHub's branch protection. `docs/setup-windows.md` gains "Optional: upload finished work to GitHub": a fine-grained token for that one repository with Contents read/write only, saved with `git remote add|set-url origin https://<user>:<token>@github.com/…` in `mc shell`; a branch ruleset on the default branch (Active, empty bypass list because the token acts as the owner, restrict deletions, block force pushes, require a pull request), and leaving uploading off where GitHub won't enforce it (private repositories on the free plan); then `mc config set git.push true`. Rule 1 ("no keys in `~/mc-apps`") names this token as its one exception, the troubleshooting table explains `Could not push mc/…` (no remote, expired token, pre-push hook), and the settings template's `git.push` comment points to that section instead of promising "never forced".

### CEO dashboard and the leader

1. **A read-only dashboard exists** (`mc dashboard`; design-v1's "Later: a tiny read-only web dashboard"). It serves `GET` and `HEAD` only (anything else is 405) and builds a snapshot from files Mission Control already writes. It never writes, creates, locks or touches anything under the Mission Control home. It uses `MissionStore.load` for each `mission.json` (the constructor and `load` do no writes) and reads the rest directly with read-only calls: `mc.lock`, the `STOP` file, `quota.json`, `usage.jsonl`, `events.jsonl` and a few values of `dispatch.json` (`finalVerify` and `inflight`). It never calls `list()` (it hides unreadable missions), `activeRun()` (it probes a pid), `readEvents`, `readUsage`, `stopRequested` or `logsDir()` (which creates a folder). The read-only proof (every write call blocked, tree hash unchanged, `strace` showing only `O_RDONLY`) was run on the first prototype of these reads; the shipped reads are covered by `src/dashboard/readonly.test.ts` and by a live check that the home's file list, sizes, mtimes and hashes are the same before and after serving. In Docker it runs in its own container with the `mc-home` volume mounted read-only. The full contract is `docs/dashboard-spec.md`; the data contract is `src/dashboard/types.ts`.
2. **No authentication, by the owner's decision.** No token, cookie, CSRF protection, rate limit or second container. Kept: every displayed string is inserted with `textContent`; fixed routes only; a strict Content-Security-Policy that lists the hashes of the page's inline script and style; the listen address and port are options (default `0.0.0.0` inside the container, port 8787; `mc-docker.sh dashboard` publishes on the loopback address unless `--lan` is given, which publishes on every interface). The first design of the dashboard had a token gate and two containers; that part is not built.
3. **The dashboard is the CEO's eyes only; the leader is the hands.** The leader is a Claude session started in `leader/` (also reachable from the Claude app or claude.ai/code through Remote Control when started with `claude --remote-control`, not verified) that acts only through `mc`: status, logs, report, stop, new, feature, run. Its permissions (`leader/.claude/settings.json`) auto-allow only `status`, `logs` and `report` through `scripts/mc-docker.sh`; `stop`, `run`, `new` and `feature` are in the `ask` list (Claude Code asks first, on the PC or in the app), and file edits, git and `logs --follow` are refused. The owner can move entries from `ask` to `allow` (`docs/leader.md`). Text written by AIs (reports, logs, decisions, titles) is data to the leader, never instructions. The page has no write path: "Tell the leader" gives a ready sentence to paste, and "Stop tonight's run" is a sentence, not a button. The leader has no command to reopen a feature or change a plan in place, so an answer to a stuck feature or a question becomes a follow-up request (`mc feature`), and the sheet says so. `mc run` blocks for the whole night, so the leader starts it as a background task of its chat; `mc dashboard` is a foreground command and is started by the owner. The first design's inbox and directives are out of scope.
4. **One vocabulary, built on the server.** `src/dashboard/vocabulary.ts` holds every word and sentence; the snapshot (`src/dashboard/types.ts`, schemaVersion 1) carries stable state ids plus the plain word; the page only lays strings out and owns a short fixed list of chrome words. Text written by an AI is marked `author: "ai"` and labelled on the page. A text counts as the engine's only when it matches a known engine string in full; the default is `ai`.
5. **The night lamp rules are a fixed table with named constants** (`docs/dashboard-spec.md`, section 5). Liveness is the lock's heartbeat alone (5 minutes, the engine's own number for a run in another container), never a pid probe. "Tonight" is the last 18 hours. A saved `waiting` status is not proof that the run sleeps (the engine leaves it while the agent runs after the wait), and `done` or `partial` is not finished before the stage is `complete`; the dashboard decides both from the events and the stage. A failed mission from before turns the lamp amber; other older items are shown in a quiet row and never change the lamp (the engine never clears a decision on a finished mission). A queued mission is grey, not amber. A wait of unknown cause, or with a login problem, is amber whatever its length. A stale page turns amber after 30 s and "Not responding" after 5 min; unknown or unreadable data is never green. The places where this differs from the first design are listed in section 5.6 of the dashboard spec and are open for the owner to confirm.
6. **Nothing was added to the engine, so some things are approximate or absent**: no stop time unless `mc dashboard --until HH:MM` is given; no "tonight's share of the week" (memory only); allowance readings carry no time, so the page shows when the figures last changed, from the file's modification time; the wait cause is read from the shape of the `limit.wait` reason; the feature of a running step is read from its label. Each of these is stated on the field in `types.ts`.
7. **The morning debrief has four honest ticks**: Delivered, Final review passed (from `dispatch.json` `finalVerify`; `unknown`, never `yes`, when that file cannot be read; a caveat when a feature's own review did not finish or when the review covered only the features that were built), Nothing open (counted from the open items, so a stuck feature or a failed mission is never "nothing"), No rework. They are the AI team's own checks, not a human review, and the page says so. Also: "Reinforcements called in" (tries after the first, with the ladder steps used of its size shown beside it) and "Recovered after a retry". Not built: points, XP, levels, streaks, confetti, percent-complete bars, dollar amounts, model names on the main views.
8. **Packaging**: the page is `dashboard/index.html` at the package root, found with `packageRoot()` like `prompts/` and `stacks/`; the Dockerfile copies the folder and `package.json` lists it in `files`. The dashboard container bypasses `docker/entrypoint.sh` (`--entrypoint mc`; the entrypoint would warn about the read-only home and the missing logins). `dashboard/demo.html` and `dashboard/demo/*.json` are generated from the fixtures, so the page can be shown from a file.
9. **Tests use authentic data**: fixtures under `test/fixtures/dashboard/` come from the real engine run with scripted AIs (captured on commit `8342744`), with absolute paths replaced and `dispatch.json` reduced to the one key the dashboard reads; synthetic fixtures cover what no capture contains and are marked as such. `test/leader.test.ts` keeps `leader/CLAUDE.md` and the leader's permissions in step with the real commands and with the dashboard's sentences.
10. **Not verified, and the docs must not claim otherwise**: Docker Desktop and WSL2 networking to a browser or an iPad, iPad Safari, `claude --remote-control` and `/remote-control`, the leader's behaviour in a real Claude Code (including its permission rules and `mc run` as a background task of its session), and any real AI output (every capture comes from scripted stand-ins; none holds a usage reading). The asleep, finalize, heartbeat and kill rules were checked live with the real engine and scripted AIs, not with real AI output. `docs/setup-windows.md`, `leader/README.md` and `docs/leader.md` say so where it matters.
