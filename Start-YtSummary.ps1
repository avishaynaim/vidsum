param(
    [ValidateSet('Chrome', 'Edge')][string]$Browser = 'Chrome',
    [string]$DataDirectory = (Join-Path $env:LOCALAPPDATA 'YT-Summary\data'),
    [ValidateRange(1, 20)][int]$MaxConcurrent = 4,
    [ValidateSet('ChatGPT','Gemini','Claude')][string]$FirstProvider = 'ChatGPT',
    [ValidateRange(0, 60000)][int]$StartIntervalMilliseconds = 2000,
    [ValidateRange(2048, 100000)][int]$MaxMessageCharacters = 22000,
    [switch]$EnableKiwi,
    [string]$KiwiAddress = '',
    [switch]$NoOpenSetup
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$server = $null
$connection = $null
$recovery = $null
$lock = $null
$pool = $null
$shutdown = New-Object Threading.CancellationTokenSource
$composerGate = New-Object Threading.SemaphoreSlim -ArgumentList 1, 1
$providerGates = @{}
foreach ($providerName in @('ChatGPT','Gemini','Claude')) {
    $providerGates[$providerName] = New-Object Threading.SemaphoreSlim -ArgumentList 1, 1
}
$workers = New-Object 'Collections.Generic.List[object]'
$titleWorker = $null
$exitCode = 0

function Test-PrivateIPv4([string]$Address) {
    $parsed = $null
    if (-not [Net.IPAddress]::TryParse($Address, [ref]$parsed) -or
        $parsed.AddressFamily -ne [Net.Sockets.AddressFamily]::InterNetwork) { return $false }
    $bytes = $parsed.GetAddressBytes()
    return $bytes[0] -eq 10 -or
        ($bytes[0] -eq 172 -and $bytes[1] -ge 16 -and $bytes[1] -le 31) -or
        ($bytes[0] -eq 192 -and $bytes[1] -eq 168)
}

function Find-KiwiAddress {
    $candidates = foreach ($adapter in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()) {
        if ($adapter.OperationalStatus -ne [Net.NetworkInformation.OperationalStatus]::Up -or
            $adapter.NetworkInterfaceType -eq [Net.NetworkInformation.NetworkInterfaceType]::Loopback) { continue }
        $properties = $adapter.GetIPProperties()
        if ($properties.GatewayAddresses.Count -eq 0) { continue }
        foreach ($unicast in $properties.UnicastAddresses) {
            $value = $unicast.Address.ToString()
            if (Test-PrivateIPv4 $value) { $value }
        }
    }
    $selected = @($candidates | Select-Object -Unique)
    if ($selected.Count -ne 1) {
        throw 'Could not choose one private Wi-Fi/LAN IPv4 address. Restart with -EnableKiwi -KiwiAddress 192.168.x.x.'
    }
    return $selected[0]
}

# Every failure is recorded as one metadata-only JSON line so a recurring problem can be
# investigated later without asking the user to copy dashboard text. Transcript and summary
# content is never written here; only the video identity, the stage and the failure message.
function Write-YtFailureDiagnostic {
    param([string]$Path, $Job, [string]$Action)
    try {
        $directory = Split-Path -Parent $Path
        if (-not (Test-Path -LiteralPath $directory)) { $null = New-Item -ItemType Directory -Path $directory -Force }
        if ((Test-Path -LiteralPath $Path) -and (Get-Item -LiteralPath $Path).Length -gt 1MB) {
            Move-Item -LiteralPath $Path -Destination ($Path + '.1') -Force
        }
        $field = { param($Name, $Default) if ($Job.PSObject.Properties[$Name]) { $Job.$Name } else { $Default } }
        $record = [ordered]@{
            timeUtc = [DateTime]::UtcNow.ToString('o')
            action = $Action
            jobId = [string]$Job.Id
            videoId = [string]$Job.VideoId
            title = [string](& $field 'Title' '')
            summaryLevel = [string](& $field 'SummaryLevel' '')
            state = [string]$Job.State
            message = [string]$Job.Message
            retryReason = [string](& $field 'RetryReason' '')
            provider = [string](& $field 'ProviderName' '')
            progress = [string](& $field 'Progress' '')
            stageIndex = [int](& $field 'StageIndex' 0)
            successfulParts = [int](& $field 'SuccessfulParts' 0)
            chunkCount = [int](& $field 'ChunkCount' 0)
            autoRetryAttempts = [int](& $field 'AutoRetryAttempts' 0)
        }
        $line = ($record | ConvertTo-Json -Compress -Depth 4)
        [IO.File]::AppendAllText($Path, $line + [Environment]::NewLine, (New-Object Text.UTF8Encoding($false)))
        return $true
    } catch {
        Write-Warning ('Could not record a failure diagnostic: ' + $_.Exception.Message)
        return $false
    }
}

function Complete-VideoWorker($Entry) {    try {
        $null = $Entry.PowerShell.EndInvoke($Entry.Async)
        foreach ($warning in $Entry.PowerShell.Streams.Warning) { Write-Warning $warning.Message }
        if ($Entry.PowerShell.HadErrors) {
            $details = ($Entry.PowerShell.Streams.Error | Out-String).Trim()
            if (-not $details) { $details = 'The video worker reported an error without any details.' }
            throw $details
        }
    } catch {
        $reason = $_.Exception.Message
        if ([string]::IsNullOrWhiteSpace($reason)) { $reason = $_.Exception.GetType().Name }
        # The worker records its own terminal outcome (including its own error text) before
        # returning. A late non-terminating error in its runspace must never overwrite that
        # outcome, or a video that actually completed is reported as a failure.
        $current = $server.GetJob($Entry.Job.Id)
        $settled = $null -ne $current -and
            $current.State -in @('completed', 'submitted', 'reviewed', 'cancelled', 'error', 'needs-review')
        if (-not $settled) {
            $server.UpdateJob($Entry.Job.Id, 'error', 'Video worker failed: ' + $reason)
        }
        Write-Warning ("Video " + $Entry.Job.VideoId + ": " + $reason)
    } finally {
        $Entry.PowerShell.Dispose()
        $Entry.Cts.Dispose()
    }
}

function Complete-TitleWorker($Entry) {
    try {
        $null = $Entry.PowerShell.EndInvoke($Entry.Async)
        foreach ($warning in $Entry.PowerShell.Streams.Warning) { Write-Warning $warning.Message }
    } catch {
        Write-Warning ("Video title lookup for " + $Entry.Job.VideoId + ": " + $_.Exception.Message)
    } finally {
        try {
            $server.CompleteTitleLookup($Entry.Job.Id,
                (-not [string]::IsNullOrWhiteSpace([string]$Entry.Job.Title) -and
                 [int]$Entry.Job.DurationSeconds -gt 0))
        } finally {
            $Entry.PowerShell.Dispose()
            $Entry.Cts.Dispose()
        }
    }
}

try {
    if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -lt 5) {
        throw 'Run this helper with the built-in Windows PowerShell 5.1, not PowerShell Core.'
    }
    if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
        throw 'Company policy restricts PowerShell. The helper will not change or bypass that policy.'
    }
    if ($KiwiAddress -and -not $EnableKiwi) {
        throw 'KiwiAddress is only used with -EnableKiwi.'
    }
    Import-Module (Join-Path $PSScriptRoot 'YtSummary.psm1') -Force -DisableNameChecking
    Import-Module (Join-Path $PSScriptRoot 'BrowserRecovery.psm1') -Force -DisableNameChecking
    $browserPath = Get-YtBrowser $Browser
    $null = New-Item -ItemType Directory -Path $DataDirectory -Force
    $configPath = Join-Path $DataDirectory 'config.json'
    try {
        $lock = [IO.File]::Open((Join-Path $DataDirectory 'running.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    } catch [IO.IOException] {
        if (-not (Test-Path -LiteralPath $configPath)) { throw 'Another helper is starting. Wait a few seconds and try again.' }
        $existing = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        $status = Invoke-RestMethod -Uri "http://127.0.0.1:$($existing.port)/api/status" -Headers @{ 'X-YT-Token' = $existing.token } -TimeoutSec 3 -Proxy $null
        if ($status.app -ne 'YT Summary') { throw 'The local port is used by an unexpected application.' }
        if ($EnableKiwi -and [string]::IsNullOrWhiteSpace([string]$status.mobileOrigin)) {
            throw 'YT Summary is already running without Kiwi access. Stop it, then restart with -EnableKiwi.'
        }
        $existingKiwiAddress = if ($existing.PSObject.Properties['kiwiAddress']) {
            [string]$existing.kiwiAddress
        } else { '' }
        $existingHost = if ($EnableKiwi -and (Test-PrivateIPv4 $existingKiwiAddress)) {
            $existingKiwiAddress
        } else { '127.0.0.1' }
        if (-not $NoOpenSetup) { Start-Process "http://${existingHost}:$($existing.port)/#token=$($existing.token)" }
        Write-Host 'YT Summary is already running.'
        return
    }
    if (Test-Path -LiteralPath $configPath) {
        $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
        if ($config.token -notmatch '^[a-f0-9]{64}$' -or $config.port -lt 1024 -or $config.port -gt 65535) {
            throw 'Invalid local configuration. Do not reuse an untrusted config.json.'
        }
    } else {
        $bytes = New-Object byte[] 32
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($bytes) } finally { $random.Dispose() }
        $token = ([BitConverter]::ToString($bytes)).Replace('-', '').ToLowerInvariant()
        $config = [pscustomobject]@{ port = 8765; token = $token }
    }
    $mobileAddress = $null
    if ($EnableKiwi) {
        $mobileAddress = if ($KiwiAddress) { $KiwiAddress } else { Find-KiwiAddress }
        if (-not (Test-PrivateIPv4 $mobileAddress)) {
            throw 'KiwiAddress must be a private IPv4 address (10.x.x.x, 172.16-31.x.x, or 192.168.x.x).'
        }
    }
    $savedConfig = [ordered]@{ port = [int]$config.port; token = [string]$config.token }
    if ($EnableKiwi) { $savedConfig.kiwiAddress = $mobileAddress }
    [IO.File]::WriteAllText($configPath, ($savedConfig | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    if (-not ('YtSummary.LocalServer' -as [type])) {
        Add-Type -Path (Join-Path $PSScriptRoot 'LoopbackServer.cs') -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'
    }
    $html = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'index.html'))
    $script = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'app.js'))
    $journalDirectory = Join-Path $DataDirectory 'pending-sends'
    $null = New-Item -ItemType Directory -Path $journalDirectory -Force
    $diagnosticsPath = Join-Path $DataDirectory 'diagnostics\failures.jsonl'
    $diagnosticsRetryAfter = [DateTime]::MinValue
    $server = New-Object YtSummary.LocalServer -ArgumentList $config.port, $config.token, $html, $script,
        $MaxConcurrent, $StartIntervalMilliseconds, (Join-Path $DataDirectory 'jobs'), $mobileAddress
    # Removing a video has to remove its pending-send journal too, or the next startup replays
    # that journal and recreates the job the user just deleted.
    $server.PendingSendDirectory = $journalDirectory
    $server.Start()
    $legacyJournal = Join-Path $DataDirectory 'pending-send.json'
    if (Test-Path -LiteralPath $legacyJournal) {
        $legacy = Get-Content -LiteralPath $legacyJournal -Raw | ConvertFrom-Json
        $null = [Guid]::ParseExact($legacy.requestId, 'D')
        if ($legacy.videoId -notmatch '^[A-Za-z0-9_-]{11}$') { throw 'Invalid legacy pending-send record.' }
        $id = [Guid]::NewGuid().ToString('D')
        [IO.File]::Move($legacyJournal, (Join-Path $journalDirectory "$id.json"))
    }
    foreach ($file in @(Get-ChildItem -LiteralPath $journalDirectory -Filter '*.json' -File)) {
        $record = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        $id = [Guid]::ParseExact($file.BaseName, 'D').ToString('D')
        # A journal belonging to a video that already finished is stale: no worker will ever run
        # again to consume it, so leaving it behind would re-report that success as a failure at
        # every launch.
        if ($null -eq $server.RestorePendingSend($id, $record.requestId, $record.videoId)) {
            Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
        }
    }
    Write-Host 'Starting a separate browser profile. Your regular browser is not controlled.'
    $initialUrl = if ($server.DispatchPaused) { 'about:blank' } else { 'https://chatgpt.com/' }
    $connection = Start-YtBrowser $browserPath (Join-Path $DataDirectory 'browser-profile') $initialUrl
    $endpoint = Get-Content -LiteralPath (Join-Path $DataDirectory 'browser-profile\YT-Summary-endpoint.json') -Raw | ConvertFrom-Json
    $recovery = New-YtBrowserRecoveryState $connection $endpoint
    $pool = [Management.Automation.Runspaces.RunspaceFactory]::CreateRunspacePool(1, $MaxConcurrent)
    $pool.Open()
    $server.BrowserReady = $true
    $setupUrl = "$($server.Origin)/#token=$($config.token)"
    if (-not $NoOpenSetup) { Start-Process $setupUrl }
    Write-Host ''
    Write-Host "YT Summary is ready: up to $MaxConcurrent video jobs, starts staggered by $StartIntervalMilliseconds ms."
    Write-Host 'Use the setup page to add the NEW bookmark; keep your old bookmark.'
    Write-Host 'Sign into the ChatGPT WEBSITE in the separate browser window.'
    Write-Host 'Close this helper or use Stop helper on its setup page to finish.'
    Write-Host 'For an unfinished split video, its transcript is saved privately beside its checkpoint so a restart resumes without re-fetching it. It is deleted when the video completes or you clear its progress.'
    if ($EnableKiwi) {
        Write-Host ''
        Write-Host 'Kiwi Android access is enabled for this private network only.' -ForegroundColor Cyan
        Write-Host "Pairing URL: $($server.MobileOrigin)/#token=$($config.token)"
        Write-Host 'Keep this URL private. Android and this PC must be on the same Wi-Fi/LAN.'
        Write-Host 'If Android cannot connect, allow inbound TCP for this helper port on Private networks in Windows Firewall.'
    }
    $nextHealthCheck = [DateTime]::UtcNow.AddSeconds(10)
    $nextReconcileSweep = [DateTime]::UtcNow.AddSeconds(10)
    while ($server.IsRunning -and -not $server.StopRequested) {
        if ($null -ne $titleWorker -and $titleWorker.Async.IsCompleted) {
            Complete-TitleWorker $titleWorker
            $titleWorker = $null
        }
        foreach ($entry in @($workers.ToArray())) {
            if ($entry.Async.IsCompleted) {
                Complete-VideoWorker $entry
                $null = $workers.Remove($entry)
            }
        }
        while ($null -ne ($review = $server.TakeReviewAcknowledgement())) {
            $path = Join-Path $journalDirectory ($review.Id + '.json')
            if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path }
            $server.CompleteReview($review.Id)
        }
        while ($null -ne ($stopJobId = $server.TakeJobStopRequest())) {
            # Only this specific video's own linked token is cancelled; every other queued or
            # active video, and every provider slot, is untouched.
            $entry = @($workers.ToArray()) | Where-Object { $_.Job.Id -eq $stopJobId } | Select-Object -First 1
            if ($null -ne $entry) { $entry.Cts.Cancel() }
        }
        if ([DateTime]::UtcNow -ge $nextHealthCheck) {
            $activeBrowserWorkers = $workers.Count + $(if ($null -ne $titleWorker) { 1 } else { 0 })
            Update-YtBrowserRecovery -State $recovery -Server $server -BrowserPath $browserPath `
                -ProfileDirectory (Join-Path $DataDirectory 'browser-profile') -ActiveWorkers $activeBrowserWorkers
            $connection = $recovery.Connection
            $endpoint = $recovery.Endpoint
            $nextHealthCheck = [DateTime]::UtcNow.AddSeconds(3)
        }
        if ($null -eq $titleWorker -and $server.BrowserReady) {
            $titleJob = $server.TakeTitleLookup()
            if ($null -ne $titleJob) {
                $titlePowerShell = [Management.Automation.PowerShell]::Create()
                $titleCts = [Threading.CancellationTokenSource]::CreateLinkedTokenSource($shutdown.Token)
                try {
                    $null = $titlePowerShell.AddCommand((Join-Path $PSScriptRoot 'Invoke-YtTitleWorker.ps1')).
                        AddParameter('ModulePath', (Join-Path $PSScriptRoot 'YtSummary.psm1')).
                        AddParameter('BrowserWebSocketUrl', $endpoint.webSocketDebuggerUrl).
                        AddParameter('Server', $server).AddParameter('Job', $titleJob).
                        AddParameter('CancellationToken', $titleCts.Token)
                    $titleAsync = $titlePowerShell.BeginInvoke()
                    $titleWorker = [pscustomobject]@{
                        Job=$titleJob;PowerShell=$titlePowerShell;Async=$titleAsync;Cts=$titleCts
                    }
                } catch {
                    $titlePowerShell.Dispose()
                    $titleCts.Dispose()
                    Write-Warning ("Could not start title lookup for " + $titleJob.VideoId + ": " + $_.Exception.Message)
                }
            }
        }
        if ($server.BrowserReady -and [DateTime]::UtcNow -ge $nextReconcileSweep) {
            # A stranded ambiguous send may have finished on its own in the browser. Attaching it
            # automatically is preferred over asking the user for the link.
            $nextReconcileSweep = [DateTime]::UtcNow.AddSeconds(5)
            $ambiguousJob = $server.TakeAmbiguousReconcile()
            if ($null -ne $ambiguousJob) {
                $owner = @($workers.ToArray()) | Where-Object { $_.Job.Id -eq $ambiguousJob.Id } | Select-Object -First 1
                if ($null -ne $owner) {
                    # Rotation writes an ambiguous note before trying the next provider. Its own
                    # worker still owns this video, so nothing may reconcile it from outside yet.
                    try { $server.CompleteAmbiguousReconcile($ambiguousJob.Id, $false, $true) } catch { }
                } else {
                    try {
                        $null = Invoke-YtAmbiguousTabRecovery -Connection $connection -Server $server `
                            -Job $ambiguousJob -CancellationToken $shutdown.Token
                    } catch {
                        try { $server.CompleteAmbiguousReconcile($ambiguousJob.Id, $false) } catch { }
                        Write-Warning ("Could not reconcile " + $ambiguousJob.VideoId + ": " + $_.Exception.Message)
                    }
                }
            }
        }
        # A failed video repairs itself: it is requeued from its saved checkpoint up to a hard
        # cap and the failure is recorded for later investigation, so nothing waits for a manual
        # click. A job whose worker is still alive is skipped entirely, because rotation reports
        # a stage failure as "error" while it is still trying the next provider.
        if ([DateTime]::UtcNow -ge $diagnosticsRetryAfter) {
            $autoRetry = $server.TakeAutoRetryCandidate()
            if ($null -ne $autoRetry) {
                $retryOwner = @($workers.ToArray()) | Where-Object { $_.Job.Id -eq $autoRetry.Id } | Select-Object -First 1
                if ($null -eq $retryOwner) {
                    # Snapshotted before the requeue, because requeueing rewrites the very state
                    # and message that make the record worth keeping.
                    $failureSnapshot = $autoRetry | Select-Object *
                    try {
                        $requeued = $server.RequeueForAutoRetry($autoRetry.Id)
                        if (-not (Write-YtFailureDiagnostic -Path $diagnosticsPath -Job $failureSnapshot -Action 'auto-retry')) {
                            $diagnosticsRetryAfter = [DateTime]::UtcNow.AddSeconds(60)
                        }
                        Write-Host ('Retrying ' + $requeued.VideoId + ' automatically: ' + $requeued.Message)
                    } catch {
                        # A job store that cannot persist must not be hammered every 100 ms.
                        $autoRetry.AutoRetryAfterUtc = [DateTime]::UtcNow.AddSeconds(30)
                        Write-Warning ('Could not automatically retry ' + $autoRetry.VideoId + ': ' + $_.Exception.Message)
                    }
                }
            }
            $unrecorded = $server.TakeUnrecordedFailure()
            if ($null -ne $unrecorded) {
                $recordOwner = @($workers.ToArray()) | Where-Object { $_.Job.Id -eq $unrecorded.Id } | Select-Object -First 1
                if ($null -eq $recordOwner) {
                    if (Write-YtFailureDiagnostic -Path $diagnosticsPath -Job $unrecorded -Action 'gave-up') {
                        $server.MarkFailureRecorded($unrecorded.Id)
                    } else {
                        $diagnosticsRetryAfter = [DateTime]::UtcNow.AddSeconds(60)
                    }
                }
            }
        }
        if ($workers.Count -lt $MaxConcurrent) {
            $job = $server.TakeJob()
            if ($null -ne $job) {
                $worker = [Management.Automation.PowerShell]::Create()
                $worker.RunspacePool = $pool
                $path = Join-Path $journalDirectory ($job.Id + '.json')
                $jobCts = [Threading.CancellationTokenSource]::CreateLinkedTokenSource($shutdown.Token)
                try {
                    $null = $worker.AddCommand((Join-Path $PSScriptRoot 'Invoke-YtSummaryWorker.ps1')).
                        AddParameter('ModulePath', (Join-Path $PSScriptRoot 'YtSummary.psm1')).
                        AddParameter('BrowserWebSocketUrl', $endpoint.webSocketDebuggerUrl).
                        AddParameter('Server', $server).AddParameter('Job', $job).
                        AddParameter('JournalPath', $path).AddParameter('ComposerGate', $composerGate).
                        AddParameter('ProviderGates', $providerGates).AddParameter('FirstProvider', $FirstProvider).
                        AddParameter('CancellationToken', $jobCts.Token).
                        AddParameter('MaxMessageCharacters', $MaxMessageCharacters)
                    $async = $worker.BeginInvoke()
                    $workers.Add([pscustomobject]@{Job=$job;PowerShell=$worker;Async=$async;JournalPath=$path;Cts=$jobCts})
                    Write-Host ("Started video " + $job.VideoId)
                } catch {
                    $worker.Dispose()
                    $jobCts.Dispose()
                    $server.UpdateJob($job.Id, 'error', 'Could not start video worker: ' + $_.Exception.Message)
                    Write-Warning $_.Exception.Message
                }
            }
        }
        Start-Sleep -Milliseconds 100
    }
    if (-not $server.IsRunning -and -not $server.StopRequested) { throw $server.LastServerError }
} catch {
    $exitCode = 1
    Write-Host ('YT Summary stopped: ' + $_.Exception.Message) -ForegroundColor Red
} finally {
    $shutdown.Cancel()
    if ($null -ne $titleWorker) { Complete-TitleWorker $titleWorker }
    foreach ($entry in @($workers.ToArray())) { Complete-VideoWorker $entry }
    if ($null -ne $pool) { $pool.Close(); $pool.Dispose() }
    if ($null -ne $server) { $server.Dispose() }
    if ($null -ne $recovery) { $connection = $recovery.Connection }
    if ($null -ne $connection) {
        try {
            if ($connection.Socket.State -eq [Net.WebSockets.WebSocketState]::Open) {
                $null = Invoke-YtCdp $connection 'Browser.close' @{} -TimeoutSeconds 3
            }
        } catch {
            Write-Warning ('Could not confirm browser closure. Close the dedicated browser window manually. ' + $_.Exception.Message)
        } finally {
            $connection.Socket.Dispose()
        }
    }
    if ($null -ne $lock) { $lock.Dispose() }
    $composerGate.Dispose()
    foreach ($gate in $providerGates.Values) { $gate.Dispose() }
    $shutdown.Dispose()
}
exit $exitCode
