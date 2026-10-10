#!/usr/bin/env bash
# Container entrypoint: check that the mounted folders are writable and that both CLIs are logged in,
# print a short hint for anything missing, then run the requested command (by default `mc --help`).
set -euo pipefail

claude_dir="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
codex_dir="${CODEX_HOME:-$HOME/.codex}"
mc_home="${MC_HOME:-$HOME/.mission-control}"
apps_dir="$HOME/mc-apps"

hint() {
  printf 'mission-control: %s\n' "$*" >&2
}

# $1 = folder, $2 = what to do about it.
check_writable() {
  if [ ! -d "$1" ] || [ ! -w "$1" ]; then
    hint "cannot write to $1. $2"
  fi
}

check_folders() {
  local volume_fix="Fix: in Ubuntu, run: mc fix-permissions"
  check_writable "$claude_dir" "$volume_fix"
  check_writable "$codex_dir" "$volume_fix"
  check_writable "$mc_home" "$volume_fix"
  # shellcheck disable=SC2016 # printed as is, for the user to paste into Ubuntu
  check_writable "$apps_dir" 'Fix: in Ubuntu, run: sudo chown -R "$USER": ~/mc-apps && mc build'
}

check_logins() {
  if [ ! -s "$claude_dir/.credentials.json" ]; then
    hint "not logged in to Claude yet. In Ubuntu, run: mc login-claude"
  fi
  if [ ! -s "$codex_dir/auth.json" ]; then
    hint "not logged in to Codex yet. In Ubuntu, run: mc login-codex"
  fi
}

check_folders
# Talking to claude or codex directly is how you log in, so a "not logged in" hint would only be noise.
case "${1:-}" in
  claude | codex) ;;
  *) check_logins ;;
esac

exec "$@"
