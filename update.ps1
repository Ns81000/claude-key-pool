# Claude Key Pool - one-command updater for Windows
# Pulls the latest code, reinstalls dependencies, rebuilds, and relaunches.
# Your keys (config.json) are never touched - that file is local and git-ignored.
# If no install exists yet, this falls back to a full install automatically.
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

# Run a native command safely. See install.ps1 for the full rationale: native
# tools write progress to stderr, which under 'Stop' would become a terminating
# NativeCommandError even on success (exit code 0) - the original git-pull bug.
# We relax the preference so output prints naturally and judge success by exit
# code only. Returns nothing, so no stray exit code leaks to the console.
function Invoke-Native {
  param(
    [Parameter(Mandatory)][string]$Exe,
    [string[]]$Arguments = @(),
    [switch]$AllowFail
  )
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @Arguments
    $script:NativeExit = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
  if ($null -eq $script:NativeExit) { $script:NativeExit = 0 }
  if (-not $AllowFail -and $script:NativeExit -ne 0) {
    throw "$Exe $($Arguments -join ' ') failed (exit code $script:NativeExit)"
  }
}

function Stop-ServerOnPort($portNumber) {
  try {
    $conns = Get-NetTCPConnection -LocalPort $portNumber -State Listen -ErrorAction SilentlyContinue
    if ($conns) {
      $conns | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {
        try { Stop-Process -Id $_ -Force -ErrorAction Stop; Write-Ok "Stopped process $_ on port $portNumber" }
        catch { Write-Warn "Could not stop process $_ (it may have already exited)" }
      }
      return
    }
  } catch {
    # Get-NetTCPConnection missing on minimal/older systems - fall back to netstat.
    try {
      $lines = netstat -ano -p tcp 2>$null | Select-String ":$portNumber\s.*LISTENING"
      $pids  = $lines | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique
      foreach ($procId in $pids) {
        if ($procId -match '^\d+$') {
          try { Stop-Process -Id $procId -Force -ErrorAction Stop; Write-Ok "Stopped process $procId on port $portNumber" }
          catch { Write-Warn "Could not stop process $procId" }
        }
      }
      return
    } catch { }
  }
  Write-Ok "No server was running on port $portNumber"
}

Write-Host "Claude Key Pool updater" -ForegroundColor White

# --- Locate the install ---------------------------------------------------
# If there's no install yet, don't error out - fall back to a full install so
# a user who runs update first still ends up with a working app.
if (-not (Test-Path (Join-Path $InstallToDir '.git'))) {
  Write-Warn "No existing install found at $InstallToDir"
  Write-Step 'Running the installer instead'
  Invoke-Expression (Invoke-RestMethod 'https://raw.githubusercontent.com/Ns81000/claude-key-pool/main/install.ps1')
  return
}
Set-Location $InstallToDir
Write-Ok "Found installation at $InstallToDir"

# --- Ensure toolchain -----------------------------------------------------
if (-not (Test-Command git))  { throw "git is not installed. Install it first: winget install --id Git.Git -e" }
if (-not (Test-Command node)) { throw "Node.js is not installed. Install it first: winget install --id OpenJS.NodeJS.LTS -e" }
if (-not (Test-Command pnpm)) {
  Write-Warn 'pnpm not found - enabling it via corepack'
  Invoke-Native corepack @('enable', 'pnpm') -AllowFail
  Invoke-Native corepack @('prepare', 'pnpm@latest', '--activate') -AllowFail
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path', 'User')
}
if (-not (Test-Command pnpm)) { throw "pnpm could not be enabled. Install it manually: npm install -g pnpm" }

# --- Stop a running server ------------------------------------------------
Write-Step "Stopping any running server on port $Port"
Stop-ServerOnPort $Port

# --- Pull latest ----------------------------------------------------------
# Force-sync the working tree to origin/$Branch. This handles the cases that
# broke --ff-only before: local edits to tracked files, untracked files
# blocking a checkout, and divergent history. git-ignored files (config.json,
# config.backup.json) are never touched by reset, and we explicitly exclude
# them from clean, so your saved keys are always safe.
Write-Step "Pulling the latest code from '$Branch'"
Invoke-Native git @('fetch', '--prune', 'origin')
Invoke-Native git @('checkout', '-f', $Branch) -AllowFail
Invoke-Native git @('reset', '--hard', "origin/$Branch")
Invoke-Native git @('clean', '-fd', '-e', 'config.json', '-e', 'config.backup.json')
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

# Launch in its OWN new console window and return immediately. Using & here
# would host the batch file inside this PowerShell session and trigger a
# "Terminate batch job (Y/N)?" prompt - the exact issue seen before.
Start-Process -FilePath $launcher -WorkingDirectory $InstallToDir

# This script runs inside the user's own PowerShell session (irm | iex), so it
# must not call exit - that would kill their terminal. Just tell them it's safe.
Write-Host "`nAll done - you can close this window now." -ForegroundColor Green
