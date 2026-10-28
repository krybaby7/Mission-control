# Mission Control: handoff to the local agent

Written 28 October 2026 by a cloud Claude Code session, for the Claude Code agent that will now work on Mission Control on the owner's own PC. You cannot read the owner's earlier cloud chats, so this file carries what they held: what the product is, what exists, what was tried for real, what the owner wants, what was decided and why, what is broken or missing, and what to do next.

Read it all once. Then read the files it points to before you change anything. Where this file and the code disagree, the code wins; where this file and a later commit disagree, the later commit wins.

---

## 0. The short version

- **What it is.** Mission Control (`mc`) is a TypeScript program that runs a small team of AIs to get software jobs done for a non-technical owner. It drives the official **Claude Code** and **Codex** command-line programs, using the owner's own subscriptions (not API keys), inside a Docker container on the owner's Windows 11 PC (WSL2 Ubuntu + Docker Desktop). Code makes every mechanical decision (what runs next, retries, escalation, budgets, whether checks passed); the AIs only do the work that needs judgment.
- **Where the work is.** The current code is on branch **`feat/any-task`** (last commit `ad0eae3`, 16 Oct 2026). `master` is far behind (the MVP of 11 Oct). Nothing has been merged to `master`. This handoff file lives on branch `claude/lucid-gauss-nxcanf`, which is `feat/any-task` plus this file and nothing else.
- **State.** Built and heavily tested with stand-in AIs: on 28 Oct 2026, `npm run check` on `feat/any-task` passed with a clean typecheck and **91 test files, 5,653 tests passed, 1 skipped**, and `npm run build` passed. Ten small **real** runs with a real Claude were made in a cloud machine (2 on 12 Oct, 8 on 16 Oct). **Nothing has ever run on the owner's PC**, no job has run inside Docker, Codex has never done a job (one tiny test call to GPT-6.1 Sol worked on 11 Oct), and nothing has gone to real GitHub or through the leader chat.
- **Your advantage.** You are on the PC. Everything the cloud sessions could not try (Docker Desktop, WSL, Windows paths, Codex, real GitHub, the iPad, Claude Code permission prompts, the leader) you can try with the owner. That is the most valuable work left.
- **First job.** Walk the owner through [`docs/owner-trial-checklist.md`](owner-trial-checklist.md), steps 1 to 3 first. Stop at the first failure, diagnose it, fix it on the branch, and carry on.
- **Open decisions.** Five questions to the owner were never answered (section 6.2a). The main one: since 16 Oct the owner has been asked whether to open a pull request from `feat/any-task` to `master`. Do not open or merge one without the owner's clear yes.

---

## 1. Who you work for, and how

The owner is a **non-technical CEO**. They read answers at a glance, often on an iPad or phone. They are not at the keyboard most of the time, and they will test things themselves on their PC.

Rules that every earlier session followed, because the owner asked for them or approved them:

