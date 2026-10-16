#!/usr/bin/env bash
# Runs Mission Control inside its Docker container. Use it from Ubuntu (WSL2) on the machine with Docker Desktop.
# docs/setup-windows.md sets up the alias `mc` for this script; run it with no arguments for the command list.
#
# Three commands, `get`, `publish-preview` and `publish`, do not run in the container. They run here, on this PC, with
# your own git and GitHub login, because the container must never hold a password or a token. See docs/github-setup.md.
# Messages use curly quotes around titles (SC1111) and show ~/mc-apps as the owner knows it, not expanded (SC2088).
# shellcheck disable=SC1111,SC2088
set -euo pipefail

readonly IMAGE="mission-control:local"
readonly RUN_CONTAINER="mission-control-run"
readonly DASHBOARD_CONTAINER="mission-control-dashboard"
readonly DASHBOARD_PORT=8787
# The dashboard only serves two small documents, so its box is much smaller than a run's.
readonly DASHBOARD_PIDS_LIMIT=256
readonly DASHBOARD_MEMORY="256m"
# `publish` reads a mission's record in a box of the same small size, with no network at all.
readonly FACTS_PIDS_LIMIT=256
readonly FACTS_MEMORY="256m"
readonly CONTAINER_HOME="/home/pwuser"
readonly APPS_DIR="$HOME/mc-apps"
readonly REPORTS_DIR="$HOME/mc-reports"
readonly PREVIEW_PORT=3000
# A scheduled run can start while Docker Desktop is still starting (after a reboot or an update), so it waits.
readonly DOCKER_WAIT_SECONDS=300
readonly DOCKER_POLL_SECONDS=10
# Limits for every container, so a runaway build or test (or a fork bomb) fails inside the box instead of using up
# the memory of Docker Desktop's WSL2 machine and taking Docker Desktop down with it: at most this many processes
# and threads, and this share of the memory Docker has.
readonly PIDS_LIMIT=8192
readonly MEMORY_PERCENT=75
# Small files this script keeps outside the container, in your Ubuntu home folder.
readonly CONFIG_DIR="$HOME/.config/mission-control"
# The notification address lives in the mc-home volume. A copy outside the container lets a scheduled run that can't
# start (Docker Desktop not running, the image missing) still tell your iPad why. Refreshed whenever a run starts.
readonly NOTIFY_URL_FILE="$CONFIG_DIR/ntfy-url"
# Where Mission Control's folder is, and the small launcher the Windows shortcuts call (see install_leader).
readonly CHECKOUT_FILE="$CONFIG_DIR/checkout"
readonly LAUNCHER_FILE="$CONFIG_DIR/launch"
# One small file for each app folder in ~/mc-apps, named like the folder, holding the one GitHub repository ("owner/repo")
# the folder was set up for. `get` writes it, and `publish` writes it the first time you name a repository. Only this PC
# can write it: the container sees ~/mc-apps and nothing in ~/.config. `publish` uploads nowhere else.
readonly ORIGINS_DIR="$CONFIG_DIR/origins"
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_DIR
# Set for an unattended run: `die` then also sends its message to the iPad.
NOTIFY_FAILURE=""
# The `docker run` arguments every container gets, filled once by container_base.
CONTAINER_BASE=()

# The only characters a GitHub owner, repository or folder name may use. Spelled out so that no language setting can
# widen them (a range such as a-z can match accented letters in some languages).
readonly ALNUM='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
# A GitHub owner: 1 to 39 letters, digits or dashes, starting with a letter or digit.
readonly GH_OWNER_RE="[$ALNUM][$ALNUM-]{0,38}"
# A GitHub repository: 1 to 100 letters, digits, dots, dashes or underscores. "." and ".." are refused separately.
readonly GH_REPO_RE="[$ALNUM._-]{1,100}"

