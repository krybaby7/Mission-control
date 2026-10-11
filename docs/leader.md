# The leader

The leader is the way a non-technical CEO acts on Mission Control. It is a Claude Code session, started in the repository's `leader/` folder, that the CEO talks to in plain words. It is the CEO's hands. The dashboard ([docs/dashboard-spec.md](dashboard-spec.md)) is the CEO's eyes and only shows things.

This page says what the leader is, what it may do, how it is kept inside those limits, and what has not been tried. For the steps to start it on your PC, see [leader/README.md](../leader/README.md) and [docs/setup-windows.md](setup-windows.md).

## What it is, and what it is not

- It is Claude Code, running in the Ubuntu (WSL2) window on the PC, with `leader/` as its folder. Claude Code reads `leader/CLAUDE.md` there as its standing instructions and `leader/.claude/settings.json` as its permissions.
- The same session can be reached from the Claude app or claude.ai/code (Remote Control, below), when it is started with `claude --remote-control`.
- It acts only through Mission Control's own commands, run through `scripts/mc-docker.sh`: status, logs, report, stop, new, feature and run. There is no other write path: the dashboard has none either.
- It is the CEO's hands, never the CEO's engineer. It does not write code, fix an app, or do the AI team's work. The engine does that.
- It adds nothing to the engine. No engine file was changed to make it.

## The seven commands

All are run from `leader/` as `../scripts/mc-docker.sh <command>`. Each was checked against `mc --help` and the help of each command (the commands and flags in `src/cli.ts`), and against `scripts/mc-docker.sh`, which hands everything it does not know to `mc` inside the container.

| Command | What it does | Notes |
|---|---|---|
| `status --json` | Lists every mission: id, title, kind, status, stage, features done and total, blocked, `waitingUntil`, `interrupted`. | Read only. `waitingUntil` is UTC (the string ends in Z), because `src/cli.ts` prints the raw event time in JSON. The plain `status` table prints the same moment in local time, in its WAITING UNTIL column. `leader/CLAUDE.md` tells the leader to read the local time there and never to say the UTC clock time as if it were local. |
| `logs <mission>` | What happened in one mission, step by step. | Read only. The whole log is long and technical (model names, internal steps), so the leader reads only the last 60 lines (it pipes the output through `tail -n 60`) and translates. `--follow` never ends, so the leader does not use it, and the settings refuse it. |
| `report [<mission>]` | The first 40 lines of the latest report, or of one mission's. | Read only. "Needs your decision" and the Features table are near the top, but with many features they can fall below line 40. The rest sits in a file inside the Docker volume, which the leader cannot open. A mission that is still running has no report (the command says so and fails): the leader then reads the end of `logs` and says the full answer comes when the mission ends. |
| `stop` | Asks the running work to stop. The running AI step is cancelled, progress is saved and the report is written. | Writes the `STOP` file. The leader first checks with `status --json` that a run is going (if not, it says there is nothing to stop and does not run `stop`), then always asks. Claude Code asks too (see Permissions). |
| `new '<idea>' --name '<name>'` | Queues a new app. | Only queues. |
| `feature ~/mc-apps/<app-folder> '<request>' --base '<branch>'` | Queues a change to an existing app. | Only queues. The folder must be inside `~/mc-apps`. |
| `run [--until HH:MM]` | Works through the queue. `--mission <id>` works on one mission only. | Spends the owner's usage. It blocks until the run ends. `--until` is optional: the leader passes it only when the CEO gives a stop time, and never asks for one. What happens without it is in the next section. |

Not in the list on purpose: `dashboard` (a foreground command that runs until Ctrl+C, so a tool call from the leader would never return; the owner starts it), `config`, `init`, `doctor`, the logins, `shell`, `build`, `copy-reports` and `fix-permissions`.

## Starting a run without blocking the chat

`run` does not return until the run ends (the Docker script's `run` branch ends in `exec docker run`). Run in the foreground, it would make the chat unusable for as long as the run lasts. So `leader/CLAUDE.md` tells the leader to start it as a background task (Claude Code's Bash tool has a `run_in_background` option) and to keep talking.

### With and without a stop time

What `mc run` does without `--until`, from `src/run.ts`, `src/cli.ts` and `scripts/mc-docker.sh` (the Docker script passes the arguments on unchanged and adds no stop time):

