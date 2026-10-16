# Set up Mission Control on Windows 11

Mission Control builds your app ideas with Claude Code and Codex, working inside a sealed box (a Docker container) on your PC. You set it up once. After that, the routine is: describe an idea, start a run, and read the report when it finishes. Your iPad buzzes when the run is done.

**What was tried, and what was not.** Mission Control was tested with stand-in AIs, and a few small jobs were run with a real Claude in a cloud test machine. **Nothing in this guide has been tried on a Windows PC.** Windows, WSL, Docker Desktop, Codex and a real GitHub were never used for it. The leader, the team running inside Docker and the Claude Code permission prompts have not been tried by anyone yet. The steps for those programs, for the logins and for GitHub come from their own documentation. The **You should see** lines say what that documentation, or our own tests, led us to expect. The words on your screen may differ a little. If a step does not do what the guide says, stop there and look in [Troubleshooting](#troubleshooting). Write down the step number and what you saw instead.

**What you need**

- A Windows 11 PC that can stay on while a run works, ideally with 16 GB of memory, and with 30 GB of free disk space. You must be allowed to install programs on it (an administrator login).
- A paid Claude plan (Pro or Max) and a paid ChatGPT plan (Plus or higher, which includes Codex).
- A free GitHub account (github.com). You need it to download Mission Control if its page is private, and for the GitHub part at the end.
- An iPad (or iPhone) for notifications.
- About an hour, mostly spent waiting for downloads. This is an estimate: nobody has timed it.

**How to use this guide**

- You will use two kinds of window. **PowerShell** is only for the few Windows commands in Step 1. **The Ubuntu window** is for everything else. To open it, click **Start**, type `Ubuntu`, and press Enter. Its last line looks like `adam@YOUR-PC:~$` (your Ubuntu name, then your PC's name). That line is called the prompt: it means the window is ready for a command. A PowerShell window's last line starts with `PS C:\`. Type each command in the window the step names.
- Gray boxes are commands. Copy the whole box, paste it into the window named in the step (in the Ubuntu window, right-click to paste), and press Enter. Do not type the `$` sign of the prompt.
- Some commands show nothing for a minute or more. Wait until the prompt comes back.
- **You should see** tells you what success looks like. If you see something else, look it up in [Troubleshooting](#troubleshooting).
- Text in `<angle brackets>` is a placeholder. Replace all of it, brackets included.

## What the container protects you from, and what it doesn't

Mission Control lets AI agents run commands for as long as a run lasts, without asking you first. To make that safe enough, they work inside a Docker container: a sealed box on your PC. Inside the box, the agents can see only:

- your apps folder (`~/mc-apps` in Ubuntu), where they build your apps;
- the Claude and Codex logins;
- Mission Control's own notes and reports.

**It protects** your Windows files (Documents, Pictures, Desktop), your browsers and saved passwords, and everything else in Ubuntu. If an agent runs a harmful command such as "delete everything", the damage stays in the box and in `~/mc-apps`, where git keeps the history of each app. The box also has limits: it may use at most three quarters of Docker's memory and a few thousand programs at once, so an app build that runs out of control should fail inside the box instead of freezing Docker Desktop (read in the script, never run).

**By default it is not involved in GitHub.** `mc get`, `mc publish-preview` and `mc publish` run in your Ubuntu window, outside the box, with your own GitHub login. The box never sees that login. `mc publish` reads the app's folder, but it makes a clean copy of the one branch before it touches GitHub, so nothing the agents left in that folder can run with your login. It also uploads only to a repository you named (the preview shows it), and never to one that the app's folder was changed to. See [docs/github-setup.md](github-setup.md).

**It does not protect:**

- **Your Claude and Codex logins.** Agents can read them, so a misbehaving agent could use your subscriptions.
- **The internet.** Agents can reach the internet, because they need it to download building blocks. In principle, they could send out anything inside the box, your Claude and Codex logins included. This version has no list of allowed websites.
- **Your home network.** Agents can also reach the other devices on your network (your router's settings page, a network drive, printers) and programs on your PC that accept network connections. Keep those protected with passwords that aren't the factory defaults.
- **Your apps folder.** Anything in `~/mc-apps` can be changed or deleted.
- **Git in your apps folder during a run.** An agent could add git settings that make git run commands. Mission Control undoes them after every step and when a mission finishes, but while a run is working, don't run `git` in `~/mc-apps`, or open those folders in an editor, outside `mc shell`.
- **Your usage allowance.** Each run uses a lot of your Claude and ChatGPT limits. Mission Control paces itself: by default one run uses at most about a third (35%) of each plan's weekly limit, and it stops rather than run on paid extra usage. That pacing was tested with stand-in AIs only. No real run came near a limit. But it does use them.
- **Mission Control itself.** Agents run as the same user as Mission Control, so a misbehaving agent could stop a run early or change Mission Control's settings and records in `~/.mission-control`. Work already saved is kept, and the next run carries on.

**What the AI services can read.** Everything in your apps folder can be read or sent to the AI services (Anthropic and OpenAI) whenever an AI opens a file, and Mission Control also puts file text into what it sends them. An AI that builds can use the internet. For documents, pages and data that matters more than for code: do not put personal data, customer lists, passwords or private papers in your apps folder. If you take a private repository with `mc get`, its files go in front of the AI services as soon as a feature runs. Sending the work to GitHub sends the files you chose, public or private as that repository is. Data for a job must already be in the app's folder, and CSV is the format to use: nothing can be uploaded through the leader.

Mission Control's own checks of a document, a page or a table send nothing out. When it takes pictures of a page, it blocks the page's web connections. That was tried on a test machine, with a different browser build than the one in the Docker image, and not on Windows. The pictures themselves go to the second AI when it looks at them. The check for keys and passwords is a net with holes: it knows ten common shapes and looks only at the files of features checked by a second AI. The Docker script limits the box's memory, so that a huge file should not fill your PC. That was read in the script and was not run. [docs/work-modes.md](work-modes.md) lists exactly what was and was not tried.

**So, follow these rules:**

1. Never put real passwords, API keys, SSH keys, bank details or personal documents in `~/mc-apps`, and never give them to an agent. To send finished work to GitHub, use `mc publish` (see [Optional: work on a repository on GitHub](#optional-work-on-a-repository-on-github)): it uses your own login on the PC and needs no token in that folder. The one exception is a GitHub token limited to one repository, if you turn on the older way of uploading: see [Optional: upload finished work to GitHub](#optional-upload-finished-work-to-github) first.
2. Don't connect extra folders to the container, and don't edit `scripts/mc-docker.sh` to add any.
3. Never set `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`. They would switch you from your subscription to pay-per-use billing. `mc doctor` checks for this.
4. Treat your notification topic name (Step 6) like a password.

## Step 1: Turn on WSL2 and install Ubuntu

WSL2 runs Linux (Ubuntu) inside Windows. Mission Control runs from there.

1. Click **Start**, type `PowerShell`, right-click **Windows PowerShell**, choose **Run as administrator**, then click **Yes**.
2. Paste this command:

   ```
   wsl --install -d Ubuntu
   ```

   **You should see** "Installing: Ubuntu", then a message that the operation succeeded and that you need to restart. If it says that virtualization is turned off, see [Troubleshooting](#troubleshooting).
3. Restart your PC.
4. After the restart, Ubuntu opens by itself. If it doesn't, click **Start**, type `Ubuntu`, and open it. When it asks for a **UNIX username**, type a short lowercase name (for example `adam`) and press Enter. Then choose a password and type it twice. Nothing appears while you type a password; that is normal. Write the password down: Ubuntu asks for it whenever you install a program (a command that starts with `sudo`).

   **You should see** a line like `adam@YOUR-PC:~$`.
5. To check that you have WSL **2**, open PowerShell (normally, not as administrator) and paste:

   ```
   wsl -l -v
   ```

   **You should see** a line with `Ubuntu` and the number `2` under VERSION. If the number is `1`, run `wsl --set-version Ubuntu 2`.

From now on, **the Ubuntu window** means: **Start**, type `Ubuntu`, and open it.

## Step 2: Install Docker Desktop

1. Download **Docker Desktop for Windows** from <https://www.docker.com/products/docker-desktop/>. Most PCs need the AMD64 version; choose ARM64 only if your PC has an ARM processor (such as Snapdragon).
2. Run the installer. Keep **Use WSL 2 instead of Hyper-V** checked. Restart if it asks.
3. Open Docker Desktop and accept the terms. You can skip signing in and skip the survey. Docker Desktop is free for personal use and for small companies. A company with 250 or more employees, or more than 10 million US dollars of yearly revenue, needs a paid Docker plan. Check Docker's current terms on its website if you are not sure.
4. Click the **gear icon** (Settings), top right:
   - **General:** check **Start Docker Desktop when you sign in to your computer**. **Use the WSL 2 based engine** should already be checked.
   - **Resources > WSL integration:** turn on **Ubuntu**, then click **Apply & restart**.
5. Wait until the bottom left of the Docker Desktop window shows **Engine running**. From now on, Docker Desktop must be running (open, or in the tray at the bottom right of the screen) whenever you use `mc`.
6. Close the Ubuntu window and open a new one. Paste:

   ```
   docker run --rm hello-world
   ```

   **You should see** `Hello from Docker!` among the lines. The first time, Docker downloads a small test image, so it needs the internet.

## Step 3: Download and build Mission Control

In the Ubuntu window:

1. Check that git is there. Git is the program that downloads Mission Control:

   ```
   git --version
   ```

   **You should see** a line like `git version 2.43.0`. If Ubuntu says `command not found`, install git. Ubuntu asks for your password (the one from Step 1; nothing appears while you type it):

   ```
   sudo apt update && sudo apt install -y git
   ```

2. Download Mission Control:

   ```
   cd ~ && git clone -b feat/any-task https://github.com/krybaby7/Mission-control.git
   ```

   This is the branch with the new work. Without `-b feat/any-task` you would get an older version that has no leader, no dashboard and no GitHub commands.

   **You should see** `Cloning into 'Mission-control'...` and then the prompt again. If it asks for a username and password, the project is private. Type your GitHub username. For the password you need a GitHub token, which is a long password that GitHub makes for you:

   - On github.com, click your picture, then **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens** > **Generate new token**.
   - Under **Repository access**, choose **Only select repositories** and pick Mission-control.
   - Under **Permissions** > **Repository permissions**, set **Contents** to **Read-only**.
   - Click **Generate token**, copy it, and paste it as the password. Nothing appears while you paste. Your normal GitHub password does not work here.

   If you do the GitHub login in [Optional: work on a repository on GitHub](#optional-work-on-a-repository-on-github) first, you need no token.

3. Create the `mc` shortcut, so you can type `mc` instead of the full script path:

   ```
   echo "alias mc='~/Mission-control/scripts/mc-docker.sh'" >> ~/.bashrc && source ~/.bashrc
   ```

   **You should see** nothing, just the prompt again. Now check the shortcut:

   ```
   mc help
   ```

   **You should see** a list that starts with `Usage: mc-docker.sh <command> [arguments...]`. `mc` is the shortcut for the script `mc-docker.sh`. It works in every Ubuntu window you open from now on.

4. Build the sealed box that Mission Control runs in (Docker calls it an image). Docker Desktop must be running. It downloads about 2 GB and takes 5 to 15 minutes the first time. Both numbers are guesses, because the image has not been built yet:

   ```
   mc build
   ```

   **You should see** many lines scroll by, ending with `mc-docker: the image is ready.`

From here on, most `mc ...` commands run inside the container, the sealed box. Five run in Ubuntu itself, outside the box: `mc get`, `mc publish-preview`, `mc publish`, `mc install-leader` and `mc leader`. `mc publish-preview` and `mc publish` still start a small read-only box for a moment, to read the mission's record, so Docker Desktop must be running for them. Until you finish Step 4, each command that runs inside the box also prints "not logged in to Claude yet" and "not logged in to Codex yet". That is expected.

## Step 4: Log in to Claude and Codex

You log in once. The logins are kept inside Docker, not in Windows, and they survive restarts and rebuilds.

### 4a. Claude

1. Paste:

   ```
   mc login-claude
   ```

2. Claude Code starts. Pick any text style with the arrow keys and press Enter.
3. Choose **Claude account with subscription**.
4. Claude shows a long sign-in link. Hold **Ctrl** and click it (or copy it into your browser). Sign in to Claude and click **Authorize**.
5. If the page shows a code, copy it, paste it into the Ubuntu window, and press Enter.

   **You should see** "Login successful". Press Enter through any remaining screens. If it asks whether you trust the files in this folder, choose **Yes**.
6. When you reach the Claude prompt (a box where you can type), type `/exit` and press Enter.

If Claude goes straight to its prompt without asking you to log in, type `/login`, press Enter, and continue from instruction 3.

### 4b. Codex

1. In the Ubuntu window, paste:

   ```
   mc login-codex
   ```

   **You should see** a web address (`https://auth.openai.com/codex/device`) and a one-time code (like `ABCD-1234`). The code expires after 15 minutes.
2. Open the address on your PC or iPad, sign in to ChatGPT, and enter the code. Approve when it asks: the warning about codes from other people is a general precaution, and here the code came from your own Ubuntu window.

   **You should see** `Successfully logged in` in the Ubuntu window, and then the prompt again.

   Most accounts allow this sign-in already; there is nothing to switch on first. If the code is refused, look in ChatGPT > **Settings** > **Security** for a device code option and turn it on.

## Step 5: Check the setup

1. Create the settings file:

   ```
   mc init
   ```

   **You should see** a line ending in `config.yaml`. That is where your settings live, inside the container.
2. Run the checks:

   ```
   mc doctor
   ```

   **You should see** a list of lines. ✓ means fine, `!` means a warning, and ✗ means a problem. The last line says `Everything looks good.`, or how many problems and warnings there are. One warning is expected until Step 6: `Notifications: Phone notifications are off.` Every other line that isn't ✓ explains how to fix it. Fix it, then run `mc doctor` again.
3. Run the live check:

   ```
   mc doctor --live
   ```

   This makes one tiny real request to each AI. It uses a little of your allowance and can take a minute or two.

   **You should see** ✓ lines for Claude, Codex and Haiku.

## Step 6: Get notifications on your iPad (ntfy)

ntfy is a free app that shows a notification when a run finishes, when something gets stuck, or when Mission Control needs you.

1. Make up a secret topic name. Anyone who knows it can read your notifications, so it should be hard to guess. In the Ubuntu window, paste:

   ```
   echo "mc-$(tr -dc 'a-z0-9' < /dev/urandom | head -c 16)"
   ```

   **You should see** something like `mc-k3v9x0q2m7b1t8zp`. Write it down exactly. This is your topic.
2. On the iPad, open the **App Store**, search for **ntfy**, and install it. Open it and allow notifications. Tap **+**, type your topic, keep the server as `ntfy.sh`, and tap **Subscribe**.
3. Tell Mission Control the address. Replace `<your-topic>` with your topic:

   ```
   mc config set notify.ntfyUrl https://ntfy.sh/<your-topic>
   ```

4. Check what Mission Control saved:

   ```
   mc config get notify.ntfyUrl
   ```

   **You should see** `https://ntfy.sh/` followed by your topic, spelled exactly as on the iPad. If it differs, repeat instruction 3. Running `mc doctor` again now shows no ntfy warning.
5. Send a test notification:

   ```
   curl -d "Hello from Mission Control" https://ntfy.sh/<your-topic>
   ```

   **You should see** the notification on your iPad within a few seconds. If Ubuntu says `curl: command not found`, run `sudo apt install -y curl` and try again.

You can also change settings by editing the file. Run `mc shell`, which opens a window inside the box (its prompt looks different from before). Then type `nano ~/.mission-control/config.yaml`. Save with **Ctrl+O** and Enter, quit with **Ctrl+X**, then type `exit` to leave the box.

## Step 7: Keep the PC awake while a run works

Mission Control only works while the PC is on and awake.

1. Open **Settings > System > Power** (on a laptop: **Power & battery**). Under **Screen, sleep, & hibernate timeouts** (or **Screen and sleep**), set sleep **when plugged in** to **Never**. Turning the screen off is fine.
2. On a laptop, keep it plugged in. In **Control Panel > Hardware and Sound > Power Options > Choose what closing the lid does**, set **When plugged in** to **Do nothing**.
3. Stop Windows Update from restarting during a run: **Settings > Windows Update > Advanced options > Active hours**, choose **Manually**, and set it to cover the hours when your runs happen.
4. While a run works, lock the screen (**Windows key + L**) if you like, but don't sign out or shut down. Docker Desktop must be running.

## Step 8: Queue work

Describe the app in plain words. The more detail you give, the better the result.

```
mc new "A habit tracker where I can add daily habits, tick them off each day, and see a weekly streak chart" --name "Habit tracker"
```

**You should see** `Queued your new app “Habit tracker”.` and the new mission's name, like `2026-10-09-habit-tracker`. Queuing only writes the work down. Nothing is built, and none of your Claude or ChatGPT allowance is used, until you start a run in Step 9. To see everything that's queued:

```
mc status
```

**You should see** a table with one line for each mission: its name, its status (`queued` for now) and how many features are done.

To change an app that already exists, its folder must be inside `~/mc-apps` (Mission Control's container sees no other folder; move or copy the app there first). Then:

```
mc feature ~/mc-apps/<app-folder> "Add a dark mode"
```

A project that lives on GitHub comes into `~/mc-apps` with `mc get`: see [Optional: work on a repository on GitHub](#optional-work-on-a-repository-on-github). You can also describe the job to the leader and let it queue the work: see [Optional: start the leader](#optional-start-the-leader).

**Read this before you queue writing, a page or a table.** Those jobs need an app that has code and its own checks: an app Mission Control built, or a project you downloaded with `mc get`. A folder that holds only documents can fail at the start, or finish with a hollow report. See [Documents, pages and data](#documents-pages-and-data).

## Step 9: Start a run

When you are ready to let the team work, in the Ubuntu window:

```
mc run
```

**You should see** a first line `Working until the queue is done (no stop time given).` and then progress lines. The run keeps going until all the queued work is done, or until you stop it. It also ends early if no work can go on (for example a full disk, or both AI logins expired), and it says why. If both AIs reach their usage limit, it waits for the limit to end and then carries on, which can take hours.

To make a run stop at a time you choose, add a stop time. It uses the 24-hour clock and your local time (07:00 is 7:00 AM, 17:00 is 5:00 PM):

```
mc run --until 17:00
```

Mission Control then works until that time, writes a report and notifies you. Minimize the window, but leave it open until the run ends: closing it cuts the run short. To see how it is going, run `mc status` in another Ubuntu window (open one the same way as the first), or open the dashboard (see [the dashboard](#optional-watch-the-team-on-a-web-page-the-dashboard)). To stop early, run `mc stop` in that other window. The run stops within a few minutes, keeps its saved progress, writes the report and notifies you. The AI step that is running is cancelled and done again on the next run, which can cost up to 45 minutes of its work.

Missions that were paused (by `mc stop`, by the stop time, or while the AIs were at their usage limits) continue automatically the next time you run this. Features that got stuck don't: once a mission is finished, its report's **Needs your decision** gives the command that queues them again, if you still want them. If the stop time you give has only just passed (say it is 17:20 and you give `--until 17:00`), the run would last almost a day, so Mission Control refuses to start: give a later time, such as `--until 19:00`. A mission that stopped because it needs your help (the report and `mc status` say so) waits for you: do what its report asks under **Needs your decision**, then continue it with `mc run --mission <mission>` (the mission's name as `mc status` shows it). If it only needed a new login, the next run continues it by itself.

A mission that you asked to stop for your look (see [Checking things yourself](#checking-things-yourself-optional)) stops at the place you asked for. So does every mission from a plan the leader wrote: it stops at the plan, before anything is built. Other missions carry on. When nothing else is left, the run ends with a line like `... is waiting for your check`. That is expected, not a failure.

### Optional: start a run automatically at a set time

Windows can start a run for you at a time you choose. This example starts one every day at 13:00 and stops it at 17:00. Change both times to what suits you. This part has not been tried on a real PC yet.

1. Click **Start**, type `Task Scheduler`, and open it. On the right, click **Create Task...** (not "Create Basic Task").
2. **General** tab: Name `Mission Control scheduled run`. Choose **Run only when user is logged on**.
3. **Triggers** tab: **New...** > **Daily**, start time `01:00:00 PM` > **OK**.
4. **Actions** tab: **New...** > **Start a program**.
   - **Program/script:** `wsl.exe`
   - **Add arguments:**

     ```
     -d Ubuntu -- bash -lc "~/Mission-control/scripts/mc-docker.sh run --until 17:00 >> ~/mc-run.log 2>&1"
     ```

   Click **OK**. If your Ubuntu has another name (check with `wsl -l -v` in PowerShell), write that name in place of `Ubuntu`.
5. **Conditions** tab: check **Wake the computer to run this task**. Click **OK**.
6. To test it, right-click the task and choose **Run**. This starts a real run, so it uses your allowance if work is queued. A black window opens and stays open while it works. Leave it open: closing it cuts the run short. In the Ubuntu window, `docker ps` **should show** `mission-control-run`. End the test with `mc stop`.

Only one run can happen at a time. If you start one by hand while the scheduled one is working, you'll see "a Mission Control run is already active". If Docker Desktop is still starting at the set time (say, after Windows restarted for an update), the scheduled run waits up to 5 minutes for it. If the scheduled run can't start at all (Docker Desktop isn't running, for example), your iPad gets a notification "Mission Control: the run didn't start" that says why. This works once a run has started at least once since you set up notifications in Step 6: each run that starts keeps a copy of the notification address in Ubuntu for this. The scheduled run's messages go to `~/mc-run.log`; read the end with `tail -n 50 ~/mc-run.log`.

## Checking things yourself (optional)

Some work is only right when you look at it yourself: how a page looks, whether the plan is what you meant. You can ask the team to stop at a place, show you what to look at, and carry on only after you answer. This part has not been tried on a real PC yet.

1. When you queue work, say where you want to look. There are three places, and you can ask for more than one:

   ```
   mc new "A habit tracker" --name "Habit tracker" --checkpoint plan --checkpoint final
   ```

   - `plan`: before anything is built. Nothing is spent on building until you have seen the plan.
   - `feature`: before each feature is added to the app (one stop for every feature).
   - `final`: when everything is built and checked, before the work is marked finished.

   **You should see** a line like `It will stop for your check: the plan, the finished app.` The same flag works with `mc feature`. Work queued without `--checkpoint` runs straight through, as before.

2. Start the run as usual. A mission that reaches a place you asked for stops there, on purpose. The other missions carry on, and the run ends when nothing else is left. You get a notification on your iPad ("please check the plan"), the end of the run says `... is waiting for your check`, and `mc status` shows `needs your check` for it.

3. Look at it. `mc report <mission>` starts with **Waiting for your check**: what the team made and what to look at. For a feature or the finished app it ends with the steps to open the work, the same steps as **How to try it** in a finished report (including putting the app's folder back afterwards). Nothing moves while it waits: the work is kept, and nothing is added to your app until you approve.

4. Answer it, in the Ubuntu window or by telling the leader. The two commands below are two different answers. Use one of them, not both. To say yes, carry on:

   ```
   mc approve <mission>
   ```

   To send it back with what to change:

   ```
   mc send-back <mission> --note "make the buttons bigger"
   ```

   **You should see** `Recorded: you approved the plan for “Habit tracker”.` and that it continues on the next run. Continue it with `mc run --mission <mission>`. A send-back needs a note that says what to change: the team changes it with your note and asks you again. You can send the same check back twice; a third send-back ends the work there (the plan: nothing will be built; a feature: it is set aside and the rest carries on; the finished app: the finished result is kept as it is), and the report says what to do next. You can still approve at any time.

5. An answer can only be recorded while no run is going. If one is, you see `A run is going right now, so the answer can't be recorded safely.` Wait until it ends (`mc status` shows), then try again. A mission that waits for you never holds a run up.

6. On the dashboard, a mission that waits has an amber card with an eye icon. It reads **“<name>”: please check the plan**, or **“<name>”: please check “<feature title>” before it is added** for a feature, or **“<name>”: please check the finished app**. It shows the lines the team wrote about what to look at, and two buttons, **Tell the leader: approve** and **Tell the leader: send it back**. They only give you a sentence to paste into the chat with the leader. The dashboard never approves anything. The leader asks you one more question before it runs `approve` or `send-back`, and Claude Code asks you on top of that.

### Plans the leader writes

For a small, clear job the leader can write the plan itself instead of leaving it to the team's planner (see [Optional: start the leader](#optional-start-the-leader)). It shows you the plan in the chat, with every check word for word and a short plan code, and asks one question, "Queue this plan and start the team on it?", before anything is queued. The team still builds each feature, has it reviewed, and checks the finished app. A feature checked by tests has its tests written first. The leader writing a plan has not been tried by anyone yet. In the real test runs a tester wrote each plan by hand, in the same format, and queued it the same way.

- A mission queued this way stops at the plan for your look before anything is built, even though you did not ask for it with `--checkpoint`. You answer it as in the steps above. The leader skips this stop only if you tell it you do not want to look at its plans, it asks one more question ("Skip your look at this plan? ..."), and you say a clear yes.
- The leader reads the whole plan to you again at the stop. You can also read it yourself, without the leader. In an Ubuntu window, this prints all of it, with the plan code, every check, the choices made for you, whether the team's plan reviewer or you changed it, and the checks that were removed or added:

  ```
  mc plan show <mission>
  ```

  `mc report <mission>` shows only the first 40 lines, which can cut a long plan. In Windows, `mc copy-reports` copies the reports to `~/mc-reports` (it prints the folder's Windows address). The whole text is the file `missions\<mission>\report.md` inside that folder.
- Asking for the same plan twice does not queue it twice while the first one has not finished. Mission Control says `This plan is already queued as “<name>” (<id>). See it with: mc status`, and the leader tells you in plain words that it is waiting already.
- The plan code is the same in the leader's message, in `mc plan show` and in the report. It always names the plan as the leader wrote it: if it differs from the one the leader quoted when it asked you, what was queued is not the plan you were shown. `mc plan show` also says whether the team's plan reviewer or your note changed the plan since.

What this protects, and what it doesn't. A check is a place where you look, not a lock. The AI team runs as the same Ubuntu user as Mission Control, so a determined one could write an approval itself. That could only skip your look: every test and review still runs, and nothing that fails is added. Mission Control keeps a record of each answer, distrusts a waiting check that shows an answer with no record, and sends a notice to your iPad each time an answer is recorded, so one you didn't give shows up there.

### Documents, pages and data

For work that is not code (a guide, a page, a table), the leader can write a plan that says how each feature is checked. Nothing here has been tried on a real PC. A real Claude has done small test jobs of this kind in a cloud test machine (a guide, a web page and a table). They found faults, some of them serious. Most were fixed, and three are not fully fixed (see [docs/real-runs.md](real-runs.md)). Only the web page job was run again after its fixes, so most of the fixes were tested here only. The other company's AI, Codex, has never done one. [docs/work-modes.md](work-modes.md) is the full guide.

- **Read this first: use an app that has code and checks.** A job of writing, a page or a table needs an app folder that already holds code and has its own checks: an app Mission Control built, or a project you took with `mc get`. Do not point it at a folder that holds only documents. That can fail at the start, or finish with a report that looks fine although nothing checked the project. The bullet about folders that hold only documents, further down, says more.
- For each feature the leader tells you one of three lines: "Checked by tests.", "Checked by a second AI against this list.", or "Checked by a second AI against this list, and then by you." In the last case the team stops before it adds the feature, so that you can look at it. The plan file cannot turn that stop off. The leader asks "Skip your look at these features? The team will add them without stopping for you. Yes or no?" before it does, and only the command `mc plan queue - --no-owner-checkpoint` can.
- If the second AI cannot judge one of the checks, the team stops for your look at that feature too.
- At the stop, `mc plan show <mission>` lists what the second AI found, check by check. For a web page the team takes pictures at phone width and at desktop width. In Windows, run `mc copy-reports` in the Ubuntu window. It prints the address of the `mc-reports` folder, and the pictures are in `missions\<mission>\screenshots` inside it. The report lists them too. The dashboard shows no picture.
- When a finished feature was checked another way than by tests, the top of the report has a line `Checked:` that says how many features were checked in each way, and the draft pull request on GitHub copies it. Mission Control says "approved by you" for your answer, because that is what it records. It cannot know that you opened a file.
- Before a job that reads a file you named, the leader asks "Does this file hold personal data, customer details or private papers? Yes or no?". If you open a data file that a script wrote, open it in a text editor first, and if Excel asks, do not press "Enable Editing" or "Enable Content" until you have read the cells (this was not tried on a PC).
- Pages that need a running server get no pictures. A job that needs facts from the internet, with sources, is not covered.
- A folder that holds only documents can fail at the start, or finish with a hollow report. This was tried only with a stand-in for the team's AI that works out how to check a project, so what the real one answers is not known. Three things can happen:
  - The folder must be a git repository (a folder that keeps the history of its files). If it is not, `mc plan queue` queues nothing and says so. To make it one, when no run is working, give git your name once (use your own), then, inside that folder, start the history and save your files into it:

    ```
    git config --global user.name "Your Name"
    git config --global user.email "you@example.com"
    cd ~/mc-apps/<folder> && git init -b main && git add . && git commit -m "My files"
    ```
  - If the team's AI finds no way to check the project, the mission stops at the start with “Could not work out how to check this project”. It asks you to add a short note on how to run the checks to the README or AGENTS.md, and then to run `mc run --mission <mission>`.
  - If the team's AI answers with a command that checks nothing, the mission can finish. The report's “How to try it” then names that command as the project's own checks, and the dashboard says that the final checks of the whole app passed, although the command checked nothing. The second AI and Mission Control's own checks still ran on each feature.

  [docs/work-modes.md](work-modes.md) has the same limit.
- Features that run side by side are deferred, and not built. Mission Control is made for one feature at a time. It has one loop over the features. It keeps one copy of the mission in memory, which is written whole at every save. It has one run lock and one line of merges into a single branch. Its pacing assumes one AI call at a time. Its timeline and stops assume one feature is in flight. Running features side by side would need separate working copies and a rule for merge conflicts (who settles them?). It would also need saves that cannot overwrite each other, a resume that copes with several half-finished features, and pacing across calls that overlap. Thousands of tests assume a fixed order, so doing it would also make them unreliable. The gain is clock time on big jobs with many features. The use of the allowance is the same, and most small jobs have one to three features. It waits until real use shows that it is needed.

## Step 10: When the run has finished

1. Your iPad shows a ntfy notification titled “Run finished”, with a short summary.
2. Read the latest report:

   ```
   mc report
   ```

   **You should see** the start of the report: how it went, what you can do now, how to try the app, and any decisions it needs from you. If the run worked on several missions, you see the run summary instead: each mission's result, what they need from you, and the command for each one's own report, such as `mc report 2026-10-09-habit-tracker`.
3. To read the full reports in Windows:

   ```
   mc copy-reports
   ```

   It prints a folder address like `\\wsl.localhost\Ubuntu\home\adam\mc-reports`. Paste it into the address bar of **File Explorer**. Open `reports\latest.md` with Notepad (the run summaries are the `reports\run-<date>.md` files). Notepad shows the report's pictures as lines of text: the screenshots themselves are picture files in `missions\<mission>\screenshots`.
4. Try the app:

   ```
   mc shell
   ```

   Then type the commands from the report's **How to try it** section, one at a time. When the app says it's ready, open <http://localhost:3000> in your Windows browser. When you're done, press **Ctrl+C** to stop the app, run the `git checkout ...` command the report gives to put the app's folder back on your own version (if it gave one), and type `exit`. For a change to an app you already had, the report also says how to keep the change. For a guide or a web page there is no app to start: the section ends with the name of the file to open (for example `docs/USAGE.md`), and gives its Windows path.

Your apps' files are in File Explorer at `\\wsl.localhost\Ubuntu\home\<your-ubuntu-name>\mc-apps`.

**Next: try it yourself.** [docs/owner-trial-checklist.md](owner-trial-checklist.md) is a short list of small jobs to try on your own PC. Each step says what you should see, what it proves and what nobody has tried yet, and the last step says what to send back if something fails. [docs/real-runs.md](real-runs.md) is the record of the real test runs that came before it.

## Optional: watch the team on a web page (the dashboard)

The dashboard is a web page that shows, in plain words, whether the team is working, how far along it is, whether anything needs you, and what you got. It only reads Mission Control's files: it can't change, stop or start anything. This part has not been tried on a real PC yet.

1. Open a second Ubuntu window (leave the one with the run alone) and run:

   ```
   mc dashboard
   ```

   **You should see** a line like `mc-docker: the dashboard is at http://localhost:8787 (Ctrl+C to stop)`. Leave the window open. The dashboard runs in a container of its own, which can only read Mission Control's notes and reports.

2. Open <http://localhost:8787> in your Windows browser. The page has four tabs: **Now**, **Needs you**, **Timeline** and **Results**. It asks for news every few seconds. If it can't, it says **Not updating**, and after a few minutes **Not responding**.

3. If you gave the run a stop time, you can show it. Start the dashboard with the same time:

   ```
   mc dashboard --until 17:00
   ```

   `--until` is only a stop time to show. Mission Control doesn't save the run's stop time, so without `--until` the page shows no stop time and no countdown. A run started without a stop time keeps going until the queued work is done, or until no work can go on.

4. To stop the dashboard, press **Ctrl+C** in its window. If the window is gone and it is still running, `docker stop mission-control-dashboard` stops it.

After you update Mission Control (see [Updating Mission Control](#updating-mission-control)), run `mc build` before starting the dashboard: the page is part of the image.

There is no password, by design. Anyone who can open the page can see your missions' names and progress.

### From the iPad

**Whether the iPad can open the dashboard through WSL2 and the Windows firewall has not been tried, so this guide doesn't say how to do it.** These are the facts that are known:

- `mc dashboard` makes the page available on the PC itself only.
- `mc dashboard --lan` makes it available on every network interface of the PC, so any device on the same network that has the PC's address and port 8787 can open it. The address would be the PC's own address on your network (Windows shows it with the `ipconfig` command).
- The page is plain `http`, with no password.
- Windows, Docker Desktop and WSL2 each sit between the iPad and the page. Nobody has checked what they let through.

If the page doesn't open on the iPad, the leader (next section) can tell you how the work is going in words, and the ntfy notifications from Step 6 don't depend on the dashboard.

## Optional: start the leader

The leader is a Claude Code session that you talk to in plain words, like “How is it going?”, “Add a dark mode to the habit tracker” or “Please stop the current run.” It acts only through the same `mc` commands you use: status, logs, report, stop, new, feature, plan, run, approve and send-back. Three more work with GitHub: get, publish-preview and publish (see [Optional: work on a repository on GitHub](#optional-work-on-a-repository-on-github)).

Claude Code asks you before the leader stops the run, starts the team working, queues a new app or a change, queues a plan it wrote, downloads from GitHub, uploads to GitHub or answers a check. Answer Yes once. Never choose "Yes, and don't ask again": it saves a rule that nobody has reviewed, and for a plan the rule would be the text of that one plan, which is of no use. Before it answers a check, the leader also asks you in the chat; see [Checking things yourself](#checking-things-yourself-optional). It can't reopen a feature that got stuck or change a plan. For those it queues a follow-up request that starts on the next run.

Nobody has tried this part yet, on a PC or anywhere else.

1. Install Claude Code in Ubuntu itself. The copy inside Mission Control's container can't be used. Anthropic's page for this is <https://code.claude.com/docs/en/setup>. For WSL it gives this command, which you paste in the Ubuntu window:

   ```
   curl -fsSL https://claude.ai/install.sh | bash
   ```

   It shows no progress while it downloads. When the prompt comes back, close the Ubuntu window, open a new one, and check:

   ```
   claude --version
   ```

   **You should see** a version number. If Ubuntu says `command not found`, the folder it was installed into is not on Ubuntu's list of places to look yet. Anthropic's page explains how to fix that, under "Fix your PATH". This was read from Anthropic's page and was not run on Windows. You log in the first time you start the leader (the next instruction). The leader's chat uses the same Claude plan as the team's runs.

2. In the Ubuntu window, once, tell Mission Control to remember where it is (it needs no Docker):

   ```
   mc install-leader
   ```

   **You should see** `mc-docker: saved that Mission Control is in /home/<you>/Mission-control.` Then start the leader:

   ```
   mc leader
   ```

   This starts Claude Code inside the `leader` folder of your copy of Mission Control, wherever you are, with Remote Control on (step 4 says what that is). To start it without Remote Control, run `mc leader --no-remote`. Do that too if Claude Code complains about Remote Control when you start it. Starting it by hand also works, if you go into the folder first: `cd ~/Mission-control/leader && claude`. The leader has to start inside that folder, because its commands are written `../scripts/mc-docker.sh ...` and its permission rules match that exact text.

   The first time, Claude Code asks you to pick a text style, to log in (a long link appears: hold **Ctrl** and click it, as in Step 4a), and whether you trust the folder (answer yes). If you started it with Remote Control it also asks "Enable Remote Control? (y/n)"; see instruction 4. Then you see a box where you can type. Type `How is it going?` and press Enter. Docker Desktop must be running, or the leader cannot see the work. The folder's `CLAUDE.md` and `.claude/settings.json` give the leader its instructions and limits; [leader/README.md](../leader/README.md) explains them.

3. On the dashboard, the **Tell the leader about this** buttons (on cards and features) and **Tell the leader anything** (on the bar) give you a ready sentence. Copy it and paste it into the chat with the leader.

4. Optional: to talk to the same leader from the Claude app on your iPad or phone, start it with `mc leader` (step 2), which runs this command in the right folder for you. By hand it is:

   ```
   cd ~/Mission-control/leader && claude --remote-control "Leader"
   ```

   This is one session: you can type to it in the Ubuntu window, and the same session is open in the Claude app (tap **Code**) or in a browser at claude.ai/code, where it is listed as "Leader" with a computer icon and a green dot. Already running the leader? Type `/remote-control Leader` in it instead.

   Do not use `claude remote-control` for this. That is a different mode: it starts its own session that you can open from the app or claude.ai/code, but you cannot type to it in that Ubuntu window.

   It needs a claude.ai login (Pro, Max, Team or Enterprise); API keys do not work. On Team or Enterprise, an Owner must first turn on Remote Control in the Claude Code admin settings. The first time, Claude Code asks "Enable Remote Control? (y/n)" and whether you trust the folder; answer yes. Keep the Ubuntu window open and the PC awake. Remote Control has not been tried here: whether the session appears, and what you can do in it from the app, is unverified. These steps follow Anthropic's Remote Control documentation (https://code.claude.com/docs/en/remote-control).

If you ask the leader to start the team working, it runs `mc run` as a background task of the chat. It adds a stop time (`--until`) only if you give one; without one, the run keeps going until the queued work is done or you ask it to stop (it also ends early if no work can go on, for example a full disk or every AI login expired). If the chat session ends, the run may stop too; its progress is kept and the next run continues (not tried). For a run that must not depend on a chat, use Step 9 or the scheduled run.

## Optional: start the leader and the dashboard with one click

Two small files open Ubuntu for you and start the leader or the dashboard, so you do not have to type anything. They are in the `scripts/windows` folder of Mission Control. **This part has not been tried here: there was no Windows PC and no WSL to try the shortcut files on.** Before you use them, Docker Desktop must be running, and for the leader you must have done instruction 1 of [Optional: start the leader](#optional-start-the-leader) (Claude Code installed in Ubuntu).

1. In the Ubuntu window, once (it needs no Docker):

   ```
   mc install-leader
   ```

   **You should see** `mc-docker: saved that Mission Control is in ...` and `put the launcher at ~/.config/mission-control/launch`. This saves where Mission Control is, so the shortcuts find it from anywhere.
2. In Windows, open **File Explorer** and paste this into the address bar. Replace `<your-ubuntu-name>` with your Ubuntu user name (the one in `adam@YOUR-PC`):

   ```
   \\wsl.localhost\Ubuntu\home\<your-ubuntu-name>\Mission-control\scripts\windows
   ```

   **You should see** four files. Use only the two whose names start with `start-`: `start-leader` and `start-dashboard` (Windows may hide the `.cmd` ending). Leave the other two where they are. `mc-launch.sh` is used by the other two, and `.gitattributes` only tells git how to keep the line endings.
3. Copy both `start-` files and paste them on your Windows Desktop. (Or right-click one, choose **Show more options**, then **Send to**, then **Desktop (create shortcut)**. Rename the shortcut as you like.)
4. Double-click **start-leader**. Windows may ask whether you are sure you want to run it, because it is a script. It is a few lines of text that you can read first with Notepad (right-click, **Show more options**, **Edit**). What Windows shows was not tried. A black window opens, Ubuntu starts, and then Claude Code starts the leader. The first time it asks you to log in and to trust the folder: answer as in [Optional: start the leader](#optional-start-the-leader).
5. Double-click **start-dashboard**. The window prints `the dashboard is at http://localhost:8787`: open that address in your browser. Close the window, or press **Ctrl+C**, to stop it.

If your Ubuntu has another name (check with `wsl -l -v` in PowerShell), open the `.cmd` file with Notepad and change the word after `DISTRO=`. Use the same name in place of `Ubuntu` in the folder address in instruction 2.

If you moved Mission Control, or downloaded it again, open the Ubuntu window, go into the new folder (`cd` followed by its path), and run `scripts/mc-docker.sh install-leader` once more. Use that, not `mc`: the `mc` shortcut still points to the old folder. If the new folder is not `~/Mission-control`, also fix the shortcut: type `nano ~/.bashrc`, change the path in the line that starts with `alias mc=`, save with **Ctrl+O** and Enter, quit with **Ctrl+X**, and open a new Ubuntu window. If you do not run `install-leader` again, the shortcut says `I can't find Mission Control in ...` and what to run. Files copied to the Desktop keep working after you update Mission Control: they only call the launcher.

The leader's commands keep working because the shortcut always starts the leader inside the `leader` folder of the copy that `mc install-leader` saved. Nothing about the leader's permissions changes.

## Optional: work on a repository on GitHub

Mission Control can bring a project from GitHub to your PC, let the team work on it, and send the result back as a **draft pull request** (GitHub's way of asking "please add this work", not merged until you merge it yourself). This uses **your own** GitHub login, on the PC. With these commands the box where the team works never gets a password or a token. **This part has not been tried against a real GitHub**: it was tested with a stand-in for GitHub and a stand-in for the `gh` program. The longer guide, with every message you may see, is [docs/github-setup.md](github-setup.md).

1. You need git (you checked it in Step 3). Install the GitHub tool `gh` from <https://cli.github.com>: on that page, find the Linux steps for Debian and Ubuntu, copy the whole block, paste it in the Ubuntu window and press Enter. It asks for your Ubuntu password. Then check:

   ```
   gh --version
   ```

   **You should see** a version number. These steps come from GitHub's page and were not run here. Without `gh`, `mc publish` still uploads the branch, and you open the pull request yourself.
2. Log in to GitHub, once, in your own Ubuntu window (not through the leader):

   ```
   gh auth login
   ```

   Choose **GitHub.com**, **HTTPS**, and **Login with a web browser**, and say yes when it asks about git. It shows a one-time code and a web address. Open the address in your Windows browser and type the code. If Ubuntu tries to open a browser by itself and nothing happens, that is fine. Then:

   ```
   gh auth setup-git
   ```

   and check with `gh auth status`: **you should see** that you are logged in to github.com.
3. Download a repository into `~/mc-apps`:

   ```
   mc get acme/widgets
   ```

   **You should see** `mc-docker: downloaded acme/widgets into ~/mc-apps/widgets.` and the next step. Only github.com is accepted. A folder that exists is never overwritten. Then queue work on it as usual: `mc feature ~/mc-apps/widgets "Add a dark mode"`, or ask the leader. If the repository holds only documents and no code, see the limit in [Documents, pages and data](#documents-pages-and-data).
4. When a mission that changes an existing project has finished (its name is in `mc status`, like `2026-10-12-dark-mode`), first look at where it would go. This uploads nothing, but Docker Desktop must be running, because the mission's record is read inside a small box:

   ```
   mc publish-preview <mission>
   ```

   **You should see** `It would go to github.com/acme/widgets`. Check that this is the repository you mean. Then send it, with that name after `--to`:

   ```
   mc publish <mission> --to acme/widgets
   ```

   **You should see** `mc-docker: draft pull request: https://github.com/...`. It uploads only the branch `mc/<mission>`, never the main branch, never with force, and a partly finished mission is sent as a draft that lists what is not finished. Open the address, read the draft, and merge it on github.com when you are happy.

   A project that Mission Control built from nothing is different: it has no pull request on its first trip. `mc publish-preview` says `... is a new app` and prints the two git commands that put the whole app on GitHub, once. The steps are in [docs/github-setup.md](github-setup.md).

The leader can do steps 3 and 4 for you ("Work on my repo acme/widgets and send it to GitHub"). It asks you a plain question before each one, and Claude Code asks you again. It never sees your login.

## Optional: upload finished work to GitHub

This is the older way, where Mission Control uploads each finished branch by itself. **Prefer `mc publish` (the section above):** it needs no token saved in the app's folder. Use the older way only if you want the team to upload without you asking. `mc publish` refuses an app whose GitHub address has a token inside it, which is what this older way writes.

Out of the box, Mission Control keeps everything on your PC. If you turn uploading on, each finished mission's branch (`mc/<mission>`) goes to the app's repository on GitHub. Mission Control never uploads `main` and never overwrites what is already there, and it doesn't run the app's git hooks while uploading.

**Read this first.** To upload, the container needs a GitHub token, and it has to be saved in the app's folder, where the agents work. So a misbehaving agent can read the token and use it itself, for anything the token allows; Mission Control's own care only covers what Mission Control does. That is why the token must be limited to that one repository, and why GitHub itself must refuse changes to `main`. If you can't do both, leave uploading off.

Do this once for each app, at a time when no run is working:

1. On <https://github.com>, open the app's repository. For an app Mission Control built, create one first: **+** (top right) > **New repository**, give it a name, and leave **Add README**, **.gitignore** and **license** off, so it starts empty.
2. Create a token for that repository only: your picture > **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens** > **Generate new token**.
   - **Token name:** for example `mission-control-<app>`. **Expiration:** 90 days is a good choice.
   - **Repository access:** **Only select repositories**, and pick this one repository.
   - **Permissions:** give **Contents** the access **Read and write**, and nothing else (GitHub adds **Metadata: Read-only** by itself).
   - Click **Generate token** and copy it (it starts with `github_pat_`). Make a separate token for each app.
3. Save the address with the token in the app's folder. Open `mc shell`, then paste this with your own values in place of the placeholders:

   ```
   git -C ~/mc-apps/<app-folder> remote add origin https://<github-username>:<token>@github.com/<github-username>/<repository>.git
   ```

   **You should see** nothing, just the prompt again. If it says `remote origin already exists` (an app you got from GitHub), paste it again with `set-url` in place of `add`.
4. If you created the repository in instruction 1, upload the app once yourself, still in `mc shell`:

   ```
   git -C ~/mc-apps/<app-folder> push origin main
   ```

   **You should see** a few lines ending in `main -> main`. Then type `exit`.
5. Make GitHub protect `main`. In the repository on github.com: **Settings** > **Rules** > **Rulesets** > **New ruleset** > **New branch ruleset**.
   - **Ruleset Name:** `protect main`. **Enforcement status:** **Active**.
   - **Bypass list:** leave it empty. The token acts as you, so anything you are allowed to skip, it can skip too.
   - **Target branches:** **Add target** > **Include default branch**.
   - **Rules:** check **Restrict deletions**, **Block force pushes** and **Require a pull request before merging**.
   - Click **Create**. If GitHub says the rules won't be enforced (private repositories on the free plan), nothing on GitHub stops an agent with the token from changing `main`: remove the token (instruction 2's page, **Delete**) and leave uploading off for this app.
6. Turn uploading on (once, for all apps):

   ```
   mc config set git.push true
   ```

To bring a mission's work into `main`, open the repository on github.com, click **Compare & pull request** next to the `mc/...` branch, then **Create pull request** and **Merge pull request**. When the token expires, make a new one (instruction 2) and save it with `set-url` (instruction 3). An app without a GitHub address just gets a note in its report that it wasn't uploaded.

## Updating Mission Control

```
cd ~/Mission-control && git pull && mc build && mc install-leader
```

`git pull` stays on the branch you downloaded in Step 3. Docker Desktop must be running. Your logins, missions and apps are kept. If the project is private, `git pull` asks for your GitHub username and token again, as in Step 3 (tokens expire: make a new one when it is refused).

## Troubleshooting

| What you see | What to do |
|---|---|
| `Docker isn't running` | Start Docker Desktop and wait until it shows **Engine running** (bottom left). Then try again. |
| `Docker isn't available in Ubuntu`, or `docker: command not found` | Usually Docker Desktop isn't running: start it and wait until it shows **Engine running** (bottom left), then try again. If it was already running: in Docker Desktop, **Settings > Resources > WSL integration**, turn on **Ubuntu**, then **Apply & restart**. Open a new Ubuntu window. |
| `WslRegisterDistribution failed`, or a message that virtualization is turned off, when you run `wsl --install` in Step 1 | WSL2 needs "virtualization" to be switched on in your PC's startup settings (the UEFI or BIOS screen). On many PCs it is called Intel VT-x, AMD-V or SVM Mode. How to open that screen depends on the PC maker: search the web for your PC's make and model and "turn on virtualization". Then run `wsl --install -d Ubuntu` again. This was taken from Microsoft's documentation and was not tried. |
| `git: command not found`, or `curl: command not found` | Install it. Ubuntu asks for your password: `sudo apt update && sudo apt install -y git curl`. |
| `mc: command not found` | Run `source ~/.bashrc`. If that doesn't help, repeat Step 3, instruction 3. |
| `the Mission Control image isn't built yet` | Run `mc build`. |
| `not logged in to Claude yet` or `not logged in to Codex yet`, or `mc doctor --live` says `Not logged in` (plain `mc doctor` only checks that a login is stored, not that it still works) | Log in again: `mc login-claude` or `mc login-codex`. Logins sometimes expire; that's normal. Missions that stopped because of it continue by themselves on the next `mc run`. |
| A mission is "Stopped, needs your help", or `mc status` shows it `failed` | Read what it needs: `mc report <mission>`, under **Needs your decision**. Do that, then continue it: `mc run --mission <mission>`. `mc status` shows the mission names. |
| "paused, the disk is almost full" | Free some space: delete apps you no longer need from `~/mc-apps`, or run `docker system prune` to clear old Docker data. Then run `mc run` again; it continues where it paused. |
| "Mission Control stopped unexpectedly" | The last run ended without finishing (the PC restarted, Docker Desktop stopped, or the power went out). Nothing is lost: the work so far is kept and continues. If it keeps happening, check Step 7 and that Docker Desktop stays running. |
| The Codex code is refused | Codes expire after 15 minutes: run `mc login-codex` again for a fresh one. If it's still refused, look for a device code option in ChatGPT > Settings > Security and turn it on. |
| "You've hit your limit", or `mc status` shows a mission waiting | Nothing to do. Mission Control notices limits, switches to the other AI when allowed, or waits until the limit resets and carries on. If it happens on every run, queue less work. |
| "Waiting for the AIs to respond", or "paused, the AI isn't working" | The internet connection or an AI service had a problem, or an AI command line keeps failing. Nothing was lost and nothing counted against the work. Check that the PC is online, then run `mc doctor --live`. The next `mc run` carries on where it paused. |
| `mc status` shows a mission `needs your check`, or the end of a run says `is waiting for your check` | You asked the team to stop there (`--checkpoint`), or the leader wrote the plan, which stops at the plan by default. Look at it with `mc report <mission>` (for a plan the leader wrote, `mc plan show <mission>` prints all of it), then `mc approve <mission>` or `mc send-back <mission> --note "what to change"`. See [Checking things yourself](#checking-things-yourself-optional). |
| `A run is going right now, so the answer can't be recorded safely` | `mc approve` and `mc send-back` only work while no run is going. Wait until the run ends (`mc status`), then try again. |
| `is not waiting for your check, so there is nothing to answer`, or `You already answered this check` | The check was answered already, or the mission isn't stopped for one. `mc status` shows what it is doing. After an answer, continue it with `mc run --mission <mission>`. |
| You want to stop a run | In another Ubuntu window: `mc stop`. It stops the run now. The AI step that is running is cancelled and done again on the next run, which can cost up to 45 minutes of its work. Everything saved is kept, and the next `mc run` continues. If it hasn't stopped after a few minutes: `docker stop mission-control-run`. |
| `a Mission Control run is already active` | One is already working, maybe the scheduled one. Check with `mc status`, or stop it with `mc stop`. If `docker ps` doesn't list `mission-control-run`, the last run was cut off: wait 5 minutes and try again. |
| `mc status` shows a mission `interrupted` | The last run ended without finishing (it was stopped with `docker stop`, or the PC or Docker Desktop restarted). Nothing is lost: the next `mc run` continues it. |
| `this run would work until 17:00 tomorrow` (with the time you gave) | The stop time you gave had only just passed, so the run would have lasted almost a day. Nothing was started. Give a later time, such as `mc run --until 19:00`, or start without a stop time: `mc run`. |
| `Mission Control can only change apps inside ~/mc-apps`, or `There is no folder at ...` | Move or copy the app's folder into `~/mc-apps`, then use its path there: `mc feature ~/mc-apps/<app-folder> "..."`. |
| `has no branch checked out` when running `mc feature` | The app's folder is still on a version you were trying from a report. Run the `git -C ... checkout ...` command it prints, then try again. |
| `mc doctor` says `Not checked: a run is working right now` | It leaves the AIs alone while a run uses the same logins. Run it again after the run ends. |
| `cannot write to /home/pwuser/.claude` (or `.codex`, or `.mission-control`) | Run `mc fix-permissions`. |
| `cannot write to /home/pwuser/mc-apps` | Run the command it prints: `sudo chown -R "$USER": ~/mc-apps && mc build`. |
| `port is already allocated` when running `mc shell` | Another `mc shell` window is open. Close it first. |
| http://localhost:3000 doesn't open | Check that the app is still running in the `mc shell` window. If it is, stop it with **Ctrl+C** and start it again with `npm run dev -- --hostname 0.0.0.0`. |
| `the dashboard is already running` | One dashboard is open already. Use the address it printed when it started, or stop it with `docker stop mission-control-dashboard`. |
| `port is already allocated` when running `mc dashboard` | Port 8787 is in use, maybe by a dashboard in another window. Close that one, or choose another port: `mc dashboard --port 8788`, and open <http://localhost:8788>. |
| http://localhost:8787 doesn't open | Check that the dashboard window is still open and shows the address. If you updated Mission Control, run `mc build` and start the dashboard again. From the iPad, see [From the iPad](#from-the-ipad): it has not been tried. |
| The dashboard says **Not updating** or **Not responding** | The page has lost touch with the dashboard window. Check that the window is open and the PC is awake, then reload the page. |
| Nothing happened, or "Mission Control: the run didn't start" | The notification and the end of `~/mc-run.log` (`tail -n 50 ~/mc-run.log`) say why; look that message up in this table. Without either, the scheduled run didn't run at all: was the PC asleep, restarted, or signed out (Step 7)? Also make sure Docker Desktop starts when you sign in (Step 2). |
| The report says `Could not push mc/...` | Uploading is on (see [Optional: upload finished work to GitHub](#optional-upload-finished-work-to-github)). With `no remote`: the app has no GitHub address yet; follow instructions 1 to 3 there, or ignore it. With `Authentication failed`, `could not read Username`, `403` or `denied`: the token expired or can't write to that repository; make a new one (instruction 2) and save it with `set-url` (instruction 3). With `pre-push hook`: the app has its own git hook that runs before uploads (some projects use one for big files, called Git LFS, or for checks), and Mission Control never runs an app's hooks, so it didn't upload. Upload it yourself in the Ubuntu window when no run is working: `git -C ~/mc-apps/<app-folder> push origin mc/<mission>`. |
| No notification on the iPad | Repeat the test in Step 6, instruction 5. Check that notifications are allowed for ntfy in the iPad's Settings. Check the address with `mc config get notify.ntfyUrl`. |
| `couldn't tell your timezone, so times such as 07:00 mean UTC` | Run `sudo dpkg-reconfigure tzdata` and pick your region and city. |
| `Mission Control only works with github.com` or `I don't understand "..." as a GitHub repository` | `mc get` takes `owner/repo`, `https://github.com/owner/repo` or `git@github.com:owner/repo.git`. See [docs/github-setup.md](github-setup.md) for every message of `mc get` and `mc publish`. |
| `I could not download owner/repo` | Check the name. A private repository needs your login: run `gh auth login`, then `gh auth setup-git`, in your own Ubuntu window. See [Optional: work on a repository on GitHub](#optional-work-on-a-repository-on-github). |
| `... is a new app`, `... has no GitHub address yet`, or `... is not a plain github.com address`, when you run `mc publish-preview` or `mc publish` | A new app goes to GitHub once, as a whole, with two git commands that the message prints, after you made an empty repository on github.com. An app without an address needs the same first steps. The address must be written without a login inside it. The steps are in [docs/github-setup.md](github-setup.md). |
| `... was set up for owner/repo, but its GitHub address now says ...` | The address in the app's folder is not the repository the folder came from. The team can write in that folder, so look before you go on: `cat ~/mc-apps/<app>/.git/config`. The steps are in [docs/github-setup.md](github-setup.md). |
| The shortcut window shows `I can't find Mission Control in ...` | You moved Mission Control or downloaded it again. Open the new folder in Ubuntu and run `scripts/mc-docker.sh install-leader` (or `mc install-leader`). |
| The shortcut window closes at once, or says `The leader did not start` | Read the message above that line. If the launcher is missing, run `mc install-leader` once in an Ubuntu window. If Ubuntu has another name, change the word after `DISTRO=` in the `.cmd` file (see [Optional: start the leader and the dashboard with one click](#optional-start-the-leader-and-the-dashboard-with-one-click)). |
| `Claude Code isn't installed in Ubuntu itself` when you run `mc leader` | Install Claude Code in Ubuntu (see [Optional: start the leader](#optional-start-the-leader)), log in, and try again. |
| You want to start over: forget the logins, missions and reports | `docker volume rm mc-claude mc-codex mc-home mc-browsers` deletes them for good (your apps in `~/mc-apps` are kept; `mc-browsers` only holds test browsers, which come back by themselves). Then repeat Steps 4 to 6. |
