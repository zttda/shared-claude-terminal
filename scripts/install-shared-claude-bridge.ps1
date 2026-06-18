param(
  [string]$CodexHome = (Join-Path $HOME ".codex")
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageRoot = Split-Path -Parent $scriptDir
$sourceDir = Join-Path $packageRoot "skills\\shared-claude-bridge"
$skillsRoot = Join-Path $CodexHome "skills"
$targetDir = Join-Path $skillsRoot "shared-claude-bridge"

if (-not (Test-Path $sourceDir)) {
  throw "Source skill folder not found: $sourceDir"
}

New-Item -ItemType Directory -Force -Path $skillsRoot | Out-Null

if (Test-Path $targetDir) {
  $timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $backupDir = "$targetDir.backup-$timestamp"
  Move-Item -LiteralPath $targetDir -Destination $backupDir
  Write-Host "Backed up existing skill to: $backupDir" -ForegroundColor Yellow
}

Copy-Item -LiteralPath $sourceDir -Destination $targetDir -Recurse -Force

Write-Host "Installed shared-claude-bridge skill to: $targetDir" -ForegroundColor Green
