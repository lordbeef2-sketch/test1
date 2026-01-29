[CmdletBinding()]
param(
  [string]$OutDir = "dist-packages",
  [switch]$NoUpdate,
  [switch]$AllowPlaceholderConfig
)

$ErrorActionPreference = "Stop"

function Invoke-Step([string]$Title, [scriptblock]$Action) {
  Write-Host "==> $Title" -ForegroundColor Cyan
  & $Action
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot ".." )).Path
Set-Location $repoRoot

Invoke-Step "Clean output folder" {
  $outPath = Join-Path $repoRoot $OutDir
  New-Item -ItemType Directory -Force -Path $outPath | Out-Null

  # This folder is an output-only artifact folder. Wipe it.
  Get-ChildItem -Path $outPath -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

Invoke-Step "Validate config.json" {
  $cfgPath = Join-Path $repoRoot "config.json"
  if (-not (Test-Path $cfgPath)) { throw "config.json not found at repo root." }
  $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json
  if (-not $AllowPlaceholderConfig) {
    if ($cfg.allowedAdGroup -match "SomeSecurityGroup" -or [string]::IsNullOrWhiteSpace($cfg.allowedAdGroup)) {
      throw "config.json has a placeholder allowedAdGroup. Set a real group (or pass -AllowPlaceholderConfig)."
    }
  }
}

if (-not $NoUpdate) {
  Invoke-Step "Update dependencies (safe)" {
    npm install --workspaces --include-workspace-root
    npm update --workspaces
  }
}

Invoke-Step "Create offline bundle" {
  powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $repoRoot "scripts\create-offline-bundle.ps1") -OutDir $OutDir
}

Invoke-Step "Create stable latest zip name" {
  $outPath = Join-Path $repoRoot $OutDir
  $latestZip = Join-Path $outPath "DLT-offline-latest.zip"
  $newest = Get-ChildItem -Path $outPath -Filter "DLT-offline-*.zip" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $newest) { throw "No bundle zip found in $outPath" }
  Copy-Item -Force -Path $newest.FullName -Destination $latestZip
  Write-Host "Latest: $latestZip" -ForegroundColor Green
}

Invoke-Step "Remove staging output" {
  $outPath = Join-Path $repoRoot $OutDir
  # Keep only the stable zip; remove timestamp zips and staging folders.
  Get-ChildItem -Path $outPath -Filter "DLT-offline-*.zip" -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne "DLT-offline-latest.zip" } |
    Remove-Item -Force -ErrorAction SilentlyContinue

  Get-ChildItem -Path $outPath -Filter "DLT-offline-*" -Directory -ErrorAction SilentlyContinue |
    Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
}

Invoke-Step "Copy installer next to zip" {
  $outPath = Join-Path $repoRoot $OutDir
  Copy-Item -Force -Path (Join-Path $repoRoot "scripts\install-offline.ps1") -Destination (Join-Path $outPath "install-offline.ps1")
  Copy-Item -Force -Path (Join-Path $repoRoot "scripts\run.ps1") -Destination (Join-Path $outPath "run.ps1")
  Write-Host "Installer: $(Join-Path $outPath 'install-offline.ps1')" -ForegroundColor Green
}