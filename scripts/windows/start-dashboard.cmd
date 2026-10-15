@echo off
rem Opens Ubuntu and starts the Mission Control dashboard. Close this window or press Ctrl+C to stop it.
rem Needs the one-time step "mc install-leader" in an Ubuntu window (see docs/setup-windows.md).
rem If your Ubuntu has another name (check it with: wsl -l -v), change the word Ubuntu on the next line.
set "DISTRO=Ubuntu"
title Mission Control dashboard
echo When a line below says where the dashboard is, open that address in your browser.
echo It is usually http://localhost:8787
wsl.exe -d %DISTRO% -- bash -lic "$HOME/.config/mission-control/launch dashboard"
if errorlevel 1 (
  echo.
  echo The dashboard stopped. If that was not on purpose, read the message above.
  echo If it says the launcher is missing, open Ubuntu and run: mc install-leader
  pause
)
