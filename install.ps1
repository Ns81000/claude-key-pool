# Claude Key Pool - one-command installer for Windows
# Clones the repo, installs dependencies, builds the app, and creates a
# desktop shortcut (with the app logo) that launches the UI in your browser.
#
# Run in PowerShell:
#   irm https://raw.githubusercontent.com/Ns81000/claude-key-pool/main/install.ps1 | iex

$ErrorActionPreference = 'Stop'

$RepoUrl   = 'https://github.com/Ns81000/claude-key-pool.git'
$InstallToDir = Join-Path $env:USERPROFILE 'claude-key-pool'
$Port = 9999

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

Write-Host "Claude Key Pool installer" -ForegroundColor White

# --- Prerequisites --------------------------------------------------------
Write-Step 'Checking prerequisites'

if (-not (Test-Command git)) {
  throw "git is not installed. Install it first: winget install --id Git.Git -e"
}
Write-Ok "git found"

if (-not (Test-Command node)) {
  throw "Node.js is not installed. Install it first: winget install --id OpenJS.NodeJS.LTS -e"
}
Write-Ok "node $(node --version) found"

# Enable pnpm through corepack (ships with Node) if it is not present.
if (-not (Test-Command pnpm)) {
  Write-Warn 'pnpm not found - enabling it via corepack'
  corepack enable pnpm 2>$null
  corepack prepare pnpm@latest --activate 2>$null
}
if (-not (Test-Command pnpm)) {
  throw "pnpm could not be enabled. Install it manually: npm install -g pnpm"
}
Write-Ok "pnpm $(pnpm --version) found"

# --- Clone / update -------------------------------------------------------
if (Test-Path (Join-Path $InstallToDir '.git')) {
  Write-Step "Updating existing install at $InstallToDir"
  git -C $InstallToDir pull --ff-only
} else {
  Write-Step "Cloning into $InstallToDir"
  git clone $RepoUrl $InstallToDir
}

Set-Location $InstallToDir

# --- Install + build ------------------------------------------------------
Write-Step 'Installing dependencies (this can take a minute)'
pnpm install

Write-Step 'Building the app'
pnpm build

# --- Launcher -------------------------------------------------------------
# A small .cmd that starts the production server and opens the browser once
# the port is listening. This is what the desktop shortcut points to.
Write-Step 'Creating launcher and desktop shortcut'

$launcher = Join-Path $InstallToDir 'start-key-pool.cmd'
@"
@echo off
title Claude Key Pool
cd /d "%~dp0"
echo Starting Claude Key Pool on http://localhost:$Port ...
start "" /min cmd /c "pnpm start"
powershell -NoProfile -Command "for (\$i=0; \$i -lt 60; \$i++) { try { Invoke-WebRequest -UseBasicParsing http://localhost:$Port -TimeoutSec 2 | Out-Null; break } catch { Start-Sleep -Milliseconds 500 } }"
start "" http://localhost:$Port
"@ | Set-Content -Path $launcher -Encoding ASCII

$iconPath = Join-Path $InstallToDir 'public\logo.ico'
$desktop  = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'Claude Key Pool.lnk'

$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut($shortcut)
$lnk.TargetPath       = $launcher
$lnk.WorkingDirectory = $InstallToDir
$lnk.IconLocation     = $iconPath
$lnk.Description       = 'Launch the Claude Key Pool dashboard'
$lnk.Save()

Write-Ok "Desktop shortcut created: $shortcut"

# --- Done -----------------------------------------------------------------
Write-Host "`nDone." -ForegroundColor Green
Write-Host "Double-click 'Claude Key Pool' on your desktop any time to open the dashboard." -ForegroundColor White
Write-Host "Launching now..." -ForegroundColor White
& $launcher
