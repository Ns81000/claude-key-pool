@echo off
title Claude Key Pool
cd /d "%~dp0"

rem Enable ANSI escape code support for colored terminal output (Windows 10+).
rem This registry key enables VirtualTerminalLevel for the current console.
reg query "HKCU\Console" /v VirtualTerminalLevel >nul 2>nul
if errorlevel 1 (
  reg add "HKCU\Console" /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>nul
)

echo.
echo   Claude Key Pool
echo   Starting server on http://localhost:9999
echo   (Keep this window open. Close it to stop the proxy.)
echo.

rem If a server is already listening on the port (e.g. the shortcut was
rem double-clicked twice), don't start a second one - just open the dashboard.
netstat -ano -p tcp 2>nul | findstr ":9999" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   Server is already running - opening the dashboard...
  start "" "http://localhost:9999"
  exit /b 0
)

rem Make sure pnpm is available when launched directly via double-click.
rem On this machine pnpm comes through corepack because the global pnpm
rem shim could not be installed, so accept either form.
where pnpm >nul 2>nul
if errorlevel 1 (
  where corepack >nul 2>nul
  if errorlevel 1 (
    echo   ERROR: neither pnpm nor corepack was found on your PATH.
    echo   Install Node.js LTS and retry.
    echo.
    pause
    exit /b 1
  )
  set "PNPM_CMD=corepack pnpm"
) else (
  set "PNPM_CMD=pnpm"
)

rem Open the browser once the server answers, from a HIDDEN helper that exits
rem as soon as it is done. IMPORTANT: this command must contain no pipes -
rem inside double quotes cmd passes ^| through as a literal caret, which breaks
rem PowerShell's argument parsing (the bug that stopped the browser opening).
start "" /min powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 120;$i++){ try{ $null = Invoke-WebRequest -UseBasicParsing 'http://localhost:9999' -TimeoutSec 2; break }catch{ Start-Sleep -Milliseconds 500 } }; Start-Process 'http://localhost:9999'"

rem Set FORCE_COLOR so the Node.js runtime emits ANSI codes even when stdout
rem is not detected as a TTY (common in CMD windows).
set FORCE_COLOR=1

rem Run the production server in the FOREGROUND of this window. Closing this
rem window stops the proxy, exactly as the message above promises.
call %PNPM_CMD% start

echo.
echo   The server has stopped. You can close this window.
echo.
pause
