# Claude Key Pool - one-command installer for Windows
# Clones the repo, installs dependencies, builds the app, and creates a
# desktop shortcut (with the app logo) that launches the UI in your browser.
# Safe to re-run at any time: an existing install is force-synced and rebuilt.
#
# Run in PowerShell:
#   irm https://raw.githubusercontent.com/Ns81000/claude-key-pool/main/install.ps1 | iex

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

# Run a native command safely. Native tools (git, pnpm, node) routinely write
# progress to stderr; under $ErrorActionPreference='Stop' that stderr would be
# turned into a terminating NativeCommandError even on success. Here we relax
# the preference so the tool's own output prints naturally, and we judge success
# only by the process exit code (stored in $script:NativeExit for the rare
# -AllowFail caller that wants to inspect it). Returns nothing, so call sites
# never leak a stray exit code into the console.
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

# Free the port so a rebuild/relaunch never collides with an already-running
# server (matters when the installer is re-run while the app is open).
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
  Invoke-Native corepack @('enable', 'pnpm') -AllowFail
  Invoke-Native corepack @('prepare', 'pnpm@latest', '--activate') -AllowFail
  # corepack drops shims into Node's dir (already on PATH), but this session's
  # command cache may be stale - refresh PATH so the shim is found right away.
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path', 'User')
}
if (-not (Test-Command pnpm)) {
  throw "pnpm could not be enabled. Install it manually: npm install -g pnpm"
}
Write-Ok "pnpm $(pnpm --version) found"

# --- Stop any running server ---------------------------------------------
# A re-run of the installer while the app is open would otherwise fail to
# rebuild/relaunch. Free the port up front.
Write-Step "Stopping any running server on port $Port"
Stop-ServerOnPort $Port

# --- Clone / update -------------------------------------------------------
$gitDir = Join-Path $InstallToDir '.git'
if (Test-Path $gitDir) {
  # Already installed - behave like the updater: force-sync to the remote.
  Write-Step "Existing install found - updating it at $InstallToDir"
  Invoke-Native git @('-C', $InstallToDir, 'fetch', '--prune', 'origin')
  Invoke-Native git @('-C', $InstallToDir, 'checkout', '-f', $Branch) -AllowFail
  Invoke-Native git @('-C', $InstallToDir, 'reset', '--hard', "origin/$Branch")
  # -x removes ignored build artifacts too, but we KEEP config.json / backups
  # so a re-install never wipes the user's saved keys.
  Invoke-Native git @('-C', $InstallToDir, 'clean', '-fd', '-e', 'config.json', '-e', 'config.backup.json')
} elseif (Test-Path $InstallToDir) {
  # Directory exists but isn't a git checkout (partial/corrupt/interrupted install).
  $hasFiles = (Get-ChildItem -Force $InstallToDir | Measure-Object).Count -gt 0
  if ($hasFiles) {
    throw "$InstallToDir exists but is not a git repository. Move or delete it, then re-run the installer."
  }
  Write-Step "Cloning into $InstallToDir"
  Invoke-Native git @('clone', '--branch', $Branch, $RepoUrl, $InstallToDir)
} else {
  Write-Step "Cloning into $InstallToDir"
  Invoke-Native git @('clone', '--branch', $Branch, $RepoUrl, $InstallToDir)
}

Set-Location $InstallToDir

# --- Install + build ------------------------------------------------------
Write-Step 'Installing dependencies (this can take a minute)'
Invoke-Native pnpm @('install')

Write-Step 'Building the app'
Invoke-Native pnpm @('build')

# --- Launcher + desktop shortcut ------------------------------------------
# start-key-pool.cmd ships with the repo: it starts the production server and
# opens the browser once the port is listening. The desktop shortcut points to it.
Write-Step 'Creating desktop shortcut'

$launcher = Join-Path $InstallToDir 'start-key-pool.cmd'
$iconPath = Join-Path $InstallToDir 'public\logo.ico'
$desktop  = [Environment]::GetFolderPath('Desktop')
$shortcut = Join-Path $desktop 'Claude Key Pool.lnk'

try {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut($shortcut)
  $lnk.TargetPath       = $launcher
  $lnk.WorkingDirectory = $InstallToDir
  if (Test-Path $iconPath) { $lnk.IconLocation = $iconPath }
  $lnk.Description       = 'Launch the Claude Key Pool dashboard'
  $lnk.Save()
  Write-Ok "Desktop shortcut created: $shortcut"
} catch {
  Write-Warn "Could not create desktop shortcut: $($_.Exception.Message)"
  Write-Warn "You can still launch the app with: $launcher"
}

# --- Done -----------------------------------------------------------------
Write-Host "`nDone." -ForegroundColor Green
Write-Host "Double-click 'Claude Key Pool' on your desktop any time to open the dashboard." -ForegroundColor White

if (Test-Path $launcher) {
  Write-Host "Launching now..." -ForegroundColor White
  # Launch in its OWN new console window and return immediately. Using & here
  # would host the batch file inside this session and trigger a
  # "Terminate batch job (Y/N)?" prompt on exit.
  Start-Process -FilePath $launcher -WorkingDirectory $InstallToDir
} else {
  Write-Err "Launcher not found at $launcher - the build may be incomplete."
}
