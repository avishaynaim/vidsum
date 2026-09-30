[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ModulePath,
    [Parameter(Mandatory)][string]$BrowserWebSocketUrl,
    [Parameter(Mandatory)]$Server,
    [Parameter(Mandatory)]$Job,
    [Parameter(Mandatory)][string]$JournalPath,
    [System.Threading.SemaphoreSlim]$ComposerGate,
    [System.Collections.IDictionary]$ProviderGates,
    [ValidateSet('ChatGPT','Gemini','Claude')][string]$FirstProvider = 'ChatGPT',
    [Parameter(Mandatory)][System.Threading.CancellationToken]$CancellationToken,
    [ValidateRange(2048, 100000)][int]$MaxMessageCharacters = 22000
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$connection = $null
try {
    $journalAtAttemptStart = Test-Path -LiteralPath $JournalPath
    if ($Job.State -in @('submitted', 'completed', 'reviewed', 'cancelled')) { return }
    Import-Module -Name $ModulePath -Force -DisableNameChecking -ErrorAction Stop
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        $partsAtAttemptStart = if ($Job.PSObject.Properties['SuccessfulParts']) { [int]$Job.SuccessfulParts } else { 0 }
        $stageAtAttemptStart = if ($Job.PSObject.Properties['StageIndex']) { [int]$Job.StageIndex } else { 0 }
        try {
            $CancellationToken.ThrowIfCancellationRequested()
            if ($Server.StopRequested) { throw (New-Object System.OperationCanceledException -ArgumentList 'The helper was stopped.') }
            if (-not $Server.IsRunning) { throw "Local server stopped: $($Server.LastServerError)" }
            $Server.UpdateJob($Job.Id, 'starting', "Connecting this job to the dedicated browser (attempt $attempt/3).")
            $connection = Open-YtCdp -WebSocketUrl $BrowserWebSocketUrl -CancellationToken $CancellationToken
            Invoke-YtSummaryJob -Connection $connection -Server $Server -Job $Job -JournalPath $JournalPath `
                -ComposerGate $ComposerGate -ProviderGates $ProviderGates -FirstProvider $FirstProvider `
                -CancellationToken $CancellationToken -MaxMessageCharacters $MaxMessageCharacters
            if ($Job.State -eq 'error' -and $Job.Message) {
                throw (New-Object InvalidOperationException -ArgumentList $Job.Message)
            }
            if ($Job.State -eq 'cancelled' -and -not $CancellationToken.IsCancellationRequested -and -not $Server.StopRequested) {
                $cancelMessage = if ($Job.Message) { $Job.Message } else { 'Unexpected worker cancellation.' }
                throw (New-Object OperationCanceledException -ArgumentList $cancelMessage)
            }
            break
        } catch {
            $hasProgress = ($Job.PSObject.Properties['SuccessfulParts'] -and [int]$Job.SuccessfulParts -gt $partsAtAttemptStart) -or
                ($Job.PSObject.Properties['StageIndex'] -and [int]$Job.StageIndex -gt $stageAtAttemptStart) -or
                ((Test-Path -LiteralPath $JournalPath) -and -not $journalAtAttemptStart)
            if ($attempt -ge 3 -or $hasProgress -or $_.Exception.Data['YtRetriesExhausted'] -or
                -not (Test-YtTransientInfrastructureFailure $_.Exception $Server $CancellationToken)) { throw }
            $Server.UpdateJob($Job.Id, 'starting',
                "Transient infrastructure error; retrying independently ($($attempt + 1)/3): $($_.Exception.Message)")
            Start-Sleep -Milliseconds (200 * $attempt)
        } finally {
            if ($null -ne $connection) {
                try { $connection.Socket.Dispose() }
                catch { Write-Warning "Job $($Job.Id): Could not dispose retry connection: $($_.Exception.Message)" }
                $connection = $null
            }
        }
    }
} catch {
    $stateName = if ($CancellationToken.IsCancellationRequested -or $Server.StopRequested) { 'cancelled' }
        else { 'error' }
    $message = $_.Exception.Message
    $pausedByUser = $false
    if ($Job.PSObject.Properties['PausedByUser']) { $pausedByUser = [bool]$Job.PausedByUser }
    if ($stateName -eq 'cancelled' -and -not $Server.StopRequested -and $CancellationToken.IsCancellationRequested -and $pausedByUser) {
        # Only an explicit per-job Pause sets this flag before cancelling the job's own token, so
        # this cannot fire for a global helper stop or any other cancellation source.
        $message = 'Paused by request. Resume anytime from its saved checkpoint; no progress was lost.'
    }
    $Server.UpdateJob($Job.Id, $stateName, $message)
    Write-Warning "Job $($Job.Id): $message"
} finally {
    if ($null -ne $connection) {
        # The parent owns the browser; disposing this socket leaves every tab open.
        try { $connection.Socket.Dispose() }
        catch { Write-Warning "Job $($Job.Id): Could not dispose its browser connection: $($_.Exception.Message)" }
    }
}
