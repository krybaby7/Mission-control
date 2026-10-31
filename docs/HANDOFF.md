# Mission Control: handoff to the local agent

<!-- github-preservation-authorization -->
**GitHub preservation update, 31 October 2026:** The owner explicitly asked to push the reconstructed changes to GitHub so they are not lost. This authorizes a preservation commit and push to origin/codex/local-reconstruction-preparation-20261031 in the existing krybaby7/Mission-control repository. It does not authorize a pull request, merge, master change or product release. The repository is public; the exact intended source/document membership was reviewed for unintended private material. All 563 members matched the final checkpoint and all 523 tested inputs matched the passing validation. Only current preservation-status documentation is updated for this push. Git commit identity uses the authenticated GitHub account krybaby7 and its GitHub noreply address, supplied only for this commit. Local archives and the worker checkout remain preserved. The actual pushed commit is verified against the remote branch; the local verification receipt is kept with the next Ubuntu/Windows checkpoint.
<!-- github-preservation-authorization-end -->

<!-- reconstruction-current-start -->
**Current reconstruction handoff, 31 October 2026:** The permitted P1/P2/P4/P5/P6 core is implemented and separately source-reviewed in WSL Ubuntu at /home/adami/Mission-control, branch codex/local-reconstruction-preparation-20261031, reconstruction base a4a6f4315d5f0af03ec1e28b7539e609c3e2b11a. Final local npm run check and npm run build both passed: **6,676 tests passed, 15 skipped, 117 files**, with unchanged input hashes (20261031T044153Z-final-core-validation). This is **tested here only with stand-ins**, newly reconstructed from source/specs, not recovered cloud bytes. Read [release evidence](reduced-mission-control/release-evidence.md) and the current [requirement register](reduced-mission-control/12-reconstruction-evidence.md).

The owner authorized local automated tests/typecheck/build and exact gpt-6.1-sol agents at medium or higher reasoning; workers used high and no recursive delegation. Product models/Haiku, original refs and all starting files are preserved. At the end of local reconstruction no commit or push had occurred. The later branch-only preservation authorization is recorded above; master remains unchanged. Browser prerequisites (14 skips), optional Pandoc (1 skip), advisory work, P3/OS protection and real-provider trials remain explicit limits. No OS/protection activation, real AI/product/provider/account/login work, Docker, installs/downloads/audits, product publication/PR or deletion of preserved work is authorized. The separate preservation-branch push is now authorized.

Final archives: /home/adami/mc-reconstruction-checkpoints/20261031T044654Z-core-reconstruction-final and C:/Users/adami/projects/Mission control Harness/recovery-backups/20261031T044654Z-core-reconstruction-final. See completion.json there for verified digests and copy status. Worker checkout and all earlier archives remain. No source blocker remains in the permitted core; the next work requires the specific prerequisite/protection/trial decisions described in release evidence. Ubuntu is terminated only after all workers/jobs finish and the final paired archive is verified. Historical instructions/results below do not override this handoff.
<!-- reconstruction-current-end -->

**Local update, 28 October 2026:** The owner has since chosen a build-only phase. All project commands run inside WSL Ubuntu from the current PowerShell session. No Mission Control runs, Docker use, or product AI logins are authorized. Sections 10–12 record the local setup, checks, confirmed decisions, and reuse assessment and supersede the trial-first instructions below.


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

Two pages outside the repo (private claude.ai artifacts of the owner): the roadmap of 16 Oct, https://claude.ai/artifact/A2Siyxoa7C6JFu6548bMjA, and the “Mission Control Field Guide” written with this handoff (28 Oct), https://claude.ai/artifact/Rc8gSQFziurJAbJVFCNT7k: how it works, what it can and cannot do, the dashboard's real screens, and the decisions waiting for the owner.

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

The owner also had a real job in mind as a benchmark (12 Oct): a large task in another of their private projects, with a mandatory visual check by the owner and a draft pull request. It was judged too big for a first job and never run. Ask the owner about it; do not reach into other projects without them.

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
| Keep Mission Control walled off from the owner's other projects and their secrets | 11 Oct: Mission Control's agents have full control in their box and must never see another project's keys. The agreed flow when Mission Control works on another project: it pushes a branch, the owner reviews it, the other system pulls it. |

### 6.2a Questions the owner was asked and never answered

| Asked | Question | Safe default until they answer |
|---|---|---|
| 11 Oct | Run Mission Control non-stop on a rented Linux server instead of the PC? The owner leaned towards a server with no resource caps, and a 4 CPU / 8 GB rented server was suggested for Mission Control, with an offer to write its setup guide (plain Ubuntu + Docker, no WSL). No answer, nothing bought. | The PC, as all later work assumed. `scripts/mc-docker.sh` should work on plain Ubuntu, but it was never tried there. |
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

---

## 10. Local development takeover, 28 October 2026

### Current owner instructions (supersede the trial-first recommendations above)

The owner wants to **build the product before using it**. Do not start Mission Control runs, use Docker, or log the product in to any AI. Do not run the owner trial yet. Do not run `scripts/dev/real-run-setup.sh`; it deletes the product's data and app folders.

Keep the current Windows PowerShell session, but run every project command, including Git, inside WSL Ubuntu. The checkout is `~/Mission-control` in the Ubuntu filesystem. Edit through the Windows UNC path `\\wsl.localhost\<distribution>\home\<Ubuntu user>\Mission-control`, with LF line endings. Never use Windows Git on these files.

Ask before a system-wide installation needing sudo. Ask before real AI calls or large multi-agent work, outward GitHub actions other than pushing the working branch, any deletion, or any change to master. The initial clone/fetch and Ubuntu developer GitHub login were explicitly requested. Never set API keys, add a root CLAUDE.md, or access unrelated projects. Product leader instructions are for the leader, not the development orchestrator.

Orientation and local checks are complete. The owner answered the four decisions below, then requested consideration of existing open-source harnesses before product fixes begin. Section 11 records that research and its limits.

### What was actually checked or changed

**Tried for real on this PC (development setup only):**

- Ubuntu was already installed on WSL version 2; Ubuntu reports 26.04.1 LTS. No WSL install, administrator prompt, restart, or sudo installation was needed.
- Cloned the requested handoff branch and fetched it. The starting commit is `a4a6f43`. Created working branch `codex/local-handoff`; master was not checked out or changed.
- Git 2.53.0 was already present in Ubuntu. Installed Node 22.23.4 with npm 10.9.9 and GitHub CLI 2.103.3 for the Ubuntu user only. Official release archives were checked against their published SHA-256 checksums.
- Node is found in a fresh non-interactive Ubuntu shell through `~/.local/bin`. Existing shell startup configuration already supported this; no shell startup file was changed.
- The owner completed the GitHub device sign-in. `gh auth status` succeeded and `gh auth setup-git` completed inside Ubuntu. This is a developer login; no product AI login was made. No push or pull request was made.
- Neither Claude Code nor Codex is installed on the native Ubuntu tool path. A Windows Codex launcher was visible through inherited Windows PATH, but is not counted as a Linux installation. Do not use Windows launchers for project commands.
- Set repository-local Git settings `core.autocrlf=false` and `core.eol=lf`.
- `npm ci && npm run check` exited 0. Typecheck passed. Vitest reported **91 files passed, 5,639 tests passed, 15 skipped**, in about 93 seconds after installation.
- The difference from the cloud baseline is explained by **14 skipped Chromium checks** (13 in `src/render.test.ts`, one in `test/modes-tiles.test.ts`). Chromium is absent. The other skipped test uses Pandoc, which is also absent. `playwright-core@1.64.0` is installed. No missing test was represented as passing.
- `npm run build` exited 0.
- `npm audit --json` reported one affected dependency, `fast-uri`, with moderate severity and a fix available. Its four advisories are GHSA-w74x-v6f9-j3xg, GHSA-xhq7-xmqj-769h, GHSA-wjr9-j795-jxcr, and GHSA-333x-w4r6-6crp. No dependency versions were changed.
- No usable Git author identity is configured in Ubuntu. This handoff update remains uncommitted. No identity was invented or copied from another project.

**Tested here only with stand-in AIs:** the local automated suite. Its GitHub and Docker tests use substitutes; they are not evidence of a real product upload or container run.

**Not tried here:** any Mission Control job with a real AI, a product AI login, Docker, an independent Codex build/review, the leader's interactive permissions, the iPad path, or a product GitHub upload. Earlier real Claude results remain historical evidence recorded in section 4.

### Owner decisions confirmed, 28 October 2026

1. **Release:** wait until the agreed fixes pass before opening the pull request into master. No pull request or merge is authorized now.
2. **Review gap:** **A** is selected: keep the feature moving and clearly disclose when the same AI family built and reviewed it. Do not describe that as independent review.
3. **Location:** keep development on the **PC**. No rented server now.
4. **Backups:** keep `wip/build` and `wip/ceo-dashboard` until release work is retained and their contents are verified. No deletion now.

Before product fixes begin, the owner wants existing open-source harnesses considered, including replacing substantial existing work if a better option is demonstrated. See section 11.

### Proposed build order (not started)

Estimates are active work time, not promises. These are proposed changes, **not tried**, derived from sections 7.1, 6.3 and 8, with the local setup findings added first.

| Order | Work | Size | Estimate | Confidence |
|---|---|---|---|---|
| 1 | Complete browser test prerequisites and investigate/update the affected dependency; repeat checks. Prefer user-local setup; ask before sudo. | Small | 1–3 hours | Medium |
| 2 | Close the self-review reporting/control gap according to the owner's A/B choice, with stand-in tests of provider fallback. | Medium | A: 3–6 hours; B: 1–2 days | Medium |
| 3 | Filter unrelated secrets out of agent environments; prove a viable Linux protection mechanism for frozen tests before implementing it. Ordinary same-user file permissions are not a strong security boundary. | Large | 1–3 days | Low–medium |
| 4 | Fix stale review notes and wrongly discarded report summaries (7.1 items 3 and 4), with focused regression tests. | Medium | 3–6 hours | Medium |
| 5 | Strengthen feature boundaries and preservation of agreed checks; investigate the literal backslash-n limit (7.1 items 1, 2 and 5). | Medium | 1–2 days | Medium |
| 6 | Run the complete local checks and build; update guides and this handoff; prepare release notes with the remaining untried paths. | Small | 1–2 hours | High |

Extract shared dispatcher code only when a change demonstrates a repeated need. No speculative framework rewrite or parallel-feature work.

Excluded from this phase: owner trials, live health checks, real Claude/Codex runs, the single-agent cost comparison, Docker/container validation, leader permission trials, real product GitHub publication, iPad access, scheduled runs, and server deployment. Stand-in tests cannot close those evidence gaps.

---

## 11. Reuse before more building, 28 October 2026

### Owner direction and current decision

The owner is willing to replace even substantial existing Mission Control code if an existing harness is better, more complete, and demonstrated to work. Past effort is not a reason to keep inferior code.

The owner requested research before further product building and approved exactly two additional, bounded, read-only ChatGPT research workers. They reviewed Orchestrator.inc and OpenHands. The owner has now supplied Perplexity Deep Research. Section 12 and research-reconciliation.md record the checked findings and updated recommendation.

**No replacement has been selected.** The full findings, pinned sources, effort estimates and local reproduction are in [harness-research.md](harness-research.md). Continue from that report rather than restarting the search.

### Evidence collected

**Tried for real, development setup only:** Cezar v0.16.3 was cloned into a separate Ubuntu research checkout, pinned at `69699d765f94434ece15d4b06b8124f3625d883a`, on branch `codex/research-cezar`. Its development dependencies were installed without lifecycle scripts. This was not a real AI trial.

**Tested here only with stand-in AIs:** 82 selected upstream Cezar tests passed in two batches (72 and 10). The second batch deliberately excluded 187 other tests by name. A separate workflow-continuation acceptance test failed: after a failed check was corrected, Continue resumed the AI conversation but left that check failed and the next check pending. The run state was waiting. This reproduces the central behavior in upstream issue 1733, not every detail of that report. No candidate production fix was made.

Evidence and the candidate checkout are under `~/.cache/mission-control-research/2026-10-28/`. The tests used a fake HOME, an empty initial environment, native Linux tools and bundled stand-in agents. The portable reproduction is saved as [research/cezar-continue-reproduction.test.ts.txt](research/cezar-continue-reproduction.test.ts.txt).

**Not tried here:** Orchestrator, OpenHands and Paperclip execution; complete candidate suites; actual AI task quality; candidate logins, phone interfaces, Docker or isolation against real agents. No product runs, API keys, GitHub writes or production code replacements occurred. REA was not executed.

### Findings and recommendation

- **Cezar:** closest configurable workflow candidate and useful TypeScript components. Its explicit human-approval steps passed selected local checks. Its optional final review stop is off by default and skipped in autonomous mode. Default Codex permissions are broad. Its environment filter deliberately permits GitHub and provider credentials, so use a stricter Mission Control policy if adapting it. The failed continuation reproduction needs resolution before adoption.
- **Orchestrator.inc:** strong desktop/phone, worker and recovery foundation. Its own source says Codex allowance readings are advisory, not launch gates. Default permissions and environment inheritance conflict with our controls. Exact-release upstream automated checks succeeded, but no local product journey was tried.
- **OpenHands Agent Canvas:** broad UI/runtime components. Its current external-agent bridge automatically answers permission requests. Dollar limits and subscription reserve policies are different. Upstream release evidence includes successful main CI and four failures in a separate mock browser suite.
- **Paperclip:** relevant for persistent business teams, formal approvals and spending controls. Budget reservation and recovery designs are substantial. Defaults, subscription reserves, isolation, migration and operational complexity still need a trial.

Initial recommendation, updated by section 12: reuse a small, demonstrably useful component first; keep full replacement open until matched acceptance cases show it saves future work. Cezar's environment-filter design and tests are the smallest immediate reuse opportunity, with different credential rules. No implementation has started.

The main report distinguishes local tests, upstream tests, reported problems and unknowns. All candidates and Mission Control retain real-world gaps. A bigger test count or README is not evidence of better task outcomes.

### Subscription and REA notes

