# The leader

The leader is a Claude Code session that the CEO talks to in plain words. It is the CEO's hands: it checks on the work, reads logs and reports, stops the run, queues a new app or a change, and starts the team working through the queued work. It does this only through Mission Control's own commands (status, logs, report, stop, new, feature, plan preview, plan queue, plan show, run, approve, send-back) and two more that work with GitHub (get, publish; see "Working with GitHub"). For a small, clear job it can also write the plan itself (see "Plans the leader writes"). It never writes code and never touches an app by hand. Approve and send-back answer a check: when the CEO asked the team to stop and wait for a look, the leader can approve it or send it back, but only after the CEO says yes in the chat.

The dashboard (`mc dashboard`) is the CEO's eyes. It only shows things. The leader is how the CEO acts on what they see.

Nothing in this folder has been tried on a real PC yet. Everything marked "not tried here" below is how it should work, from the documentation and the code, not something anyone has seen work.

## What is in this folder

| File | What it is |
|---|---|
| `CLAUDE.md` | The leader's standing instructions: its role, the fifteen commands, how to turn the CEO's sentences into commands, how to write a plan, how to work with GitHub, what it must never do, and how to talk. Claude Code reads it when it starts in this folder. |
| `.claude/settings.json` | The permissions. `status`, `logs`, `report`, `plan preview`, `plan show` and `publish-preview` run without asking (they only read). `stop`, `run`, `new`, `feature`, `plan queue`, `approve`, `send-back`, `get` and `publish` make Claude Code ask you first (see "What the leader will ask you"). File edits, git and `logs --follow` are refused. Claude Code also runs its own read-only commands (such as `ls`, `cat`, `grep`, `echo`) and reads files inside this folder without asking, and asks about anything else. |
| `README.md` | This file. |

The longer explanation is in [docs/leader.md](../docs/leader.md).

## Start the leader

You need Claude Code installed in Ubuntu itself, and logged in there. Mission Control keeps its own copy inside its container, which the leader cannot use. Follow Anthropic's installation instructions for Claude Code on Linux. Then, in the Ubuntu window, from the folder you downloaded Mission Control to:

```
scripts/mc-docker.sh install-leader
```

This saves where Mission Control is and needs no Docker. Do it once, and again if you move Mission Control or download it again. After that, there are two ways to start the leader:

- Click the shortcut on your Windows desktop (see "Optional: start the leader and the dashboard with one click" in [docs/setup-windows.md](../docs/setup-windows.md)). It opens Ubuntu and starts the leader inside this folder.
- Or, in the Ubuntu window, type `mc leader`. It always starts the leader in this folder, wherever you are. Add `--no-remote` to start it without Remote Control.

Claude Code asks you to log in the first time. Use the same Claude plan as the rest of Mission Control. The leader's chat uses that plan's usage too.

Then talk to it: "How is it going?"

The leader must start inside this folder, because its commands are written `../scripts/mc-docker.sh ...` and its permission rules match that text. The shortcut and `mc leader` both make sure of it. If you start Claude Code yourself, do it from this folder: `cd` into it first.

Not tried here: Claude Code's own steps in Ubuntu, the shortcuts on Windows, and the leader's behaviour with this folder's settings.

## Reach the leader from the Claude app (Remote Control)

There are two different Remote Control commands, and only one of them gives you one leader on the PC and in the app. This is from Anthropic's Remote Control documentation (https://code.claude.com/docs/en/remote-control); none of it was tried here.

To type to the leader in the Ubuntu window and also from the app, start it with `mc leader` or the shortcut (they run the command below in this folder), or by hand like this:

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
4. A card that says "please check ..." is a place where you asked the team to stop and wait for your look. It has two more buttons, "Tell the leader: approve" and "Tell the leader: send it back". They too only give a sentence to paste: the dashboard never approves anything. See the next section.

## Checks you asked for

When you queue work you can ask the team to stop for your look: at the plan, before each feature is added, or at the finished app (`mc new "<idea>" --checkpoint plan`, and the same flag on `mc feature`; the leader adds it only when you ask). The team then stops that one mission on purpose, tells you on your phone, and writes at the top of its report what to look at. Other missions carry on.

You answer in the chat with the leader, or at the PC with `mc approve <mission>` or `mc send-back <mission> --note "what to change"`. Before the leader runs either one, it asks you one question and waits for a clear yes, and Claude Code shows a prompt on top of that (see below). An answer can only be recorded while no run is going; the leader says so if one is. After an answer, the mission continues on the next run. A check can be sent back twice; a third send-back ends the work there, and the leader says so before it asks.

