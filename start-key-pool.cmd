@echo off
title Claude Key Pool
cd /d "%~dp0"
echo.
echo   Claude Key Pool
echo   Starting server on http://localhost:9999
echo   (Keep this window open. Close it to stop the proxy.)
echo.

rem Start the production server in this window's background job, then wait for
rem the port to answer before opening the browser.
start "" /min cmd /c "pnpm start"

powershell -NoProfile -Command "$ok=$false; for($i=0;$i -lt 60;$i++){ try{ Invoke-WebRequest -UseBasicParsing http://localhost:9999 -TimeoutSec 2 ^| Out-Null; $ok=$true; break }catch{ Start-Sleep -Milliseconds 500 } }; if(-not $ok){ Write-Host 'Server did not respond in time; opening anyway.' }"

start "" http://localhost:9999

echo.
echo   Dashboard opened in your browser.
echo   To stop the proxy: close this window, or use the Quit button in the UI.
echo.
