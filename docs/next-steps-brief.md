# Next steps brief: finish Mission Control (read this first)

Written 2026-10-15 for a fresh Claude Code chat in ultracode. You are the orchestrator. Read this whole file, then `docs/checkpoints-spec.md`, `docs/plans-spec.md` (especially section 17), `docs/dashboard-spec.md`, `docs/leader.md`, `docs/setup-windows.md`, `docs/dev-real-run.md`, `leader/CLAUDE.md`, `leader/.claude/settings.json`, `scripts/mc-docker.sh`, and skim `docs/design-v1.md` and `docs/mvp-spec.md`.

## 0. Start here

```
git fetch origin feat/checkpoints
git checkout feat/checkpoints
git checkout -b feat/any-task          # work on this branch; commit and push it after each wave
npm ci && npm run check                # expect typecheck clean, 64 test files, about 3,910 tests passed, 1 skipped
```

Never touch `master`/`main`. Push only `feat/any-task`. Do not open a pull request unless the owner asks. Every commit ends with the attribution lines your session's system reminder gives.

## 1. Who you work for

The owner is a non-technical CEO who is not at the keyboard while you work. They will read your final report, then test everything on their own Windows PC (WSL2 + Docker) **after** you finish. So:

* Do not stop to ask unless a decision is truly theirs (money outside the plan, deleting data, merging to master, anything outward-facing). For every other open question, take the default given here, record it, and list it in the final report. If a question really blocks you, ask once with `AskUserQuestion`, then continue with what does not depend on it.
* Everything the owner or the CEO can read (output of commands, docs, the leader's instructions, the dashboard) is in plain words: short sentences, no jargon, no em-dash asides, no "night/tonight/overnight" framing (the owner said they are not testing anything with nights), never the word "objective" (say "feature"), curly quotes around titles.
* Report honestly. "Tried for real", "tested here only", and "not tried" are different things; say which. Do not claim a thing works unless you ran it. When the owner asks "why", answer straight.

## 2. What exists (branch `feat/checkpoints`, 3,910 tests)

* The engine (`src/dispatcher.ts` etc.): deterministic stages onboard, spec, gate A, init, features, gate C, finalize; roles architect, engineer, test author, reviewer, scout; tests first with frozen tests; one feature at a time; single writer under a run lock; state in `mission.json`, `events.jsonl`, `usage.jsonl`, `quota.json`, `dispatch.json`; work lands on a branch `mc/<id>`; pacing pauses new work at 85% of the weekly Claude allowance.
* The dashboard (`mc dashboard`, `src/dashboard/`, `dashboard/index.html`): read-only, a lamp, a Needs-you list, a timeline, results, "Tell the leader" copy sentences.
* The leader (`leader/CLAUDE.md`, `leader/.claude/settings.json`): a Claude Code session the CEO talks to; it acts only through `scripts/mc-docker.sh` commands (status, logs, report, plan preview/show allowed; new, feature, plan queue, run, stop, approve, send-back ask first); Edit/Write/git denied.
* Human checkpoints (`src/checkpoint.ts`, docs/checkpoints-spec.md): `--checkpoint plan|feature|final`, `mc approve`, `mc send-back --note`. Proven in a real run.
* Leader-written plans (`src/plan.ts`, docs/plans-spec.md): `mc-plan 1` plain-text format, `mc plan preview|queue|show`, intake without a planner call, plan stop by default. Proven in a real run (8 AI calls, about a minute).
* A roadmap picture for the owner: https://claude.ai/artifact/A2Siyxoa7C6JFu6548bMjA (update it at the end, section 7).

## 3. The owner's goal and decisions (binding)

* "A team that, when I ask it to get something done, does it efficiently and with quality, even if the task is a 2-hour task." "ANY task, as if it is Claude Code, and working entirely on GitHub." The leader decides the pipeline per task; the engine executes it with guardrails. "It is okay if the graph stops and prompts me to check something myself, then continues after I check."
* **Step 3 scope (chosen):** work that is not code: **writing and documents**, **web pages and visual work**, and **data and spreadsheets**. Not research with sources (not chosen; say so in the docs).
* **GitHub in and out (chosen):** done on the owner's PC with their own login (host side), so no password is ever inside the container. See P2.
* **Parallel features: deferred.** Do not build them. Say in the docs that it is deferred and why (section 4, last paragraph).
* **Tidy-ups and the same-plan guard (chosen):** P1.
* **One-click launcher and the leader finding its own folder (chosen):** P2.
* **Release:** nothing is merged to master by you. At the end, offer the owner a pull request.

## 4. Work packages and waves

Disjoint file ownership inside a wave. Agents never commit; you commit after the integrator and verifier pass.

### Wave 1 (parallel): P1, P2, P3

**P1. Tidy-ups and the same-plan guard** (owns `src/plan.ts`, `src/checkpoint.ts`, `src/report.ts`, `src/run.ts`, `src/cli.ts` for these items only, `src/dashboard/vocabulary*.ts`, and their tests):
1. "All 1 feature is built" grammar in the final-check look (`src/dispatcher.ts` look builder; P1 may edit that one function).
2. Doubled quote marks on dashboard card lines when an AI-written line starts with “…” (seen on a plan card: `““Add whisper…”: …”`).
3. The run summary says "Night finished" (`src/run.ts` and `src/cli.ts`); change every owner-visible "Night finished/summary" wording to plain run wording (for example "Run finished"). Grep all owner-visible engine strings for night/tonight/overnight/morning; keep file names that tests pin only if renaming is risky, and say what you kept.
4. Show each feature's id in `plan preview`, `plan queue`, `plan show` and the plan look (it reaches AI prompts and branch names, and the owner should see it).
5. The report's "Plan: written by the leader (plan code …)" line must be inside the first 40 lines for plans of any size (move it above the look).
6. `describePlan` wraps a fact longer than 280 characters; the continuation line must carry its "Check for “title”:" prefix.
7. **Same-plan guard** (restore what plans-spec P13 cut): `mc plan queue` refuses a plan whose plan code equals that of a mission that is not complete or failed: `This plan is already queued as “<name>” (<id>). See it with: mc status`. Update plans-spec P13/section 12 and the leader text (queue once; check `status` before retrying).
8. Update plans-spec/docs where behaviour changes; tests for each item.

**P2. Host side: GitHub in and out, and the launcher** (owns `scripts/mc-docker.sh`, `test/mc-docker.test.ts`, `leader/**`, `test/leader.test.ts`, `docs/setup-windows.md`, `docs/leader.md`, new `scripts/windows/**`, new docs, `README.md` command table):
* New wrapper commands that run **on the host, outside the container**, with the owner's own git/GitHub login (the container never holds credentials; the engine stays credential-free):
  * `mc-docker.sh get <github-url | owner/repo> [folder-name]`: `git clone` into `~/mc-apps/<name>`; refuses if the folder exists; prints the next step (`mc plan preview ...` / `mc feature <name> ...`). Accept only github.com URLs and `owner/repo`; refuse other hosts (say so).
  * `mc-docker.sh publish <mission>`: in `~/mc-apps/<app>` push the branch `mc/<id>` (never main/master, never force) and open a **draft** pull request with `gh pr create --draft` when `gh` exists on the host; otherwise push and print the compare URL. PR title = the mission title; body = the first lines of the report plus the plan code and a plain "what was checked and what you looked at" line (honest wording from the checkpoint log and check modes). Refuses when the mission is not done, has no commits, or the app folder has no `origin` that is github.com. Prints the pull request address.
* Leader permissions: `get` and `publish` are in `ask`, never `allow`; the leader asks the CEO a plain yes/no first (same pattern as `approve`); update `leader/CLAUDE.md` (a flow for "work on my repo X and send it to GitHub"), `settings.json`, `leader/README.md`, `docs/leader.md`, and the pinned lists in `test/leader.test.ts`.
* The launcher: a Windows shortcut or small `.bat`/`.cmd` set under `scripts/windows/` that opens Ubuntu and starts the leader (`claude --remote-control "Leader"` in the leader folder), and one for the dashboard; plus the **leader finding its own folder** (today `../scripts/mc-docker.sh` assumes the leader runs in `leader/` of a checkout; make the setup robust, for example a small setup step that records the checkout path, and keep every leader command prefix working with the permission rules). Document it plainly in `docs/setup-windows.md`.
* Tests use the existing fake docker pattern in `test/mc-docker.test.ts`, plus a local bare git repository as "origin" and a fake `gh` script. Real GitHub is **not** testable here; say so.

**P3. Step 3 design** (docs only: owns `docs/modes-spec.md`; same shape as docs/plans-spec.md: decisions table, format with examples and every validation message, stage table, prompts, CLI texts, leader text, files with line references, tests, work packages, risks, open questions with defaults, what could not be verified). Then **two adversarial reviewers** (engine feasibility and backward compatibility; leader/CEO safety, hostile input and honesty of the claims), then a reviser. Answer these questions in the spec, with evidence from the code:
* **How each feature is checked.** A per-feature check mode in the plan: `tests` (today: tests first), `review` (no frozen tests; a builder makes the deliverable, an independent reviewer judges every written check as pass or fail with evidence, with fix rounds; plus scripted checks where they exist, see below), `owner` (review, plus a stop for the owner's look that the plan file can never turn off; only a command-line flag can). Default `tests`. A non-test mode must never be reported as "tests passed"; the report, the dashboard and the PR body say honestly "checked by a second AI against your list" and "you looked at it". Keep `mc-plan 1` valid and decide whether new keys are optional extensions of version 1 (lean: yes) or version 2.
* **How hard to think.** A per-feature `effort` (light, standard, deep) the leader chooses, mapped onto the engine's existing tiers and effort levels for the builder and the reviewer; default standard. This is the "leader decides the pipeline" part.
* **Writing and documents.** Files in the repo (markdown and similar). Scripted checks that cost nothing and catch real defects (the files exist, links resolve, headings present, length bounds, spelling of identifiers named in the plan). Rubric review by an independent reviewer (different model tier or family per the engine's existing reviewer-independence rule; read how it is chosen for code).
* **Web pages and visual work.** The Docker image already ships Playwright and browsers (`docker/Dockerfile`, base `mcr.microsoft.com/playwright:v1.64.0-noble`). Render the page, take screenshots at phone and desktop width, give them to the reviewer (check how an agent can look at an image through the Claude and Codex CLIs the engine drives; do not assume), and show them to the owner in the stop (the report already collects screenshots: `collectScreenshots` in `src/report.ts`). Decide what happens when a runner cannot look at images.
* **Data and spreadsheets.** This is the most checkable non-code kind: a script that produces the numbers can have real tests (tests-first), totals can be recomputed independently, a CSV or workbook can be validated by a script (columns, types, row counts, formulas). Decide the output formats (CSV first; `.xlsx` needs a library, so check what the container can install: it has network access and Node, check whether Python exists in the image; do not assume), how a binary workbook is committed and reviewed on GitHub (prefer a CSV or a script plus the workbook), where input data comes from (files already in the repo; no uploads anywhere), and the privacy note (files in the repo are read by the AI providers).
* **What a plan may name.** The earlier rule stands: no shell commands, no verify fields, no paths that escape the repo, no web addresses. Decide how a plan names where deliverables go without adding an attack surface (lean: checks name the file in plain words; the engine validates names against a strict pattern if it needs them at all). Hostile-input fuzz is part of verification.
* **Pipeline per mode.** A stage table: which AI calls run for `tests`, `review`, `owner`, with the new prompts under `prompts/` (this step may add prompts and an output schema for the rubric verdict; keep the existing ones unchanged) and what happens on a failed round, a rounds cap, the honest end states (reuse the checkpoint design's end-state pattern).
* **Leader rubric.** How the leader picks mode and effort for a job (a table it can follow), what it tells the CEO, and the one question it asks before queuing.
* **Dashboard and report wording** for non-test modes; the Results page ticks must not claim tests.
* Cost model: AI calls per mode compared with `tests`, using the real numbers in `docs/plans-spec.md` section 2.

### Wave 2 (after Wave 1 is merged): P4 Step 3 build

Review the P3 spec yourself before building (read it; check it against the code; take the defaults). Then, in parallel with disjoint ownership: **WP-A** engine and CLI (plan keys, dispatcher modes, prompts, schema, report, run, cli, harness, tests) and **WP-B** surfaces (dashboard, leader text, docs, fixtures, tests). Then the integrator (`npm run check`, `npm run build`, an integration test) and an independent verifier (backward compatibility against base commit `8aae86f`: old-way and plan missions behave and log exactly as before; hostile plan fuzz; resume paths; honesty of every owner-visible claim; wording rules).

### Wave 3: prove it, document it, hand over

1. **Real runs** with `docs/dev-real-run.md` (nested real Claude; a few percent of the week in all; read `quota.json` after each; stop spending at 80% weekly and say so):
   * R1 a code job through a leader-style plan (regression).
   * R2 a writing job in mode `owner`: a stop shows the deliverable and the checks; approve; the report says what was checked and by whom.
   * R3 a web-page job: screenshots in the look.
   * R4 a data job: tests-first script plus its output; one send-back at the stop.
   * R5 the GitHub round trip against a **local** bare repository and a fake `gh` (real GitHub cannot be reached from here).
2. A full `npm run check`, `npm run build`, and the time-zone check (`TZ=Pacific/Auckland npx vitest run` on the date-sensitive files, as past verifiers did).
3. `docs/setup-windows.md` read end to end as the owner would read it, corrected where the new steps change it.
4. **`docs/owner-trial-checklist.md`**: a numbered, plain-words checklist for the owner's own try-out on their PC: install, open the leader, a small code job through a plan, a writing job with a look, a web job, publish to a GitHub repo of theirs, the dashboard on the iPad, and what to send back if something fails. Include what each step proves and what was never tried here.
5. A final independent read of everything the owner can read (wording rules, honesty, dead links).

## 5. Why parallel features are deferred (say this in the docs, in plain words)

The engine is built around one feature at a time: one loop (`for (let f = this.nextFeature(); f; ...) await this.runFeature(f)` in `src/dispatcher.ts`), one in-memory copy of the mission that is written whole on every save, one run lock, one merge queue into a single integration branch, pacing that assumes one AI call at a time, and a timeline and checkpoint design that assume one feature is in flight. Running features side by side would need separate working copies, a rule for merge conflicts (who resolves them?), saves that cannot overwrite each other, crash-resume with several half-finished features, and pacing across concurrent calls, and thousands of tests assume a fixed order, so concurrency would also make them flaky. The payoff is only clock time on big multi-feature jobs (the cost in allowance is the same), and most small jobs are one to three features. Do it later, after real use shows it is needed.

## 6. How to orchestrate (what worked in the last two steps)

* Use `Workflow` scripts: parallel agents with disjoint file ownership, then an integrator, then an independent read-only verifier. Brief files under the scratchpad directory (`step*-brief.md`) with hard rules and overrides; agents read them. Keep about 4 to 6 agents per workflow. Save big outputs to files and keep chat summaries short; your context will be compacted more than once.
* Design before build for anything new (spec in `docs/`, two adversarial reviewers, a reviser), then build from the spec. Prove risky assumptions with a cheap spike before building on them (the plans step found that Claude Code blocks any command containing a curly bracket followed by a quote, so a JSON plan could never have been sent; that changed the design).
* Backward compatibility is the top rule: a mission queued the old way must behave and log exactly as today (compare event-type sequences and `mission.json` keys against base commit `8aae86f` on the mock harness). Never weaken an existing test; list every changed existing test and the reason.
* Tests that pin things on purpose: `test/leader.test.ts` (command lists, flags checked against `--help`, pinned sentences, the `ask` and `allow` lists), `test/mc-docker.test.ts`, the dashboard tests and fixtures (dated fixtures need `copyFreshHome`).
* Allowance: the weekly Claude allowance reset on Wednesday 14 Oct 19:00 UTC. Everything that uses an AI draws on it (your builds and the real runs). My estimate for all of the work above is about 17 to 21 points of the week; Step 2 alone used about 5. The 5-hour window also limits bursts, so do not run more than one big workflow at a time. The engine itself refuses new work at 85% weekly. If the reading passes 80%, stop and report.

## 7. Facts and quirks learned the hard way

* Cloud container: root, no Docker daemon, no Codex. Real engine runs: `docs/dev-real-run.md` and `scripts/dev/*`.
* Claude Code's Bash tool refuses: any command containing a curly bracket followed by a quote; a here-document with an unquoted delimiter; a command after a here-document; `$()` in a quoted argument; `bash -c '…|…'` containing a removal. Write a script file and run it. `pkill -f <text>` can kill your own shell; use a pid.
* A nested `claude -p` does not apply a project `.claude/settings.json`; use `--allowedTools`.
* The file-writing tool once turned `\uXXXX` escapes typed in source into raw invisible characters. After writing code with escapes, scan: `grep -nP '[\x{200B}-\x{200F}\x{202A}-\x{202E}\x{2060}\x{FEFF}]' <files>`.
* Mission ids carry the local date; keep tests free of hard-coded dates or run them under another `TZ`.
* The owner's `~/.claude/stop-hook-git-check.sh` nags to commit and push. Commit only stable files you own, on `feat/any-task`; never `master`.
* The roadmap page (artifact URL above) is the owner's picture of progress. At the end update it: what is built, what the owner should try, the allowance reading from the last real run, and what is deferred. Read it first with `Artifact action: read`, then publish to the same URL.

## 8. Definition of done and what to hand back

* Waves 1 to 3 finished, committed and pushed on `feat/any-task`; `npm run check` and `npm run build` green; the verifier's findings fixed or listed.
* A final report in plain words, short: what the owner can now do; what was tried for real and what was not; the defaults you took (with the question each answered); what is deferred; the allowance used; and the first three things the owner should do in `docs/owner-trial-checklist.md`.
* Offer, do not open, a pull request from `feat/any-task` to master.
