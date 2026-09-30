param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $HelperRoot 'BrowserRecovery.psm1') -Force -DisableNameChecking
$module = Get-Module BrowserRecovery
& $module {
    $script:assertions = 0
    function Assert([bool]$Value, [string]$Message) {
        if (-not $Value) { throw "FAILED: $Message" }
        $script:assertions++
    }
    function New-Connection {
        $socket = [pscustomobject]@{State=[Net.WebSockets.WebSocketState]::Open;Disposed=$false}
        $socket | Add-Member ScriptMethod Dispose {$this.Disposed=$true}
        return [pscustomobject]@{Socket=$socket}
    }
    function New-Server {
        return [pscustomobject]@{
            IsRunning=$true;StopRequested=$false;BrowserReady=$false;BrowserMessage=''
            HasQueuedJobs=$true;HasPendingTitleLookups=$false;DispatchPaused=$false
        }
    }
    function Get-YtBrowser {param($Browser) $script:policyChecks++; if($script:policyBlocked){throw 'Remote debugging disabled by policy.'};return 'fixture.exe'}
    function Invoke-YtCdp {param($Connection,$Method,$Parameters,$TimeoutSeconds) if($script:healthFails){throw 'Fixture connection closed.'};return [pscustomobject]@{product='fixture'}}
    function Start-YtBrowser {
        param($BrowserPath,$ProfileDirectory,$InitialUrl)
        $script:starts++
        if($script:startupFails){throw 'Fixture startup failure.'}
        if($script:stopDuringStart){$script:server.StopRequested=$true}
        $script:healthFails=$false
        return New-Connection
    }
    function Get-Content {param($LiteralPath,[switch]$Raw) return '{"port":43210,"webSocketDebuggerUrl":"ws://127.0.0.1:43210/devtools/browser/new-fixture"}'}
    $script:starts=0;$script:policyChecks=0;$script:policyBlocked=$false
    $script:healthFails=$false;$script:startupFails=$false;$script:stopDuringStart=$false
    $now=[DateTime]::UtcNow
    $args=@{BrowserPath='C:\Fixture\chrome.exe';ProfileDirectory='C:\Fixture\profile';Now=$now}

    $state=New-YtBrowserRecoveryState (New-Connection) ([pscustomobject]@{webSocketDebuggerUrl='old'})
    $script:server=New-Server
    Update-YtBrowserRecovery $state $server @args
    Assert ($server.BrowserReady -and $script:starts -eq 0) 'A healthy browser is not restarted'

    $old=$state.Connection
    $script:healthFails=$true
    Update-YtBrowserRecovery $state $server @args -WarningAction SilentlyContinue
    Assert ($server.BrowserReady -and $script:starts -eq 1 -and $old.Socket.Disposed) 'A closed browser is restored once for queued work'
    Assert ($state.Endpoint.webSocketDebuggerUrl -like '*new-fixture' -and $state.Connection -ne $old) 'Dispatch receives the newly saved endpoint and connection'
    Assert ($script:policyChecks -eq 1) 'Recovery rechecks managed browser policy'
    Assert $server.HasQueuedJobs 'Recovery never consumes or replaces a queued job'
    Update-YtBrowserRecovery $state $server @args
    Assert ($script:starts -eq 1) 'Repeated health ticks do not reopen a healthy browser'

    foreach($guard in @('idle','workers','quota','stop','server-down')) {
        $state=New-YtBrowserRecoveryState $null $null
        $script:server=New-Server
        $active=0
        switch($guard) {
            idle {$server.HasQueuedJobs=$false}
            workers {$active=2}
            quota {$server.DispatchPaused=$true}
            stop {$server.StopRequested=$true}
            server-down {$server.IsRunning=$false}
        }
        Update-YtBrowserRecovery $state $server @args -ActiveWorkers $active
        Assert ($script:starts -eq 1) "$guard does not open a browser"
    }
    $state=New-YtBrowserRecoveryState $null $null
    $script:server=New-Server
    $server.HasQueuedJobs=$false
    $server.HasPendingTitleLookups=$true
    $server.DispatchPaused=$true
    Update-YtBrowserRecovery $state $server @args
    Assert ($script:starts -eq 2 -and $server.BrowserReady) `
        'missing historical titles reopen Chrome independently of paused summary dispatch'
    $script:starts=1
    $state=New-YtBrowserRecoveryState $null $null
    $script:server=New-Server
    $script:startupFails=$true
    Update-YtBrowserRecovery $state $server @args -WarningAction SilentlyContinue
    Assert ($state.Failures -eq 1 -and -not $server.BrowserReady -and $server.BrowserMessage -like '*retrying*') 'Startup failure is shown without claiming ready'
    Update-YtBrowserRecovery $state $server @args -WarningAction SilentlyContinue
    Assert ($script:starts -eq 2) 'Recovery observes its retry backoff'
    $args.Now=$now.AddSeconds(15)
    Update-YtBrowserRecovery $state $server @args -WarningAction SilentlyContinue
    $args.Now=$now.AddSeconds(45)
    Update-YtBrowserRecovery $state $server @args -WarningAction SilentlyContinue
    $args.Now=$now.AddHours(1)
    Update-YtBrowserRecovery $state $server @args -WarningAction SilentlyContinue
    Assert ($state.Failures -eq 3 -and $script:starts -eq 4 -and $server.BrowserMessage -like '*three failed*') 'Automatic startup attempts are capped at three with an explicit final error'

    $script:startupFails=$false;$script:policyBlocked=$true
    $state=New-YtBrowserRecoveryState $null $null
    $script:server=New-Server
    Update-YtBrowserRecovery $state $server @args -WarningAction SilentlyContinue
    Assert ($script:starts -eq 4 -and $server.BrowserMessage -like '*disabled by policy*') 'A managed policy block never starts Chrome'

    $script:policyBlocked=$false;$script:stopDuringStart=$true
    $state=New-YtBrowserRecoveryState $null $null
    $script:server=New-Server
    Update-YtBrowserRecovery $state $server @args -WarningAction SilentlyContinue
    Assert (-not $server.BrowserReady -and $null -ne $state.Connection) 'A concurrent Stop prevents dispatch and retains the recovered socket for shutdown'
    Write-Output "ALL $script:assertions browser-recovery assertions passed. No browser or network used."
}
