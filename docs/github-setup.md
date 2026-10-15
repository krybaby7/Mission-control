# Work with GitHub: bring a project in, send the result out

Mission Control can bring a project from GitHub to your PC, let the team work on it, and send the result back to GitHub as a draft pull request. A pull request is GitHub's way of asking "please add this work to the main version". A draft one says it is not ready to merge yet. Nothing is merged until you merge it yourself, on github.com.

Three commands do this. All run in your Ubuntu window, on your PC, with your own GitHub login:

- `mc get` downloads a repository into `~/mc-apps`.
- `mc publish-preview` shows which repository a finished mission's work would go to. It uploads nothing.
- `mc publish` uploads a finished mission's work to the repository you name, and opens the draft pull request.

With these commands, the box where the team works (the Docker container) never gets a password, a token or a login. That is on purpose, and it is why they run outside the box.

## What was tried and what was not

**Tried here:** both commands, against a stand-in for GitHub (a folder of git repositories, reached through the same git setting an owner could use) and a stand-in for the `gh` program. The tests cover odd and hostile input, an app folder that holds git settings and hooks that would run a command, and a branch that already exists on GitHub.

**Not tried:** a real GitHub. A real login. The real `gh` program opening a pull request. Private repositories. SSH keys. Git LFS (big-file storage). Windows, WSL and Docker Desktop. The steps for installing and logging in below come from GitHub's own documentation, not from anything run here. Real GitHub cannot be reached from the place this was built, so please try it once with a repository you can afford to experiment with.

**Two limits to know about.** `mc publish` needs git version 2.29 or newer. Ubuntu 22.04 and newer have it; check with `git --version`. If you use an SSH address, `mc` asks SSH never to ask a question, and it uses its own SSH settings for that one command, so a special key set in your own git settings (`core.sshCommand`) is not used. Both were found by reading the script, and neither was tried.

## One-time setup: log in to GitHub on your PC

Do this in your own Ubuntu window, not through the leader. Only you can log in.

1. Check that git is there: `git --version`. If Ubuntu says it is missing, run `sudo apt install git`.
2. Install the GitHub tool, called `gh`. GitHub's page for it is <https://cli.github.com>. Look for the Linux steps for Debian and Ubuntu. Without `gh`, `mc publish` still uploads the branch, but you open the pull request yourself.
3. Log in:

   ```
   gh auth login
   ```

   When it asks, choose **GitHub.com**, then **HTTPS**, then **Login with a web browser**. Say yes when it asks whether to log git in with your GitHub login. It shows a one-time code and a web address: open the address on your PC and type the code.
4. Make git use the same login:

   ```
   gh auth setup-git
   ```

5. Check it:

   ```
   gh auth status
   ```

   **You should see** that you are logged in to github.com.

The login stays in your Ubuntu home folder. It never goes into the container.

## Download a repository: `mc get`

```
mc get acme/widgets
```

This downloads `https://github.com/acme/widgets` into `~/mc-apps/widgets`. To use another folder name, add it:

```
mc get acme/widgets my-widgets
```

**You should see** a line like `mc-docker: downloaded acme/widgets into ~/mc-apps/widgets.` and the next step: `mc feature ~/mc-apps/widgets "<what you want changed>"`. You can also ask the leader to work on the folder.

It also saves a small note, `~/.config/mission-control/origins/widgets`, that says this folder belongs to `acme/widgets`. The box where the team works cannot see that note. `mc publish` uploads from this folder only to the repository in the note (see "Why you name the repository" below).

What it accepts, and nothing else:

| You write | Example |
|---|---|
| owner and repository | `acme/widgets` |
| the web address | `https://github.com/acme/widgets` (a `.git` or a `/` at the end is fine) |
| the ssh address | `git@github.com:acme/widgets.git` |

