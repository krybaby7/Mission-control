# Your own try-out: a checklist for your PC

This list is for you, at your desk. It tries Mission Control on your own Windows PC, one step at a time, with small jobs that cost little. Every step says what to do, what you should see, what a good result proves, and what nobody has tried before you.

**What was tried before you, and what was not.**

- **Tried for real:** a real Claude did small test jobs on a tiny practice app, on a cloud test machine: a code job, a guide, a web page (twice) and a table with a script. The record is in [docs/real-runs.md](real-runs.md).
- **Tested here only:** everything else that was built, with stand-in AIs and automated tests. That includes the fixes made after those test jobs. It also includes the step that sends work to GitHub: it was tried only with a folder standing in for GitHub, a fake `gh` and a fake Docker, although a real Claude built the work that was sent.
- **Never tried by anyone:** Windows, WSL, Docker Desktop, a real GitHub, the real `gh` tool, the Claude Code permission prompts, the iPad, Codex, and the leader chatting with a person.

So if a step fails, that is useful news and not your mistake. **Stop at the step that fails. Do not try to fix it.** Go to [Step 10](#10-if-something-fails-what-to-send-back).

**Words used here.** A job is called a mission. `mc status` lists the missions by name, like `2026-10-16-shout-function`. A feature is one piece of a job. “A second AI” is a separate AI session that reads the work and judges each check on the list. “The look” is the place where the team stops and waits for you.

## Do these three first

| | What | What it costs |
|---|---|---|
| 1 | **Install and check** (Step 1) | Nothing from your allowance, except a very small amount for `mc doctor --live` (one tiny request to each AI; nobody measured it). About an hour of your time, mostly waiting for downloads. |
| 2 | **One small code job through the leader** (Steps 2 and 3) | About 1 percent of one week of your Claude plan. The real test job used 8 AI calls and about a minute of team time. |
| 3 | **Send that job to a throwaway GitHub repository** (Step 7) | Nothing. Sending makes no AI call (read in the script; the stand-in test made none). |

Steps 4, 5, 6, 8 and 9 can wait until these three work.

## What the jobs cost

All figures come from the real test jobs: a real Claude, Claude only, a tiny practice app. “About 1 percent of one week” is the most a small job moved the weekly reading. That reading goes up in whole percents, so it cannot show less. The dollar figures are the engine's own estimate at list price. (The engine is the part of Mission Control that runs the team.) They are not what your plan charges you.

| Job | AI calls | Team time | Engine's estimate at list price | Part of one week |
|---|---|---|---|---|
| Code job (Step 3) | 8 | 1 to 1.5 minutes | $0.24 to $0.41 | about 1 percent or less |
| Guide with your look (Step 4) | 7 | about 1 minute | $0.26 | about 1 percent or less |
| Web page (Step 5) | 8 | 1.5 to 2 minutes | $0.40 to $0.52 | about 1 percent or less |
| Script and table, sent back once (Step 6) | 15 | about 3 minutes | $0.59 | about 1 percent or less |
| Send to GitHub (Step 7) | 0 | seconds | nothing | nothing |

Steps 3 to 6 together: at most about 4 percent of one week, if nothing goes wrong. A job that needs more rounds costs more. Your own apps are bigger than the practice app, so a real job will cost more, and nobody has measured by how much. The leader's chat and Step 9 also use your plans, and those were not measured. Mission Control stops starting new work when the week reaches 85 percent.

## The practice app

Steps 3 to 7 use one tiny app called `word-tools`. It is the app the real test jobs used. It has a little code and three tests. **That matters: a job of writing, a page or a table needs an app that has code and its own checks.** A folder that holds only documents can fail at the start or finish with an empty report, so do not use one for the first writing job. Step 3 makes the app with one pasted block ([Block A](#block-a-the-practice-app) at the end of this page).

## The steps

### 1. Install and check

- **Do:** follow [docs/setup-windows.md](setup-windows.md), Steps 1 to 6. Do Step 7 there only if your PC goes to sleep. Then type `mc config set defaultProfile claude`. This makes the team use Claude only for now, as every real test job did. Step 9 switches Codex back on.
- **You should see:** `Hello from Docker!` (Step 2 of the guide), `mc-docker: the image is ready.` (Step 3), `Login successful` (Step 4), no ✗ line from `mc doctor` (Step 5) and a test message on your iPad (Step 6). `mc config get defaultProfile` prints `claude`.
- **It proves:** Windows, WSL, Docker Desktop, both logins and the iPad message work with Mission Control.
- **Never tried here:** all of it. The guide was written from the programs' own documentation and from our tests, not from a PC.

### 2. Open the leader

- **Do:** in [docs/setup-windows.md](setup-windows.md), find “Optional: start the leader”. Install Claude Code in Ubuntu, then run `mc install-leader` and `mc leader`. If Claude Code complains about Remote Control, run `mc leader --no-remote`. When the typing box appears, type `How is it going?`.
- **You should see:** Claude Code asks you once to log in and to trust the folder. Then the leader answers in a few plain words, for example that nothing is queued. Its words are its own and will differ.
- **It proves:** Claude Code runs in your Ubuntu window, starts in the leader folder, and the leader can reach Mission Control through Docker Desktop.
- **Never tried here:** Windows, WSL, Claude Code on a PC, `claude --remote-control`. The leader has never chatted with a person. Only its rule file and its permission list were tested. In the real test jobs the tester, an AI session, wrote the plans by hand, following the leader's rules.

### 3. A small code job through a plan

- **Do:**
  1. Paste [Block A](#block-a-the-practice-app) into the Ubuntu window.
  2. Tell the leader, in its chat:

     ```
     In my apps folder there is an app called word-tools, on the branch main. Add a shout(text) function next to capitalize. It turns the text to upper case and adds an exclamation mark at the end.
     ```
  3. Read its plan. Say yes to “Queue this plan and start the team on it?”. Say Yes to each Claude Code prompt, once each, and never “Yes, and don't ask again”.
  4. When the team stops at the plan, tell the leader to approve it. Say yes when it offers to start the team again.
- **You should see:** the plan, with every check word for word and a short plan code. If the team's plan reviewer changed your checks, the leader lists the ones removed and the ones added (that part is new and was only tested here). In the real test the team stopped at the plan after 20 seconds and finished 45 seconds after the approval. At the end `mc status` shows `done`, and `mc report` starts with the job's name and `**Done** · 1 of 1 feature done`. Follow “How to try it” in the report: `npm test` should show no failed test.
- **It proves:** the whole path works on your PC: the plan, the stop at the plan, your approval, the checks written first, the build, the second AI's review and the report.
- **Never tried here:** the leader writing this plan itself, the Claude Code permission prompts, Windows, WSL, Docker Desktop.

### 4. A writing job with a look

- **Do:**
  1. Tell the leader. Use `word-tools`, which has code and tests, and not a folder of documents:

     ```
     In word-tools, add a short usage guide in docs/USAGE.md with an Install part and a Use part that shows capitalize. I want to look at it myself before it is added.
     ```
  2. Check the leader's line for the guide. It must end with “and then by you”. If it does not, ask the leader to mark the guide for your look.
  3. Answer as in Step 3. The team stops twice: at the plan, then at the guide. At the second stop, open the file as the look says, read it, and tell the leader to approve it or to send it back with what to change.
  4. Put the folder back with the lines the look gives (`git checkout main`, then `exit`). The next job needs that.
- **You should see:** the stop says it is waiting for your check and gives the second AI's answers: how many checks passed, failed or could not be judged. It names the file to open and gives its Windows address. After your approval the report has a line that starts `Checked:`. It says a second AI checked the guide against your list and that you approved it. No line calls the guide “tested”.
- **It proves:** the way work without tests is checked: Mission Control's own checks (headings, length), the second AI's answers, the stop for you, and honest words in the report.
- **Never tried here:** the new text of the look for a guide. The real test showed the old text, which sent you to `npm test` and did not name the file. That was fixed and only tested here. Also the leader choosing the way of checking by itself, Windows, WSL, Docker Desktop.

### 5. A web job

- **Do:**
  1. Tell the leader:

     ```
     In word-tools, add a one-page landing page at site/index.html. It needs a headline, three benefits and a Get started button. On a phone the benefits should be in one column. On a desktop they should be in three columns.
     ```
  2. Answer as in Steps 3 and 4, including putting the folder back at the end.
  3. To see the pictures, run `mc copy-reports` in Ubuntu, paste the address it prints into File Explorer, and open `missions\<mission>\screenshots`.
- **You should see:** the team stops for your look at the page. It says two pictures were taken, at phone width and at desktop width, and it names `site/index.html`. The pictures show a headline, a button and three benefits: stacked on the phone, side by side on the desktop. The page opens in your browser and looks the same.
- **It proves:** the browser in the Docker image can draw the page, a second AI looked at the pictures, and the pictures reach you in Windows.
- **Never tried here:** the picture step with the browser inside the real Docker image (the test machine had another browser build) and on Windows. Codex looking at pictures: only Claude does it. The new text of the look for a page. In the real tests the pictures of the two small pages looked right.

### 6. A data job

- **Do:**
  1. Paste [Block B](#block-b-the-sales-file) into the Ubuntu window.
  2. Tell the leader:

     ```
     In word-tools, data/sales.csv has the columns Region, Units and Revenue. Add a script that writes reports/totals.csv with one row for each region, with its total units and total revenue. Also add data/columns.csv that says in plain words what each column means. I want to look at that file before it is added.
     ```
  3. The leader asks whether the file holds personal data. Answer no: the numbers are made up.
  4. At the stop for `columns.csv`, send it back once. Tell the leader: `Make every Meaning at most 7 words.` When it comes back, read the file, then approve.
- **You should see:** the script's totals are East 145 units and 2900.25, North 195 and 3900.50, South 110 and 2210.75. You can work them out from `data/sales.csv`. To see the totals file, use the report's checkout lines in `mc shell`, run the script the report names (in the real test: `node scripts/region-totals.js`) and open `reports/totals.csv`. After your note, the stop comes again, repeats your note in curly quotes and says that nothing checks the note was followed. You check that.
- **It proves:** tests written first for a script with exact numbers, the check of a table, and a send-back that is reworked and shown again.
- **Never tried here:** Excel or any spreadsheet file (if Excel asks “Enable Editing”, do not press it before you have read the cells). A second send-back. In the real test the first feature also built the second feature's file ahead of time. That was not fixed: the look now lists such a file as “already there before this feature”, and that was only tested here. Windows, WSL, Docker Desktop.

### 7. Publish to a throwaway GitHub repository

- **Do:**
  1. Install `gh` and log in: [docs/setup-windows.md](setup-windows.md), “Optional: work on a repository on GitHub”, instructions 1 and 2.
  2. On github.com, make an empty **private** repository named `mc-practice`. Leave README, .gitignore and licence off.
  3. With no job running, type this in Ubuntu, with your own GitHub name in place of `<you>`:

     ```
     git -C ~/mc-apps/word-tools remote add origin https://github.com/<you>/mc-practice.git
     git -C ~/mc-apps/word-tools push -u origin main
     ```
  4. Look first, then send. Use the Step 3 job's name from `mc status`:

     ```
     mc publish-preview <mission>
     mc publish <mission> --to <you>/mc-practice
     ```
- **You should see:** `It would go to github.com/<you>/mc-practice`, then `draft pull request: https://github.com/...`. Open that address. It is a draft pull request from the branch `mc/<mission>`, with the plan code, a part “What was checked” and the first lines of the report. The repository has two branches, `main` and `mc/<mission>`, and `main` is as you pushed it. Read “What was checked”: does it say honestly what happened? That is the point of this step.
- **It proves:** your own GitHub login, the real `gh` tool and a real GitHub work with `mc publish`. Only one branch goes up, nothing is forced, and `main` is not touched.
- **Never tried here:** a real GitHub, a real `gh` (`gh auth login`, the draft pull request), a private repository, Windows, WSL, Docker Desktop. The real test used a folder standing in for GitHub and a fake `gh`. The pull request text was improved after that test and only tested here. The leader's own GitHub path (“Work on my repo … and send it to GitHub”) has never run, even with stand-ins.
- **Also try, if you like (costs nothing):** `mc get <you>/mc-practice practice-copy` downloads your throwaway repository into `~/mc-apps/practice-copy`. You should see `mc-docker: downloaded <you>/mc-practice into ~/mc-apps/practice-copy.` That tries the download with your login. It was never tried against a real GitHub either.
- **When you are done:** delete the repository on github.com (Settings, at the bottom: Delete this repository).

### 8. The dashboard on the iPad

- **Do:** do this while a job waits for your look (during Step 4 or 5). In a second Ubuntu window run `mc dashboard --lan`. On the PC open <http://localhost:8787>. Then, in PowerShell, run `ipconfig` and find the `IPv4 Address` line of your Wi-Fi or network card. On the iPad, on the same network, open Safari and type `http://<that address>:8787`.
- **You should see:** four tabs, **Now**, **Needs you**, **Timeline** and **Results**. A job that waits for you has an amber card, `“<name>”: please check the feature`, with two buttons that only give you a sentence to paste into the leader's chat. The page changes nothing. If it loses touch it says **Not updating**.
- **It proves:** the page works in a Windows browser, and whether the iPad can reach it through Windows and WSL2.
- **Never tried here:** the iPad route. Nobody knows whether Windows, WSL2 and Docker Desktop let the iPad through. Also Safari on the iPad, and the page in a Windows browser. `--lan` opens the page to every device on your network, and it has no password. Use it only at home, and press Ctrl+C in its window when you are done. If the iPad cannot open it, do not change the Windows firewall yourself. Send back what Safari says.

### 9. Try Codex (optional)

- **Do:** type `mc config set defaultProfile mixed`. Then do Step 3 again with another small job, for example: `In word-tools, add a whisper(text) function next to capitalize. It turns the text to lower case and adds three dots at the end.`
- **You should see:** the same path as Step 3. In this team, Claude plans and reviews and Codex builds.
- **It proves:** Codex can build in the usual team, and the two plans share the work.
- **Never tried here:** all of it. Codex never ran in any test job. Its login, its builds and how it shares the work with Claude were never tried, here or on a PC. What this costs is not known: it draws on both plans.

### 10. If something fails: what to send back

**Do not fix anything.** Write down the step number and send these in your next message to the Claude chat that built this, or to whoever is helping you.

1. **What you saw.** The text in the Ubuntu window, from the command that failed to the end. Select it with the mouse, press Ctrl+Shift+C, and paste it into your message. If that does not work, take a picture of the screen (Windows key + Shift + S).
2. **For a job that stopped, looks wrong or did not finish (Steps 3 to 7).** Paste this block into the Ubuntu window. Replace `<mission>` with the job's name from `mc status`. A line that prints an error is fine. Then open `\\wsl.localhost\Ubuntu\home\<your Ubuntu name>\mc-send` in File Explorer and attach the five files.

   ```
   mkdir -p ~/mc-send
   mc status > ~/mc-send/status.txt 2>&1
   mc doctor > ~/mc-send/doctor.txt 2>&1
   mc logs <mission> > ~/mc-send/logs.txt 2>&1
   mc report <mission> > ~/mc-send/report.txt 2>&1
   mc plan show <mission> > ~/mc-send/plan.txt 2>&1
   ```
3. **For a web job (Step 5).** Also run `mc copy-reports`, and attach the pictures from `missions\<mission>\screenshots` in the folder it prints.
4. **For GitHub (Step 7).** The text of the failed command, and the output of `gh auth status`. It shows your account name and hides your token.
5. **For the leader (Step 2).** The last lines of the chat, as text or as a picture.
6. **For the iPad (Step 8).** What Safari says, whether the page opens on the PC, and the output of `ipconfig` in PowerShell.

The five files hold the words of your jobs and the AIs' answers. They are not meant to hold a password or a login. Read them before you send them if a job was private. The block in point 2 was run here only on a test copy outside Docker. It was never run through the Docker script and never on a PC.

## The two blocks you paste

Paste each block into the Ubuntu window, not into the leader's chat. Each stops by itself if something is wrong.

### Block A: the practice app

It makes `~/mc-apps/word-tools`: a little code, three tests and one saved version on the branch `main`. It refuses to run if that folder is already there. Run here, in a test folder: it made the app, and `npm test` passed all three tests.

```
bash <<'SCRIPT'
set -e
mkdir -p ~/mc-apps
mkdir ~/mc-apps/word-tools
cd ~/mc-apps/word-tools
mkdir src
cat > package.json <<'EOF'
{
  "name": "word-tools",
  "version": "1.0.0",
  "description": "Tiny text helpers",
  "type": "module",
  "main": "src/index.js",
  "scripts": { "test": "node --test" }
}
EOF
cat > src/capitalize.js <<'EOF'
/** Upper-cases the first letter of a word and lower-cases the rest. */
export function capitalize(word) {
  if (typeof word !== "string") throw new TypeError("capitalize expects a string");
  if (word === "") return "";
  return word[0].toUpperCase() + word.slice(1).toLowerCase();
}
EOF
printf 'export { capitalize } from "./capitalize.js";\n' > src/index.js
cat > src/capitalize.test.js <<'EOF'
import { test } from "node:test";
import assert from "node:assert/strict";
import { capitalize } from "./index.js";

test("capitalize upper-cases the first letter and lower-cases the rest", () => {
  assert.equal(capitalize("hELLO"), "Hello");
});

test("capitalize returns an empty string for an empty string", () => {
  assert.equal(capitalize(""), "");
});

test("capitalize rejects non-strings", () => {
  assert.throws(() => capitalize(42), TypeError);
});
EOF
printf '# word-tools\n\nTiny text helpers, with no dependencies.\n\n## capitalize(word)\n\nUpper-cases the first letter and lower-cases the rest.\n\n## Tests\n\n`npm test`\n' > README.md
printf 'node_modules/\n' > .gitignore
git init -q -b main
git add -A
git -c user.name=Owner -c user.email=owner@example.invalid commit -q -m "Initial commit: capitalize helper"
echo "Made ~/mc-apps/word-tools"
SCRIPT
```

**You should see:** `Made ~/mc-apps/word-tools`. If it says `File exists`, the app is there already and you can go on.

### Block B: the sales file

It adds `data/sales.csv`, seven made-up rows, to the practice app and saves it on `main`. Do it when no job is running and the folder is back on `main`. Run here, in a test folder: it added the file, and the sums come out as in Step 6.

```
bash <<'SCRIPT'
set -e
cd ~/mc-apps/word-tools
git checkout -q main
mkdir -p data
cat > data/sales.csv <<'EOF'
Region,Units,Revenue
North,120,2400.50
South,80,1600.00
East,45,900.25
North,60,1200.00
South,30,610.75
East,100,2000.00
North,15,300.00
EOF
git add data/sales.csv
git -c user.name=Owner -c user.email=owner@example.invalid commit -q -m "Add sales data"
echo "Added data/sales.csv"
SCRIPT
```

**You should see:** `Added data/sales.csv`.