Official OpenAI documentation supports ChatGPT auth and allowance readings through Codex app-server. Anthropic's current Help Center says Agent SDK, CLI headless and third-party app usage still draw from subscription limits, while its SDK overview separately retains a prior-approval requirement for developers offering claude.ai login/rate limits. Record both; candidate approval status is unverified. Do not assume all SDK subscription use is impossible or that a CLI wrapper automatically resolves the product-policy question.

REA is useful when shipped behavior is unavailable in source. Normal source inspection and stand-in tests answered the current questions. Reviewing REA guidance was not reverse-engineering evidence.

### Next step and limits

The owner's Perplexity result has been reconciled in section 12; use that updated recommendation before further work. A focused stand-in adoption trial is estimated at 1–3 days, medium confidence. Full-switch planning ranges in the report are low-confidence estimates, not commitments.

Before selecting any replacement, compare failed-check recovery, owner stops, allowance reserves, same-family disclosure, protected checks and isolation using harmless fixtures. Real task comparisons remain separately subject to owner approval. Do not start product runs, use Docker or log products into AI accounts under the current build-only scope.

Preserve Mission Control, the research checkout and existing branches. No deletion or migration is authorized. No further agent workers are authorized by the completed two-worker approval.

---

## 12. Perplexity research reconciled, 28 October 2026

The owner supplied the external research after Ubuntu had been stopped. It has now been read and its decision-relevant claims checked against primary sources. Read [research-reconciliation.md](research-reconciliation.md) before resuming product work. The attributed original is [research/perplexity-harness-review-2026-10-28.md](research/perplexity-harness-review-2026-10-28.md).

### Current recommendation, not an approved rewrite

Evaluate a reduced Mission Control first, using the official Claude Code and Codex programs. Borrow useful controls and UI components as needs arise. No full replacement has been selected. Do not build a second small coordinator without mapping what already exists.

Local source confirms that Mission Control already has structured official-CLI execution, Codex app-server account/usage queries, a fixed job sequence, saved progress, checks, approval records, pacing and reporting. Its Codex runner reads JSON events, not a scraped terminal display. These components may still need fixes or simplification; their presence is not proof of real-world reliability.

