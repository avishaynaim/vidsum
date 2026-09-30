param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$directory = Join-Path $PSScriptRoot ('title-worker-fixture-' + [guid]::NewGuid().ToString('N'))
$modulePath = Join-Path $directory 'FixtureTitleModule.psm1'
try {
    $tokens = $null
    $parseErrors = $null
    $startAst = [Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $HelperRoot 'Start-YtSummary.ps1'), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors) { throw 'FAILED: Start-YtSummary.ps1 did not parse.' }
    $completeFunction = $startAst.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'Complete-TitleWorker'
    }, $true)
    if ($null -eq $completeFunction -or $null -ne $completeFunction.Parent.Parent.Parent) {
        throw 'FAILED: Complete-TitleWorker must be declared at script scope.'
    }
    Write-Output 'PASS: title worker completion is declared at launcher script scope.'

    $null = New-Item -ItemType Directory -Path $directory
    @'
function Open-YtCdp {
    $socket = [pscustomobject]@{Disposed=$false}
    $socket | Add-Member ScriptMethod Dispose {$this.Disposed=$true}
    [pscustomobject]@{Socket=$socket}
}
function Get-YtYouTubeVideoMetadata {
    param($Connection,$VideoId,$CancellationToken)
    [pscustomobject]@{Title="Title for $VideoId";DurationSeconds=3723}
}
function Test-YtTransientInfrastructureFailure { return $false }
Export-ModuleMember -Function *
'@ | Set-Content -LiteralPath $modulePath -Encoding UTF8
    $job = [pscustomobject]@{Id='title-job';VideoId='title000001';Title='';DurationSeconds=0}
    $server = [pscustomobject]@{StopRequested=$false}
    $server | Add-Member ScriptMethod SetJobMetadata {
        param($Id,$Title,$DurationSeconds)
        if ($Id -ne $job.Id) { throw 'Wrong title job.' }
        $job.Title = $Title
        $job.DurationSeconds = $DurationSeconds
    }
    & (Join-Path $HelperRoot 'Invoke-YtTitleWorker.ps1') -ModulePath $modulePath `
        -BrowserWebSocketUrl 'ws://127.0.0.1:12345/devtools/browser/fixture' `
        -Server $server -Job $job -CancellationToken ([Threading.CancellationToken]::None)
    if ($job.Title -cne 'Title for title000001' -or $job.DurationSeconds -ne 3723) {
        throw 'FAILED: title worker did not persist the discovered title and duration.'
    }
    Write-Output 'PASS: title worker persists title and duration without invoking summary processing.'

    # A late non-terminating error in a worker runspace must never overwrite the terminal
    # outcome the worker already recorded, or a video that really completed is reported as
    # "Video worker failed:" with no reason at all.
    $videoFunction = $startAst.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'Complete-VideoWorker'
    }, $true)
    if ($null -eq $videoFunction) { throw 'FAILED: Complete-VideoWorker was not found.' }
    Invoke-Expression $videoFunction.Extent.Text
    $states = @{}
    $server = [pscustomobject]@{}
    $server | Add-Member ScriptMethod GetJob { param($Id) [pscustomobject]@{Id=$Id;State=$states[$Id]} }
    $server | Add-Member ScriptMethod UpdateJob {
        param($Id,$State,$Message)
        $states[$Id] = $State
        $script:lastMessage = $Message
    }
    foreach ($case in @(
        @{Id='settled';State='completed';Expected='completed'},
        @{Id='unsettled';State='summarizing';Expected='error'}
    )) {
        $states[$case.Id] = $case.State
        $script:lastMessage = ''
        $shell = [PowerShell]::Create()
        $null = $shell.AddScript('Write-Error "late runspace noise"')
        $entry = [pscustomobject]@{
            PowerShell=$shell;Async=$shell.BeginInvoke()
            Cts=(New-Object Threading.CancellationTokenSource)
            Job=[pscustomobject]@{Id=$case.Id;VideoId='vid00000001'}
        }
        Complete-VideoWorker $entry -WarningAction SilentlyContinue
        if ($states[$case.Id] -ne $case.Expected) {
            throw "FAILED: a $($case.State) job became $($states[$case.Id]) instead of $($case.Expected)."
        }
        if ($case.Expected -eq 'error' -and $script:lastMessage -notmatch 'late runspace noise') {
            throw 'FAILED: the worker failure message lost its reason.'
        }
    }
    Write-Output 'PASS: a late runspace error never overwrites an already-settled job outcome.'
    Write-Output 'PASS: an unsettled job still fails with a non-empty reason.'
} finally {
    if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
}
