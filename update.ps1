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
function Write-Error($msg) { Write-Host "    ERROR: $msg" -ForegroundColor Red }

Write-Host "Claude Key Pool updater" -ForegroundColor White

# --- Locate the install ---------------------------------------------------
if (-not (Test-Path (Join-Path $InstallToDir '.git'))) {
  Write-Error "No existing install found at $InstallToDir"
  throw "Run the installer first: irm https://raw.githubusercontent.com/Ns81000/claude-key-pool/main/install.ps1 | iex"
}
Set-Location $InstallToDir
Write-Ok "Found installation at $InstallToDir"

# --- Stop a running server ------------------------------------------------
# Free port 9999 so the rebuild and relaunch don't collide with a live server.
Write-Step "Stopping any running server on port $Port"
$conns = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
    try {
      Stop-Process -Id $_ -Force -ErrorAction Stop
      Write-Ok "Stopped process $_"
    } catch {
      Write-Warn "Could not stop process $_ (it may have already exited)"
    }
  }
} else {
  Write-Ok "No server was running"
}

# --- Prepare for pull ----------------------------------------------------
Write-Step 'Preparing for update'
try {
  # Clean up any untracked files that might block the merge (like start-key-pool.cmd)
  git clean -fd
  Write-Ok "Cleaned working directory"
} catch {
  Write-Warn "Could not clean working directory (continuing anyway): $_"
}

# --- Pull latest ----------------------------------------------------------
Write-Step 'Pulling the latest code from main branch'
try {
  $pullOutput = git pull origin main --ff-only 2>&1
  if ($LASTEXITCODE -ne 0) {
    Write-Error "git pull failed with exit code $LASTEXITCODE"
    Write-Host $pullOutput
    throw "Failed to pull latest code"
  }
  Write-Ok "Successfully pulled latest code"
  Write-Ok "Current version: $(git log -1 --oneline)"
} catch {
  Write-Error "Failed to pull: $_"
  throw $_
}

# --- Install + build ------------------------------------------------------
Write-Step 'Installing dependencies with pnpm'
try {
  pnpm install
  Write-Ok "Dependencies installed"
} catch {
  Write-Error "pnpm install failed: $_"
  throw $_
}

Write-Step 'Building the app'
try {
  pnpm build
  Write-Ok "Build successful"
} catch {
  Write-Error "pnpm build failed: $_"
  throw $_
}

# --- Relaunch -------------------------------------------------------------
Write-Step 'Relaunching the proxy server'
$launcher = Join-Path $InstallToDir 'start-key-pool.cmd'

if (-not (Test-Path $launcher)) {
  Write-Error "Launcher not found at $launcher"
  throw "start-key-pool.cmd not found"
}

Write-Host "`n✓ Updated successfully!" -ForegroundColor Green
Write-Host "Current version: $(git log -1 --oneline)" -ForegroundColor Green
Write-Host "`nLaunching the dashboard..." -ForegroundColor White

Start-Sleep -Milliseconds 500
& $launcher
