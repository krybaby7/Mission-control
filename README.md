# Mission Control

Your software team. You describe an app or a change in plain words. Mission Control plans it, writes tests, builds it, reviews it, and leaves a plain-language report and screenshots when it finishes.

It uses the subscriptions you already pay for, and drives the official **Claude Code** and **Codex** programs. Models are assigned by role:

| Tier | Claude | ChatGPT |
|---|---|---|
| Frontier | Opus 5.5 | GPT-6 Astra |
| Standard | Sonnet 5.5 | GPT-6.1 Sol |
| Light (all cheap helper work) | Haiku 5.5 | not used |

> **Status:** the system is built and tested with stand-in AIs and thousands of automated tests. A few small real runs (a real Claude login, in a test container in the cloud) have been made, and the stops for your look and the plans the leader writes were tried that way. **Nothing has been tried on a Windows PC yet**, and nothing has been tried against a real GitHub. The first real run on your PC is the next step.

## Getting started

Follow **[docs/setup-windows.md](docs/setup-windows.md)**. It walks a non-programmer through Windows 11 step by step: WSL2, Docker Desktop, logging in to both AIs, iPad notifications via ntfy, keeping the PC awake, starting runs on a schedule, and the one-click shortcuts for the leader and the dashboard.

Daily use, from the Ubuntu window, once set up:

```bash
scripts/mc-docker.sh new "A habit tracker with a weekly streak chart"   # queue work
scripts/mc-docker.sh run --until 07:00                                   # start a run
scripts/mc-docker.sh report                                              # read the report when it finishes
scripts/mc-docker.sh copy-reports                                        # reports + screenshots → ~/mc-reports
```

To work on a project that lives on GitHub, and send the result back as a draft pull request, see **[docs/github-setup.md](docs/github-setup.md)**.

## How it works

```
your idea ─► Architect (frontier) writes a spec: small, testable features
          ─► Gate A: a reviewer from the other AI family checks the spec
          ─► Initializer scaffolds the app (Next.js + SQLite + Playwright) until its checks pass
          ─► for each feature:
               Test author (other family) writes acceptance tests → they must FAIL first → frozen
               Engineer builds until the frozen tests and the full checks pass
                 failing? → try harder → architect diagnoses → other family's frontier model → "blocked"
               Reviewer (other family, read-only) → fix rounds → merge
          ─► Gate C: full review + full checks ─► report + phone notification
```

**Code makes every mechanical decision**: what runs next, retries, escalation, budgets, and whether tests passed. The AIs only do the work that needs judgment.

**Quality guards:**
- Tests are written before the code, by a different model family.
- Engineers can't edit frozen tests or the files that define the checks.
- An anti-cheat scan catches skipped or weakened tests.
- "Done" means the checks actually pass.
- Work that has no tests (a guide, a web page, a table) is checked another way, and the report says which: Mission Control's own checks, then a second AI that judges each written check with a reason, and for some features a stop for your look. It is never called "tested" (see [docs/work-modes.md](docs/work-modes.md)).

