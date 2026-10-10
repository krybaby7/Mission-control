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

1. First, allow sign-in with a code. On <https://chatgpt.com>, click your picture > **Settings** > **Security**, and turn on the option for **device code** sign-in for Codex.
2. In the Ubuntu window, paste:

   ```
   mc login-codex
   ```

   **You should see** a web address and a one-time code (like `ABCD-1234`).
3. Open the address on your PC or iPad, sign in to ChatGPT, and enter the code.

   **You should see** a success message in the Ubuntu window, and then the prompt again.

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
| The Codex code is refused | Turn on device code sign-in in ChatGPT's security settings (Step 4b), then run `mc login-codex` again. |
| "You've hit your limit", or `mc status` shows a mission waiting | Nothing to do. Mission Control notices limits, switches to the other AI when allowed, or waits until the limit resets and carries on. If it happens every night, queue less work. |
| "Waiting for the AIs to respond", or "paused, the AI isn't working" | The internet connection or an AI service had a problem, or an AI command line keeps failing. Nothing was lost and nothing counted against the work. Check that the PC is online, then run `mc doctor --live`. The next `mc run` carries on where it paused. |
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
| Nothing happened overnight, or "Mission Control: the night run didn't start" | The notification and the end of `~/mc-night.log` (`tail -n 50 ~/mc-night.log`) say why; look that message up in this table. Without either, the scheduled run didn't run at all: was the PC asleep, restarted, or signed out (Step 7)? Also make sure Docker Desktop starts when you sign in (Step 2). |
| The report says `Could not push mc/...` | Uploading is on (see [Optional: upload finished work to GitHub](#optional-upload-finished-work-to-github)). With `no remote`: the app has no GitHub address yet; follow instructions 1 to 3 there, or ignore it. With `Authentication failed`, `could not read Username`, `403` or `denied`: the token expired or can't write to that repository; make a new one (instruction 2) and save it with `set-url` (instruction 3). With `pre-push hook`: the app has its own git hook that runs before uploads (some projects use one for big files, called Git LFS, or for checks), and Mission Control never runs an app's hooks, so it didn't upload. Upload it yourself in the Ubuntu window when no night run is working: `git -C ~/mc-apps/<app-folder> push origin mc/<mission>`. |
| No notification on the iPad | Repeat the test in Step 6, instruction 5. Check that notifications are allowed for ntfy in the iPad's Settings. Check the address with `mc config get notify.ntfyUrl`. |
| `couldn't tell your timezone, so times such as 07:00 mean UTC` | Run `sudo dpkg-reconfigure tzdata` and pick your region and city. |
| You want to start over: forget the logins, missions and reports | `docker volume rm mc-claude mc-codex mc-home mc-browsers` deletes them for good (your apps in `~/mc-apps` are kept; `mc-browsers` only holds test browsers, which come back by themselves). Then repeat Steps 4 to 6. |
