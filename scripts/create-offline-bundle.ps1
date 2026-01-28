[CmdletBinding()]
param(
  [string]$OutDir = "dist-packages",
  [switch]$SkipInstall,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Invoke-Step([string]$Title, [scriptblock]$Action) {
  Write-Host "==> $Title" -ForegroundColor Cyan
  & $Action
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
Set-Location $repoRoot

$timestamp = (Get-Date).ToString("yyyyMMdd-HHmmss")
$bundleName = "DLT-offline-$timestamp"
$stageRoot = Join-Path $repoRoot $OutDir
$stageDir = Join-Path $stageRoot $bundleName
$zipPath = Join-Path $stageRoot ("$bundleName.zip")

Invoke-Step "Prepare output folder" {
  New-Item -ItemType Directory -Force -Path $stageRoot | Out-Null
  if (Test-Path $stageDir) { Remove-Item -Recurse -Force $stageDir }
  New-Item -ItemType Directory -Force -Path $stageDir | Out-Null
}

if (-not $SkipInstall) {
  Invoke-Step "Install workspace dependencies" {
    npm install --workspaces --include-workspace-root
  }
}

if (-not $SkipBuild) {
  Invoke-Step "Build backend + frontend" {
    npm run build
  }
}

Invoke-Step "Stage runtime files" {
  New-Item -ItemType Directory -Force -Path (Join-Path $stageDir "backend") | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $stageDir "frontend") | Out-Null

  Copy-Item -Force -Path (Join-Path $repoRoot "config.json") -Destination $stageDir
  Copy-Item -Force -Path (Join-Path $repoRoot "README.md") -Destination $stageDir
  Copy-Item -Force -Path (Join-Path $repoRoot "package.json") -Destination $stageDir
  Copy-Item -Force -Path (Join-Path $repoRoot "package-lock.json") -Destination $stageDir

  Copy-Item -Force -Path (Join-Path $repoRoot "backend\package.json") -Destination (Join-Path $stageDir "backend")
  if (Test-Path (Join-Path $repoRoot "backend\migrations")) {
    robocopy (Join-Path $repoRoot "backend\migrations") (Join-Path $stageDir "backend\migrations") /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
  }

  if (-not (Test-Path (Join-Path $repoRoot "backend\dist"))) {
    throw "backend/dist not found. Run build first."
  }
  robocopy (Join-Path $repoRoot "backend\dist") (Join-Path $stageDir "backend\dist") /MIR /NFL /NDL /NJH /NJS /NP | Out-Null

  if (-not (Test-Path (Join-Path $repoRoot "frontend\dist"))) {
    throw "frontend/dist not found. Run build first."
  }
  robocopy (Join-Path $repoRoot "frontend\dist") (Join-Path $stageDir "frontend\dist") /MIR /NFL /NDL /NJH /NJS /NP | Out-Null

  if (-not (Test-Path (Join-Path $repoRoot "node_modules"))) {
    throw "node_modules not found. Run npm install first."
  }
  robocopy (Join-Path $repoRoot "node_modules") (Join-Path $stageDir "node_modules") /MIR /NFL /NDL /NJH /NJS /NP | Out-Null

  # Include installer alongside the bundle for convenience.
  if (Test-Path (Join-Path $repoRoot "scripts\install-offline.ps1")) {
    Copy-Item -Force -Path (Join-Path $repoRoot "scripts\install-offline.ps1") -Destination $stageDir
  }
}

Invoke-Step "Write bundle start script" {
  $startScript = @'
param(
  [string]$HostAddress = $env:DLT_HOST,
  [int]$Port = 9191
)

$ErrorActionPreference = "Stop"

# Load locally generated env (created by install-offline.ps1)
if (Test-Path -Path (Join-Path $PSScriptRoot 'local.env.ps1')) {
  . (Join-Path $PSScriptRoot 'local.env.ps1')
}

if ([string]::IsNullOrWhiteSpace($env:DLT_SESSION_SECRET) -or $env:DLT_SESSION_SECRET.Length -lt 32) {
  Write-Error "DLT_SESSION_SECRET is missing. Run install-offline.ps1 (it generates local.env.ps1), or set the env var manually."
  exit 1
}

if ([string]::IsNullOrWhiteSpace($HostAddress)) {
  $HostAddress = "127.0.0.1"
}

$env:PORT = "$Port"
$env:HOST = $HostAddress

Write-Host "Starting DLT backend on http://${HostAddress}:${Port} ..."
Push-Location (Join-Path $PSScriptRoot 'backend')
try {
  node .\\dist\\index.js
} finally {
  Pop-Location
}
'@

  Set-Content -Path (Join-Path $stageDir "start-backend.ps1") -Value $startScript -Encoding UTF8
}

Invoke-Step "Write offline instructions" {
  $doc = @'
# DLT Offline Bundle

This bundle contains:
- `backend/dist` (compiled server)
- `frontend/dist` (static UI)
- `node_modules` (all runtime deps)

## Run
1) Extract the zip somewhere (e.g. `C:\DLT`)
2) Run PowerShell:
   - `./start-backend.ps1` (defaults to localhost:9191)

## Requirements
- The machine running the backend must have Active Directory access (domain-joined and able to reach a DC).
- Set a real `allowedAdGroup` value in `config.json` before starting (the placeholder will cause the backend to fail closed).

## Optional
- Bind address: set `$env:DLT_HOST` (default `127.0.0.1`)
- Port: `./start-backend.ps1 -Port 9191`

No `npm install` is required on the target machine.
'@

  Set-Content -Path (Join-Path $stageDir "OFFLINE.md") -Value $doc -Encoding UTF8
}

Invoke-Step "Create zip" {
  if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
  Compress-Archive -Path (Join-Path $stageDir "*") -DestinationPath $zipPath -Force
}

Write-Host "" 
Write-Host "Offline bundle created:" -ForegroundColor Green
Write-Host "- Folder: $stageDir"
Write-Host "- Zip:    $zipPath"