# Runs inside the container: mirror the reports and each mission's report.md and screenshots into ~/mc-reports,
# keeping the folder layout so links between them still work.
# shellcheck disable=SC2016 # expanded by the container's bash, not here
readonly COPY_REPORTS_SCRIPT='
set -euo pipefail
shopt -s nullglob
src="$HOME/.mission-control"
dest="$HOME/mc-reports"
if [ -d "$src/reports" ]; then cp -R "$src/reports" "$dest/"; fi
for mission in "$src"/missions/*/; do
  if [ ! -f "$mission/report.md" ]; then continue; fi
  out="$dest/missions/$(basename "$mission")"
  mkdir -p "$out"
  cp "$mission/report.md" "$out/"
  if [ -d "$mission/screenshots" ]; then cp -R "$mission/screenshots" "$out/"; fi
done
'

# Runs inside a small read-only container for `publish` (node, with the Mission Control folder mounted read-only and no
# network): prints the facts about one mission as lines of "key", a tab, and values. It only reads. Every text is
# cleaned first (control characters and invisible or direction-changing characters are dropped, spaces are collapsed,
# lengths are capped), because a mission's title and a feature's title were written by an AI. The host checks every
# value again with strict patterns and never runs any of it. The mission's id is the only argument.
# Exit status: 2 not a mission name, 3 no such mission, 4 the record can't be read, 5 the record is not a plain file.
IFS= read -r -d '' FACTS_SCRIPT <<'FACTS_END' || true
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const id = process.argv[1] || "";
if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id) || id.includes("..")) process.exit(2);

const out = [];
const put = (...cells) => out.push(cells.join("\t"));
const INVISIBLE = [[0xad, 0xad], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0xe0000, 0xe007f]];
const isControl = (cp) => cp < 32 || (cp >= 127 && cp <= 159) || cp === 0x2028 || cp === 0x2029;
const isInvisible = (cp) => INVISIBLE.some(([from, to]) => cp >= from && cp <= to);
// One line of plain text: controls become spaces, invisible characters go, runs of white space become one space.
function plain(value, max) {
  let text = "";
  for (const ch of String(value === undefined || value === null ? "" : value)) {
    const cp = ch.codePointAt(0);
    if (isControl(cp)) text += " ";
    else if (!isInvisible(cp)) text += ch;
  }
  return Array.from(text.replace(/\s+/g, " ").trim()).slice(0, max).join("");
}
// A line longer than `max` characters is cut at the end of the last sentence that fits, or else at the last space, and ends with "..." (the
// result is at most `max` characters, and a word is not cut in the middle).
function cutLine(text, max) {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  const window = chars.slice(0, max - 3);
  let end = -1;
  for (let i = window.length - 2; i >= 80; i--) {
    if (/[.!?]/.test(window[i]) && window[i + 1] === " ") {
      end = i + 1;
      break;
    }
  }
  if (end > 0) return window.slice(0, end).join("") + " ...";
  const space = window.lastIndexOf(" ");
  return (space > 0 ? window.slice(0, space) : window.slice(0, max - 3)).join("").replace(/\s+$/, "") + "...";
}
// One line of a report: like plain, but the spaces inside stay as they are (tables and lists keep their shape).
function reportLine(value) {
  let text = "";
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0);
    if (cp === 9) text += "  ";
    else if (isControl(cp)) text += " ";
    else if (!isInvisible(cp)) text += ch;
  }
  return cutLine(text.replace(/\s+$/, ""), 300);
}

const home = process.env.MC_HOME || path.join(os.homedir(), ".mission-control");
const dir = path.join(home, "missions", id);
let m;
try {
  const file = path.join(dir, "mission.json");
  const st = fs.lstatSync(file);
  if (!st.isFile()) process.exit(5);
  if (st.size > 64 * 1024 * 1024) process.exit(4);
  m = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (err) {
  process.exit(err && err.code === "ENOENT" ? 3 : 4);
}
if (!m || typeof m !== "object" || Array.isArray(m)) process.exit(4);

put("id", plain(m.id, 130));
put("kind", plain(m.kind, 20));
put("status", plain(m.status, 20));
put("title", plain(m.title, 100));
put("repo", plain(m.repoPath, 300));
put("base", plain(m.baseBranch, 120));
put("branch", plain(m.integrationBranch, 140));
if (typeof m.baseSha === "string" && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(m.baseSha)) put("basesha", m.baseSha);
const planSha = m.plan && typeof m.plan.sha256 === "string" ? m.plan.sha256 : "";
if (/^[0-9a-f]{64}$/.test(planSha)) put("plan", planSha.slice(0, 8));

const features = Array.isArray(m.features) ? m.features.filter((f) => f && typeof f === "object") : [];
const done = features.filter((f) => f.status === "done");
put("features_total", features.length);
put("features_done", done.length);
put("features_tested", done.filter((f) => Array.isArray(f.frozenTests) && f.frozenTests.length > 0).length);
// Features checked by a second AI and not by tests (docs/modes-spec.md, 10.5): only these change the words of "What was checked".
put("features_modes", done.filter((f) => f.mode === "review" || f.mode === "owner").length);
for (const f of features.filter((x) => x.status !== "done").slice(0, 20)) put("open", plain(f.status, 20), plain(f.title || f.id, 100));
if (m.baselineBroken === true) put("baseline_broken", "1");
const notes = Array.isArray(m.notes) ? m.notes : [];
put("unfinished_reviews", notes.filter((n) => typeof n === "string" && /^The review of .* did not finish/.test(n)).length);
// The review notes that were left open: the ones the report lists under "Review notes" (the copy of the report below does not reach that far).
put("open_notes", features.reduce((n, f) => n + (Array.isArray(f.openFindings) ? f.openFindings.length : 0), 0));
// A mission that stopped to wait for the owner's check (the plan, a feature or the finished app) says so; one that is only paused does not.
if (m.checkpoint && typeof m.checkpoint === "object" && m.checkpoint.state === "pending" && m.stage !== "complete") put("waiting", "1");

const KINDS = ["plan", "feature", "final"];
for (const kind of (Array.isArray(m.checkpoints) ? m.checkpoints : []).filter((k) => KINDS.includes(k)).slice(0, 3)) put("asked", kind);
for (const r of (Array.isArray(m.checkpointLog) ? m.checkpointLog : []).slice(-50)) {
  if (!r || !KINDS.includes(r.kind) || !["approve", "send_back"].includes(r.decision)) continue;
  const feature = r.kind === "feature" ? features.find((x) => x.id === r.featureId) : undefined;
  put("answer", r.kind, r.decision, feature ? plain(feature.title || feature.id, 100) || "-" : "-");
}

// The first lines of the report, without the steps for trying the app on this PC and without pictures.
try {
  const file = path.join(dir, "report.md");
  const st = fs.lstatSync(file);
  if (st.isFile() && st.size <= 5 * 1024 * 1024) {
    let skipping = false;
    let lastBlank = true;
    let kept = 0;
    let checked = "";
    for (const raw of fs.readFileSync(file, "utf8").split("\n").slice(0, 120)) {
      const line = raw.replace(/\r$/, "");
      // The report's own "Checked:" line (in its header), copied as the report wrote it.
      if (checked === "" && /^Checked: /.test(line)) {
        checked = plain(line, 600);
        put("checked", checked);
      }
      if (/^#{1,2} /.test(line)) skipping = /^## (How to try it|Usage|Technical details)\b/.test(line);
      if (skipping || line.trim().startsWith("![")) continue;
      const text = reportLine(line);
      if (text === "" && lastBlank) continue;
      lastBlank = text === "";
      put("report", text);
      if (++kept >= 30) break;
    }
  }
} catch (err) {
  // No report: the pull request says so.
}
process.stdout.write(out.join("\n") + "\n");
FACTS_END
readonly FACTS_SCRIPT

usage() {
  cat <<'EOF'
Usage: mc-docker.sh <command> [arguments...]

Setup and maintenance:
  build [docker build flags]   Build the Mission Control image (again after every update)
  login-claude                 Log in to Claude once (type /login if it doesn't ask, /exit when done)
  login-codex                  Log in to Codex once (shows a link and a one-time code to approve)
  shell                        Open a terminal inside the container; port 3000 reaches your browser
  copy-reports                 Copy reports and screenshots to ~/mc-reports, readable from Windows
  dashboard [--port N] [--lan] [--until HH:MM]
                               Show the team's progress on a web page at http://localhost:8787 (it only reads).
                               --lan lets other devices on your network open it too. Ctrl+C stops it.
  fix-permissions              Repair ownership of the login and data volumes
  install-leader               Remember where Mission Control is, so the Windows shortcuts find the leader (once)
  leader [--no-remote]         Start the leader (Claude Code) in the leader folder
  help                         Show this help

On this PC, with your own GitHub login (never inside the container):
  get <owner/repo | github.com address> [folder-name]
                               Download a GitHub repository into ~/mc-apps/<folder-name>
  publish-preview <mission>    Show where a finished mission's work would go on GitHub. It uploads nothing
  publish <mission> --to <owner/repo>
                               Upload a finished mission's branch and open a draft pull request, to the repository you name

Everything else goes to Mission Control inside the container, for example:
  doctor [--live]              Check the setup
  new "<idea>"                 Queue a new app
  run --until 07:00            Work until 7:00 (only one run at a time)
  status | report | stop       See progress, read the report, stop a run
  plan preview|queue|show      Plans written outside the team (write - after preview or queue to send the plan in)

  --help                       List all Mission Control commands
EOF
}

say() {
  printf 'mc-docker: %s\n' "$*"
}

warn() {
  printf 'mc-docker: %s\n' "$*" >&2
}

die() {
  warn "$@"
  if [ -n "$NOTIFY_FAILURE" ]; then
    notify_start_failure "$*"
  fi
  exit 1
}

# Prints each argument as its own line of an error, then stops.
die_lines() {
  local line
  for line in "$@"; do
    warn "$line"
  done
  exit 1
}

# At most 60 plain ASCII characters of $1, for echoing someone's input back in a message: nothing in it can move the
# cursor, change colors or hide text.
shown() {
  printf '%s' "$1" | LC_ALL=C tr -cd '\040-\176' | cut -c1-60
}

# Best effort: pushes why a scheduled run didn't start to the address the last run that started left in NOTIFY_URL_FILE.
notify_start_failure() {
  local url=""
  if [ -r "$NOTIFY_URL_FILE" ]; then
    read -r url <"$NOTIFY_URL_FILE" || true
  fi
  if [ -z "$url" ] || ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  if ! curl --fail --silent --show-error --max-time 20 --retry 2 \
    --header "Title: Mission Control: the run didn't start" \
    --header "Priority: 4" \
    --header "Tags: warning" \
    --data-binary "$1" "$url" >/dev/null; then
    warn "couldn't send this message to your iPad either."
  fi
}

on_terminal() {
  [ -t 0 ] && [ -t 1 ]
}

refuse_root() {
  if [ "$(id -u)" -eq 0 ]; then
    die "run this as your normal Ubuntu user, without sudo."
  fi
}

docker_ready() {
  command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1
}

# Polls Docker for up to DOCKER_WAIT_SECONDS; fails if it never answers.
wait_for_docker() {
  local waited=0
  say "waiting for Docker to start (up to $((DOCKER_WAIT_SECONDS / 60)) minutes)."
  while [ "$waited" -lt "$DOCKER_WAIT_SECONDS" ]; do
    sleep "$DOCKER_POLL_SECONDS"
    waited=$((waited + DOCKER_POLL_SECONDS))
    if docker_ready; then
      return 0
    fi
  done
  return 1
}

# Pass "wait" to give Docker Desktop time to start instead of failing at once.
require_docker() {
  if docker_ready || { [ "${1:-}" = "wait" ] && wait_for_docker; }; then
    return
  fi
  # Docker Desktop's WSL integration makes Ubuntu's docker command a link into Docker Desktop, which points nowhere
  # while Docker Desktop is stopped: then the command looks missing too, and not running is the likelier cause.
  if ! command -v docker >/dev/null 2>&1; then
    die "Docker isn't available in Ubuntu. Docker Desktop is probably not running: start it, wait until it shows \"Engine running\", then try again. If it is already running, open its Settings > Resources > WSL integration, turn on Ubuntu, click \"Apply & restart\", and open a new Ubuntu window."
  fi
  die "Docker isn't running. Start Docker Desktop, wait until it shows \"Engine running\", then try again."
}

require_image() {
  if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    die "the Mission Control image isn't built yet. Run: mc build"
  fi
}

require_terminal() {
  if ! on_terminal; then
    die "\"$1\" is interactive: run it yourself in an Ubuntu window."
  fi
}

# Your Ubuntu timezone (WSL copies it from Windows), so times like "--until 07:00" mean your local time.
host_timezone() {
  local zone="${TZ:-}"
  if [ -z "$zone" ]; then
    zone="$(readlink /etc/localtime 2>/dev/null || true)"
    case "$zone" in
      */zoneinfo/*) zone="${zone#*/zoneinfo/}" ;;
      *) zone="" ;;
    esac
  fi
  if [ -z "$zone" ] && [ -r /etc/timezone ]; then
    zone="$(</etc/timezone)"
  fi
  if [ -z "$zone" ]; then
    warn "couldn't tell your timezone, so times such as 07:00 mean UTC. To fix it, run: sudo dpkg-reconfigure tzdata"
  fi
  printf '%s\n' "$zone"
}

