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

**It protects** your Windows files (Documents, Pictures, Desktop), your browsers and saved passwords, and everything else in Ubuntu. If an agent runs a harmful command such as "delete everything", the damage stays in the box and in `~/mc-apps`, where git keeps the history of each app.

**It does not protect:**

- **Your Claude and Codex logins.** Agents can read them, so a misbehaving agent could use your subscriptions.
- **The internet.** Agents can reach the internet, because they need it to download building blocks. In principle, they could send out anything inside the box.
- **Your home network.** Agents can also reach the other devices on your network (your router's settings page, a network drive, printers) and programs on your PC that accept network connections. Keep those protected with passwords that aren't the factory defaults.
- **Your apps folder.** Anything in `~/mc-apps` can be changed or deleted.
- **Your usage allowance.** Each night uses a lot of your Claude and ChatGPT limits. Mission Control paces itself, but it does use them.

**So, follow these rules:**

1. Never put real passwords, API keys, SSH keys, bank details or personal documents in `~/mc-apps`, and never give them to an agent.
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

To change an app that already exists, its folder must be inside `~/mc-apps`. Then:

```
mc feature ~/mc-apps/<app-folder> "Add a dark mode"
```

## Step 9: Start a night's work

Before bed, in the Ubuntu window:

```
mc run --until 07:00
```

Mission Control works until 7:00 in the morning (your local time), then writes a report and notifies you. **You should see** it start on the first mission. Minimize the window, but leave it open until the morning: closing it cuts the run short. To stop early, run `mc stop` in another Ubuntu window: the run stops within a few minutes, keeps its progress, writes the report and notifies you. Missions that don't finish continue automatically the next time you run this.

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

Only one run can happen at a time. If you start one by hand while the scheduled one is working, you'll see "a Mission Control run is already active". If Docker Desktop is still starting at 23:00 (say, after Windows restarted for an update), the scheduled run waits up to 5 minutes for it. The scheduled run's messages go to `~/mc-night.log`; read the end with `tail -n 50 ~/mc-night.log`.

## Step 10: In the morning

1. Your iPad shows a ntfy notification that the night finished, with a short summary.
2. Read the latest report:

   ```
   mc report
   ```

   **You should see** the start of the report: how it went, what you can do now, how to try the app, and any decisions it needs from you.
3. To read the full reports with screenshots in Windows:

   ```
   mc copy-reports
   ```

   It prints a folder address like `\\wsl.localhost\Ubuntu\home\adam\mc-reports`. Paste it into the address bar of **File Explorer**. Open `reports\latest.md` with Notepad. Screenshots are in `missions\<mission>\screenshots`.
4. Try the app:

   ```
   mc shell
   ```

   Then type the commands from the report's **How to try it** section, one at a time. When the app says it's ready, open <http://localhost:3000> in your Windows browser. When you're done, press **Ctrl+C** to stop the app and type `exit`.

Your apps' files are in File Explorer at `\\wsl.localhost\Ubuntu\home\<your-ubuntu-name>\mc-apps`.

## Updating Mission Control

```
cd ~/Mission-control && git pull && mc build
```

Your logins, missions and apps are kept.

## Troubleshooting

| What you see | What to do |
|---|---|
| `Docker isn't running` | Start Docker Desktop and wait until it shows **Engine running** (bottom left). Then try again. |
| `Docker isn't available in Ubuntu`, or `docker: command not found` | In Docker Desktop: **Settings > Resources > WSL integration**, turn on **Ubuntu**, then **Apply & restart**. Open a new Ubuntu window. |
| `mc: command not found` | Run `source ~/.bashrc`. If that doesn't help, repeat Step 3, instruction 2. |
| `the Mission Control image isn't built yet` | Run `mc build`. |
| `not logged in to Claude yet` or `not logged in to Codex yet`, or `mc doctor` says a login expired | Log in again: `mc login-claude` or `mc login-codex`. Logins sometimes expire; that's normal. |
| The Codex code is refused | Turn on device code sign-in in ChatGPT's security settings (Step 4b), then run `mc login-codex` again. |
| "You've hit your limit", or `mc status` shows a mission waiting | Nothing to do. Mission Control notices limits, switches to the other AI when allowed, or waits until the limit resets and carries on. If it happens every night, queue less work. |
| You want to stop a run | In another Ubuntu window: `mc stop`. It stops after the current step and keeps its progress; the next `mc run` continues. If it hasn't stopped after a few minutes: `docker stop mission-control-run`. |
| `a Mission Control run is already active` | One is already working, maybe the scheduled one. Check with `mc status`, or stop it with `mc stop`. |
| `cannot write to /home/pwuser/.claude` (or `.codex`, or `.mission-control`) | Run `mc fix-permissions`. |
| `cannot write to /home/pwuser/mc-apps` | Run the command it prints: `sudo chown -R "$USER": ~/mc-apps && mc build`. |
| `port is already allocated` when running `mc shell` | Another `mc shell` window is open. Close it first. |
| http://localhost:3000 doesn't open | Check that the app is still running in the `mc shell` window. If it is, stop it with **Ctrl+C** and start it again with `npm run dev -- --hostname 0.0.0.0`. |
| Nothing happened overnight | Was the PC asleep or restarted (Step 7)? For the scheduled run, read `tail -n 50 ~/mc-night.log`, and make sure Docker Desktop starts when you sign in (Step 2). |
| No notification on the iPad | Repeat the test in Step 6, instruction 5. Check that notifications are allowed for ntfy in the iPad's Settings. Check the address with `mc config get notify.ntfyUrl`. |
| `couldn't tell your timezone, so times such as 07:00 mean UTC` | Run `sudo dpkg-reconfigure tzdata` and pick your region and city. |
| You want to start over: forget the logins, missions and reports | `docker volume rm mc-claude mc-codex mc-home mc-browsers` deletes them for good (your apps in `~/mc-apps` are kept; `mc-browsers` only holds test browsers, which come back by themselves). Then repeat Steps 4 to 6. |