**Guards while it works on its own:**
- **Usage limits:** when a subscription hits its limit, its work moves to the other AI, or the run waits for the reset. Usage is paced so you keep some for your own use.
- **Resume anywhere:** every step is saved, so a crash, a reboot or `mc stop` loses nothing, and the next `mc run` continues.
- **Isolation:** everything runs in a disposable container. By default it holds no GitHub password or token. Work reaches GitHub through `mc publish`, which runs on your PC with your own login, pushes only the `mc/*` branch of one mission, never with force, and only to a repository you named. (The older setting `git.push` would need a token saved in the app's folder. It is off, and you do not need it.)
- **Billing protection:** API-key settings are removed before each run, so your plans are used rather than paid API credit.

## Commands (`mc`)

| Command | What it does |
|---|---|
| `mc init` | Create your settings file (`~/.mission-control/config.yaml`) |
| `mc config get/set <key> [value]` | Read or change one setting, e.g. `mc config set notify.ntfyUrl https://ntfy.sh/your-topic` |
| `mc doctor [--live]` | Check the setup. `--live` makes one tiny real call per AI |
| `mc new "<idea>" [--name "<title>"] [--checkpoint plan\|feature\|final]` | Queue a new app. With `--checkpoint` it stops for your look at that point (see below) |
| `mc feature <app-folder> "<request>" [--checkpoint plan\|feature\|final]` | Queue a change to an existing app |
| `mc plan preview [file\|-]` / `mc plan queue [file\|-]` / `mc plan show <id>` | Plans written outside the team, usually by the leader, as plain lines of text. `preview` checks a plan and queues nothing; `queue` queues it, skips the team's planner, and by default stops for your look at the plan (`--no-plan-checkpoint` turns that off); a feature marked for your look stops too (`--no-owner-checkpoint` turns that off); `show` prints the whole plan of a mission and how each feature was checked. A plan that is already queued is not queued twice. Write `-` to send the plan in with the command, or give a file inside `~/mc-apps` |
| `mc run [--until HH:MM] [--profile mixed\|claude\|codex] [--role engineer=claude:frontier]` | Work through the queue |
| `mc status` / `mc report [id]` / `mc logs <id>` | Progress, the report, a step-by-step log |
| `mc approve <id> [--note "<text>"]` / `mc send-back <id> --note "<what to change>"` | Answer a mission that stopped for your check (see below) |
| `mc stop` | Stop after the current step; nothing is lost |
| `mc dashboard [--port N] [--until HH:MM]` | Show the current progress on a web page. It only reads. Through the Docker script it runs in a container of its own (see below) |
| `mc get <owner/repo \| github.com address> [folder-name]` | Download a GitHub repository into `~/mc-apps`. Runs on your PC with your own GitHub login, not in the container. Never overwrites a folder. Only github.com (see [docs/github-setup.md](docs/github-setup.md)) |
| `mc publish-preview <mission>` | Say which GitHub repository a finished (or partly finished) mission's work would go to. Uploads nothing (see [docs/github-setup.md](docs/github-setup.md)) |
| `mc publish <mission> --to <owner/repo>` | Upload a finished (or partly finished) mission's branch `mc/<mission>` to that repository and open a **draft** pull request, with the first lines of the report and a plain line about what was checked and who looked. Runs on your PC with your own login. Uploads only to the repository you name, which must be the one the app's folder was set up for. Never touches the main branch, never forces. A new app has no pull request on its first trip; the guide says what to do instead (see [docs/github-setup.md](docs/github-setup.md)) |
| `mc install-leader` / `mc leader [--no-remote]` | `install-leader` saves where Mission Control is, once, so the Windows shortcuts in `scripts/windows` can find it. `leader` starts Claude Code, the leader, in the `leader` folder of this copy, wherever you are (see below) |

**Checks you ask for.** Queue work with `--checkpoint plan` (before anything is built), `--checkpoint feature` (before each feature is added) or `--checkpoint final` (before the app is finished), and that one mission stops there on purpose, tells your phone, and shows at the top of its report what to look at. Other missions carry on. Read it with `mc report <id>`, then `mc approve <id>` or `mc send-back <id> --note "what to change"`. A send-back is reworked and shown to you again, up to two times; a third one ends the work there and says so. An answer can only be recorded while no run is going, and the mission continues on the next run (`mc run --mission <id>`). Without `--checkpoint` nothing changes: a mission runs straight through.

**Profiles:**

| Profile | Roles |
|---|---|
| `mixed` (default) | Claude plans and reviews, Codex builds, so both subscriptions share the load |
| `claude` | Claude only |
| `codex` | Codex for every role. Cheap helper tasks (planning context, failure summaries, report writing) still use Haiku 5.5 |

## Watching the work and talking to the leader

Two parts, for someone who is not technical (a CEO, say) and looks at an iPad or a phone for five seconds:

- **The dashboard is the eyes.** A web page that shows whether the team is working, how far along it is, whether anything needs a person, and what you got. It only reads the files Mission Control already writes, and it can change nothing. Start it in its own Ubuntu window and leave it running:

  ```bash
  scripts/mc-docker.sh dashboard              # then open http://localhost:8787 in the Windows browser
  scripts/mc-docker.sh dashboard --until 07:00   # shows a stop time and countdown; give the stop time you gave `run`, if any
  ```

  It runs in a container of its own that sees the Mission Control folder read-only. There is no password, by design: anyone who can open the page can see it. By default only the PC itself can; `--lan` publishes it on every network interface (see [docs/setup-windows.md](docs/setup-windows.md)). Press Ctrl+C to stop it.

- **The leader is the hands.** A Claude Code session started in the [`leader/`](leader/) folder. The CEO talks to it in plain words ("How is it going?", "Add a dark mode to the habit tracker", "Please stop the current run."). It acts only through `mc`: status, logs, report, stop, new, feature, plan, run, approve and send-back, plus `get`, `publish-preview` and `publish` for GitHub (on your PC, with your own login). For a small, clear job it can write the plan itself; you see every check before anything is built. On the dashboard, every card and feature has a **Tell the leader about this** button, and the bar has **Tell the leader anything**; each gives a ready sentence to paste into the chat. The page itself sends nothing.

  ```bash
  scripts/mc-docker.sh install-leader          # once: remembers where Mission Control is (needs no Docker)
  scripts/mc-docker.sh leader --no-remote      # starts Claude Code in the leader folder, wherever you are
  scripts/mc-docker.sh leader                  # the same with Remote Control: claude --remote-control "Leader" in the leader folder
  ```

  The Windows shortcuts `scripts/windows/start-leader.cmd` and `start-dashboard.cmd` start them with a double click (see [docs/setup-windows.md](docs/setup-windows.md)). The leader has to start in the `leader` folder, because its commands are written `../scripts/mc-docker.sh ...` and its permission rules match that text; `mc leader` always does that. By hand it is `cd leader && claude`, or `cd leader && claude --remote-control "Leader"` for one session you can type to on the PC and open in the Claude app (Code tab) or at claude.ai/code.

  (`claude remote-control` is a different mode: its own session that you open from the app, and you cannot type to it in that window. Remote Control needs a claude.ai login, not an API key.) Claude Code asks you to approve the leader's `stop`, `run`, `new`, `feature`, `plan queue`, `approve`, `send-back`, `get` and `publish` commands; answer Yes once. The leader also asks you in the chat before it answers a check for you, before it downloads from GitHub, and before it sends work to GitHub, and never does any of this on its own.

  The leader cannot reopen a feature or change a plan in place. A stuck feature or a question is answered with a follow-up request, which starts on the next run.

**Not tried on a real PC yet:** Docker Desktop and WSL2 networking to a browser or an iPad, iPad Safari, `claude --remote-control`, the Windows shortcuts, a real GitHub with `mc get`, `mc publish-preview` and `mc publish`, and any real AI output on a Windows PC. The dashboard and the leader's instructions are tested against recordings of the real engine run with stand-in AIs. Details: [docs/leader.md](docs/leader.md), [docs/dashboard-spec.md](docs/dashboard-spec.md) (section 20 lists what is unverified).

## Documents

| File | What's in it |
|---|---|
| [docs/brainstorm.md](docs/brainstorm.md) | Research, economics, fact-check of the X post, and prior art |
| [docs/design-v1.md](docs/design-v1.md) | The architecture and the decisions behind it |
| [docs/mvp-spec.md](docs/mvp-spec.md) | The exact build contract, including verified CLI facts and the decision log |
| [docs/setup-windows.md](docs/setup-windows.md) | Step-by-step setup for Windows 11 + iPad |
| [docs/github-setup.md](docs/github-setup.md) | Work with GitHub: log in once, download a repository, send a finished mission back as a draft pull request |
| [docs/leader.md](docs/leader.md) | The leader: what it may do, how it is limited, what is not tried |
| [docs/work-modes.md](docs/work-modes.md) | Documents, pages and data: how work that has no tests is checked, what it costs, the privacy note, what was not tried |
| [docs/modes-spec.md](docs/modes-spec.md) | The design behind it: the three ways of checking, the checks Mission Control runs by itself, pictures, the prompts |
| [docs/dashboard-spec.md](docs/dashboard-spec.md) | The dashboard's build contract: lamp rules, wording, data sources, tests |

## For developers

```bash
npm install
npm run check     # typecheck + all tests (no network, no real AI calls)
npm run build     # → dist/cli.js (the `mc` command)
```

TypeScript on Node 22. The layout is described in `docs/mvp-spec.md` § Layout. Pinned CLI versions are Claude Code 2.1.295 and Codex 0.162.0; `mc doctor` warns when the installed versions differ.

**Known limits:**
- The container's outbound network is not restricted yet.
- Agents run as the same user as Mission Control inside the container.

Both are documented in the spec's decision log.

**What is not built.**
- **Features that run side by side.** Deferred, and not built. Mission Control is made for one feature at a time: one loop over the features, one copy of the mission in memory that is written whole at every save, one run lock, one line of merges into a single branch, pacing that assumes one AI call at a time, and a timeline and stops that assume one feature is in flight. Running features side by side would need separate working copies, a rule for merge conflicts (who settles them?), saves that cannot overwrite each other, a resume that copes with several half-finished features, and pacing across calls that overlap. Thousands of tests assume a fixed order, so doing it would also make them unreliable. The gain is clock time on big jobs with many features. The use of the allowance is the same, and most small jobs have one to three features. It waits until real use shows that it is needed.
- **Research that needs sources.** Not covered: a plan carries no web address, and nothing checks that a source is real or that a fact is true.
- **Pictures on the dashboard, and pages that need a running server.** The pictures of a page go to the report, not to the dashboard, and a page that needs a server gets none. The rest of the list is in [docs/work-modes.md](docs/work-modes.md).