# Prints where a host path inside ~/mc-apps is in the container; prints nothing for any other path.
container_path() {
  case "$1" in
    "$APPS_DIR" | "$APPS_DIR"/*) printf '%s\n' "$CONTAINER_HOME/mc-apps${1#"$APPS_DIR"}" ;;
  esac
}

# Prints MEMORY_PERCENT of the memory Docker has (on Windows, Docker Desktop's WSL2 machine) in MiB, as a --memory
# value. Prints nothing when Docker doesn't say.
memory_limit() {
  local total
  total="$(docker info --format '{{.MemTotal}}' 2>/dev/null || true)"
  case "$total" in
    '' | *[!0-9]*) return 0 ;;
  esac
  if [ "$total" -lt 1073741824 ]; then
    return 0 # under 1 GiB is no real answer
  fi
  printf '%sm\n' "$((total * MEMORY_PERCENT / 100 / 1048576))"
}

# Fills CONTAINER_BASE (once) with what every container gets: an init process that forwards signals, shared memory
# for Chromium, the limits, logins and data in named volumes, and apps in ~/mc-apps.
# The limits: no Linux capabilities and no gaining any through setuid programs (agents run as an ordinary user and
# need none), at most PIDS_LIMIT processes and threads, and MEMORY_PERCENT of Docker's memory. `--memory-swap -1`
# leaves swap to WSL's own setting (a quarter of its memory by default, less than the limit anyway), so Docker
# prints no warning on a kernel that can't limit swap.
# Playwright's browsers get a volume too, so a browser an agent installs for an app's newer Playwright is still
# there for the next run; Docker fills a new, empty volume with the browsers that come with the image.
container_base() {
  if [ "${#CONTAINER_BASE[@]}" -gt 0 ]; then
    return
  fi
  local memory
  memory="$(memory_limit)"
  CONTAINER_BASE=(--rm --init --shm-size=1g
    --cap-drop ALL --security-opt no-new-privileges --pids-limit "$PIDS_LIMIT")
  if [ -n "$memory" ]; then
    CONTAINER_BASE+=(--memory "$memory" --memory-swap -1)
  fi
  # Docker would create a missing bind-mount folder owned by root, which the container then can't write to.
  mkdir -p "$APPS_DIR"
  CONTAINER_BASE+=(
    --volume "mc-claude:$CONTAINER_HOME/.claude"
    --volume "mc-codex:$CONTAINER_HOME/.codex"
    --volume "mc-home:$CONTAINER_HOME/.mission-control"
    --volume "mc-browsers:/ms-playwright"
    --volume "$APPS_DIR:$CONTAINER_HOME/mc-apps"
  )
}

# Replaces this script with `docker run` (so signals reach the container directly), adding what every container
# gets (container_base), your timezone, and a terminal when there is one (none under Task Scheduler).
# Usage: run_container [extra docker run flags...] -- command [arguments...]
run_container() {
  local -a flags=()
  while [ "$1" != "--" ]; do
    flags+=("$1")
    shift
  done
  shift
  if on_terminal; then
    flags+=(--interactive --tty)
  fi
  local zone workdir
  zone="$(host_timezone)"
  if [ -n "$zone" ]; then
    flags+=(--env "TZ=$zone")
  fi
  # Started from inside ~/mc-apps, the command starts in the same folder, so relative paths such as "." work.
  workdir="$(container_path "$PWD")"
  if [ -n "$workdir" ]; then
    flags+=(--workdir "$workdir")
  fi
  container_base
  exec docker run "${CONTAINER_BASE[@]}" "${flags[@]}" "$IMAGE" "$@"
}

# Refreshes NOTIFY_URL_FILE from Mission Control's settings: written when an address is set, removed when none is,
# kept as it was when the settings can't be read. The address works like a password, so only you can read the file.
remember_notify_url() {
  local url
  container_base
  if ! url="$(docker run "${CONTAINER_BASE[@]}" "$IMAGE" mc config get notify.ntfyUrl 2>/dev/null)"; then
    return 0
  fi
  case "$url" in
    "(not set)") rm -f -- "$NOTIFY_URL_FILE" ;;
    *[[:space:]]*) ;; # not a single address: keep the copy as it was
    https://?* | http://?*)
      mkdir -p -- "${NOTIFY_URL_FILE%/*}"
      (umask 077 && printf '%s\n' "$url" >"$NOTIFY_URL_FILE")
      ;;
  esac
}

build_image() {
  say "building $IMAGE. The first build downloads about 2 GB and can take 5 to 15 minutes."
  docker build \
    --file "$REPO_DIR/docker/Dockerfile" \
    --tag "$IMAGE" \
    --build-arg "MC_UID=$(id -u)" \
    --build-arg "MC_GID=$(id -g)" \
    "$@" "$REPO_DIR"
  say "the image is ready."
}

# True for a `plan` command that was told to read the plan sent in with it (an argument is `-`) when the input is not
# a terminal: a here-document or a pipe. Docker closes a container's input unless it is asked to keep it open, and then
# the plan would never arrive. The leader's tool has no terminal, so this is the case it meets.
plan_reads_input() {
  [ "${1:-}" = "plan" ] || return 1
  if [ -t 0 ]; then
    return 1
  fi
  local arg
  for arg in "$@"; do
    if [ "$arg" = "-" ]; then
      return 0
    fi
  done
  return 1
}

# Runs mc. Your shell turns ~/mc-apps/... into /home/<you>/mc-apps/..., which doesn't exist in the container,
# so arguments inside that folder are pointed at the same folder as the container sees it.
run_mc() {
  if [ "${1:-}" = "feature" ]; then
    mkdir -p "$APPS_DIR"
    check_feature_folder "${@:2}"
  fi
  local -a args=()
  local arg translated
  for arg in "$@"; do
    translated="$(container_path "$arg")"
    args+=("${translated:-$arg}")
  done
  if plan_reads_input "$@"; then
    run_container --interactive -- mc "${args[@]}"
  else
    run_container -- mc "${args[@]}"
  fi
}

# mc's own lock can't see a run in another container, so a fixed container name lets Docker refuse a second one.
# The fixed hostname makes every run look like the same host to mc's lock: a lock left by a run that was killed (docker
# stop, a crash, a restart) is then judged by its pid, which is gone, instead of blocking the next run for 5 minutes.
run_work() {
  local running
  running="$(docker container inspect --format '{{.State.Running}}' "$RUN_CONTAINER" 2>/dev/null || true)"
  case "$running" in
    true)
      NOTIFY_FAILURE="" # no news for the iPad: the run that is working sends its own
      die "a Mission Control run is already active. To stop it, run: mc stop"
      ;;
    false) docker container rm "$RUN_CONTAINER" >/dev/null ;; # left behind by a crash
  esac
  remember_notify_url
  run_container --name "$RUN_CONTAINER" --hostname "$RUN_CONTAINER" -- mc run "$@"
}

# `dashboard [--port N] [--lan] [--until HH:MM]`: a read-only web page about the current work, in a container of its own.
# It gets none of what the other containers get (no logins, no apps folder) and sees the Mission Control folder through
# a read-only mount, so the operating system enforces that it never writes. `--entrypoint mc` skips docker/entrypoint.sh,
# which would complain about the read-only folder and the missing logins. No --hostname: a lock held by the run container
# (hostname mission-control-run) must look like another host's, so it is judged by its heartbeat and not by a pid.
run_dashboard() {
  local port="$DASHBOARD_PORT" stop_time="" publish_host="127.0.0.1:"
  while [ "$#" -gt 0 ]; do
    case "$1" in
      --port)
        [ "$#" -ge 2 ] || die "dashboard: --port needs a number, for example: mc dashboard --port 8787"
        port="$2"
        shift 2
        ;;
      --until)
        [ "$#" -ge 2 ] || die "dashboard: --until needs a time, for example: mc dashboard --until 07:00"
        stop_time="$2"
        shift 2
        ;;
      --lan)
        publish_host=""
        shift
        ;;
      *) die "dashboard: I don't know \"$1\". Usage: mc dashboard [--port N] [--lan] [--until HH:MM]" ;;
    esac
  done
  case "$port" in
    '' | *[!0-9]* | 0?*) die "dashboard: \"$port\" is not a port number. Use a whole number from 1 to 65535." ;;
  esac
  if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
    die "dashboard: \"$port\" is not a port number. Use a whole number from 1 to 65535."
  fi
  if [ -n "$stop_time" ] && ! [[ "$stop_time" =~ ^[0-9]{1,2}:[0-9]{2}$ ]]; then
    die "dashboard: \"$stop_time\" is not a time of day. Write it as HH:MM in 24-hour time, for example 07:00."
  fi
  local running
  running="$(docker container inspect --format '{{.State.Running}}' "$DASHBOARD_CONTAINER" 2>/dev/null || true)"
  case "$running" in
    true) die "the dashboard is already running. Open the address it printed when it started (http://localhost:$DASHBOARD_PORT unless you chose another port), or stop it with: docker stop $DASHBOARD_CONTAINER" ;;
    false) docker container rm "$DASHBOARD_CONTAINER" >/dev/null ;; # left behind by a crash
  esac
  # shellcheck disable=SC2054 # the commas are inside a mount option, not between array elements
  local -a flags=(--rm --init --name "$DASHBOARD_CONTAINER"
    --read-only --tmpfs /tmp:rw,size=16m
    --cap-drop ALL --security-opt no-new-privileges --pids-limit "$DASHBOARD_PIDS_LIMIT"
    --memory "$DASHBOARD_MEMORY" --memory-swap -1
    --volume "mc-home:$CONTAINER_HOME/.mission-control:ro"
    --publish "$publish_host$port:$port")
  local zone
  zone="$(host_timezone)"
  if [ -n "$zone" ]; then
    flags+=(--env "TZ=$zone")
  fi
  local -a mc_args=(dashboard --host 0.0.0.0 --port "$port")
  if [ -n "$stop_time" ]; then
    mc_args+=(--until "$stop_time")
  fi
  say "the dashboard is at http://localhost:$port (Ctrl+C to stop)"
  if [ -z "$publish_host" ]; then
    say "other devices on your network can open it too, at this computer's address and port $port."
  fi
  exec docker run "${flags[@]}" --entrypoint mc "$IMAGE" "${mc_args[@]}"
}

# `mc feature <app-folder> ...`: the container only sees ~/mc-apps, so an app folder anywhere else would look missing
# to Mission Control. Stops with what to do when the folder exists here but outside ~/mc-apps.
check_feature_folder() {
  local folder="" arg skip_next=""
  for arg in "$@"; do
    if [ -n "$skip_next" ]; then
      skip_next=""
      continue
    fi
    case "$arg" in
      --base | --name | --profile | --role) skip_next=1 ;; # an option followed by its value
      -*) ;;
      *)
        folder="$arg"
        break
        ;;
    esac
  done
  if [ -z "$folder" ] || [ ! -d "$folder" ]; then
    return # nothing to check here: Mission Control explains a missing folder itself
  fi
  local real apps_real
  real="$(cd -- "$folder" && pwd -P)"
  apps_real="$(cd -- "$APPS_DIR" && pwd -P)"
  case "$real" in
    "$apps_real" | "$apps_real"/*) return ;;
  esac
  die "Mission Control can only change apps inside ~/mc-apps: it works in a container that sees no other folder, so $real looks missing to it. Move or copy the app's folder there first, for example: mv \"$real\" ~/mc-apps/ and then run: mc feature ~/mc-apps/$(basename -- "$real") \"<your request>\""
}

copy_reports() {
  mkdir -p "$REPORTS_DIR"
  local windows_path="\\\\wsl.localhost\\${WSL_DISTRO_NAME:-Ubuntu}${REPORTS_DIR//\//\\}"
  say "copying reports to $REPORTS_DIR. In Windows File Explorer, open: $windows_path"
  run_container --volume "$REPORTS_DIR:$CONTAINER_HOME/mc-reports" -- bash -c "$COPY_REPORTS_SCRIPT"
}

# Volumes first created by an older image, or by hand, can end up owned by root. Root in the container needs two of
# the capabilities every container drops: changing owners, and reading folders that belong to someone else.
fix_permissions() {
  say "giving the login and data volumes back to the container user."
  run_container --user root --cap-add CHOWN --cap-add DAC_OVERRIDE --entrypoint chown -- -R pwuser:pwuser \
    "$CONTAINER_HOME/.claude" "$CONTAINER_HOME/.codex" "$CONTAINER_HOME/.mission-control"
}

# ───────────────────────────── The leader, and the Windows shortcuts ─────────────────────────────

# `install-leader`: records where this copy of Mission Control is and puts the small launcher next to it, so the Windows
# shortcuts (scripts/windows/*.cmd) can find the leader and the dashboard from anywhere. The launcher always starts the
# leader inside this copy's leader folder, so the leader's commands (../scripts/mc-docker.sh ...) keep matching its
# permission rules. After moving or downloading Mission Control again, run it once more from the new folder.
install_leader() {
  [ "$#" -eq 0 ] || die "install-leader takes no arguments. Usage: mc install-leader"
  local source_launcher="$REPO_DIR/scripts/windows/mc-launch.sh"
  if [ ! -f "$REPO_DIR/leader/CLAUDE.md" ] || [ ! -f "$REPO_DIR/leader/.claude/settings.json" ] || [ ! -f "$source_launcher" ]; then
    die "$REPO_DIR does not look like a whole copy of Mission Control: the leader folder or the launcher is missing. Download Mission Control again (docs/setup-windows.md, Step 3)."
  fi
  case "$REPO_DIR" in
    *$'\n'*) die "the folder's name has a line break in it, which can't be saved. Move Mission Control to a folder with an ordinary name." ;;
  esac
  mkdir -p -- "$CONFIG_DIR"
  printf '%s\n' "$REPO_DIR" >"$CHECKOUT_FILE.tmp.$$"
  mv -f -- "$CHECKOUT_FILE.tmp.$$" "$CHECKOUT_FILE"
  install -m 755 -- "$source_launcher" "$LAUNCHER_FILE.tmp.$$"
  mv -f -- "$LAUNCHER_FILE.tmp.$$" "$LAUNCHER_FILE"
  say "saved that Mission Control is in $REPO_DIR."
  say "put the launcher at ~/.config/mission-control/launch. The Windows shortcuts in scripts/windows use it."
  say "if you move Mission Control or download it again, run this command once more from the new folder."
}

# `leader [--no-remote]`: starts Claude Code in this copy's leader folder, which is where its instructions and its
# permission rules are. With remote control by default, so the same session can be reached from the Claude app.
start_leader() {
  local remote=1
  if [ "$#" -gt 1 ]; then
    die "leader: too many arguments. Usage: mc leader [--no-remote]"
  fi
  case "${1:-}" in
    "") ;;
    --no-remote) remote=0 ;;
    *) die "leader: I don't know \"$(shown "$1")\". Usage: mc leader [--no-remote]" ;;
  esac
  require_terminal "leader"
  local dir="$REPO_DIR/leader"
  if [ ! -f "$dir/CLAUDE.md" ] || [ ! -f "$dir/.claude/settings.json" ]; then
    die "the leader folder is missing from $REPO_DIR. Download Mission Control again (docs/setup-windows.md, Step 3)."
  fi
  if ! command -v claude >/dev/null 2>&1; then
    die "Claude Code isn't installed in Ubuntu itself (the copy inside Mission Control's container can't be used). Install it in Ubuntu, log in, then try again. See docs/setup-windows.md, \"Optional: start the leader\"."
  fi
  cd -- "$dir"
  if [ "$remote" -eq 1 ]; then
    exec claude --remote-control "Leader"
  fi
  exec claude
}

# ───────────────────────────── GitHub in and out (on this PC, never in the container) ─────────────────────────────
#
# `get` and `publish` use your own git and GitHub login. The container never sees a password or a token, and neither
# command is given one. Everything they take in (a web address, a folder name, a mission name) is checked against a
# strict pattern first, and everything they run is an array of arguments, never text that a shell reads.

# git for a copy of one branch that this script made itself, in a folder of its own. Nothing in it comes from an app's
# folder, where the AI team works and could have written hooks and settings that make git run commands. No hooks and
# no fsmonitor, no prompts, and ssh fails instead of asking.
clean_git() {
  env -u GIT_DIR -u GIT_WORK_TREE -u GIT_INDEX_FILE -u GIT_OBJECT_DIRECTORY -u GIT_ALTERNATE_OBJECT_DIRECTORIES \
    -u GIT_COMMON_DIR -u GIT_NAMESPACE -u GIT_PREFIX \
    GIT_TERMINAL_PROMPT=0 GIT_EDITOR=true GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh} -o BatchMode=yes" \
    git -c core.hooksPath=/dev/null -c core.fsmonitor=false -c protocol.ext.allow=never "$@"
}

# parse_github_address <text>
# Returns 0 and sets GH_OWNER, GH_REPO and GH_URL when <text> is one of the three forms that are accepted:
#   https://github.com/<owner>/<repo>   (a trailing .git or / is fine; the https:// may be left out)
#   git@github.com:<owner>/<repo>.git   (the .git is optional)
#   <owner>/<repo>
# Returns 1 when it names another host, and 2 when it is not a GitHub address at all. It only looks at the text.
parse_github_address() {
  local text="$1" form owner repo lower
  GH_OWNER="" GH_REPO="" GH_URL=""
  # A browser shows github.com/<owner>/<repo> without https://, and a host name may have capitals: accept both. The
  # address that is used afterwards is always built again from the owner and the repository.
  lower="${text,,}"
  case "$lower" in
    github.com/*) text="https://github.com/${text:11}" ;;
    https://github.com/*) text="https://github.com/${text:19}" ;;
  esac
  if [[ "$text" =~ ^https://github\.com/($GH_OWNER_RE)/($GH_REPO_RE)/?$ ]]; then
    form="https"
  elif [[ "$text" =~ ^git@github\.com:($GH_OWNER_RE)/($GH_REPO_RE)$ ]]; then
    form="ssh"
  elif [[ "$text" =~ ^($GH_OWNER_RE)/($GH_REPO_RE)$ ]]; then
    form="https"
  else
    case "$text" in
      https://github.com/* | git@github.com:*) return 2 ;; # github.com itself, but not the address of a repository
      *://* | *@*:*) return 1 ;;
    esac
    return 2
  fi
  owner="${BASH_REMATCH[1]}"
  repo="${BASH_REMATCH[2]}"
  repo="${repo%.git}"
  case "$repo" in
    "" | . | ..) return 2 ;;
  esac
  GH_OWNER="$owner"
  GH_REPO="$repo"
  if [ "$form" = "ssh" ]; then
    GH_URL="git@github.com:$owner/$repo.git"
  else
    GH_URL="https://github.com/$owner/$repo.git"
  fi
}

# A folder name for ~/mc-apps: a letter or digit first, then letters, digits, dots, dashes and underscores; 61 characters
# at most; no "..".
valid_folder_name() {
  [[ "$1" =~ ^[$ALNUM][$ALNUM._-]{0,60}$ ]] && [[ "$1" != *..* ]]
}

# A mission's name, as `mc status` shows it (for example 2026-10-12-dark-mode).
valid_mission_id() {
  [[ "$1" =~ ^[$ALNUM][$ALNUM._-]{0,127}$ ]] && [[ "$1" != *..* ]]
}

# A branch name to start from: no "..", no "//", and it does not end in "/", "." or ".lock".
valid_base_branch() {
  [[ "$1" =~ ^[$ALNUM][$ALNUM._/-]{0,100}$ ]] || return 1
  case "$1" in
    *..* | *//* | */ | *. | *.lock) return 1 ;;
  esac
}