Other websites are refused, and so is anything with a space, a quote, a `;` or a web address that carries a login. The folder name must start with a letter or a digit and use only letters, digits, dots, dashes and underscores (61 characters at most). If the folder exists already, nothing is downloaded and nothing is changed.

Downloading a private repository needs the login from the setup above.

## Send a finished mission to GitHub: `mc publish`

When a mission is done, or partly done, first look at where it would go:

```
mc publish-preview 2026-10-12-dark-mode
```

Use the mission's name as `mc status` shows it. **You should see** a few lines: that the mission is ready, `It would go to github.com/acme/widgets`, and the line to run next. Nothing is uploaded and nothing is changed. Read the repository's name. It must be the one you mean.

Then send it, with the same repository after `--to`:

```
mc publish 2026-10-12-dark-mode --to acme/widgets
```

**You should see** the line `mc-docker: draft pull request: https://github.com/...`. Open that address to read the draft. To merge it, click **Ready for review** and then **Merge pull request**. Nothing else on GitHub changes before that.

What the two commands do, in order. They stop with a plain sentence at the first thing that is wrong:

1. The name looks like a mission name, and the mission exists. For `publish`, the text after `--to` looks like `owner/repo`.
2. The mission is finished (**done**) or partly finished (**partial**). A partly finished mission is sent as a draft, and the draft lists the features that are not finished. A mission that is waiting, running, paused or stopped is refused, and so is one that needs your help.
3. The mission's branch (`mc/<mission>`) has work that the main branch does not have. A new app does not: see "A new app" below.
4. The app's folder in `~/mc-apps` is a git folder whose GitHub address is a plain `github.com` address, with no login or password inside it.
5. That address is the repository the folder was set up for, when Mission Control knows it (see "Why you name the repository").
6. The app does not use git hooks or Git LFS. Mission Control never runs an app's hooks, so for such an app it does not upload, and tells you the one command to use yourself.

`mc publish-preview` stops here, and prints the repository. The rest is only `mc publish`:

7. The repository after `--to` is the one the app's address names. If you leave `--to` out, `mc publish` shows the same lines as the preview, uploads nothing and exits with an error.
8. The main branch is on GitHub already.
9. It uploads **only** the branch `mc/<mission>`. Never `main`, never `master`, never with force. If GitHub already has a branch with that name and other work on it, it stops and does not overwrite it.
10. The first time you publish from a folder that has no note, it saves one: from then on this folder uploads only to that repository.
11. With `gh`, it opens a **draft** pull request and prints its address. Without `gh`, or if `gh` fails, the branch is still uploaded and it prints an address where you open the pull request yourself.

If you run it again for the same mission, after more work, it uploads the new work to the same branch and prints the address of the pull request that exists.

### What the draft says

- The mission's title and name, the branch, and the main branch it is meant for.
- The plan code, if the leader wrote the plan.
- **What was checked.** From the mission's own record, in plain words: how many features had tests written before the code, whether the app's own checks were already failing, how many reviews did not finish, and which stops you answered. It says plainly when nobody looked at the work before it was published. Mission Control records each of your answers. It cannot tell what you actually looked at, and the draft says so.
- Which features are not finished, for a partly finished mission.
- The first lines of the report, in a block of plain text. The steps for trying the app on your PC are left out.

The title and the feature names were written by the AI team. Before they go into the draft, the characters that would tag a person (`@`), link an issue (`#`), add HTML (`<` and `>`) or turn text into a link are left out.

### A new app, which does not come from GitHub yet

When Mission Control builds an app from nothing, what the team finished is put on the `main` branch in `~/mc-apps/<app>` at the end (also when the app is only partly finished). GitHub has nothing yet. A pull request asks GitHub to add new work to what it already has, and here there is nothing to compare with. So for a new app `mc publish-preview` and `mc publish` say `... is a new app` and upload nothing. The whole app goes to GitHub once, by you, with your own git. Do this in your own Ubuntu window:

