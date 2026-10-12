# Set up Mission Control on Windows 11

Mission Control builds your app ideas overnight with Claude Code and Codex, working inside a sealed box (a Docker container) on your PC. You set it up once. After that, the routine is: describe an idea, start a run before bed, and read the report in the morning. Your iPad buzzes when the night's work is done.

**What you need**

- A Windows 11 PC that can stay on overnight, ideally with 16 GB of memory, and with 30 GB of free disk space.
- A paid Claude plan (Pro or Max) and a paid ChatGPT plan (Plus or higher, which includes Codex).
- An iPad (or iPhone) for notifications.
- About an hour, mostly spent waiting for downloads.

**How to use this guide**

- Gray boxes are commands. Copy the whole box, paste it into the window named in the step (in the Ubuntu window, right-click to paste), and press Enter.
- **You should see** tells you what success looks like. If you see something else, look it up in [Troubleshooting](#troubleshooting).
- Text in `<angle brackets>` is a placeholder. Replace all of it, brackets included.

## What the container protects you from, and what it doesn't

Mission Control lets AI agents run commands all night without asking you first. To make that safe enough, they work inside a Docker container: a sealed box on your PC. Inside the box, the agents can see only:

- your apps folder (`~/mc-apps` in Ubuntu), where they build your apps;
- the Claude and Codex logins;
- Mission Control's own notes and reports.

**It protects** your Windows files (Documents, Pictures, Desktop), your browsers and saved passwords, and everything else in Ubuntu. If an agent runs a harmful command such as "delete everything", the damage stays in the box and in `~/mc-apps`, where git keeps the history of each app. The box also has limits: it may use at most three quarters of Docker's memory and a few thousand programs at once, so an app build that runs out of control fails inside the box instead of freezing Docker Desktop.

**It does not protect:**

- **Your Claude and Codex logins.** Agents can read them, so a misbehaving agent could use your subscriptions.
- **The internet.** Agents can reach the internet, because they need it to download building blocks. In principle, they could send out anything inside the box, your Claude and Codex logins included. This version has no list of allowed websites.
- **Your home network.** Agents can also reach the other devices on your network (your router's settings page, a network drive, printers) and programs on your PC that accept network connections. Keep those protected with passwords that aren't the factory defaults.
- **Your apps folder.** Anything in `~/mc-apps` can be changed or deleted.
- **Git in your apps folder during a run.** An agent could add git settings that make git run commands. Mission Control undoes them after every step and when a mission finishes, but while a night run is working, don't run `git` in `~/mc-apps`, or open those folders in an editor, outside `mc shell`.
- **Your usage allowance.** Each night uses a lot of your Claude and ChatGPT limits. Mission Control paces itself: by default one night uses at most about a third (35%) of each plan's weekly limit (setting `pacing.maxWeeklySharePerNight`), and it stops rather than run on paid extra usage. But it does use them.
- **Mission Control itself.** Agents run as the same user as Mission Control, so a misbehaving agent could stop a night's run early or change Mission Control's settings and records in `~/.mission-control`. Work already saved is kept, and the next run carries on.

**So, follow these rules:**

1. Never put real passwords, API keys, SSH keys, bank details or personal documents in `~/mc-apps`, and never give them to an agent. The one exception is a GitHub token limited to one repository, if you turn on uploading: see [Optional: upload finished work to GitHub](#optional-upload-finished-work-to-github) first.
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

   **You should see** "Installing: Ubuntu", then a message that the operation succeeded and that you need to restart.
3. Restart your PC.
4. After the restart, Ubuntu opens by itself. If it doesn't, click **Start**, type `Ubuntu`, and open it. When it asks for a **UNIX username**, type a short lowercase name (for example `adam`) and press Enter. Then choose a password and type it twice. Nothing appears while you type a password; that is normal. Write the password down: Ubuntu sometimes asks for it.

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
3. Open Docker Desktop and accept the terms. You can skip signing in and skip the survey. Docker Desktop is free for personal use.
4. Click the **gear icon** (Settings), top right:
   - **General:** check **Start Docker Desktop when you sign in to your computer**. **Use the WSL 2 based engine** should already be checked.
   - **Resources > WSL integration:** turn on **Ubuntu**, then click **Apply & restart**.
5. Close the Ubuntu window and open a new one. Paste:

   ```
   docker run --rm hello-world
   ```

   **You should see** `Hello from Docker!` among the lines.

## Step 3: Download and build Mission Control

In the Ubuntu window:

1. Download Mission Control:

   ```
   cd ~ && git clone https://github.com/krybaby7/Mission-control.git
   ```

   **You should see** `Cloning into 'Mission-control'...` and then the prompt again. If it asks for a username and password, the project is private: type your GitHub username, and for the password use a GitHub token (on github.com: your picture > **Settings** > **Developer settings** > **Personal access tokens** > **Fine-grained tokens** > **Generate new token**, with read access to this repository's contents).

2. Create the `mc` shortcut, so you can type `mc` instead of the full script path:

   ```
   echo "alias mc='~/Mission-control/scripts/mc-docker.sh'" >> ~/.bashrc && source ~/.bashrc
   ```

   **You should see** nothing, just the prompt again. That means it worked.

3. Build the Mission Control image (5 to 15 minutes the first time):

   ```
   mc build
   ```

   **You should see** many lines scroll by, ending with `mc-docker: the image is ready.`

From here on, every `mc ...` command runs inside the container. Until you finish Step 4, each command also prints "not logged in to Claude yet" and "not logged in to Codex yet". That is expected.

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

   **You should see** a list of ✓ lines. A warning about notifications (ntfy) is expected until Step 6. Any other line that isn't ✓ explains how to fix it. Fix it, then run `mc doctor` again.
3. Run the live check:

   ```
   mc doctor --live
   ```

   This makes one tiny real request to each AI. It uses a little of your allowance and can take a minute or two.

   **You should see** ✓ lines for Claude, Codex and Haiku.

## Step 6: Get notifications on your iPad (ntfy)

ntfy is a free app that shows a notification when a night's work finishes, when something gets stuck, or when Mission Control needs you.

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

   **You should see** the notification on your iPad within a few seconds.

You can also change settings by editing the file: run `mc shell`, then `nano ~/.mission-control/config.yaml`. Save with **Ctrl+O** and Enter, quit with **Ctrl+X**, then type `exit`.

## Step 7: Keep the PC awake at night

Mission Control only works while the PC is on and awake.

1. Open **Settings > System > Power** (on a laptop: **Power & battery**). Under **Screen, sleep, & hibernate timeouts** (or **Screen and sleep**), set sleep **when plugged in** to **Never**. Turning the screen off is fine.
2. On a laptop, keep it plugged in. In **Control Panel > Hardware and Sound > Power Options > Choose what closing the lid does**, set **When plugged in** to **Do nothing**.
3. Stop Windows Update from restarting at night: **Settings > Windows Update > Advanced options > Active hours**, choose **Manually**, and set it to cover the night (for example 10:00 PM to 8:00 AM).
4. At night, lock the screen (**Windows key + L**) if you like, but don't sign out or shut down. Docker Desktop must be running.

## Step 8: Queue work

Describe the app in plain words. The more detail you give, the better the result.

```
mc new "A habit tracker where I can add daily habits, tick them off each day, and see a weekly streak chart" --name "Habit tracker"
```

**You should see** the new mission's name, like `2026-10-09-habit-tracker`. To see everything that's queued:

```
mc status
```

To change an app that already exists, its folder must be inside `~/mc-apps` (Mission Control's container sees no other folder; move or copy the app there first). Then:

```
mc feature ~/mc-apps/<app-folder> "Add a dark mode"
```

## Step 9: Start a night's work

Before bed, in the Ubuntu window:

```
mc run --until 07:00
```

Mission Control works until 7:00 in the morning (your local time), then writes a report and notifies you. **You should see** it start on the first mission. Minimize the window, but leave it open until the morning: closing it cuts the run short. To stop early, run `mc stop` in another Ubuntu window: the run stops within a few minutes, keeps its progress, writes the report and notifies you. Missions that were paused (by `mc stop`, by the 7:00 stop time, or while the AIs were at their usage limits) continue automatically the next time you run this. Features that got stuck don't: once a mission is finished, its report's **Needs your decision** gives the command that queues them again, if you still want them. If you start a run after its stop time has passed (say at 7:20 with `--until 07:00`), it refuses instead of working through your day: give a later time, such as `--until 12:00`. A mission that stopped because it needs your help (the report and `mc status` say so) waits for you: do what its report asks under **Needs your decision**, then continue it with `mc run --mission <mission>` (the mission's name as `mc status` shows it). If it only needed a new login, the next run continues it by itself.

### Optional: start it automatically at 23:00 every night

1. Click **Start**, type `Task Scheduler`, and open it. On the right, click **Create Task...** (not "Create Basic Task").
2. **General** tab: Name `Mission Control night run`. Choose **Run only when user is logged on**.
3. **Triggers** tab: **New...** > **Daily**, start time `11:00:00 PM` > **OK**.
4. **Actions** tab: **New...** > **Start a program**.
   - **Program/script:** `wsl.exe`
   - **Add arguments:**

     ```
     -d Ubuntu -- bash -lc "~/Mission-control/scripts/mc-docker.sh run --until 07:00 >> ~/mc-night.log 2>&1"
     ```

   Click **OK**.
5. **Conditions** tab: check **Wake the computer to run this task**. Click **OK**.
6. To test it, right-click the task and choose **Run**. A black window opens and stays open while it works. Leave it open: closing it cuts the run short. In the Ubuntu window, `docker ps` **should show** `mission-control-run`. End the test with `mc stop`.

Only one run can happen at a time. If you start one by hand while the scheduled one is working, you'll see "a Mission Control run is already active". If Docker Desktop is still starting at 23:00 (say, after Windows restarted for an update), the scheduled run waits up to 5 minutes for it. If the scheduled run can't start at all (Docker Desktop isn't running, for example), your iPad gets a notification "Mission Control: the night run didn't start" that says why. This works once a run has started at least once since you set up notifications in Step 6: each run that starts keeps a copy of the notification address in Ubuntu for this. The scheduled run's messages go to `~/mc-night.log`; read the end with `tail -n 50 ~/mc-night.log`.

## Checking things yourself (optional)

Some work is only right when you look at it yourself: how a page looks, whether the plan is what you meant. You can ask the team to stop at a place, show you what to look at, and carry on only after you answer. This part has not been tried on a real PC yet.

1. When you queue work, say where you want to look. There are three places, and you can ask for more than one:

   ```
   mc new "A habit tracker" --name "Habit tracker" --checkpoint plan --checkpoint final
   ```

   - `plan`: before anything is built. Nothing is spent on building until you have seen the plan.
   - `feature`: before each feature is added to the app (one stop for every feature).
   - `final`: before the finished app is finished.

   **You should see** a line like `It will stop for your check: the plan, the finished app.` The same flag works with `mc feature`. Work queued without `--checkpoint` runs straight through, as before.

2. Start the run as usual. A mission that reaches a place you asked for stops there, on purpose. The other missions carry on, and the run ends when nothing else is left. You get a notification on your iPad ("please check the plan"), the end of the run says `... is waiting for your check`, and `mc status` shows `needs your check` for it.

3. Look at it. `mc report <mission>` starts with **Waiting for your check**: what the team made and what to look at. For a feature or the finished app it ends with the steps to open the work, the same steps as **How to try it** in a finished report (including putting the app's folder back afterwards). Nothing moves while it waits: the work is kept, and nothing is added to your app until you approve.

4. Answer it, in the Ubuntu window or by telling the leader:

   ```
   mc approve <mission>
   mc send-back <mission> --note "make the buttons bigger"
   ```

   **You should see** `Recorded: you approved the plan for “Habit tracker”.` and that it continues on the next run. Continue it with `mc run --mission <mission>`. A send-back needs a note that says what to change: the team changes it with your note and asks you again. You can send the same check back twice; a third send-back ends the work there (the plan: nothing will be built; a feature: it is set aside and the rest carries on; the finished app: the finished result is kept as it is), and the report says what to do next. You can still approve at any time.

5. An answer can only be recorded while no run is going. If one is, you see `A run is going right now, so the answer can't be recorded safely.` Wait until it ends (`mc status` shows), then try again. A mission that waits for you never holds a run up.

6. On the dashboard, a mission that waits has an amber card, **“<name>”: please check the plan** (or the feature, or the finished app), with an eye icon, the lines the team wrote about what to look at, and two buttons, **Tell the leader: approve** and **Tell the leader: send it back**. They only give you a sentence to paste into the chat with the leader. The dashboard never approves anything. The leader asks you one more question before it runs `approve` or `send-back`, and Claude Code asks you on top of that.

### Plans the leader writes

For a small, clear job the leader can write the plan itself instead of leaving it to the team's planner (see [Optional: start the leader](#optional-start-the-leader)). It shows you the plan in the chat, with every check word for word and a short plan code, and asks one question, "Queue this plan and start the team on it?", before anything is queued. The team still writes the tests first, builds, has a different AI review each feature, and checks the finished app. This part has not been tried on a real PC yet.

- A mission queued this way stops at the plan for your look before anything is built, even though you did not ask for it with `--checkpoint`. You answer it as in the steps above. The leader skips this stop only if you tell it you do not want to look at its plans, it asks one more question ("Skip your look at this plan? ..."), and you say a clear yes.
- The leader reads the whole plan to you again at the stop. You can also read it yourself, without the leader. In an Ubuntu window, this prints all of it, with the plan code, every check, the choices made for you, and whether the team's plan reviewer or you changed it:

  ```
  mc plan show <mission>
  ```

  `mc report <mission>` shows only the first 40 lines, which can cut a long plan. In Windows, `mc copy-reports` copies the reports to `~/mc-reports` (it prints the folder's Windows address), and the mission's `report.md` there holds the whole text.
- The plan code is the same in the leader's message, in `mc plan show` and in the report. It always names the plan as the leader wrote it: if it differs from the one the leader quoted when it asked you, what was queued is not the plan you were shown. `mc plan show` also says whether the team's plan reviewer or your note changed the plan since.

What this protects, and what it doesn't. A check is a place where you look, not a lock. The AI team runs as the same Ubuntu user as Mission Control, so a determined one could write an approval itself. That could only skip your look: every test and review still runs, and nothing that fails is added. Mission Control keeps a record of each answer, distrusts a waiting check that shows an answer with no record, and sends a notice to your iPad each time an answer is recorded, so one you didn't give shows up there.

## Step 10: In the morning

1. Your iPad shows a ntfy notification that the night finished, with a short summary.
2. Read the latest report:

   ```
   mc report
   ```

   **You should see** the start of the report: how it went, what you can do now, how to try the app, and any decisions it needs from you. If the night worked on several missions, you see the night's summary instead: each mission's result, what they need from you, and the command for each one's own report, such as `mc report 2026-10-09-habit-tracker`.
3. To read the full reports in Windows:

   ```
   mc copy-reports
   ```

   It prints a folder address like `\\wsl.localhost\Ubuntu\home\adam\mc-reports`. Paste it into the address bar of **File Explorer**. Open `reports\latest.md` with Notepad (the night's summaries are the `reports\night-....md` files). Notepad shows the report's pictures as lines of text: the screenshots themselves are picture files in `missions\<mission>\screenshots`.
4. Try the app:

   ```
   mc shell
   ```

   Then type the commands from the report's **How to try it** section, one at a time. When the app says it's ready, open <http://localhost:3000> in your Windows browser. When you're done, press **Ctrl+C** to stop the app, run the `git checkout ...` command the report gives to put the app's folder back on your own version (if it gave one), and type `exit`. For a change to an app you already had, the report also says how to keep the change.

Your apps' files are in File Explorer at `\\wsl.localhost\Ubuntu\home\<your-ubuntu-name>\mc-apps`.

## Optional: watch the team on a web page (the dashboard)

The dashboard is a web page that shows, in plain words, whether the team is working, how far along it is, whether anything needs you, and what you got. It only reads Mission Control's files: it can't change, stop or start anything. This part has not been tried on a real PC yet.

1. Open a second Ubuntu window (leave the one with the run alone) and run:

   ```
   mc dashboard
   ```

   **You should see** a line like `mc-docker: the dashboard is at http://localhost:8787 (Ctrl+C to stop)`. Leave the window open. The dashboard runs in a container of its own, which can only read Mission Control's folder.

2. Open <http://localhost:8787> in your Windows browser. The page has four tabs: **Now**, **Needs you**, **Timeline** and **Results**. It asks for news every few seconds. If it can't, it says **Not updating**, and after a few minutes **Not responding**.

3. If you gave the run a stop time, you can show it. Start the dashboard with the same time:

   ```
   mc dashboard --until 07:00
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

The leader is a Claude Code session that you talk to in plain words: "How is it going?", "Add a dark mode to the habit tracker", "Please stop the current run." It acts only through the same `mc` commands you use (status, logs, report, stop, new, feature, plan, run, approve and send-back), and Claude Code asks you before the leader stops the run, starts the team working, queues a new app or a change, queues a plan it wrote, or answers a check (answer Yes once; never "Yes, and don't ask again": it saves a rule that nobody has reviewed, and for a plan the rule would be the text of that one plan, which is of no use). Before it answers a check, the leader also asks you in the chat; see [Checking things yourself](#checking-things-yourself-optional). It can't reopen a feature that got stuck or change a plan; for those it queues a follow-up request that starts on the next run. This part has not been tried on a real PC yet.

1. Claude Code must be installed in Ubuntu itself, and logged in there. The copy inside Mission Control's container can't be used. Follow Anthropic's installation instructions for Claude Code on Linux. The leader's chat uses the same Claude plan as the team's runs.

2. In the Ubuntu window:

   ```
   cd ~/Mission-control/leader && claude
   ```

   Log in when it asks. Then type `How is it going?`. The folder's `CLAUDE.md` and `.claude/settings.json` give the leader its instructions and limits; [leader/README.md](../leader/README.md) explains them.

3. On the dashboard, the **Tell the leader about this** buttons (on cards and features) and **Tell the leader anything** (on the bar) give you a ready sentence. Copy it and paste it into the chat with the leader.

4. Optional: to talk to the same leader from the Claude app on your iPad or phone, start it this way instead of step 2:

   ```
   cd ~/Mission-control/leader && claude --remote-control "Leader"
   ```

   This is one session: you can type to it in the Ubuntu window, and the same session is open in the Claude app (tap **Code**) or in a browser at claude.ai/code, where it is listed as "Leader" with a computer icon and a green dot. Already running the leader? Type `/remote-control Leader` in it instead.

   Do not use `claude remote-control` for this. That is a different mode: it starts its own session that you can open from the app or claude.ai/code, but you cannot type to it in that Ubuntu window.

   It needs a claude.ai login (Pro, Max, Team or Enterprise); API keys do not work. On Team or Enterprise, an Owner must first turn on Remote Control in the Claude Code admin settings. The first time, Claude Code asks "Enable Remote Control? (y/n)" and whether you trust the folder; answer yes. Keep the Ubuntu window open and the PC awake. Remote Control has not been tried here: whether the session appears, and what you can do in it from the app, is unverified. These steps follow Anthropic's Remote Control documentation (https://code.claude.com/docs/en/remote-control).

If you ask the leader to start the team working, it runs `mc run` as a background task of the chat. It adds a stop time (`--until`) only if you give one; without one, the run keeps going until the queued work is done or you ask it to stop (it also ends early if no work can go on, for example a full disk or every AI login expired). If the chat session ends, the run may stop too; its progress is kept and the next run continues (not tried). For a run that must not depend on a chat, use Step 9 or the scheduled run.

## Optional: upload finished work to GitHub

Out of the box, Mission Control keeps everything on your PC. If you turn uploading on, each finished mission's branch (`mc/<mission>`) goes to the app's repository on GitHub. Mission Control never uploads `main` and never overwrites what is already there, and it doesn't run the app's git hooks while uploading.

**Read this first.** To upload, the container needs a GitHub token, and it has to be saved in the app's folder, where the agents work. So a misbehaving agent can read the token and use it itself, for anything the token allows; Mission Control's own care only covers what Mission Control does. That is why the token must be limited to that one repository, and why GitHub itself must refuse changes to `main`. If you can't do both, leave uploading off.

Do this once for each app, during the day (not while a night run is working):

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
cd ~/Mission-control && git pull && mc build
```

Your logins, missions and apps are kept. If the project is private, `git pull` asks for your GitHub username and token again, as in Step 3 (tokens expire: make a new one when it is refused).

## Troubleshooting

| What you see | What to do |
|---|---|
| `Docker isn't running` | Start Docker Desktop and wait until it shows **Engine running** (bottom left). Then try again. |
| `Docker isn't available in Ubuntu`, or `docker: command not found` | Usually Docker Desktop isn't running: start it and wait until it shows **Engine running** (bottom left), then try again. If it was already running: in Docker Desktop, **Settings > Resources > WSL integration**, turn on **Ubuntu**, then **Apply & restart**. Open a new Ubuntu window. |
| `mc: command not found` | Run `source ~/.bashrc`. If that doesn't help, repeat Step 3, instruction 2. |
| `the Mission Control image isn't built yet` | Run `mc build`. |
| `not logged in to Claude yet` or `not logged in to Codex yet`, or `mc doctor --live` says `Not logged in` (plain `mc doctor` only checks that a login is stored, not that it still works) | Log in again: `mc login-claude` or `mc login-codex`. Logins sometimes expire; that's normal. Missions that stopped because of it continue by themselves on the next `mc run`. |
| A mission is "Stopped, needs your help", or `mc status` shows it `failed` | Read what it needs: `mc report <mission>`, under **Needs your decision**. Do that, then continue it: `mc run --mission <mission>`. `mc status` shows the mission names. |
| "paused, the disk is almost full" | Free some space: delete apps you no longer need from `~/mc-apps`, or run `docker system prune` to clear old Docker data. Then run `mc run` again; it continues where it paused. |
| "Mission Control stopped unexpectedly" | The last run ended without finishing (the PC restarted, Docker Desktop stopped, or the power went out). Nothing is lost: the work so far is kept and continues. If it keeps happening, check Step 7 and that Docker Desktop stays running. |
| The Codex code is refused | Codes expire after 15 minutes: run `mc login-codex` again for a fresh one. If it's still refused, look for a device code option in ChatGPT > Settings > Security and turn it on. |
| "You've hit your limit", or `mc status` shows a mission waiting | Nothing to do. Mission Control notices limits, switches to the other AI when allowed, or waits until the limit resets and carries on. If it happens every night, queue less work. |
| "Waiting for the AIs to respond", or "paused, the AI isn't working" | The internet connection or an AI service had a problem, or an AI command line keeps failing. Nothing was lost and nothing counted against the work. Check that the PC is online, then run `mc doctor --live`. The next `mc run` carries on where it paused. |
| `mc status` shows a mission `needs your check`, or the end of a run says `is waiting for your check` | You asked the team to stop there (`--checkpoint`), or the leader wrote the plan, which stops at the plan by default. Look at it with `mc report <mission>` (for a plan the leader wrote, `mc plan show <mission>` prints all of it), then `mc approve <mission>` or `mc send-back <mission> --note "what to change"`. See [Checking things yourself](#checking-things-yourself-optional). |
| `A run is going right now, so the answer can't be recorded safely` | `mc approve` and `mc send-back` only work while no run is going. Wait until the run ends (`mc status`), then try again. |
| `is not waiting for your check, so there is nothing to answer`, or `You already answered this check` | The check was answered already, or the mission isn't stopped for one. `mc status` shows what it is doing. After an answer, continue it with `mc run --mission <mission>`. |
| You want to stop a run | In another Ubuntu window: `mc stop`. It stops after the current step and keeps its progress; the next `mc run` continues. If it hasn't stopped after a few minutes: `docker stop mission-control-run`. |
| `a Mission Control run is already active` | One is already working, maybe the scheduled one. Check with `mc status`, or stop it with `mc stop`. If `docker ps` doesn't list `mission-control-run`, the last run was cut off: wait 5 minutes and try again. |
| `mc status` shows a mission `interrupted` | The last run ended without finishing (it was stopped with `docker stop`, or the PC or Docker Desktop restarted). Nothing is lost: the next `mc run` continues it. |
| `this run would work until 07:00 tomorrow` | The stop time had already passed when the run started. Give a later time, such as `mc run --until 12:00`. |
| `Mission Control can only change apps inside ~/mc-apps`, or `There is no folder at ...` | Move or copy the app's folder into `~/mc-apps`, then use its path there: `mc feature ~/mc-apps/<app-folder> "..."`. |
| `has no branch checked out` when running `mc feature` | The app's folder is still on a version you were trying from a report. Run the `git -C ... checkout ...` command it prints, then try again. |
| `mc doctor` says `Not checked: a night run is working right now` | It leaves the AIs alone while a run uses the same logins. Run it again after the run ends. |
| `cannot write to /home/pwuser/.claude` (or `.codex`, or `.mission-control`) | Run `mc fix-permissions`. |
| `cannot write to /home/pwuser/mc-apps` | Run the command it prints: `sudo chown -R "$USER": ~/mc-apps && mc build`. |
| `port is already allocated` when running `mc shell` | Another `mc shell` window is open. Close it first. |
| http://localhost:3000 doesn't open | Check that the app is still running in the `mc shell` window. If it is, stop it with **Ctrl+C** and start it again with `npm run dev -- --hostname 0.0.0.0`. |
| `the dashboard is already running` | One dashboard is open already. Use the address it printed when it started, or stop it with `docker stop mission-control-dashboard`. |
| `port is already allocated` when running `mc dashboard` | Port 8787 is in use, maybe by a dashboard in another window. Close that one, or choose another port: `mc dashboard --port 8788`, and open <http://localhost:8788>. |
| http://localhost:8787 doesn't open | Check that the dashboard window is still open and shows the address. If you updated Mission Control, run `mc build` and start the dashboard again. From the iPad, see [From the iPad](#from-the-ipad): it has not been tried. |
| The dashboard says **Not updating** or **Not responding** | The page has lost touch with the dashboard window. Check that the window is open and the PC is awake, then reload the page. |
| Nothing happened overnight, or "Mission Control: the night run didn't start" | The notification and the end of `~/mc-night.log` (`tail -n 50 ~/mc-night.log`) say why; look that message up in this table. Without either, the scheduled run didn't run at all: was the PC asleep, restarted, or signed out (Step 7)? Also make sure Docker Desktop starts when you sign in (Step 2). |
| The report says `Could not push mc/...` | Uploading is on (see [Optional: upload finished work to GitHub](#optional-upload-finished-work-to-github)). With `no remote`: the app has no GitHub address yet; follow instructions 1 to 3 there, or ignore it. With `Authentication failed`, `could not read Username`, `403` or `denied`: the token expired or can't write to that repository; make a new one (instruction 2) and save it with `set-url` (instruction 3). With `pre-push hook`: the app has its own git hook that runs before uploads (some projects use one for big files, called Git LFS, or for checks), and Mission Control never runs an app's hooks, so it didn't upload. Upload it yourself in the Ubuntu window when no night run is working: `git -C ~/mc-apps/<app-folder> push origin mc/<mission>`. |
| No notification on the iPad | Repeat the test in Step 6, instruction 5. Check that notifications are allowed for ntfy in the iPad's Settings. Check the address with `mc config get notify.ntfyUrl`. |
| `couldn't tell your timezone, so times such as 07:00 mean UTC` | Run `sudo dpkg-reconfigure tzdata` and pick your region and city. |
| You want to start over: forget the logins, missions and reports | `docker volume rm mc-claude mc-codex mc-home mc-browsers` deletes them for good (your apps in `~/mc-apps` are kept; `mc-browsers` only holds test browsers, which come back by themselves). Then repeat Steps 4 to 6. |
