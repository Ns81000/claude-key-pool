# Claude Key Pool - one-command updater for Windows
# Pulls the latest code, reinstalls dependencies, rebuilds, and relaunches.
# Your keys (config.json) are never touched - that file is local and git-ignored.
#
# Run in PowerShell:
#   irm https://raw.githubusercontent.com/Ns81000/claude-key-pool/main/update.ps1 | iex

# Stop on cmdlet errors, but native commands (git/pnpm) are handled explicitly
# via Invoke-Native below so their stderr output is never mistaken for a failure.
$ErrorActionPreference = 'Stop'

$RepoUrl      = 'https://github.com/Ns81000/claude-key-pool.git'
$InstallToDir = Join-Path $env:USERPROFILE 'claude-key-pool'
$Branch       = 'main'
$Port         = 9999

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    $msg" -ForegroundColor Yellow }
function Write-Err($msg)  { Write-Host "    ERROR: $msg" -ForegroundColor Red }

function Test-Command($name) {
  return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# Run a native command safely. Native tools (git, pnpm) routinely write progress
# to stderr; under $ErrorActionPreference='Stop' a naive 2>&1 turns that harmless
# text into a terminating NativeCommandError even when the command succeeded
# (exit code 0). This is exactly what broke `git pull` before. Here we relax the
# preference, stream all output live, and judge success only by the exit code.
function Invoke-Native {
  param(
    [Parameter(Mandatory)][string]$Exe,
    [string[]]$Arguments = @(),
    [switch]$AllowFail
  )
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Arguments 2>&1 | ForEach-Object { Write-Host "    $_" }
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  if (-not $AllowFail -and $code -ne 0) {
    throw "$Exe $($Arguments -join ' ') failed (exit code $code)"
  }
  return $code
}

Write-Host "Claude Key Pool updater" -ForegroundColor White

# --- Locate the install ---------------------------------------------------
if (-not (Test-Path (Join-Path $InstallToDir '.git'))) {
  Write-Err "No existing install found at $InstallToDir"
  throw "Run the installer first: irm https://raw.githubusercontent.com/Ns81000/claude-key-pool/main/install.ps1 | iex"
}
Set-Location $InstallToDir
Write-Ok "Found installation at $InstallToDir"

# --- Ensure toolchain -----------------------------------------------------
if (-not (Test-Command git))  { throw "git is not installed. Install it first: winget install --id Git.Git -e" }
if (-not (Test-Command node)) { throw "Node.js is not installed. Install it first: winget install --id OpenJS.NodeJS.LTS -e" }
if (-not (Test-Command pnpm)) {
  Write-Warn 'pnpm not found - enabling it via corepack'
  Invoke-Native corepack @('enable', 'pnpm') -AllowFail | Out-Null
  Invoke-Native corepack @('prepare', 'pnpm@latest', '--activate') -AllowFail | Out-Null
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path', 'User')
}
if (-not (Test-Command pnpm)) { throw "pnpm could not be enabled. Install it manually: npm install -g pnpm" }

# --- Stop a running server ------------------------------------------------
# Free port 9999 so the rebuild and relaunch don't collide with a live server.
Write-Step "Stopping any running server on port $Port"
try {
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
} catch {
  # Get-NetTCPConnection is unavailable on some minimal/older systems - fall back.
  Write-Warn "Port check unavailable ($($_.Exception.Message)); attempting netstat fallback"
  try {
    $lines = netstat -ano -p tcp | Select-String ":$Port\s.*LISTENING"
    $pids  = $lines | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique
    foreach ($procId in $pids) {
      if ($procId -match '^\d+$') {
        try { Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Ok "Stopped process $procId" }
        catch { Write-Warn "Could not stop process $procId" }
      }
    }
    if (-not $pids) { Write-Ok "No server was running" }
  } catch {
    Write-Warn "Could not check port $Port (continuing anyway)"
  }
}

# --- Pull latest ----------------------------------------------------------
# Force-sync the working tree to origin/$Branch. This handles the common cases
# that broke --ff-only before: local edits to tracked files, untracked files
# blocking a checkout, and divergent history. git-ignored files (config.json,
# config.backup.json) are never touched by reset/clean, so your keys are safe.
Write-Step "Pulling the latest code from '$Branch'"
Invoke-Native git @('fetch', '--prune', 'origin')
Invoke-Native git @('checkout', '-f', $Branch) -AllowFail | Out-Null
Invoke-Native git @('reset', '--hard', "origin/$Branch")
Invoke-Native git @('clean', '-fd')
Write-Ok "Successfully synced to latest code"
Write-Ok "Current version: $(git log -1 --oneline)"

# --- Install + build ------------------------------------------------------
Write-Step 'Installing dependencies with pnpm'
Invoke-Native pnpm @('install')
Write-Ok "Dependencies installed"

Write-Step 'Building the app'
Invoke-Native pnpm @('build')
Write-Ok "Build successful"

# --- Relaunch -------------------------------------------------------------
Write-Step 'Relaunching the proxy server'
$launcher = Join-Path $InstallToDir 'start-key-pool.cmd'

if (-not (Test-Path $launcher)) {
  Write-Err "Launcher not found at $launcher"
  throw "start-key-pool.cmd not found"
}

Write-Host "`nUpdated successfully!" -ForegroundColor Green
Write-Host "Current version: $(git log -1 --oneline)" -ForegroundColor Green
Write-Host "`nLaunching the dashboard..." -ForegroundColor White

Start-Sleep -Milliseconds 500
& $launcher
