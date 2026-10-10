#!/usr/bin/env bash
# Runs Mission Control inside its Docker container. Use it from Ubuntu (WSL2) on the machine with Docker Desktop.
# docs/setup-windows.md sets up the alias `mc` for this script; run it with no arguments for the command list.
set -euo pipefail

readonly IMAGE="mission-control:local"
readonly RUN_CONTAINER="mission-control-run"
readonly CONTAINER_HOME="/home/pwuser"
readonly APPS_DIR="$HOME/mc-apps"
readonly REPORTS_DIR="$HOME/mc-reports"
readonly PREVIEW_PORT=3000
# A scheduled run can start while Docker Desktop is still starting (after a reboot or an update), so it waits.
readonly DOCKER_WAIT_SECONDS=300
readonly DOCKER_POLL_SECONDS=10
REPO_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
readonly REPO_DIR

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
  login-codex                  Log in to Codex once (device code; enable it in ChatGPT security settings)
  shell                        Open a terminal inside the container; port 3000 reaches your browser
  copy-reports                 Copy reports and screenshots to ~/mc-reports, readable from Windows
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
  exit 1
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
  if ! command -v docker >/dev/null 2>&1; then
    die "Docker isn't available in Ubuntu. In Docker Desktop, open Settings > Resources > WSL integration, turn on Ubuntu, then click \"Apply & restart\"."
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

# Replaces this script with `docker run` (so signals reach the container directly), adding what every
# container needs: logins and data in named volumes, apps in ~/mc-apps, an init process that forwards signals,
# shared memory for Chromium, your timezone, and a terminal when there is one (none under Task Scheduler).
# Playwright's browsers get a volume too, so a browser an agent installs for an app's newer Playwright is still
# there the next night; Docker fills a new, empty volume with the browsers that come with the image.
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
  # Docker would create a missing bind-mount folder owned by root, which the container then can't write to.
  mkdir -p "$APPS_DIR"
  exec docker run --rm --init --shm-size=1g \
    --volume "mc-claude:$CONTAINER_HOME/.claude" \
    --volume "mc-codex:$CONTAINER_HOME/.codex" \
    --volume "mc-home:$CONTAINER_HOME/.mission-control" \
    --volume "mc-browsers:/ms-playwright" \
    --volume "$APPS_DIR:$CONTAINER_HOME/mc-apps" \
    "${flags[@]}" "$IMAGE" "$@"
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
  local -a args=()
  local arg translated
  for arg in "$@"; do
    translated="$(container_path "$arg")"
    args+=("${translated:-$arg}")
  done
  run_container -- mc "${args[@]}"
}

# mc's own lock can't see a run in another container, so a fixed container name lets Docker refuse a second one.
run_night() {
  local running
  running="$(docker container inspect --format '{{.State.Running}}' "$RUN_CONTAINER" 2>/dev/null || true)"
  case "$running" in
    true) die "a Mission Control run is already active. To stop it, run: mc stop" ;;
    false) docker container rm "$RUN_CONTAINER" >/dev/null ;; # left behind by a crash
  esac
  run_container --name "$RUN_CONTAINER" -- mc run "$@"
}

copy_reports() {
  mkdir -p "$REPORTS_DIR"
  local windows_path="\\\\wsl.localhost\\${WSL_DISTRO_NAME:-Ubuntu}${REPORTS_DIR//\//\\}"
  say "copying reports to $REPORTS_DIR. In Windows File Explorer, open: $windows_path"
  run_container --volume "$REPORTS_DIR:$CONTAINER_HOME/mc-reports" -- bash -c "$COPY_REPORTS_SCRIPT"
}

# Volumes first created by an older image, or by hand, can end up owned by root.
fix_permissions() {
  say "giving the login and data volumes back to the container user."
  run_container --user root --entrypoint chown -- -R pwuser:pwuser \
    "$CONTAINER_HOME/.claude" "$CONTAINER_HOME/.codex" "$CONTAINER_HOME/.mission-control"
}

main() {
  local command="${1:-help}"
  if [ "$command" = "help" ]; then
    usage
    return
  fi
  refuse_root
  # Only an unattended night run waits for Docker; at a terminal, you hear about it straight away.
  if [ "$command" = "run" ] && ! on_terminal; then
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
    fix-permissions) fix_permissions ;;
    run)
      shift
      run_night "$@"
      ;;
    *) run_mc "$@" ;;
  esac
}

main "$@"