The keep/simplify/replace map is now complete; see [section 13](#13-keep--simplify--replace-review-28-october-2026) and [keep-simplify-replace.md](keep-simplify-replace.md). Its recommendations and estimates supersede the earlier next-step outline. No product implementation or real comparison has started.

### What changed in the evidence

- OpenHands Canvas 1.34.0 pins Agent Server 1.58.1. The newer SDK 1.58.2 was separately inspected and still automatically answers permission requests on its external Claude/Codex path. General confirmation-policy tests do not establish approval on that path.
- Orchestrator 0.14.7 exists. Its selected capacity source still says readings are advisory and do not control launch admission. The earlier bounded review and upstream test evidence were for 0.14.6; do not silently transfer them to the newer release.
- Omnigent 0.20.0 is a new isolation-component candidate. Its Apache-2.0 source implements Linux Bubblewrap path controls and contains useful tests. Explicit selection fails when Bubblewrap is missing; the generic default may fall back to no sandbox. The product remains labeled alpha. Nothing was installed or run here.
- HAPI 0.31.3 is an optional phone-interface candidate under AGPL-3.0. Its README and license were inspected; no deployment was tried.
- Pi 1.4.0 includes a separate experimental durable-state package beyond the minimal coding-agent core screened earlier. It remains a component option, not a demonstrated replacement.
- The external report's claim that Mission Control has no real-provider proof is too broad. Section 4 records ten small historical real Claude runs. They were not repeated here, and real Codex jobs, product runs on this PC, Docker and real publication remain untried.
- Cezar's earlier 82 selected stand-in passes and failed continuation reproduction remain relevant. They were not rerun.

Anthropic's current legal documentation expressly describes end-user sign-in to an unmodified official Claude Code binary under conditions, while restricting credential collection/intermediation by third-party products. OpenAI distinguishes local/open-source app-server auth from commercial/hosted use and states connected-app caps do not reserve allowance. See the linked reconciliation for exact sources and limitations. No provider login was attempted.

### Authorization and work state

This session changed only research documents and the handoff. No production code, provider pins or dependencies changed. No new candidate tests, extra research workers, product AI calls, Docker operations, GitHub writes, commits or deletions were performed.

The external report's 28 proposed live runs are not authorized and are not the recommended immediate step. Start with harmless local fixtures, then propose a few comparable real tasks separately if needed. Keep the owner's earlier four decisions and all section 10 restrictions in force.

Ubuntu was briefly started to read project code and save these notes. Stop it again at the end of this task; a later agent may start it when needed for authorized project work. All project commands and Git remain inside Ubuntu; file edits use the Windows UNC path.

---

## 13. Keep / simplify / replace review, 28 October 2026

The owner said “go ahead with the list.” The concrete review is complete in [keep-simplify-replace.md](keep-simplify-replace.md). This authorizes the decision list, not a rewrite, deletion or real product run. No implementation was started.

### Recommendation and concrete findings

Keep the official CLI adapters, fixed workflow, saved progress, checks, approval stops and read-only dashboard. Make the three optional AI helpers independently switchable in a reduced configuration: context suggestions, failure summaries and report prose. Preserve their existing fallback information and all required checks. Prefer the existing supplied-plan route when a plan already exists. Defer a general workflow framework and broad dispatcher refactor.

Adapt Cezar's positive environment-list pattern with stricter exclusions. Evaluate Omnigent's Linux isolation controls and test cases in a bounded local experiment. Neither project is selected as a wholesale replacement. Protect coordinator state and approval authority as well as frozen tests and unrelated files. Ordinary same-user file permissions and restoring a work folder are not that boundary.

Source confirms the executor returns the actual provider family. Tests-mode review/test authorship lack the dedicated feature records needed for clear disclosure; a usable rubric result already records its reviewer. Implement option A using actual outcomes, including builder switches and unknown old records. Do not infer independent review from configuration.

The allowance review found an additional policy gap: a utilization reading without any usable reset time creates no pacing block. An existing test explicitly expects this. A valid previously known reset can be inherited; actual limit responses also have separate waiting behavior. Recommend visible unknown allowance and a conservative unattended-start policy, with its details agreed before implementation. This is a source/test-definition finding, not a new runtime result or a claim that all quota logic fails.

### Scope, estimates and preserved evidence

The linked list maps each recommendation to source files, required regression behavior and size/time/confidence. Its proposed build order starts with the missing browser prerequisites/dependency check and the already chosen review disclosure, then environment filtering and a capped isolation experiment. Optional-helper switches, unknown-allowance policy and the remaining section 7.1 faults follow. Product runs remain excluded.

Cap the initial isolation experiment at 4–8 active hours and report a blocker before extending it. Integration is provisionally another 1–3 days, subject to what the experiment proves. This separates the earlier rough combined estimate into a bounded investigation and a conditional implementation estimate.

This review inspected current source and test definitions. It did not rerun tests. The latest full check remains the section 10 result: typecheck passed, 5,639 tests passed, 15 skipped. All proposed behavior is **not tried**; the existing suite is **tested here only with stand-ins**. The ten historical real Claude runs are unchanged evidence. No claim of reduced real allowance use has been established.

Only documentation changed. No product code, dependencies, provider pins, extra workers, live AI calls, Docker, outward GitHub actions, commits or deletions were performed. Branch remains `codex/local-handoff`; research documents remain uncommitted. Preserve the four owner decisions in section 10.

Documentation validation **tried for real:** `git diff --check` passed. The three documents edited in this review passed LF/UTF-8 and trailing-whitespace checks; all 69 local file links resolved. The new decision list was read back and exactly matched the intended text. The closing action is to sync and stop Ubuntu again; confirm `wsl --list --verbose` before assuming its state in a later session. Every project/Git command still runs inside Ubuntu; edits use the Windows UNC path.

---

## 14. Build specification for GPT 6.1 Sol workers, 28 October 2026

The owner asked: “create the spec for all these steps, and we'll run agents on it for the implementation. GPT 6.1 Sol agents.” The specification is complete in [reduced-mission-control-spec.md](reduced-mission-control-spec.md), with seven linked package documents in `docs/reduced-mission-control/`.

### Current scope and model choice

This request prepares the specification before implementation. No implementation or review agents were launched, and no product code changed. When the owner starts implementation, development workers use `gpt-6.1-sol`; do not silently substitute another model. This does not change the product's model assignments. Haiku 5.5 remains its configured light model for mechanical work and enabled optional helpers.

The spec divides work into baseline repair, review/report evidence, environment filtering, a capped Linux isolation experiment, optional helpers, allowance admission, plan integrity, and final integration. The coordinator owns shared contracts and serializes central-file changes. At most two workers are active together; no recursive worker delegation or unbounded review loops.

### Proposed defaults and explicit limits

- The reduced configuration disables three optional helpers independently. Required checks and reviews remain. New missions save the resolved helper settings; old missions with no snapshot retain all-true behavior.
- Newly generated setup settings explicitly stop on unknown allowance. Existing config files that omit the new setting retain warning behavior. Missing data never becomes a claimed reserve.
- Codex's existing metadata route must be available before strict admission, rather than only inside the first model job. Claude may have no usable preflight reading; strict mode must stop and explain that without a paid probe.
- Attempt caps count reserved worker invocations, including executor retries, with metadata-only queries excluded.
- Supplied feature checks and IDs cannot be silently weakened by plan revision. New parsed planner text is preserved literally instead of heuristically decoding escapes a second time; existing accepted plans are not rewritten.
- The isolation experiment is capped at 4–8 active hours. Integration requires an actual result and a reviewed concrete addendum. No successful isolation or real CLI compatibility is assumed.

All proposed changes are **not tried**. The last full check remains 5,639 passes / 15 skips plus clean typecheck; it was not rerun for this documentation-only task. Existing stand-in and historical real-Claude evidence remain separate.

### Work state and next action

Read the main spec first, then the assigned package and the execution instructions. Package checkboxes begin unchecked. The next action is owner review of the written spec and, when requested, the first bounded implementation batch. Do not repeat the model-choice question.

The current branch remains `codex/local-handoff`. Specification and prior research documents remain uncommitted; no Git author identity was invented. Preserve all existing work. No real product calls, provider logins, Docker, API-key setup, system installs, GitHub writes, commits, deletions or changes to master occurred while preparing this specification.

Documentation validation **tried for real:** all eight specification files were read back and matched the intended text. The nine changed/new documents passed UTF-8/LF, whitespace and local-link checks (45 links), with 118 unique package requirement IDs and balanced code fences. The spec was self-reviewed for scope, shared contracts, coverage and compatibility. `git diff --check` passed. These are document checks, not implementation tests. The closing action is to sync and stop Ubuntu again; verify its state before later work. All project commands and Git still run inside Ubuntu; edits use its Windows UNC path.


---

## 15. Hosted GPT 6.1 Sol implementation requested, 28 October 2026

The owner explicitly asked to run GPT 6.1 Sol in the cloud so work can continue while this PC is off. This authorizes implementation of the reduced Mission Control specification and the cloud development-agent work needed for it. It does not authorize real Mission Control provider jobs, Docker, product login, API-key setup, publication, PRs, changes to master or deletion.

A dedicated cloud environment for only this repository is being prepared. The browser model selector shows GPT-6.1 Sol Light. Setup has been told to use `claude/lucid-gauss-nxcanf` at base `a4a6f4315d5f0af03ec1e28b7539e609c3e2b11a`, rather than master. At the time of this entry, environment preparation is running; product implementation has not yet been verified as started.

### Cloud-specific execution rule

The owner's latest cloud request supersedes local WSL/UNC instructions for the hosted worker only. Run cloud project commands in its native Linux filesystem and edit there. All work performed on this PC still uses Ubuntu for project/Git commands and the UNC path for edits. Do not require a live connection to this PC or access other projects.

The uncommitted specification/research documents and current handoff are being supplied as a bounded documentation package with a SHA-256 manifest. Apply them over the specified repository base before coding. Preserve existing work. The host has no Git author identity configured; do not invent a personal identity. A cloud platform's already configured agent identity may be retained. If no usable identity exists, retain changes and an exportable patch without committing.

Use one primary GPT 6.1 Sol worker. Follow the package order and gates in `reduced-mission-control/06-agent-execution.md`; use no recursive delegation or open-ended review loop. P3b remains conditional on actual P3 evidence and a reviewed integration addendum. The full scope is estimated at several days; a cloud session may finish a bounded batch and leave a checkpoint. Do not claim all work is complete merely because its session ends.

No local source code changed during setup. The latest completed local full check remains 5,639 passed / 15 skipped plus clean typecheck; no real product run has been started. Record the actual cloud task link and observed status when launch is confirmed.


### Launch confirmed

The existing hosted task is [Mission Control — cloud implementation](https://chatgpt.com/local/01a18414-fdad-7142-b79d-8ebce58e7061). The app reported execution host `durable` and an active implementation turn. The model was explicitly set to `gpt-6.1-sol` when dispatching the implementation brief; the browser selector showed GPT-6.1 Sol Light. The worker confirmed source editing is permitted in `/workspace/Mission-control`, branch `codex/reduced-mission-control-cloud`, at the exact requested base, with all 14 supplied documents present. It accepted the implementation scope and began reading/verifying the workspace. This is a confirmed cloud development task, not a real Mission Control product run.

Creating the reusable private cloud environment reached a platform publication failure. Its settings were saved, but publication did not succeed. The implementation was therefore dispatched into the already running durable cloud workspace, with explicit instructions not to wait for publication or retry it. Do not describe the reusable environment as published. Its inspected configuration includes only this repository, access “Only me”, package-manager network access, no added secrets or environment variables, and no unrestricted public internet access.

### Actual setup evidence and limitations

- The cloud network proxy could not reach GitHub or the package registry. No proxy/security policy was bypassed. A public Git bundle and the exact documentation package were uploaded, verified and applied instead.
- The dependency archive exceeded a 32 MiB transfer-tool limit. Two smaller parts were uploaded and reassembled. Their hashes, the final archive hash, 2,395 archive members and eight confined links were verified by the setup worker. This is an uploaded native Linux dependency baseline; `npm ci` was not run in cloud.
- Typechecking and `npm run build` passed in cloud. The initial full check encountered repeated process/Git execution restrictions and was stopped with exit 143. There is no complete cloud suite or skip total from that attempt.
- The focused Git suite had 90 passes / nine failures under its initial restrictions, then 99 passes through the platform's approved broader filesystem execution path with unchanged tests. The first reproduced failure was `spawnSync git EPERM`. Full-suite execution is the implementation worker's first unresolved validation task.
- Fourteen Chromium checks lack prerequisites. Pandoc 3.1.11.1 is present in cloud. Do not carry over the local 15-skip figure as a cloud result.
- Setup logs are retained in `/workspace/mission-control-setup-evidence/`. The cloud brief requires package checkpoints, exact evidence, preserved code/patch output, no automatic push/PR, and no false claim that the complete specification passed.

These are **tried-for-real development setup commands** and **stand-in test evidence only**. Product implementation completion, full cloud validation, real provider behavior, real allowance effects and this PC's Windows isolation remain **not tried or not yet established**.

The local repository remains on `codex/local-handoff`, with documentation changes only and no commit or push. Transfer artifacts are kept outside the repository in `~/mc-cloud-transfer`; none should be committed. The cloud implementation brief and task record supersede the earlier setup-only scope for this task. Stop local Ubuntu after recording this note; cloud execution does not depend on it. A cloud task may pause for an approval, an allowance limit or another concrete blocker; do not promise completion within one session.

### Hosted delivery and fresh review, 29 October 2026

The first hosted implementation run ended with a preserved delivery, not completion of the whole specification. Core P1/P2/P4/P5/P6 code was delivered in the cloud checkout. The owner then approved a fresh full check, independent review and fixes for confirmed core defects. This bounded review is complete.

The work ran in the same [hosted task](https://chatgpt.com/local/01a18414-fdad-7142-b79d-8ebce58e7061), on host `durable`, using GPT 6.1 Sol and a separate bounded Sol reviewer. Cloud branch: `codex/reduced-mission-control-cloud`; base/HEAD remains `a4a6f4315d5f0af03ec1e28b7539e609c3e2b11a`. The corrected implementation remains uncommitted in the cloud; the local checkout still contains documentation only.

#### Confirmed fixes and review

The reviewer found five core defects: retained work from executor retries could lose AI identity; repaired features could omit dashboard identity wording; malformed evidence subjects could establish review credit; finding resolutions could substitute a requested reviewer family for an unknown actual family; and document builders lacked the multi-feature scope instruction. The fixes also cover incomplete retained test authorship.

A further source read found and reproduced a cleanup/recording gap in scaffold initialization. The second correction round added durable pending-write evidence: interrupted ownership remains unknown, completed evidence and removal of its pending marker are saved together, and recovery saves uncertainty before clearing the interruption marker. Seventeen new regression cases were added. The same separate reviewer accepted the bounded corrections with no important in-scope issue remaining. Its final focused check ran three handoff cases successfully; fourteen other cases were not selected in that focused command. All seventeen new cases then ran in the complete suite. A separate Sol reviewer is not evidence from a different AI family.

#### Actual validation

**Tried for real: development commands; AI behavior tested with stand-ins only.** The fresh baseline matched all 539 original delivered files before and after checking: 5,707 tests passed across 100 files, 14 browser tests skipped, check exit 0, build exit 0. This resolves the missing process-exit evidence from the first delivery.

The final corrected tree passed `timeout 600s env VITEST_MAX_WORKERS=4 npm run check`: clean typecheck, **5,724 tests passed / 14 skipped**, 101 test files passed, 5,738 total tests, 295.82 seconds, exit 0. `npm run build` also exited 0. The same wrappers immediately saved separate exit files. All 542 frozen input hashes were unchanged after the check and build; their digest is `db88f6f5b96ce84eb7f85c51d413ee51fb5a8880ca9fb538c48b847a7746c69e`. Final evidence files are under `/workspace/mission-control-verification-20261029/`.

The later delivery differs from that frozen input set only in eight declared documentation files. Archive verification checked all 542 source members and the archived exit files. Document checks covered 32 files and 254 local links.

#### Preserved delivery and remaining work

The reviewed delivery is `/workspace/mission-control-delivery-20261029/`. It contains `reduced-mission-control-20261029-source.tar.gz`, `reduced-mission-control-20261029.patch`, `reduced-mission-control-20261029-evidence.tar.gz`, `delivery-manifest.json`, `changed-files.txt`, `SHA256SUMS` and `README.md`. The patch includes new files. The coordinator verified artifact sizes/hashes, archived file contents and original-delivery preservation. Source archive SHA-256: `f0bab31abf5f80696630b4cfd5fe9924013efaf688e7149525213caee3b383b7`. Patch SHA-256: `b971ad8b538d31224802d0ef347c7fd4cb414a41952ef4a7922d31dcfa853a6b`.

Keep the original artifacts in `/workspace/mission-control-delivery/`. The corrected source and exports have not been imported into the local repository. The cloud handoff, release-evidence document, review disposition and manifest are the detailed implementation record.

**The whole specification is not complete.** Remaining IDs are B02/B03/B04, I02–I11, V04/V05/V10. Matching Chromium download through the configured proxy was denied HTTP 403, `Domain forbidden`; fourteen browser checks remain skipped. Complete OS protection, Windows/WSL sentinel checks and P3b integration are not established. Real provider compatibility, actual allowance effects and product use remain **not tried**.

Next work should retrieve/preserve the reviewed source in Ubuntu, complete browser coverage and the outstanding combined checks, then finish the bounded isolation evidence and reviewed integration design before considering the release PR. No PR or merge is authorized by this review result. Keep the existing owner decisions: agreed fixes before the release PR; same-family disclosure under option A; PC development for now; preserve both backup branches.

No real product provider call, provider login, Docker command, API-key setup, commit, push, PR, publication, deletion or master change was performed for this review. Local edits were limited to this handoff, through the Ubuntu UNC path with UTF-8/LF. The final local documentation check and Ubuntu stop are recorded in the current chat; cloud execution does not depend on this PC.

## 16. Remaining protection specification and next-chat takeover

The owner requested a specification for what remains to build and a copyable prompt for a new orchestrator that will deploy **GPT 6.1 Sol** development agents. The owner also wants another discussion before testing. This turn prepared documentation only; it did not launch implementation agents.

Read the [remaining protection specification](reduced-mission-control/07-remaining-protection-spec.md) and [new-chat orchestrator brief](reduced-mission-control/08-next-orchestrator.md). These take precedence over stale implementation-status wording in the original plan. The original specification, P2/P3 document and P7 execution document now point to this current status.

### Testing authorization and stop point

**HOLD ALL TEST EXECUTION pending the owner's clarification.** A question was sent asking whether automated development checks with stand-in AIs and harmless files may proceed while real-provider trials remain held. No answer was assumed. The next chat must record any explicit clarification. Until then, source recovery, source review, inactive code/test preparation and document/hash/format checks are allowed; test suites, OS experiments, product/provider calls and activation of the new protection are held. Do not commit untested code. This is a conservative interpretation of the owner's testing pause, not an approval requirement invented by a skill.

### Planned work

The six packages are: recover the exact reviewed cloud source; prepare missing protection cases and policy; execute the authorized experiment; review a concrete integration design; conditionally implement protected launches; then complete authorized integration checks and delivery evidence. The specification defines ISO01–ISO20 requirements, T01–T20 acceptance cases and RCV1–RCV10 recovery steps. A passing offline fixture does not establish that an online provider path is complete.

The cloud core remains implemented and reviewed with stand-in evidence, as recorded above. It has not been imported here. The local branch remains codex/local-handoff at a4a6f4315d5f0af03ec1e28b7539e609c3e2b11a with older source and preserved uncommitted documentation. The new chat must recover the dated, hash-verified delivery before coding and preserve these newer instructions. It must not rebuild completed packages from stale local source. The original missing pre-implementation baseline cannot be retroactively invented.

Use the exact model ID gpt-6.1-sol for every future implementer/reviewer, with self-contained briefs and at most two workers plus the orchestrator. No recursive delegation; at most two correction rounds before a revised estimate. This development-agent choice does not change the product's light models, including Haiku.

### Evidence from this documentation task

**Tried for real: read-only development inspection and documentation edits.** Ubuntu currently has /usr/bin/bwrap, Bubblewrap 0.11.1, and kernel 6.18.54.1-microsoft-standard-WSL2. No capability/isolation probe was run. These version checks establish availability only.

**Not tried in this turn:** implementation, product tests, the protection experiment, real AI calls and provider login. No Docker command, system install, commit, push, PR, publication, deletion or master change was performed. New files and edits used the Ubuntu UNC path with UTF-8/LF; project/Git commands ran inside Ubuntu. Historical cloud test counts are unchanged and apply only to the reviewed cloud tree.

Document verification passed: git diff --check; UTF-8/LF and whitespace checks on all six touched documents; 53 local file links resolved; complete, unique ISO/T/RCV requirement sequences; and exact saved-content comparison for both new documents. These are document checks only, not product tests or proof of protection. Ubuntu is to be stopped after this final note; the observed stop result is recorded in the chat. The next orchestrator must stop before the owner's further discussion/testing gate and report prepared-but-unverified work honestly.

## 17. Local remaining-protection takeover, 30 October 2026

Package A is in progress. The current working branch is `codex/remaining-protection-preparation` in `/home/adami/Mission-control`, based on `a4a6f4315d5f0af03ec1e28b7539e609c3e2b11a`. Existing uncommitted documents were preserved in `/home/adami/mc-reviewed-delivery-20261029/local-docs-before.tar.gz`, with document hashes, original status, HEAD and Git refs beside it. No source has been imported yet. No applicable AGENTS.md was found in the checkout or its Linux ancestors.

### Current owner authorization, verbatim

> I want another discussion before testing. Until I explicitly clarify that pause, you may recover source, inspect it, prepare inactive code and test cases, and perform source review. Do not execute tests, activate the protection, or claim it is complete. Stop at the testing gate.

All test execution remains held. No unit, integration, browser, OS isolation, build, live doctor, provider metadata/account check, product login or real product run is authorized by this takeover. Read-only inspection, recovery hash checks, inactive preparation and source/document review are allowed. No commit is allowed while the full-check gate remains unmet.

The owner authorized bounded `gpt-6.1-sol` development workers and contact with the existing hosted task solely for recovery/export. Maximum two workers plus the orchestrator; no recursive delegation. The orchestrator owns HANDOFF, shared contracts and integration. Source recovery must precede coding. The historical cloud 5,724-pass/14-skip result is not new local test evidence.

Read-only availability inspection found native Linux Node v22.23.4, Git 2.53.0, `/usr/bin/bwrap` 0.11.1 and kernel 6.18.54.1-microsoft-standard-WSL2. These versions establish availability only; no capability probe ran. Original backup branches and all prior work remain preserved. Package A estimate: small–medium, 1–3 active hours, medium confidence. Package B and all later packages have not started.

### Package A stopping point: hosted recovery blocked

The existing hosted task was contacted with model `gpt-6.1-sol` for recovery/export only. Its completed response reports: **“No usable execution environment is available.”** Host startup did not complete, so it could not read `/workspace/mission-control-delivery-20261029`, verify the artifacts or create a transfer. No source, patch, manifest or evidence bytes were recovered. The response is retained outside the checkout in `/home/adami/mc-reviewed-delivery-20261029/cloud-recovery-blocker.json`. This is the recovery worker's reported platform error; no new cloud test evidence exists.

The local browser route also reported “Local browser use is disabled in Work settings.” No setting was changed or bypassed. There is no downloaded/exported artifact to hash locally. Do not confuse the backup archive hash with the reviewed cloud source hash.

RCV1 and RCV6 are done. The local-backup part of RCV5 is done. RCV2–RCV4 and the verified-delivery part of RCV5 are blocked on export; RCV7–RCV9 are not started. RCV10 applies: report the missing dated artifacts and continue only independent planning. The missing items are the dated complete patch or source archive, `delivery-manifest.json`, `SHA256SUMS`, `changed-files.txt`, `README.md`, and evidence archive named in section 2 of the remaining specification. Their required hashes have not changed.

A separate `gpt-6.1-sol` reviewer, dispatched with `fork_turns: none`, inspected the current specification read-only. It found no conflict in Package B's preparation scope and identified false-positive hazards for alias/race protection, controller authority, inherited descriptors, detached descendants, network positive controls, Git metadata, fail-closed launches and honest old-record behavior. No recursive worker was created. The cloud recovery worker and local reviewer have both finished. Their work is review/recovery preparation, not product AI execution or evidence from a different AI family.

The orchestrator saved [the preparation plan](reduced-mission-control/09-preparation-plan.md) and read the installed Bubblewrap manual without a capability probe. The plan records the normal-parent-exit descendant concern and optional namespace flags as questions for later synthetic execution. This does not select or validate a final launch recipe.

**Current state:** Package A is incomplete because the dated cloud export is unavailable. Package B has independent planning only, with no fixture or policy implementation. Packages C–F have not started. Production source, product models, dependencies and tests have not changed in this takeover. No tests, typecheck/build, OS experiment, protection activation, real product/provider call, provider login, Docker command, installation, commit, push, PR, publication, deletion or master change occurred.

The only repository files written by this takeover are HANDOFF and `docs/reduced-mission-control/09-preparation-plan.md`. All prior uncommitted documents remain preserved. The pre-takeover document backup SHA-256 is `212304f8bbe75163d640475f250925bbd4b6ab295641fcc0e405603a9e2cf41b`. Original local refs were saved; only the new working branch was added. The checkout had no local/remote-tracking `master`, `wip/build` or `wip/ceo-dashboard` refs at inspection, so their remote existence was not re-verified. No remote refs or backup branches were modified.

Next: regain access to the same hosted workspace or obtain its exact dated export; verify and recover it under RCV2–RCV9 before coding. Then complete Package B and stop for the owner's testing discussion. Do not infer test approval from restored export access. No protection-completion claim is justified.

Closing document/hash inspection passed: all 31 pre-takeover document files remain byte-for-byte preserved (HANDOFF retains its entire original prefix with this section appended), all prior local Git refs are unchanged, and the tracked production diff is empty. Both documents written here passed UTF-8/LF and whitespace inspection; `git diff --check` passed. These are document/recovery checks only, not product tests. No other active development worker remains. The closing action is to sync and stop Ubuntu; the observed stop result belongs in this chat, not an assumed success in this note.

### Owner-requested hosted startup retry, 30 October 2026

The owner asked: “Can you make the existing cloud workspace yourself?” The orchestrator interpreted this as authorization to attempt supported startup/recovery of the same hosted workspace, preserving its files. A bounded follow-up was sent to the existing cloud task with model `gpt-6.1-sol`, no reasoning override, no new task/environment and no recursive workers. The requested operation is status/resume/restart through available documented platform tools, followed by the existing artifact export only if access returns. The testing hold remains unchanged; no testing, implementation, provider use, Docker, installation, publication, reset or deletion is authorized by this question.

The local session exposes task continuation but no direct hosted-instance start/restart tool. The existing hosted worker was asked to attempt its supported startup route once, avoid unchanged waiting loops, and return the precise status/error. Outcome is pending at this entry. Official guidance says to reopen the same task for saved working state and that new tasks start separate work: https://learn.chatgpt.com/docs/environments/cloud-environments . This does not establish that this particular workspace or its files have been recovered.

Hosted startup retry outcome: the recovery worker reports that the supported `wait_for_environment` operation timed out after 240 seconds. Its final `cloud_environment.environment_status` observation was desired/observed phase `running`, connectivity `offline`, failure `null`, capabilities `[]`. File access still returned “No usable execution environment is available.” No start/resume/restart control was exposed to that worker. A running phase alone did not establish usable execution or access to the saved files.

The completed response is saved in `/home/adami/mc-reviewed-delivery-20261029/cloud-startup-retry-20261030.json`. No original file hashes could be rechecked, no export was produced, and no new environment was created. This does not establish that the original data is gone; it remains inaccessible. Package A is still blocked. Only HANDOFF was updated in the repository during this retry. All test and activation holds remain. The next step requires the existing task to regain platform connectivity, or recovery of its exact dated artifacts through an available export route.

## 18. Owner reports delivery downloads unavailable, 31 October 2026

The owner found the correct 29 October delivery message but reports that its linked files cannot be downloaded. The owner also reports that the hosted agent recommended contacting OpenAI support and now wishes to consider the files lost for planning purposes. Treat the reviewed cloud delivery as unavailable; permanent deletion is not established. No further hosted recovery attempt or support contact was made in this local turn.

A read-only local check confirmed that the main build specification, all package documents 00 through 09, and this handoff remain present. The saved pre-takeover document archive at `/home/adami/mc-reviewed-delivery-20261029/local-docs-before.tar.gz` still has SHA-256 `212304f8bbe75163d640475f250925bbd4b6ab295641fcc0e405603a9e2cf41b`, matching the recorded value. The checkout remains on `codex/remaining-protection-preparation`; older source and newer uncommitted documents remain in place.

A bounded read-only GPT 6.1 Sol review confirmed detailed surviving requirements and acceptance cases for P1, P2, P4, P5 and P6. Their original estimates total 30–58 active hours before final integration and isolation work. This is historical scope information, not a reconstruction estimate. Those changes span review/report integrity, worker environment filtering, optional helpers, allowance admission and plan integrity. The existing engine, dashboard, provider adapters and older tests remain local. Full enforced file protection was never completed in the reviewed cloud work.

The surviving documents support reconstruction of intended behavior, but do not substitute for the exact source patch, complete new regression tests, review dispositions or raw verification evidence. Historical claims of 5,724 passing tests apply only to the inaccessible dated tree. Do not carry those claims into reconstructed source.

This turn answers the owner's loss/scope question and records the planning assumption. Reconstruction has not begun. Package A remains incomplete, and the recovery-first instructions in 07/08/09 have not been silently replaced. Before any reconstruction starts, prepare an explicit revised scope and estimate reflecting the unavailable source. All testing, build, activation, real-provider, Docker, publication, deletion and master restrictions remain unchanged. No source code or test cases were edited and no tests, build or OS probes were run. Only this handoff note was added; Ubuntu is to be synced and stopped after document checks.


### Support request and reconstruction pause, 31 October 2026

The owner explicitly requested that the orchestrator send OpenAI platform support a complaint and recovery request expressing disappointment about losing access to substantial work. The owner also instructed: "let's wait for their answer before we reconstruct." Reconstruction is now explicitly paused pending support's response and further owner direction. The separate testing hold remains in force.

A detailed message was prepared for support@openai.com, requesting preservation of the original workspace, restoration or export of its saved filesystem, explanation, and a case reference. It includes the task identity, original source/delivery paths, uncommitted-state warning, observed offline runtime error and the recorded source archive hash. No source code, credentials or raw logs were attached.

One Gmail send attempt returned an internal tool error. Profile lookup and the subsequent Sent-folder verification also failed with internal errors. No message ID, ticket number or delivery confirmation was obtained. Do not record the request as sent or support as having received it. Browser discovery returned "Local browser use is disabled in Work settings"; no setting was changed or bypassed.

The ready-to-send text is preserved at /home/adami/mc-reviewed-delivery-20261029/support-request-20261031.txt. The owner can submit it through the affected task's documented /feedback dialog or their normal support channel. No repeated send attempt or automatic follow-up is scheduled. Source, tests, runtime and cloud workspace remain unchanged. Only this handoff entry and the external request text were written. Ubuntu is to be synced and stopped after the document check.

### Support response and verified conversation timeline, 31 October 2026

The owner supplied a reply from AI-assisted OpenAI support. Support suggested reopening the original task through another surface and trying a fresh signed-in/private browser session for failed downloads; it asked which surface was used and the last successful workspace-access time. Support cited typical saved-state retention, but did not confirm recovery or preservation of this specific workspace. A support conversation is now reported by the owner; no case number was provided. The earlier failed email attempt remains unconfirmed. Product feedback is distinct from a customer-support case.

The owner clarified: "I don t remember, and the original cloud task was opened by you. So you are the last one who had access to its files. I never seen them even". Do not invent a personal file-access time, successful owner download, alternate-surface attempt or sign-out/in result.

Read-only inspection of the existing cloud task transcript confirmed the last successful delivery turn (01a186e0-d763-730b-9ee4-3857c4083b57) ran from 2026-10-29 08:57:24 UTC to 09:45:33 UTC. Its final response reported the dated reviewed artifacts. This is the completion time of the last recorded successful cloud work session, not an exact timestamp of the owner's access or the platform retention clock.

The later bounded readiness retry ran on 2026-10-30 16:54:20–16:58:48 UTC and failed. A further owner-requested cloud retry completed at 21:59:43 UTC on 30 October, again reporting running/offline and "No usable execution environment is available." This establishes a recorded agent-side file-access failure in addition to the owner's download-link failure. No new execution or startup retry was requested in this local turn.

A prior cloud-agent response also records environment ID ccarenv_b64_Y2NhcmVudl9jMWQ0ZmRjYWRhYjg4MTkxODdiYmU5NzhjZjE4ODdkZg for support's investigation. This identifier was read from the task transcript; its current status has not been newly queried. Reconstruction, testing and activation remain paused. Only transcript/document inspection and this handoff update occurred; Ubuntu is to be synced and stopped after document checks.

## 19. Local reconstruction approved for a fresh orchestrator, 31 October 2026

The owner now said: "Okay, I think we should accept that we have lost it. So we'll have to restart the implementation. So prepare the plan, the specs that we already have, adapt them if we need to adapt anything, and then provide me with a prompt I'll take to a new chat with fresh context to take over as the orchestrator and spawn GPT 6.1 soul agents for implementation."

Use the previously agreed exact development model gpt-6.1-sol (GPT 6.1 Sol). This decision supersedes the old requirement to recover the cloud source before coding, the instruction not to reconstruct the missing core, and the wait-for-support reconstruction pause. It is a planning assumption that the exact delivery is unavailable, not proof of permanent deletion. Optional later recovery must be compared separately and must never overwrite local reconstruction. No further cloud recovery loop is required before local preparation.

The owner's separate testing hold has NOT been clarified or lifted. This turn prepares documentation and a fresh-chat prompt only. The next orchestrator may perform preservation, source inspection, inactive pure-module/fixture/test authoring, exact runtime patch proposals and source review. No tests, typecheck/build, OS probes, active runtime wiring/default changes or protection activation until explicit owner clarification. Do not commit untested work. After permission, only the authorized development checks are allowed; real product/provider/account/login work remains separately held.

### Current reading order and work plan

1. Read this handoff completely; newest entries override historical authorization and status.
2. Read [10-reconstruction-plan.md](reduced-mission-control/10-reconstruction-plan.md), the main [build specification](reduced-mission-control-spec.md), original package documents 00–06, and the adapted [07 protection specification](reduced-mission-control/07-remaining-protection-spec.md).
3. Read [11-reconstruction-regressions.md](reduced-mission-control/11-reconstruction-regressions.md) and maintain [12-reconstruction-evidence.md](reduced-mission-control/12-reconstruction-evidence.md).
4. Use the replaced [08-next-orchestrator.md](reduced-mission-control/08-next-orchestrator.md) as the copyable fresh-chat prompt. Document 09 is explicitly historical.

The plan restores P1/P2/P4/P5/P6 on the existing engine, retains P0/P7 and all original requirements, and carries protection I/ISO/T work as an additional conditional stage. RC01–RC08 preserve the later cloud-review lessons: retained retry/test authorship, repaired-feature disclosure, invalid subjects, actual reviewer identity, maker scope and durable pending-write/interruption recovery. All requirements start unassessed for reconstruction; existing code may already meet parts, and the new orchestrator must inspect rather than blindly rewrite it.

Provisional core effort is 38–74 active engineering hours, including baseline/contracts, the five packages and final integration, with low–medium confidence. Protection preparation, the capped experiment and conditional integration are additional. These are estimates, not measured effort or a promise to finish within one chat. Before each stage give size/time/confidence and re-estimate after initial inventory. Use exact Sol model, fork_turns none, at most two workers plus orchestrator, no recursion, one writer plus read-only review by default, and at most two correction rounds before a new estimate. The orchestrator alone integrates shared types/config/state/schemas, dispatcher/executor/run and documentation.

### Source inspection and preservation in this planning turn

Two bounded read-only GPT 6.1 Sol audits inspected the surviving specifications and older code. The source still has the denylist scrubEnv, executor retry results that lose preceding identity/counting detail, whole-prose rejection, mode-only supplied-check preservation and second escape decoding. These are source observations, not new test failures. No reconstructed implementation or fixture exists from this turn.

Current inspected checkout: /home/adami/Mission-control, branch codex/remaining-protection-preparation, HEAD a4a6f4315d5f0af03ec1e28b7539e609c3e2b11a. No branch or source changes were made in this planning turn. At takeover, inspect again, preserve dirty files, and create/reuse a new own reconstruction branch without dropping work. No Git identity was invented.

Before document edits, all 32 prior documentation files and branch/status/refs were preserved under /home/adami/mc-reconstruction-checkpoints/20261030T230909Z-before-plan. The documentation archive was read back and matched its per-file manifest; SHA-256 is 8e43df4ca4f3b108c6ae083c1f32998498f53b031ddf0282e48fad5d230163d8. The timestamp uses UTC; this planning entry uses the owner's local date.

The restart requires verified timestamped source checkpoints outside the checkout at every authored slice and execution gate, including intended untracked files and a per-file manifest. Keep a second verified archive copy in this chat's Windows recovery-backups folder, as an export rather than a source checkout. A tracked patch alone misses untracked work. Preserve old checkpoints. The final documentation review/checkpoint outcome will be appended after it is observed.

All previous owner restrictions remain: Ubuntu-only local project/Git commands; UTF-8/LF edits through UNC; no real product runs, provider/account queries or logins, Docker, API keys, publication/push/PR, deletion or master changes; no root CLAUDE.md or unrelated secrets; preserve backup branches and product models/Haiku; ask before sudo/system installs. The original cloud 5,724-pass record does not validate reconstructed code. Stop at the testing gate and report authored-but-unverified work honestly.


### Reconstruction handoff review and closing checkpoint

Both bounded GPT 6.1 Sol reviewers accepted the revised documents for source/specification planning. One clarification was applied: 10 R0/R1 replace the old exact-delivery recovery prerequisite, and the adapted 07 A–F cover the reconstructed-core state and later protection work. This is documentation/source-review acceptance only, not implementation or behavior validation.

Document checks passed on 15 changed/new Markdown files: UTF-8/LF/whitespace, 254 local links, all 118 original package requirement IDs unchanged, complete ISO01–ISO20 and T01–T20 sequences, and 166 individually listed B/R/E/I/H/U/F/V/ISO/T/RC ledger rows. C1–C8 and all ten combined scenarios are also retained. The previous HANDOFF prefix and unrelated prior documents remain unchanged. Git refs are unchanged, the tracked production diff is empty, and no new non-document repository files were introduced.

The closing checkpoint directory is /home/adami/mc-reconstruction-checkpoints/20261030T231907Z-reconstruction-plan. Its second-copy destination is C:\Users\adami\projects\Mission control Harness\recovery-backups\20261030T231907Z-reconstruction-plan. The source archive includes 514 explicitly inventoried source/document files, including intended untracked documents. The checkpoint also retains base Git history, tracked changes, untracked-file inventory, file hashes, current handoff/ledger and the copyable prompt. Archive construction/verification outcomes are recorded in completion.json in those directories; if that record is absent or does not report matching archives/copies, treat the checkpoint as incomplete. The preflight found no suspicious excluded directory, local credential filename or symlink among the selected members.

No source/test implementation, tests, typecheck/build, OS probes, product/provider work, installations, Docker, Git commits/writes to refs, publication, deletion or master changes occurred. The next work is the new-chat prompt's local preservation/inventory and inactive preparation, followed by the testing discussion gate. Stop Ubuntu after the closing archive checks when both read-only workers are idle.

## 20. Local reconstruction preparation, 31 October 2026

The owner explicitly started the preservation, source inventory and bounded inactive preparation from plan 10. Cloud recovery is not a prerequisite. The testing hold remains exactly as stated:

> My testing hold remains. You may inspect, author inactive modules, fixtures and test cases, prepare runtime patch proposals, and perform source review. Do not execute tests, typecheck/build, OS probes, active runtime integration or protection activation until we discuss testing and I explicitly clarify permission.

Source: `/home/adami/Mission-control`. New working branch: `codex/local-reconstruction-preparation-20261031`. Base HEAD remains `a4a6f4315d5f0af03ec1e28b7539e609c3e2b11a`. Existing dirty work was preserved before branching or editing. No applicable AGENTS.md was found in the checkout or named Linux ancestors; root CLAUDE.md was not read.

The verified starting checkpoint is `/home/adami/mc-reconstruction-checkpoints/20261030T235245Z-r0-preserved`. Its 514 regular source/document members matched the SHA-256 manifest and current bytes. Original status/refs, Git history bundle, tracked binary patch and untracked inventory are retained. The second verified export is `C:\Users\adami\projects\Mission control Harness\recovery-backups\20261030T235245Z-r0-preserved`. Source archive SHA-256: `d7a9b954a55a2353178f80e451fe912e6208d3202015a64b931193001b57cbaf`. Both directories contain completion.json. The only new ref is the reconstruction branch; previous refs are retained.

Read [13 source inventory](reduced-mission-control/13-preparation-inventory.md), [14 invocation/evidence contract](reduced-mission-control/14-invocation-evidence-contract.md) and the updated [12 ledger](reduced-mission-control/12-reconstruction-evidence.md). Two exact gpt-6.1-sol workers were dispatched with fork_turns none, no reasoning override and no recursion: one bounded P1 author and one read-only inventory/reviewer. The orchestrator alone edits documentation/shared files. The author is restricted to new src/provenance.ts and src/provenance.test.ts after design review. No existing runtime wiring is authorized.

Source findings: internal retries discard earlier identity; dispatcher interruption markers clear before cleanup and durable result recording; recovery clears the marker before recording uncertainty; feature premerge passingCommit differs from integration commit; dashboard's existing projection substitutes a reviewer value and blanks test hashes, so it cannot become an evidence source. These are inspected defects/risks, not observed new failing tests.

The bounded preparation freezes a conservative pure evidence-reader contract and proposes the joint invocation reservation/pending-write ordering. Runtime ledger schema, legacy reconciliation, application-wide aggregation and same-subject revalidation remain further work before integration. Environment, helpers, allowance, plan, browser and protection requirements are inventoried and remain open. No new isolation fixture or operating-system result is claimed by this P1 slice. Core estimate remains 38–74 active hours, low–medium confidence, with protection additional; the source inventory does not justify a narrower estimate before execution evidence.

Current evidence is source/design review and archive/document checks only. No tests, collection, typecheck/build, OS probes, product/provider/account/login work, dependency installs/audit, Docker, commit, push/PR/publication, deletion or master changes have run in this takeover. Product models, including Haiku, remain unchanged. Historical local/cloud passes are not reconstruction evidence. The final reviewed-slice checkpoint and stop outcome will be recorded only after observed verification.

### Testing-gate handoff

The bounded inactive slice is now checked by a second Sol AI against the written contract. It consists of `src/provenance.ts` and `src/provenance.test.ts`, with 43 authored test definitions, all unrun. It reads actual identity and retained-contribution records conservatively; nothing imports it into production. No owner approval of reconstructed behavior or successful execution is recorded.

The separate reviewer required two focused correction rounds. Round 1 grounded test authors in valid retained file members and removed unknown nested fields from returned subjects. Round 2 excluded every entry for an ambiguously duplicated test path. Final source review found no significant unresolved issue within this small slice. Exact accepted hashes: module `d3cd25b4bb629d47db2819fdebbdf988146bbaf0e5007262511321b7833f8414`; test source `b810f6dec952282648b0a5c6e1b65dac9f3c2249aed4e6111d89dfe60208afaa`. Detailed review history remains in 12.

This is not completion of R1/P1 or the reconstructed core. Durable invocation storage/recovery, same-commit snapshot update rules, whole-app aggregation, CLI/report/dashboard integration and remaining packages are unfinished. No isolation fixture or enforced protection was added. All pre-existing source, tests, product model configuration and dependencies remain unchanged. No existing test was weakened. The initial HANDOFF text and unrelated dirty documents are preserved.

An intermediate verified checkpoint is `/home/adami/mc-reconstruction-checkpoints/20261031T000117Z-r1-contracts` with its matching Windows recovery export. It preserves 518 files before code corrections, explicitly labeled unreviewed/unrun at that time; archive SHA-256 `e6c69efb6827e079c1dd64585a5990a27b017e5fdbd1af4a56d4e42a71416b3c`.

The final reviewed-slice/testing-gate checkpoint destination is `/home/adami/mc-reconstruction-checkpoints/20261031T000635Z-testing-gate`; the second copy is `C:\Users\adami\projects\Mission control Harness\recovery-backups\20261031T000635Z-testing-gate`. The authoritative archive/copy verification outcome and hashes are recorded in `completion.json` in both directories after this document is frozen. Treat the checkpoint as incomplete if that receipt is absent or not verified. This avoids claiming an archive verified before it exists, or making its manifest refer to its own hash.

Next actions: discuss exactly which development checks the owner permits; after explicit permission, run the preserved baseline and record actual results before runtime integration; finish and review the durable lifecycle contract, then integrate/test bounded slices. Synthetic OS experiments require their own clearly allowed scope and remain capped. Real AI/provider/account/login work, Docker, publication/push/PR, deletion and master changes remain separately prohibited. No commit before the required full check and valid identity. Keep the two backup branches and all checkpoints.

Both development workers are finished. Ubuntu may be synced and stopped after final document/archive verification. The observed stop and final archive result belong in the chat/receipt, not an assumed success here.

## 21. Owner authorizes local reconstruction checks, 31 October 2026

The owner requested completion of the lost implementation, then answered **Yes** to lifting the hold for local automated tests, typechecking and builds. They further stated: "Yes, you can run tests and you can spawn agents, GPT-6.1 soul agents, with at least minimum medium thinking level, if not high or more."

This explicitly opens plan 10's local development-check and core-integration gate. Use exactly `gpt-6.1-sol`, `fork_turns: none`, with high reasoning for the two current workers. The new reasoning instruction supersedes earlier instructions not to override the setting. One writer and one read-only reviewer remain the default; no recursive delegation. The orchestrator owns shared runtime files and documentation.

Real AI/product runs, provider/account queries and logins, Docker, synthetic isolation/OS experiments, protection activation, publication/push/PR, deletion of existing work and master changes remain prohibited. No dependency installation/download/audit is inferred from permission to run tests. Existing test-owned temporary fixture lifecycle is part of authorized tests; preserved source and backups must never be deleted. Product models and Haiku remain unchanged. Native commands run inside Ubuntu only.

Continue on `codex/local-reconstruction-preparation-20261031`, preserving all dirty work. First retain a fresh complete checkpoint and run the existing check against that source, then integrate bounded reviewed packages. Historical cloud results remain historical. New test results require raw logs, immediate exit records and source identities. No commit before a passing full check and a valid configured identity; no commit is necessary for recovery checkpoints.

Work is in progress. The provisional core estimate remains 38–74 active engineering hours, low–medium confidence; this is not a completion promise. P2's first design/implementation slice is bounded to 60–90 minutes before checkpoint/review. Protection remains a separate unapproved stage. Exact observed results and checkpoint paths will be appended when available.

### Verified helper-controls slice

P4 is implemented and separately source-reviewed: all eight helper combinations, persisted new-mission settings, legacy all-on behavior, corrupt snapshot rejection, CLI creation paths, raw failure preservation, supplied-plan reuse, owner stops and required Haiku/escalation stages. Local full check and build both exited 0 against unchanged complete source inputs: `/home/adami/mc-reconstruction-evidence/20261031T003036Z-p4-integrated-corrected`. Result: 5,818 passed, 15 skipped across 94 passing files. Skipped browser/Pandoc prerequisites remain open for final reconciliation.

Existing tests were changed only to expect the new persisted helper snapshot and visible helper settings: state exact-object expectation, report expected text with historical golden files preserved, dispatcher mission-key comparison, and CLI mission-key comparison. The earlier provenance fixture typing/table correction is separate. All failed/intermediate logs are preserved. No cloud result is reused as local validation.

P2 pure module is tested/reviewed but runtime wiring remains open. P6 and P1/P5 remain open. This is a checkpoint, not completion of the lost implementation. Next work uses a separate Ubuntu worktree for the bounded P2 writer, overlaid from this exact preserved dirty source, while the orchestrator owns central P6 changes. No active protection or real provider work is allowed.

### P6 focused reconstruction, pending full check

Automatic supplied-plan revisions now reconcile against immutable PlanSource.spec: checks/order, IDs, dependencies, kind, mode, effort and expectations remain. Technical wording may apply; latest partial/rejected edits are recorded and displayed. Invalid originals stop with the actual validation problem. Owner send-backs retain their separate existing rules. Every multi-feature test author, builder and maker receives scope instructions; actual later-file overlap appears in the owner look, CLI details, report and report facts. This is prompt/disclosure behavior, not filesystem enforcement or proof of AI obedience. Parsed planner text remains literal; historical R3 fixture and external plan grammar/hash stay unchanged.

Local evidence: 20261031T003843Z-p6-red reproduced 14 defects (one control passed). 20261031T004033Z-p6-compatibility had 886 passes and 21 failures in deliberately obsolete behavior expectations. Those expectations were updated narrowly without deleting historical fixture files. 20261031T004434Z-p6-corrections had 344 passes and one new fixture field-name error, now corrected. 20261031T004602Z-p6-reviewed-focused: typecheck exit 0; 345 tests in 8 files passed, no skips; complete input hashes unchanged. Reviewer findings corrected semantic equality, strict enum parsing and early validation of unusable supplied plans. Full check/build and final source acceptance remain pending; no core-completion claim.

P2 wiring is in the isolated Ubuntu worktree codex/p2-reconstruction-20261031. Its positive-environment adapters and focused fake-child checks are under separate review, including temporary-directory cleanup and metadata-child lifetime. Root retains central integration ownership. Latest verified full-source checkpoint remains 20261031T003635Z-p4-checked (523 members, source archive SHA-256 02ee9715507d36d62bf3325c079ddcb0bccb3dd814447dc1cf4680ed4a69ba37), with matching verified Windows recovery copy.

### P6 source acceptance and final compatibility correction

Separate Sol source review accepted the bounded P6 implementation. Full local check 20261031T004723Z-p6-integrated reached 5,850 passed, 15 skipped and one historical R45 expectation failure; build exited 0 and complete source inputs stayed unchanged. The remaining test expected automatic review to replace supplied checks. Its complete comparison assertions are retained, now exercised after an explicit owner send-back, with an added assertion that automatic replacement was rejected. Focused 20261031T005045Z-p6-owner-comparison passed all 14 cases, exit 0. The owner guide now explains literal text, all-multi-feature scope/disclosure and automatic rejection versus explicit owner changes. Full combined verification follows P2 integration; do not describe the last full check as passing.

Draft 16-durable-lifecycle-design.md prepares the joint P1/P5 transactional work and awaits design review. It is not implemented. P2 writer froze 24 owned files in its isolated worktree, with 670 passing focused cases and 13 browser skips; root-owned launch sites are the only remaining typecheck errors in that worktree. Final P2 source acceptance and primary integration are next. No prohibited runtime/provider/protection work occurred.

### Combined P2/P4/P6 local check passed

The integrated primary tree passed native Ubuntu `npm run check` and `npm run build`, both exit 0, in `/home/adami/mc-reconstruction-evidence/20261031T005211Z-p2-p6-integrated-retry`: 5,880 passed, 15 skipped, 97 passing test files. Complete source inputs matched before/after. This validates the executed stand-in/unit/integration cases only; browser prerequisites and real provider compatibility remain untried, and no OS protection is claimed.

P2 now covers provider workers, metadata, verification, rendering and controller Git/diagnostics with explicitly constructed environments and owned temporary homes. Its isolated source review and 670 passing focused cases are retained in 20261031T003725Z-p2-wiring. The first primary integration check (20261031T005151Z-p2-p6-integrated) failed typechecking before tests because new-file patch headers prevented transfer; no files were applied by that rejected patch. Exact before/after hash-verified transfer plus root-owned launch-site changes corrected this; integration-receipt.json records the transfer. Failed logs remain preserved.

P6 source review and the complete owner-change comparison assertions now pass in the combined tree. P1 runtime provenance/recovery and P5 allowance admission remain unfinished. Draft 16 has reviewed design direction but its exact persistence contract still needs review before coding. This is verified partial reconstruction, not recovery of the whole lost implementation. The next checkpoint receipt will identify the matching Ubuntu and Windows source archives.

### Durable invocation reservation/recovery slice under final verification

New invocations.ts records each actual attempt before launch, including executor retries; requested candidate identity stays separate from observed actual identity. A failed reservation launches nothing. Observation and existing cleanup procedure are durably acknowledged before retry. Accepted-contribution adoption is still absent: cleanedAt is not evidence of restoration/isolation, and controller/other default context cannot establish independence.

The journal preserves the legacy count, validates present history, skips reserved IDs without logs and blocks damaged records even for optional calls. Recovery persists one key/count/tally, marks uncertain writes, then synchronizes scratch; handled decisions replay after interruption without double counting. Threshold decisions are acknowledged only after their effect. Persistence failures preserve the stage and stop before another AI call.

Evidence: 20261031T010244Z-invocation-red could not collect the not-yet-created module; no behavior pass claimed. 20261031T010521Z-invocation-executor-red reproduced four lifecycle failures with 69 controls passing. 20261031T010631Z-invocation-dispatcher-red reproduced six integration failures. 20261031T010717Z-invocation-dispatcher-first typecheck0,174pass/3old-expectation failures. Narrow old-test changes now count actual aborted/auth attempts; the legacy scratch test explicitly removes the new journal to simulate an old mission. 20261031T010852Z-invocation-review-focused passed typecheck and all191cases in5files, source stable.

Read-only review required exact recovery-tally/chronology validation, wrapping scratch-save failures, bounding legacy marker payload and truthful outage wording. Round1 corrections add baseline tally history and explicit reset records, strict v1 fields and three scratch-write failure positions. 20261031T011200Z-invocation-review-corrections passed116cases; a TypeScript closure-narrowing error was then fixed. Full check/build 20261031T011226Z-invocation-integrated and final source acceptance are pending. No provenance adoption/finding/allowance completion is claimed.

Latest verified complete checkpoint before this slice: /home/adami/mc-reconstruction-checkpoints/20261031T005938Z-p2-p6-checked, 529members, source SHA256 e922b82434b49058aaea572c5dda4cd5e30996b557def20e08325c225e6f532d, matching verified Windows recovery copy. Both workers remain exact gpt-6.1-sol high; environment_writer has accepted P5 pure/quota design and is implementing only owned modules in its refreshed isolated worktree; reconstruction_reviewer is read-only.

Skipped prerequisites reconciled from the combined log and source gates:13real-render cases in src/render.test.ts,1drawn-page case in test/modes-tiles.test.ts,1optionalPandoc case in src/util/ai-text.test.ts. No browser installation, OS experiment or provider query is inferred. Product models and Haiku remain unchanged.

### Invocation slice accepted and full local check passed

Second source-review correction round accepted the actual files. Both final corner cases were reproduced (20261031T011431Z-invocation-round2-red:2fail31pass), then corrected: new reservations reject terminal metadata; a shared interruption tally clears only after all already-recorded same-label recovery decisions are handled. Focused20261031T011453Z-invocation-round2-focused:141pass4files,typecheck0. Old golden fixtures remain unchanged; the expected new mission-key set adds invocations, and two outage assertions now compare the count with actual stand-in calls.

Final frozen native Ubuntu check/build20261031T011557Z-invocation-accepted-full both exited0:5,929passed,15skipped,99passing testfiles; complete source hashes unchanged. Prior full20261031T011226Z-invocation-integrated is retained honestly:5,916pass/15skip/11obsoleteexpectationfail,build0. The corrected full run includes outage/night-store cases and does not reuse historical cloud evidence.

This closes the bounded U19–U21 reservation/count/cap behavior with local stand-ins and reviewed recovery ordering. RC07/RC08 still need accepted-contribution adoption and complete provenance integration; P1/P5 are not complete. Three new source files are invocations.ts, invocations.test.ts and invocations-dispatcher.test.ts. The next verified complete checkpoint receipt covers this slice plus all previous dirty work. No product/provider/OS-protection run, install, push, publication, commit or master change occurred.

### P1 report prose focused slice

Mixed/review mission reports now preserve unaffected narrative sentences and capability items. Existing conservative checking/no-record detectors and safe denials are unchanged. Removed claims are replaced by one recorded per-feature checking-facts section, and the footnote describes that action. Ambiguous punctuation and multi-backtick spans fall back only for the affected field. Helper-disabled reports keep their existing deterministic path; no extra AI call is added.

Evidence:20261031T011825Z-report-prose-red reproduced4failures with163controls passing. First implementation had141pass/32oldwhole-summary/footnoteexpectation failures; those assertions now check preservation of safe fields while every forbidden-claim assertion remains. 20261031T011921Z-report-prose-focused passed202cases/typecheck0 including helper combinations/R6 flows. Read-only review found post-removal unbalanced delimiters, reproduced3fail167pass then corrected176pass/typecheck0. Round2 reproduced double/four-backtick cases2fail170pass. Final20261031T012256Z-report-prose-final-focused passed172reportcases/typecheck0, full source stable. Final bounded source acceptance and combined full check remain pending.

The complete checked invocation checkpoint is /home/adami/mc-reconstruction-checkpoints/20261031T011804Z-invocations-checked (532members, archive SHA256eeb20ff6c04eac0d13bf47b58a75a52698b0452e4209284493e6ddb153a43e10) with matching verified Windows export. A separate focused-prose checkpoint preserves this authored slice honestly before further work. P1 retained-contribution runtime/finding resolution and P5 admission remain incomplete.


### P5 pure allowance and P1 finding audit preparation

P1 prose source review accepted the final focused slice after the two documented correction rounds. The verified 532-member focused checkpoint is 20261031T012324Z-prose-focused, source SHA256 026a519093f88071149aa67032bf49e00d9a2e471d3b0d3307f251c20dcba90b, with matching Windows recovery copy.

P5 pure allowance/quota correction 1 passed separate source review and 133 focused tests plus typecheck. Four files were transferred from the isolated Ubuntu worktree only after exact before/after hash verification; receipt: 20261031T010841Z-p5-allowance/primary-integration-c1.json. It retains controller receipt times, strict unknown reasons, ambiguity, bounded restore and existing numeric caps. Metadata refresh, strict admission, configuration and UI remain unfinished. One worker outage compatibility case failed then passed standalone; the cause remains unconfirmed and both logs are retained.

The new inactive finding-resolution module retains stable finding IDs and audit history, with closure bound to the current unchanged reviewed SHA and exact verification SHA for blocking findings. Legacy, damaged, stale, duplicated and oversized data cannot silently close findings. Runtime integration is absent. First focused typecheck found a Vitest table-spread typing error; the table was corrected and corner cases added. Frozen 20261031T012800Z-finding-pure-review-focused: typecheck0, 170 passed in three files (37 finding,50 allowance,83 quota), source unchanged. Actual finding source review is pending. Latest full combined check remains 5929pass/15skip/99files plus build0 before these newer slices.

Root added only the approved shared allowance batch/read metadata types and readonlyMutation result field, plus batch recording in executor. A new complete paired checkpoint will preserve this state before the isolated writer proceeds with metadata/parser work. No real provider calls, OS experiments or protection activation occurred. P1/P5 remain incomplete.


### Finding pure accepted; P5 admission and dashboard under review

Finding-resolution correction accepted after a history-wide immutable review-job context check. Evidence20261031T013257Z-finding-context-red:5fail38pass;20261031T013306Z-finding-context-corrected:type0,176pass3files. Module SHA8d301350d1974ccf1251df34494b563760ea95272adc7a43262c3350c7ba8864; testd06d21c4c4b44b2803daea26e350d154981e1e07fbf7df81d3f2c38da7eabf27. Pure only; no runtime adoption/closure yet.

Combined frozen20261031T013322Z-pure-slices-combined reached6048pass/15skip/1old-report-footnote expectation failure, build0. This is NOT a passing full check. The historical R6 fixture was preserved; only its old whole-summary wording assertion now expects the reviewed replacement footnote, retaining the forbidden-test-claim assertion.

P5 root admission now captures stop/warn policy for one invocation. Omission remains distinguishable and effectively warn; new template explicitly stop; invalid including explicitnull rejected before merge. Strict mode checks required aggregate freshness before each actual attempt, one optional metadata refresh per provider/decision, no metadata model charge. Cap precheck precedes metadata/waits, finite known limits can wait, auth remains separate, stop/exact deadline wins. Unknown required work records additive allowance pause with unchanged stage/decisions; optional work skips. Pause removal rolls back if reservation save fails. Reports/run summaries show policy and reserve uncertainty.

Evidence20261031T013541Z-admission-config-red:14fail192pass;013619first:type0,202pass4fail (three obsolete template/deadline expectations and null loader defect), corrected. 013650dispatchred:2fail13pass;013717:type0,221pass4files;013755ordering:type0,239pass5files including run/outages. Source review found post-await freshness boundary gap;014046red reproduced1fail88pass then corrected selection/wait rechecks.

Dashboard now reads canonical observation identities before sanitization, shares allowance interpretation, never treats mtime/legacy receipt as freshness, overrides green Plenty for unknown evidence and displays reason/last receipt/policy. Known numeric high-use/limit constraints remain visible. Dedicated allowance pause is distinct from owner approval. Two optional strictly typed snapshot fields are added and rendered as text. Historical snapshot fixtures are untouched. 014016first had539fail161pass from obsolete strict shape plus old green expectations and a new fixture missing ID;014105 had collection errors from wrong optional-helper spelling; both corrected without broad shape relaxation. Final frozen014118:type0,789pass6files including random-home invariants and89executorcases. Separate final source review remains pending; no complete P5/full-core claim.

Latest verified paired complete checkpoint before this work:013211-allowance-finding-preparation,536members, sourceSHAf61adc3e606f315ab9f79af818aa883c202992d19ceb3fc41635b2c89783e0d7. The isolated writer's fake metadata/runner tests are in progress; no real provider query, OS experiment, protection activation, install or publication occurred. Next: reviewed runner integration, complete P5 verification, then P1 retained-provenance and finding runtime.


### P5 review corrections and compatibility verification

Admission and dashboard source are accepted after the documented corrections. Unknown allowance uses conditional limit wording: a new allowance check can be made after the old restriction, never a promise that a model job will restart. New tests prove expiry does not invent fresh readings. Evidence014525:198pass2files/type0. Earlier frontier014233 reproduced1fail92pass then014247 passed257/type0. Display014342 reproduced4fail93pass then014408 passed571/type0.

Full primary before runner integration014635:6009pass/15skip/82fail in7files; build0; complete source stable. Failures were old exact mission-key/sentence/snapshot/demo expectations and a long-dash wording regression. The long dash was corrected to a colon. No original wording guard or historical SHA/JSON fixture was removed. New test-only allowance-legacy-projection asserts the new uncertainty/no-green/caption/conditional-time behavior, then reverses only those documented allowance fields for historical whole-output comparisons. All49 historical snapshot hashes and10 demoJSONgoldens remain unchanged. Source-reviewed compatibility acceptance remains pending.

014944 compatibility reached188pass/2remaining old expectations; corrected one feature checkpoint sentence and regenerated dashboard/demo.html from the current index/current fake snapshots. Targeted015121 demo-page generation passed26cases and intentionally changed only dashboard/demo.html; it is generation evidence, not frozen-source validation. Final015127:type0,138pass5files, source unchanged, including a new strict coordinator test with one dedicated pause, zero model calls and recorded summary policy. Latest full run is still not passing; runner integration and a fresh complete check remain.

P5 runner c1 in isolated Ubuntu worktree passed358cases/6files and typecheck0; reviewer found and corrected malformed known Claude unified-window payloads that previously left an older fresh reading in force. Exact seven files and c1 hashes are in013428Z-p5-runners/handoff-c1.json. Original artifacts retained; primary integration awaits separate c1 source acceptance. Real provider/account/billing compatibility is not tested. P1 retained-provenance and finding runtime remain unfinished.

Owner guide and08 next-orchestrator instructions now reflect the explicitly lifted local-check hold and high Sol reasoning. Protection/OS experiments and real AI remain prohibited. The guide's reduced example now explicitly sets unknownAllowance:stop; legacy omitted settings remain effectivelywarn without rewriting them. This policy is per invocation, unlike per-mission helper settings.


### P5 accepted local checkpoint; P1 runtime continues

Runner C1 and compatibility projection passed separate read-only source review. Seven runner files were integrated after exact before/after hash checks, receipt013428Z-p5-runners/primary-integration-c1.json. Initial combined015420:6141pass/15skip/2old dashboard sentence failures, build0, unchanged source. Both narrow assertions were corrected to include the saved per-run allowance policy. Final frozen20261031T015807Z-p5-accepted-full: npm run check exit0,6143passed/15skipped/101passingfiles; npm run build exit0; complete source manifest unchanged. Skips remain the previously reconciled13render/1drawn-page/1optionalPandoc prerequisites; no dependencies were installed. This is new local stand-in evidence, not historical cloud validation or real-provider compatibility proof.

P2/P4/P6, invocation accounting and P5 allowance/runner/config/dashboard slices are source-reviewed and locally full-checked. P1 provenance adoption, finding runtime and all-surface disclosure still remain. Next independent pure provenance graph/revision design was accepted with exact chain selection, global raw-ID collision detection, cumulative nested budgets, independent controller merge context and narrowly qualified application coverage; contract16 records those invariants. One isolated Sol-high writer owns only provenance.ts/test.ts after checkpoint refresh; root owns runtime/shared files, reviewer remains read-only. No model pins, master, provider accounts, protection settings or publications changed.

The next paired checkpoint includes537explicit source/document members, the new test-only allowance-legacy-projection.ts and all preserved prior work. Its completion.json is authoritative for archive and Windows-copy verification. Do not call P1 complete from this P5 checkpoint.


### P1 finding runtime in progress, not yet accepted

P5 closing pairedcheckpoint verified:20261031T020002Z-p5-checked,537members, sourceSHA3dd68181b662dc12780550fc0b297e77a4cb41d751dcb10be6cc1f05aa7aff08 with matching Ubuntu/Windows copies. Its full local6143pass/15skip/typecheck0/build0 remains the latest accepted complete check.

Finding runtime now adds distinct strict finalReview schema, outstanding original IDs, actual final jobId, anchored clean integration SHA before verification/review, explicit resolution history and atomic open-finding projection. Historical feature-review schema/goldens remain unchanged; finite fake GateC answers now explicitly include resolutions. Ordinary reports retain open notes and display qualified resolution audit. Source review identified two additional correctness edges: newly reported final concerns must stay visible even when review has no completed-evidence credit, and failed/budget-exhausted reopening needs durable uncertainty so a later projection cannot revive an older closure. Corrections and regressions are pending; this is not accepted code yet.

Evidence020245runtime red8fail6pass included two test harness mistakes, corrected020316 still8fail6pass for missingbehavior.020417reopenred1fail46pass.020546first234pass/2obsolete-schema-listfail/type1testthis-annotation; all corrected.020648expanded354pass/1restartfixture branch-checkoutfailure/type0, corrected.020807focused166pass5files/type0stable includes existing mode/checkpoint/dashboard agreement and20runtimecases. A separate worker finished the inactive provenance graph/revision slice136cases/type0; two files frozen in020044Z-provenance-graph, source review pending. Root remains shared-file integrator. P1 runtime/provenance is unfinished and no real AI/protection/OS work is authorized.


### P1 finding runtime and extended pure provenance: full local check passed

Separate source review accepted finding runtime, durable uncertainty/reopen correction, and all additional boundary tests. Evidence021019red4fail21pass;021106corrected244pass3/type0;021307finalfocused423pass5/type0stable (27runtime,49pure finding cases, plus report/schema/prompt). Accepted production hashes: dispatcher47b29da3efbfc54e4df21f8c2f6ab885b55c8de8ab895f363449192a539ecdf5, finding-resolution0365b9b8e213614bb9d7be5172c13552dc3485208440dea727ad06a01229b761, report3575c8e3a9943327ddc33fc3ce5eb36a9fb7f82d4680056b2b681bcb8282b401. Full history/open/save-failure cases retain failed logs and no cloud assertions.

Extended pure provenance graph C1 passed separate source review and140cases/type0. Exact two-file transfer receipt020044Z-provenance-graph/primary-integration-c1.json verified against baseline020002. It validates same-subject revision chains, exact merged feature selections, global raw-ID collisions, cumulative graph budgets and independent app context, and rejects application context on direct feature/test/plan queries. Runtime contribution adoption/merge-ledger/surface wiring still absent.

First combined021417check failed honestly:6206pass/15skip/27fail in3files, build0stable. The ordinary per-feature review prompt had accidentally received the new final-review instruction; it was restored exactly. Older e2e stand-ins now explicitly return final resolutions[], and the historical prompt comparison adds only the specified GateC instruction/section while preserving original golden bytes.021714focused89pass3/type0stable. Final frozen20261031T022001Z-finding-accepted-full check0:6233passed,15skipped,102passingtestfiles; build0; full source manifest unchanged. Narrow final compatibility source review is pending; no new runtime behavior was introduced by the fixture correction.

Next accepted design in16 delegates only new retained-work.ts/test.ts to the isolated Sol-high writer after a verified paired538-member checkpoint. Root owns capture I/O, journal/state/shared integration and app merge ledger. Snapshot equality proves no retained delta, not no writes/protection. Legacy progressed work starts unknown, damaged raw state is retained, and all relevant restoration/save gaps stay uncertain. P1 R01–R09 and RC07/RC08 remain open. No real provider/model/account/OS/protection/Docker/install/publication/master activity occurred.


### Source capture and exact commit proof accepted

Final finding prompt/fixture compatibility received separate source acceptance after full022001:6233pass/15skip/102files/build0stable. The complete paired538-member checkpoint022321-findings-checked verified source SHA4b8adeb6c293286d85afa4e59b877dce888dac99b74afd76e36c3d8d4c01e3da. Before worker refresh, all531prior worker files were preserved as paired022355-worker-refresh SHA4f019919c69b16fb16abe925761efd74fcaf3d9e17ac6c440f228fcbacb601aa; its checkout was then refreshed from the exact538-member primary archive without deleting old work.

New inactive work-capture.ts/test.ts provide bounded observational source snapshots and separate exact committed-tree proof. Stable filesystem snapshots alone cannot earn commit credit: hidden index flags and staging can mask changed bytes. captureCommittedTree independently enumerates the exact commit with replacement objects disabled, validates supported Git object format and unique regular tree entries, hashes raw blob header/bytes alongside SHA256 in repeated bounded fd scans, and requires complete path/mode/content/HEAD agreement. All failures return incomplete empty captures. Paths with ambiguous UTF8, nonregular files, malformed scope/limits, movement, overflow or cancellation fail closed. Duration is monotonic; mode follows Git owner-executable semantics. This is not OS isolation or proof that a process never wrote.

Evidence022600red4fail8controls;022735focused177pass/type0. Review C1:023302red8fail18controls;023315190pass1bad-literal-newline fixture/type0; corrected023331191pass/type0. Exact-tree proof023423red3fail34controls;023454202pass/type0;023523207pass/type0. C2 replacement/object-format/empty-record cases023618red4fail45controls then frozen023629-capture-proof-c2-focused:type0,214pass/3files,49scanner,source unchanged. Separate read-only source review accepted module SHA07eecc05af3bbfb527649a3c014a7626b04880e791f9c80b402c33eb607b53d5 and test SHAf4e0d95e8b24c857540dbd7cde31973548090243c95c0d2e515416832ff8a57c. Tests use temporary local Git/files and fake process boundaries only; no real product/provider or OS-isolation experiments.

P1 retained contribution adoption, merge ledger, runtime review identities and consistent surface wording remain unfinished. One Sol-high writer owns only retained-work.ts/test.ts in the isolated checkout; root owns all shared integration. The next complete paired checkpoint has540explicit source/document members, adding the two capture files. No package completion claim follows from this focused slice.


### P1 disclosure preparation and review runtime proposal

Accepted capture-proof checkpoint023847 has540members, sourceSHAd5fa0fa2dd4c9c4f9f8d0e13c360228583c3759538689027d405b699802139cc, verified matching Windows recovery copy. The latest complete passing check remains022001; newer source slices have focused evidence only.

Inactive review-disclosure.ts/test.ts now reuse the canonical provenance interpreter for descriptive family wording: explicit unknown legacy identity, retained overlap even when partial, different-family claims only when established, separate frozen test authors, and app comparison limited to retained AI work of this mission. No model/path/raw malformed values enter its fixed owner vocabulary.024013red16fail;024054155pass1incorrectapp-context fixture expectation/type0, corrected to the acceptedPC07 behavior (recorded current app review may remain known while aggregation/relationship is unknown).024121type0/156pass2files/stable received separate source acceptance. ModuleSHA2146e5b4c721f3560ae20625838168bdb0c918ce93427974a794053647479a1f. Added suggested surface boundaries at024753:type0/159pass2files/stable,19disclosure+140pure. Production surfaces still unchanged.

New provenance-dispatcher.test.ts authors14runtime cases,024412red13fail1control as expected before implementation. It covers actual feature/rubric/plan/final jobs, fallback, malformed review, readonly mutation, changed subject, missing ID, damaged raw history and save rollback. This deliberately failing new test file means the current full suite is not claimed passing. A narrow test-helper follow-up tolerates malformed envelopes and selects review stage explicitly for future builder evidence.

An inactive copied runtime proposal is under /home/adami/mc-reconstruction-evidence/review-runtime-proposal/src; no primary dispatcher/type changes are applied yet. It acquires exact committed captures around each actual review invocation (not only the outer request), derives identities from observed/cleaned journal entries, uses explicit scope/stage/subject, and rolls back audit adoption on persistence failure. Plan and whole-app records stay separate. Required strict appendReviewEvidence is part of the isolated writer's retained-work module and awaits source review. Root owns all shared integration. P1 retained runtime, merger ledger and all-surface agreement remain unfinished.


### Application ledger accepted; interrupted-write restoration accepted

Root inactive application-ledger.ts/test.ts records a known pre-write baseline, immutable scaffold source once merging begins, exact source snapshot selectors, and a durable pending merge attempt before Git. Finishing requires the matching fresh operation receipt and committed capture; two ancestry checks alone cannot reconcile a save-failure gap. Unexpected later descendants stay unknown. No-op and fast-forward forms, repeated intent, changed source revision, malformed records, root/capture mismatch and bounded storage are tested. Source accepted SHA54c107f5ae0e83459dec2627cd03cac9cb1b5d4ffc5a3233a8ceeb85ab12c14a, test09936a1f783d0b9c12cbd9010d7ce891a0e10580a832239215e0501d337de928. Evidence025533red23fail5controls;025738source regex-escaping error/type1 corrected;025757217pass/type0; frozen025850type0/218pass3files/29new stable. Root runtime still must resolve exact feature snapshot selectors, compare every delivered feature, use replacement-disabled Git and exact merge-form/tree proofs, and save ledger/provenance/tracking/feature state atomically. No runtime ledger imports exist yet.

Review-runtime proposal received conditional source review. A stop/deadline arriving during awaited pre-capture could otherwise still launch a reviewer; a new checkStop directly after capture fixes the proposal. New tests cover both stop/deadline and first/last fallback capture validity.025002-review-runtime-ordering-red:type0,16fail2controls stable, expected because proposal remains inactive. Current full suite is deliberately not passing while those runtime regressions await strict append integration.

First retained-work worker review found four material defects plus semantic-key-order replay: cross-scope checkpoint/envelope binding, inability to retire active unobserved crash intents after exact full restore, loss of known members despite an intact basis checkpoint, and uncertainty erased on deleted-test recreation. Worker is correcting only its two isolated files; no primary transfer occurred.

Root added strict optional journal restoration proof {at,checkpointId,subject,cleanupComplete:true}. Only an explicit scoped, uncleaned workspace writer may be marked reverted after controller-owned exact full restoration; it does not create observation, actual identity, ordinary cleanedAt, adoption or review credit. All requested IDs validate before atomic save; failures roll back. Existing interruption counts and unhandled recovery decisions remain; matching stale markers do not recount. Reserve rejects owned restoration fields including undefined; conflicting proof, later observe/clean/adopt and malformed chronology are rejected. This helper is not yet called at runtime.030227red5fail13controls;030307tests70pass/type1Vitestarraytable issue corrected; frozen030338-journal-restoration-review-input:type0/70pass3files/22new stable. Separate source review accepted invocations SHA88af9539200ef4cdfd630997c181fb6af202c93198514ed79c8d5ca91da2b67a and new testf8e78331c770f8681418c470d9d19a3d42c95fac3f24fc6594b49168bae490c4. Combined retained-restore/journal/pending/adoption cases remain required after workerC1 integration.

Last verified complete backup before these new files is024859-review-runtime-prepared,543members, sourceSHAd4da349b3d330097b1efccfc5d0026e05c0f419b0397cdfea78738d28a7b3aa5, matching Windows copy. Next checkpoint adds application ledger pair and restoration test for546members. Latest complete passing suite remains0220016233pass15skip/build0; all newer evidence is scoped and local. P1 retained runtime and truthful surface integration remain unfinished.


### Exact Git merge proof accepted; retained-work C1 ready to integrate

Controller Git commands now disable replacement objects so ancestry, merge/restore operations and committed source proof address the same objects. confirmMergeReceipt accepts only exact equal-width SHA identities, brackets observed HEAD, checks exact ordered before/source parents for a new --no-ff merge, and permits source ancestry only when the returned integration HEAD is unchanged (explicit no-op). It rejects intervening descendants, replacement-parent illusions and an unexpected raw fast-forward. Failed observations give no credit. Root must still combine an immediate successful operation, saved pending attempt, exact committed tree capture and atomic adoption; no saved-gap recovery is inferred.

Evidence030736red4fail7controls (99otherGit cases name-filtered); source-replacement fixture reproduced success without expected feature bytes.030809type0/187pass1obsoleteGitargs assertion; both strict argument-prefix assertions now expressly require --no-replace-objects. Frozen030825type0/188pass3files accepted Git moduleSHA37a17a22fc7a9a6e6e98fb69f8e6a2676faffe642fd3bcc1a784bf0d69dea55a. Added nativeSHA256 merge positive in031018:type0/189pass3files/111Git stable; production source unchanged.

Retained-work C1 received separate source acceptance after all five findings: exact scope binding, active-unobserved full restore, preserved basis-member linkage, non-healing incomplete tombstones, and semantic snapshot replay. Partial restores union known author linkage and remain incomplete; no whole-job narrowing there. Worker evidence022737-retained-work/handoff-c1.json records red38:9fail65controls; final43:249pass3files76new,44type0; full source/test/docs manifests stable, only its2ownedfiles changed. Accepted module99842f98b4177f0a8559e723275e01b00b66084c0bf6c608f37418b7963dfac0, test015aea5bbf4ab932fe959c6edb916c94818fb7d0b55f13f6572ae68ab039e3bb. Root will hash-transfer those exact files only after the next paired checkpoint, then verify against the newer journal restoration reader and add combined restoration/pending/adoption cases. No complete P1 claim or actual provider run follows from this pure acceptance.


### Retained C1 integrated; actual review runtime applied

After verified paired checkpoint031407-before-retained-integration (546members, sourceSHA87276e4c8191eca700252c57de4750b9eaa3682f13a29772011174c31fcafc3c), root transferred the exact accepted retained-work pair. Receipt022737-retained-work/primary-integration-c1.json. New combined retained-recovery.test.ts proves observed/unobserved full-reset settlement, partial-save uncertainty, failed-save persistence and exclusion of restored candidate identities with the current journal reader.031436-retained-primary-combined:type0/276pass5files stable; independent reviewer accepted this pure combination. Controller transaction remains subsequent work.

Root applied actual review runtime in dispatcher/types. Per actual review invocation exact committed before/after captures bind to its job ID; observation+cleanup+valid answer and unchanged bytes are required for completed evidence. Plan uses exact serialized spec hash; GateC separately binds verification and final review. Damaged audit remains raw plus sticky uncertainty. Persistence failures roll back and stop. No requested route identity creates credit.031502type0/124pass11fail: nine historical exact-key assertions now explicitly allow additive provenance (all old events/models/keys remain pinned), two new rubric fixtures corrected to use a supplied modes plan.032016type0/135pass3files stable.

Independent review found age crossing during awaited capture and proof-only rubric retry.032201red2 reproduced both. Root rechecks captured strict allowance policy/current observation age after capture before reservation, without another metadata query/restamp; missing proof breaks rubric retries and records unfinished.032214type0/225pass1newfixture failure: actual owner gate uses stopped/checkpointfeature, not nonexistent needs_human. That fixture was corrected;032335-review-runtime-accepted-input is running. No current full-suite pass claimed yet. Latest complete passing suite remains0220016233pass15skip/build0; historical cloud tests never validate reconstruction.

Next bounded runtime slice: writer reservation/capture/tracking and atomic adoption/reset,1–2hours mediumconfidence. Root owns all shared/runtime files. Worker Solhighforknone owns only isolated new mission-evidence.ts/test.ts for canonical report/CLI/dashboard wording; dependency refresh receipt032052-view-dependencies. Reviewer read-only. Exact models/pins and all owner restrictions retained.


Review runtime accepted after boundary corrections:032335type0/226pass4files; warn transition032539red1 then032548type0/110pass2files, all source manifests stable. Independent reviewer accepted production dispatcherSHA b9ff72b7fdeb07cde65a3625468ece4e293cbde609cd1e4d3f8f338e375a04cb and types140632d147032068b0e9d3dd71341d77be2a8501beb58adbdcd333d0cecb1f13. Warn logs only fresh-to-unknown transition after capture. Additive exact-key assertions preserve historical fixtures unchanged. P1 writer/merge/surfaces unfinished.


### Writer controller accepted; bounded runtime integration in progress

Verified paired032809-review-runtime-checked contains549members, sourceSHA849cbacd13f2b760fdb71b0f8514be694d242837f1a3d0e92cdef27f79dbcc30. It precedes controller and writer runtime additions. All prior checkpoints retained.

New root retained-controller.ts/test.ts wraps detached journal/tracking transitions in one authoritative save. It rolls back all Mission own fields and original Feature references, preserves unknown raw state, independently screens fresh scope initialization, and persists bounded reset intent before Git. Pure controller itself performs no Git/process/filesystem work. Source review found malformed replay/partial-head gaps (033516red5fail20controls;033535escaping/typefailure preserved;033555type0/128pass4files) and stale same-SHA terminal selection after fullrestore (033723testordering mistake,033729explicit oldselector notallowed,033736 reproduced1fail26controls). Corrected fullrestore republishes the narrowed write/frozen snapshot and journal dispositions in the SAME transaction before clearingintent; failedsave restorespendingintent/currenthistory.033757type0/130pass4files27controllerstable. Independent source acceptance module4eb4eb828ef43320d1bd265c8e113c0e7f37bee1cf28a1919dc720d6fe7cb203/test6395eebef28a478c1c96020072f11b2a1eb49902dd13ac82eef69a709b3b71c2. initialize true means scope exists, never independent no-AI baseline proof.

New retained-dispatcher tests033210type0/6fail3controls beforewiring. Root now wires six explicit workspace-writing contexts, captures before actual reservation and after physical cleanup, saves reservation+intent and cleanup+tracking jointly, records initial scope checkpoint, freezes tests and accepts passing state atomically, retains failed content checkpoints, and reconciles existing full/partial restoration paths. Application baseline ledger initialized independently before ANY workspace writer; scaffold source checkpoint recorded at init. Whole-app feature merge aggregation still unwired. Ordinary failover/crossfamily failedwrites, no-delta exclusions, diagnosis fullreset and key save failures pass initial0341398pass1expectation/typefailure. Type was callback narrowing only. Adoption test now separately covers contentcheckpoint vs acceptedpassing state: on failedpassing-save prior contentadoption remains valid but passingCommit/status do not advance; all prior journal/tracking/provenance must matchdisk. Extra test for initialcontentcheckpoint-save failure keepswriterpending. New review-capture.ts delegatesexactcommittedscanner atactualreviewboundary so those tests do not intercept new baseline/adoption captures.034234-retained-runtime-core-checked type0; combinedtests running.

This is not finished P1. Durable pending reset replay across restart, all restoration/restack corner cases, effective current checkpoint selectors, application merge pending+exactreceipt+atomicdeliveredstate, and shared surfaces remain under construction. Nextremainingstage2–3hoursmediumconfidence; no full-suite pass since022001, newruntime currentlyscopedtests only. No real AI/provider/product calls or protection activation.

Isolated mission-evidence adapter C1 is NOT integrated. First review requested authoritative unpruned journal binding, currentcheckpoint binding, separation of historical coverage vs pending mutation, planbeforefirstwriter support, and historical roots after normal worktree cleanup. WorkerC1 evidence032232-mission-evidence/handoff-c1.json:323pass4files74adapter/type0stable, module26c3ed6f3400141580444299d2151ffb30893cc747ef19067d8606438cb3d977. Rereview found directterminal-vs-checkpoint selection and valid incomplete review audit poisoning contributor completeness; correction pending. Only two isolated worker files owned; root retains all shared file ownership.


### Writer runtime corrections checked; mission evidence C2 accepted

034654-retained-runtime-expanded: typecheck0,254passed7files, stable source. Read-only review found two current-loop edges: reset completion returned false without stopping, and accepted tests/passing SHA came from an earlier HEAD observation. New035250-writer-review-red reproduced3fail13controls. Root now stops on false restoration proof while keeping the durable intent, and rejects a moved HEAD before accepted-state adoption; freeze and all passing paths pass expectedHead.035317-writer-review-corrected:typecheck0,154passed4files, stable source; second source review pending. The reset test also proves fresh replay before any further model job. This remains local stand-in evidence.

Mission-evidence C2 is separately source accepted in isolated worktree: module43f0d306399f7ba039ba9b4e1549531003a3b0785fa52416685408e03d165a8f,test297ae792f5fc0db0c360de99008f9882cf9810fe96d0145b2c4cc99aece2e222.032232Z-mission-evidence/handoff-c2.json:330passed4files81adapter,typecheck0, stable input. It binds actual journal observations/cleanup to unpruned evidence, direct terminal checkpoint selectors, distinct historical uncertainty versus current pending writes, and recorded roots after cleanup. No primary integration yet. Next verified paired checkpoint553members adds retained-controller pair, retained-dispatcher test, review-capture wrapper; then exact two-file adapter transfer.

Remaining P1 work: interrupted retained author continuation with explicit unresolved checkpoint membership, amendment/restack, application pending merge plus fresh exact receipt and atomic delivered state, all owner surfaces, final complete check/build/review/backups. Latest complete passing check remains022001:6233passed15skipped/build0; subsequent runs are bounded. No provider/real AI/protection/OS work.


### Merge aggregation source accepted; recovery and surfaces continue

Writer corrected core accepted at dispatcheraf584ffd and retained-dispatcher9f6e5030;035317type0/154pass4stable. Paired035601-writer-runtime-checked verified553members, sourceSHA5f821269310b2ad11eddf4fc94b7d29bc144096fa92673107b6c55ec777637f2. Accepted mission-evidence C2 exact pair transferred with032232Z-mission-evidence/primary-integration-c2.json.

Application merge now persists exact source selector and pending attempt before Git, requires fresh confirmMergeReceipt and complete live/committed capture proof, records originalscaffold plus exact feature revisions, and jointly saves ledger/provenance/done-state and reopened findings before worktree removal. Existing saved-gap pending is never closed by ancestry or later no-op; malformed raw state preserved with stickyunknown. Review corrections cover missingselector versus validatedlegacy-null, allfeaturecoverage, failedsave reopenedconcern barrier and independentlyobservedHEAD.035639red6;035737type0/113pass3canonicalwordfixture failures;035826type0/145pass4;040105146pass/type1testthisannotation corrected;040250type0/147pass4;040433type0/149pass4stable. Separate source acceptance dispatcher8fa2bc7a570d43118dcfad3f0d76a441e80b78abbd6dae820bf680177395ce1e. Adjacent scaffoldcallback guard now authored with2new damagedinitcases, notyetchecked.

Isolated retained RC02 C2 independently accepted:347pass4/type0, knownlaterauthors retainedpartially, interruptedunobserved/uncleaned remainunknown with strictdigestedunresolvedmembership and nonrehydration. Nonblocking replaytime correction C3 adds1redcase then348pass4/type0; frozen de428749f15ed898b73da33b0c66dbbb8c486c8cadda10c642acdb4b0d0dae8e/test33ff55b77b01e466889127c893b84459b5ac249ce3cc6129e21be23d663351b8. Primarytransfer/runtime notyetdone. Worker now owns onlynew retained-restack.ts/test.ts, conservative intermediate and exactcontent final bridge, durable runtimeintent remainsrootowned.

Owner surfaces now share missionEvidenceView across report/CLIplan details/dashboardfeature/debrief; dashboardcomputes beforelossy cleaning inprivateWeakMap, ignoresforgedfilecachedview.040558testfixturemissingscreenshots repaired;0406195meaningfulred;040649shebangplacement mistake corrected;040658type0/105pass3stable. Broader040716808fail/1324pass due additive dashboardshape fields, then040815type0/2066pass20fail: oldreportgolden extra section, newlineformat, reading-only testswording and demopage refresh. Corrective model-mode filtering/authored2cases+newlinefix and explicit shape additions are current, compatibility unfinished. Historical49snapshot hashes/10demoJSONgoldens remain unchanged; newtest-only evidenceprojection assertscanonicalunknown thenremovesonlyadditive fields for oldwholeoutput comparisons. No full-suite pass since0220016233pass15skip/build0. Next backup558members before RC02C3 transfer. FullP1 notcomplete; protection/realprovider/OS experiments remainprohibited.


### RC02 recovery and consistent owner surfaces accepted; restack remains open

Verified paired040927-merge-and-surfaces-prepared:558members, sourceSHA2d8fe4669898c91e8c17c72c7a2fce7b7a57d83c99497057836414026ea170e9. Retained C3 exact transferred after this backup, receipt040815-retained-replay-c3/primary-integration-c3.json. C2 was source accepted; C3 adds only incoming replaytime validation, checked red1 then348pass4/type0. Root recover wrapper now preserves unobserved/uncleaned unknown without fakeidentity, reaps/captures before laterwriters, validatesroot/recovery, and atomically savestracking.041014red2;041038241pass6/type2annotation errors corrected. Review found finished-but-uncleaned persisted intents also needed recovery:041330red1 then041339type0/273pass8stable. Runtime20cases include actualother-familylaterauthor and failedrecovery-save withnoadditionaljob/charge. Separate source acceptance controllera5a9522b,dispatcher88ad99b2,C3de428749. Scaffoldmalformedrawguard and2initcases passed in14app tests.

Shared surfaces independently accepted. Report/CLIplan details/dashboardfeature/debrief use same canonicalrawreader, dashboardstoresderivedview inprivateWeakMap beforecleaning, nevertrusts filecachedview.5standincases ordinary/fallback/repair/legacy/damaged agree. Reading-only mode returns nofictionaltestauthorlines. Additive dashboardfield namedreviewRecord to retain the existing no-raw-evidence assertion. Reportlegacy tests explicitly assertcanonicalnewsection thenprojectoutonlythatsection; historicgoldens retained.041136type0/506pass7compatfail (sectionregex andoldforbiddenkey), corrected041249-evidence-compatibility-final:type0/2066passed25files stable.041320demo generation26pass intentionallyupdatedonlydemoHTML; original10JSONgoldensunchanged.041339includes25demo checks withstablesource. Furtherwhole-suite verificationstillrequired.

Newrestackruntime6redcases041729 expectedbeforeimplementation. Pureisolatedretained-restack26cases374pass5/type0 frozen, source reviewinprogress. Rootdesign16 recordsdurableintent/exactselectors/changedpathpartitions, freshreplayedGitcomposition, tests-only conservativecheckpoint, finalfulltreeidentity/completenessceiling, and atomicfrozenfields+evidence+intentclear. Latestpairedcheckpoint041929-before-restack-integration verified559members SHA950b90006437a5582409af1fa998e450e0af1c44511b9ffbe2e896b78f34cbc4 withmatchingWindowscopy. Rootruntimeproposal remainsinactiveuntilpureacceptance.041954-pre-restack-full-audit started to expose anyothercompatibilityfailures; deliberatelyredrestackcases mean no successclaimed. Latestcompletepassstill022001. No realAI/provider/OS/protection/Docker/publication/model changes.


### Final core integration audit and durable test rewrite

Full source-frozen041954-pre-restack-full-audit completed: npmcheck1 (6624passed,15failed,15skipped across115files), build0, unchangedsource. Six failures were expected authored restack regressions before wiring; eight were additive review-record output expectations; one was a scratch-only legacy fixture retaining modern tracking after deleting its journal, under review. This is not a passing complete suite.

Accepted isolated retained-restack pair transferred exactly, receipt040704-retained-restack/primary-integration.json, modulec67131864344ae85ba5a5f139ec3da85bb84dc3b0eb3ebf2ba4e0ca79f58097a/test2896ff1cb98f0304821805257f75cf7eff3331693c1f7c86b3927577e3ee363a. Root connected durable workRestack intent before physical rearrangement, no model jobs during pending restore/restack, exact live/committed captures for tests-only and full restored tree, pure retained author composition, and atomic testsCommit/frozenMembers/evidence/dispositions/intent completion. Legacy uncertainty remains unknown. Invalid intent stops before Git. A saved gap replays from explicit source commits with fresh proof.

042559initial:type1 (missing import/type narrowing) and5failed157passed; corrected042654:type0, all6restack cases passed plus other scoped controls,161passed5legacy CLI newline fixture failures. Sources stable; fixes to exact additive section boundary/newline expectations now authored. R6 old broad 'no record' assertion matched the new truthful 'no recorded identity'; it now still rejects that prose within narrative and capability sections, retaining all prior exact sentence checks. E2E heading list explicitly includes Recorded AI reviews. No historical golden changed.

Read-only reviewer inspects actual runtime plus interrupted-run failure; second Solhigh agent audits requirement completeness only. No concurrent source writer. Next full check/build remains required, current complete-suite status not passing. Latest verified paired complete checkpoint remains041929559members; next adds accepted pure restack pair for561members. OS/protection/provider/realproduct/publication/master/model restrictions unchanged.


### Complete core check passed before four final combined cases

043725-core-integrated-full: npm run check0 (typecheck0;6672passed15skipped,116passingfiles), npm run build0, complete input hashes unchanged. This supersedes041954's failedwholeaudit for the current core source. The15skips remain13render,1drawn-page,1optionalPandoc; no browser or OS result is inferred. Allproduction retained/restack/ledger/adapter bytes match source-accepted review identities.043131additional9restack/modern-journal-loss/legacy/view cases passed116/type0. Separate final testcompatibility/cross-cut source review accepted with no material blocker, receipt043442-preservation-audit/review-disposition.json.

043345-restack-core-reviewed verified562source/documentmembers, sourceSHA bf6d9241bdfe93b70a110fb55432189ee206d4b9c41aa42f0ffb07fdd073b5a5 with matchingWindowscopy.043442preservationaudit confirms514startingmembers retained,287historicfixture/pinfiles byteunchanged,alloriginalrefsunchanged,model/Haiku/profile/ladder/CLI/defaultpermission settingsunchanged. No commit/push. Currentguides describe Recorded AI reviews and revisedlaunchinventory explicitlydeniesOSprotectionclaim.

Fouradditional cross-package cases SC03/04/06/07 are being authored outsideprimary by oneSolhighwriter; no primarysourcechangesduringfullcheck. They stillneed exacttransfer/localexecution/review and a finalcompletecheck afteraddition. No current-sourceblocker remains, but finalscenario reconciliation andfinalbackups remainopen.


### Final permitted-core handoff

Final044153 check/build passed:6676passed15skipped117files; source stable and independently source-reviewed. Four combined scenarios passed after one fixture-only numeric reset correction. SC01–SC10 mapped, with the OS-boundary half ofSC05 explicitly held. Current summary and release-evidence carry exact scope, results, limits and archive destinations. Permitted core reconstruction is complete; prerequisite/advisory and P3/protection/real-provider release work are not claimed complete.
