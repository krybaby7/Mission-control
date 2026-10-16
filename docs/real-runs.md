# Real runs: what a real Claude did, and what it did not show

This is a plain record of the real test runs of Mission Control. A real run uses Mission Control's own code and the real Claude Code, with a real Claude login, on a tiny throwaway app. It shows what stand-in AIs cannot: real answers, real timing and real use of the allowance.

**How it was done.** On 16 October 2026, on a cloud test machine, with Claude only. The practice app was `word-tools`, a tiny library with one function and three tests. There was no Docker, no Windows, no Codex and no real GitHub. The tester was another Claude Code session that ran every command and wrote down what happened. It wrote every plan by hand, following the leader's written rules, and queued it with `mc plan queue`. The leader itself, the chat AI, never took part. In all there were eight runs (R1 to R7, and R3b, which repeats the web page job after fixes). They made nine missions, used 88 AI calls and came to $3.95 at Mission Control's own list-price estimate. That estimate is not what a plan charges. R6 ran on the code as it stood after the fixes for R1 to R5. R7 ran the plan of R6 again, on the code with the fixes for R6. Only R5 and R6 sent work to the stand-in for GitHub.

**How to read it.** “Tried for real” means a real Claude did it in these runs. “Tested here only” means stand-in AIs and automated tests, no real run. “Not tried” means neither. What the owner should try on a PC is in [docs/owner-trial-checklist.md](owner-trial-checklist.md).

## At a glance

| Run | The job | How it was checked | AI calls | Team time | Estimate at list price | Verdict | Faults found |
|---|---|---|---|---|---|---|---|
| R1 | A shout function, through a plan | Tests | 8 | about 65 seconds | $0.41 | Worked | 4 small |
| R2 | A usage guide, with your look | A second AI, then you | 7 | about 70 seconds | $0.26 | Worked with issues | 5 small |
| R3 | A landing page, done two ways | A second AI; a second AI, then you | 16 (8 and 8) | about 2 minutes for the first | $0.82 ($0.42 and $0.40) | Worked with issues | 8, two of them major |
| R3b | The landing page again, after the fixes | A second AI | 8 | about 90 seconds | $0.52 | Worked with issues | 4 small |
| R4 | A script and a table, sent back once | Tests; then a second AI and you | 15 | about 3 minutes | $0.59 | Worked with issues | 7, two of them major |
| R5 | Sending work to GitHub, with stand-ins | Tests | 8 | about 80 seconds | $0.24 | Worked | 4 small |
| R6 | A function and a notes file, sent back once, then sent to GitHub (stand-ins) | Tests; then a second AI and you | 13 | about 2 minutes | $0.70 | Worked with issues | 6, two of them major |
| R7 | The plan of R6 again, after the fixes for R6 | Tests; then a second AI and you | 13 | about 2 minutes | $0.41 | Worked | 2 small |

40 faults were found. Six were major. None stopped a job. In every job the main result was right. In R3b, R4 and R6 the builder also changed or made files that nobody asked for. In R7, on the same plan as R6, it did not.

**Allowance.** The weekly reading was 23 percent before R1 and 31 percent after R7. Over R1 to R3 it rose from 23 to 24, over R3b to R5 from 26 to 27, and over R6 from 30 to 31. Over R7 it did not move (31 to 31). Between R3 and R3b it rose by 2 more, and between R5 and R6 by 3 more, but no run of this record was made in between, so other use of the same account must account for it. The five-hour reading, the shorter window, rose by about 1 point over R6 (33 to 34) and over R7 (41 to 42). The reading shows whole percents only, so no single job can be told from zero. On the test account, whose plan size is not known, a small job moved the reading by 1 percent or less. On a smaller plan the same job is a bigger share.

## R1: a code job through a plan

