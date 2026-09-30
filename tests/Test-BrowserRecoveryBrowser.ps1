param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $HelperRoot 'YtSummary.psm1') -Force -DisableNameChecking
Import-Module (Join-Path $HelperRoot 'BrowserRecovery.psm1') -Force -DisableNameChecking
Add-Type -Path (Join-Path $HelperRoot 'LoopbackServer.cs') -ReferencedAssemblies 'System.dll','System.Core.dll','System.Web.Extensions.dll'
$directory=Join-Path $PSScriptRoot ('recovery-fixture-' + [guid]::NewGuid().ToString('N'))
$profile=Join-Path $directory 'profile'
$server=$null;$connection=$null;$recovery=$null
try {
    $browser=Get-YtBrowser
    $server=New-Object YtSummary.LocalServer -ArgumentList 0, ('a' * 64), '', '', 20, 0, (Join-Path $directory 'jobs')
    $server.Start()
    $id=[guid]::NewGuid().ToString('D')
    $requestId=[guid]::NewGuid().ToString('D')
    $null=$server.RestorePendingSend($id,$requestId,'JZn5RLXQFtg')
    $server.UpdateJob($id,'queued','Local recovery fixture; no video worker is run.')
    $connection=Start-YtBrowser $browser $profile 'about:blank'
    $oldEndpoint=Get-Content -LiteralPath (Join-Path $profile 'YT-Summary-endpoint.json') -Raw | ConvertFrom-Json
    $recovery=New-YtBrowserRecoveryState $connection $oldEndpoint
    $null=Invoke-YtCdp $connection 'Browser.close'
    $deadline=[DateTime]::UtcNow.AddSeconds(10)
    do {
        $listeners=@([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq ([int]$oldEndpoint.port))
        if(-not $listeners.Count){break}
        Start-Sleep -Milliseconds 200
    } while([DateTime]::UtcNow -lt $deadline)
    if($listeners.Count){throw 'The isolated fixture Chrome did not exit.'}
    Update-YtBrowserRecovery $recovery $server -BrowserPath $browser -ProfileDirectory $profile -ActiveWorkers 0
    if(-not $server.BrowserReady -or $null -eq $recovery.Connection){throw 'Automatic reopen did not restore a usable browser.'}
    if($recovery.Endpoint.webSocketDebuggerUrl -eq $oldEndpoint.webSocketDebuggerUrl){throw 'The dead endpoint was reused.'}
    $null=Invoke-YtCdp $recovery.Connection 'Browser.getVersion'
    if($server.GetJob($id).State -ne 'queued' -or $server.GetJob($id).RequestId -ne $requestId){throw 'Recovery altered the queued request.'}
    $targets=Invoke-YtCdp $recovery.Connection 'Target.getTargets'
    if(@($targets.targetInfos | Where-Object {$_.type -eq 'page' -and $_.url -ne 'about:blank'}).Count){throw 'A test unexpectedly navigated outside its blank fixture.'}
    Write-Output 'PASS: Closing isolated Chrome then recovering reopens a new loopback browser and preserves the exact queued request.'
} finally {
    if($null -ne $recovery){$connection=$recovery.Connection}
    if($null -ne $connection){
        try{$null=Invoke-YtCdp $connection 'Browser.close' -TimeoutSeconds 3}
        catch{Write-Warning $_.Exception.Message}
        $connection.Socket.Dispose()
    }
    if($null -ne $server){$server.Dispose()}
    Start-Sleep -Milliseconds 500
    if(Test-Path -LiteralPath $directory){Remove-Item -LiteralPath $directory -Recurse -Force}
}
