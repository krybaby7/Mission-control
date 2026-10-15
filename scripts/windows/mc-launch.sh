#!/usr/bin/env bash
# Starts the Mission Control leader or dashboard for the Windows shortcuts (start-leader.cmd, start-dashboard.cmd).
#
# `mc-docker.sh install-leader` copies this file to ~/.config/mission-control/launch and saves, in
# ~/.config/mission-control/checkout, the folder that Mission Control is in. This launcher reads that folder each time,
# so a shortcut keeps working after the folder is moved or downloaded again: run install-leader once more from the
# new folder. Without a saved folder it tries ~/Mission-control, the folder the setup guide downloads to.
#
# It starts only "leader" or "dashboard", nothing else. The leader is started by mc-docker.sh, which changes into the
# leader folder of that copy first, so the leader's commands (../scripts/mc-docker.sh ...) match its permission rules.
set -euo pipefail

fail() {
  printf 'Mission Control launcher: %s\n' "$*" >&2
  exit 1
}

if [ "$#" -ne 1 ]; then
  fail "I can start \"leader\" or \"dashboard\". Usage: launch leader   or: launch dashboard"
fi
what="$1"
case "$what" in
  leader | dashboard) ;;
  *) fail "I can start \"leader\" or \"dashboard\", not that. Usage: launch leader   or: launch dashboard" ;;
esac

checkout=""
record="$HOME/.config/mission-control/checkout"
if [ -r "$record" ]; then
  read -r checkout <"$record" || true
fi
if [ -z "$checkout" ]; then
  checkout="$HOME/Mission-control"
fi
script="$checkout/scripts/mc-docker.sh"
if [ ! -f "$script" ]; then
  fail "I can't find Mission Control in $checkout. If you moved it or downloaded it again, open an Ubuntu window, go to the new folder, and run: scripts/mc-docker.sh install-leader"
fi
exec bash "$script" "$what"