- **The job.** In `word-tools`, add `shout(text)`: it turns the text to upper case and adds an exclamation mark. One feature, checked by tests. A plan of five checks with real values.
- **What the team did.** 8 AI calls in about 65 seconds, $0.41: a first look at the app, a check of the plan, tests written first, a helper that gathers context, the build, a review of the feature, a final review and a helper that writes the report text. It stopped at the plan after 20 seconds. After the approval it finished in 45 seconds. No rework.
- **What you would have seen.** Queuing the same plan a second time was refused: `This plan is already queued as “Shout function” (2026-10-16-shout-function). See it with: mc status`. At the stop: `“Shout function” is waiting for your check (the plan). Read it: mc plan show 2026-10-16-shout-function. Then: mc approve 2026-10-16-shout-function  or  mc send-back 2026-10-16-shout-function --note "..."`. The report said `**Done** · 1 of 1 feature done`.
- **The work.** `src/shout.js`, five new tests and a section in the README. `npm test` passed all 8 tests (3 old, 5 new). `main` was not touched.
- **Verdict.** Worked.
- **Found wrong, 4 small.**
  - `plan queue` has no `--profile` option, and the instructions for the test said to use it. The instructions were wrong, not Mission Control. Fixed in docs/dev-real-run.md (the guide for developers).
  - The preview said “a different AI reviews it”, but the reviewer was another Claude session. Fixed: “a second AI reviews it”.
  - The report's notes repeated a first guess that contradicted the plan's own choice. Fixed: left out when the leader wrote the plan.
  - The guide said every report has a line `Checked:`. A plan checked only by tests has none. Fixed in the guide.
- **Not shown.** A send-back at the plan, a stop, a restart.

## R2: a writing job with a look

- **The job.** A short guide, `docs/USAGE.md`, with the parts Install and Use, mentioning `capitalize`, between 80 and 300 words. Checked by a second AI and then by you. One of its five checks was a question of taste, ending “(the CEO decides)”.
- **What the team did.** 7 AI calls in about 70 seconds, $0.26. No tests were written. A second AI judged the checks. The team stopped twice: at the plan, and at the guide.
- **What you would have seen.** At the guide: `The second AI's answers: 4 passed, 0 failed, 1 could not be judged.` The one it could not judge was the taste check, as it should. After your approval the report said `Checked: 1 feature by a second AI against your list, except 1 check it could not judge and approved by you.` That wording has changed since (see below). The lines for looking at the guide worked as written.
- **The work.** One new file, 36 lines and 152 words. Nothing in any text called the guide tested.
- **Verdict.** Worked with issues.
- **Found wrong, 5 small.**
  - The AI's honest summary of the report was thrown away, because it said “no automated tests were written” and the word “tests” was on the banned list. The footnote gave a wrong reason. Fixed.
  - The look cut the second AI's reason in the middle of a sentence. Fixed.
  - The steps for looking at a guide ended with `npm test` and never named the file. Fixed: they name the file and its Windows address. Shown to hold in R6 and R7, for a notes file.
  - A few clumsy lines in the preview and after `mc approve`. Fixed.
  - A taste check made every look read “1 check was not judged by anyone”, next to “approved by you”. Fixed: it now says “left for you”, in a clause of its own. Shown to hold in R6 and R7.
- **Not shown.** A send-back, a fix round, `light` or `deep` effort, a check that fails.

## R3: a web page with pictures

- **The job.** A one-page landing page, `site/index.html`, with a headline, three benefits and a Get started button, in one column on a phone and three on a desktop. It was done twice: checked by a second AI only, and checked by a second AI and then by you.
- **What the team did.** 8 AI calls each, $0.42 and $0.40. The team's plan reviewer asked for changes both times, so the planner rewrote the plan, which cost one more call. Two pictures were taken each time, at phone width (390 pixels) and desktop width (1280 pixels). The second AI was a Claude session. In the first mission its log shows that it opened both pictures.
- **What you would have seen.** A stop at the page, with the pictures: `The second AI's answers: 5 passed, 0 failed, 4 could not be judged.` In the first mission that stop was caused by a fault (the first one below). In the second it was by design. The report named both pictures.
- **The work.** Both pages were right. One column at phone width, three at desktop width, no sideways scrolling. The tester measured them in a browser and looked at the pictures.
- **Verdict.** Worked with issues.
- **Found wrong, 8: two major and 6 small.**
  - **Major.** Correct answers turned into “could not be judged” whenever the second AI quoted page markup. Three passes were lost in each mission, so every page would have stopped for you. Fixed. A later real run showed it holds (R3b).
  - **Major.** The team's plan reviewer and planner rewrote the leader's checks into checks the second AI could never judge, such as “npm test still passes”, and replaced the taste check. Fixed for features checked by reading. A later real run showed it holds for the second-AI-only way, with the six checks unchanged (R3b). R6 and R7 used the way that adds your look, but the plan reviewer asked for no changes both times, so they did not test this.
  - The plan named 375 pixels but the pictures are 390. Fixed. Shown to hold in R3b.
  - In one revised plan, a line break was written as the two characters backslash and n. Fixed. R3b had no such fault, but it came and went by itself, so one clean run proves little.
  - The second AI's reasons read as holes where a page tag had been cut out. Fixed. Shown to hold in R3b.
  - The steps for looking at a page never said to open `site/index.html`. Fixed. R3b's final report names the file. The look at a stop was not seen again for a page. R6 and R7 showed the look naming the file for a notes file.
  - The `Checked:` line could be read as if “approved by you” were an exception. Fixed. Shown to hold in R6 and R7: the clauses are separate.
  - Long lines at the plan stop were split into separate bullets. Fixed. Shown to hold in R3b.
