# Mission Control: design v1

This builds on [`brainstorm.md`](./brainstorm.md). It turns the brainstorm into concrete decisions based on your answers:

| You said | Design consequence |
|---|---|
| Claude subscription + ChatGPT/Codex subscription, easy switching | Drive the **official `claude` and `codex` binaries** as subprocesses behind one `AgentRunner` interface. Role → model mapping lives in **profiles**: `claude`, `codex`, `mixed`. No Agent SDK and no API keys. The scarce resource is **usage-limit headroom**, not dollars. |
| New apps, features: coding | Two mission types: **greenfield** (initializer phase first) and **feature** (onboarding phase first). Verification is executable: unit tests, typecheck, and Playwright e2e. |
| Fully autonomous overnight | Quota governor (sleep, fail over, pace), crash-safe state, hard isolation, loop guards, a morning report, and push notifications. A human is only needed in the morning. |

---

## 0. Subscription rules: what's allowed (read this)

- **Signing in to the unmodified `claude` binary with your own subscription and running it headless (`claude -p`) is documented and allowed.** Headless runs draw from your plan's limits. Source: [legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance), [Max-plan article](https://support.claude.com/en/articles/11145838-using-claude-code-with-your-max-plan).
- **Plan logins may *not* be used by third-party harnesses, the Agent SDK in products, or anything serving other people.** That is why we shell out to the official binaries and never touch OAuth tokens ourselves.
- **Gray zone:** "Advertised usage limits for Pro and Max plans assume ordinary, individual usage." Anthropic's docs don't address a personal orchestrator running all night.
  - Keep it personal. Don't run it for clients on your plan.
  - Expect to hit limits.
  - Re-read the terms occasionally.
  - If it becomes a business, flip the profile to API-key mode, which is a config switch, not a rewrite.
- **Codex:** `codex exec` with ChatGPT login is the documented non-interactive path. It uses `~/.codex/auth.json` and refreshes it in place.
- **Traps:**
  - If `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) is set in an agent's environment, the CLI silently bills the API instead of your plan.
  - `claude --bare` *requires* an API key.
  - The runner must scrub these environment variables.

---

## 1. Components

```
                         ┌───────────────────────── mc (TypeScript, Node 22) ─────────────────────────┐
 iPad ──ssh/Happy──►     │                                                                             │
 ntfy push ◄──────────── │  Dispatcher (state machine)  ◄──►  SQLite: missions, units, runs, usage     │
                         │        │                                                                    │
                         │        ├─► Quota Governor ── per-provider limit state, failover, pacing     │
                         │        ├─► Workspace Mgr ─── git worktrees, branches mc/<mission>/<unit>     │
                         │        ├─► Verifier ──────── ./mc-verify, frozen-file check, anti-cheat      │
                         │        ├─► Reporter ──────── morning report, PR, push notifications          │
                         │        └─► AgentRunner                                                       │
                         │              ├─ ClaudeRunner  → claude -p … --output-format stream-json      │
                         │              ├─ CodexRunner   → codex exec --json --output-schema …          │
                         │              └─ MockRunner    → scripted, for tests (spends no quota)        │
                         └─────────────────────────────────────────────────────────────────────────────┘
                                    all inside one disposable container / VM per mission
```

**Principle: guarantees live in the orchestrator, not in either CLI.** Hooks differ between Claude Code and Codex. So "done", "tests are frozen", "no pushes to main" and "stop on no progress" are enforced by the Dispatcher and Verifier, which work identically for both providers. CLI hooks are optional extras.

### 1.1 AgentRunner interface

```ts
interface AgentRunner {
  run(job: AgentJob, signal: AbortSignal): AsyncIterable<RunEvent>; // streams progress
}

interface AgentJob {
  role: Role;                      // architect | engineer | scout | reviewer | ...
  provider: "claude" | "codex" | "mock";
  model: string;                   // provider-native id or alias
  effort: "low" | "medium" | "high" | "xhigh";
  cwd: string;                     // the unit's worktree
  rolePromptFile: string;          // roles/<role>.md, provider-neutral
  prompt: string;                  // the brief
  outputSchema?: JSONSchema;       // structured hand-off back to the Dispatcher
  access: "read-only" | "workspace-write";
  limits: { maxTurns: number; wallClockMs: number };
  resumeSessionId?: string;
}

