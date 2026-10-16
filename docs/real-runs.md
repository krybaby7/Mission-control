# Real runs: what a real Claude did, and what it did not show

This is a plain record of the real test runs of Mission Control. A real run uses the real engine and the real Claude Code, with a real Claude login, on a tiny throwaway app. It shows what stand-in AIs cannot: real answers, real timing and real use of the allowance.

**How it was done.** On 16 October 2026, on a cloud test machine, with Claude only. The practice app was `word-tools`, a tiny library with one function and three tests. There was no Docker, no Windows, no Codex and no real GitHub. The tester was another Claude Code session that ran every command and wrote down what happened. It wrote every plan by hand, following the leader's written rules, and queued it with `mc plan queue`. The leader itself, the chat AI, never took part. In all there were six runs (R1 to R5, and R3b, which repeats the web page job after fixes). They made seven missions, used 62 AI calls and came to $2.84 at the engine's own list-price estimate. (The engine is the part of Mission Control that runs the team.) That estimate is not what a plan charges.

**How to read it.** “Tried for real” means a real Claude did it in these runs. “Tested here only” means stand-in AIs and automated tests, no real run. “Not tried” means neither. What the owner should try on a PC is in [docs/owner-trial-checklist.md](owner-trial-checklist.md).

## At a glance

| Run | The job | How it was checked | AI calls | Team time | Engine's estimate | Verdict | Faults found |
|---|---|---|---|---|---|---|---|
| R1 | A shout function, through a plan | Tests | 8 | about 65 seconds | $0.41 | Worked | 4 small |
| R2 | A usage guide, with your look | A second AI, then you | 7 | about 70 seconds | $0.26 | Worked with small issues | 5 small |
| R3 | A landing page, done two ways | A second AI; a second AI, then you | 16 (8 and 8) | about 2 minutes for the first | $0.82 ($0.42 and $0.40) | Worked with issues | 8, two of them major |
| R3b | The landing page again, after the fixes | A second AI | 8 | about 90 seconds | $0.52 | Worked with small issues | 4 small |
| R4 | A script and a table, sent back once | Tests; then a second AI and you | 15 | about 3 minutes | $0.59 | Worked with issues | 7, two of them major |
| R5 | Sending work to GitHub, with stand-ins | Tests | 8 | about 80 seconds | $0.24 | Worked | 4 small |

32 faults were found. Four were major. None stopped a job. In every job the tester found the work correct.

**Allowance.** The weekly reading was 23 percent before R1 and 27 percent after R5. Over R1 to R3 it rose from 23 to 24, and over R3b to R5 from 26 to 27. Between R3 and R3b it rose by 2 more, but no run was made in between, so other use of the same account must account for it. The reading shows whole percents only, so no single job can be told from zero. A small job used about 1 percent of one week or less.

## R1: a code job through a plan

- **The job.** In `word-tools`, add `shout(text)`: it turns the text to upper case and adds an exclamation mark. One feature, checked by tests. A plan of five checks with real values.
- **What the team did.** 8 AI calls in about 65 seconds, $0.41: a first look at the app, a check of the plan, tests written first, a helper that gathers context, the build, a review of the feature, a final review and a helper that writes the report text. It stopped at the plan after 20 seconds. After the approval it finished in 45 seconds. No rework.
- **What you would have seen.** Queuing the same plan a second time was refused: `This plan is already queued as “Shout function” (2026-10-16-shout-function). See it with: mc status`. At the stop: `“Shout function” is waiting for your check (the plan). Read it: mc plan show 2026-10-16-shout-function. Then: mc approve 2026-10-16-shout-function  or  mc send-back 2026-10-16-shout-function --note "..."`. The report said `**Done** · 1 of 1 feature done`.
- **The work.** `src/shout.js`, five new tests and a section in the README. `npm test` passed all 8 tests (3 old, 5 new). `main` was not touched.
- **Verdict.** Worked.
- **Found wrong, 4 small.**
  - `plan queue` has no `--profile` option, and the instructions for the test said to use it. The instructions were wrong, not the engine. Fixed in the developer guide.
  - The preview said “a different AI reviews it”, but the reviewer was another Claude session. Fixed: “a second AI reviews it”.
  - The report's notes repeated a first guess that contradicted the plan's own choice. Fixed: left out when the leader wrote the plan.
  - The guide said every report has a line `Checked:`. A plan checked only by tests has none. Fixed in the guide.