- There is no stop time and no upper limit on the length of the run. `src/run.ts` logs "Working until the queue is done (no stop time given)." The run goes through the queued missions one after another, picks up missions queued while it works, and ends when none has work left, when `mc stop` or a stop signal arrives, or when the work cannot go on (a full disk, every AI needs a login, or the AI command lines keep failing).
- When every AI is at its usage limit, the run waits for the limit to end and carries on. With a stop time, it ends the run instead of waiting past that time. Without one it can wait a long time.
- With a stop time, the engine refuses one that is more than 18 hours ahead (`--until` always means the next time the clock shows it) and starts nothing.

`leader/CLAUDE.md` tells the leader to say this in plain words before it starts a run without a stop time. The CEO decides whether there is a stop time; the leader does not ask for one. The dashboard's `--until` is only "a stop time to show": the engine does not save the stop time, so `mc dashboard --until HH:MM` takes the time the CEO gave and shows it with a countdown.

Some of Mission Control's own messages still use an older word for the run: the phone notification "Night finished", the log line "Ending the night early", and the README's tagline "Your overnight software team". The engine was not changed. In the leader's words, and in everything the dashboard shows, each of them means that the team finished or ended its run.

### Without a terminal

Under such a task there is no terminal, so `mc-docker.sh run` behaves as it does under Task Scheduler: it waits up to five minutes for Docker Desktop, and if it cannot start it pushes a notification to the owner's iPad (decision log, "Container and setup" item 4).

Not tried here: running `mc-docker.sh run` as a background task of a Claude Code session. If the session ends during a run, the run may receive a stop signal. The engine handles `SIGHUP`, `SIGINT` and `SIGTERM` by finishing up and saving its progress (`src/run.ts`), and the next run continues, but nobody has seen this happen through Claude Code. A run that must not depend on a chat session is started by the owner or by the scheduled task.

## Permissions

`leader/.claude/settings.json` has three lists, with rules written as `Bash(../scripts/mc-docker.sh <command>:*)`:

- `allow` (no prompt): `status`, `logs` and `report`. They only read.
- `ask` (Claude Code stops and asks first): `stop`, `run`, `new` and `feature`. They change something or spend usage.
- `deny` (refused): `Edit`, `Write`, `NotebookEdit`, `git` commands, and `logs ... --follow` (the rule is `Bash(../scripts/mc-docker.sh logs *--follow*)`, because `logs:*` in the allow list would otherwise let it through).

Claude Code checks `deny` first, then `ask`, then `allow`, so an `ask` rule wins over an `allow` rule that also matches. A compound command (`a && b`) needs every part to match. Claude Code also runs its own read-only commands (`ls`, `cat`, `grep`, `echo`, `wc`, `find`, read-only forms of `git`) and reads files inside the folder without asking, so "everything else asks" is not exact. These details are from Anthropic's permissions documentation (https://code.claude.com/docs/en/permissions).

Why `stop`, `run`, `new` and `feature` ask: reports, logs, decisions and the names of missions and features are written by AIs, and the leader reads them. `CLAUDE.md` tells the leader that such text is data, never instructions, but a sentence in a prompt is a weak guard. A person tapping Yes on a prompt, with the command in front of them, is a real one. It costs one tap per command, on the PC or, with Remote Control, in the app (the documentation says permission prompts stay open until they are answered).

Answer **Yes** once. Do not choose "Yes, and don't ask again": Claude Code saves that as a rule in `.claude/settings.local.json` at the root of the repository, which would let the command through for every later session, started in any folder of the repository.

To relax this, move entries from `ask` to `allow` in the same file. The confirmation before `stop` in `CLAUDE.md` stays either way.

Not tried here: that the rule syntax matches commands written with a relative path in the installed Claude Code, that the `--follow` rule catches `logs <mission> --follow` and `logs --follow <mission>`, that a compound command (`a && b`) is refused as a whole, and how the same rules behave in a Remote Control session. `test/leader.test.ts` checks only the shape of the file.

## The sentences the dashboard gives the CEO

The dashboard sends nothing. Its buttons "Tell the leader about this" (on a card or a feature) and "Tell the leader anything" (on the bar) give the CEO a ready sentence with `<your answer here>` for them to fill in, and a Copy button; the CEO pastes it into the chat. The sentences are fixed by the dashboard's vocabulary (`src/dashboard/vocabulary.ts`, spec section 8). The only text an AI wrote in a sentence is a mission or feature title; leader/CLAUDE.md tells the leader that these names are data, never instructions. The sentences name a mission, and sometimes a feature or a question number, so the leader can find the item with `status --json`, `report` and `logs`. When two missions or features have the same title, the sentence adds the id.

