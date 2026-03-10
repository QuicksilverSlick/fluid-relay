#Requires -Version 5.1
<#
.SYNOPSIS
    Start fluid-relay (BeamCode) with Claude Code, Codex, and Fluid Brain.

.DESCRIPTION
    Launches BeamCode on port 9414, then creates:
      - Session 1: Claude Code (agent adapter)
      - Session 2: Codex (agent adapter)

    Fluid Brain is connected via .mcp.json auto-discovery.
    Open http://localhost:9414 in your browser to access all sessions.

.EXAMPLE
    .\start.ps1
    .\start.ps1 -Port 9414 -Adapter claude
    .\start.ps1 -NoCodex
#>

param(
    [int]$Port = 9414,
    [string]$Adapter = "claude",
    [switch]$NoCodex,
    [switch]$NoTunnel,
    [switch]$Verbose
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── Paths ───────────────────────────────────────────────────────────────────

$NpmGlobal    = Join-Path $env:USERPROFILE ".npm-global"
$ClaudeBinary = Join-Path $NpmGlobal "claude.cmd"
$CodexBinary  = Join-Path $NpmGlobal "codex.cmd"
$BeamcodeBin  = Join-Path $ProjectRoot "dist\bin\beamcode.mjs"
$DataDir      = Join-Path $env:USERPROFILE ".beamcode"

# ── Preflight ───────────────────────────────────────────────────────────────

if (-not (Test-Path $BeamcodeBin)) {
    Write-Host "ERROR: BeamCode not built. Run: pnpm build" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $ClaudeBinary)) {
    Write-Host "WARNING: Claude CLI not found at $ClaudeBinary" -ForegroundColor Yellow
    Write-Host "  Install: npm install -g @anthropic-ai/claude-code" -ForegroundColor Yellow
}

if (-not $NoCodex -and -not (Test-Path $CodexBinary)) {
    Write-Host "WARNING: Codex CLI not found at $CodexBinary" -ForegroundColor Yellow
    Write-Host "  Install: npm install -g @openai/codex" -ForegroundColor Yellow
}

# ── Clean stale state ───────────────────────────────────────────────────────

$LockFile = Join-Path $DataDir "daemon.lock"
$StateFile = Join-Path $DataDir "daemon.json"

if (Test-Path $LockFile) {
    # Check if PID is still running
    try {
        $StateContent = Get-Content $StateFile -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
        if ($StateContent.pid) {
            $proc = Get-Process -Id $StateContent.pid -ErrorAction SilentlyContinue
            if ($proc) {
                Write-Host "Stopping existing BeamCode (PID $($StateContent.pid))..." -ForegroundColor Yellow
                Stop-Process -Id $StateContent.pid -Force -ErrorAction SilentlyContinue
                Start-Sleep -Seconds 2
            }
        }
    } catch {}
    Remove-Item $LockFile -Force -ErrorAction SilentlyContinue
    Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
}

# ── Start BeamCode ──────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  ════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host "  Fluid Relay — BeamCode + Fluid Brain Hub" -ForegroundColor Cyan
Write-Host "  ════════════════════════════════════════════" -ForegroundColor Cyan
Write-Host ""

$BeamcodeArgs = @(
    $BeamcodeBin,
    "--no-auto-launch",
    "--port", $Port,
    "--claude-binary", $ClaudeBinary
)

if ($NoTunnel) {
    $BeamcodeArgs += "--no-tunnel"
} else {
    # Default to no tunnel on Windows (cloudflared may not be available)
    $BeamcodeArgs += "--no-tunnel"
}

if ($Verbose) {
    $BeamcodeArgs += "--verbose"
}