- **Not shown.** A send-back at the plan, a stop, a restart.

## R2: a writing job with a look

- **The job.** A short guide, `docs/USAGE.md`, with the parts Install and Use, mentioning `capitalize`, between 80 and 300 words. Checked by a second AI and then by you. One of its five checks was a question of taste, ending “(the CEO decides)”.
- **What the team did.** 7 AI calls in about 70 seconds, $0.26. No tests were written. A second AI judged the checks. The team stopped twice: at the plan, and at the guide.
- **What you would have seen.** At the guide: `The second AI's answers: 4 passed, 0 failed, 1 could not be judged.` The one it could not judge was the taste check, as it should. After your approval the report said `Checked: 1 feature by a second AI against your list, except 1 check it could not judge and approved by you.` That wording has changed since (see below). The lines for looking at the guide worked as written.
- **The work.** One new file, 36 lines and 152 words. Nothing in any text called the guide tested.
- **Verdict.** Worked with small issues.
- **Found wrong, 5 small.**
  - The AI's honest summary of the report was thrown away, because it said “no automated tests were written” and the word “tests” was on the banned list. The footnote gave a wrong reason. Fixed.
  - The look cut the second AI's reason in the middle of a sentence. Fixed.
  - The steps for looking at a guide ended with `npm test` and never named the file. Fixed: they name the file and its Windows address.
  - A few clumsy lines in the preview and after `mc approve`. Fixed.
  - A taste check made every look read “1 check was not judged by anyone”, next to “approved by you”. Fixed: it now says “left for you”, in a clause of its own.
- **Not shown.** A send-back, a fix round, `light` or `deep` effort, a check that fails.

## R3: a web page with pictures

- **The job.** A one-page landing page, `site/index.html`, with a headline, three benefits and a Get started button, in one column on a phone and three on a desktop. It was done twice: checked by a second AI only, and checked by a second AI and then by you.
- **What the team did.** 8 AI calls each, $0.42 and $0.40. The team's plan reviewer asked for changes both times, so the planner rewrote the plan, which cost one more call. Two pictures were taken each time, at phone width (390 pixels) and desktop width (1280 pixels). The second AI was a Claude session. In the first mission its log shows that it opened both pictures.
- **What you would have seen.** A stop at the page, with the pictures: `The second AI's answers: 5 passed, 0 failed, 4 could not be judged.` In the first mission that stop was caused by a fault (the first one below). In the second it was by design. The report named both pictures.
- **The work.** Both pages were right. One column at phone width, three at desktop width, no sideways scrolling. The tester measured them in a browser and looked at the pictures.
- **Verdict.** Worked with issues.
- **Found wrong, 8: two major and 6 small.**
  - **Major.** Correct answers turned into “could not be judged” whenever the second AI quoted page markup. Three passes were lost in each mission, so every page would have stopped for you. Fixed. A later real run showed it holds (R3b).
  - **Major.** The team's plan reviewer and planner rewrote the leader's checks into checks the second AI could never judge, such as “npm test still passes”, and replaced the taste check. Fixed for features checked by reading. A later real run showed it holds for the second-AI-only way, with the six checks unchanged (R3b). It was not run again for the way that adds your look.
  - The plan named 375 pixels but the pictures are 390. Fixed. Shown to hold in R3b.
  - In one revised plan, a line break was written as the two characters backslash and n. Fixed. R3b had no such fault, but it came and went by itself, so one clean run proves little.
  - The second AI's reasons read as holes where a page tag had been cut out. Fixed. Shown to hold in R3b.
  - The steps for looking at a page never said to open `site/index.html`. Fixed. R3b's final report names the file. The look at a stop was not seen again.
  - The `Checked:` line could be read as if “approved by you” were an exception. Fixed. Not run again.
  - Long lines at the plan stop were split into separate bullets. Fixed. Shown to hold in R3b.
- **Not shown.** A page whose checks the second AI could all judge, with a look text after the fixes. A page that needs a server. Codex as the second AI.

## R3b: the web page again, after the fixes

