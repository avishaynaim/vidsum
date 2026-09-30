param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$directory = Join-Path $PSScriptRoot ('auto-retry-fixture-' + [guid]::NewGuid().ToString('N'))
$assertions = 0

function Assert([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "FAILED: $Message" }
    $script:assertions++
}

try {
    $null = New-Item -ItemType Directory -Path $directory
    $tokens = $null
    $parseErrors = $null
    $startAst = [Management.Automation.Language.Parser]::ParseFile(
        (Join-Path $HelperRoot 'Start-YtSummary.ps1'), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors) { throw 'FAILED: Start-YtSummary.ps1 did not parse.' }

    $diagnosticFunction = $startAst.Find({
        param($node)
        $node -is [Management.Automation.Language.FunctionDefinitionAst] -and
            $node.Name -eq 'Write-YtFailureDiagnostic'
    }, $true)
    Assert ($null -ne $diagnosticFunction) 'The launcher declares the failure diagnostic recorder'
    Assert ($null -eq $diagnosticFunction.Parent.Parent.Parent) 'The diagnostic recorder is declared at script scope'
    Invoke-Expression $diagnosticFunction.Extent.Text

    $logPath = Join-Path $directory 'diagnostics\failures.jsonl'
    $failed = [pscustomobject]@{
        Id = 'job-1'; VideoId = 'cmnssOpSo80'; Title = 'A real video title'; SummaryLevel = 'ultra'
        State = 'error'; Message = 'Part 1/3 [Gemini]: Too many requests.'; RetryReason = 'previous failure'
        ProviderName = 'Gemini'; Progress = 'Part 1/3'; StageIndex = 1; SuccessfulParts = 1
        ChunkCount = 3; AutoRetryAttempts = 2
    }
    $wrote = Write-YtFailureDiagnostic -Path $logPath -Job $failed -Action 'auto-retry'
    Assert ($wrote -eq $true) 'A successful record reports success so the failure is not marked as handled blindly'
    Assert (Test-Path -LiteralPath $logPath) 'The recorder creates its diagnostics directory and file'
    $lines = @(Get-Content -LiteralPath $logPath)
    Assert ($lines.Count -eq 1) 'Each failure is exactly one line'
    $record = $lines[0] | ConvertFrom-Json
    Assert ($record.action -ceq 'auto-retry') 'The recorded action says what the helper did'
    Assert ($record.videoId -ceq 'cmnssOpSo80' -and $record.jobId -ceq 'job-1') 'The failing video is identified'
    Assert ($record.message -match 'Too many requests') 'The real failure text is preserved for investigation'
    Assert ($record.provider -ceq 'Gemini' -and $record.progress -ceq 'Part 1/3') 'The provider and stage are recorded'
    Assert ($record.successfulParts -eq 1 -and $record.chunkCount -eq 3) 'Saved progress is recorded'
    Assert ($record.autoRetryAttempts -eq 2) 'The automatic attempt number is recorded'
    Assert ($null -ne ([DateTime]::Parse($record.timeUtc))) 'Every record is timestamped'
    $recordNames = @($record.PSObject.Properties.Name)
    Assert ($recordNames -notcontains 'Transcript' -and $recordNames -notcontains 'FinalResult' -and
        $recordNames -notcontains 'transcript') 'No transcript or summary content is ever written to the log'

    $null = Write-YtFailureDiagnostic -Path $logPath -Job $failed -Action 'gave-up'
    Assert (@(Get-Content -LiteralPath $logPath).Count -eq 2) 'Later failures append instead of replacing the log'

    # A job object missing the newer optional fields (an old saved record) must still be recorded.
    $legacyJob = [pscustomobject]@{Id='job-2';VideoId='vid00000002';State='error';Message='Legacy failure.'}
    $null = Write-YtFailureDiagnostic -Path $logPath -Job $legacyJob -Action 'gave-up'
    $legacyRecord = @(Get-Content -LiteralPath $logPath)[-1] | ConvertFrom-Json
    Assert ($legacyRecord.videoId -ceq 'vid00000002' -and $legacyRecord.autoRetryAttempts -eq 0) `
        'A legacy job without the newer fields is still recorded with safe defaults'

    # An unwritable path must never take the helper down; the videos matter more than the log.
    $previousWarning = $WarningPreference
    $WarningPreference = 'SilentlyContinue'
    $failedWrite = Write-YtFailureDiagnostic -Path (Join-Path $directory "bad`0path\log.jsonl") -Job $failed -Action 'auto-retry'
    $WarningPreference = $previousWarning
    Assert ($failedWrite -eq $false) 'A failing diagnostic write is swallowed but reported so the failure stays pending'

    # Size rotation keeps the log bounded without losing the most recent failures.
    $bigPath = Join-Path $directory 'diagnostics\big.jsonl'
    [IO.File]::WriteAllText($bigPath, ('x' * 1100kb))
    $null = Write-YtFailureDiagnostic -Path $bigPath -Job $failed -Action 'auto-retry'
    Assert (Test-Path -LiteralPath ($bigPath + '.1')) 'An oversized log is rotated aside'
    Assert (@(Get-Content -LiteralPath $bigPath).Count -eq 1) 'The rotated log restarts with the newest failure'

    # The launcher must never restart a video whose worker is still alive: rotation reports a
    # stage failure as "error" while it is still trying the next provider.
    $loopText = $startAst.Extent.Text
    Assert ($loopText -match 'TakeAutoRetryCandidate') 'The launcher asks the server for automatic retry candidates'
    Assert ($loopText -match 'RequeueForAutoRetry') 'The launcher requeues failed videos automatically'
    Assert ($loopText -match 'TakeUnrecordedFailure' -and $loopText -match 'MarkFailureRecorded') `
        'The launcher records failures that used up their automatic attempts'
    $autoRetryBlock = [regex]::Match($loopText,
        '\$autoRetry = \$server\.TakeAutoRetryCandidate\(\)(?s).{0,1200}?Write-YtFailureDiagnostic').Value
    Assert ($autoRetryBlock -match '\$workers\.ToArray\(\)') `
        'A video whose worker is still running is skipped by the automatic retry'
    Assert ($autoRetryBlock -match 'RequeueForAutoRetry(?s).{0,400}?Write-YtFailureDiagnostic') `
        'The failure is recorded only after the requeue, so a failing requeue cannot log the same failure forever'
    Assert ($autoRetryBlock -match '\$failureSnapshot') `
        'The failure is recorded from a snapshot taken before the requeue rewrites the message'
    Assert ($loopText -match '\$autoRetry\.AutoRetryAfterUtc = \[DateTime\]::UtcNow\.AddSeconds\(30\)') `
        'A requeue that cannot persist is backed off instead of retried every loop'
    Assert ($loopText -match '\$diagnosticsRetryAfter = \[DateTime\]::MinValue' -and
        $loopText -match 'if \(\[DateTime\]::UtcNow -ge \$diagnosticsRetryAfter\)') `
        'A broken diagnostics log pauses the automatic repair pass instead of spinning'
    Assert ($loopText -match 'if \(Write-YtFailureDiagnostic -Path \$diagnosticsPath -Job \$unrecorded -Action ''gave-up''\) \{\s*\$server\.MarkFailureRecorded') `
        'A failure is only marked as recorded when the record actually reached the log'

    # A journal nobody will ever consume has to be deleted, or the same finished video is
    # re-reported as a failure at every single launch.
    $journalBlock = [regex]::Match($loopText,
        'foreach \(\$file in @\(Get-ChildItem -LiteralPath \$journalDirectory(?s).{0,900}?\r?\n    \}').Value
    Assert ($journalBlock -match 'RestorePendingSend') 'The launcher replays interrupted sends at startup'
    Assert ($journalBlock -match '\$null -eq \$server\.RestorePendingSend' -and $journalBlock -match 'Remove-Item') `
        'A stale journal from an already finished video is deleted instead of replayed forever'

    Write-Output "ALL $assertions auto-retry assertions passed. No browser and no network were used."
} finally {
    if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
}
