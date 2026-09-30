$ErrorActionPreference = 'Stop'
$modulePath = Join-Path (Split-Path $PSScriptRoot -Parent) 'YtSummary.psm1'
Import-Module $modulePath -Force -DisableNameChecking
$module = Get-Module YtSummary
$script:assertions = 0
function Assert([bool]$Condition, [string]$Message) {
    $script:assertions++
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

$recovered = & $module {
    $script:navigationCalls = 0
    $script:closedTargets = @()
    $script:updates = @()
    function Invoke-YtCdp {
        param($Connection, $Method, $Parameters, $SessionId)
        if ($Method -ne 'Page.navigate') { throw "Unexpected method $Method" }
        $script:navigationCalls++
        if ($SessionId -eq 'dead-session') {
            throw [InvalidOperationException]::new(
                'Browser command Page.navigate failed: Session with given id not found.')
        }
        return [pscustomobject]@{frameId='fixture'}
    }
    function Close-YtStageTab {
        param($Connection, $Tab)
        $script:closedTargets += [string]$Tab.TargetId
    }
    function New-YtBrowserTab {
        param($Connection, $Url, [switch]$Background, $Server,
            [System.Threading.CancellationToken]$CancellationToken)
        return [pscustomobject]@{TargetId='replacement-target';SessionId='replacement-session'}
    }
    $server = [pscustomobject]@{StopRequested=$false}
    $server | Add-Member ScriptMethod UpdateJob {
        param($JobId, $State, $Message)
        $script:updates += $Message
    }
    $job = [pscustomobject]@{Id='job-navigation-recovery'}
    $tab = [pscustomobject]@{TargetId='dead-target';SessionId='dead-session'}
    $result = Invoke-YtProviderNavigation -Connection ([pscustomobject]@{}) -Server $server -Job $job `
        -Tab $tab -ProviderName ChatGPT -ProviderUrl 'https://chatgpt.com/' -Label 'Part 2/33'
    [pscustomobject]@{
        Tab=$result
        NavigationCalls=$script:navigationCalls
        ClosedTargets=@($script:closedTargets)
        Updates=@($script:updates)
    }
}
Assert ($recovered.Tab.SessionId -eq 'replacement-session') 'a dead pre-send session is replaced with a new attached tab'
Assert ($recovered.NavigationCalls -eq 2) 'navigation is retried once on the replacement tab'
Assert ($recovered.ClosedTargets.Count -eq 1 -and $recovered.ClosedTargets[0] -eq 'dead-target') 'the abandoned dead target is closed best-effort'
Assert ($recovered.Updates.Count -eq 1 -and $recovered.Updates[0] -match 'before anything is sent') 'the visible retry reason states that no send occurred'

$exhausted = & $module {
    $script:navigationCalls = 0
    function Invoke-YtCdp {
        param($Connection, $Method, $Parameters, $SessionId)
        $script:navigationCalls++
        throw [InvalidOperationException]::new(
            'Browser command Page.navigate failed: Session with given id not found.')
    }
    function Close-YtStageTab { param($Connection, $Tab) }
    function New-YtBrowserTab {
        param($Connection, $Url, [switch]$Background, $Server,
            [System.Threading.CancellationToken]$CancellationToken)
        return [pscustomobject]@{
            TargetId="replacement-$script:navigationCalls"
            SessionId="replacement-session-$script:navigationCalls"
        }
    }
    $server = [pscustomobject]@{StopRequested=$false}
    $server | Add-Member ScriptMethod UpdateJob { param($JobId, $State, $Message) }
    try {
        $null = Invoke-YtProviderNavigation -Connection ([pscustomobject]@{}) -Server $server `
            -Job ([pscustomobject]@{Id='job-exhausted'}) `
            -Tab ([pscustomobject]@{TargetId='dead';SessionId='dead'}) `
            -ProviderName Gemini -ProviderUrl 'https://gemini.google.com/app' -Label 'Final combined summary'
        throw 'Expected navigation recovery to exhaust.'
    } catch {
        [pscustomobject]@{
            Message=$_.Exception.Message
            RetriesExhausted=[bool]$_.Exception.Data['YtRetriesExhausted']
            NavigationCalls=$script:navigationCalls
        }
    }
}
Assert ($exhausted.Message -match 'Session with given id not found') 'the original navigation error is preserved after bounded recovery'
Assert $exhausted.RetriesExhausted 'exhaustion is tagged so the worker does not add another retry loop'
Assert ($exhausted.NavigationCalls -eq 3) 'pre-send navigation recovery is capped at three attempts'

Write-Host "Provider navigation recovery tests passed ($script:assertions assertions)."
