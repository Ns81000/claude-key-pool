# Claude Key Pool - one-command updater for Windows
# Pulls the latest code, reinstalls dependencies, rebuilds, and relaunches.
# Your keys (config.json) are never touched - that file is local and git-ignored.
#
# Run in PowerShell:
#   irm https://raw.githubusercontent.com/Ns81000/claude-key-pool/main/update.ps1 | iex

$ErrorActionPreference = 'Stop'

$InstallToDir = Join-Path $env:USERPROFILE 'claude-key-pool'
$Port = 9999

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }

Write-Host "Claude Key Pool updater" -ForegroundColor White

# --- Locate the install ---------------------------------------------------
if (-not (Test-Path (Join-Path $InstallToDir '.git'))) {
  throw "No existing install found at $InstallToDir. Run the installer first: irm https://raw.githubusercontent.com/Ns81000/claude-key-pool/main/install.ps1 | iex"
}
Set-Location $InstallToDir

# --- Stop a running server ------------------------------------------------
# Free port 9999 so the rebuild and relaunch don't collide with a live server.
Write-Step "Stopping any running server on port $Port"
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    try { Stop-Process -Id $_ -Force -ErrorAction Stop; Write-Ok "Stopped process $_" }
    catch { Write-Warn "Could not stop process $_ (it may have already exited)" }
  }
} else {
  Write-Ok "No server was running"
}

# --- Pull latest ----------------------------------------------------------
Write-Step 'Pulling the latest code'
git pull --ff-only
Write-Ok "Up to date"

# --- Install + build ------------------------------------------------------
Write-Step 'Installing dependencies'
pnpm install

Write-Step 'Rebuilding the app'
pnpm build

# --- Relaunch -------------------------------------------------------------
Write-Step 'Relaunching'
$launcher = Join-Path $InstallToDir 'start-key-pool.cmd'

Write-Host "`nUpdated." -ForegroundColor Green
Write-Host "Launching the dashboard..." -ForegroundColor White
& $launcher
