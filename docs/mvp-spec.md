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
  - `{"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","cache_write_input_tokens","output_tokens","reasoning_output_tokens"}}`. Usage is the **thread total**.
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
- `turn.completed` → usage: `input_tokens`, `output_tokens`+`reasoning_output_tokens`, `cached_input_tokens` → cacheRead, `cache_write_input_tokens` → cacheWrite.
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
