param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$count = 0
foreach ($scenario in @('no-window','existing-window','policy','timeout')) {
    Import-Module (Join-Path $HelperRoot 'YtSummary.psm1') -Force -DisableNameChecking
    $module = Get-Module YtSummary
    $result = & $module {
        param($Scenario)
        $script:scenario=$Scenario
        $script:creates=New-Object 'Collections.Generic.List[object]'
        $script:inspections=0
        function Invoke-YtCdp {
            param($Connection,$Method,$Parameters,$SessionId)
            switch ($Method) {
                'Target.createTarget' {
                    $script:creates.Add($Parameters)
                    if ($Parameters.ContainsKey('newWindow')) { return [pscustomobject]@{targetId='replacement-window'} }
                    if ($script:scenario -eq 'existing-window' -and $script:creates.Count -ge 2) {
                        return [pscustomobject]@{targetId='retried-target'}
                    }
                    if ($script:scenario -eq 'policy') { throw 'Browser policy forbids target creation.' }
                    if ($script:scenario -eq 'timeout') { throw 'The target creation request timed out.' }
                    throw 'Browser command Target.createTarget failed: Failed to open a new tab'
                }
                'Target.getTargets' {
                    $script:inspections++
                    $items=@()
                    if($script:scenario -eq 'existing-window'){$items=@([pscustomobject]@{type='page'})}
                    return [pscustomobject]@{targetInfos=$items}
                }
                'Target.attachToTarget' { return [pscustomobject]@{sessionId='replacement-session'} }
                default { throw "Unexpected command $Method" }
            }
        }
        $errorText=''
        $tab=$null
        try { $tab=New-YtBrowserTab $null 'about:blank' -Background } catch { $errorText=$_.Exception.Message }
        return [pscustomobject]@{Tab=$tab;Error=$errorText;Creates=$script:creates.ToArray();Inspections=$script:inspections}
    } $scenario
    if ($scenario -eq 'no-window') {
        if ($null -eq $result.Tab -or $result.Creates.Count -ne 2 -or
            -not $result.Creates[1].newWindow -or $result.Creates[1].ContainsKey('background')) {
            throw 'The no-window fallback did not request one ordinary new browser window.'
        }
    } elseif ($scenario -eq 'existing-window') {
        if ($null -eq $result.Tab -or $result.Error -or $result.Creates.Count -ne 2 -or $result.Inspections -ne 1) {
            throw 'A transient tab-creation failure did not succeed on its bounded retry.'
        }
    } else {
        if (-not $result.Error -or $result.Creates.Count -ne 1 -or $result.Inspections -ne 0) {
            throw 'Policy errors and uncertain timeouts must not trigger another creation attempt.'
        }
    }
    Write-Output "PASS: $scenario tab-creation handling"
    $count++
}
Write-Output "ALL $count tab-lifetime cases passed. No browser or network connection was used."
