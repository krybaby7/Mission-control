# Count words

**Done** · 1 of 1 feature done · report written 2026-10-16 03:23

Plan: written by the leader (plan code 657f9ae6); the team's plan reviewer asked for no changes.

The word-tools library now has a countWords function, placed next to the existing capitalize function, that tells you how many words a piece of text contains. Words are separated by spaces, and a run of several spaces counts as one separator, so extra spacing doesn't inflate the count. Empty text, or text made only of spaces, counts as zero words. If you pass in something that isn't text, the function refuses it with an error, the same way capitalize does. The one planned feature is finished, with nothing blocked or skipped. Review noted two minor points that don't stop it from working. The library's documentation has no entry for the new function yet, so readers won't find it there. Also, only plain spaces separate words, so text split by line breaks or tabs counts as one word. That follows your request exactly, but it's worth knowing about. Nothing needs a decision from you right now.

## What you can do now

- Call countWords with any piece of text to find out how many words it has.
- Get a count where words are separated by spaces, and extra spaces between words don't add to the count.
- Get zero back for empty text or text made only of spaces.
- Get an error if you pass in something that isn't text, the same way capitalize behaves.
- Use countWords alongside capitalize, since both come from the same word-tools library.

## How to try it

The app is in your folder `~/mc-apps/word-tools` (in Windows File Explorer: `\\wsl.localhost\Ubuntu\home\<your Ubuntu name>\mc-apps\word-tools`).

In the Ubuntu window, run `mc shell` first: it opens a terminal inside Mission Control's container, which has everything the app needs. Then run these one at a time:

1. `cd ~/mc-apps/word-tools`: go to the app's folder
2. `git checkout mc/2026-10-16-count-words`: switch to the version with the new work
3. `npm test`: run the project's own checks

Then start your app the way you usually do.

When you're done, put the folder back on your own version with `git checkout main` and type `exit`.

## Needs your decision

Nothing. You don't need to do anything.

## Features

|  | Feature | What happened |
|---|---|---|
| ✅ | Count words | Built and checked (2 review notes below) |

## Your checks

| What you checked | Your answer | When | Your note |
|---|---|---|---|
| The plan | Approved | 2026-10-16 03:22 |  |

## Choices I made for you

- Text that is empty, or only spaces, has zero words.
- A value that is not a text is refused with a TypeError, the same way capitalize refuses it.

## Review notes

- **Count words** · Small: The README has a section for each public helper (`## capitalize(word)`), but this change adds no matching `## countWords(text)` section. Users reading the README won't learn that the new export exists or that it splits only on spaces. (in `README.md`)
- **Count words** · Small: countWords splits only on the space character, as the request says. Tabs and newlines are therefore not separators, so countWords("hello\nworld") returns 1. This matches the spec, but the behaviour may surprise users and isn't documented or tested. (in `src/count-words.js`) Suggested check: assert.equal(countWords("hello\tworld"), 1) to pin down the space-only behaviour (or 2 if the owner decides other whitespace should count).

## Usage

8 agent runs, about 1 min of agent time.

| Model | Tool | Runs | Input tokens | Output tokens | Est. cost |
|---|---|---|---|---|---|
| claude-opus-5-5 | Claude Code | 4 | 18 | 2,603 | $0.16 |
| claude-haiku-5-5 | Claude Code | 2 | 4 | 2,043 | <$0.01 |
| claude-sonnet-5-5 | Claude Code | 2 | 12 | 2,155 | $0.08 |
| **Total** |  | 8 | 34 | 6,801 | $0.24 |

_Est. cost is the list price the tools report, not what your subscription charges._

## Technical details

- Mission id: `2026-10-16-count-words` (feature, profile `claude`)
- Repository: `/root/mc-apps/word-tools`
- Started from: `main` at `c0d510e47d`
- Integration branch: `mc/2026-10-16-count-words`
- Full check: `npm test` · test files: `node --test {files}`
- Stage: finalize · status: done · agent runs: 8 · gate C rounds: 0
- Logs: `missions/2026-10-16-count-words/logs/` and `missions/2026-10-16-count-words/events.jsonl` in the Mission Control home folder; `mc logs 2026-10-16-count-words` prints the event log
- Report generated: 2026-10-16T03:23:32.865Z

| Feature | Status | Commit | Branch | Built by | Attempts |
|---|---|---|---|---|---|
| `count-words` | done | `d7181fdeee` |  | claude | 1 |

### Run notes

- Stack: word-tools is a tiny plain-JavaScript ES-module library ("type": "module") with no dependencies and no build step. Its source lives in src/: each helper has its own file (src/capitalize.js), src/index.js re-exports them, and package.json "main" points at src/index.js. Tests use Node's built-in runner (node:test with node:assert/strict). Each test file sits next to its source as src/<name>.test.js and imports from "./index.js". `npm test` runs `node --test`, which finds *.test.js files on its own. There is no linter, formatter, typecheck or e2e suite.
