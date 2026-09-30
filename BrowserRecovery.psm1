Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function New-YtBrowserRecoveryState {
    param($Connection, $Endpoint)
    return [pscustomobject]@{
        Connection=$Connection; Endpoint=$Endpoint
        Failures=0; NextAttemptUtc=[DateTime]::MinValue; LastError=''
    }
}

function Update-YtBrowserRecovery {
    param(
        [Parameter(Mandatory)]$State,
        [Parameter(Mandatory)]$Server,
        [Parameter(Mandatory)][string]$BrowserPath,
        [Parameter(Mandatory)][string]$ProfileDirectory,
        [int]$ActiveWorkers = 0,
        [DateTime]$Now = [DateTime]::UtcNow
    )
    if ($Server.StopRequested -or -not $Server.IsRunning) { return }
    if ($null -ne $State.Connection) {
        try {
            if ($State.Connection.Socket.State -ne [Net.WebSockets.WebSocketState]::Open) {
                throw 'The dedicated browser connection closed.'
            }
            $null = Invoke-YtCdp $State.Connection 'Browser.getVersion' @{} -TimeoutSeconds 3
            $Server.BrowserReady = $true
            $Server.BrowserMessage = ''
            return
        } catch {
            $State.LastError = $_.Exception.Message
            $State.Connection.Socket.Dispose()
            $State.Connection = $null
            $Server.BrowserReady = $false
            Write-Warning ('Browser unavailable; queued videos are retained. ' + $State.LastError)
        }
    }
    $Server.BrowserReady = $false
    $hasPendingTitleLookups = $Server.PSObject.Properties['HasPendingTitleLookups'] -and
        [bool]$Server.HasPendingTitleLookups
    if (-not $Server.HasQueuedJobs -and -not $hasPendingTitleLookups) {
        $Server.BrowserMessage = 'Chrome is closed. It will reopen automatically when you start another video with the bookmark.'
        return
    }
    if ($ActiveWorkers -gt 0) {
        $Server.BrowserMessage = 'Waiting for interrupted workers to stop before reopening Chrome. Sent messages will not be replayed.'
        return
    }
    if ($Server.DispatchPaused -and -not $hasPendingTitleLookups) {
        $Server.BrowserMessage = 'Queued videos are saved. Wait for the ChatGPT usage limit to reset, then use Resume.'
        return
    }
    if ($State.Failures -ge 3) {
        $Server.BrowserMessage = 'Automatic browser recovery stopped after three failed attempts. Open the launcher again after resolving: ' + $State.LastError
        return
    }
    if ($Now -lt $State.NextAttemptUtc) { return }
    $Server.BrowserMessage = if ($hasPendingTitleLookups -and -not $Server.HasQueuedJobs) {
        'Reopening the dedicated Chrome browser to fill missing saved video titles. Summaries remain paused.'
    } else {
        'Reopening the dedicated Chrome browser for your queued video. Your saved login will be reused.'
    }
    $recovered = $null
    try {
        # Recheck policy on recovery, and reuse the endpoint validation in Start-YtBrowser.
        $null = Get-YtBrowser $(if ([IO.Path]::GetFileName($BrowserPath) -ieq 'msedge.exe') { 'Edge' } else { 'Chrome' })
        $recovered = Start-YtBrowser $BrowserPath $ProfileDirectory 'about:blank'
        $endpoint = Get-Content -LiteralPath (Join-Path $ProfileDirectory 'YT-Summary-endpoint.json') -Raw | ConvertFrom-Json
        $null = Invoke-YtCdp $recovered 'Browser.getVersion' @{} -TimeoutSeconds 3
        $State.Connection = $recovered
        $State.Endpoint = $endpoint
        $State.Failures = 0
        $State.NextAttemptUtc = [DateTime]::MinValue
        $State.LastError = ''
        if (-not $Server.StopRequested -and $Server.IsRunning) {
            $Server.BrowserReady = $true
            $Server.BrowserMessage = ''
            Write-Host 'Dedicated browser restored automatically. Continuing saved local work.'
        }
    } catch {
        if ($null -ne $recovered) { $recovered.Socket.Dispose() }
        $State.Failures++
        $State.LastError = $_.Exception.Message
        $delay = [Math]::Min(120, 15 * [Math]::Pow(2, $State.Failures - 1))
        $State.NextAttemptUtc = $Now.AddSeconds($delay)
        $Server.BrowserMessage = if ($State.Failures -ge 3) {
            'Automatic browser recovery stopped after three failed attempts. Open the launcher again after resolving: ' + $State.LastError
        } else {
            "Could not reopen Chrome yet. The queue is saved; retrying in $delay seconds. " + $State.LastError
        }
        Write-Warning $Server.BrowserMessage
    }
}

Export-ModuleMember -Function New-YtBrowserRecoveryState, Update-YtBrowserRecovery