1. **Plain words in everything the owner can read** (command output, docs, the leader's text, the dashboard, your chat replies): short sentences, no jargon, no em-dash asides, curly quotes around titles (“Habit tracker”). Say "feature", never "objective".
2. **No "night / tonight / overnight / morning" framing.** The project began as an overnight team, but the owner said they are not testing anything with nights. Say "run". The engine still writes some "night" words internally and in old file names (`night-<date>.md`); new owner-visible text uses "run" (`run-<date>.md`, "Run finished", "Run summary").
3. **Honesty with three levels.** Always say which of these a claim is: **tried for real** (a real AI did it), **tested here only** (stand-in AIs and automated tests), or **not tried**. Never say something works unless it ran. For work no test checked, never say "tested"; say "checked by a second AI against your list" and "approved by you" (never "you looked at it": the log records an approval, not a look). When the owner asks "why", answer straight.
4. **Do not stop to ask** unless the decision is truly the owner's: spending allowance on real runs, money outside the plan, deleting data, merging to `master`, anything outward-facing (GitHub pushes, pull requests). For everything else, take the safe default, record it, and list it in your report. If one question blocks you, ask once, then carry on with what does not depend on it.
5. **Never touch `master`/`main` directly.** Work on a branch. Push only your branch. Do not open a pull request unless the owner asks.
6. **Backward compatibility is the top engineering rule.** A mission queued the old way must behave and log exactly as before. Never weaken an existing test; list every existing test you change and why.
7. **Design before build for anything new**: a spec in `docs/`, adversarial review, then build from the spec. Prove risky assumptions with a cheap spike first (the plan format changed from JSON to plain lines because a spike showed Claude Code blocks commands containing a curly bracket followed by a quote).

---

## 2. The product

### 2.1 The parts, and who talks to whom

```
 Owner / CEO  ── chat (PC, or iPad via Remote Control) ──►  Leader  (Claude Code session in leader/)
     ▲  ▲                                                      │  acts ONLY through scripts/mc-docker.sh
     │  │                                                      ▼
     │  └── reads (never writes) ──  Dashboard (mc dashboard, :8787, own read-only container)
     │                                     ▲ reads the engine's files
     │                                     │
     │   ┌──────────── Docker container "mission-control:local" (user pwuser, no GitHub login) ─────────┐
     │   │  mc (engine): Dispatcher state machine · RoleExecutor · QuotaGovernor · Verifier · Reporter    │
     │   │     ├─ ClaudeRunner → `claude -p … --output-format stream-json`  (Claude Code 2.1.295 pinned)  │
     │   │     └─ CodexRunner  → `codex exec --json …`                      (Codex 0.162.0 pinned)       │
     │   │  volumes: mc-claude, mc-codex (logins) · mc-home (~/.mission-control state) · mc-browsers      │
     │   │  bind mount: ~/mc-apps  ← the apps; each job's work lands on branch mc/<mission-id>             │
     │   └──────────────────────────────────────────────────────────────────────────────────────────────────┘
     │
     ├── ntfy push to the iPad: run finished, stuck, needs you, login expired, crashed
     └── GitHub, on the PC side only, with the owner's own `gh` login:
           mc get <owner/repo>  → clone into ~/mc-apps
           mc publish <mission> --to <owner/repo> → push mc/<id> only, open a DRAFT pull request
```

- **The engine** (`src/`) is the product. It is deterministic code; AIs are called at fixed points with fixed prompts (`prompts/*.md`) and strict JSON output schemas (`src/schemas.ts`).
- **The leader** (`leader/CLAUDE.md`, `leader/.claude/settings.json`) is the CEO's hands: a Claude Code session started in `leader/` that turns plain requests into `mc` commands (15 of them). It may run `status`, `logs`, `report`, `plan preview`, `plan show`, `publish-preview` freely; `run`, `stop`, `new`, `feature`, `plan queue`, `approve`, `send-back`, `get`, `publish` always prompt; Edit, Write and git are denied. **It has never been run with a person.**
- **The dashboard** (`src/dashboard/`, `dashboard/index.html`) is the CEO's eyes: a read-only web page (lamp, Needs you, Timeline, Results, allowance) built only from files the engine already writes. "Tell the leader" buttons only produce a sentence to paste into the leader chat; the page sends nothing. `dashboard/demo.html` shows ten sample states offline.
- **The wrapper** `scripts/mc-docker.sh` is what the owner types as `mc` in Ubuntu. It builds the image, logs in, runs `mc` in the container with limits (`--cap-drop ALL`, `no-new-privileges`, pids 8192, memory 75%), and hosts the PC-side commands (`get`, `publish-preview`, `publish`, `dashboard`, `leader`, `install-leader`, `copy-reports`, `shell`).

### 2.2 What happens to one job (a "mission")

Stages, in order (`src/dispatcher.ts`, one mission at a time, one feature at a time):

1. **onboard** (changes to an existing app only): the architect reads the repo and returns the verify commands; the baseline is run and existing failures are recorded so they are not blamed on the team.
2. **spec**: the architect writes a plan of small, independently testable features (1 to 25) with acceptance checks and a UI contract. Or the **leader wrote the plan** (`mc plan queue`, format `mc-plan 1`), which skips this call.
3. **gate A**: a second AI reviews the plan; it may ask the planner to revise it.
4. *(stop for the owner's look at the plan: always for leader-written plans, or with `--checkpoint plan`)*
5. **init** (new apps only): scaffold the house stack (Next.js + TypeScript + Tailwind + SQLite/Drizzle + Vitest + Playwright) until its checks pass.
6. **features**, each in its own git worktree, by check mode:
   - **`tests`** (default): a test author (other AI family in the `mixed` profile) writes acceptance tests that must **fail first**, they are **frozen** (hashed), the engineer builds until they and the full checks pass. Frozen files and check scripts are restored if touched; an anti-cheat scan rejects `.skip`, `.only`, weakened asserts, changed test discovery.
   - **`review`**: no tests. A builder makes the deliverable, Mission Control's own **scripted checks** run (files exist, links, headings, word counts, CSV columns and rows, no placeholders, no keys, page title and phone layout), the page is **photographed** at 390 and 1280 px, then a **second AI judges every written check** as pass / fail / cannot judge, with evidence the engine verifies (quotes must exist in the files).
   - **`owner`**: `review`, then a stop for the owner's look before the feature is added. Only a command-line flag can skip it, never the plan.
   - **Escalation when a build fails**, fired by the verifier, never by the AI: same model with more effort → architect diagnoses (hint, amend a wrong test, or block) → the other family's frontier model → **blocked** (other features carry on; dependents are skipped).
   - A read-only **reviewer** (other family) checks the passing work; blocker/major findings go back for up to 2 fix rounds. Then the feature merges into the mission's integration branch.
   - *(optional stop before each feature is added: `--checkpoint feature`)*
7. **gate C**: full checks plus a final review of the whole diff; one repair round if needed.
8. *(optional stop before finishing: `--checkpoint final`)*
9. **finalize**: report (plain language, screenshots, “How to try it”, “Needs your decision”, usage), phone notice, branch `mc/<id>`. For a new app `main` is fast-forwarded to the result; for an existing app `main` is never moved.

The owner answers a stop with `mc approve <id>` or `mc send-back <id> --note "..."` (at most two send-backs per stop; a third ends the work there and says so). Answers can only be recorded while no run is going; the mission continues on the next `mc run`.

### 2.3 Roles, models and profiles

| Role | Default tier and effort | Job |
|---|---|---|
| architect | frontier, high | onboard, plan, diagnosis |
| test author | standard, high | acceptance tests (tests mode) |
| engineer | climbs a ladder: standard/medium → standard/high → diagnose → frontier/high (other family) → frontier/high | builds |
| reviewer | frontier, high, read-only | plan review (gate A), feature review, final review (gate C), the second AI in review/owner modes |
| scout | light, low | context packs, failure digests, report prose |

| Tier | Claude | ChatGPT / Codex |
|---|---|---|
| frontier | `claude-opus-5-5` | `gpt-6-astra` |
| standard | `claude-sonnet-5-5` | `gpt-6.1-sol` |
| light | `claude-haiku-5-5` (always; **never GPT Luna**, by the owner's rule) | not used |

Profiles: **`mixed`** (default: Claude plans and reviews, Codex builds, so both subscriptions share the load and every review is cross-family), **`claude`** (Claude only), **`codex`** (Codex for every role; light work still on Haiku). Per-feature `effort` (`light`, `standard`, `deep`) in a plan shifts tiers; `deep` uses `xhigh`, never `max`; `ultra` is never used.

### 2.4 Guardrails (all tested with stand-ins; none has met a real limit or a real crash)

- **Billing protection:** API-key variables are scrubbed before every run; Claude runs ignore settings files and MCP servers; a login that would bill API credit or paid extra usage stops the run. The owner must never set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`.
- **Pacing:** new work pauses at 85% of the weekly limit, 97% of the 5-hour window, and when one run has used 35% of the week (`config.pacing`). Limits fail over to the other family or wait for the reset.
- **Resume anywhere:** every step is saved (`mission.json`, `events.jsonl`, `usage.jsonl`, `quota.json`, `dispatch.json` under `~/.mission-control`). A crash, a reboot or `mc stop` loses only the AI step that was running.
- **One run at a time:** a run lock; the run container has a fixed name.
- **Git safety:** agents are told never to push, and the container holds no GitHub login (unless the old, off-by-default `git.push` setting is turned on with a token in the app folder). Mission Control pushes only `mc/*`, never with force, never `main`; `publish` runs on the PC from a clean copy, with hooks off, to the one repository the app was set up for.
- **Container limits:** see 2.1. Agents can still reach the internet and read the CLI logins (see section 7).

---

## 3. What exists, and where

### 3.1 Branches (GitHub `krybaby7/Mission-control`)

| Branch | Head | What it is |
|---|---|---|
| `master` | `8342744` (11 Oct) | The MVP: engine, runners, quota, dispatcher, CLI, Docker, Windows guide. 32 test files, 1,672 tests pass (checked 28 Oct). Its README still says "not yet run against your real subscriptions". |
| `wip/build` | `22e668f` (10 Oct) | An old snapshot during the MVP build. Superseded. The owner asked on 11 Oct for it to be deleted. |
| `wip/ceo-dashboard` | `9c2c38b` (11 Oct) | An old snapshot of the dashboard spec. Superseded. |
| `feat/ceo-dashboard` | `ed0aa4e` (11 Oct) | `master` + dashboard + leader. Contained in the next two. |
| `feat/checkpoints` | `15d218d` (15 Oct) | + checkpoints, leader-written plans, the next-steps brief. Contained in `feat/any-task`. |
| **`feat/any-task`** | **`ad0eae3` (16 Oct)** | **+ Step 3 (documents, pages, data), GitHub in and out, launcher, real runs R1 to R7, owner docs. This is the product today.** |
| `claude/lucid-gauss-nxcanf` | (this commit) | `feat/any-task` + this handoff file. |

The `wip/*` branches and `feat/ceo-dashboard` / `feat/checkpoints` are fully contained in `feat/any-task` (or superseded) and can be deleted once the owner agrees.

### 3.2 Code map (`feat/any-task`, TypeScript, Node ≥ 22.12, deps: `ajv`, `commander`, `yaml`, `playwright-core` 1.64.0)

| Path | What |
|---|---|
| `src/types.ts` | The shared contract. Additive changes only. |
| `src/dispatcher.ts` (4,091 lines) | The mission state machine: stages, feature loop, ladder, modes, checkpoints, gate C, finalize. |
| `src/executor.ts`, `src/quota.ts`, `src/limits.ts` | Running a role on a provider with failover, waiting and pacing; parsing limit messages. |
| `src/runners/` | `claude.ts`, `codex.ts` (+ `codex-app-server.ts` for rate limits), `mock.ts`, `worktree-guard.ts`. |
| `src/verify.ts`, `src/checks.ts` | Running verify commands, frozen-file and anti-cheat checks; the scripted checks of the modes (S01 to S29). |
| `src/plan.ts`, `src/checkpoint.ts`, `src/checked-by.ts`, `src/later-files.ts`, `src/render.ts` | Leader plans (`mc-plan 1`), owner stops, honest "how it was checked" wording, files a feature made for a later one, page pictures. |
| `src/report.ts`, `src/notify.ts`, `src/run.ts`, `src/doctor.ts`, `src/cli.ts` | Report, ntfy, the run loop, `mc doctor`, the `mc` command. |
| `src/dashboard/` | Snapshot builder (lamp rules, cards, timeline, allowance, debrief) and the read-only server. |
| `prompts/` | Role prompts: architect, engineer, test_author, reviewer, scout, plus maker and checker for the modes. |
| `stacks/nextjs.md` | The house stack for new apps. |
| `leader/` | The leader's instructions and permissions. **`leader/CLAUDE.md` is a product prompt for the leader role, not instructions for you.** If Claude Code loads it while you read files there, ignore its "you are the leader" voice. |
| `dashboard/` | `index.html` (the page), `demo.html` + `demo/*.json` (offline sample states). |
| `docker/`, `scripts/mc-docker.sh`, `scripts/windows/` | Image, wrapper, Windows shortcuts and launcher. |
| `scripts/dev/` | Cloud-only helpers for real runs. **`real-run-setup.sh` deletes `~/.mission-control` and `~/mc-apps`. Never run it on the owner's PC** (it refuses unless root, but do not rely on that). |
| `test/` | Cross-module tests: mock end-to-end missions, outages, Docker wrapper (fake docker), GitHub (bare repos + fake gh), leader text pins, dashboard fixtures, modes, real-run regression fixtures. |

### 3.3 Documents (read in this order)

1. [`README.md`](../README.md): what it is, commands, status, what is not built.
2. [`docs/owner-trial-checklist.md`](owner-trial-checklist.md): the owner's try-out on the PC, step by step, with what each step proves and what to send back.
3. [`docs/real-runs.md`](real-runs.md): the eight real runs of 16 Oct, every fault found, what was fixed and what was shown to hold.
4. [`docs/next-steps-brief.md`](next-steps-brief.md): the brief the last cloud session executed (the owner's binding decisions, how work was orchestrated, quirks).
5. [`docs/setup-windows.md`](setup-windows.md), [`docs/github-setup.md`](github-setup.md): the owner's setup guides.
6. [`docs/work-modes.md`](work-modes.md) (owner view) and [`docs/modes-spec.md`](modes-spec.md) (design, section 22 = where the build differs).
7. [`docs/leader.md`](leader.md), [`docs/plans-spec.md`](plans-spec.md), [`docs/checkpoints-spec.md`](checkpoints-spec.md), [`docs/dashboard-spec.md`](dashboard-spec.md).
8. [`docs/mvp-spec.md`](mvp-spec.md) (the engine contract and the decision log), [`docs/design-v1.md`](design-v1.md), [`docs/brainstorm.md`](brainstorm.md) (the research and economics behind it all).
9. [`docs/dev-real-run.md`](dev-real-run.md): how real runs were made in the cloud.

Two pages outside the repo (private claude.ai artifacts of the owner): the roadmap of 16 Oct, https://claude.ai/artifact/A2Siyxoa7C6JFu6548bMjA, and the visual overview written with this handoff (link in the owner's chat of 28 Oct).

---

## 4. Evidence: what is proven, and how well

| Thing | Tried for real (real Claude, cloud machine, tiny app) | Tested here only (stand-ins) | Never tried |
|---|---|---|---|
| Change an existing app, tests first | yes (R1, R5, R6, R7) | yes | on the PC, in Docker |
| Build a new app from nothing | | yes | **yes, never with a real AI** |
| Leader-written plans, plan stop, same-plan guard | yes, plans written by hand by a tester | yes | **the leader writing a plan** |
| Owner stops: approve, send-back with note | yes (R2, R4, R6, R7) | yes | a second send-back, a send-back at the plan |
| Writing / docs checked by a second AI | yes (R2, R6, R7) | yes | a docs-only folder |
| Web page with pictures | yes (R3, R3b), Claude only | yes | the browser inside the Docker image; Codex looking at pictures |
| Data: script with tests + described CSV | yes (R4) | yes | `.xlsx` output |
| GitHub get / publish | against a local stand-in and fake `gh` (R5, R6) | yes | **real GitHub, real `gh`** |
| Codex as builder, reviewer, or anything | one tiny test call to GPT-6.1 Sol (11 Oct), no job | yes | **a real Codex job** |
| Usage limits, failover, waiting, 85% pause | | yes | yes |
| Crash and resume | planned stops only | yes | a real crash |
| Docker image, WSL, Windows paths, iPad, ntfy, shortcuts | | fake docker only | **yes** |
| Dashboard | | yes, on fixtures captured from the real engine | opened during a real run; iPad Safari |
| Leader chat and Claude Code permission prompts | a non-interactive spike only | text pinned by tests | **yes** |

**Real-run numbers (16 Oct):** 8 runs, 9 missions, 88 AI calls, about $3.95 at Mission Control's own list-price estimate (not what a plan charges). One-feature jobs took 7 to 8 calls and 65 to 90 seconds; two-feature jobs with a send-back took 13 to 15 calls and 2 to 3 minutes. On the test account the weekly reading went from 23% to 31% across all eight runs (other use is mixed in; a small job moved it 1% or less). Earlier real runs on 12 Oct (run A, two features: 14 calls, $0.87; run B, one feature: 9 calls, $0.47) are in `docs/plans-spec.md` section 2.

**Faults found by real runs:** 40 (6 major). 35 fixed, 2 partly fixed, 3 not fixed. 15 fixes were shown to hold by a later real run; 20 were tested here only. Details and what remains: section 7.

---

## 5. How we got here

| Date | Session (cloud chat) | What happened |
|---|---|---|
| 9 Oct | “Vibe coding firm architecture” (iPhone/iPad) | Fact-check of an X post about `/advisor` and Haiku subagents; the economics of Opus/Sonnet/Haiku 5.5; brainstorm (`docs/brainstorm.md`); design v1 for two subscriptions and overnight work; owner decisions (PC host, plans, stack, Haiku-only light tier). |
| 9 to 11 Oct | same | MVP built in waves by parallel agents with adversarial reviewers (about 16 hours, four container restarts): utilities, foundation modules, runners, quota, executor, dispatcher, CLI, Docker, Windows guide; then end-to-end mock missions and a five-lens system review (55 confirmed findings fixed). README. On 11 Oct the setup steps were rehearsed on a cloud Ubuntu machine (the Codex login step was corrected from it) and one tiny test call each to Sonnet, Haiku and GPT-6.1 Sol worked through Mission Control's own code. Ended with the open question of renting a server (6.2a). `master` = this. |
| 11 to 15 Oct | “Mission control next” (iPhone/iPad) | CEO dashboard and the leader; the night framing removed; human checkpoints; leader-written plans (JSON design dropped after the permission spike); two small real runs (12 Oct); `docs/next-steps-brief.md` for the next chat. |
| 15 to 16 Oct | “Checkpoints feature implementation” (desktop) | Wave 1: tidy-ups, same-plan guard, GitHub get/publish, one-click launcher. Step 3 design (two adversarial reviews), build, two verifiers. Wave 3: eight real runs, fixes, owner docs, roadmap page. Ended by asking whether to open the PR to `master`. |
| 21 Oct | “Harness engineering primitives” and “Project overview for CEO” (iPhone/iPad) | Two advice-only chats, both started from `master` (they did not see the newer branch). No code changed, no decision taken. See sections 6.3 and 7.1. |
| 28 Oct | this session | Handoff to the local agent; this file; a visual overview for the owner. |

---

## 6. What the owner wants, in their words

These quotes come from the owner's messages in the cloud chats (typos kept as typed where quoted exactly).

### 6.1 The goal

> “I'd like to do some graph engineering. And create my own vibe coding firm that will basically take on and automate any work I give it and only stop when it's done.” The challenge: “something that is token efficient while keeping the full quality”, with Haiku 5.5 used where it really saves, “not just a scenario where haiku is being used but isn't actually saving”. (9 Oct, the first message)
>
> “1. I have claude and codex subscription. I want to be able to easily switch between the claude subscription with claude models and the codex with gpt models. 2. new apps, features etc. coding related things 3. fully autonomous overnight runs.” (9 Oct; point 3 was later replaced by the run framing below)
>
> “I just want this to be a team that when I ask it to get something done, it does it efficiently and with quality. even if the task is just 2 hour task. im not testing or measuring anything with nights.” (11 Oct)
>
> “I want ANY task to be able to be done on the mission control, as if it is claude code. and have mission control work entirely on github.” (12 Oct)
>
> “what if instead of having a fixed program, the Leader is the one who decides the pipeline when planning. ? so we essentially give control of the engine to the leader. … The leader can decide the pipeline based on each task.” (12 Oct; the compromise built: the leader writes the plan, the engine runs it with its guardrails)
>
> “its okay if the graph stops and prompts me to check something myself then continues after I check” (12 Oct)
>
> “The main orchestrator for me is the leader.” (11 Oct)
>
> “If I give it a small task, will it know how to adapt to it ? or will it be completely overkill ?” (12 Oct; still a fair question, see recommendation 5)
>
> “I did not try it on my pc yet, I want to finish everything then try after we re done.” (15 Oct; this is that moment)
>
> On 21 Oct, asked whether to swap Mission Control for an open-source harness: “I don't mind even losing the 28,000 lines of code if DeepSeek harness can just give us what we need instantly and without hassle, without having to test anything.” (The advice was not to swap: it is a single-agent workbench, a developer preview, and its Claude link goes through the Agent SDK, which has terms-of-service risk on a subscription.) The owner cares about a team that works without hassle, not about the code itself.

The owner also had a real job in mind as a benchmark (12 Oct): a large task in a separate private project (`tameni-map-lab`) that refines a set of 3D landmark models, with a mandatory visual check by the owner and a draft pull request. It was judged too big for a first job and never run. Do not reach into that project without the owner.

### 6.2 Binding decisions (with the question each answered)

| Decision | Question it answered |
|---|---|
| Runs on the owner's Windows PC (WSL2 Ubuntu + Docker Desktop), agents in a container | Where does it run? (A VPS was recommended; the owner chose the PC.) |
| Claude Max 5x + ChatGPT Pro 5x (as of 9 Oct; check if it changed) | Which plans? Sets pacing and whether Astra can review. |
| Subscriptions through the official CLIs, never API keys | Subscription or API? (personal use only; API-key mode would be a config switch if it ever becomes a business) |
| House stack: Next.js + TypeScript + Tailwind + SQLite (Drizzle) + Vitest + Playwright | Stack for new apps? (owner said "anything") |
| Fully autonomous, with optional stops for the owner's look | How autonomous? |
| No night framing; "run" instead | The owner is not testing anything with nights. |
| Step 3 scope: writing and documents, web pages and visual work, data and spreadsheets. Not research with sources | Which non-code work? |
| GitHub in and out on the owner's PC with their own login; no credentials ever in the container | How does work reach GitHub? |
| Parallel features deferred | Build features side by side? (not until real use shows the need) |
| Nothing merged to `master` without the owner | Release? |
| The dashboard has no login; “CEO and others” may see it | Who sees the dashboard, and does it need security? (“No need for security.”) |
| The leader is reached both in the Ubuntu window and in the Claude app (Remote Control) | Where does the owner talk to the leader? (“On Both”) |
| The dashboard needs no engine change | “Why would you need to touch the engine ?” |
| Results land on a local branch `mc/<id>`; GitHub upload happens on the PC, not in the container | How does work leave the PC? (“option A is fine”, later extended to `mc get` / `mc publish`) |
| Run the whole brief autonomously; ask only for decisions that are truly the owner's | 15 Oct: “I am a non-technical CEO and will not be at the keyboard. Only ask me when a decision is truly mine.” |
| Scope gates are the owner's: on 9 Oct, “Once the architecture is built do not implement anything. Stop there.” | Read as: build Mission Control itself, then stop, with no missions and no sample apps until the owner says go. Respect gates like this. |
| Light work is always Haiku 5.5, never GPT Luna: “forget about luna, it is bad, keep it to haiku 5.5 for those kind of tasks” | Which cheap model? (9 Oct, unprompted) |
| Keep Mission Control walled off from the owner's other projects, above all `trade-graph`, which holds exchange and API keys | 11 Oct: Mission Control's agents have full control in their box and must never see those keys. The agreed flow: Mission Control pushes a branch, the owner reviews it, the other system pulls it. |

### 6.2a Questions the owner was asked and never answered

| Asked | Question | Safe default until they answer |
|---|---|---|
| 11 Oct | Run Mission Control non-stop on a rented Linux server instead of the PC? The owner first said “I don t want to have to cap anything, so I ll go with the 8cpu /16gb option”, then asked “What if I go with contabo for the trade graph and hetzner for the Mission Control ?” The assistant endorsed a Hetzner CPX32 (4 CPU, 8 GB, about €36 a month) and offered to write a server setup guide (plain Ubuntu + Docker, no WSL). No answer, nothing bought. | The PC, as all later work assumed. `scripts/mc-docker.sh` should work on plain Ubuntu, but it was never tried there. |
| 11 Oct | Delete the branch `wip/build`? The owner said yes, but that session could not delete branches. It still exists (with `wip/ceo-dashboard`). | Offer to delete both once more; both are superseded. |
| 21 Oct | Self-review gap: A (flag it in the report) or B (pause the feature)? | A. See 7.1 item 0. |
| 21 Oct | Build a “primitives” layer? (advice was no; the owner did not reply) | Do not. Extract the shared attempt sequence only when you touch that code anyway. |
| 16 Oct | Open a pull request from `feat/any-task` to `master`? | Do not open one. Ask again after the first trial steps pass. |

### 6.3 Later questions, 21 October (advice only, nothing changed)

Both chats started from `master`, so they did not see the leader, the dashboard, checkpoints or modes.

- **“Is this harness engineering or rather graph engineering? Or both?”** Answer: both, mostly harness engineering.
- **“Primitives, reusable building blocks: is it worth it for our project?”** Answer: not now. The lower layer is already made of primitives (runners, executor, verifier, git, store, quota, ladders in config). The workflow layer is one hard-wired class. The one cheap change suggested: extract the repeated attempt sequence (run the agent, commit, frozen check, anti-cheat, verify) into one function used by build, init and the fix rounds. Build a full primitives layer only when a second mission kind (a bugfix mission with no test author, a refactor with no spec) or a pipeline set in `config.yaml` is wanted. The owner did not reply.
- **The self-review gap** (section 7.1 item 0): recommended as the one thing to fix before the first real unattended run, with a choice between A (flag it in the report) and B (pause the feature). The owner did not choose.
- **Two small hardening items, never done:** remove every password and token from the agents' environment, not only the billing-related ones; add operating-system file locks on frozen tests as a second layer behind the hash check.
- **Not worth taking from other harnesses:** auto-approve, loop-detection reminders, a sandbox that does not restrict the network. **Maybe later:** a review checklist that learns from the owner's corrections (each change approved by the owner).

### 6.4 How the owner likes to work (seen across the chats)

- Short numbered questions, short answers. The owner often replies “1. … 2. …” or just “go”. Some messages arrive twice because they were resent.
- **Gives reasons, recommends clearly, admits mistakes.** The owner pushes back on defaults that have no reason (“why are things revolving around nights?”, “why did you not recommend data and spreadsheets?”) and valued the honest answer “I had no good reason”.
- **Wants size and time up front** (“how long will this take ? how big is the fix ?”), and checks progress. Past estimates missed both ways, so say how sure an estimate is.
- **Likes a picture.** When lost, the owner asked for “some sort of schema to help me visualize what's been done and what's left”. The roadmap page and the field guide of 28 Oct answer that.
- **Efficiency matters:** changes were wanted “only if they could increase efficiency”.
- **Keep them posted on long work, and ask before a long loop starts again:** “ok just keep me updated”; “if there is sort of review loop taking unnecessary long let me know before restarting any review.” The first build took about 16 hours with four container restarts, and the owner asked “How far are we from finishing ? im wondering what is taking so long ?”
- **They may assume you remember other projects and chats.** You do not; say so, and ask rather than guess.
- **Wants to plan the next steps together**, then let the work run without them. The cloud sessions used “ultracode” (multi-agent workflows with an independent verifier); building that way used a lot of allowance (the weekly reading went from 73% to 81% during Step 2, and the 15 to 16 Oct session cost about $217 at list price on its own, separate from the $3.95 of real runs).
- **The final report the owner expects** has these parts: what you can now do; what was tried for real; what was never tried; choices I made for you; left out on purpose; allowance; first three things to do.

### 6.5 Not to be confused with Control Room

`krybaby7/control-room` is a separate project of the owner (a private planning dashboard with owner briefings for several projects), built from 18 Oct on. It has a screen called “Mission control” since 21 Oct, which is only a name collision. No code or plan is shared, and the owner has said nothing in any chat about merging, freezing or replacing Mission Control. Its own development moved to local agents on 27 Oct, the same way this project is moving now.

---

## 7. Known faults, limits and deferred work

### 7.1 Open faults

0. **Self-review after a failover** (raised in the 21 Oct “Project overview for CEO” chat as the one thing to fix before the first real unattended run; still present on `feat/any-task` by reading the code, not run). Every agent call is made with `allowFailover: true` (`src/dispatcher.ts`, `exec`, about line 898). The test author and the reviewer are chosen as “the other family from the builder” (`assignFor("reviewer", f, f.builtBy …)`, about line 2089), but when that family is at its limit the executor hands the call to the builder's own family. Nothing records which family really reviewed a tests-mode feature, and the report does not say. So in the `mixed` profile, Codex can write the tests for, and approve, its own work, while the README promises the other family. (The `claude` and `codex` profiles never promise another company.) The owner was offered two fixes and has not chosen: **A** keep working and flag every feature that was reviewed by its builder's family in the report, or **B** pause that feature until the other family's limit resets. Default if you must pick before they answer: A, because it loses no work and is honest.
1. **A builder can do the next feature's work** (R4, R6; partly fixed). Briefs now tell the test author and builder to keep to their own feature, and the look/report warn when a feature made a file a later feature's checks name, **but only in missions that have a feature checked by a second AI**. A mission where every feature is checked by tests got no such brief, and no real run had two tests-mode features.
2. **The plan reviewer can still reword or drop the checks of a tests-mode feature** (R4; partly fixed). `mc plan show` and the look list removed and added checks, but this list has never come up in a real run.
3. **A review note answered by a later feature stays open** in the finished report (R7; not fixed).
4. **The AI-written report summary is dropped** when a true sentence contains the word "tests" in a mixed-mode mission (R7; not fixed). The fallback text is true, so nothing misleads.
5. **A backslash followed by `n` in a plan line becomes a line break** (R4; written down as a limit).

### 7.2 Limits by design or deferred

- **Features side by side**: deferred. One loop, one in-memory mission written whole on every save, one lock, one merge line, pacing for one call at a time. Wait for real use.
- **Research with sources**: not covered; plans carry no web addresses and nothing checks a source.
- **A folder that holds only documents** can fail at onboarding or finish with a hollow report. Use an app with code and checks.
- **Pages that need a running server** get no pictures; **no pictures on the dashboard**; **no `.xlsx` inside the engine** (only as a tests-mode script's export); **no Word or PDF**.
- **Security limits** (all written down in the owner docs): the container's outbound network is open (an allowlist was deferred because it would break legitimate builds and ntfy); agents run as the same user as `mc`, so a misbehaving agent can read the CLI logins, change `~/.mission-control`, or forge a checkpoint answer (forgery is loud: a phone notice and a cross-check, but not impossible). The optional host-held approver secret (`docs/checkpoints-spec.md` 8.4) is not built.
- **v1.1 ideas not built**: architect-requested checkpoints; a cheaper "stop only when the reviewer changed the plan" variant.

### 7.3 Things that only the PC can verify (from the specs' own "not verified" lists)

- `docker run --interactive` forwarding a here-document plan through `exec` in `mc-docker.sh`.
- The leader's permission rules in an interactive Claude Code session: does `plan preview - <<'PLAN'` run without a prompt under `leader/.claude/settings.json`? Does `plan queue` prompt exactly once, and how is a long plan shown? Plans with apostrophes, double quotes, backslashes, curly quotes, non-ASCII text? A plan over 10,000 characters? (`docs/plans-spec.md` section 15 lists these five tests; if the first fails, move `plan preview` to `ask`.)
- Codex in the container: `codex login --device-auth`, the read-only sandbox fallback, `codex app-server` rate-limit readings, the `gpt-6-astra` / `gpt-6.1-sol` model ids (`mc doctor` checks them against `codex debug models`; they may have changed since 9 Oct).
- The picture step with the browser in the Docker image; the Docker memory and pid limits under a real Playwright run.
- The dashboard on the iPad through Windows, WSL2 and Docker Desktop (`mc dashboard --lan`).
- `mc publish` with a real `gh`, a private repo, and the draft pull request text.
- Task Scheduler runs, the "run didn't start" notice, and a run started as a background task of the leader.

---

## 8. Recommendations

In this order:

1. **Run the trial with the owner, on the PC.** `docs/owner-trial-checklist.md` steps 1 to 3 first (install and check; one small code job through the leader with `defaultProfile claude`; publish it to a throwaway GitHub repository). They cost about 1% of a week each on the test account. Before spending allowance, ask. When something fails, collect the five files the checklist names, find the root cause, fix it on the branch with a test, and re-run that step. Then steps 4 to 9 (writing job, web job, data job, dashboard on iPad, Codex).
2. **Prove Codex early, separately, and close the self-review gap before using `mixed`.** The default profile `mixed` makes Codex the builder, and Codex has never done a job. Until checklist step 9 passes, keep `defaultProfile: claude`. Check the pinned Codex version and model ids first (`mc doctor`). Before switching the default back to `mixed`, fix 7.1 item 0 (the owner's choice of A or B; A if they leave it to you) and do the two small hardening items of 6.3 (no passwords or tokens of any kind in the agents' environment; OS-level locks on frozen tests).
3. **Settle the release.** `master` is three stages behind and its README is misleading, and the setup guide clones `feat/any-task` by name. Once steps 1 to 3 pass on the PC, recommend to the owner a pull request from `feat/any-task` (or this branch) to `master`, then point the guides back at the default branch. Ask first; never merge without a clear yes.
4. **Fix the open faults in 7.1**, smallest first: 3 and 4 are local to the report; 1 needs the keep-to-your-feature brief in every multi-feature mission (and a real run with two tests-mode features to see whether it is needed); 2 needs a real run where the plan reviewer changes checks.
5. **Measure against the baseline the brainstorm demanded.** `docs/brainstorm.md` section 7 says every piece of Mission Control must beat plain Claude Code (Opus at medium, one session) on cost per verified task, or be cut. That comparison was never made. Once the PC works, run the same two or three small jobs both ways and record calls, time, allowance, and fixes the owner had to make. This tells the owner whether the team is worth its overhead for small jobs (each job pays about 4 fixed AI calls).
6. **Before running against repositories the owner does not trust, or for long unattended runs**, revisit the security limits in 7.2 (outbound allowlist, separate agent user, host-held approver secret).
7. **Keep the dispatcher maintainable.** `src/dispatcher.ts` is 4,091 lines. Extract shared pieces only when a real second need appears; do not build a general "primitives" layer speculatively.
8. **Keep parallel features deferred** until real use shows that clock time on big jobs matters.
9. **Settle where it lives.** The PC needs to stay awake and on for every run. The owner once wanted it running non-stop on a rented server (6.2a). After the PC trial, ask whether that is still wanted; if yes, write the server setup guide that was offered and try `scripts/mc-docker.sh` on plain Ubuntu.

---

## 9. Practical notes for you

- **Work inside WSL Ubuntu**, in the owner's checkout (the setup guide uses `~/Mission-control`). The code is POSIX-only; the engine itself runs in Docker via `scripts/mc-docker.sh`.
- **Developer loop:** `npm ci && npm run check` (typecheck + 5,653 tests, about 4 minutes, no network, no real AI) and `npm run build`. Tests use temp homes (`MC_HOME`) and never touch the real `~/.mission-control` or `~/mc-apps`. For date-sensitive tests, also run under another zone (`TZ=Pacific/Auckland npx vitest run <files>`): mission ids carry the local date.
- **Tests that pin text on purpose:** `test/leader.test.ts` (command lists, flags checked against `--help`, pinned sentences, the ask/allow lists), `test/mc-docker*.test.ts`, the dashboard tests and fixtures (dated fixtures need `copyFreshHome`), and `test/modes-wording.test.ts` (words never said about untested work). When you change owner-visible text, expect these to fail and update them deliberately.
- **Do not add a `CLAUDE.md` at the repository root.** Claude Code reads `CLAUDE.md` files from the working folder upward, so the leader session (started in `leader/`) would load it as part of its own instructions. Keep developer notes in this file or in your own memory, and start each session with "Read docs/HANDOFF.md first".
- **Anything that spends allowance, touches GitHub, or deletes data needs the owner's yes:** `mc run`, `mc doctor --live`, `mc get`, `mc publish`, `git push` to anything but your branch, `docker volume rm`, deleting anything in `~/mc-apps` or `~/.mission-control`.
- **Claude Code quirks learned the hard way:** its Bash tool refuses a command containing a curly bracket followed by a quote, a here-document with an unquoted delimiter, a command after a here-document, `$()` inside a quoted argument, and `bash -c '…|…'` with a removal (write a script file instead). A nested `claude -p` does not apply a project `.claude/settings.json` (use `--allowedTools`). `pkill -f <text>` can kill your own shell; use a pid. After writing code with `\uXXXX` escapes, scan for invisible characters: `grep -nP '[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}\x{FEFF}]' <files>`.
- **Allowance:** the weekly Claude allowance reset on Wednesdays at 19:00 UTC in October. Mission Control refuses new work at 85% weekly; the cloud sessions stopped spending at 80%.
- **Attribution:** earlier commits end with `Co-Authored-By` and `Claude-Session` lines; follow whatever your own harness asks.
