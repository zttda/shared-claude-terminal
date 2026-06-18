$ErrorActionPreference = "Continue"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageRoot = Split-Path -Parent $scriptDir
$projectDir = Join-Path $packageRoot "shared-claude-terminal"
$skillFile = Join-Path $packageRoot "skills\\shared-claude-bridge\\SKILL.md"

function Test-Command {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) {
    Write-Host "[OK] command found: $Name -> $($command.Source)" -ForegroundColor Green
    return $true
  }

  Write-Host "[FAIL] command not found: $Name" -ForegroundColor Red
  return $false
}

Write-Host "Checking package layout..." -ForegroundColor Cyan
if (Test-Path (Join-Path $projectDir "server.js")) {
  Write-Host "[OK] project file found: $projectDir\\server.js" -ForegroundColor Green
} else {
  Write-Host "[FAIL] missing project file: $projectDir\\server.js" -ForegroundColor Red
}

if (Test-Path $skillFile) {
  Write-Host "[OK] skill file found: $skillFile" -ForegroundColor Green
} else {
  Write-Host "[FAIL] missing skill file: $skillFile" -ForegroundColor Red
}

Write-Host ""
Write-Host "Checking commands..." -ForegroundColor Cyan
Test-Command "node" | Out-Null
Test-Command "npm" | Out-Null
Test-Command "claude" | Out-Null

Write-Host ""
Write-Host "Checking port 4317..." -ForegroundColor Cyan
$portOwner = Get-NetTCPConnection -LocalPort 4317 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($portOwner) {
  Write-Host "[WARN] port 4317 is already in use by PID $($portOwner.OwningProcess)" -ForegroundColor Yellow
} else {
  Write-Host "[OK] port 4317 is available" -ForegroundColor Green
}