1. On <https://github.com>, create an empty repository (**+**, then **New repository**; leave **Add README**, **.gitignore** and **license** off). Choose public or private yourself. In a public repository everyone can read the app.
2. Tell the app where it is, and upload the main branch once. Use your own owner and repository name:

   ```
   git -C ~/mc-apps/habit-tracker remote add origin https://github.com/<owner>/<repo>.git
   git -C ~/mc-apps/habit-tracker push -u origin main
   ```

That is all. There is no pull request for this first upload, because the whole app is the new thing. From then on, every change you ask for (`mc feature`, or the leader) is a mission with its own branch, and `mc publish-preview` and `mc publish` send it as a draft pull request in the usual way. The first time, `mc publish` asks you to name the repository with `--to`, because this folder was not downloaded with `mc get`.

If you run `mc publish-preview` for the new app again after this, it prints the GitHub address of the folder and says that, if you did the two steps already, there is nothing more to do.

## Why you name the repository

The AI team writes in the app's folder, and the GitHub address that `mc publish` uploads to is a setting inside that folder. A team that went wrong, or a text it read that told it what to do, could change that address to another repository you are allowed to write to, for example a public one. Then a plain "publish" would send the whole history of a private app there. So `mc publish` does not take the address on trust:

- **A folder that `mc get` downloaded.** The note that `mc get` saved is out of reach of the team. If the folder's address is not the repository in the note, `mc publish-preview` and `mc publish` refuse, even if you name the new address after `--to`. The message says which two repositories differ and how to look. If you moved the repository on purpose, remove the note (`rm ~/.config/mission-control/origins/<folder>`) and publish again.
- **A folder with no note** (a new app you connected yourself). `mc publish-preview` prints the repository, and `mc publish` uploads only to the repository you name after `--to`. After the first upload it saves a note, so from then on the folder is protected like a downloaded one.
- **The leader.** It runs `mc publish-preview` first, names the repository in its question ("Send ... to acme/widgets on GitHub as a draft pull request?"), and runs `mc publish ... --to acme/widgets` only after your yes. Claude Code's prompt then shows the repository in the command.

What this cannot do: if the team changes the address before the first upload from a folder with no note, and you do not notice the repository's name in the preview or in the leader's question, the work goes there. Read the name.

## Why publish works from a copy

The app's folder is where the AI team works. An AI could, in principle, leave git settings or hooks in it that make git run a command. `mc publish` uses your GitHub login, so it must not give such a command the chance to run. Git therefore never runs inside the app's folder. The script copies the one branch (and the main branch, to compare with) into a new, empty folder that it makes for the purpose, uploads from that copy, and deletes the copy when it is done. The app's saved settings are read only as a plain text file, to find the GitHub address. If you run git yourself inside an app's folder, the warning in [docs/setup-windows.md](setup-windows.md) about git in your apps folder still applies.

The mission's record lives inside Docker, which your PC cannot read directly. So `mc publish` reads it in a small, separate box: read-only, no network, no logins, no apps folder, and no variable that holds a password. It only prints a short list of facts, and your PC checks each one again before it uses it.

## If you see a message