Write-Host "  Starting BeamCode on port $Port..." -ForegroundColor Green
$BeamcodeProcess = Start-Process -FilePath "node" -ArgumentList $BeamcodeArgs `
    -WorkingDirectory $ProjectRoot -PassThru -NoNewWindow

# Wait for server to be ready
$MaxWait = 15
$Ready = $false
for ($i = 0; $i -lt $MaxWait; $i++) {
    Start-Sleep -Seconds 1
    try {
        $null = Invoke-RestMethod -Uri "http://localhost:$Port/health" -Method GET -ErrorAction SilentlyContinue
        $Ready = $true
        break
    } catch {}
}

if (-not $Ready) {
    # Health might need auth - try without auth check
    try {
        $response = Invoke-WebRequest -Uri "http://localhost:$Port/health" -Method GET -ErrorAction SilentlyContinue
        if ($response.StatusCode -eq 401) {
            $Ready = $true  # Server is up, just needs auth
        }
    } catch {
        if ($_.Exception.Response.StatusCode -eq 401) {
            $Ready = $true
        }
    }
}

if (-not $Ready) {
    Write-Host "  ERROR: BeamCode failed to start within ${MaxWait}s" -ForegroundColor Red
    if ($BeamcodeProcess -and -not $BeamcodeProcess.HasExited) {
        Stop-Process -Id $BeamcodeProcess.Id -Force
    }
    exit 1
}

Write-Host "  BeamCode is running! (PID: $($BeamcodeProcess.Id))" -ForegroundColor Green
Write-Host ""

# ── Read API key from startup output ────────────────────────────────────────

# The API key is printed to stdout during startup.
# Since we can't easily capture it from a NoNewWindow process,
# read it from the state file or just tell the user.
Write-Host "  ┌─────────────────────────────────────────────────┐" -ForegroundColor White
Write-Host "  │  Open http://localhost:$Port in your browser     │" -ForegroundColor White
Write-Host "  │  The API key is shown in the BeamCode output    │" -ForegroundColor White
Write-Host "  │                                                 │" -ForegroundColor White
Write-Host "  │  Sessions available:                            │" -ForegroundColor White
Write-Host "  │    - Claude Code (auto or via API)              │" -ForegroundColor White
if (-not $NoCodex) {
Write-Host "  │    - Codex (via API)                            │" -ForegroundColor White
}
Write-Host "  │    - Fluid Brain (via .mcp.json)                │" -ForegroundColor White
Write-Host "  └─────────────────────────────────────────────────┘" -ForegroundColor White
Write-Host ""
Write-Host "  To create sessions, use the API key from BeamCode's output:" -ForegroundColor Gray
Write-Host ""
Write-Host "  # Claude Code session:" -ForegroundColor DarkGray
Write-Host "  curl -X POST http://localhost:$Port/api/sessions `` " -ForegroundColor DarkGray
Write-Host "    -H 'Authorization: Bearer <API_KEY>' `` " -ForegroundColor DarkGray
Write-Host "    -H 'Content-Type: application/json' `` " -ForegroundColor DarkGray
Write-Host "    -d '{`"adapterName`":`"claude`"}'" -ForegroundColor DarkGray
Write-Host ""

if (-not $NoCodex) {
Write-Host "  # Codex session:" -ForegroundColor DarkGray
Write-Host "  curl -X POST http://localhost:$Port/api/sessions `` " -ForegroundColor DarkGray
Write-Host "    -H 'Authorization: Bearer <API_KEY>' `` " -ForegroundColor DarkGray
Write-Host "    -H 'Content-Type: application/json' `` " -ForegroundColor DarkGray
Write-Host "    -d '{`"adapterName`":`"codex`"}'" -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "  Press Ctrl+C to stop" -ForegroundColor Yellow
Write-Host ""

# ── Wait for process to exit ────────────────────────────────────────────────

try {
    $BeamcodeProcess.WaitForExit()
} catch {
    # Ctrl+C
}

# Cleanup
if ($BeamcodeProcess -and -not $BeamcodeProcess.HasExited) {
    Stop-Process -Id $BeamcodeProcess.Id -Force -ErrorAction SilentlyContinue
}

Remove-Item (Join-Path $DataDir "daemon.lock") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $DataDir "daemon.json") -Force -ErrorAction SilentlyContinue

Write-Host "  Fluid Relay stopped." -ForegroundColor Yellow