type RunEvent =
  | { type: "progress"; text: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; cacheRead: number; estCostUsd?: number }
  | { type: "limit"; kind: "session" | "weekly" | "model" | "throttle" | "spend"; resetsAt?: string; raw: string }
  | { type: "result"; ok: boolean; text: string; structured?: unknown; sessionId?: string };
```

**ClaudeRunner** maps the job to:

```
claude -p "<prompt>" --model <m> --effort <e> --output-format stream-json --verbose \
  --append-system-prompt-file roles/<role>.md --json-schema '<schema>' \
  --permission-mode <auto | bypassPermissions inside container> --max-turns <n> \
  [--allowedTools Read,Grep,Glob for read-only roles] [--resume <id>]
```

- **Limit signals:** `rate_limit_event` (carries `resetsAt`) and `system/api_retry` with `rate_limit`, plus the text form `You've hit your … limit · resets <time>`. Users report events appearing mid-line in the stream, so parse NDJSON defensively.

**CodexRunner** maps the job to `codex exec --json --output-schema <file> -m <model> -c model_reasoning_effort=<e> --sandbox <…>`. Exact flags and gotchas are in §2.1. A small `codex app-server` client polls rate limits. Moving the whole runner onto app-server (as vibe-kanban does) is a later option.

**Pin both CLI versions** in the container image. Upgrade deliberately, re-running the smoke suite.

---

## 2. Profiles: switching providers

`mission-control.yaml` (example; GPT model ids come from §2.1):

```yaml
default_profile: mixed

profiles:
  claude:                       # everything on the Claude subscription
    architect: { provider: claude, model: opus,   effort: high }
    engineer:  { provider: claude, model: opus,   effort: medium }
    mechanic:  { provider: claude, model: haiku,  effort: medium }   # narrow / mechanical units
    scout:     { provider: claude, model: haiku,  effort: low }      # one-shot functions
    reviewer:  { provider: claude, model: opus,   effort: high }
  codex:                        # everything on the ChatGPT subscription
    architect: { provider: codex, model: gpt-6-astra, effort: high }    # scarce on Plus (5–45 msgs/5h): few calls only
    engineer:  { provider: codex, model: gpt-6.1-sol, effort: medium }
    mechanic:  { provider: codex, model: gpt-6-luna,  effort: high }    # OpenAI suggests starting Luna at high
    scout:     { provider: codex, model: gpt-6-luna,  effort: medium }
    reviewer:  { provider: codex, model: gpt-6.1-sol, effort: high }    # Astra if on Pro
  mixed:                        # spread load over BOTH quota pools + cross-family review
    architect: { provider: claude, model: opus,   effort: high }
    engineer:  { provider: codex,  model: gpt-6.1-sol, effort: medium }
    mechanic:  { provider: claude, model: haiku,  effort: medium }
    scout:     { provider: claude, model: haiku,  effort: low }
    reviewer:  { provider: claude, model: opus,   effort: high }     # always the other family from the engineer

failover:
  # if a provider is limited, run its roles on the other one; null = wait for reset instead
  claude: codex
  codex: claude

pacing:
  max_weekly_share_per_night: 0.35   # never burn more than ~1/3 of a weekly limit in one night
```

Switch with `mc run --profile codex`. Override a single role with `--role engineer=claude:opus:medium`.

### Why `mixed` is the default

