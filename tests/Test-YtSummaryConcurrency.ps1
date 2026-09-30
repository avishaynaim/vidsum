param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $HelperRoot
Add-Type -Path (Join-Path $root 'LoopbackServer.cs') -ReferencedAssemblies 'System.dll','System.Core.dll','System.Web.Extensions.dll'
$token = 'c' * 64
$directory = Join-Path $PSScriptRoot 'yt-summary-concurrency-state'
$server = $null
$pool = $null
$release = New-Object Threading.ManualResetEventSlim -ArgumentList $false
$started = New-Object Threading.CountdownEvent -ArgumentList 20
$workers = New-Object 'Collections.Generic.List[object]'
$assertions = 0

function Assert([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "FAILED: $Message" }
    $script:assertions++
    Write-Output "PASS: $Message"
}

function New-Server([int]$Stagger, [string]$Storage) {
    $instance = New-Object YtSummary.LocalServer -ArgumentList 0, $token, '<html></html>', '', 20, $Stagger, $Storage
    $instance.Start()
    return $instance
}

function Post([string]$Path, [hashtable]$Data) {
    $request = [Net.HttpWebRequest]::Create($server.Origin + $Path)
    $request.Proxy = $null
    $request.ServicePoint.Expect100Continue = $false
    $request.KeepAlive = $false
    $request.Method = 'POST'
    $request.ContentType = 'application/json'
    $request.Headers.Add('X-YT-Token', $token)
    $request.Headers.Add('Origin', $server.Origin)
    $bytes = [Text.Encoding]::UTF8.GetBytes(($Data | ConvertTo-Json -Compress))
    $request.ContentLength = $bytes.Length
    $stream = $request.GetRequestStream()
    try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    try { $response = $request.GetResponse() }
    catch [Net.WebException] {
        if ($null -eq $_.Exception.Response) { throw }
        $response = $_.Exception.Response
    }
    try {
        $reader = New-Object IO.StreamReader -ArgumentList $response.GetResponseStream()
        try { $body = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        return [pscustomobject]@{Status=[int]$response.StatusCode;Body=$body}
    } finally { $response.Dispose() }
}

try {
    if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
    $server = New-Server 0 $directory
    $requests = @()
    $jobs = @()
    foreach ($i in 1..23) {
        $request = @{videoId=('vid' + $i.ToString('D8'));requestId=[Guid]::NewGuid().ToString('D')}
        $response = Post '/api/jobs' $request
        if ($response.Status -ne 202) { throw ($response | ConvertTo-Json -Depth 5) }
        $requests += $request
        $jobs += $response.Body
    }
    Assert ($null -eq $server.TakeJob()) 'Twenty-three requests queue before the browser is ready'
    $server.BrowserReady = $true
    $active = @()
    foreach ($i in 1..20) { $active += $server.TakeJob() }
    Assert (@($active | Where-Object { $null -ne $_ }).Count -eq 20) 'All twenty independent worker slots can be dispatched'
    Assert ($null -eq $server.TakeJob()) 'The twenty-first job waits while all slots are occupied'
    $status = Invoke-RestMethod ($server.Origin + '/api/status') -Headers @{'X-YT-Token'=$token} -Proxy $null
    Assert ($status.active -eq 20 -and $status.queued -eq 3 -and $status.maxConcurrent -eq 20) 'Dashboard reports twenty active and three queued'
    $duplicate = Post '/api/jobs' $requests[0]
    Assert ($duplicate.Status -eq 200 -and $duplicate.Body.Id -eq $jobs[0].Id) 'A request retry does not create a second worker'

    $pool = [Management.Automation.Runspaces.RunspaceFactory]::CreateRunspacePool(1, 20)
    $pool.Open()
    $scriptText = @'
param($Server,$Job,$Started,$Release)
$ErrorActionPreference='Stop'
$Server.UpdateJob($Job.Id,'loading','Concurrent fixture running.')
$null=$Started.Signal()
if(-not $Release.Wait(30000)){throw 'Fixture release timed out.'}
$Server.UpdateJob($Job.Id,'submitted','Local fixture completed; no browser message was sent.')
$Job.Id
'@
    foreach ($job in $active) {
        $ps = [Management.Automation.PowerShell]::Create()
        $ps.RunspacePool = $pool
        $null = $ps.AddScript($scriptText).AddArgument($server).AddArgument($job).AddArgument($started).AddArgument($release)
        $workers.Add([pscustomobject]@{PS=$ps;Async=$ps.BeginInvoke();Job=$job})
    }
    Assert ($started.Wait(20000)) 'Twenty actual PowerShell runspaces are executing concurrently'
    Assert (@($active | Where-Object { $_.State -eq 'loading' }).Count -eq 20) 'Every overlapping worker updates only its own job'
    $release.Set()
    $returned = @()
    foreach ($entry in $workers.ToArray()) {
        $returned += @($entry.PS.EndInvoke($entry.Async))
        if ($entry.PS.HadErrors) { throw ($entry.PS.Streams.Error | Out-String) }
        $entry.PS.Dispose()
        $null = $workers.Remove($entry)
    }
    Assert (@($returned | Select-Object -Unique).Count -eq 20) 'Twenty workers return distinct job identities'
    $pool.Close()
    $pool.Dispose()
    $pool = $null
    $reviewJob = $server.TakeJob()
    Assert ($null -ne $reviewJob) 'A queued video starts after a slot is released'
    $server.UpdateJob($reviewJob.Id, 'needs-review', 'Fixture uncertain send.')
    $retry = Post '/api/jobs' @{videoId=$reviewJob.VideoId;requestId=[Guid]::NewGuid().ToString('D')}
    Assert ($retry.Status -eq 200 -and $retry.Body.Id -eq $reviewJob.Id) 'An uncertain matching video reuses its existing retryable job'
    $other = $server.TakeJob()
    Assert ($null -ne $other -and $other.VideoId -ne $reviewJob.VideoId) 'Other videos keep starting despite an uncertain send'
    $server.UpdateJob($other.Id, 'sending', 'Fixture interrupted send.')
    $server.Dispose()
    $server = New-Server 0 $directory
    Assert ($server.GetJob($jobs[0].Id).State -eq 'submitted') 'Confirmed jobs survive restart without replay'
    Assert ($server.GetJob($other.Id).State -eq 'error') 'An interrupted send becomes a retryable per-job error after restart'
    Assert ($server.GetJob($jobs[22].Id).State -eq 'queued') 'Unstarted queue entries survive restart'
    $duplicate = Post '/api/jobs' $requests[0]
    Assert ($duplicate.Status -eq 200 -and $duplicate.Body.Id -eq $jobs[0].Id) 'Request idempotency survives restart'
    Assert ((Post '/api/acknowledge' @{jobId=$reviewJob.Id}).Status -eq 200) 'Review acknowledgement names one video'
    $review = $server.TakeReviewAcknowledgement()
    $server.CompleteReview($review.Id)
    Assert ($server.GetJob($reviewJob.Id).State -eq 'reviewed' -and $server.GetJob($other.Id).State -eq 'error') 'Legacy acknowledgement does not affect another retryable video'
    $fresh = Post '/api/jobs' @{videoId='new00000001';requestId=[Guid]::NewGuid().ToString('D')}
    Assert ($fresh.Status -eq 202) 'New videos queue normally while another send needs review'
    $server.Dispose()
    $server = New-Server 150 (Join-Path $directory 'stagger')
    $server.BrowserReady = $true
    $null = Post '/api/jobs' @{videoId='delay000001';requestId=[Guid]::NewGuid().ToString('D')}
    $null = Post '/api/jobs' @{videoId='delay000002';requestId=[Guid]::NewGuid().ToString('D')}
    $first = $server.TakeJob()
    Assert ($null -ne $first -and $null -eq $server.TakeJob()) 'Scheduler enforces a gap between video starts'
    Start-Sleep -Milliseconds 180
    Assert ($null -ne $server.TakeJob()) 'The next job starts after the stagger interval'
    Write-Output "ALL $assertions concurrency assertions passed. All network traffic was loopback; no browser was opened."
} finally {
    $release.Set()
    foreach ($entry in $workers.ToArray()) {
        try { $null = $entry.PS.EndInvoke($entry.Async) } finally { $entry.PS.Dispose() }
    }
    if ($null -ne $pool) { $pool.Close(); $pool.Dispose() }
    if ($null -ne $server) { $server.Dispose() }
    $release.Dispose()
    $started.Dispose()
    if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
}
