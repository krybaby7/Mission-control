#!/usr/bin/env bash
# Runs Mission Control inside its Docker container. Use it from Ubuntu (WSL2) on the machine with Docker Desktop.
# docs/setup-windows.md sets up the alias `mc` for this script; run it with no arguments for the command list.
set -euo pipefail

readonly IMAGE="mission-control:local"
readonly RUN_CONTAINER="mission-control-run"
readonly DASHBOARD_CONTAINER="mission-control-dashboard"
readonly DASHBOARD_PORT=8787
# The dashboard only serves two small documents, so its box is much smaller than a night run's.
readonly DASHBOARD_PIDS_LIMIT=256
readonly DASHBOARD_MEMORY="256m"
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
# The notification address lives in the mc-home volume. A copy outside the container lets a night run that can't
# start (Docker Desktop not running, the image missing) still tell your iPad why. Refreshed whenever a run starts.
readonly NOTIFY_URL_FILE="$HOME/.config/mission-control/ntfy-url"
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_DIR
# Set for an unattended night run: `die` then also sends its message to the iPad.
NOTIFY_FAILURE=""
# The `docker run` arguments every container gets, filled once by container_base.
CONTAINER_BASE=()

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
                               Show tonight's progress on a web page at http://localhost:8787 (it only reads).
                               --lan lets other devices on your network open it too. Ctrl+C stops it.
  fix-permissions              Repair ownership of the login and data volumes
  help                         Show this help

Everything else goes to Mission Control inside the container, for example:
  doctor [--live]              Check the setup
  new "<idea>"                 Queue a new app
  run --until 07:00            Work until 7am (only one run at a time)
  status | report | stop       See progress, read the report, stop a run

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

# Best effort: pushes why tonight's run didn't start to the address the last run that started left in NOTIFY_URL_FILE.
notify_start_failure() {
  local url=""
  if [ -r "$NOTIFY_URL_FILE" ]; then
    read -r url <"$NOTIFY_URL_FILE" || true
  fi
  if [ -z "$url" ] || ! command -v curl >/dev/null 2>&1; then
    return 0
  fi
  if ! curl --fail --silent --show-error --max-time 20 --retry 2 \
    --header "Title: Mission Control: the night run didn't start" \
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
# there the next night; Docker fills a new, empty volume with the browsers that come with the image.
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
  run_container -- mc "${args[@]}"
}

# mc's own lock can't see a run in another container, so a fixed container name lets Docker refuse a second one.
# The fixed hostname makes every night run the same host to mc's lock: a lock left by a run that was killed (docker
# stop, a crash, a restart) is then judged by its pid, which is gone, instead of blocking the next run for 5 minutes.
run_night() {
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

# `dashboard [--port N] [--lan] [--until HH:MM]`: a read-only web page about tonight's run, in a container of its own.
# It gets none of what the other containers get (no logins, no apps folder) and sees the Mission Control folder through
# a read-only mount, so the operating system enforces that it never writes. `--entrypoint mc` skips docker/entrypoint.sh,
# which would complain about the read-only folder and the missing logins. No --hostname: a lock held by the night run
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

main() {
  local command="${1:-help}"
  if [ "$command" = "help" ]; then
    usage
    return
  fi
  refuse_root
  # Only an unattended night run waits for Docker, and tells your iPad when it can't start; at a terminal, you hear
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
      run_night "$@"
      ;;
    *) run_mc "$@" ;;
  esac
}

main "$@"