- **Two independent quota pools.** Splitting roles across subscriptions roughly doubles overnight throughput before either one hits its 5-hour window.
- **Cross-family review is a small but real gain.**
  - Greptile measured it on 1,000 PRs: the other family's reviewer found 2–3 points more P0/P1 bugs, in both directions.
  - Models also measurably favor their own outputs ([self-preference](https://arxiv.org/abs/2404.13076)).
  - **Catch:** a reviewer that *edits* without running tests can damage stronger code. One study found Codex "reviewing" Claude's code dropped its pass rate from 91.4% to 82.8% ([arXiv 2607.21656](https://arxiv.org/abs/2607.21656)).
  - **So reviewers here are read-only.** They return schema'd findings, the builder fixes them, and **only failing tests or Playwright checks decide which findings count.** Cap it at 2 review rounds.
- Cursor saw per-family temperament differences: GPT stronger at extended autonomous work, Opus 4.5 "stops earlier and takes shortcuts". That was older models. Telemetry will tell you which family to put in which seat for *your* work.

### 2.1 Codex specifics

Checked against learn.chatgpt.com docs and the openai/codex source. The latest release is `rust-v0.162.1` (2026-10-09). **Pin it.**

**Models with ChatGPT sign-in** ([models](https://learn.chatgpt.com/docs/models)):

| Tier | Model | Plus usage per 5 h (OpenAI's estimate) | Role fit |
|---|---|---|---|
| Frontier | `gpt-6-astra` | 5–45 messages | architect, gates (rarely) |
| Standard (CLI default) | `gpt-6.1-sol` | 15–160 | engineer, reviewer |
| Cheap / fast | `gpt-6-luna` | 350–3,000 | scout, mechanic: **Codex's Haiku** |

- Effort levels are `low…xhigh|max|ultra`. **`ultra` fans out to subagents. Never use it implicitly**: set effort explicitly per role.
- `gpt-5.5` retires from ChatGPT sign-in on **Oct 14, 2026**. Validate model ids at startup with `codex debug models`.
- On Pro, OpenAI says there is "currently no five-hour limit". Weekly caps are unclear.

**CodexRunner command:**

```
codex exec -C <worktree> -m <model> -c model_reasoning_effort='"<effort>"' \
  --sandbox <read-only|danger-full-access> --skip-git-repo-check \
  --json --output-schema <schema.json> -o <final.md> "<prompt>"     # follow-ups: codex exec resume <id> "…"
```

| Gotcha | Handling |
|---|---|
| `--json` emits `thread.started`, `turn.completed{usage}`, `turn.failed`, `item.*` (`command_execution`, `file_change`, `agent_message`, `todo_list`, …). Some `error` events are recovered retries. | Decide success from `turn.failed` + the exit code |
| Usage in `turn.completed` is the **thread total** | Subtract the previous total on resumed sessions |
| A usage limit gives **exit 1** + "You've hit your usage limit… Try again at 3:45 PM" (local-time text). No structured reset time in exec. | Parse the text as a fallback. Primary: poll `codex app-server` → `account/rateLimits/read` (`usedPercent`, `resetsAt`), which also feeds **pacing** |
| `workspace-write` has **no network**, and the bwrap sandbox can fail inside Docker | Inside *our* container, use `danger-full-access`; the container is the sandbox. Read-only roles use `--sandbox read-only`. |
| Exec auto-**rejects** approval requests | Grant everything up front (sandbox mode). Never rely on prompts. |
| Profiles changed in 0.134+: `[profiles.x]` is silently ignored | A profile is now `~/.codex/<name>.config.toml`, selected with `-p <name>`. We pass `-c` overrides per run instead. |
| One `auth.json` must not be shared by concurrent jobs. It refreshes in place. | Serialize Codex runs per auth file in the MVP. Mount `~/.codex` read-write so refreshes persist. |
| Hooks only run once trusted by hash | We don't depend on hooks. If we add some: `--dangerously-bypass-hook-trust` inside the container. |
| `codex mcp-server` has been removed | Use `codex app-server` (JSON-RPC, "experimental") or the `@openai/codex-sdk`. MVP uses `exec`. |

**Headless auth:** `codex login --device-auth` (enable device-code login in ChatGPT security settings first). Or log in elsewhere and copy `~/.codex/auth.json`. Check with `codex login status`.

**Allowed?** OpenAI's pricing matrix lists "Codex SDK, `codex exec`, and scriptable workflows" on Plus/Pro/Business. Subscription auth for "commercial or hosted services" is not allowed. **Personal use is fine.**

### 2.2 Shared instructions across both CLIs

- **`AGENTS.md` is the single source of truth** for project conventions. Codex reads it natively, and Claude Code ≥ 2.1.277 reads it natively **when no `CLAUDE.md` exists**. So: no `CLAUDE.md` in generated projects, or a one-line `CLAUDE.md` containing `@AGENTS.md`.
- **Role prompts** (`roles/*.md`) live in the orchestrator, not the project. They are provider-neutral and injected per run (`--append-system-prompt-file` for Claude, prompt preamble or config for Codex).
- **Skills** use the open Agent Skills format (`SKILL.md` + frontmatter), which both CLIs read. The canonical location is **`.agents/skills/`**, which Codex reads, with a symlink `.claude/skills → ../.agents/skills` for Claude Code. Codex follows symlinks.
- **Keep `AGENTS.md` short**, like a table of contents. Codex caps the combined AGENTS.md chain at 32 KiB, and short files are better for context anyway.
- **MCP:** the repo-knowledge service (Phase 3) is an MCP server, so both CLIs use the same one.

---

## 3. Mission lifecycle

### 3.1 Greenfield app

```
INTAKE (your 1–10 sentence idea)
  └► SPEC (architect, high): ambitious-but-bounded spec + feature_list.json
        each feature: id, user story, acceptance checks (unit / e2e / visual), priority, deps
  └► ◆ GATE A (reviewer, other family): spec + plan review, no code yet
  └► INITIALIZER (engineer): house stack scaffold, AGENTS.md, init.sh, ./mc-verify,
        unit test runner, Playwright smoke test, lint/typecheck, seed data, first commit
        exit criterion: ./mc-verify green on the empty app
  └► FEATURE LOOP (below), in dependency order, parallel where deps allow
  └► ◆ GATE C: full diff vs spec review + full e2e suite + screenshots
  └► MORNING REPORT + PR (or branch) for you
```

- **House stack.** You pick it once, for example Next.js + TypeScript + SQLite/Postgres + Playwright. A known stack means the planner wastes no tokens on stack debates, the playbook accumulates stack-specific lessons, and verification is predictable. The architect may deviate only with a written reason in the spec.
- **Anthropic's harness numbers** ([Mar 2026](https://www.anthropic.com/engineering/harness-design-long-running-apps)): a solo run took 20 min and $9 and produced a broken app. Planner + generator + Playwright evaluator took 6 h and $200 and got the core working. The evaluator "identified legitimate issues, then talked itself into approving". That is why the gate is **executable checks first, LLM opinion second**.

### 3.2 Feature in an existing repo

ONBOARD → SPEC → GATE A → FEATURE LOOP → GATE C → REPORT.

ONBOARD runs once per repo and is refreshed incrementally:
- detect stack and commands
- write `./mc-verify`
- write `AGENTS.md` if missing
- run the suite to record the **baseline of already-failing tests**, so they are not blamed on us
- build the repo map

### 3.3 Feature loop (per unit)

```
BRIEF ─► BUILD (engineer or mechanic) ─► VERIFY (./mc-verify scoped + frozen-file check + anti-cheat)
   pass ─► REVIEW (read-only, other family, schema'd findings) ─► fixes? ─► VERIFY (max 2 rounds)
        ─► MERGE into mc/<mission>/integration ─► regression suite
   fail ─► ladder: same model @high (fresh context + failure digest)
                 ─► other family's engineer (fresh perspective, separate quota)
                 ─► GATE B: architect diagnosis → hint | split | re-plan
                 ─► BLOCKED (keep doing other units; goes in the morning report)
```

**Switching providers is a rung on the ladder.** A second model family fails differently. It also draws from a different quota pool.

---

## 4. Quota governor

Each provider has a state machine:

```
OK ─► THROTTLED (transient 429/overload: backoff 30s→5m with jitter, same provider)
OK ─► LIMITED(kind, resetsAt)  kind ∈ {session, weekly, model:<name>, spend}
        model-specific  → try the same provider with another model (e.g. Opus limit → Sonnet), if the role allows
        session/weekly  → failover provider if profile allows, else park role until resetsAt + jitter
        all providers limited → Dispatcher sleeps until the earliest resetsAt; state is in SQLite, so a reboot is safe
```

- **Limit signals:**
  - Claude: `rate_limit_event.resetsAt` in stream-json, or the text form `You've hit your … limit · resets <time>`. `--fallback-model` does *not* trigger on usage limits, so the governor switches models itself.
  - Codex: `account/rateLimits/read` via app-server (`usedPercent`, `resetsAt`), or a fallback parse of exit 1 + "Try again at <local time>".
- **Usage ledger:** per run, record provider, model, effort, tokens, est. cost, and wall time. Per night, the share of weekly limit used is *estimated* from token totals against calibrated plan budgets.
- **Pacing:** stop starting new non-critical work when a provider's estimated weekly share for tonight exceeds `max_weekly_share_per_night`. That keeps your daytime interactive use alive.
- **Never resume a session after a long sleep.** The cache is cold, so start a fresh session from the ledger. Resume only within a few minutes.

---

## 5. Overnight operations

| Concern | Decision |
|---|---|
| **Where it runs** | An always-on Linux box: a small VPS (2–4 vCPU, 8 GB) or a home machine. Laptops sleep. Claude cloud routines are an option for Claude-only missions but can't host Codex easily (no `api.openai.com` on the default network allowlist). |
| **Isolation** | One disposable container per mission, running as non-root. It mounts only the mission workspace and the two CLI auth dirs. Outbound allowlist (Anthropic's devcontainer firewall pattern) covering the package registries, Anthropic, OpenAI, and GitHub. No `~/.ssh`, no cloud credentials, no `.env` with real secrets. |
| **Permissions inside the container** | Claude: `--permission-mode auto` first, `bypassPermissions` only in the container. Codex: `--sandbox workspace-write` with no approvals. The container is the real sandbox. |
| **Git safety** | Agents commit to local worktrees only. **The orchestrator alone pushes**, only `mc/*` branches, with a fine-grained token scoped to one repo, contents read/write only, no admin. Server-side branch protection on `main`. No force-push. Shallow clones are forbidden: a real incident had an agent revert from a shallow clone and delete a repo's history. |
| **Loop guards** | Max iterations per unit. Wall-clock cap per unit and per mission. **No-progress detector:** the same failing-test signature hash twice escalates, a third time blocks. A kill-switch file (`touch STOP`). Terse test output (Carlini: print a few lines, log the rest, greppable `ERROR` lines). Agents can't kill the orchestrator: it runs as a separate user and process, which matters because an agent once ran `pkill -9 bash` and killed its own loop. |
| **Crash safety** | All state in SQLite plus git. Every node is idempotent and re-runnable, so `mc resume` continues after a reboot. |
| **From the iPad** | Push notifications via ntfy for done, blocked, all-limited and crash. Happy (an encrypted mobile client for Claude Code and Codex) or SSH (Blink/Termius) + tmux for live intervention. Later: a tiny read-only web dashboard. |
| **Morning report** | Built from git log, `feature_list.json` deltas, test and e2e results, **screenshots** of the app, the usage ledger, and a **"decisions needed"** list. Blocked units come with what was tried and the cheapest next step. Delivered as a markdown file in the repo + a push notification + the PR description. |

---

## 6. What the first overnight run needs (MVP)

**In scope:**
1. `mc` CLI skeleton, config loader with profiles, and SQLite state.
2. `ClaudeRunner`, `CodexRunner`, `MockRunner`, plus a contract test suite that runs on the mock (no quota) and a 2-call smoke test per real provider.
3. Dispatcher state machine for both mission types, with the escalation ladder and loop guards.
4. Verifier: `./mc-verify` convention, frozen-file hash check, anti-cheat diff scan.
5. Workspace manager: worktrees, integration branch, orchestrator-only push.
6. Quota governor: limit parsing, sleep/failover, usage ledger.
7. Reporter: morning report + ntfy.
8. Container image with pinned CLIs and a firewall allowlist.

**Out of scope for now:** repo knowledge graph and file cards, learned router, ACE playbook, dashboard, parallel units. Start with **one unit at a time** (single writer). Add parallel worktrees after a few clean nights.

**First real test:** three small greenfield specs (e.g. a todo app with auth, a markdown notes app, a URL shortener with stats) + three feature tasks on one of them. Run each under the `claude`, `codex` and `mixed` profiles. Compare verified features per night, usage share, and how often you had to fix things in the morning.

---

## 7. Open questions

1. **Where will it run overnight?**
   - (a) A small Linux VPS. Recommended: always on, cheap, reachable from the iPad over SSH or Tailscale.
   - (b) A home computer that stays on.
   - (c) Claude cloud routines, for Claude-only missions.
2. **Which plan tiers?** Claude Pro / Max 5x / Max 20x, and ChatGPT Plus / Pro. This sets the pacing defaults and whether `gpt-6-astra` can hold the reviewer seat.
3. **House stack** for new apps. Default proposal: Next.js + TypeScript + SQLite (Prisma or Drizzle) + Playwright + Vitest.
4. **Where should results land?** A PR on GitHub per mission (needs a repo per app) or a branch you review.