# What the owner sees when an address can't be used: names github.com, and what to write instead.
explain_bad_address() {
  local text="$1" code="$2"
  if [ "$code" -eq 1 ]; then
    die_lines "Mission Control only works with github.com. \"$(shown "$text")\" is not a github.com address." \
      "Write it as owner/repo, as https://github.com/owner/repo, or as git@github.com:owner/repo.git."
  fi
  die_lines "I don't understand \"$(shown "$text")\" as a GitHub repository." \
    "Write it as owner/repo, as https://github.com/owner/repo, or as git@github.com:owner/repo.git."
}

# The same text in lower case (GitHub does not tell "Acme/Widgets" and "acme/widgets" apart).
lower_case() {
  printf '%s' "$1" | LC_ALL=C tr 'ABCDEFGHIJKLMNOPQRSTUVWXYZ' 'abcdefghijklmnopqrstuvwxyz'
}

# Sets PINNED to the repository ("owner/repo") that the app folder $1 was set up for, or to nothing. The note lives in
# ~/.config/mission-control/origins, which the container cannot see, so the AI team can't change it. A note that is not
# a plain "owner/repo" counts as no note.
read_pinned_origin() {
  local file="$ORIGINS_DIR/$1" line=""
  PINNED=""
  if [ -f "$file" ] && [ ! -L "$file" ]; then
    IFS= read -r line <"$file" || true
    if [[ "$line" =~ ^($GH_OWNER_RE)/($GH_REPO_RE)$ ]]; then
      PINNED="$line"
    fi
  fi
}

