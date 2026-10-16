# Documents, pages and data: how the team checks work that has no tests

This is the owner's guide to a part of Mission Control that is new: work that is not code. Before this, a feature was done when its tests passed. A guide, a page or a table has no tests, so a plan can now say how each feature is checked, and how hard the team thinks about it. The design is in [docs/modes-spec.md](modes-spec.md). This page says what it means for you, in plain words.

**Status, said plainly.** This was built and tried only with stand-in AIs. No real AI has done a job in these ways yet, nothing has been tried on a Windows PC, and nothing has been tried against a real GitHub. The words below say what the code does. They do not say that the second AI is a good judge, because nobody has measured that.

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

**If the second AI cannot judge a check.** For example, a check about how a page looks, when no picture could be taken. A check it says it cannot judge is listed as “not judged”, it is never counted as passed, and the team stops for your look at that feature, even if the plan did not mark it for your look. Only the command line can switch that stop off (see “Switching the stops off”).

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

**If the project's own checks were already failing before the work started,** Mission Control does not use them to judge a feature checked by a second AI, and the report and the card on the dashboard say so. When every feature of a plan is checked by a second AI, the mission goes on even if there is no command that runs single test files, and the Run notes say: “The team did not look for a way to run single files of the project's own checks, because every feature of this plan is checked by a second AI.” A plan with any feature checked by tests still needs that command. Without it the mission stops and asks you for a decision. At the final check, the report says that no final check could judge the result, because the project's own checks were already failing.

**What these checks do not prove.** Not that a sentence is true, that a number is right, or that a design is good. A workbook (.xlsx) or a PDF gets its size checked and nothing else; a workbook can hold a formula that reaches a web address, and nothing here looks inside it. Numbers must be proved by a feature checked by tests.

