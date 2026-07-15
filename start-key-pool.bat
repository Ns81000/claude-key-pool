@echo off
title Claude Key Pool Server
echo Starting Claude Key Pool Dashboard and Proxy Server on port 9999...
cd /d "%~dp0"
pnpm run dev --port 9999
pause