# Saves the note that the app folder $1 belongs to the repository $2 ("owner/repo"). Returns 1 when it can't.
remember_origin() {
  local app="$1" slug="$2" tmp
  mkdir -p -- "$ORIGINS_DIR" 2>/dev/null || return 1
  tmp="$(mktemp "$ORIGINS_DIR/.new.XXXXXX" 2>/dev/null)" || return 1
  if printf '%s\n' "$slug" >"$tmp" 2>/dev/null && mv -f -- "$tmp" "$ORIGINS_DIR/$app" 2>/dev/null; then
    return 0
  fi
  rm -f -- "$tmp"
  return 1
}

# Reads the "origin" of an app folder from its saved settings (read as a plain file, git never runs in the folder).
# Sets ORIGIN_STATE to "none" (there is none), "odd" (there are several, or it is not a plain github.com address) or
# "ok", and then GH_OWNER, GH_REPO and GH_URL as parse_github_address does.
read_origin() {
  local config="$1" lines="" count=0 code=0
  GH_OWNER="" GH_REPO="" GH_URL=""
  lines="$(clean_git config --file "$config" --get-all remote.origin.url 2>/dev/null || true)"
  if [ -n "$lines" ]; then
    count="$(printf '%s\n' "$lines" | wc -l | tr -d ' ')"
  fi
  if [ "$count" -eq 0 ]; then
    ORIGIN_STATE="none"
    return 0
  fi
  if [ "$count" -ne 1 ]; then
    ORIGIN_STATE="odd"
    return 0
  fi
  parse_github_address "$lines" || code=$?
  if [ "$code" -ne 0 ]; then
    ORIGIN_STATE="odd"
  else
    ORIGIN_STATE="ok"
  fi
}

# `get <github-url | owner/repo> [folder-name]`: downloads a repository into ~/mc-apps/<folder-name> with your own git
# login. Never overwrites: a folder that exists is left alone.
get_repo() {
  if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
    die_lines "get needs a GitHub repository and, if you like, a folder name." \
      "For example: mc get owner/repo     or: mc get https://github.com/owner/repo my-folder"
  fi
  local input="$1" name="${2:-}" code=0
  parse_github_address "$input" || code=$?
  if [ "$code" -ne 0 ]; then
    explain_bad_address "$input" "$code"
  fi
  if [ "$#" -eq 1 ]; then
    name="$GH_REPO"
    if ! valid_folder_name "$name"; then
      die_lines "The repository's name \"$(shown "$name")\" can't be used as a folder name here." \
        "Choose a folder name yourself. For example: mc get $(shown "$input") my-app"
    fi
  elif ! valid_folder_name "$name"; then
    die_lines "\"$(shown "$name")\" can't be used as a folder name." \
      "Start with a letter or a digit, use only letters, digits, dots, dashes and underscores, at most 61 characters, and no \"..\". For example: my-app"
  fi
  if ! command -v git >/dev/null 2>&1; then
    die "git isn't installed in Ubuntu. Install it with: sudo apt install git"
  fi
  mkdir -p -- "$APPS_DIR"
  local dest="$APPS_DIR/$name"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    die_lines "~/mc-apps/$name already exists, so I downloaded nothing and left it as it is." \
      "To download into another folder: mc get $(shown "$input") <folder-name>"
  fi
  say "downloading $GH_OWNER/$GH_REPO into ~/mc-apps/$name. This uses your own GitHub login."
  local output="" status=0
  output="$(clean_git clone --quiet -- "$GH_URL" "$dest" 2>&1)" || status=$?
  if [ "$status" -ne 0 ]; then
    local detail
    detail="$(printf '%s\n' "$output" | LC_ALL=C tr -cd '\n\040-\176' | tail -n 3)"
    warn "I could not download $GH_OWNER/$GH_REPO. Git said:"
    while IFS= read -r line; do
      [ -z "$line" ] || warn "  $line"
    done <<<"$detail"
    die_lines "Check the name first. If the repository is private, log in to GitHub on this PC, in your own Ubuntu window:" \
      "  gh auth login" \
      "  gh auth setup-git" \
      "Then try again. The steps are in docs/github-setup.md."
  fi
  say "downloaded $GH_OWNER/$GH_REPO into ~/mc-apps/$name."
  if remember_origin "$name" "$GH_OWNER/$GH_REPO"; then
    say "Mission Control will publish finished work from ~/mc-apps/$name only to $GH_OWNER/$GH_REPO."
  else
    warn "I could not save a note of where ~/mc-apps/$name came from. Publishing from it will ask you to name the repository."
  fi
  say "next, tell the team what to change. For example:"
  printf '  mc feature ~/mc-apps/%s "<what you want changed>"\n' "$name"
  say "or ask the leader. It can write a plan for you to read first (mc plan preview), then queue it."
}

# Reads one mission's record and report in a box of its own: read-only, no network, no logins, no apps folder. The mission
# folder lives in a Docker volume, which this PC can't read directly, and `mc` has no command that prints these facts.
# Prints FACTS_SCRIPT's lines; its exit status says why not (see FACTS_SCRIPT).
read_mission_facts() {
  docker run --rm --init --network none --read-only --tmpfs /tmp:rw,size=16m \
    --cap-drop ALL --security-opt no-new-privileges --pids-limit "$FACTS_PIDS_LIMIT" \
    --memory "$FACTS_MEMORY" --memory-swap -1 \
    --volume "mc-home:$CONTAINER_HOME/.mission-control:ro" \
    --entrypoint node "$IMAGE" -e "$FACTS_SCRIPT" -- "$1"
}

# Sets the F_* variables from FACTS_SCRIPT's lines. A value is data: it is only compared, counted and checked later.
parse_mission_facts() {
  F_ID="" F_KIND="" F_STATUS="" F_TITLE="" F_REPO="" F_BASE="" F_BRANCH="" F_BASESHA="" F_PLAN=""
  F_TOTAL=0 F_DONE=0 F_TESTED=0 F_MODES=0 F_UNFINISHED_REVIEWS=0 F_OPEN_NOTES=0 F_WAITING="" F_BASELINE_BROKEN="" F_CHECKED=""
  F_OPEN=() F_ASKED=() F_ANSWERS=() F_REPORT=()
  local line key rest
  while IFS= read -r line; do
    key="${line%%$'\t'*}"
    rest=""
    if [ "$line" != "$key" ]; then
      rest="${line#*$'\t'}"
    fi
    case "$key" in
      id) F_ID="$rest" ;;
      kind) F_KIND="$rest" ;;
      status) F_STATUS="$rest" ;;
      title) F_TITLE="$rest" ;;
      repo) F_REPO="$rest" ;;
      base) F_BASE="$rest" ;;
      branch) F_BRANCH="$rest" ;;
      basesha) F_BASESHA="$rest" ;;
      plan) F_PLAN="$rest" ;;
      features_total) F_TOTAL="$rest" ;;
      features_done) F_DONE="$rest" ;;
      features_tested) F_TESTED="$rest" ;;
      features_modes) F_MODES="$rest" ;;
      checked) F_CHECKED="$rest" ;;
      unfinished_reviews) F_UNFINISHED_REVIEWS="$rest" ;;
      open_notes) F_OPEN_NOTES="$rest" ;;
      waiting) F_WAITING="$rest" ;;
      baseline_broken) F_BASELINE_BROKEN="$rest" ;;
      open) F_OPEN+=("$rest") ;;
      asked) F_ASKED+=("$rest") ;;
      answer) F_ANSWERS+=("$rest") ;;
      report) F_REPORT+=("$rest") ;;
    esac
  done <<<"$1"
  F_TITLE="$(printf '%s' "$F_TITLE" | LC_ALL=C tr -d '\000-\037\177')"
  case "$F_KIND" in
    greenfield | feature) ;;
    *) F_KIND="" ;;
  esac
  for key in F_TOTAL F_DONE F_TESTED F_MODES F_UNFINISHED_REVIEWS F_OPEN_NOTES; do
    [[ "${!key}" =~ ^[0-9]{1,6}$ ]] || printf -v "$key" '%s' 0
  done
}

# Text from a mission (written by an AI) made safe to put in the body of a pull request, where "@name" tags a person,
# "#12" links an issue, "<...>" is read as HTML and a web address becomes a link: those characters are left out.
body_safe() {
  local text
  text="$(printf '%s' "$1" | LC_ALL=C tr -d '@#<>`\000-\037\177')"
  printf '%s' "${text//:\/\//:}"
}