- **Not shown.** A page whose checks the second AI could all judge, with a look text after the fixes. A page that needs a server. Codex as the second AI.

## R3b: the web page again, after the fixes

- **The job.** The same page and the same plan as R3, in the second-AI-only way, once.
- **What the team did.** 8 AI calls in about 90 seconds, $0.52. The plan reviewer asked for one small change (name the file), and the planner made it and nothing else.
- **What you would have seen.** The six checks you wrote came through word for word. `6 passed, 0 failed, 0 could not be judged.` Only one stop: the plan. The report said `Checked: 1 feature by a second AI against your list.` and told you to open `site/index.html`.
- **The work.** Right at 320, 375, 390 and 1280 pixels, and in both pictures. The builder also added a short section to the README, which nobody had asked for.
- **Verdict.** Worked with issues.
- **Found wrong, 4 small.**
  - The plan reviewer's note was cut in the middle of a word. Fixed.
  - The AI's summary of the report was thrown away again, because it said nothing had been run in a browser. Fixed: the facts now say that pictures were taken.
  - The builder changed a file that no check named, and nobody said so. Fixed: the second AI is asked to name such files.
  - The Windows path was written twice, and two brackets stood in a row. Fixed.
  - None of these four fixes was run again.
- **Not shown.** A stop at the page after the fixes, the wording “left for you” (R6 showed it later), and a quote that really is missing (the check never had one to catch).

## R4: a script and a table, with one send-back