- **The job.** The same page and the same plan as R3, in the second-AI-only way, once.
- **What the team did.** 8 AI calls in about 90 seconds, $0.52. The plan reviewer asked for one small change (name the file), and the planner made it and nothing else.
- **What you would have seen.** The six checks you wrote came through word for word. `6 passed, 0 failed, 0 could not be judged.` Only one stop: the plan. The report said `Checked: 1 feature by a second AI against your list.` and told you to open `site/index.html`.
- **The work.** Right at 320, 375, 390 and 1280 pixels, and in both pictures. The builder also added a short section to the README, which nobody had asked for.
- **Verdict.** Worked with small issues.
- **Found wrong, 4 small.**
  - The plan reviewer's note was cut in the middle of a word. Fixed.
  - The AI's summary of the report was thrown away again, because it said nothing had been run in a browser. Fixed: the facts now say that pictures were taken.
  - The builder changed a file that no check named, and nobody said so. Fixed: the second AI is asked to name such files.
  - The Windows path was written twice, and two brackets stood in a row. Fixed.
  - None of these four fixes was run again.
- **Not shown.** A stop at the page after the fixes, the wording “left for you”, and a quote that really is missing (the check never had one to catch).

## R4: a script and a table, with one send-back

- **The job.** A sales file, `data/sales.csv`, with seven rows. Feature 1: a script, with tests written first, that writes `reports/totals.csv` with one row for each region. Feature 2: a file, `data/columns.csv`, that says what each column means. Feature 2 was marked for your look, and it was sent back once with the note “Make every Meaning at most 7 words.”
- **What the team did.** 15 AI calls in about 3 minutes, $0.59. The send-back (rework and a second look) cost 2 calls, $0.05 and 14 seconds. The builder of feature 2 first used the lightest AI, which changed no file, then a stronger one.
- **What you would have seen.** The stop at the table, the send-back, the same stop again as the second showing, then your approval. The final report said `Checked: 1 feature by tests; 1 feature by a second AI against your list and approved by you.`
- **The work.** The totals are right: East 145 and 2900.25, North 195 and 3900.50, South 110 and 2210.75. The tester added up the sales file separately and got the same numbers. The new meanings had 4, 5 and 5 words: the note was followed. Nothing checked that. The tester did.
- **Verdict.** Worked with issues.
- **Found wrong, 7: two major and 5 small.**
  - **Major, partly fixed.** The builder of feature 1 also made feature 2's file, a README section and a line in `.gitignore`. So the look “before it is added” came after the file existed, and the report said the README was not changed. Fixed in part: the look now lists files that were “already there before this feature”. **Not fixed:** nothing tells a builder to build only its own feature.
  - **Major, partly fixed.** The plan reviewer dropped one of the leader's checks (that the totals equal the sums of the sales rows), reworded six and said nothing. Fixed in part: `mc plan show` and the look now list the checks removed and added, the leader tells you, and the leader puts a script's path in the plan's contract. **Not fixed:** the plan reviewer may still reword the checks of a feature checked by tests, and nothing was changed so that the tests add up the sales file themselves. They hold the numbers as fixed text.
  - **Not fixed.** A backslash followed by n in a plan line becomes a line break, so a line meant to show those two characters reads wrongly. It is written down as a limit in [docs/work-modes.md](work-modes.md).
  - “The table has 3 to 3 rows”. Fixed: “exactly 3 rows”.
  - The look at a data file did not name the file, offered `npm test`, and said “Nothing” under Needs your decision while it waited for you. Fixed.
  - The second showing did not repeat your note. Fixed: it repeats the note and says that nothing checks that it was followed.
  - Long text at the plan stop was cut or split badly. Fixed.
  - None of the fixes for these faults was run again.
- **Not shown.** A second send-back, a send-back at the plan, a cell that starts like a formula, a spreadsheet file, `deep` effort.

## R5: sending work to GitHub, with stand-ins

