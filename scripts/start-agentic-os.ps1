param(
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$AgenticOSRoot = Split-Path -Parent $PSScriptRoot
$AssistantRoot = Split-Path -Parent $AgenticOSRoot
$ServerUrl = "http://127.0.0.1:5175/api/models"
$SecurityAuditUrl = "http://127.0.0.1:5175/api/security/github-audit"
$AppUrl = "http://localhost:5174/"
$Node = (Get-Command node -ErrorAction Stop).Source
$ServerEntry = Join-Path $AgenticOSRoot "server\index.js"
$ViteEntry = Join-Path $AgenticOSRoot "node_modules\vite\bin\vite.js"
$LogRoot = Join-Path $AssistantRoot "AIAccess\Vault\Logs\AgenticOS"

New-Item -ItemType Directory -Path $LogRoot -Force | Out-Null

function Test-Endpoint([string]$Uri) {
  try {
    $null = Invoke-WebRequest -Uri $Uri -TimeoutSec 2 -UseBasicParsing
    return $true
  } catch {
    return $false
  }
}

function Wait-Endpoint([string]$Uri, [int]$Seconds = 35) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (Test-Endpoint $Uri) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"

$BackendAlreadyRunning = Test-Endpoint $ServerUrl
if ($BackendAlreadyRunning -and -not (Test-Endpoint $SecurityAuditUrl)) {
  throw "An outdated Agentic OS backend is already listening on port 5175. Stop that server, then run this script again."
}

if (-not $BackendAlreadyRunning) {
  if (-not (Test-Path $ServerEntry)) { throw "Backend entry point not found: $ServerEntry" }
  Start-Process -FilePath $Node `
    -ArgumentList @("`"$ServerEntry`"") `
    -WorkingDirectory $AgenticOSRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogRoot "server-$stamp.out.log") `
    -RedirectStandardError (Join-Path $LogRoot "server-$stamp.err.log") | Out-Null
}

if (-not (Test-Endpoint $AppUrl)) {
  if (-not (Test-Path $ViteEntry)) { throw "Vite is not installed. Run npm install in $AgenticOSRoot first." }
  Start-Process -FilePath $Node `
    -ArgumentList @("`"$ViteEntry`"") `
    -WorkingDirectory $AgenticOSRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $LogRoot "vite-$stamp.out.log") `
    -RedirectStandardError (Join-Path $LogRoot "vite-$stamp.err.log") | Out-Null
}

if (-not (Wait-Endpoint $ServerUrl)) { throw "Agentic OS backend did not become ready at http://localhost:5175" }
if (-not (Wait-Endpoint $SecurityAuditUrl)) { throw "Agentic OS backend is missing the GitHub security audit endpoint. Restart server/index.js." }
if (-not (Wait-Endpoint $AppUrl)) { throw "Agentic OS web app did not become ready at $AppUrl" }

if (-not $NoBrowser) { Start-Process $AppUrl }
