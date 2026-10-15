# Habit tracker

**Done** · 2 of 2 features done · report written 2026-10-10 05:00

Your habit tracker is up and running. You can add habits and tick them off.

## What you can do now

- Add a habit by typing its name
- Tick off a habit when you've done it today

## How to try it

Open a terminal and run these one at a time:

1. `cd /home/pwuser/mc-apps/habit-tracker`: go to the app's folder
2. `git checkout mc/2026-10-09-habit-tracker`: switch to the version with the new work
3. `npm install`: download what the app needs (slow the first time)
4. `npm run verify`: run the project's own checks

Then start your app the way you usually do.

To keep the change, add it to your own version (`main`), in the app's folder: `git checkout main && git merge mc/2026-10-09-habit-tracker`. If you don't want it, do nothing: it stays apart, and your version doesn't have it.

When you're done, put the folder back on your own version with `git checkout main`.

## Needs your decision

Nothing. You don't need to do anything.

## Features

|  | Feature | What happened |
|---|---|---|
| ✅ | Add a habit | Built and checked (1 review note below) |
| ✅ | Tick off a habit | Built and checked |

## Choices I made for you

- No login: it is a single-user app on your computer.

## Review notes

- **Add a habit** · Small: The button label could be clearer.

## Usage

No agent runs were recorded.

## Technical details

- Mission id: `2026-10-09-habit-tracker` (feature, profile `mixed`)
- Repository: `/home/pwuser/mc-apps/habit-tracker`
- Started from: `main` at `0123456789`
- Integration branch: `mc/2026-10-09-habit-tracker`
- Integration worktree: `/home/pwuser/.mission-control/worktrees/2026-10-09-habit-tracker/_integration`
- Full check: `npm run verify` · test files: `node scripts/mc-test.mjs {files}`
- Stage: complete · status: done · agent runs: 14 · gate C rounds: 0
- Logs: `missions/2026-10-09-habit-tracker/logs/` and `missions/2026-10-09-habit-tracker/events.jsonl` in the Mission Control home folder; `mc logs 2026-10-09-habit-tracker` prints the event log
- Report generated: 2026-10-10T05:00:00.000Z

| Feature | Status | Commit | Branch | Built by | Attempts |
|---|---|---|---|---|---|
| `add-habit` | done | `aaaaaaaaaa` |  | codex | 0 |
| `tick-habit` | done | `1111111111` |  | claude | 0 |

### Run notes

- The review of "Add a habit" did not finish, so it was merged after passing its checks.