- **The job.** `mc get acme/word-tools` from a folder that stood in for GitHub. A job on the copy: a function `countWords`, checked by tests. Then `mc publish-preview` and `mc publish --to acme/word-tools`, and a set of refusals. A fake `gh` and a fake `docker` stood in for the two programs the PC does not have here.
- **What the team did.** 8 AI calls in about 80 seconds, $0.24. No rework. 11 tests passed.
- **What you would have seen.** `mc-docker: mc/2026-10-16-count-words is now on github.com/acme/word-tools. The base branch "main" was not changed.` and `mc-docker: draft pull request: https://github.com/acme/word-tools/pull/1`. The draft's text said what was checked: tests written before the code, a separate reviewer, and the stops you answered, with “Mission Control records each answer. It cannot tell what the owner looked at.”
- **What the stand-in GitHub held afterwards.** Only the branch `mc/<mission>`. `main` was as before. The upload was one plain push, with no force. The fake `gh` was called once, with `--draft`. No token reached the container. Git never ran inside the app's folder.
- **The refusals.** A mission that was not done, a wrong `--to`, an app folder whose GitHub address had been changed to another repository, an address that was not github.com, a missing `--to` and an unknown mission were all refused with a plain sentence, and nothing was uploaded.
- **Verdict.** Worked.
- **Found wrong, 4 small.** The draft's text cut a long line in the middle of a word and lost the reviewers' open notes. It pointed to a `report.md` that a reader on GitHub cannot open. A refusal showed the raw word “stopped”. It said “1 of 1 finished features”. All four fixed. None run again.
- **Not shown.** A real GitHub, the real `gh`, a real Docker, Windows. A running container's limits (no network, read only) were checked only as the arguments of the call.

## The faults and their fixes, counted

| | How many |
|---|---|
| Faults found | 32 (4 major) |
| Fixed | 29 |
| Fixed in part | 2 (both major, from R4) |
| Not fixed | 1 (the backslash and n, written down as a limit) |
| Shown to hold by a later real run | 6 |
| Fixed, and **not run again by a real run** | 23 |

The six shown to hold by R3b are the quote check, the plan reviewer leaving the leader's checks alone (for the second-AI-only way), the pixel widths, the readable reasons, the file to open (in the final report only), and the split lines at the plan stop. **The other 23 fixes were not run again by a real run.** Two of them are changes to documents. The other 21 were tested here only. Every fix for a fault found in R3b, R4 or R5 belongs to those 23, or is one of the three that are not fully fixed, because no real run was made after them.

## What no real run could show

- **Windows, WSL, Docker Desktop.** Every run was on a Linux cloud machine, without Docker. So `mc copy-reports`, `mc shell`, the shortcuts, File Explorer addresses, the iPad and ntfy were never tried. Neither were the limits that the Docker script puts on the box.
- **A real GitHub and the real `gh`.** R5 used a folder, a fake `gh` and a fake `docker`.
- **Codex.** Every run used Claude only. The usual team (Claude plans and reviews, Codex builds), a second AI from the other company, and Codex looking at pictures were never run.
- **The leader writing a plan, and the Claude Code prompts.** The tester wrote every plan by hand. The leader never chatted, asked its questions, or met a permission prompt in a run.
- **Recovery after a restart.** No run was interrupted. The cloud machine restarts about every 25 minutes, and the runs lasted one to three minutes, so none was hit. Continuing after a planned stop (`mc run --mission` after `mc approve`) worked every time. That is not a crash.
- **A quote that is really missing.** No made-up quote was seen in these runs. The fixed check was tried on recorded answers only, so a made-up quote turning a pass into “not judged” was not seen for real.
- **A fix round after a failed check.** No real check failed. The second AI never failed a check, and every tests-first feature passed on the first try. The only rework was R4's send-back. The only climb to a stronger AI was R4's first try by the lightest one.
- **Limits and big jobs.** The pause at 85 percent of the week, a wait for a usage limit, a new app built from nothing, an app bigger than three tests, more than two features, `deep` effort, and a folder that holds only documents.
- **The dashboard.** It was not looked at during a real run.
- **How good the second AI is as a judge.** Its answers were right in the cases the tester checked. Nobody measured how often it is wrong.

## Measured costs

The calls, time and list-price estimate of each run are in the table at the top. The figures set against the earlier guesses are in [docs/modes-spec.md](modes-spec.md), section 3.1. In short: a feature checked by tests used 4 calls, one checked by a second AI used 3, and a whole one-feature job used 7 or 8 calls. The plan reviewer asked for changes to the leader's plan in 4 of 7 plans, and each time the planner's rewrite cost one more call ($0.06 to $0.11).

## Where the evidence is

Parts of the real answers are kept as test files: `test/fixtures/modes/real-r3/` (the second AI's answers and the two pages from R3), `test/fixtures/modes/real-r45/` (the plan and the plan reviewer's answers from R3b and R4) and `test/fixtures/publish/real-r5-report.md` (the report behind R5's draft). The full output of every command, the mission records and the usage ledgers were saved on the cloud test machine's scratch disk. They are not in this repository.
