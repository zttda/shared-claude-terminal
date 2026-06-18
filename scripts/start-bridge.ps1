param(
  [Parameter(Mandatory = $true)]
  [string]$Workspace,
  [int]$Port = 4317,
  [switch]$NoSessionPersistence
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$packageRoot = Split-Path -Parent $scriptDir
$projectDir = Join-Path $packageRoot "shared-claude-terminal"

if (-not (Test-Path $projectDir)) {
  throw "Project folder not found: $projectDir"
}

if (-not (Test-Path $Workspace)) {
  throw "Workspace folder not found: $Workspace"
}

$args = @("server.js", "--cwd", (Resolve-Path $Workspace).Path, "--port", [string]$Port)
if ($NoSessionPersistence) {
  $args += "--no-session-persistence"
}

Push-Location $projectDir
try {
  Write-Host "Starting shared-claude-terminal..." -ForegroundColor Cyan
  Write-Host "Claude workspace: $Workspace" -ForegroundColor Gray
  Write-Host "Open: http://127.0.0.1:$Port/" -ForegroundColor Green
  & node @args
} finally {
  Pop-Location
}