- **The job.** A sales file, `data/sales.csv`, with seven rows. Feature 1: a script, with tests written first, that writes `reports/totals.csv` with one row for each region. Feature 2: a file, `data/columns.csv`, that says what each column means. Feature 2 was marked for your look, and it was sent back once with the note “Make every Meaning one short sentence of at most 7 words.”
- **What the team did.** 15 AI calls in about 3 minutes, $0.59. The send-back (rework and a second look) cost 2 calls, $0.05 and 14 seconds. The builder of feature 2 first used the lightest AI, which changed no file, then a stronger one.
- **What you would have seen.** The stop at the table, the send-back, the same stop again as the second showing, then your approval. The final report said `Checked: 1 feature by tests; 1 feature by a second AI against your list and approved by you.`
- **The work.** The totals are right: East 145 and 2900.25, North 195 and 3900.50, South 110 and 2210.75. The tester added up the sales file separately and got the same numbers. The new meanings had 4, 5 and 5 words: the note was followed. Nothing checked that. The tester did.
- **Verdict.** Worked with issues.
- **Found wrong, 7: two major and 5 small.**
  - **Major, partly fixed.** The builder of feature 1 also made feature 2's file, a README section and a line in `.gitignore`. So the look “before it is added” came after the file existed, and the report said the README was not changed. Fixed in part: the look now lists files that were “already there before this feature”. R6 showed that line in a real run. **Not fixed when R4 was written:** nothing told a builder to build only its own feature. R6 showed the same fault again (see R6). After R6 the briefs of the test author and the builder say so, in a mission that has a feature checked by a second AI, and R7 showed the builder keeping to its own feature, once. It stays “fixed in part” (see the count below).
  - **Major, partly fixed.** The plan reviewer dropped one of the leader's checks (that the totals equal the sums of the sales rows), reworded six and said nothing. Fixed in part: `mc plan show` and the look now list the checks removed and added, the leader tells you, and the leader puts a script's path in the plan's contract. **Not fixed:** the plan reviewer may still reword the checks of a feature checked by tests, and nothing was changed so that the tests add up the sales file themselves. They hold the numbers as fixed text.
  - **Not fixed.** A backslash followed by n in a plan line becomes a line break, so a line meant to show those two characters reads wrongly. It is written down as a limit in [docs/work-modes.md](work-modes.md).
  - “The table has 3 to 3 rows”. Fixed: “exactly 3 rows”.
  - The look at a data file did not name the file, offered `npm test`, and said “Nothing” under Needs your decision while it waited for you. Fixed. Seen in part: R6 showed the file named but `npm test` still listed as a step (R6's fourth fault), and R7 showed the file first and `npm test` only as an extra. Nobody looked at the line under Needs your decision.
  - The second showing did not repeat your note. Fixed: it repeats the note and says that nothing checks that it was followed. Shown to hold in R6 and R7.
  - Long text at the plan stop was cut or split badly. Fixed.
  - Apart from the three shown above (the second showing, the look in part, the list of files already there), none of the fixes for these faults was run again.
- **Not shown.** A second send-back, a send-back at the plan, a cell that starts like a formula, a spreadsheet file, `deep` effort.

## R5: sending work to GitHub, with stand-ins

- **The job.** `mc get acme/word-tools` from a folder that stood in for GitHub. A job on the copy: a function `countWords`, checked by tests. Then `mc publish-preview` and `mc publish --to acme/word-tools`, and a set of refusals. A fake `gh` and a fake `docker` stood in for the two programs the PC does not have here.
- **What the team did.** 8 AI calls in about 80 seconds, $0.24. No rework. 11 tests passed.
- **What you would have seen.** `mc-docker: mc/2026-10-16-count-words is now on github.com/acme/word-tools. The base branch "main" was not changed.` and `mc-docker: draft pull request: https://github.com/acme/word-tools/pull/1`. The draft's text said what was checked: tests written before the code, a separate reviewer, and the stops you answered, with “Mission Control records each answer. It cannot tell what the owner looked at.”
- **What the stand-in GitHub held afterwards.** Only the branch `mc/<mission>`. `main` was as before. The upload was one plain push, with no force. The fake `gh` was called once, with `--draft`. The call that starts the small read-only box carried no token. A fake Docker recorded it, and no real box ran. Git never ran inside the app's folder.
- **The refusals.** A mission that was not done, a wrong `--to`, an app folder whose GitHub address had been changed to another repository, an address that was not github.com, a missing `--to` and an unknown mission were all refused with a plain sentence, and nothing was uploaded.
- **Verdict.** Worked.
- **Found wrong, 4 small.** The draft's text cut a long line in the middle of a word and lost the reviewers' open notes. It pointed to a `report.md` that a reader on GitHub cannot open. A refusal showed the raw word “stopped”. It said “1 of 1 finished features”. All four fixed. R6 ran the draft again: the line cut at the end of a sentence and the pointer to `mc report` held. The line about open review notes was there but missed a note (R6's fifth fault, now fixed and not run again). The refusal and the singular were not run again.
- **Not shown.** A real GitHub, the real `gh`, a real Docker, Windows. A running container's limits (no network, read only) were checked only as the arguments of the call.

## R6: a function and a notes file, then GitHub with stand-ins

- **The job.** A plan of two features for `word-tools`, written by hand the way the leader writes one. Feature 1: `wordCount(text)`, checked by tests. Feature 2: a short notes file, `docs/NOTES.md`, with a Purpose part and a Limits part, marked for your look. One of its four checks was a question of taste, ending “(the CEO decides)”. The plan also had two contract lines that name the notes file and its two headings. Afterwards the finished mission was sent to the stand-in for GitHub, as in R5. R6 was meant as the last smoke run on the code as it stood then.
- **What the team did.** 13 AI calls in about 2 minutes (136 seconds, in four runs), $0.70. The plan reviewer asked for no changes. The team stopped three times: at the plan, at the notes file, and at the notes file again after one send-back. The note was “The Purpose part must be one sentence.” The send-back cost 2 calls, a fix and a second look.
- **What you would have seen.** At the notes file: `The second AI's answers: 3 passed, 0 failed, 1 left for you.` The look named `docs/NOTES.md` and its Windows address. At the second showing: `Your note: “The Purpose part must be one sentence.”` and `It was changed after your note and checked again by a second AI. Nothing checks that your note was followed, so please look.` The finished report said `Checked: 1 feature by tests; 1 feature by a second AI against your list; 1 check left for you; approved by you.` The look also listed `docs/NOTES.md` under “Changed, but already there before this feature”. That line was true, and it points at the first fault below.
- **What the stand-in GitHub held afterwards.** Only the branch `mc/2026-10-16-word-count-and-notes`. `main` was as before. The upload was one plain push, with no force. The fake `gh` was called once, with `--draft`. The call that starts the small read-only box carried no token. Git never ran inside the app's folder. The draft's text copied the report's summary up to the end of a sentence and said that the whole report is in Mission Control on the owner's PC: `mc report 2026-10-16-word-count-and-notes`.
- **The work.** The function was right. The tester tried five texts by hand and got 1, 4, 2, 0 and 0 words, and a number was refused with an error. The notes file had a one-sentence Purpose part and 92 words, inside the 60 to 200 asked for. `npm test` passed 12 tests: 3 old, 7 for the function and 2 for the headings of the notes file. Nobody had asked for those last two (see the first fault).
- **Verdict.** Worked with issues.
- **Found wrong, 6: two major and 4 small.**
  - **Major.** A builder did the next feature's work again, this time two roles. The test author of feature 1 wrote a test that `docs/NOTES.md` exists with a Purpose and a Limits heading. The builder of feature 1 then made the file to pass that test. The notes feature only rewrote the file. So the owner's app kept a test that nobody asked for, and the first version of the notes was written with no stop for you and no second AI. The look said “already there before this feature” and did not say why. The likely cause (the tester's reading of the code, not something in the logs): the plan's contract lines name the notes file for the whole plan, and the brief of feature 1 did not say that they may be about another feature. Fixed after the run: the briefs of the test author and the builder now say to keep to their own feature, and the look and the report say when a feature made a file that a later feature's checks name. The leader's rules now say that a feature checked by a second AI needs no contract line for its file. R7 showed it holds, once.
  - **Major.** The summary at the top of the finished report said “The word counting feature has no record of how it was checked”. The line under it said `Checked: 1 feature by tests`. Likely cause (read in the code): in a mission whose other feature is checked another way, the facts given to the writer said nothing about how the tested feature was checked. Fixed: the facts now say it, and a sentence that says nobody recorded how a feature was checked is cut out. R7 showed the summary no longer says it.
  - The finished report did not name the file to open for the notes. Its “How to try it” ended with `npm test`, which does not cover the notes. Fixed: it names the file first and shows `npm test` last. R7 showed it.
  - The look listed `npm test` as the third numbered step and only then said that the project's own checks do not cover the notes. Fixed: the steps go to the version, then name the file, and `npm test` follows as an extra. R7 showed it.
  - The draft pull request said “the reviewers left none open” while the final review had left a small note in the report. Fixed: that note is counted and the line points to where the report lists it. Not run again.
  - The copy of the report in the draft ended in half a table. Fixed: the copy ends at the end of a whole section. Not run again.
- **Not shown.** A plan reviewer that changes checks (it asked for no changes, so the list of removed and added checks did not come up). The singular “1 of 1 finished feature” of the draft (two features were finished). A look that lists new files and files already there side by side. A real GitHub, the real `gh`, a real Docker. The refusals of `mc publish`, which R5 had tried on earlier code.

## R7: the plan of R6 again, after the fixes

- **The job.** The plan of R6, byte for byte, with its two contract lines about the notes file kept on purpose, because they were the likely cause of R6's first fault. It ran on the code with the fixes for R6. There was no GitHub part. The plan code was `cce315c6`, the same as in R6.
- **What the team did.** 13 AI calls, the same kinds as in R6, in about 2 minutes (139 seconds), $0.41. The plan reviewer again asked for no changes. The same three stops and the same note at the send-back.
- **What you would have seen.** The look at the notes file listed `docs/NOTES.md` under “Files that changed”, with no “already there” line. Then came the two steps that go to the version, then “Then open” with the file's name and its Windows address, and last “The project's own checks do not cover this feature. If you also want to run them, run `npm test`.” The finished report's first paragraph said `All 2 features are built. The “Checked” line and the Features table say how each was checked. The final checks of the whole app passed.` The `Checked:` line above it agreed. Its “How to try it” named the file to open and put `npm test` last.
- **The work.** `npm test` passed 11 tests: 3 old and 8 for the function. No test read the notes file. The notes file first appeared in the commit of the notes feature. The tester's hand check of the function gave 1, 4, 2, 0 and 0, and an error for a number. The notes file had 97 words and a one-sentence Purpose part.
- **Did R6's first fault come back?** No. The test author wrote: “I did not test docs/NOTES.md, because the `notes` feature owns it.” The builder wrote: “I did not create docs/NOTES.md, because it belongs to the separate `notes` feature.” Both had seen the contract lines and left the file alone. This is one run, one sample of an AI. R6 did the wrong thing once on this plan, and R7 did the right thing once on the same plan. It does not show that the fault never happens.
- **Verdict.** Worked.
- **Found wrong, 2 small.**
  - A review note of feature 1, that the notes file was missing, stayed in the finished report after the notes feature had made the file. It also marked the feature's row (“Built and checked (1 review note below)”). Nothing said that the note had been answered. The summary writer repeated it as advice to the owner, but that sentence was dropped with the rest of the summary (next point). Not fixed.
  - The AI-written summary of the finished report was thrown away by the old guard on the word “tests”, although its sentences were true (“The word counting was checked with automated tests that were written before the code.”). The report said it left the summary out because it described how the work was checked in words that Mission Control could not confirm, which is not quite the reason. So the top paragraph was Mission Control's own plain text. It was true and it agreed with the `Checked:` line, so nothing misled. Not fixed.
- **Not shown.** A plan reviewer that changes checks (it changed nothing again). A look that lists new files and files already there side by side. The GitHub half. That the fixes hold every time.

## The faults and their fixes, counted

| | How many |
|---|---|
| Faults found | 40 (6 major) |
| Fixed | 35 |
| Fixed in part | 2 (both major, from R4) |
| Not fixed | 3 (the backslash and n, written down as a limit, and the 2 small faults of R7) |
| Shown to hold by a later real run | 15 |
| Fixed, and not fully run again by a real run | 20 |

**The 15 that a later real run showed to hold.**

- R3b showed six: the quote check, the plan reviewer leaving the leader's checks alone (for the second-AI-only way), the pixel widths, the readable reasons, the file to open (in the final report only), and the split lines at the plan stop.
- R6 and R7 showed five more of the earlier fixes: the look names the file and its Windows address (from R2), “left for you” as a clause of its own (from R2), the separate clauses of the `Checked:` line (from R3), the repeated note at the second showing (from R4), and the draft's pointer to `mc report` (from R5, R6 only).
- R7 showed four of the fixes made after R6, each once: the test author and the builder keeping to their own feature, a finished report that no longer says the tested feature has no record of how it was checked, the file to open coming first in the finished report, and the file to open coming first in the look.

**The 20 that were not fully run again.** Two are changes to documents. Two were seen in part: R4's fix for the look at a data file (the file was named in R6 and R7, and `npm test` was only an extra in R7, but nobody looked at the line under “Needs your decision”), and R5's fix for the draft's text (R6 showed lines cut at the end of a sentence, but its count of open review notes missed one; the new count was not run again). The other 16 were tested here only: R6's fifth and sixth faults, and the fixes for faults of R1 to R5 that no later run touched.

**The 2 fixed in part, both from R4.** The first is the plan reviewer changing checks: `mc plan show` and the look list what it removed and added, but it may still reword the checks of a feature checked by tests, and no real run has shown that list since it was built. The second is a builder doing the next feature's work: the look lists a file that was already there, and since R6 the briefs and a warning exist, but only in a mission that has a feature checked by a second AI (see “What no real run could show”).

**The 3 not fixed.** The backslash and n becoming a line break is written down as a limit. R7's two small faults (a review note that stays open after a later feature answered it, and the written summary being left out of a finished report when it says something true about tests) are described under R7 and are listed in [docs/work-modes.md](work-modes.md) under the limits.

## What no real run could show

- **Windows, WSL, Docker Desktop.** Every run was on a Linux cloud machine, without Docker. So `mc copy-reports`, `mc shell`, the shortcuts, File Explorer addresses, the iPad and ntfy were never tried. Neither were the limits that the Docker script puts on the box.
- **A real GitHub and the real `gh`.** R5 and R6 used a folder, a fake `gh` and a fake `docker`.
- **Codex.** Every run used Claude only. The usual team (Claude plans and reviews, Codex builds), a second AI from the other company, and Codex looking at pictures were never run.
- **The leader writing a plan, and the Claude Code prompts.** The tester wrote every plan by hand. The leader never chatted, asked its questions, or met a permission prompt in a run.
- **A builder doing the next feature's work, in every case.** R4 and R6 showed it, and R7 showed it not happening on the plan of R6. That is one run on one plan, one sample of an AI. The briefs that now tell the test author and the builder to keep to their own feature, and the warning in the look, exist only in a mission that has a feature checked by a second AI. Every real mission with more than one feature (R4, R6, R7) had one feature checked by tests and one checked by a second AI. No real run had two features that are both checked by tests, and no real run has shown whether a builder there stays in its own feature. The warning covers only a file that the feature newly added and that a later feature's checks name. A line added to a README that nobody asked for is not covered.
- **A plan reviewer that changes checks, since the lists of changed checks were built.** In R6 and R7 it asked for no changes, so the lists of what it removed and added never came up in a real run.
- **A look that lists new files and files already there side by side.** Only one of the two lists has come up in a real run so far.
- **A review note that a later feature answers.** In R7 it stayed open in the finished report. Nothing was changed for this yet.
- **Recovery after a restart.** No run was interrupted. The cloud machine is restarted from time to time. The runs lasted one to three minutes, and no restart hit a run. Continuing after a planned stop (`mc run --mission` after `mc approve`) worked every time. That is not a crash.
- **A quote that is really missing.** No made-up quote was seen in these runs. The fixed check was tried on recorded answers only, so a made-up quote turning a pass into “not judged” was not seen for real.
- **A fix round after a failed check.** The second AI never failed a check, and every tests-first feature passed on the first try. One of Mission Control's own checks failed once (R4: the lightest AI changed no file), and a stronger AI tried again. That was the only climb to a stronger AI. The only rework was a send-back by the owner: R4's, and one in each of R6 and R7.
- **Limits and big jobs.** The pause at 85 percent of the week, a wait for a usage limit, a new app built from nothing, an app bigger than three tests, more than two features, `deep` effort, and a folder that holds only documents.
- **The dashboard.** It was not looked at during a real run.
- **How good the second AI is as a judge.** Its answers were right in the cases the tester checked. Nobody measured how often it is wrong.

## Measured costs

The calls, time and list-price estimate of each run are in the table at the top. The figures set against the earlier guesses are in [docs/modes-spec.md](modes-spec.md), section 3.1. In short: a feature checked by tests used 4 calls, one checked by a second AI used 3, a send-back used 2 more, and a whole one-feature job used 7 or 8 calls. A two-feature job with one send-back used 13 calls both times (R6 and R7), $0.70 in R6 and $0.41 in R7. The same plan and the same kinds of calls came to two different prices, and the reports do not say why. The plan reviewer asked for changes to the leader's plan in 4 of 9 plans, and each time the planner's rewrite cost one more call ($0.06 to $0.11).

## Where the evidence is

Parts of the real answers are kept as test files: `test/fixtures/modes/real-r3/` (the second AI's answers and the two pages from R3), `test/fixtures/modes/real-r45/` (the plan and the plan reviewer's answers from R3b and R4) and `test/fixtures/publish/real-r5-report.md` and `test/fixtures/publish/real-r6-report.md` (the reports behind R5's and R6's drafts). The full output of every command, the mission records and the usage ledgers were saved on the cloud test machine's scratch disk. They are not in this repository.
