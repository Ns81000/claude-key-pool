# Claude Key Pool - one-command installer for Windows
# Clones the repo, installs dependencies, builds the app, and creates a
# desktop shortcut (with the app logo) that launches the UI in your browser.
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
# progress to stderr; under $ErrorActionPreference='Stop' a naive 2>&1 turns
# that harmless text into a terminating NativeCommandError. Here we temporarily
# relax the preference, stream all output live, and decide success purely from
# the process exit code.
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
  Invoke-Native corepack @('enable', 'pnpm') -AllowFail | Out-Null
  Invoke-Native corepack @('prepare', 'pnpm@latest', '--activate') -AllowFail | Out-Null
  # corepack drops shims into Node's dir, which is already on PATH, but the
  # current session's command cache may be stale - force a lookup refresh.
  $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
              [System.Environment]::GetEnvironmentVariable('Path', 'User')
}
if (-not (Test-Command pnpm)) {
  throw "pnpm could not be enabled. Install it manually: npm install -g pnpm"
}
Write-Ok "pnpm $(pnpm --version) found"

# --- Clone / update -------------------------------------------------------
$gitDir = Join-Path $InstallToDir '.git'
if (Test-Path $gitDir) {
  Write-Step "Updating existing install at $InstallToDir"
  Invoke-Native git @('-C', $InstallToDir, 'fetch', '--prune', 'origin')
  # Force the working tree to match the remote branch. config.json and other
  # git-ignored files are left untouched (reset/clean never touch ignored files).
  Invoke-Native git @('-C', $InstallToDir, 'checkout', '-f', $Branch) -AllowFail | Out-Null
  Invoke-Native git @('-C', $InstallToDir, 'reset', '--hard', "origin/$Branch")
  Invoke-Native git @('-C', $InstallToDir, 'clean', '-fd')
} elseif (Test-Path $InstallToDir) {
  # Directory exists but isn't a git checkout (partial/corrupt install).
  if ((Get-ChildItem -Force $InstallToDir | Measure-Object).Count -gt 0) {
    throw "$InstallToDir already exists but is not a git repository. Move or delete it, then re-run the installer."
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
  & $launcher
} else {
  Write-Err "Launcher not found at $launcher - the build may be incomplete."
}