# Writes the body of the draft pull request to $1 with printf, from the F_* facts. No fact reaches a command line.
write_pull_request_body() {
  local file="$1" title kind pair what
  title="$(body_safe "$F_TITLE")"
  [ -n "$title" ] || title="$F_ID"
  {
    printf '%s\n' "This is a draft pull request opened by Mission Control. Nothing is merged until you merge it."
    printf '\n'
    printf '%s\n' "- Mission: “$title” (\`$F_ID\`)"
    printf '%s\n' "- Branch: \`$F_BRANCH\`, to be merged into \`$F_BASE\`"
    if [ -n "$F_PLAN" ]; then
      printf '%s\n' "- Plan: written by the leader (plan code $F_PLAN)"
    fi
    if [ "$F_STATUS" = "partial" ]; then
      local features_word="features are"
      if [ "$F_TOTAL" -eq 1 ]; then
        features_word="feature is"
      fi
      printf '\n'
      printf '%s\n' "**This mission is only partly done.** $F_DONE of $F_TOTAL $features_word finished."
    fi
    printf '\n'
    printf '%s\n' "## What was checked"
    printf '\n'
    local by_reading="" finished_word="finished features"
    if [ "$F_DONE" -gt 0 ] && [ "$F_MODES" -gt 0 ]; then
      by_reading=1
    fi
    # "1 of 1 finished feature", "1 of 3 finished features": the noun follows the number of finished features.
    if [ "$F_DONE" -eq 1 ]; then
      finished_word="finished feature"
    fi
    if [ "$F_DONE" -eq 0 ]; then
      printf '%s\n' "- Tests: no feature was finished, so there is no test result to show."
    elif [ -n "$by_reading" ]; then
      # Some finished features were checked by a second AI and not by tests: no sentence may claim a test for them (spec 10.3).
      local checked_text
      checked_text="$(body_safe "${F_CHECKED#Checked: }")"
      printf '%s\n' "- Tests: the team wrote tests before the code for $F_TESTED of $F_DONE $finished_word. The rest were not checked by tests. The Checked line below says how each was checked."
      if [ "${F_CHECKED:0:9}" = "Checked: " ] && [ -n "$checked_text" ]; then
        printf '%s\n' "- Checked: $checked_text"
      else
        printf '%s\n' "- Checked: the report says how each feature was checked."
      fi
    else
      printf '%s\n' "- Tests: the team wrote tests before the code for $F_TESTED of $F_DONE $finished_word. A feature counts as finished only when its tests and the app's own checks pass."
    fi
    if [ -n "$F_BASELINE_BROKEN" ]; then
      if [ -z "$by_reading" ]; then
        printf '%s\n' "- The app's own checks were already failing before this work started, so only the new tests judged the new work."
      elif [ "$F_TESTED" -gt 0 ]; then
        printf '%s\n' "- The app's own checks were already failing before this work started, so they could not be used to judge the new work. The features checked by tests were judged by their new tests only."
      else
        printf '%s\n' "- The app's own checks were already failing before this work started, so they could not be used to judge the new work."
      fi
    fi
    if [ "$F_UNFINISHED_REVIEWS" -gt 0 ]; then
      local added_after="their tests passed"
      if [ -n "$by_reading" ]; then
        added_after="Mission Control's own checks passed"
      fi
      printf '%s\n' "- Review: a separate AI reviewer reads each feature before it is added. $F_UNFINISHED_REVIEWS review(s) did not finish. Those features were added after $added_after."
    else
      printf '%s\n' "- Review: a separate AI reviewer reads each feature before it is added. The first lines of the report are below. The whole report, with what the reviewers left open, is in Mission Control on the owner's PC: \`mc report $F_ID\`."
    fi
    # The copy of the report below is cut short, so the notes the reviewers left open are counted here, in a line of their own.
    if [ "$F_OPEN_NOTES" -eq 0 ]; then
      printf '%s\n' "- Open review notes: the reviewers left none open."
    elif [ "$F_OPEN_NOTES" -eq 1 ]; then
      printf '%s\n' "- Open review notes: the reviewers left 1 note open. The full report lists it: \`mc report $F_ID\` in Mission Control on the owner's PC."
    else
      printf '%s\n' "- Open review notes: the reviewers left $F_OPEN_NOTES notes open. The full report lists them: \`mc report $F_ID\` in Mission Control on the owner's PC."
    fi
    local -a stops=() unanswered=()
    local kind_name answered
    for pair in "${F_ANSWERS[@]}"; do
      IFS=$'\t' read -r kind what _ <<<"$pair"
      case "$kind" in
        plan) kind_name="the plan" ;;
        final) kind_name="the finished app" ;;
        *)
          kind_name="the feature “$(body_safe "${pair##*$'\t'}")”"
          ;;
      esac
      case "$what" in
        approve) stops+=("$kind_name: approved") ;;
        send_back) stops+=("$kind_name: sent back") ;;
      esac
    done
    for kind in "${F_ASKED[@]}"; do
      answered=""
      for pair in "${F_ANSWERS[@]}"; do
        case "$pair" in "$kind"$'\t'approve$'\t'*) answered=1 ;; esac
      done
      [ -n "$answered" ] || unanswered+=("$kind")
    done
    if [ "${#F_ASKED[@]}" -eq 0 ] && [ "${#stops[@]}" -eq 0 ]; then
      printf '%s\n' "- People: nobody looked at this before it was published. No stop for the owner's look was asked for."
    else
      if [ "${#stops[@]}" -gt 0 ]; then
        local joined="" stop
        for stop in "${stops[@]}"; do
          joined="${joined:+$joined; }$stop"
        done
        printf '%s\n' "- People: the owner answered at these stops: $joined. Mission Control records each answer. It cannot tell what the owner looked at."
      fi
      for kind in "${unanswered[@]}"; do
        case "$kind" in
          plan) what="the plan" ;;
          final) what="the finished app" ;;
          *) what="a feature" ;;
        esac
        printf '%s\n' "- People: a stop at $what was asked for, but no approval is recorded."
      done
    fi
    if [ "${#F_OPEN[@]}" -gt 0 ]; then
      printf '\n'
      printf '%s\n' "## Not finished"
      printf '\n'
      for pair in "${F_OPEN[@]}"; do
        what="${pair%%$'\t'*}"
        case "$what" in
          blocked) what="stuck" ;;
          skipped) what="left out" ;;
          *) what="not finished" ;;
        esac
        printf '%s\n' "- “$(body_safe "${pair#*$'\t'}")” ($what)"
      done
    fi
    printf '\n'
    printf '%s\n' "## From the report"
    printf '\n'
    if [ "${#F_REPORT[@]}" -eq 0 ]; then
      printf '%s\n' "No report was written for this mission."
    else
      # A fence one longer than any run of the same mark in the text, so the text can't close it.
      local longest=2 rest fence line
      for line in "${F_REPORT[@]}"; do
        rest="$line"
        while [[ "$rest" =~ (~+) ]]; do
          [ "${#BASH_REMATCH[1]}" -le "$longest" ] || longest="${#BASH_REMATCH[1]}"
          rest="${rest#*"${BASH_REMATCH[1]}"}"
        done
      done
      fence="$(printf '%*s' "$((longest + 1))" '' | tr ' ' '~')"
      printf '%s\n' "$fence"
      for line in "${F_REPORT[@]}"; do
        printf '%s\n' "$line"
      done
      printf '%s\n' "$fence"
    fi
  } >"$file"
}

# The address of the pull request in gh's answer, when there is one for this repository.
pull_request_address() {
  local text="$1" owner="$2" repo="$3" line
  while IFS= read -r line; do
    if [[ "$line" =~ (https://github\.com/"$owner"/"$repo"/pull/[0-9]+) ]]; then
      printf '%s\n' "${BASH_REMATCH[1]}"
      return 0
    fi
  done <<<"$text"
  return 1
}

# Sets PUBLISH_ID (the mission), PUBLISH_HAS_TO (1 when --to was given, even with an empty value) and PUBLISH_TO (the
# repository after --to) from the arguments of `publish`. $1 says whether --to is allowed. Returns 1 for anything but
# one mission name, with --to once at most.
parse_publish_args() {
  local allow_to="$1" have_id=""
  shift
  PUBLISH_ID="" PUBLISH_TO="" PUBLISH_HAS_TO=""
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--to" ] && [ "$allow_to" = "yes" ]; then
      if [ -n "$PUBLISH_HAS_TO" ] || [ "$#" -lt 2 ]; then
        return 1
      fi
      PUBLISH_HAS_TO=1
      PUBLISH_TO="$2"
      shift 2
    else
      if [ -n "$have_id" ]; then
        return 1
      fi
      have_id=1
      PUBLISH_ID="$1"
      shift
    fi
  done
  [ -n "$have_id" ]
}

# The refusal for an app folder whose "origin" is not one plain github.com address.
die_bad_origin() {
  die_lines "The GitHub address of $1 is not a plain github.com address, so I did not publish." \
    "It must look like https://github.com/owner/repo.git, with no login or password inside it, and there can be only one." \
    "Mission Control only publishes to github.com. The steps are in docs/github-setup.md."
}

# A new app: the engine has already moved the base branch to the finished work, so the branch has nothing the base
# doesn't, and GitHub has nothing yet either. There is no pull request to open. The whole app is uploaded once, by the
# owner, with the owner's own git. Says so, and stops.
explain_new_app() {
  local app="$1" label="$2" base="$3" config="$4" title="$5"
  warn "“$title” is a new app, and what was built is on the branch \"$base\" in $label already."
  warn "A new app goes to GitHub as a whole, once. A pull request needs work that GitHub does not have yet, and here there is none, so I have nothing to publish."
  read_origin "$config"
  case "$ORIGIN_STATE" in
    none)
      die_lines "$label has no GitHub address yet. To put the app on GitHub, do this once, in your own Ubuntu window:" \
        "  1. On github.com, create an empty repository (leave README, .gitignore and license off)." \
        "  2. git -C ~/mc-apps/$app remote add origin https://github.com/<owner>/<repo>.git" \
        "  3. git -C ~/mc-apps/$app push -u origin $base" \
        "After that, every later change to the app goes to GitHub with mc publish. The steps are in docs/github-setup.md." ;;
    ok)
      die_lines "The GitHub address of $label is github.com/$GH_OWNER/$GH_REPO. If that is the empty repository you made for this app, upload the app once, in your own Ubuntu window:" \
        "  git -C ~/mc-apps/$app push -u origin $base" \
        "If you did that already, there is nothing more to do. Later changes to the app go to GitHub with mc publish. The steps are in docs/github-setup.md." ;;
    *)
      die_lines "The GitHub address of $label is not a plain github.com address, or there is more than one." \
        "It must look like https://github.com/owner/repo.git, with no login or password inside it. Set it right with:" \
        "  git -C ~/mc-apps/$app remote set-url origin https://github.com/<owner>/<repo>.git" \
        "Then upload the app once: git -C ~/mc-apps/$app push -u origin $base" ;;
  esac
}

