@echo off
rem Thin wrapper: make sure Node exists, then hand off to the cross-platform
rem launcher (start.mjs). macOS/Linux users run start.sh instead.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js not found. Install Node.js on a supported line - 22.23.4+, 24.22.1+ or 26.12.1+ - from https://nodejs.org/
    echo ^(or run: winget install OpenJS.NodeJS.LTS, then verify with `node --version`; prereleases and odd majors are rejected^), reopen this terminal,
    echo then run start.cmd again.
    exit /b 1
)

node start.mjs %*
exit /b %errorlevel%
