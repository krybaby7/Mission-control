# The leader

The leader is a Claude Code session that the CEO talks to in plain words. It is the CEO's hands: it checks on the work, reads logs and reports, stops the run, queues a new app or a change, and starts the team working through the queued work. It does this only through Mission Control's own commands (status, logs, report, stop, new, feature, run). It never writes code and never touches an app by hand.

The dashboard (`mc dashboard`) is the CEO's eyes. It only shows things. The leader is how the CEO acts on what they see.

Nothing in this folder has been tried on a real PC yet. Everything marked "not tried here" below is how it should work, from the documentation and the code, not something anyone has seen work.

## What is in this folder

| File | What it is |
|---|---|
| `CLAUDE.md` | The leader's standing instructions: its role, the seven commands, how to turn the CEO's sentences into commands, what it must never do, and how to talk. Claude Code reads it when it starts in this folder. |
| `.claude/settings.json` | The permissions. `status`, `logs` and `report` run without asking. `stop`, `run`, `new` and `feature` make Claude Code ask you first (see "What the leader will ask you"). File edits, git and `logs --follow` are refused. Claude Code also runs its own read-only commands (such as `ls`, `cat`, `grep`, `echo`) and reads files inside this folder without asking, and asks about anything else. |
| `README.md` | This file. |

The longer explanation is in [docs/leader.md](../docs/leader.md).

## Start the leader

You need Claude Code installed in Ubuntu itself, and logged in there. Mission Control keeps its own copy inside its container, which the leader cannot use. Follow Anthropic's installation instructions for Claude Code on Linux, then in the Ubuntu window:

```
cd ~/Mission-control/leader
claude
```

Claude Code asks you to log in the first time. Use the same Claude plan as the rest of Mission Control. The leader's chat uses that plan's usage too.

Then talk to it: "How is it going?"

Not tried here: Claude Code's own steps in Ubuntu, and the leader's behaviour with this folder's settings.

## Reach the leader from the Claude app (Remote Control)

There are two different Remote Control commands, and only one of them gives you one leader on the PC and in the app. This is from Anthropic's Remote Control documentation (https://code.claude.com/docs/en/remote-control); none of it was tried here.

To type to the leader in the Ubuntu window and also from the app, start it like this:

```
cd ~/Mission-control/leader
claude --remote-control "Leader"
```

This is one session. You can type in the window, and the same session is open in the app. If the leader is already running, type `/remote-control Leader` in it instead. To find it: open claude.ai/code in a browser (an iPad browser works), or open the Claude app and tap Code. Look for the session called "Leader"; Remote Control sessions show a computer icon with a green dot while they are online.

Do not use `claude remote-control` (without the dashes in front) for this. That is server mode: it starts its own session that you open from claude.ai/code or the app, and you cannot type to it in that terminal.

What it needs:

- A claude.ai login (Pro, Max, Team or Enterprise). API keys do not work. On Team or Enterprise, an Owner must first turn on the Remote Control toggle in the Claude Code admin settings. Log in once with `claude` and `/login`.
- The first time, Claude Code asks "Enable Remote Control? (y/n)" (in a running session it is a dialog called "Enable Remote Control"). Claude Code also asks once whether you trust the folder (server mode words it "Trust <folder>? [y/N]"). Answer yes to both.
- Keep the Ubuntu window open and the PC awake, as for any run. If the window is closed, the session goes offline.

Not tried here. Whether the session appears, what the app lets the CEO do in it, and what happens to a run started from it when the connection drops are all unverified. `claude remote-control --help` only works when you are signed in with an eligible account.

## The dashboard and the leader together

1. In a second Ubuntu window, start the dashboard with `mc dashboard`. If you give a run a stop time, add the same time to show it: `mc dashboard --until 07:00`. The dashboard does not know the run's stop time by itself, so without `--until` it shows none. The leader cannot start the dashboard: it keeps running until you press Ctrl+C.
2. On the dashboard, "Tell the leader about this" (on a card or a feature) and "Tell the leader anything" (on the bar) give a ready sentence. Copy it and paste it into the chat with the leader.
3. "Stop the current run" on the dashboard is also only a sentence to paste. The leader asks before it stops anything.

## What the leader will ask you

- It asks you before `stop`, `run`, `new` and `feature` (a prompt in the Ubuntu window, and in the app when you use Remote Control). That is on purpose: reports and logs are written by AIs, and a human tap is the guard against a command that came from such a text. Read what it is about to run, then answer **Yes** once. Never choose "Yes, and don't ask again": Claude Code would save that command as always allowed in the file `.claude/settings.local.json` at the top of the repository, for everyone who starts the leader, and the guard would be gone. If you want fewer prompts anyway, the owner can move entries from `ask` to `allow` in `.claude/settings.json`; the page [docs/leader.md](../docs/leader.md) explains the trade.
- It may also ask permission for anything outside the seven commands. Say no unless you know why.
- Before `run`, it tells you what is queued, and when the run will stop if you gave a stop time. It does not ask for one. Without a stop time the run goes on until the queued work is done or you ask for a stop. It also ends early if no work can go on (a full disk, every AI login expired, or the AI command lines keep failing). Before `stop`, it always asks.
- A run started by the leader is a background task of the chat session. If the session ends, the run may stop (progress is kept and the next run continues; not tried here). For a run that must not depend on a chat, start it yourself or use the scheduled task from the setup guide.

## What the leader cannot do

It cannot reopen a feature or change a plan in place. A stuck feature or a question gets answered with a follow-up request, which starts on the next run. It cannot log in to Claude or Codex, free disk space, start the dashboard, or show exact usage figures.