# `publish-preview <mission>` and `publish <mission> --to <owner/repo>`. The first says where the mission's work would go
# and uploads nothing. The second uploads the mission's branch mc/<id> to that GitHub repository and opens a draft pull
# request. Both check, in this order, with a plain refusal for each: the name, that the mission exists, that it is
# finished (or partly finished), that the branch has work the base branch doesn't (a new app has none: see
# explain_new_app), that the app folder is a git folder whose "origin" is a plain github.com address, and that this is
# the repository the folder was set up for. publish also needs the repository to be the one named after --to. It pushes
# only mc/<id>, never with force, never main or master.
#
# Where the work goes is read from the app folder's "origin", and the AI team writes in that folder. So the address is
# never taken on trust: `get` saves the repository it downloaded from (a note outside the container, in
# ~/.config/mission-control/origins), publish refuses an address that differs from the note, and without a note
# publish still needs the person to name the repository with --to, after seeing it in the preview.
#
# The app folder could also hold git settings and hooks that make git run commands, and publishing uses your GitHub
# login. So git never runs inside the app folder: the branch is copied into a new, empty folder made here, and everything
# that touches GitHub runs from that copy.
publish_mission() {
  local mode="$1" verb="publish" allow_to="yes"
  shift
  if [ "$mode" = "preview" ]; then
    verb="publish-preview"
    allow_to="no"
  fi
  if ! parse_publish_args "$allow_to" "$@"; then
    die_lines "$verb needs the name of one mission. See the names with: mc status" \
      "First see where the work would go: mc publish-preview 2026-10-12-dark-mode" \
      "Then upload it: mc publish 2026-10-12-dark-mode --to <owner>/<repo>"
  fi
  local id="$PUBLISH_ID" upload=""
  if ! valid_mission_id "$id"; then
    die_lines "\"$(shown "$id")\" is not a mission name. A mission name uses letters, digits, dots and dashes, like 2026-10-12-dark-mode." \
      "See the names with: mc status"
  fi
  if [ -n "$PUBLISH_HAS_TO" ]; then
    local to_ok=""
    if [[ "$PUBLISH_TO" =~ ^($GH_OWNER_RE)/($GH_REPO_RE)$ ]]; then
      case "${BASH_REMATCH[2]}" in
        . | ..) ;;
        *) to_ok=1 ;;
      esac
    fi
    if [ -z "$to_ok" ]; then
      die_lines "\"$(shown "$PUBLISH_TO")\" is not the name of a GitHub repository." \
        "Write it as owner/repo, like acme/widgets. The name to use is the one mc publish-preview $id prints."
    fi
    upload=1
  fi
  command -v git >/dev/null 2>&1 || die "git isn't installed in Ubuntu. Install it with: sudo apt install git"
  require_docker
  require_image

  local facts="" status=0
  facts="$(read_mission_facts "$id" 2>/dev/null)" || status=$?
  case "$status" in
    0) ;;
    3) die_lines "I can't find a mission called \"$id\"." "See the names with: mc status" ;;
    *) die_lines "I could not read the record of the mission \"$id\"." "Run mc doctor, or try again in a moment." ;;
  esac
  parse_mission_facts "$facts"
  local title pr_title
  title="$(shown "$F_TITLE")"
  [ -n "$title" ] || title="$id"
  pr_title="$F_TITLE"
  [ -n "$pr_title" ] || pr_title="$id"
  if [ "$F_ID" != "$id" ]; then
    die "the record in the mission folder \"$id\" belongs to another mission, so I did not publish."
  fi

  case "$F_STATUS" in
    done | partial) ;;
    failed) die_lines "“$title” stopped and needs your help, so I did not publish it." "Read what it needs with: mc report $id" ;;
    # "stopped" is the engine's own word: say what it means. Waiting for the owner's check, or paused until the next run (real run R5).
    stopped)
      if [ -n "$F_WAITING" ]; then
        die_lines "“$title” is waiting for your check, so I did not publish it." \
          "Only a finished or partly finished mission can be published. See what it waits for with: mc status"
      else
        die_lines "“$title” is paused and not finished, so I did not publish it." \
          "It carries on with the next run. Only a finished or partly finished mission can be published. See where it is with: mc status"
      fi
      ;;
    *) die_lines "“$title” is not finished (its state is \"$(shown "$F_STATUS")\"), so I did not publish it." \
      "Only a finished or partly finished mission can be published. See where it is with: mc status" ;;
  esac

  # What the record says must have the shape this script expects, whatever an AI may have written in it.
  local branch="mc/$id" base="$F_BASE"
  if [ "$F_BRANCH" != "$branch" ]; then
    die "the branch in the record of \"$id\" is not $branch, so I did not publish."
  fi
  if ! valid_base_branch "$base"; then
    die "the base branch in the record of \"$id\" is not a plain branch name, so I did not publish."
  fi
  case "$F_REPO" in
    "$CONTAINER_HOME"/mc-apps/*) ;;
    *) die "the app folder in the record of \"$id\" is not inside ~/mc-apps, so I did not publish." ;;
  esac
  local app="${F_REPO#"$CONTAINER_HOME"/mc-apps/}"
  if [[ "$app" =~ ^[$ALNUM][$ALNUM._-]{0,100}$ ]] && [[ "$app" != *..* ]]; then
    :
  else
    die_lines "The app's folder name \"$(shown "$app")\" has characters that publish does not accept." \
      "Rename the folder to letters, digits, dots, dashes and underscores, then publish again."
  fi
  local app_dir="$APPS_DIR/$app" app_label="~/mc-apps/$app"
  if [ -L "$app_dir" ] || [ ! -d "$app_dir" ]; then
    die "$app_label is not a folder here, so I did not publish. Is the app in another place?"
  fi
  if [ -L "$app_dir/.git" ] || [ ! -d "$app_dir/.git" ]; then
    die_lines "$app_label is not a plain git folder (it has no .git folder of its own), so I did not publish." \
      "Mission Control needs a folder it can read the branch $branch from."
  fi

  PUBLISH_TMP="$(mktemp -d "${TMPDIR:-/tmp}/mc-publish.XXXXXX")"
  trap 'rm -rf -- "$PUBLISH_TMP"' EXIT
  local work="$PUBLISH_TMP/work"
  clean_git init --quiet "$work" >/dev/null 2>&1 || die "I could not make a working folder in ${TMPDIR:-/tmp}. Is the disk full?"

  # The new work, copied from the app folder into the empty folder: only the branch (and the base, to compare with).
  local output=""
  if ! output="$(clean_git -C "$work" fetch --quiet --no-tags --no-write-fetch-head -- "$app_dir" "refs/heads/$branch:refs/mc-publish/branch" 2>&1)"; then
    warn "I could not read the branch $branch in $app_label, so there is nothing to publish. Git said:"
    printf '%s\n' "$output" | LC_ALL=C tr -cd '\n\040-\176' | tail -n 2 | while IFS= read -r detail; do
      [ -z "$detail" ] || warn "  $detail"
    done
    die "Was the app folder replaced, or the branch deleted?"
  fi
  local compare_from=""
  if clean_git -C "$work" fetch --quiet --no-tags --no-write-fetch-head -- "$app_dir" "refs/heads/$base:refs/mc-publish/base" >/dev/null 2>&1; then
    compare_from="refs/mc-publish/base"
  elif [[ "$F_BASESHA" =~ ^[0-9a-f]{40}$ ]]; then
    compare_from="$F_BASESHA"
  else
    die "I can't tell which commits are new: the branch \"$base\" is not in $app_label. Put it back, then publish again."
  fi
  local count=""
  count="$(clean_git -C "$work" rev-list --count "$compare_from..refs/mc-publish/branch" 2>/dev/null)" || count=""
  if ! [[ "$count" =~ ^[0-9]+$ ]]; then
    die "I can't tell which commits are new on $branch compared with \"$base\", so I did not publish."
  fi
  if [ "$count" -eq 0 ]; then
    # When the engine finishes a new app it moves the base branch onto the finished work, so the branch is not ahead.
    if [ "$F_KIND" = "greenfield" ]; then
      explain_new_app "$app" "$app_label" "$base" "$app_dir/.git/config" "$title"
    fi
    die_lines "There is nothing to publish: $branch has no new work compared with \"$base\"."
  fi

  # Where it goes: the app folder's own "origin", which has to be a plain github.com address.
  local config="$app_dir/.git/config"
  read_origin "$config"
  if [ "$ORIGIN_STATE" = "none" ]; then
    die_lines "$app_label has no GitHub address yet (no \"origin\"), so I did not publish." \
      "Create an empty repository on github.com first. Then, once, in your own Ubuntu window:" \
      "  git -C ~/mc-apps/$app remote add origin https://github.com/<owner>/<repo>.git" \
      "  git -C ~/mc-apps/$app push origin $base" \
      "Then publish again. The steps are in docs/github-setup.md."
  fi
  if [ "$ORIGIN_STATE" != "ok" ]; then
    die_bad_origin "$app_label"
  fi
  local url="$GH_URL" owner="$GH_OWNER" repo="$GH_REPO"

  # The AI team can write in the app folder, so its "origin" can have been changed to another repository. It has to be
  # the repository the folder was set up for, when Mission Control knows that one, and the one the person named.
  read_pinned_origin "$app"
  if [ -n "$PINNED" ] && [ "$(lower_case "$PINNED")" != "$(lower_case "$owner/$repo")" ]; then
    die_lines "$app_label was set up for $PINNED, but its GitHub address now says $owner/$repo, so I did not publish." \
      "The AI team can write in that folder, so a person has to check this before anything is uploaded." \
      "To see what the folder says: cat ~/mc-apps/$app/.git/config" \
      "If you changed the address on purpose, remove the old note and publish again: rm ~/.config/mission-control/origins/$app"
  fi
  if [ -n "$upload" ] && [ "$(lower_case "$PUBLISH_TO")" != "$(lower_case "$owner/$repo")" ]; then
    die_lines "You asked me to upload to $PUBLISH_TO, but $app_label points to $owner/$repo, so I did not publish." \
      "See where the work would go with: mc publish-preview $id"
  fi

  # The app uses git hooks or big-file storage (Git LFS): those run before an upload, and this script does not run an
  # app's hooks. Uploading without them could leave GitHub with files it can't use, so the owner uploads it by hand.
  local hooks_path=""
  hooks_path="$(clean_git config --file "$config" --get core.hooksPath 2>/dev/null || true)"
  if [ -x "$app_dir/.git/hooks/pre-push" ] || [ -n "$hooks_path" ] || clean_git -C "$work" grep -q -F "filter=lfs" "refs/mc-publish/branch" -- '*.gitattributes' >/dev/null 2>&1; then
    die_lines "$app_label uses git hooks or Git LFS (big-file storage), which Mission Control never runs, so I did not publish." \
      "To upload the branch yourself, in your own Ubuntu window: git -C ~/mc-apps/$app push origin $branch" \
      "Then open the pull request on github.com."
  fi

  # Without --to this is the preview: it says where the work would go, and uploads nothing.
  if [ -z "$upload" ]; then
    say "“$title” ($id) is ready to publish."
    say "It would go to github.com/$owner/$repo: the branch $branch, and then a draft pull request into \"$base\"."
    if [ -n "$PINNED" ]; then
      say "Mission Control set up $app_label for $PINNED, and that is where it points."
    else
      say "Mission Control does not know where $app_label came from, and the AI team can change its GitHub address. Check that $owner/$repo is the repository you mean."
    fi
    say "Nothing has been uploaded."
    if [ "$mode" = "preview" ]; then
      say "To upload it: mc publish $id --to $owner/$repo"
      return 0
    fi
    warn "publish uploads only where you tell it to, so I stopped here. To go on: mc publish $id --to $owner/$repo"
    exit 1
  fi

  clean_git -C "$work" remote add origin "$url" >/dev/null 2>&1 || die "I could not prepare the upload."
  local heads=""
  if ! heads="$(clean_git -C "$work" ls-remote --heads origin "refs/heads/$base" 2>&1)"; then
    die_lines "I could not reach $owner/$repo on GitHub. Git said:" "  $(printf '%s\n' "$heads" | LC_ALL=C tr -cd '\n\040-\176' | tail -n 1)" \
      "If it is private, log in to GitHub on this PC: gh auth login, then gh auth setup-git. The steps are in docs/github-setup.md."
  fi
  local found="" head_line
  while IFS= read -r head_line; do
    [ "${head_line#*$'\t'}" = "refs/heads/$base" ] && found=1
  done <<<"$heads"
  if [ -z "$found" ]; then
    die_lines "The branch \"$base\" is not on GitHub in $owner/$repo yet, so a pull request has nothing to compare with." \
      "Upload it once yourself, in your own Ubuntu window: git -C ~/mc-apps/$app push origin $base" \
      "Then publish again."
  fi

  say "uploading $branch to $owner/$repo. This uses your own GitHub login."
  local push_output="" push_status=0
  push_output="$(clean_git -C "$work" push --quiet origin "refs/mc-publish/branch:refs/heads/$branch" 2>&1)" || push_status=$?
  if [ "$push_status" -ne 0 ]; then
    local why
    why="$(printf '%s\n' "$push_output" | LC_ALL=C tr -cd '\n\040-\176' | tail -n 3)"
    warn "I could not upload $branch. Git said:"
    while IFS= read -r head_line; do
      [ -z "$head_line" ] || warn "  $head_line"
    done <<<"$why"
    case "$push_output" in
      *rejected* | *non-fast-forward* | *"fetch first"*)
        die_lines "GitHub already has a branch called $branch with other work on it. I never overwrite it." \
          "Look at it on github.com. If you want to replace it, delete that branch there yourself, then publish again." ;;
      *)
        die_lines "If it asked for a login: log in to GitHub on this PC, in your own Ubuntu window: gh auth login, then gh auth setup-git." \
          "The steps are in docs/github-setup.md." ;;
    esac
  fi
  say "$branch is now on github.com/$owner/$repo. The base branch \"$base\" was not changed."
  # The first time a folder is published, the repository the person named is remembered for it.
  if [ -z "$PINNED" ]; then
    if remember_origin "$app" "$owner/$repo"; then
      say "Mission Control will publish finished work from $app_label only to $owner/$repo from now on."
    else
      warn "I could not save a note of which repository $app_label belongs to."
    fi
  fi

  local compare="https://github.com/$owner/$repo/compare/$base...$branch?expand=1"
  if ! command -v gh >/dev/null 2>&1; then
    say "the GitHub tool gh is not installed here, so I did not open the pull request."
    say "open it yourself: $compare"
    return 0
  fi
  local body_file="$PUBLISH_TMP/body.md"
  write_pull_request_body "$body_file"
  local pr_output="" pr_status=0
  pr_output="$(cd -- "$work" && env GH_PROMPT_DISABLED=1 NO_COLOR=1 GH_NO_UPDATE_NOTIFIER=1 GH_PAGER=cat \
    gh pr create --draft --repo "$owner/$repo" --head "$branch" --base "$base" --title="$pr_title" --body-file="$body_file" 2>&1)" || pr_status=$?
  local address=""
  address="$(pull_request_address "$pr_output" "$owner" "$repo" || true)"
  if [ -n "$address" ]; then
    if [ "$pr_status" -eq 0 ]; then
      say "draft pull request: $address"
      say "it is a draft: nothing is merged until you merge it on github.com."
    else
      say "a pull request for this branch already exists: $address"
    fi
    return 0
  fi
  warn "the branch is on GitHub, but I could not open the draft pull request. gh said:"
  printf '%s\n' "$pr_output" | LC_ALL=C tr -cd '\n\040-\176' | tail -n 3 | while IFS= read -r head_line; do
    [ -z "$head_line" ] || warn "  $head_line"
  done
  warn "open it yourself: $compare"
  warn "if gh asks for a login: gh auth login. The steps are in docs/github-setup.md."
  exit 1
}

main() {
  local command="${1:-help}"
  if [ "$command" = "help" ]; then
    usage
    return
  fi
  refuse_root
  # These need no Docker: get, install-leader and leader run on this PC alone, and publish and publish-preview ask Docker
  # only after their checks.
  case "$command" in
    get)
      shift
      get_repo "$@"
      return
      ;;
    publish)
      shift
      publish_mission publish "$@"
      return
      ;;
    publish-preview)
      shift
      publish_mission preview "$@"
      return
      ;;
    install-leader)
      shift
      install_leader "$@"
      return
      ;;
    leader)
      shift
      start_leader "$@"
      return
      ;;
  esac
  # Only an unattended run waits for Docker, and tells your iPad when it can't start; at a terminal, you hear
  # about it straight away.
  if [ "$command" = "run" ] && ! on_terminal; then
    NOTIFY_FAILURE=1
    require_docker wait
  else
    require_docker
  fi
  if [ "$command" = "build" ]; then
    shift
    build_image "$@"
    return
  fi
  require_image
  case "$command" in
    login-claude)
      require_terminal "$command"
      say "starting Claude Code. Log in when it asks (or type /login), then type /exit."
      run_container -- claude
      ;;
    login-codex) run_container -- codex login --device-auth ;;
    shell)
      require_terminal "$command"
      run_container --publish "127.0.0.1:$PREVIEW_PORT:$PREVIEW_PORT" -- bash
      ;;
    copy-reports) copy_reports ;;
    dashboard)
      shift
      run_dashboard "$@"
      ;;
    fix-permissions) fix_permissions ;;
    run)
      shift
      run_work "$@"
      ;;
    *) run_mc "$@" ;;
  esac
}

# Run only when the file is started, not when a test loads it to try its checks one by one.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  main "$@"
fi
