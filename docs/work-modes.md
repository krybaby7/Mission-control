# Documents, pages and data: how the team checks work that has no tests

This is the owner's guide to a part of Mission Control that is new: work that is not code. Before this, a feature was done when its tests passed. A guide, a page or a table has no tests, so a plan can now say how each feature is checked, and how hard the team thinks about it. The design is in [docs/modes-spec.md](modes-spec.md). This page says what it means for you, in plain words.

**Status, said plainly.** This was built and tested with stand-in AIs. Then a real Claude did a few small test jobs in these ways on a cloud test machine: a guide with your look, a web page with pictures, a table with one send-back, and a function with a notes file for your look, sent back once (this last job twice, the second time after fixes). A tester wrote each plan by hand, following the leader's rules. The leader itself has never run. Each job used between 7 and 15 AI calls. On the test account (its plan size is not known) each moved the weekly reading by 1 percent or less. The eight real runs found 40 faults in all, and 6 were serious. Three of the six were about checks that were judged wrongly or changed by the team's plan reviewer. Two were a builder doing the work of the next feature. One was a finished report whose first paragraph said that a feature had no record of how it was checked. Most faults were fixed. Five are not fully fixed (see [docs/real-runs.md](real-runs.md)). Fifteen of the 35 fixes were seen to hold in a later real run, and most of the rest were tested here only. The last two runs used the same plan. In the second, after the fixes, the builder did not do the next feature's work. That is one run, so it does not show that it never happens. Nothing has been tried on a Windows PC, nothing has been tried against a real GitHub, and the other company's AI (Codex) has never done a job. The words below say what the code does. They do not say that the second AI is a good judge, because nobody has measured that.

**One limit to know before you start.** A job of writing, a page or a table needs an app that has code and its own checks: an app Mission Control built, or a project you took with `mc get`. A folder that holds only documents can fail at the start or finish with a hollow report. The details are under “The limits” at the end.

## The three ways a feature is checked

Every feature of a plan has a way of being checked. The leader chooses it for you and tells you in plain words, one line for each feature, before anything is queued.

| Way | The plan says | Who checks it | What you see |
|---|---|---|---|
| By tests | nothing (this is the usual way) | The team writes tests first, then builds until they pass. Another AI reviews the result. | “Checked by tests.” |
| By a second AI | `mode: review` | The team builds it. Mission Control's own checks run first (see below). Then a second AI reads the result and judges each check on your list as passed, failed or not judged, with a reason. No tests are written. | “Checked by a second AI against your list.” |
| By a second AI, and then by you | `mode: owner` | The same, and then the team stops so that you look at it before it is added. | “Checked by a second AI against your list and approved by you.” |

The leader uses the way that fits the job. Code, a script and numbers that a script works out are always checked by tests. Writing with named parts (a part of a README, a how-to) is checked by a second AI. Writing where taste matters, anything you will send to other people, and a web page are marked for your look.

**What “a second AI” means.** It is a separate session of an AI that did not build the work, and it thinks at a higher level than the builder did on its first try. In the default setup it is the other company's AI. It is the same company when you use only one company's AI, when you name the AI yourself, or when a feature has pictures and only Claude is trusted to look at them (see “Pictures”). That is why Mission Control says “a second AI” and never “a different AI”.

**What “approved by you” means.** Mission Control records your approval in its log. It cannot know that you opened a file or looked at a picture, and it never says so. The leader may say “look at it”, because that is what the stop is for.

**If the second AI cannot judge a check.** For example, a check about how a page looks, when no picture could be taken. A check it says it cannot judge is listed as “not judged” (a check of taste, which only you can answer, is listed as “left for you”). It is never counted as passed. The team stops for your look at that feature, even if the plan did not mark it for your look. Only the command line can switch that stop off (see “Switching the stops off”).

**If the second AI was shown no picture of a page.** Mission Control cannot tell which checks need a picture, so it relies on the second AI to say so. A second AI could still judge a layout check from the text alone and pass it. So the team stops for your look at every feature with a page where the second AI was shown no picture, whatever the second AI answered. The look says why no picture was taken. If you queued the plan without that stop, the report says “no picture was shown to the second AI”.

