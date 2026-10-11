# The leader

The leader is a Claude Code session that the CEO talks to in plain words. It is the CEO's hands: it checks on the night, reads logs and reports, stops the run, queues a new app or a change, and starts the night. It does this only through Mission Control's own commands (status, logs, report, stop, new, feature, run). It never writes code and never touches an app by hand.

The dashboard (`mc dashboard`) is the CEO's eyes. It only shows things. The leader is how the CEO acts on what they see.

Nothing in this folder has been tried on a real PC yet. Everything marked "not tried here" below is how it should work, from the documentation and the code, not something anyone has seen work.

## What is in this folder

| File | What it is |
|---|---|
| `CLAUDE.md` | The leader's standing instructions: its role, the seven commands, how to turn the CEO's sentences into commands, what it must never do, and how to talk. Claude Code reads it when it starts in this folder. |
| `.claude/settings.json` | The permissions. The seven commands run without asking. File edits and git are refused. Anything else makes Claude Code ask you first. |
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

To talk to the same session from the Claude app on your iPad or phone, start it with Remote Control instead. In the Ubuntu window:

```
cd ~/Mission-control/leader
claude remote-control
```

The session should then appear in the Claude Code app (or in the Claude Desktop app). Keep the Ubuntu window open and the PC awake, as for a night run. Run `claude remote-control --help` to see the options your version has.

Not tried here. Whether the session appears, what the app lets the CEO do in it, and what happens to a night run started from it when the connection drops are all unverified.

## The dashboard and the leader together

1. In a second Ubuntu window, start the dashboard with `mc dashboard` (add `--until 07:00` with the same time you give the night run, to see a countdown). The leader cannot start it: it keeps running until you press Ctrl+C.
2. On the dashboard, "Tell the leader" gives a ready sentence. Copy it and paste it into the chat with the leader.
3. "Stop tonight's run" on the dashboard is also only a sentence to paste. The leader asks before it stops anything.

## What the leader will ask you

- It may ask permission for anything outside the seven commands, for example reading a file. Say no unless you know why.
- Before `run`, it tells you what is queued and when the run will stop. Before `stop`, it always asks.
- A run started by the leader is a background task of the chat session. If the session ends, the run may stop (progress is kept and the next run continues; not tried here). For a night that must not depend on a chat, start it yourself or use the scheduled task from the setup guide.

## What the leader cannot do

It cannot reopen a feature or change a plan in place. A stuck feature or a question gets answered with a follow-up request, which starts on the next run. It cannot log in to Claude or Codex, free disk space, start the dashboard, or show exact usage figures.