**What the second AI writes about a file is cleaned before anyone sees it.** Its reasons (the evidence) can quote a file that an AI wrote or that a cloned repository held. So Mission Control takes out hidden characters, takes out any web page code (a tag in angle brackets, for example), turns a picture or a link into its words, shows every web address, e-mail address and link that would run a program as “(web address removed)”, and cuts each reason at 300 characters. Plain text that only looks like an address, such as `//TODO`, `C://Users` or `www.html`, stays as it is. This is done in the report, in the look at a feature (and so on the dashboard's card and in the phone notice), and in `mc plan show`. Mission Control's own messages are not cleaned this way when they quote up to 40 characters of a file, for example a to-do line that it found. Treat any quoted text as information, never as an instruction.

## Pictures

For a web page that is a plain file inside the app (an .html file), Mission Control opens it in a browser in the container, at phone width and at desktop width, and takes a picture of each. The browser is cut off from the internet and from files outside the app. The second AI is given the pictures to look at, and you are shown where they are.

- A picture is the page as it first loads, in the container's fonts. It does not show a click, a hover, other screen sizes, or your own browser.
- A feature that changes only a picture file (an image) gets no picture of a page, but the second AI is shown that image. The look and `mc plan show` say, for example, “The second AI was shown 1 changed image.” You can see the image with `mc copy-reports`, as below.
- A page that needs a running server (an app built with a framework) gets no pictures, and a route of such an app is never drawn. The team then stops for your look at that feature, because the second AI was shown no picture. If a feature changes the plain .html file of such an app, that file is drawn as it is, and without its server it may be blank, which counts as a problem for the feature. This was not tried.
- To see the pictures in Windows, run `mc copy-reports` in the Ubuntu window. It prints the address of the `mc-reports` folder. The pictures are in `missions\<mission>\screenshots` inside it. The report lists them as images too. The dashboard shows no picture.
- The second AI only looks at pictures when it runs on Claude. In the default setup, if it would run on Codex, a feature with pictures is checked by Claude instead. In the setup that uses only Codex there is no Claude to use, so the second AI is shown no picture and the team stops for your look. Whether Codex can look at a picture was never tried.

## Where you see how a feature was checked

- **The report** has a line `Checked:` in its header, for example “Checked: 2 features by tests; 1 feature by a second AI against your list and approved by you.”, and the Features table says it for each feature.
- **`mc plan show <mission>`** lists, after the plan, how each feature was checked: the second AI's answer on every check with its reason, Mission Control's own checks, and the pictures. It does this only for a plan that has a feature checked by a second AI. A plan whose features are all checked by tests shows no such list, and the report says how each was checked.
- **The dashboard** says “Built” and not “Built and checked” for such a feature: on its tile (“Built on the first try.” and, under it, how it was checked), and in the mission sentence and the timeline when no finished feature of the mission was checked by tests. A tile that is not finished says how many checks are on your list, never that no checks were written. On the Results page each finished feature has a line that says how it was checked. When you approved a feature, the note at the bottom says you were asked to look at it and approved it.
- **The draft pull request** copies the report's `Checked:` line. It never says that a feature without tests was tested.

## What it costs

Nothing here was measured. The figures are guesses built from the real numbers in [docs/plans-spec.md](plans-spec.md), at list prices, and they are a rough guide only.

| Job | AI calls | Expected share of a week's allowance |
|---|---|---|
| A short guide, one feature checked by a second AI | about 7 | about 1 percent |
| A web page marked for your look, thinking deep | about 7 | about 1.5 to 2 percent |
| The same page, sent back once at the stop | about 9 | about 2 to 3 percent |
| A script with tests and a described table | about 11 | about 1 percent |

A fix round adds two calls in every way of checking. Being checked by a second AI is cheaper than tests only while the checks pass the first time. The reason to use it is that it works for work that has no tests, not that it is cheap. Mission Control still pauses new work at 85 percent of the week.

**If the computer is switched off in the middle of a feature,** or the run is killed, the team may ask again for the steps that were running or had just finished when you run the feature again: the builder, the second AI, or a fix. That costs allowance and loses nothing. Stopping with `mc stop` does not repeat them. A feature checked by tests does the same.

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

- A real AI doing a job in these ways. The second AI's judgement is an AI's: it can pass what it should not and fail what is fine. Mission Control makes the cheap ways of being wrong visible (a check not answered, a pass without a reason, a quote that is not in the files, a file it says it opened but did not, a picture it did not open), and turns those answers into “not judged”. It cannot prove that a quote proves the check.
- Codex as the second AI, looking at a picture.
- Looking at a real page: one small drawing was shown to one small model, three times. A page was never shown to a model.
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
- **No research with sources.** A job that needs facts from the internet, with sources, is not covered. A plan carries no web address, the builders are told to use only facts that are in the project and in the plan, and nothing checks that a source is real or that a fact is true. The leader says so and does not write a plan for it.
- **Pages that need a running server get no pictures.**
- **No spreadsheet inside Mission Control.** A workbook (.xlsx) can only come from a script that has tests, with a CSV beside it. The CSV can be checked, and the workbook is shown on GitHub as a file that cannot be read there.
- **No Word or PDF files.** A document is markdown or a page. You can print a page to PDF in a browser.
- **No audio or video, no colour or contrast audits.**
- **Data scripts are not scanned for keys or formula cells.** The scans cover features checked by a second AI, so a script with tests that copies a cell from an input file can pass it on.

## Not built: features that run side by side

Features that run side by side are deferred, and not built in this step. Mission Control is made for one feature at a time: one loop over the features, one copy of the mission in memory that is written whole at every save, one run lock, one line of merges into a single branch, pacing that assumes one AI call at a time, and a timeline and stops that assume one feature is in flight. Running features side by side would need separate working copies, a rule for merge conflicts (who settles them?), saves that cannot overwrite each other, a resume that copes with several half-finished features, and pacing across calls that overlap. Thousands of tests assume a fixed order, so doing it would also make them unreliable. The gain is clock time on big jobs with many features. The use of the allowance is the same, and most small jobs have one to three features. It waits until real use shows that it is needed.