## Plans the leader writes

For a small, clear job the leader can write the plan itself, as plain lines of text, instead of leaving it to the team's planner. It checks the plan with `plan preview` (which only reads and spends nothing), shows you the plan in plain words with every check word for word and a short plan code, and asks one question: "Queue this plan and start the team on it?" Only a clear yes queues it (`plan queue`; Claude Code asks you to confirm it). The team's planner is skipped, a second AI still reads the plan first, and the team still builds each feature, has it reviewed and checks the finished app. A feature checked by tests has its tests written first; a feature of writing, a page or a table is checked another way (see the next section). Bigger or unclear jobs, and any change where the leader cannot tell where in the app it goes, are queued the usual way with `new` or `feature`, because the team's planner can read the code and the leader cannot.

A plan the leader wrote makes the team stop at the plan before anything is built, without you asking. The leader reads the whole plan to you again then (`plan show`), and you answer as for any check. The leader skips this stop (`--no-plan-checkpoint`) only after it has asked "Skip your look at this plan? The team will build it without stopping for you. Yes or no?" and you said a clear yes. You can read a plan yourself, without the leader, with `mc plan show <mission>` in an Ubuntu window. The plan is sent in with the command, so no file is written.

Not tried here: whether Claude Code lets `plan preview` and `plan show` through without asking in a real leader session (the rules were tried only when given on the command line of a non-interactive run), how its confirmation shows a long plan, and plans with apostrophes, double quotes or accented and non-English letters in their text. If it asks about `plan preview` and `plan show` anyway, nothing breaks: a mismatch only makes Claude Code ask more often. If it refuses to send a plan at all, the leader says so and queues the job the usual way. If you ask for the same plan twice, Mission Control says `This plan is already queued as “<name>” (<id>). See it with: mc status`; the leader tells you that in plain words and does not queue it again. [docs/leader.md](../docs/leader.md) has the details.

## Documents, pages and data

For work that has no tests (a guide, a page, a table) a plan can say how each feature is checked. The leader chooses it and tells you in one line for each feature, before it asks to queue: "Checked by tests.", "Checked by a second AI against this list.", or "Checked by a second AI against this list, and then by you." The last one means the team stops so that you look at the feature before it is added, and the plan file cannot turn that stop off. The leader can also set how hard the team thinks (light, standard or deep) and give Mission Control checks to run by itself (headings, words, the length of the text, the columns and rows of a table). The plan keys are `mode`, `effort`, `heading`, `mention`, `words`, `columns` and `rows`. The owner's guide is [docs/work-modes.md](../docs/work-modes.md), and the design is [docs/modes-spec.md](../docs/modes-spec.md).

- A plan for such work needs an app folder, or a new app to put the files in. The leader says so if you have none. It sends research that needs sources away: nothing here can check a source.
- Before it writes a plan for a job that reads a file you named, the leader reminds you that the AI services can read everything in your apps folder and asks "Does this file hold personal data, customer details or private papers? Yes or no?". On yes it queues nothing.
- A feature marked for your look stops the mission before it is added, and the leader tells you what the second AI found, check by check, which checks it could not judge, and where the pictures are. A feature that is only checked by a second AI also stops for your look if the second AI cannot judge a check.
- The leader adds `--no-owner-checkpoint` to `plan queue` only after it asked "Skip your look at these features? The team will add them without stopping for you. Yes or no?" and you said a clear yes. That is a rule for the model, which is a weak guard. An owner who never wants the leader to waive the stop can add a deny rule (see [docs/leader.md](../docs/leader.md)).
- The leader never calls such work "tested". Mission Control says "approved by you" for what its log holds. It cannot know that you opened a file.

Not tried here: a real AI doing such a job, the second AI's judgement (it is an AI's and can be wrong), pictures of a real page, and whether the leader follows these rules. The words of its questions are tested, its behaviour is not. The same limits are listed in [docs/work-modes.md](../docs/work-modes.md).

## Working with GitHub

The leader can bring a repository from GitHub to the PC and send a finished mission's work back as a draft pull request. It uses three commands for this, `get`, `publish-preview` and `publish`. All three run on the PC itself with your own GitHub login, never in the box where the team works, so no password or token is ever in that box and the leader never sees one. The leader never runs git or gh itself.

