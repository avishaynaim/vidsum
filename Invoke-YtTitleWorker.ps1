[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ModulePath,
    [Parameter(Mandatory)][string]$BrowserWebSocketUrl,
    [Parameter(Mandatory)]$Server,
    [Parameter(Mandatory)]$Job,
    [Parameter(Mandatory)][System.Threading.CancellationToken]$CancellationToken
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$connection = $null
try {
    Import-Module -Name $ModulePath -Force -DisableNameChecking -ErrorAction Stop
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $CancellationToken.ThrowIfCancellationRequested()
            if ($Server.StopRequested) { return }
            $connection = Open-YtCdp -WebSocketUrl $BrowserWebSocketUrl -CancellationToken $CancellationToken
            $metadata = Get-YtYouTubeVideoMetadata -Connection $connection -VideoId $Job.VideoId `
                -CancellationToken $CancellationToken
            $Server.SetJobMetadata($Job.Id, [string]$metadata.Title, [int]$metadata.DurationSeconds)
            return
        } catch {
            if ($attempt -ge 3 -or $CancellationToken.IsCancellationRequested -or $Server.StopRequested -or
                -not (Test-YtTransientInfrastructureFailure $_.Exception $Server $CancellationToken)) {
                Write-Warning "Could not retrieve title for $($Job.VideoId): $($_.Exception.Message)"
                return
            }
            Start-Sleep -Milliseconds (200 * $attempt)
        } finally {
            if ($null -ne $connection) {
                try { $connection.Socket.Dispose() } catch { }
                $connection = $null
            }
        }
    }
} finally {
    if ($null -ne $connection) {
        try { $connection.Socket.Dispose() } catch { }
    }
}