**If the final repair changes work you approved.** When the final review finds a serious problem, the team adds a repair feature. If the repair changes a file of a feature that you approved, it stops for your look before it is added, because the report would otherwise still say “approved by you” of text you never saw. A repair that leaves your approved files alone does not stop.

## How hard the team thinks

Each feature can also have an effort: `light`, `standard` or `deep`. The leader chooses it. Standard is the usual choice.

| Effort | Use | What it does |
|---|---|---|
| `light` | Short, routine work with little at stake | The team's lightest AI builds it first and a lighter AI checks it. It costs less. |
| `standard` | Everything else | As the team is set up. |
| `deep` | Long or important work, tricky wording | The team's strongest AI builds it and checks it, thinks longer, and gets one more round to fix what the check finds. It costs two to three times as much. |

## What Mission Control checks by itself

Before the second AI reads anything, Mission Control runs its own checks. They are a program, not an AI, they cost nothing, and they catch real defects. They run on the files the feature changed:

- some file changed, and no file is empty or very large;
- no placeholder text (“lorem ipsum”, a to-do marker at the start of a line, a blank in square brackets);
- no key or password in a file (a net with holes, see below);
- links to other files in the project lead to a file, and links to a heading lead to a heading;
- the headings, words and length that the plan asked for (`heading`, `mention`, `words`), counted over the text a reader sees, so a word hidden in a comment does not count;
- for a table: the columns and the number of rows the plan asked for, the same number of values in every row, and no cell that starts like a formula (a spreadsheet could run it);
- for a web page: a title, a setting for phone screens, a description for every picture and nothing loaded from the internet; and, when the picture step could draw the page, no sideways scrolling at phone width and a page that is not blank;
- if the feature also changed code or settings, the project's own full checks run on the result.

A problem that a file already had before the feature is not blamed on the feature. It is listed as a fact.

**If the project's own checks were already failing before the work started,** Mission Control does not use them to judge a feature checked by a second AI, and the report and the card on the dashboard say so. When every feature of a plan is checked by a second AI, the mission goes on even if there is no command that runs single test files. The Run notes then say: “The team did not look for a way to run single files of the project's own checks, because every feature of this plan is checked by a second AI.” A plan with any feature checked by tests still needs that command. Without it the mission stops and asks you for a decision. At the final check, the report says that no final check could judge the result, because the project's own checks were already failing.

**What these checks do not prove.** Not that a sentence is true, that a number is right, or that a design is good. A workbook (.xlsx) or a PDF gets its size checked and nothing else; a workbook can hold a formula that reaches a web address, and nothing here looks inside it. Numbers must be proved by a feature checked by tests.

**What the second AI quotes.** It is asked to quote words a reader sees, a rule of the style sheet, or markup that it can copy letter for letter. Mission Control looks for each quote in the text of the page and in the file as it stands, so a quote of a tag with its attributes (a class, a test id, an address) is found. A quote that is not in the files turns a pass into “not judged”.