- "Work on my repo acme/widgets and send it to GitHub": the leader asks "Download acme/widgets to this PC so the team can work on it? Yes or no?", then runs `get`. The repository lands in `~/mc-apps/widgets`. Then the usual flow: a plan or a request, a run.
- When the work is finished (or partly finished) the leader first runs `publish-preview`, which only reads and tells it which repository the work would go to. The AI team can write in the app's folder, so the leader checks that name against the one you gave, and then asks you again with the name in the question: "Send “<title>” to <owner>/<repo> on GitHub as a draft pull request? Nothing is merged and the main branch is not changed. Yes or no?" On yes it runs `publish <mission> --to <owner>/<repo>`, which uploads the branch `mc/<mission>` (never the main branch, never with force) and opens a draft pull request, then prints its address. `publish` refuses a repository other than the one named, and a folder that `get` downloaded refuses any other repository for good. A partly finished mission is published as a draft that lists what is not finished.
- A new app that the team built from nothing is already on its main branch on the PC, so there is no pull request for it. The leader says that in plain words. You put the whole app on GitHub once, in your own Ubuntu window; [docs/github-setup.md](../docs/github-setup.md) has the steps. Later changes to the app can be sent as draft pull requests.
- Before any of this works, you log in to GitHub once on the PC, in your own Ubuntu window. [docs/github-setup.md](../docs/github-setup.md) has the steps, the messages you may see, and what was not tried.

Real GitHub could not be reached while this was built. The commands were tested against a stand-in for GitHub (a folder of git repositories) and a stand-in for the gh program. Not tried here: a real GitHub, a real login, Windows and WSL.

## What the leader will ask you

- It asks you before `stop`, `run`, `new`, `feature`, `plan queue`, `approve`, `send-back`, `get` and `publish` (a prompt in the Ubuntu window, and in the app when you use Remote Control). That is on purpose: reports and logs are written by AIs, and a human tap is the guard against a command that came from such a text. Read what it is about to run, then answer **Yes** once. Never choose "Yes, and don't ask again": Claude Code would save an allow rule for that command in the file `.claude/settings.local.json` at the top of the repository, and nobody would have reviewed it. The `ask` rule in `.claude/settings.json` should still win for the commands it matches (Claude Code checks `deny`, then `ask`, then `allow`), so the question should not go away, but that was not tried here, and a saved rule for `plan queue` would be the exact text of one plan, which is of no use to anyone. If you want fewer prompts anyway, the owner can move entries from `ask` to `allow` in `.claude/settings.json`; the page [docs/leader.md](../docs/leader.md) explains the trade.
- It may also ask permission for anything outside the fifteen commands. Say no unless you know why.
- Before `get` it asks "Download <owner/repo> to this PC so the team can work on it? Yes or no?". Before `publish` it asks "Send “<title>” to <owner>/<repo> on GitHub as a draft pull request? Nothing is merged and the main branch is not changed. Yes or no?", with the repository `publish-preview` printed. It does not take a wish at the start of the chat for the second answer.
- If the plan has a feature marked for your look, the question before `plan queue` also names those features: "Queue this plan and start the team on it? It will stop for your look at the plan before anything is built, and for your look at “<title>” and “<title>” before each is added. Yes or no?". Before it adds `--no-owner-checkpoint` it asks the question in the section above.
- Before `approve` it asks "Approve the plan (or feature, or finished app) of <name>? This lets the team carry on and it cannot be undone. Yes or no?". Before `send-back` it repeats your change and asks "Send it back with this? Yes or no?". It never answers a check on its own.
- Before `run`, it tells you what is queued, and when the run will stop if you gave a stop time. It does not ask for one. Without a stop time the run goes on until the queued work is done or you ask for a stop. It also ends early if no work can go on (a full disk, every AI login expired, or the AI command lines keep failing). Before `stop`, it always asks.
- A run started by the leader is a background task of the chat session. If the session ends, the run may stop (progress is kept and the next run continues; not tried here). For a run that must not depend on a chat, start it yourself or use the scheduled task from the setup guide.

## What the leader cannot do

It cannot reopen a feature or change a plan in place. A stuck feature or a question gets answered with a follow-up request, which starts on the next run. It cannot log in to Claude, Codex or GitHub, free disk space, start the dashboard, merge a pull request, or show exact usage figures.