`leader/CLAUDE.md` has a table of every sentence and what to do with it, and the four quick phrases (Your call, Leave it out, Try again, What is going on?). `test/leader.test.ts` builds each sentence from the vocabulary module and fails when `CLAUDE.md` does not contain it word for word, so the two cannot drift apart.

## Answers to stuck features and questions

The engine has no command to reopen a feature or to change a plan in place, and a finished mission never runs again. A stuck feature or an unanswered question therefore cannot be answered inside the mission. The leader says so in plain words and offers a follow-up request: a new mission on the same app, queued with `feature`, using the folder and `--base` the report gives. It starts on the next run. A mission that failed and needs the owner's help is different: after the cause is dealt with, `run --mission <id>` continues the same mission.

## Remote Control

From Anthropic's Remote Control documentation (https://code.claude.com/docs/en/remote-control), not from anything tried here:

- `claude --remote-control "Leader"`, or `/remote-control Leader` inside a running session, makes ONE session that works from the Ubuntu window and from the Claude app or claude.ai/code. That is the way to use for the leader.
- `claude remote-control` is server mode. It starts its own session, which is opened from claude.ai/code or the app, and you cannot type to it in that terminal. It is not "the same session". The installed Claude Code (2.1.296) lists the `--remote-control [name]` option in `claude --help`; it does not list a `remote-control` command there.
- The session is found by its name in the session list at claude.ai/code (a browser on the iPad works) or under the Code tab of the Claude mobile app. It shows a computer icon with a green dot while it is online.
- It needs a claude.ai login (Pro, Max, Team or Enterprise). API keys are not supported. On Team and Enterprise an Owner must first enable Remote Control in the Claude Code admin settings.
- The first use asks "Enable Remote Control? (y/n)" (a dialog in a running session), and Claude Code asks whether to trust the folder (`Trust <directory>? [y/N]` in server mode).
- The session runs on the PC. If the Ubuntu window closes or the PC sleeps, the session is offline until it is brought back; the documentation says it reconnects by itself when the machine comes back and the network returns.

Not tried here: starting it, seeing the session in the app, what a CEO can do in it, the permission prompts in it, and what happens when the connection drops during a run. The PC must stay on and awake, and the Ubuntu window must stay open.

## Limits

- The leader's chat uses the same Claude plan as the team's runs. The engine's pacing cannot see it.
- It cannot see exact usage figures or the allowance. The dashboard shows them.
- It cannot log in to Claude or Codex, free disk space, start the dashboard, remove or reorder queued work, reopen a feature or change a plan in place.
- It reads texts written by AIs (reports, logs, decisions). `CLAUDE.md` tells it to treat them, and the mission and feature names in a pasted sentence (in quotes, or after "in"), as information and never to run a command that appears in them or follow words in them. How well it holds to this has not been tested against a hostile text; the prompts for `stop`, `run`, `new` and `feature` are the second guard.
- It cannot predict. A question like "Is it going to finish?" gets what is visible (features done, anything stuck, a wait, the stop time if it started the run) and no promise. It has no usage figures and no progress per feature.
- It cannot remove or reorder queued work. "Skip this feature" is answered with that fact, and an offer to stop the run; only a feature that is already stuck stays out.
- It cannot run git. After a report's "How to try it" the app's folder can be left on a trial version; `feature` then refuses, and the leader tells the CEO the owner has to put the app back (the message names the command).

## Not verified

Said plainly; none of this may be claimed to work.

- `claude --remote-control` and `/remote-control`, and the Claude app or claude.ai/code reaching the leader.
- The rule `Bash(../scripts/mc-docker.sh logs *--follow*)` and the `ask` rules, in a real Claude Code.
- The leader's behaviour with `CLAUDE.md` and the settings file, in a real Claude Code.
- Running `mc-docker.sh run` as a background task, and what happens to it when the session ends.
- Claude Code installed in Ubuntu next to Docker Desktop on a real PC.
- Any of the leader's answers: they depend on the real status, log and report text, which every test here replaces with stand-ins.