| The message starts with | What it means, and what to do |
|---|---|
| `Mission Control only works with github.com.` | The address names another website. Write it as `owner/repo`, or as `https://github.com/owner/repo`. |
| `I don't understand "..." as a GitHub repository.` | The text is not one of the three forms above. Check for a space, a typo, or a part after the repository's name such as `/tree/main`. |
| `~/mc-apps/<name> already exists, so I downloaded nothing` | The folder is already there. Use it, or choose another name: `mc get owner/repo other-name`. |
| `I could not download owner/repo.` | Git's own words follow. Check the name. A private repository needs the login above (`gh auth login`, then `gh auth setup-git`). |
| `"..." is not finished` | The mission is not done yet. See where it is with `mc status`. |
| `... stopped and needs your help` | Read what it needs: `mc report <mission>`. |
| `I could not read the branch mc/... in ~/mc-apps/...` | The branch is not in the app's folder any more (was it replaced or deleted?), or git refused to read the folder. Git's own words follow. |
| `There is nothing to publish` | The mission's branch has no work beyond the main branch. |
| `... is a new app, and what was built is on the branch "main"` | The app was built from nothing. What the team finished is already on its main branch. It goes to GitHub as a whole, once, by you. See "A new app" above. |
| `... has no GitHub address yet` | A change to an app that has no GitHub address: do the two steps it prints, then publish again. For a new app see "A new app" above. |
| `... was set up for owner/repo, but its GitHub address now says ...` | The folder's address is not the repository it was downloaded from or first published to. The AI team can write in that folder, so a person has to look: `cat ~/mc-apps/<app>/.git/config`. If you changed it on purpose, remove the note it names and publish again. |
| `You asked me to upload to ..., but ~/mc-apps/... points to ...` | The name after `--to` is not the repository in the folder's address. Run `mc publish-preview <mission>` and use the name it prints, if that is the one you mean. |
| `"..." is not the name of a GitHub repository.` | Write the name after `--to` as `owner/repo`, like `acme/widgets`. |
| `publish uploads only where you tell it to, so I stopped here.` | You left out `--to`. The line before it is what to run next. |
| `... is not a plain github.com address` | The app's GitHub address names another site, or has a login or password inside it. The older upload way (see below) writes a token into that address; `mc publish` refuses it on purpose. Set it to a plain address with `git -C ~/mc-apps/<app> remote set-url origin https://github.com/<owner>/<repo>.git`. |
| `The branch "main" is not on GitHub ... yet` | A pull request needs the main branch to be on GitHub. Upload it once yourself: `git -C ~/mc-apps/<app> push origin main`. |
| `I could not reach owner/repo on GitHub.` | No network, a wrong name, or you are not logged in. Try `gh auth status`. If the app's address starts with `git@github.com:`, GitHub's key may not be accepted on this PC yet: run `ssh -T git@github.com` once in your Ubuntu window and answer yes (not tried here). |
| `... uses git hooks or Git LFS` | Mission Control never runs an app's hooks, so it did not upload. Upload the branch yourself with the command it prints, then open the pull request on github.com. |
| `GitHub already has a branch called mc/... with other work on it` | It never overwrites. Look at that branch on github.com. If you want to replace it, delete it there yourself and publish again. |
| `the GitHub tool gh is not installed here` | The branch is uploaded. Open the pull request with the address it prints, or install `gh` (setup above). |
| `the branch is on GitHub, but I could not open the draft pull request` | The branch is uploaded. `gh` said why; the usual reason is a missing login (`gh auth login`). Open the pull request with the address it prints. |

## The older way: Mission Control uploads by itself

`mc config set git.push true` makes the team upload each finished mission's branch by itself, but it needs a GitHub token saved inside the app's folder, where the AI team can read it. That is the reason `mc publish` exists. If you use `mc publish`, you do not need that setting, and you do not need to save a token anywhere. See “Optional: upload finished work to GitHub” in [docs/setup-windows.md](setup-windows.md) only if you want the older way anyway.

## What this does not do

- It does not merge anything. You merge on github.com.
- It cannot take back an upload. Everything in the branch becomes visible on GitHub, and in a public repository that means everyone. The branch is the AI team's work, so read the draft before you share the repository.
- It does not work with other websites than github.com, with GitHub Enterprise, or with forks.
- It does not run an app's git hooks, and it does not handle Git LFS.
- The leader can run `mc publish-preview` by itself, because it only reads. It starts `mc get` and `mc publish` only after you say yes in the chat, with the repository's name in the question, and Claude Code asks you again before it runs them. The leader never sees your login and never runs git or `gh` itself.
- It does not upload the first version of a new app. That is the two git commands above, which you run yourself.
