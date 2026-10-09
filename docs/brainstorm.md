# Mission Control: brainstorm v0

An autonomous "vibe-coding firm": you hand it work, and it runs until the work is **verifiably** done or **honestly** blocked. The goal is full quality at the lowest cost **per verified task**.

Status: brainstorm only. Nothing here is built yet. Every number cites its source. Numbers from Anthropic's internal cost guide are directional.

---

## 1. Fact-checking the X post first

| Claim | Verdict | What is real |
|---|---|---|
| `/advisor`, `claude --advisor opus` | **Real** (experimental) | [code.claude.com/docs/en/advisor](https://code.claude.com/docs/en/advisor). Settings key `advisorModel`. |
| `effortLevel: high` | **Real** | Settings key accepts `low`/`medium`/`high`/`xhigh`. Per-subagent `effort:` in frontmatter. |
| `claude --subagents haiku` | **Not a flag** | Use `CLAUDE_CODE_SUBAGENT_MODEL=haiku`, `model: haiku` in `.claude/agents/*.md`, or `--agents '<json>'`. |
| "Subagent parallel dispatcher pool (3x workers)" | **Doesn't exist** | Real knobs: `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (default 20), `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` (default 3, which is probably where "3x" came from). |
| "JEV micro-fork layer, 1,500 branches in 16 ms" | **Not Anthropic** | Jev is a third-party router (see [Pulumi's jev-router post](https://www.pulumi.com/blog/route-every-claude-code-message-to-the-right-model-with-jev/)). "Micro-fork" appears nowhere. The post reads like an ad. |
| "Opus 5.5 is too expensive to build with, so let Sonnet build" | **Outdated premise** | See section 2. |

**The post's good idea is the three checkpoints:** plan lock, repeated failure, and before done. The post implements them badly, as CLAUDE.md wishes the model may or may not act on. Anthropic measured this: Haiku 5.5 and Sonnet 5.5 executors given an Opus 5.5 advisor tool called it on **none of 198 questions** when not prompted to. The tool definition alone added 12% and 25% to cost. [Source: cost guide.](https://platform.claude.com/docs/en/about-claude/models/optimizing-for-cost-and-intelligence)

**Lesson:** checkpoints must be fired by the harness (code, hooks, graph edges), never left to the cheaper model's judgment. Recognizing the hard case is the very skill the cheaper model lacks.

---

## 2. The economics: what Haiku/Sonnet/Opus 5.5 actually cost

| Model | Input $/MTok | Output $/MTok | Cache read $/MTok |
|---|---|---|---|
| Opus 5.5 | 4.00 | 20.00 | 0.20 |
| Sonnet 5.5 | 2.00 | 10.00 | 0.20 |
| Haiku 5.5 (prompt ≤100K) | **0.10** | **0.50** | ~0.01 (est.) |
| Haiku 5.5 (prompt >100K) | 0.50 | 2.50 | |

Cache writes cost 1.25× input for the 5-minute TTL and 2× for the 1-hour TTL. Caches are **per model**.

Four things fall out of this table:

1. **Opus 5.5 is only about 2× Sonnet 5.5, and cached input is identical.** In agent loops roughly 80%+ of input is cache reads, so the Opus premium falls mostly on output tokens and cache writes.
2. **Cost per solved task beats cost per token.** These are Anthropic's figures on a SWE-bench Pro subset:

   | Configuration | Solved | $ per solved task |
   |---|---|---|
   | Opus 5.5 at `low` effort | 87.4% | $0.12 |
   | Opus 5.5 at `medium` (default) | 92.8% | $0.22 |
   | Opus 5.5 at `high` for everything | 95.3% | $0.29 |
   | **Opus 5.5 at `low`, failures re-run at `high`** | **~97%** | **$0.17** |
   | Sonnet 5 at default | 77.4% | $0.84 |

   Cheaper models take more steps and "fail slowly". In SWE-agent's data, successful runs took a median of 12 steps and $1.21, against an average of 21 steps and $2.52 for failed runs. Nobody has published coding cost-per-solve figures for Sonnet 5.5 or Haiku 5.5, so **your own eval has to decide**.
3. **The best measured trick is an effort ladder, not a model ladder.** Run cheap, let a *real verifier* catch failures, then re-run only the failures at higher effort. It needs a trustworthy failure signal (tests). It costs latency on the failures.
4. **Haiku 5.5 is a different animal from old Haiku.** At 1/20 of Sonnet and 1/40 of Opus, you can afford to run it on everything, all the time. But Anthropic's guidance is "high-volume work with **checkable outputs**", not long agentic loops. Its price also jumps 5× above a 100K-token prompt.
5. **When cheap workers pay, and when they don't.** The evidence splits cleanly:
   - **Pays:** a frontier planner with cheap workers on narrow, well-specified tasks.
     - Cursor's agent swarm rebuilt SQLite in Rust: an Opus 4.8 planner with cheap workers cost **$1,339**, against **$5,153** for Opus alone (self-reported, Jul 2026).
     - Workers used 69–90%+ of the tokens, but the planner was about two-thirds of the bill.
     - A weaker planner made the workers burn more ($2,234). **Spend on the planner.**
   - **Doesn't pay:** a cheap *primary* that decides for itself when to escalate. Cognition paired a small primary with a Sonnet "smart friend": "the quality ceiling was set by the primary" (Apr 2026). This is exactly the X post's design.
   - **Doesn't pay:** work that fits in one context. Anthropic measured that "on work a single model could handle alone, the same model at lower effort was cheaper every time."
   - **Hurts:** sequential work split across agents. Google/DeepMind found multi-agent setups were −39% to −70% on sequential tasks (+81% on parallelizable ones). Independent agents amplified errors 17.2×, against 4.4× with a central orchestrator.

   **Decision boundary:**
   - Small task → one strong model at low effort, no swarm.
   - Big project → strong planner that cuts it into narrow units, cheap workers, harness-driven escalation.

### The Haiku thesis

> **Call Haiku like a function, or hire it with an exact work order. Never make it the manager.**
> - As a function: one shot, input under 100K, schema-validated output, checked by code.
> - As a worker: one narrow unit with exact files, exact spec and its own verification step, a hard turn cap (~15), and escalation fired by the harness, not by Haiku.

When Haiku runs as an open-ended agent, it takes more turns, wanders, and its mistakes get paid for by the expensive model that cleans up after it. When it runs as a function over thousands of items, it does work you would **never pay Opus to do**. That work keeps the expensive model's context small and its turn count low.

That is where the money is. Rough cost of one expensive session:

```
cost ≈ turns × (cached_ctx × $0.20 + new_tokens × write_price + output × out_price)
```

The biggest levers are **turns** and **context length**. Haiku's job is to cut both for Opus/Sonnet: pre-digested briefs replace the 10–20 exploration turns a fresh agent burns orienting itself.

**Where Haiku pays:**
- Per-file "file cards" across the repo, keyed by content hash and recomputed only for changed files. A 2,000-file repo costs well under $1 one time via the Batch API, which takes another 50% off.
- **Re-ranking** a candidate file list for localization. Code generates the candidates (grep, BM25, symbol graph). Haiku filters them in one shot. It never drives graph traversal itself: CodexGraph showed graph tools need a strong model.
- **Clustering** test failures ("200 failures → 3 root causes"). The raw traceback of each cluster is passed through **verbatim**. Never LLM-compress tracebacks.
- Docs and spec extraction, changelog and commit messages, PR descriptions, and diff summaries for the reviewer.
- Classification and routing: task type, risk class, "mechanical or not?".
- Mechanical work units such as codemods, renames, boilerplate from a template, fixtures, i18n, and config, **only** where compile and tests verify the result.
- Retro and playbook curation as overnight Batch jobs.

**Where Haiku loses money:**
- Debugging, architecture, ambiguous specs, or anything where the parent needs the raw context anyway (delegating would duplicate the tokens).
- Long tool loops.
- Any prompt over 100K tokens.

---

## 3. The architecture: a firm as a graph

**Principle:** every decision that needs no reasoning is made in code for 0 tokens. Which node runs next, retry or escalate, whether tests passed, whether we are over budget: all code. Models only run at nodes where judgment is actually required. This is the honest version of the "JEV layer" idea.

### Roles

| Role | Model / effort | Context policy | Job |
|---|---|---|---|
| **Dispatcher** | none (plain code) | — | Runs the state machine, scheduler, budgets, retries, escalation, and stop decision |
| **Architect** | Opus 5.5 · high (where to spend: planner quality sets how much the workers burn) | Fresh. Reads only ledger artifacts. | Intake → spec, acceptance tests, risk class, plan DAG of units sized to fit one fresh context. Owns gates A, B, C. |
| **Engineers** | Chosen per unit by the router. Prior: Haiku 5.5 for narrow or mechanical units, Opus 5.5 · low/medium for standard ones. Sonnet 5.5 only where the eval proves parity. | Fresh session per work unit, own git worktree | Implement exactly one unit |
| **Scouts / clerks** | Haiku 5.5 · low/medium, one-shot | Under 100K, schema output | Index, file cards, re-rank, cluster failures, summarize |
| **QA** | Code first, then an Opus reviewer | Reviewer sees spec + diff only | Build, lint, typecheck, tests, and the anti-cheat scan, then semantic review |
| **Librarian** | Haiku + code | — | Maintains repo knowledge and the playbook (section 4) |

**Fan out reads, keep one writer per branch** (Cognition's lesson). Parallel engineers only work in separate worktrees on unit file-sets the plan declared non-overlapping.

### The graph

```
INTAKE ─► SPEC + ACCEPTANCE TESTS (Architect, high) ─► PLAN DAG
                                                          │
                                   ┌──────────────────────┘
                                   ▼
                     ◆ GATE A: plan review (Opus, fresh context, spec+plan only)
                       "auth invariants? schema contracts? units too big?"
                                   │
           ┌───────────── Dispatcher schedules ready units in parallel ─────────────┐
           ▼                                                                        ▼
   BRIEF (code retrieval + Haiku re-rank → ≤ ~8K token brief)                    (unit n…)
           ▼
   BUILD (Engineer @ low/medium, fresh context, own worktree)
           ▼
   VERIFY (code: build · lint · typecheck · unit tests · anti-cheat)
      pass ─────────────────────────────────────────► MERGE to integration branch
      fail #1 ─► failure digest (parser + Haiku cluster, raw traceback kept) ─► BUILD @ high
      fail #2 (same failure signature) ─► ◆ GATE B: Opus diagnosis
                      "root cause or rabbit hole?" → fix hint | re-plan unit | split unit
      fail #3 ─► unit = BLOCKED (keep going on the other units)
                                   │
                                   ▼
   INTEGRATE (code: full suite, e2e) ─► ◆ GATE C: Opus review of full diff vs spec
                      "hidden regressions? tests weakened? contracts broken?"
                                   ▼
   DONE CHECK (code): every acceptance check green AND gate C approved
      yes ─► RETRO (Haiku, batch) ─► playbook deltas ─► STOP
      no  ─► back to PLAN with the findings (bounded number of loops)
      only BLOCKED left ─► STOP with a crisp blocker report for the human
```

### Escalation ladder

The order is effort first, then model, then human:

`Engineer@low` → `Engineer@high` (fresh context + digest) → `Gate B Opus diagnosis` → `Fable 5.1` (optional, for truly hard units) → `BLOCKED → human`

Each rung fires on a **verifier signal**, never on self-assessment.

### Router that learns

Every unit is logged with `(task_type, files, model, effort) → verified?, $, turns, wall time`. A simple bandit per task type shifts routing toward whichever tier gives the lowest cost per verified unit. It starts with the priors above. The firm gets cheaper with use, and Haiku earns its share of units with data rather than hype.

---

## 4. Memory: context is a cache, disk is the memory

The evidence is blunt. On conversational benchmarks, a plain **filesystem + grep** agent (74.0% on LoCoMo) beat dedicated memory systems like Mem0 (68.5%). For code, the repo, git, and test results are the ground truth. So the memory problem is solved by **never needing long contexts**, not by a fancy vector DB:

- Every session starts fresh and boots from durable state in a few thousand tokens.
- Work units are sized by the planner so one fits comfortably in a single context.
- **If a session needs compaction, the unit was too big.** That should trigger a split, not a summary.

| Layer | Lifetime | Contents | Built by |
|---|---|---|---|
| **L0 Working context** | one session | Brief + the files being edited + recent tool output. Observations older than ~10 turns are masked to a stub + path, which halved cost at equal solve rate in [The Complexity Trap](https://arxiv.org/abs/2508.21433). | harness |
| **L1 Mission ledger** | one mission | `mission.json`: spec, frozen acceptance checks (with hashes), plan DAG, unit status (**only the verifier flips `passes`**), decision log, budget spent. JSON because models tamper less with JSON ([Anthropic long-running harness post](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)). | Architect + Dispatcher |
| **L2 Repo knowledge** | per repo, incremental by git hash | Deterministic code graph (tree-sitter / LSP symbols + import graph), a ~1–2K-token PageRank **repo map** (Aider-style), Haiku **file cards** (purpose, exports, invariants, gotchas), and a **test map** (which tests cover which files, from coverage). | code + Haiku (batch) |
| **L3 Playbook** | across missions | ACE-style bullets `{id, text, helpful, harmful, scope}`, per repo and global. **Only delta edits by id**. Never re-summarize the whole file: ACE saw "context collapse" from 18K → 122 tokens, with accuracy below baseline. Retrieved per unit, not injected wholesale. | Librarian |
| **L4 Episodic archive** | forever | Full transcripts + telemetry in SQLite. **Never in context.** Mined by retro and the router. | harness |

Stale facts carry a validity window, borrowing Zep/Graphiti's one good idea for code. Example: "`api/v1` is deprecated since commit abc123". Facts are invalidated, not deleted.

---

## 5. Token-efficiency rules (ranked by evidence)

1. **Optimize billed cost per *verified* task.** Failed runs count in the numerator. Token counts mislead: in [2,848 billed Claude Code runs](https://www.alphaxiv.org/abs/2607.12161), a compressor that cut tool tokens by 38% *raised* cost by 6.8%, because cache reads plus writes were ~80% of the bill.
2. **Prompt cache discipline is the #1 free win.**
   - Each role gets a frozen, byte-stable prefix: sorted tools → system prompt → conventions → repo map, then the task brief *after* the breakpoint.
   - All parallel engineers share one prefix, so they share one cache.
   - No timestamps in prompts: one 25-token timestamp took a run from $0.59 to $4.24.
   - Append-only history.
   - Never switch model or effort mid-session.
   - Alert when the cache-read share drops below ~80%.
3. **Use the effort ladder before the model ladder** (section 2).
4. **Cut turns.**
   - Pre-localized briefs.
   - A good agent-computer interface: SWE-agent found a 100-line viewer beat both 30 lines and whole files, summarized search beat iterative search, and lint-gated edits added 3 points.
   - Test wrappers return compact, *deterministically parsed* failures.
5. **Mask, don't summarize.** Summarize rarely, in bulk, and only near the limit.
6. **Hard caps everywhere:** turns per unit, $ per unit and per mission (`--max-budget-usd` / `maxBudgetUsd`), wall clock, and stall detection (same failure signature twice → gate B).
7. **Use the Batch API (−50%)** for anything not on the critical path: re-indexing, file cards, retros, playbook curation.
8. **Skills over system-prompt bloat.** Repo procedures (build, test, migrate, release) become skills that load on demand. Their scripts run without entering context.
9. **Best-of-N only with an executable selector,** such as a reproduction test that fails before the fix and passes after. Otherwise prefer sequential escalation.
10. **LLM judges are tie-breakers, not gates.** All 26 judges in CodeJudgeBench swung up to 14 points on response order alone. If you use one, run it in both orders.

---

## 6. "Only stops when done": making done machine-checkable

- **Definition of done = executable acceptance checks** (tests, scripts, e2e) written by the Architect *before* building. Their hashes are stored in the ledger.
- **Builders can't move the goalposts.**
  - A `PreToolUse` hook denies engineer edits to frozen acceptance files.
  - Changing them requires a spec amendment approved at a gate.
  - An anti-cheat scan in VERIFY flags new `skip`/`xfail`, deleted asserts, `assert True`, widened tolerances, and mocked-out subjects under test.
- **Two-stage review per unit** (from Superpowers): first "does it meet the spec?", then "is the code good?". The reviewer starts with **no shared context**. Devin Review's fresh-context reviewer catches about 2 bugs per PR.
- **A Stop or TaskCompleted hook enforces it inside Claude Code.**
  - `Stop` / `SubagentStop` hooks can block stopping (exit 2 or `decision: "block"` + reason) while the ledger has open units.
  - Note `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, default 8 consecutive blocks. The outer loop must live in the Dispatcher anyway.
- **The outer loop lives in code** (the "Ralph" pattern): while not done and budget remains, spawn the next fresh session from the ledger.
- **"Done" includes "honestly blocked".** Circuit breakers stop the burn and emit a blocker report saying what's missing, what was tried, and the cheapest next step for a human. This matters because agents succeed quickly and fail slowly.

---

## 7. Implementation path

**Phase 0: eval harness first (non-negotiable).**
- Pick 20–40 real tasks from your own repos, each with a hidden test that decides pass/fail.
- Track pass rate, $ per verified task, turns, wall time, cache-read %, and how many fixes a human had to make.
- **Baseline: plain Claude Code, Opus 5.5 at medium, one session.** It is a strong baseline, and every piece of Mission Control has to beat it on cost per verified task or get cut.

**Phase 1: Claude Code native, no custom runtime.** Fastest way to test prompts and roles.
- `.claude/agents/`:
  - `scout.md` (`model: haiku`, `effort: low`, read-only tools)
  - `engineer.md` (`model: opus`, `effort: medium`, `isolation: worktree`)
  - `reviewer.md` (`model: opus`, `effort: high`, read-only)
- Hooks:
  - Stop gate on `mission.json`
  - `PreToolUse` protecting frozen tests
  - `PostToolUse` lint-on-edit
- A Claude Code **Workflow** script (`agent()` / `pipeline()` / `parallel()`) to express the graph natively.
- Skills for repo procedures.
- For L1, consider Beads (a git-backed issue DAG) instead of a homemade `mission.json`.

**Phase 2: own orchestrator on the Claude Agent SDK (TypeScript).**
- Explicit state machine, worktree scheduler, and budgets.
- SQLite telemetry (L4) and a router.
- Each node is a `query()` call with a pinned model, effort, tools, and prompt prefix.

**Phase 3: repo knowledge service (L2).**
- tree-sitter index, repo map, file cards, and test map, exposed as an MCP server or skill scripts.
- Incremental by git hash. Nightly Batch refresh.

**Phase 4: learning loop.**
- ACE playbook curation from retros.
- Bandit router by task type.
- Automatic regression check of the firm itself against the Phase 0 eval on every change to prompts or graph.

---

## 8. Prior art worth stealing

**A warning first:** mini-swe-agent, about 100 lines of bash-only scaffold, scores over 74% on SWE-bench Verified. With frontier models, scaffold complexity buys little. Every box in section 3 must earn its keep on the Phase 0 eval.

Star counts are popularity, not proof. Almost none of these publish controlled benchmarks.

| Project | Core idea | Steal |
|---|---|---|
| [Anthropic long-running harness](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | An initializer writes `feature_list.json` (all `passes:false`), a progress file and `init.sh`. Each fresh session builds one feature end to end. | The whole L1 ledger pattern |
| [Ralph loop](https://ghuntley.com/ralph) ([snarktank/ralph](https://github.com/snarktank/ralph)) | A bash `while` loop starting a **fresh process** every iteration. Memory = specs + fix_plan + git. | The fresh process per iteration (the same-session Stop-hook plugin variant gets criticized for bringing back context rot) |
| [Superpowers](https://github.com/obra/superpowers) | Brainstorm → design → 2–5 min tasks with exact files and a verification step. Fresh subagent per task. Enforced TDD. | The two-stage review: spec compliance, then quality |
| [GSD](https://github.com/open-gsd/gsd-core) | Discuss → Plan → Execute → Verify → Ship. Parallel "waves" of fresh-context executors. | A plan-check that confirms each plan fits one fresh context |
| [BMAD-METHOD](https://github.com/bmad-code-org/BMAD-METHOD) | PM/Architect personas, then a Scrum Master writes self-contained story files | Context-sharded story files, which are the "brief" here |
| [Gas Town](https://github.com/gastownhall/gastown) + [Beads](https://github.com/gastownhall/beads) | A Mayor dispatches to short-lived workers. A Refinery agent owns the merge queue. Beads is a git-backed issue dependency graph (`bd ready`). | Beads as a ready-made L1 ledger, and a dedicated merge-queue node |
| [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | An "ultrawork" mode that won't stop with open todos. A cheap "kibitzer" model watches the main agent for repeated mistakes. | The kibitzer: Haiku watching for loops is a good function-style job |
| [Aider architect/editor](https://aider.chat/2024/09/26/architect.html) | A strong model reasons, a cheaper model writes the edits. Measured gains (e.g. 85.0% vs 79.7%). | Split reasoning from edit-writing |
| [claude-code-router](https://github.com/musistudio/claude-code-router) | Routes requests by **type** (background / think / long context) | Route by request type, not by persona |
| [spec-kit](https://github.com/github/spec-kit) | constitution → specify → plan → tasks → implement | Only `/analyze`, the artifact cross-check. Skip the "sea of markdown". |
| [OpenHands](https://github.com/OpenHands/OpenHands) | Event-stream state, a sandboxed runtime, a condenser | The event log, for replay and resume (L4) |
| [vibe-kanban](https://github.com/BloopAI/vibe-kanban), [claude-squad](https://github.com/smtg-ai/claude-squad) | One worktree and branch per agent, human diff review | The worktree-per-unit UX |
| [Serena](https://github.com/oraios/serena), GitNexus, claude-mem, ruflo/claude-flow | LSP tools, code graphs, compressed memory, consensus swarms | **Skeptical until measured.** Serena's tool definitions alone are about 24K tokens. ruflo's 84.8% SWE-bench claim has no leaderboard entry. |

**Failure modes to design against:**
- **MAST** (1,642 multi-agent traces): 44% system design, 32% inter-agent misalignment, 24% verification (stopping early, weak checks).
- **Cursor:** file locks made 20 agents perform like 2–3, and flat swarms avoided hard tasks. It got better with a planner/worker/judge hierarchy plus periodic fresh starts.
- **Carlini's C compiler** (16 agents, about $20K): "the verifier must be nearly perfect, otherwise Claude will solve the wrong problem."

---

## 9. Open questions for you

1. **Subscription or API key?**
   - With a Claude Max subscription, the constraint is usage limits, not dollars, and the main session gets a 1-hour cache TTL.
   - With the Agent SDK + API key, you pay per token but get full control (Batch API, advisor tool, task budgets).
   - This changes which levers matter most.
2. **What kind of work, mostly?** Greenfield apps, features in existing repos, bug fixing, or non-code work? The graph above is tuned for code with tests. Work without an executable verifier needs a different "done" contract.
3. **How autonomous?** Fully hands-off overnight runs, or a human gate at A (plan) and at the end?
4. **Which language and stack** for the orchestrator itself? TypeScript has the more complete Agent SDK (SessionStart/SessionEnd hooks, Workflow tool).
