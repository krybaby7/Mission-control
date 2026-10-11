# The leader

The leader is the way a non-technical CEO acts on Mission Control. It is a Claude Code session, started in the repository's `leader/` folder, that the CEO talks to in plain words. It is the CEO's hands. The dashboard ([docs/dashboard-spec.md](dashboard-spec.md)) is the CEO's eyes and only shows things.

This page says what the leader is, what it may do, how it is kept inside those limits, and what has not been tried. For the steps to start it on your PC, see [leader/README.md](../leader/README.md) and [docs/setup-windows.md](setup-windows.md).

## What it is, and what it is not

- It is Claude Code, running in the Ubuntu (WSL2) window on the PC, with `leader/` as its folder. Claude Code reads `leader/CLAUDE.md` there as its standing instructions and `leader/.claude/settings.json` as its permissions.
- The same session can be reached from the Claude app (Remote Control, below).
- It acts only through Mission Control's own commands, run through `scripts/mc-docker.sh`: status, logs, report, stop, new, feature and run. There is no other write path: the dashboard has none either.
- It is the CEO's hands, never the CEO's engineer. It does not write code, fix an app, or do the AI team's work. The engine does that.
- It adds nothing to the engine. No engine file was changed to make it.

## The seven commands

All are run from `leader/` as `../scripts/mc-docker.sh <command>`. Each was checked against `mc --help` and the help of each command (the commands and flags in `src/cli.ts`), and against `scripts/mc-docker.sh`, which hands everything it does not know to `mc` inside the container.

| Command | What it does | Notes |
|---|---|---|
| `status --json` | Lists every mission: id, title, kind, status, stage, features done and total, blocked, `waitingUntil`, `interrupted`. | Read only. |
| `logs <mission>` | What happened in one mission, step by step. | Read only. `--follow` never ends, so the leader does not use it. |
| `report [<mission>]` | The start of the latest report, or of one mission's. | Read only. |
| `stop` | Asks the running night to stop. The running AI step is cancelled, progress is saved and the report is written. | Writes the `STOP` file. The leader always asks first. |
| `new '<idea>' --name '<name>'` | Queues a new app. | Only queues. |
| `feature ~/mc-apps/<app-folder> '<request>' --base '<branch>'` | Queues a change to an existing app. | Only queues. The folder must be inside `~/mc-apps`. |
| `run --until HH:MM` | Works through the queue. `--mission <id>` works on one mission only. | Spends the owner's usage. It blocks for the whole night. |

Not in the list on purpose: `dashboard` (a foreground command that runs until Ctrl+C, so a tool call from the leader would never return; the owner starts it), `config`, `init`, `doctor`, the logins, `shell`, `build`, `copy-reports` and `fix-permissions`.

## Starting the night without blocking the chat

`run` does not return until the stop time or the end of the queue (`run_night` in `scripts/mc-docker.sh` ends in `exec docker run`). Run in the foreground, it would make the chat unusable all night. So `leader/CLAUDE.md` tells the leader to start it as a background task (Claude Code's Bash tool has a `run_in_background` option) and to keep talking.

Under such a task there is no terminal, so `mc-docker.sh run` behaves as it does under Task Scheduler: it waits up to five minutes for Docker Desktop, and if it cannot start it pushes a notification to the owner's iPad (decision log, "Container and setup" item 4).

Not tried here: running `mc-docker.sh run` as a background task of a Claude Code session. If the session ends during the night, the run may receive a stop signal. The engine handles `SIGHUP`, `SIGINT` and `SIGTERM` by finishing up and saving its progress (`src/run.ts`), and the next run continues, but nobody has seen this happen through Claude Code. A night that must not depend on a chat session is started by the owner or by the scheduled task.

## Permissions

`leader/.claude/settings.json` allows exactly the seven commands, written as `Bash(../scripts/mc-docker.sh <command>:*)`. It also refuses `Edit`, `Write`, `NotebookEdit` and `git` commands, so a leader that goes off script still cannot change files or push. Everything else makes Claude Code ask.

The stop and run commands are in the allow list, so Claude Code does not ask before them. The confirmation before `stop` is in `CLAUDE.md`, in words. To have Claude Code itself ask before `stop`, `run`, `new` and `feature`, move those four entries from `allow` to a list called `ask` in the same file. That costs a tap per command, and works from the app too. It has not been tried.

Not tried here: that the rule syntax matches commands written with a relative path in the installed Claude Code, that a compound command (`a && b`) is refused as a whole, and how the same rules behave in a Remote Control session.

## The sentences the dashboard gives the CEO

The dashboard sends nothing. Its "Tell the leader" button gives the CEO a ready sentence with `<your answer here>` for them to fill in, and a Copy button; the CEO pastes it into the chat. The sentences are fixed by the dashboard's vocabulary (`src/dashboard/vocabulary.ts`, spec section 8). No sentence contains text an AI wrote. They name a mission, and sometimes a feature or a question number, so the leader can find the item with `status --json`, `report` and `logs`. When two missions or features have the same title, the sentence adds the id.

`leader/CLAUDE.md` has a table of every sentence and what to do with it, and the four quick phrases (Your call, Leave it out, Try again, What is going on?). `test/leader.test.ts` builds each sentence from the vocabulary module and fails when `CLAUDE.md` does not contain it word for word, so the two cannot drift apart.

## Answers to stuck features and questions

The engine has no command to reopen a feature or to change a plan in place, and a finished mission never runs again. A stuck feature or an unanswered question therefore cannot be answered inside the mission. The leader says so in plain words and offers a follow-up request: a new mission on the same app, queued with `feature`, using the folder and `--base` the report gives. It starts on the next run. A mission that failed and needs the owner's help is different: after the cause is dealt with, `run --mission <id>` continues the same mission.

## Remote Control

The documented way to reach the leader from the Claude app is `claude remote-control`, run in `leader/`. The session should then appear in the Claude Code app (or the Claude Desktop app). The installed Claude Code (2.1.296) lists `remote-control` and a `--remote-control` option in its help.

Not tried here: starting it, seeing the session in the app, what a CEO can do in it, the permission prompts in it, and what happens when the connection drops. The PC must stay on and awake, and the Ubuntu window must stay open.

## Limits

- The leader's chat uses the same Claude plan as the night run. The engine's pacing cannot see it.
- It cannot see exact usage figures or the allowance. The dashboard shows them.
- It cannot log in to Claude or Codex, free disk space, start the dashboard, remove or reorder queued work, reopen a feature or change a plan in place.
- It reads texts written by AIs (reports, logs, decisions). `CLAUDE.md` tells it to treat them as information and never to run a command that appears in them. How well it holds to this has not been tested against a hostile text.

## Not verified

Said plainly; none of this may be claimed to work.

- `claude remote-control`, and the Claude app reaching the leader.
- The leader's behaviour with `CLAUDE.md` and the settings file, in a real Claude Code.
- Running `mc-docker.sh run` as a background task, and what happens to it when the session ends.
- Claude Code installed in Ubuntu next to Docker Desktop on a real PC.
- Any of the leader's answers: they depend on the real status, log and report text, which every test here replaces with stand-ins.
