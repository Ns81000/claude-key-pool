@echo off
title Claude Key Pool
cd /d "%~dp0"
echo.
echo   Claude Key Pool
echo   Starting server on http://localhost:9999
echo   (Keep this window open. Close it to stop the proxy.)
echo.

rem Make sure pnpm is available when launched directly (double-click).
where pnpm >nul 2>nul
if errorlevel 1 (
  echo   ERROR: pnpm was not found on your PATH.
  echo   Re-run the installer, or install pnpm with: npm install -g pnpm
  echo.
  pause
  exit /b 1
)

rem Open the browser once the server answers - done in a background child so the
rem server itself can own THIS window's foreground. That way closing this window
rem actually stops the proxy, exactly as the message above promises.
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -Command "for($i=0;$i -lt 60;$i++){ try{ Invoke-WebRequest -UseBasicParsing http://localhost:9999 -TimeoutSec 2 ^| Out-Null; Start-Process 'http://localhost:9999'; break }catch{ Start-Sleep -Milliseconds 500 } }"

rem Run the production server in the FOREGROUND of this window. When this window
rem is closed (or the server exits), the proxy stops.
call pnpm start

echo.
echo   The server has stopped. You can close this window.
echo.
pause