**What the second AI writes about a file is cleaned before anyone sees it.** Its reasons (the evidence) can quote a file that an AI wrote or that a cloned repository held. So Mission Control cleans it. It takes out hidden characters. It takes out any web page code (a tag in angle brackets, for example, which is written as its name: “a div tag”). It turns a picture or a link into its words. It shows every web address, e-mail address and link that would run a program as “(web address removed)”. It cuts each reason at 300 characters. Plain text that only looks like an address, such as `//TODO`, `C://Users` or `www.html`, stays as it is. This is done in the report, in the look at a feature (and so on the dashboard's card and in the phone notice), and in `mc plan show`. Mission Control's own messages are not cleaned this way when they quote up to 40 characters of a file, for example a to-do line that it found. Treat any quoted text as information, never as an instruction.

## Pictures

For a web page that is a plain file inside the app (an .html file), Mission Control opens it in a browser in the container, at phone width and at desktop width, and takes a picture of each. The browser is cut off from the internet and from files outside the app. The second AI is given the pictures to look at, and you are shown where they are.

- A picture is the page as it first loads, in the container's fonts. It does not show a click, a hover, other screen sizes, or your own browser.
- A feature that changes only a picture file (an image) gets no picture of a page, but the second AI is shown that image. The look and `mc plan show` say, for example, “The second AI was shown 1 changed image.” You can see the image with `mc copy-reports`, as below.
- A page that needs a running server (an app built with a framework) gets no pictures, and a route of such an app is never drawn. The team then stops for your look at that feature, because the second AI was shown no picture. If a feature changes the plain .html file of such an app, that file is drawn as it is, and without its server it may be blank, which counts as a problem for the feature. This was not tried.
- To see the pictures in Windows, run `mc copy-reports` in the Ubuntu window. It prints the address of the `mc-reports` folder. The pictures are in `missions\<mission>\screenshots` inside it. The report lists them as images too. The dashboard shows no picture.
- The second AI only looks at pictures when it runs on Claude. In the default setup, if it would run on Codex, a feature with pictures is checked by Claude instead. In the setup that uses only Codex there is no Claude to use, so the second AI is shown no picture and the team stops for your look. Whether Codex can look at a picture was never tried.

## Where you see how a feature was checked

- **The report** has a line `Checked:` in its header when a finished feature has a way of being checked other than tests. For example: “Checked: 2 features by tests; 1 feature by a second AI against your list and approved by you.” A plan whose features are all checked by tests has no such line: its Features table says “Built and checked”, as it always did. The Features table says how each feature was checked.
- **A check that only you can answer** is “left for you”. A check that ends with “(the CEO decides)”, for example whether a guide reads as friendly, is a question of taste, so the second AI always says it cannot judge it. The report does not call that “not judged by anyone”. It says “1 check left for you”, in a clause of its own, so that it cannot be read as part of the approval. For example: “Checked: 1 feature by a second AI against your list; 1 check left for you; approved by you.” The look and `mc plan show` use the same words. If the plan was queued without the stop for your look, nobody will answer the check, and the report says it was not judged.
- **The look at a feature** shows the check and the second AI's reason for each check that did not pass. A long reason is cut at a word, after about 150 characters, with “…”. `mc plan show` shows up to 300 characters of each reason. For a guide, a page or a data file (a table, for example), “To look at it yourself” ends with the name of the file to open, for example “open docs/USAGE.md in your app folder”, with the Windows path of the folder. Several files are named together; if some of them are pages, it says that the page opens in a browser. Nothing is installed or run, and the project's own checks are not offered as a way to try it when no feature of the mission is checked by tests. If another feature of the mission is checked by tests, the steps only go to the version, then name the file to open, and the project's own checks follow as an extra (“If you also want to run them, run ...”) with the words that they do not cover this feature. “How to try it” in the finished report says the same, with the file first and the project's own checks after it, and writes the Windows path of the folder once. While the team waits for your check, the report does not also say “Nothing. You don't need to do anything.” under “Needs your decision”.
- **The files in the look at a feature** are told apart when the feature changed a file that was already there: “New in this feature” and “Changed, but already there before this feature”. That is how you can see that a feature touched a file an earlier feature made. The report says the same thing in these words.
- **A feature that made a file for a later feature.** In any multi-feature mission, the look, plan details, Features table and report facts disclose new files that a later pending feature's checks name. This includes builders checked by tests and makers checked by reading. The engine compares plan text with filenames reported by Git; it never opens a filename merely because the plan mentions it. It does not undo or delete work based on this heuristic. Changes within an existing file are outside this warning.
- **The second showing after you sent a feature back** repeats your note, up to 200 characters, and says: “It was changed after your note and checked again by a second AI. Nothing checks that your note was followed, so please look.” The second AI judges the original list of checks, so only you can tell whether your note was followed.
- **At the plan stop for a plan the leader wrote**, automatic review retains supplied checks, feature IDs and dependencies. The plan view, approval look and report explain rejected proposals and any technical wording that was applied. Explicit owner send-backs may change checks under the existing rules; those changes, and historical records whose checks differ, still list removed and added checks word for word. A reworded check counts as one removed and one added. Long review concerns remain bounded for display.
- **`mc plan show <mission>`** lists, after the plan, how each feature was checked: the second AI's answer on every check with its reason (each reason is cut at 300 characters, and each check at 120), Mission Control's own checks, and the pictures. This section appears for a plan with a feature checked by a second AI, or when a recorded overlap needs disclosure. An all-tests plan without an overlap keeps its shorter checking summary; the separate recorded-review section still appears.
- **The dashboard** says “Built” and not “Built and checked” for such a feature: on its tile (“Built on the first try.” and, under it, how it was checked), and in the mission sentence and the timeline when no finished feature of the mission was checked by tests. A tile that is not finished says how many checks are on your list, never that no checks were written. On the Results page each finished feature has a line that says how it was checked. When you approved a feature, the note at the bottom says you were asked to look at it and approved it.
- **The draft pull request** copies the report's `Checked:` line. It never says that a feature without tests was tested.

## What it costs

The first two columns of the table are guesses. They were made before the real jobs, from the real numbers in [docs/plans-spec.md](plans-spec.md), at list prices. The last column is what the few small real jobs named under “Status” used. The real jobs used 7 to 15 AI calls each. That is close to the guess for a guide, and more than the guess for a script and a table (13 calls, or 15 with one send-back, against about 11). A function with tests plus a notes file for your look, sent back once, used 13 calls both times it was run. That is what the guesses add up to (4 fixed calls, 4 for the feature checked by tests, 3 for the notes file and 2 for the send-back). It came to $0.70 and $0.41 at list price. On the test account they moved the weekly reading by 1 percent or less, which is less than the guess for a page. That account's plan size is not known, so on a smaller plan the share is bigger. No bigger job was measured, so this is a rough guide only.

| Job | AI calls (guess) | Share of a week's allowance (guess) | What the real jobs used |
|---|---|---|---|
| A short guide, one feature checked by a second AI | about 7 | about 1 percent | 7 calls |
| A web page marked for your look, thinking deep | about 7 | about 1.5 to 2 percent | 8 calls at standard effort. `deep` was not run |
| The same page, sent back once at the stop | about 9 | about 2 to 3 percent | not run |
| A script with tests and a described table | about 11 | about 1 percent | 13 calls, or 15 with one send-back |

A fix round adds two calls in every way of checking. Being checked by a second AI is cheaper than tests only while the checks pass the first time. The reason to use it is that it works for work that has no tests, not that it is cheap. Mission Control still pauses new work at 85 percent of the week.

**If the computer is switched off in the middle of a feature,** or the run is killed, the team may ask again for the steps that were running or had just finished when you run the feature again: the builder, the second AI, or a fix. That costs allowance and loses nothing. Stopping with `mc stop` cancels the AI step that is running, and that step is done again on the next run. Steps that had finished are kept. A feature checked by tests does the same.

## Switching the stops off

A feature marked for your look stops every time. The plan file cannot turn that off, and neither can the AI that revises a plan. Only the command line can, with `mc plan queue - --no-owner-checkpoint`. The leader adds it only after it asked “Skip your look at these features? The team will add them without stopping for you. Yes or no?” and you said a clear yes. If you never want the leader to do that, the owner can add a deny rule (see [docs/leader.md](leader.md)). Mission Control then records “it was queued without a stop for your look”. It does not say that you chose not to look.

**Someone who edits the mission files by hand can switch the stop off, and the plan file cannot.** The mission file is your own file, and the team does what it says. If you add `"ownerStops": false` to a mission file by hand, the team adds the features without stopping, and the report says “it was queued without a stop for your look”, as if you had used the flag. Nothing in the log shows the difference. If you take the `mode` out of a feature in the plan stored in a mission file that is queued and has not started, that feature is built and checked by tests with no stop, and the plan code in the report no longer describes what ran. A `mode` that is not `review` or `owner` is not accepted: the mission is left out of `mc status`, with a sentence that says its file is not valid, and it does not run. Apart from that, nothing checks the file against your own edits. This is written down here and is not guarded.

If you used `--checkpoint feature` as well, you still stop at every feature. The flag does not switch off the stop at a repair that changes work you approved: you only approved anything because you were asked, and the repair must not change it without you.

## Privacy

Everything in your apps folder can be read or sent to the AI services (Anthropic and OpenAI) whenever an AI opens a file, and Mission Control also puts file text into what it sends them. An AI that builds can use the internet. For documents, pages and data that matters more than for code: **do not put personal data, customer lists, passwords or private papers in your apps folder.** If you take a private repository with `get`, its files go in front of the AI services as soon as a feature runs. Sending the work to GitHub sends the files you chose, public or private as that repository is.

- Mission Control's own checks send nothing out.
- The picture step blocks the page's web requests. That was tried with a script, a beacon and a WebSocket. It was not tried with a service worker, DNS lookups or WebRTC. A page that sent the browser to a web address (by a script, a form, a link, a refresh tag, a new window or a frame) used to make the browser open a connection to that address, with nothing sent. The browser is now started with a switch that lets it look up no name or address. This was tried with a listener on the computer's own loopback address: seven ways of leaving the page and eight spellings of the address made no connection. It was not tried with the browser inside the Docker image, with a real internal host, or with a capture of the network traffic.
- The pictures themselves are sent to the second AI when it looks at them.
- The check for keys and passwords is a net with holes. It knows ten common shapes, and it looks only at the files of features checked by a second AI.
- Data for a job must already be in the app's folder. CSV is the format to use. Nothing can be uploaded through the leader. A script that reads a spreadsheet or an archive file should check its size first. The host script sets a memory limit on the container, which should keep a file bomb from filling the machine (read in the script, not run).
- A spreadsheet can run a cell that starts with an equals sign. If you open a data file that a script wrote, open it in a text editor first, and if Excel asks, do not press “Enable Editing” or “Enable Content” until you have read the cells. This was not tried on a PC.

The leader asks one question before it queues a job that reads a file you named: “Does this file hold personal data, customer details or private papers? Yes or no?” On yes it does not queue the job.

## What was not tried

- Many real jobs. Only a few small ones were done by a real Claude (see “Status”), so how often the second AI is wrong is not known. The second AI's judgement is an AI's: it can pass what it should not and fail what is fine. Mission Control makes the cheap ways of being wrong visible (a check not answered, a pass without a reason, a quote that is not in the files, a file it says it opened but did not, a picture it did not open), and turns those answers into “not judged”. It cannot prove that a quote proves the check.
- Codex as the second AI, looking at a picture.
- A plan reviewer that removes or adds checks, since the lists of what it changed were built. In the last two real runs it asked for no changes.
- A look that lists new files and files already there side by side.
- Looking at more than a small page. In the web page trials a real Claude opened real pictures, at phone width and at desktop width, of one small page. A bigger page, a page with scripts that change the layout after it loads, and a page that needs a server were not tried.
- The browser that is inside the Docker image. The picture step was tried here with the library at its pinned version (1.64.0) but with another browser build than the image has, and not under the limits the container sets. The block on web connections was tried the same way (see “Privacy”).
- Windows, WSL, and your own fonts and browser.
- The leader following its new rules (the words of the questions are tested, the model's behaviour is not).
- Whether the numbers above are right.

## The limits

- **A plan for such work needs an app folder** (`folder`), or a new app to put the files in. Starting an empty folder of documents is not built.
- **A folder that holds only documents** can fail at the start, or finish with a hollow report. This was tried only with a stand-in for the team's AI that works out how to check a project, so what the real one answers is not known. Three things were seen:
  - The folder must be a git repository. If it is not, `mc plan queue` says “This plan can't be used yet” and that the folder is not a git repository, and it queues nothing. Inside that folder, run `git init`, then commit your files.
  - If the team's AI finds no way to check the project, the mission stops at the start after two tries with “Could not work out how to check this project”. It asks you to add a short note on how to run the checks to the README or AGENTS.md, and then to run `mc run --mission <mission>`. A note helps only if the folder really has checks to describe.
  - If the team's AI answers with a command that checks nothing, the mission can run to the end. Then the report's “How to try it” tells you to run that command as the project's own checks, and the dashboard says that the final checks of the whole app passed, although the command checked nothing. Do not read that as a check by the project. The second AI and Mission Control's own checks still ran on each feature.

  Nothing was changed for this. The leader tells you if it happens. A first real job in a plain folder of documents is the way to find out which of the three a real run meets.
- **A builder may still do the work of the next feature.** Every multi-feature test-author, builder and maker brief now says to keep to the current feature; a shared contract does not authorize later work. Detected new-file overlap is disclosed. These are instructions and a text-based warning, not an enforced filesystem ownership boundary. Historical cloud runs R4 and R6 showed work spilling into later features; R7 avoided it once. Those historical observations do not validate this local reconstruction. Current evidence uses stand-in agents only.
- **A review note can stay open after a later feature answered it.** In R7 the review of the first feature said that the notes file was missing, because the notes feature came later and made it. The finished report still showed that note, and marked the first feature's row “1 review note below”. Nothing says that the note was answered. The written summary of the report may repeat such a note as advice. Not fixed.
- **The written summary of a finished report can be left out although it is true.** When the features of a mission are checked in different ways, Mission Control cuts out the whole AI-written summary if it finds the word “tests” in a sentence that is not one of the denials it knows. In R7 two true sentences did this: “The word counting was checked with automated tests that were written before the code” and a sentence saying that no automated tests cover the notes. The report then says that it left the summary out because it described how the work was checked in words that Mission Control could not confirm. The summary at the top is then Mission Control's own plainer text. It is true and it agrees with the `Checked:` line. Not fixed.
- **Plan text is now preserved literally after JSON parsing.** A backslash followed by n stays those two characters; a real newline stays a newline. If an AI mistakenly double-escapes an intended list, its literal escape text remains visible. Existing saved plans and historical reports are not rewritten. Supplied acceptance checks, feature IDs and dependencies are retained during automatic plan review; rejected edits are shown in the plan review. Explicit owner send-backs keep their existing rules.
- **No research with sources.** A job that needs facts from the internet, with sources, is not covered. A plan carries no web address, the builders are told to use only facts that are in the project and in the plan, and nothing checks that a source is real or that a fact is true. The leader says so and does not write a plan for it.
- **Pages that need a running server get no pictures.**
- **No spreadsheet inside Mission Control.** A workbook (.xlsx) can only come from a script that has tests, with a CSV beside it. Not tried: no real job made a workbook. The CSV can be checked, and the workbook is shown on GitHub as a file that cannot be read there.
- **No Word or PDF files.** A document is markdown or a page. You can print a page to PDF in a browser.
- **No audio or video, no colour or contrast audits.**
- **Data scripts are not scanned for keys or formula cells.** The scans cover features checked by a second AI, so a script with tests that copies a cell from an input file can pass it on.

## Not built: features that run side by side

Features that run side by side are deferred, and not built in this step. Mission Control is made for one feature at a time. It has one loop over the features. It keeps one copy of the mission in memory, which is written whole at every save. It has one run lock and one line of merges into a single branch. Its pacing assumes one AI call at a time. Its timeline and stops assume one feature is in flight. Running features side by side would need separate working copies and a rule for merge conflicts (who settles them?). It would also need saves that cannot overwrite each other, a resume that copes with several half-finished features, and pacing across calls that overlap. Thousands of tests assume a fixed order, so doing it would also make them unreliable. The gain is clock time on big jobs with many features. The use of the allowance is the same, and most small jobs have one to three features. It waits until real use shows that it is needed.


## Recorded AI reviews in the reconstructed core

The report, plan details and dashboard now include “Recorded AI reviews”. It names the AI families recorded for retained work, frozen tests and the review of that version. A fallback can make the builder and reviewer the same family; the result can continue, and the record says so. An old or incomplete record says the identity or relationship could not be established.

A review belongs to the version it examined. A repair, interrupted write or unconfirmed restoration can remove current review credit until the required evidence is available. “Recorded” does not mean the current repository was checked again when you opened the report. Application comparisons cover retained AI work from this mission, not earlier repository authors.

These changes have been tested here only with stand-in AIs. They do not establish a filesystem protection boundary or real-provider compatibility.
