@echo off
rem Opens Ubuntu and starts the Mission Control leader.
rem Needs the one-time step "mc install-leader" in an Ubuntu window (see docs/setup-windows.md).
rem If your Ubuntu has another name (check it with: wsl -l -v), change the word Ubuntu on the next line.
set "DISTRO=Ubuntu"
title Mission Control leader
wsl.exe -d %DISTRO% -- bash -lic "$HOME/.config/mission-control/launch leader"
if errorlevel 1 (
  echo.
  echo The leader did not start. Read the message above.
  echo If it says the launcher is missing, open Ubuntu and run: mc install-leader
  pause
)
