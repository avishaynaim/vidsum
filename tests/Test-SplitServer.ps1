Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Add-Type -Path (Join-Path $root 'LoopbackServer.cs') -ReferencedAssemblies 'System.dll','System.Core.dll','System.Web.Extensions.dll'
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading;
public sealed class YtTemporaryFileLock : IDisposable
{
    readonly FileStream file;
    readonly Timer timer;
    public YtTemporaryFileLock(string path)
    {
        file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        timer = new Timer(state => file.Dispose(), null, 500, Timeout.Infinite);
    }
    public void Dispose() { timer.Dispose(); file.Dispose(); }
}
'@
$token = 'd' * 64
$directory = Join-Path (Get-Location) ('split-server-state-' + [guid]::NewGuid().ToString('N'))
$server = $null
$assertions = 0
$videoNumber = 0

function Assert([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "FAILED: $Message" }
    $script:assertions++
}

function Assert-Throws([scriptblock]$Action, [string]$Message, [string]$Pattern = '') {
    $threw = $false
    try { & $Action } catch { $threw = -not $Pattern -or $_.Exception.Message -match $Pattern }
    Assert $threw $Message
}

function New-Server([string]$Storage) {
    $instance = New-Object YtSummary.LocalServer -ArgumentList 0, $token, '<html></html>', '', 20, 0, $Storage
    $instance.Start()
    return $instance
}

function Request([string]$Path, [string]$Method = 'POST', [string]$Body = '{}', [hashtable]$Overrides = @{}, [int]$DeclaredLength = -1) {
    $headers = @{
        Host = '127.0.0.1:' + $server.Port
        Origin = $server.Origin
        'X-YT-Token' = $token
        'Content-Type' = 'application/json'
        'Sec-Fetch-Site' = 'same-origin'
    }
    foreach ($key in $Overrides.Keys) {
        if ($null -eq $Overrides[$key]) { $headers.Remove($key) }
        else { $headers[$key] = $Overrides[$key] }
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($Body)
    $head = "$Method $Path HTTP/1.1`r`n"
    foreach ($key in $headers.Keys) { $head += "${key}: $($headers[$key])`r`n" }
    $length = if ($DeclaredLength -ge 0) { $DeclaredLength } else { $bytes.Length }
    $head += "Content-Length: $length`r`nConnection: close`r`n`r`n"
    $client = New-Object Net.Sockets.TcpClient
    try {
        $client.Connect([Net.IPAddress]::Loopback, $server.Port)
        $client.ReceiveTimeout = 8000
        $client.SendTimeout = 8000
        $stream = $client.GetStream()
        $headerBytes = [Text.Encoding]::ASCII.GetBytes($head)
        $stream.Write($headerBytes, 0, $headerBytes.Length)
        $stream.Write($bytes, 0, $bytes.Length)
        $responseHead = ''
        while (-not $responseHead.EndsWith("`r`n`r`n")) {
            $next = $stream.ReadByte()
            if ($next -lt 0) { throw "Incomplete response to $Method $Path after $assertions assertions." }
            $responseHead += [char]$next
        }
        $length = [int]([regex]::Match($responseHead, '(?im)^Content-Length: (\d+)').Groups[1].Value)
        $responseBytes = New-Object byte[] $length
        $read = 0
        while ($read -lt $length) {
            $count = $stream.Read($responseBytes, $read, $length - $read)
            if ($count -eq 0) { throw "Incomplete response body to $Method $Path." }
            $read += $count
        }
        return [pscustomobject]@{
            Status = [int]($responseHead.Split("`r`n")[0].Split(' ')[1])
            Body = ([Text.Encoding]::UTF8.GetString($responseBytes) | ConvertFrom-Json)
        }
    } catch {
        throw "Fixture $Method $Path after $assertions assertions: $($_.Exception.Message)"
    } finally { $client.Dispose() }
}

function Add-Job([string]$Video = '', [string]$Level = '', [string]$Title = '') {
    if (-not $Video) {
        $script:videoNumber++
        $Video = 'vid' + $script:videoNumber.ToString('D8')
    }
    $data = @{videoId=$Video;requestId=[guid]::NewGuid().ToString('D')}
    if ($Level) { $data.summaryLevel = $Level }
    if ($Title) { $data.title = $Title }
    $response = Request '/api/jobs' 'POST' ($data | ConvertTo-Json -Compress)
    if ($response.Status -ne 202) { throw "Could not queue fixture: $($response | ConvertTo-Json -Compress)" }
    return $response.Body
}

try {
    $memory = New-Object YtSummary.LocalServer -ArgumentList 0, $token, '', ''
    try {
        Assert (-not $memory.DispatchPaused -and $memory.PauseReason -eq '') 'Memory-only scheduler starts unpaused'
        Assert ($memory.MaxConcurrent -eq 20 -and $memory.StartIntervalMilliseconds -eq 2000) 'Legacy constructor preserves twenty slots and two-second staggering'
        Assert ($memory.DefaultSummaryLevel -ceq 'ultra') 'Memory-only servers default to Ultra'
        Assert ($memory.DefaultSummaryLanguage -ceq 'hebrew') 'Memory-only servers default summaries to Hebrew'
        Assert (($memory.EnabledProviders -join ',') -ceq 'ChatGPT,Gemini,Claude') 'Memory-only servers enable all providers'
        Assert (-not $memory.GetType().GetProperty('DefaultSummaryLevel').CanWrite) 'The default summary level is a read-only public property'
        $memory.PauseForUsageLimit('Fixture quota reached.')
        Assert ($memory.DispatchPaused -and $memory.PauseReason -eq 'Fixture quota reached.') 'Memory-only pause works'
        $memory.ResumeDispatch()
        Assert (-not $memory.DispatchPaused -and $memory.PauseReason -eq '') 'Memory-only resume works'
        Assert-Throws { $memory.PauseForUsageLimit(' ') } 'Empty pause reason is rejected'
        $memory.BrowserReady = $true
        $titleStates = @('queued','error','cancelled','completed')
        $titleJobs = @()
        for ($i = 0; $i -lt $titleStates.Count; $i++) {
            $id = [guid]::NewGuid().ToString('D')
            $job = $memory.RestorePendingSend($id, [guid]::NewGuid().ToString('D'), ('ttl' + $i.ToString('D8')))
            $memory.UpdateJob($id, $titleStates[$i], 'Fixture titleless saved job.')
            $titleJobs += $job
        }
        $memory.SetJobMetadata($titleJobs[0].Id, 'Already titled', 754)
        $lookups = @()
        while ($null -ne ($lookup = $memory.TakeTitleLookup())) { $lookups += $lookup }
        Assert ($lookups.Count -eq 3 -and
            @($lookups | Where-Object { $_.State -in @('error','cancelled','completed') }).Count -eq 3) `
            'automatic title backfill includes old failed, cancelled, and completed jobs without dispatching queued work'
        foreach ($lookup in $lookups) {
            $memory.SetJobMetadata($lookup.Id, 'Backfilled title ' + $lookup.VideoId, 3723)
            $memory.CompleteTitleLookup($lookup.Id, $true)
        }
        Assert ($null -eq $memory.TakeTitleLookup()) 'successful title lookup work is not duplicated in the same run'
        Assert (@($titleJobs | Where-Object { $_.DurationSeconds -eq 3723 }).Count -eq 3) `
            'metadata backfill stores duration for old failed, cancelled, and completed jobs'

        $genericTitleJob = $memory.RestorePendingSend(
            [guid]::NewGuid().ToString('D'), [guid]::NewGuid().ToString('D'), 'generic0001')
        $memory.SetJobMetadata(
            $genericTitleJob.Id, 'YouTube Transcript Generator | Extract & Download Video Transcripts', 901)
        $memory.UpdateJob($genericTitleJob.Id, 'completed', 'Old completed fixture with a transcript-site page title.')
        $genericLookup = $memory.TakeTitleLookup()
        Assert ($null -ne $genericLookup -and $genericLookup.Id -eq $genericTitleJob.Id) `
            'known transcript-site page titles are automatically replaced for old completed jobs'
        $memory.SetJobTitle($genericLookup.Id, 'Canonical YouTube title')
        $memory.CompleteTitleLookup($genericLookup.Id, $true)
        Assert ($null -eq $memory.TakeTitleLookup()) `
            'a canonical title repaired from a generic transcript-site title is not scheduled again'
    } finally { $memory.Dispose() }

    Assert-Throws {
        New-Object YtSummary.LocalServer -ArgumentList 0, $token, '', '', 4, 0, $null, '8.8.8.8'
    } 'Kiwi mode refuses a public IPv4 bind address'
    Assert-Throws {
        New-Object YtSummary.LocalServer -ArgumentList 0, $token, '', '', 4, 0, $null, '127.0.0.1'
    } 'Kiwi mode refuses loopback as a misleading mobile address'

    $mobileDirectory = Join-Path $directory 'mobile'
    $server = New-Object YtSummary.LocalServer -ArgumentList 0, $token, '<html>mobile</html>', '', 4, 0, $mobileDirectory, '192.168.50.20'
    $server.Start()
    try {
        Assert ($server.Origin -eq "http://127.0.0.1:$($server.Port)" -and
            $server.MobileOrigin -eq "http://192.168.50.20:$($server.Port)") `
            'Kiwi mode publishes separate loopback and selected private-network origins'
        $mobileHeaders = @{
            Host = '192.168.50.20:' + $server.Port
            Origin = $server.MobileOrigin
            'Sec-Fetch-Site' = 'same-origin'
        }
        Assert ((Request '/api/status' 'GET' '' $mobileHeaders).Status -eq 200) `
            'A paired Kiwi dashboard can read authenticated status through the selected private address'
        $mobileJob = @{videoId='mobile00001';requestId=[guid]::NewGuid().ToString('D');summaryLevel='min'} |
            ConvertTo-Json -Compress
        Assert ((Request '/api/jobs' 'POST' $mobileJob $mobileHeaders).Status -eq 202) `
            'A paired Kiwi dashboard can queue a video through the production jobs endpoint'
        Assert ((Request '/api/status' 'GET' '' @{Host='192.168.50.21:' + $server.Port}).Status -eq 421) `
            'Kiwi mode rejects an unconfigured Host header'
        Assert ((Request '/api/settings' 'POST' '{"summaryLevel":"micro"}' @{
            Host='192.168.50.20:' + $server.Port;Origin='http://192.168.50.21:' + $server.Port
        }).Status -eq 403) 'Kiwi mode rejects a mismatched private-network origin'
        Assert ((Request '/api/status' 'GET' '' @{
            Host='192.168.50.20:' + $server.Port;'X-YT-Token'=$null
        }).Status -eq 403) 'Kiwi mode still requires the 256-bit pairing token'
        Assert ((Request '/api/status' 'GET' '').Status -eq 200) `
            'Enabling Kiwi retains ordinary loopback dashboard access'
    } finally {
        $server.Dispose()
        $server = $null
    }

    $levelsDirectory = Join-Path $directory 'levels'
    $settingsPath = Join-Path $levelsDirectory 'settings.state'
    $server = New-Server $levelsDirectory
    $server.BrowserReady = $true
    Assert ($server.DefaultSummaryLevel -ceq 'ultra' -and $server.DefaultSummaryLanguage -ceq 'hebrew' -and
        -not (Test-Path -LiteralPath $settingsPath)) 'Missing saved settings select Ultra and Hebrew without creating a settings file'
    $initialStatus = (Request '/api/status' 'GET' '').Body
    Assert ($initialStatus.summaryLevel -ceq 'ultra' -and $initialStatus.summaryLanguage -ceq 'hebrew' -and
        ($initialStatus.enabledProviders -join ',') -ceq 'ChatGPT,Gemini,Claude') 'Status exposes the default level, Hebrew language, and providers'
    $levelActive = Add-Job
    $levelQueued = Add-Job
    Assert ($levelActive.SummaryLevel -ceq 'ultra' -and $levelQueued.SummaryLevel -ceq 'ultra' -and
        $levelActive.SummaryLanguage -ceq 'hebrew' -and $levelQueued.SummaryLanguage -ceq 'hebrew') 'Unchanged bookmark requests snapshot the default level and Hebrew language'
    Assert ($server.TakeJob().Id -eq $levelActive.Id) 'An Ultra job can dispatch normally'
    $server.UpdateJob($levelActive.Id, 'summarizing', 'Fixture frozen Ultra chunk plan.')
    $setting = Request '/api/settings' 'POST' '{"summaryLevel":"max"}'
    $savedSettings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
    Assert ($setting.Status -eq 200 -and $setting.Body.summaryLevel -ceq 'max' -and $setting.Body.summaryLanguage -ceq 'hebrew' -and
        ($setting.Body.enabledProviders -join ',') -ceq 'ChatGPT,Gemini,Claude') 'Settings returns the complete saved configuration'
    Assert ($savedSettings.summaryLevel -ceq 'max' -and $savedSettings.summaryLanguage -ceq 'hebrew' -and
        ($savedSettings.enabledProviders -join ',') -ceq 'ChatGPT,Gemini,Claude') 'Settings persists the complete settings shape'
    Assert ($server.DefaultSummaryLevel -ceq 'max' -and (Request '/api/status' 'GET' '').Body.summaryLevel -ceq 'max') 'A saved setting updates the public default and status'
    Assert (@(Get-ChildItem -LiteralPath $levelsDirectory -Filter '*.json').Count -eq 2) 'Settings is not loaded as a job JSON file'
    Assert ($server.GetJob($levelActive.Id).SummaryLevel -ceq 'ultra' -and $server.GetJob($levelQueued.Id).SummaryLevel -ceq 'ultra') 'Setting changes cannot alter active or queued job intent'
    $savedActive = Get-Content -LiteralPath (Join-Path $levelsDirectory ($levelActive.Id + '.json')) -Raw | ConvertFrom-Json
    Assert ($savedActive.SummaryLevel -ceq 'ultra') 'The frozen level is persisted with every job'
    $retryBody = @{videoId=$levelActive.VideoId;requestId=$levelActive.RequestId}
    $retry = Request '/api/jobs' 'POST' ($retryBody | ConvertTo-Json -Compress)
    Assert ($retry.Status -eq 200 -and $retry.Body.Id -eq $levelActive.Id -and $retry.Body.SummaryLevel -ceq 'ultra') 'An unchanged request retry keeps its original level after a default change'
    $retryBody.summaryLevel = 'ultra'
    Assert ((Request '/api/jobs' 'POST' ($retryBody | ConvertTo-Json -Compress)).Status -eq 200) 'An explicit matching level remains idempotent'
    $retryBody.summaryLevel = 'max'
    Assert ((Request '/api/jobs' 'POST' ($retryBody | ConvertTo-Json -Compress)).Status -eq 409) 'Reusing a request ID with a conflicting explicit level is rejected'
    $retryBody.Remove('summaryLevel')
    $retryBody.videoId = $levelQueued.VideoId
    Assert ((Request '/api/jobs' 'POST' ($retryBody | ConvertTo-Json -Compress)).Status -eq 409) 'Request IDs still cannot be reused for another video'
    $levelDefault = Add-Job
    $levelOverride = Add-Job '' 'reg' 'Queued video title'
    Assert ($levelDefault.SummaryLevel -ceq 'max' -and $levelOverride.SummaryLevel -ceq 'reg') 'New bookmark requests use the saved default and explicit choices override it'
    Assert ($levelOverride.Title -ceq 'Queued video title' -and
        (Get-Content -LiteralPath (Join-Path $levelsDirectory ($levelOverride.Id + '.json')) -Raw | ConvertFrom-Json).Title -ceq 'Queued video title') `
        'A quick-add title is accepted and persisted before the queued video starts'
    $server.SetJobTitle($levelDefault.Id, 'Transcript-discovered title')
    Assert ($server.GetJob($levelDefault.Id).Title -ceq 'Transcript-discovered title' -and
        (Get-Content -LiteralPath (Join-Path $levelsDirectory ($levelDefault.Id + '.json')) -Raw | ConvertFrom-Json).Title -ceq 'Transcript-discovered title') `
        'A title discovered during transcript loading updates the live job and checkpoint atomically'
    $server.SetJobMetadata($levelDefault.Id, 'Transcript-discovered title', 3723)
    $durationStatus = @((Request '/api/status' 'GET' '').Body.jobs | Where-Object Id -eq $levelDefault.Id)[0]
    Assert ($durationStatus.DurationSeconds -eq 3723 -and
        (Get-Content -LiteralPath (Join-Path $levelsDirectory ($levelDefault.Id + '.json')) -Raw | ConvertFrom-Json).DurationSeconds -eq 3723) `
        'A discovered video duration is persisted atomically and exposed by status'
    Assert ($server.DefaultSummaryLevel -ceq 'max' -and (Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).summaryLevel -ceq 'max') 'An explicit job choice does not change the saved default'
    Assert (@((Request '/api/status' 'GET' '').Body.jobs).Count -eq 4) 'Idempotent retries and request conflicts never create another job'

    $languageSetting = Request '/api/settings' 'POST' '{"summaryLanguage":"english"}'
    Assert ($languageSetting.Status -eq 200 -and $server.DefaultSummaryLanguage -ceq 'hebrew' -and
        (Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).summaryLanguage -ceq 'hebrew') 'Legacy English settings are normalized to Hebrew'
    $englishJob = Add-Job
    Assert ($englishJob.SummaryLanguage -ceq 'hebrew') 'New jobs are always created with Hebrew summary intent'
    $null = Request '/api/settings' 'POST' '{"summaryLanguage":"hebrew"}'
    Assert ($server.DefaultSummaryLanguage -ceq 'hebrew' -and $server.GetJob($englishJob.Id).SummaryLanguage -ceq 'hebrew') 'Hebrew remains the only saved summary language'
    $fullJob = Add-Job '' 'full'
    $fullText = "Complete transcript line one.`r`nComplete transcript line two."
    $server.SetFinalResult($fullJob.Id, $fullText)
    $fullResult = Request '/api/result' 'POST' (@{jobId=$fullJob.Id} | ConvertTo-Json -Compress)
    Assert ($fullResult.Status -eq 200 -and $fullResult.Body.finalResult -ceq $fullText -and
        $server.GetJob($fullJob.Id).FinalResult -ceq 'local') 'A Full result is persisted separately and returned only through the authenticated endpoint'
    Assert (Test-Path -LiteralPath (Join-Path $levelsDirectory ($fullJob.Id + '.result.txt'))) 'The Full result has its own local durable file'

    $providersSetting = Request '/api/settings' 'POST' '{"enabledProviders":["ChatGPT","Claude"]}'
    $providerStatus = (Request '/api/status' 'GET' '').Body
    Assert ($providersSetting.Status -eq 200 -and ($server.EnabledProviders -join ',') -ceq 'ChatGPT,Claude') 'Provider settings update independently of the summary level'
    Assert (($providerStatus.enabledProviders -join ',') -ceq 'ChatGPT,Claude' -and $providerStatus.summaryLevel -ceq 'max') 'Status exposes enabled providers without changing the saved level'
    Assert (((Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).enabledProviders -join ',') -ceq 'ChatGPT,Claude') 'Enabled providers are persisted atomically'
    $providerSettingsBefore = [IO.File]::ReadAllText($settingsPath)
    foreach ($body in @('{"enabledProviders":[]}', '{"enabledProviders":["UnknownProvider"]}',
        '{"enabledProviders":["ChatGPT","ChatGPT"]}', '{"enabledProviders":"ChatGPT"}',
        '{"enabledProviders":["chatgpt"]}', '{"enabledProviders":[1]}')) {
        $rejected = Request '/api/settings' 'POST' $body
        Assert ($rejected.Status -eq 400 -and ($server.EnabledProviders -join ',') -ceq 'ChatGPT,Claude') 'Invalid provider settings, including disabling the last provider, are rejected'
        Assert ([IO.File]::ReadAllText($settingsPath) -ceq $providerSettingsBefore) 'Rejected provider settings do not alter persisted state'
    }

    Assert (-not $server.KeepIntermediateTabs) 'Keeping every part/merge tab open defaults to off'
    Assert (((Request '/api/status' 'GET' '').Body).keepIntermediateTabs -eq $false) 'Status exposes the keep-intermediate-tabs default'
    $keepTabsSetting = Request '/api/settings' 'POST' '{"keepIntermediateTabs":true}'
    Assert ($keepTabsSetting.Status -eq 200 -and $keepTabsSetting.Body.keepIntermediateTabs -eq $true -and
        $server.KeepIntermediateTabs) 'Turning on keepIntermediateTabs updates the public setting and its response'
    Assert (((Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).keepIntermediateTabs -eq $true)) 'keepIntermediateTabs is persisted atomically with the other settings'
    Assert (((Request '/api/status' 'GET' '').Body).keepIntermediateTabs -eq $true) 'Status reflects the saved keepIntermediateTabs setting'
    Assert ($server.DefaultSummaryLevel -ceq 'max' -and ($server.EnabledProviders -join ',') -ceq 'ChatGPT,Claude') 'Toggling keepIntermediateTabs does not change the level or enabled providers'
    $keepTabsOffSetting = Request '/api/settings' 'POST' '{"keepIntermediateTabs":false}'
    Assert ($keepTabsOffSetting.Status -eq 200 -and -not $keepTabsOffSetting.Body.keepIntermediateTabs -and
        -not $server.KeepIntermediateTabs) 'Turning keepIntermediateTabs back off is saved as well'
    foreach ($body in @('{"keepIntermediateTabs":"true"}', '{"keepIntermediateTabs":1}',
        '{"keepIntermediateTabs":null}', '{"keepIntermediateTabs":[]}',
        '{"keepIntermediateTabs":true,"keepIntermediateTabs":false}')) {
        $rejectedKeepTabs = Request '/api/settings' 'POST' $body
        Assert ($rejectedKeepTabs.Status -eq 400 -and -not $server.KeepIntermediateTabs) 'Invalid keepIntermediateTabs values are rejected without changing the saved setting'
    }

    $settingsBefore = [IO.File]::ReadAllText($settingsPath)
    foreach ($case in @(
        @{Headers=@{'X-YT-Token'=$null};Code=403},
        @{Headers=@{'X-YT-Token'=('a' * 64)};Code=403},
        @{Headers=@{Origin=$null};Code=403},
        @{Headers=@{Origin='https://example.invalid'};Code=403},
        @{Headers=@{Host='localhost:' + $server.Port};Code=421},
        @{Headers=@{'Sec-Fetch-Site'='cross-site'};Code=403},
        @{Headers=@{'Content-Type'='text/plain'};Code=403}
    )) {
        $body = if ($case.Headers.ContainsKey('Host')) { '' } else { '{"summaryLevel":"micro"}' }
        Assert ((Request '/api/settings' 'POST' $body $case.Headers).Status -eq $case.Code) 'Settings enforces the existing local request authorization'
        Assert ($server.DefaultSummaryLevel -ceq 'max' -and [IO.File]::ReadAllText($settingsPath) -ceq $settingsBefore) 'Unauthorized requests never change memory or saved settings'
    }
    foreach ($body in @('', '[]', 'null', '{}', 'not json', '{"summaryLevel":null}', '{"summaryLevel":1}',
        '{"summaryLevel":true}', '{"summaryLevel":[]}', '{"summaryLevel":{}}',
        '{"summaryLevel":""}', '{"summaryLevel":"legacy"}', '{"summaryLevel":"Ultra"}',
        '{"summaryLevel":"MAX"}', '{"summaryLevel":"normal"}', '{"summaryLevel":"max "}',
        '{"summaryLevel":"max\n"}', '{"SummaryLevel":"micro"}', '{"summaryLevel":"micro","extra":1}',
        '{"summaryLevel":"ultra","summaryLevel":"micro"}', '{"summaryLevel":"micro",}',
        '{"summaryLanguage":null}', '{"summaryLanguage":"Hebrew"}', '{"summaryLanguage":"spanish"}',
        '{"summaryLanguage":"hebrew","summaryLanguage":"english"}')) {
        Assert ((Request '/api/settings' 'POST' $body).Status -eq 400) 'Settings rejects invalid levels, malformed JSON, duplicate keys, and extra fields'
        Assert ($server.DefaultSummaryLevel -ceq 'max' -and [IO.File]::ReadAllText($settingsPath) -ceq $settingsBefore) 'Invalid settings leave the saved default unchanged'
    }
    Assert ((Request '/api/settings' 'GET' '').Status -eq 404) 'Settings is POST-only'
    Assert ((Request '/api/settings' 'POST' '' @{} 2049).Status -eq 413) 'Settings retains the existing request-size limit'
    Assert ($server.DefaultSummaryLevel -ceq 'max' -and [IO.File]::ReadAllText($settingsPath) -ceq $settingsBefore) 'Rejected method and oversized body cannot change settings'
    foreach ($badLevel in @($null, '', 'legacy', 'Ultra', 'MAX', 'normal', 'min ', 1, $true, @('micro'), @{})) {
        $badRequest = @{videoId=$levelQueued.VideoId;requestId=[guid]::NewGuid().ToString('D');summaryLevel=$badLevel}
        Assert ((Request '/api/jobs' 'POST' ($badRequest | ConvertTo-Json -Compress)).Status -eq 400) 'Jobs reject invalid or non-string explicit levels'
    }
    foreach ($body in @(
        ('{"videoId":"' + $levelQueued.VideoId + '","requestId":"' + [guid]::NewGuid().ToString('D') + '","extra":"micro"}'),
        ('{"videoId":"' + $levelQueued.VideoId + '","requestId":"' + [guid]::NewGuid().ToString('D') + '","summaryLevel":"micro","extra":"x"}'),
        ('{"videoId":"' + $levelQueued.VideoId + '","requestId":"' + [guid]::NewGuid().ToString('D') + '","summaryLevel":"ultra","summaryLevel":"micro"}')
    )) {
        Assert ((Request '/api/jobs' 'POST' $body).Status -eq 400) 'Jobs reject unknown fields and repeated level keys'
    }
    Assert (@((Request '/api/status' 'GET' '').Body.jobs).Count -eq 6 -and $server.DefaultSummaryLevel -ceq 'max') 'Invalid job requests neither create jobs nor change the default'

    $lock = [IO.File]::Open($settingsPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        $failedSetting = Request '/api/settings' 'POST' '{"summaryLevel":"micro"}'
        Assert ($failedSetting.Status -eq 503 -and $failedSetting.Body.error -match 'previous default is unchanged') 'A persistent Windows lock returns a clear settings persistence failure'
        Assert ($server.DefaultSummaryLevel -ceq 'max' -and $server.IsRunning -and $server.LastServerError -match 'Could not persist summary settings') 'Failed persistence leaves memory unchanged and the server running'
    } finally { $lock.Dispose() }
    Assert ([IO.File]::ReadAllText($settingsPath) -ceq $settingsBefore) 'Persistent lock failures never delete or corrupt existing saved settings'
    foreach ($path in @($settingsPath, ($settingsPath + '.tmp'))) {
        if (-not (Test-Path -LiteralPath $path)) { [IO.File]::WriteAllText($path, 'Fixture stale temporary settings.') }
        $temporaryLock = New-Object YtTemporaryFileLock -ArgumentList $path
        try { $setting = Request '/api/settings' 'POST' '{"summaryLevel":"min"}' }
        finally { $temporaryLock.Dispose() }
        Assert ($setting.Status -eq 200 -and $server.DefaultSummaryLevel -ceq 'min' -and (Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json).summaryLevel -ceq 'min') 'Transient destination and temporary-file locks recover through bounded retries'
        Assert (-not (Test-Path -LiteralPath ($settingsPath + '.tmp'))) 'Successful settings persistence removes its temporary file'
    }
    foreach ($level in @('ultra','max','reg','min','micro','full')) {
        $setting = Request '/api/settings' 'POST' (@{summaryLevel=$level} | ConvertTo-Json -Compress)
        $job = Add-Job
        Assert ($setting.Status -eq 200 -and $server.DefaultSummaryLevel -ceq $level -and $job.SummaryLevel -ceq $level) 'Every valid saved level is captured by the unchanged bookmark body'
    }

    $sameVideo = Add-Job '' 'ultra'
    $server.UpdateJob($sameVideo.Id, 'summarizing', 'Fixture active Ultra summary.')
    $duplicateBody = @{videoId=$sameVideo.VideoId;requestId=[guid]::NewGuid().ToString('D');summaryLevel='ultra'}
    $duplicate = Request '/api/jobs' 'POST' ($duplicateBody | ConvertTo-Json -Compress)
    Assert ($duplicate.Status -eq 200 -and $duplicate.Body.Id -eq $sameVideo.Id) 'Active duplicate detection still applies within the same level'
    $differentLevel = Add-Job $sameVideo.VideoId 'micro'
    Assert ($differentLevel.Id -ne $sameVideo.Id -and $differentLevel.SummaryLevel -ceq 'micro') 'The same video can queue a different explicit level while another level is active'
    $duplicateBody.requestId = [guid]::NewGuid().ToString('D')
    $duplicateBody.summaryLevel = 'micro'
    $duplicate = Request '/api/jobs' 'POST' ($duplicateBody | ConvertTo-Json -Compress)
    Assert ($duplicate.Status -eq 200 -and $duplicate.Body.Id -eq $differentLevel.Id) 'Queued same-level duplicates return their existing job'
    foreach ($state in @('submitted','completed')) {
        $server.UpdateJob($sameVideo.Id, $state, "Fixture $state cooldown.")
        $duplicateBody.requestId = [guid]::NewGuid().ToString('D')
        $duplicateBody.summaryLevel = 'ultra'
        $duplicate = Request '/api/jobs' 'POST' ($duplicateBody | ConvertTo-Json -Compress)
        Assert ($duplicate.Status -eq 200 -and $duplicate.Body.Id -eq $sameVideo.Id) 'Submitted and completed cooldowns still apply to the same level'
        $choice = if ($state -eq 'submitted') { 'max' } else { 'reg' }
        $newLevel = Add-Job $sameVideo.VideoId $choice
        Assert ($newLevel.Id -ne $sameVideo.Id -and $newLevel.SummaryLevel -ceq $choice) 'A different explicit level is not swallowed by another level cooldown'
    }
    $server.SetResultUrl($sameVideo.Id, 'https://chatgpt.com/c/reused-completed-summary')
    $server.GetJob($sameVideo.Id).UpdatedAt = [DateTime]::UtcNow.AddDays(-30)
    $oldCompletedSequence = $server.GetJob($sameVideo.Id).Sequence
    $duplicateBody.requestId = [guid]::NewGuid().ToString('D')
    $duplicateBody.summaryLevel = 'ultra'
    $oldCompletedDuplicate = Request '/api/jobs' 'POST' ($duplicateBody | ConvertTo-Json -Compress)
    Assert ($oldCompletedDuplicate.Status -eq 200 -and $oldCompletedDuplicate.Body.Id -eq $sameVideo.Id) 'A matching completed summary is reused even after the old cooldown window'
    $bumpedCompleted = @((Request '/api/status' 'GET' '').Body.jobs)[-1]
    $persistedBump = Get-Content -LiteralPath (Join-Path $levelsDirectory ($sameVideo.Id + '.json')) -Raw | ConvertFrom-Json
    Assert ($bumpedCompleted.Id -eq $sameVideo.Id -and $bumpedCompleted.Sequence -gt $oldCompletedSequence -and
        $persistedBump.Sequence -eq $bumpedCompleted.Sequence -and
        ([DateTime]$bumpedCompleted.UpdatedAt) -gt [DateTime]::UtcNow.AddMinutes(-1)) `
        'Reusing a completed summary durably bumps its card to the top of dashboard history'
    $null = Request '/api/settings' 'POST' '{"summaryLanguage":"english"}'
    $englishDuplicate = Request '/api/jobs' 'POST' (@{videoId=$sameVideo.VideoId;requestId=[guid]::NewGuid().ToString('D');summaryLevel='ultra'} | ConvertTo-Json -Compress)
    Assert ($englishDuplicate.Status -eq 200 -and $englishDuplicate.Body.Id -eq $sameVideo.Id -and $englishDuplicate.Body.SummaryLanguage -ceq 'hebrew') 'Legacy language settings cannot create duplicate non-Hebrew summary intent'
    $null = Request '/api/settings' 'POST' '{"summaryLanguage":"hebrew"}'
    $lastLevel = Add-Job $sameVideo.VideoId 'min'
    Assert ($lastLevel.SummaryLevel -ceq 'min' -and $server.DefaultSummaryLevel -ceq 'full') 'All six explicit levels are supported without changing the default'
    $server.UpdateJob($differentLevel.Id, 'needs-review', 'Fixture uncertain send cannot be bypassed.')
    foreach ($level in @('ultra','max','reg','min','micro','full','')) {
        $guardBody = @{videoId=$sameVideo.VideoId;requestId=[guid]::NewGuid().ToString('D')}
        if ($level) { $guardBody.summaryLevel = $level }
        Assert ((Request '/api/jobs' 'POST' ($guardBody | ConvertTo-Json -Compress)).Status -in @(200,202)) 'A legacy needs-review job does not block a new request'
    }
    $retry = Request '/api/jobs' 'POST' (@{videoId=$lastLevel.VideoId;requestId=$lastLevel.RequestId} | ConvertTo-Json -Compress)
    Assert ($retry.Status -eq 200 -and $retry.Body.Id -eq $lastLevel.Id -and $retry.Body.SummaryLevel -ceq 'min') 'An accepted request remains idempotent even while another level needs review'
    $server.UpdateJob($levelActive.Id, 'completed', 'Fixture saved Ultra result.')
    $legacyPath = Join-Path $levelsDirectory ($levelQueued.Id + '.json')
    $legacyJson = Get-Content -LiteralPath $legacyPath -Raw | ConvertFrom-Json
    $legacyJson.PSObject.Properties.Remove('DurationSeconds')
    [IO.File]::WriteAllText($legacyPath, ($legacyJson | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
    $checkpointJob = Add-Job 'R3sum3Parts' 'reg'
    $checkpointHash = 'a' * 64
    $checkpointPlanHash = 'b' * 64
    $server.ResetPartCheckpoint($checkpointJob.Id, $checkpointHash, 42000, 3, 'reg', $checkpointPlanHash, 'Gemini', 2)
    $server.SavePartCheckpoint($checkpointJob.Id, 0, 'Saved summary for Part 1.', 'https://gemini.google.com/app/saved-part-1', 'Gemini', 2)
    $partStatePath = Join-Path $levelsDirectory ($checkpointJob.Id + '.parts.state')
    Assert ((Test-Path -LiteralPath $partStatePath) -and
        $server.GetPartCheckpoint($checkpointJob.Id).Parts[0].Text -ceq 'Saved summary for Part 1.') `
        'A successful part is atomically persisted in a private sidecar checkpoint'
    Assert (-not ((Request '/api/status' 'GET' '').Body.jobs |
        Where-Object Id -eq $checkpointJob.Id).PSObject.Properties['Parts']) `
        'Persisted part text is not exposed through the dashboard job API'
    $server.Dispose()
    $server = New-Server $levelsDirectory
    Assert ($server.DefaultSummaryLevel -ceq 'full' -and (Request '/api/status' 'GET' '').Body.summaryLevel -ceq 'full') 'The saved summary default survives reload'
    Assert ($server.DefaultSummaryLanguage -ceq 'hebrew' -and (Request '/api/status' 'GET' '').Body.summaryLanguage -ceq 'hebrew') 'The saved Hebrew summary-language default survives reload'
    Assert (($server.EnabledProviders -join ',') -ceq 'ChatGPT,Claude') 'The enabled-provider selection survives reload'
    Assert ((Request '/api/result' 'POST' (@{jobId=$fullJob.Id} | ConvertTo-Json -Compress)).Body.finalResult -ceq $fullText) 'The local Full result survives restart'
    $reloadedCheckpoint = $server.GetPartCheckpoint($checkpointJob.Id)
    Assert ($reloadedCheckpoint.TranscriptHash -ceq $checkpointHash -and
        $reloadedCheckpoint.PlanHash -ceq $checkpointPlanHash -and
        $reloadedCheckpoint.ChunkCount -eq 3 -and $reloadedCheckpoint.Parts.Count -eq 1 -and
        $reloadedCheckpoint.Parts[0].ResultUrl -ceq 'https://gemini.google.com/app/saved-part-1') `
        'Successful part text, provenance and transcript identity survive a server restart'
    $transcriptCachePath = Join-Path $levelsDirectory ($checkpointJob.Id + '.transcript.state')
    $cachedText = 'Cached transcript text for resuming without the transcript service.'
    $server.SaveTranscriptCache($checkpointJob.Id, $checkpointJob.VideoId, $cachedText)
    Assert ((Test-Path -LiteralPath $transcriptCachePath) -and
        $server.GetTranscriptCache($checkpointJob.Id, $checkpointJob.VideoId) -ceq $cachedText) `
        'The transcript is saved privately so a restart can resume without calling the transcript service again'
    Assert ($null -eq $server.GetTranscriptCache($checkpointJob.Id, 'Oth3rVid30')) `
        'A cached transcript is never handed back for a different video'
    Assert (-not ((Request '/api/status' 'GET' '').Body.jobs |
        Where-Object Id -eq $checkpointJob.Id).PSObject.Properties['Transcript']) `
        'The cached transcript is not exposed through the dashboard job API'
    Assert (((Request '/api/status' 'GET' '').Body.jobs |
        Where-Object Id -eq $checkpointJob.Id).TranscriptSaved -eq $true) `
        'The TranscriptSaved boolean flag is exposed through the dashboard job API'
    $mismatched = $false
    try { $server.SaveTranscriptCache($checkpointJob.Id, 'Oth3rVid30', $cachedText) } catch { $mismatched = $true }
    Assert $mismatched 'A transcript from another video is refused instead of overwriting this video''s cache'
    $server.CompletePartCheckpoint($checkpointJob.Id)
    Assert (-not (Test-Path -LiteralPath $transcriptCachePath)) `
        'A completed video deletes its cached transcript, so no transcript is retained once it is done'    Assert (-not (Test-Path -LiteralPath $partStatePath) -and $null -eq $server.GetPartCheckpoint($checkpointJob.Id)) `
        'A completed job removes its private resumable part text'
    $server.ResetPartCheckpoint($checkpointJob.Id, $checkpointHash, 42000, 3, 'reg', $checkpointPlanHash, 'Gemini', 2)
    $server.SavePartCheckpoint($checkpointJob.Id, 0, 'Saved again for clear-control coverage.', '', 'Gemini', 2)
    Assert ((Request '/api/clear' 'POST' (@{jobId=$checkpointJob.Id} | ConvertTo-Json -Compress)).Status -eq 200 -and
        -not (Test-Path -LiteralPath $partStatePath)) `
        'Clear local progress removes the private part checkpoint'
    Assert ((Request '/api/clear' 'POST' (@{jobId=$fullJob.Id} | ConvertTo-Json -Compress)).Status -eq 200 -and
        -not (Test-Path -LiteralPath (Join-Path $levelsDirectory ($fullJob.Id + '.result.txt')))) 'Clearing local progress removes the persisted Full result'
    Assert ($server.GetJob($levelActive.Id).SummaryLevel -ceq 'ultra' -and $server.GetJob($levelQueued.Id).SummaryLevel -ceq 'ultra' -and $server.GetJob($levelDefault.Id).SummaryLevel -ceq 'max' -and $server.GetJob($levelOverride.Id).SummaryLevel -ceq 'reg') 'Reload preserves historical and queued levels independently of the current default'
    Assert ($server.GetJob($levelQueued.Id).DurationSeconds -eq 0) `
        'Legacy saved jobs without a duration field load safely with an unknown duration'
    $retry = Request '/api/jobs' 'POST' (@{videoId=$levelActive.VideoId;requestId=$levelActive.RequestId} | ConvertTo-Json -Compress)
    Assert ($retry.Status -eq 200 -and $retry.Body.Id -eq $levelActive.Id -and $retry.Body.SummaryLevel -ceq 'ultra') 'Persisted request retries keep their original chosen level after restart'
    $server.Dispose()
    $server = $null

    $stopJobDirectory = Join-Path $directory 'stop-job'
    $server = New-Server $stopJobDirectory
    $server.BrowserReady = $true
    $queuedToStop = Add-Job
    $stopQueued = Request '/api/stop-job' 'POST' (@{jobId=$queuedToStop.Id} | ConvertTo-Json -Compress)
    Assert ($stopQueued.Status -eq 200 -and $stopQueued.Body.stopping -eq $true) 'Stopping a queued video succeeds'
    Assert ($server.GetJob($queuedToStop.Id).State -ceq 'cancelled') 'A queued video is cancelled immediately with no worker involved'
    Assert ($null -eq $server.TakeJobStopRequest()) 'Cancelling a still-queued video never enqueues a worker stop request'
    $otherQueued = Add-Job
    Assert ($server.GetJob($otherQueued.Id).State -ceq 'queued') 'Stopping one queued video leaves an unrelated queued video untouched'

    $activeToStop = Add-Job
    $server.UpdateJob($activeToStop.Id, 'starting', 'Fixture worker running.')
    $stopActive = Request '/api/stop-job' 'POST' (@{jobId=$activeToStop.Id} | ConvertTo-Json -Compress)
    Assert ($stopActive.Status -eq 200 -and $stopActive.Body.stopping -eq $true) 'Stopping an active video succeeds'
    Assert ($server.GetJob($activeToStop.Id).State -ceq 'starting') 'An active video state is unchanged until its own worker cancels its token'
    Assert ($server.GetJob($otherQueued.Id).State -ceq 'queued') 'Stopping an active video does not disturb a sibling queued video'
    $takenStopId = $server.TakeJobStopRequest()
    Assert ($takenStopId -ceq $activeToStop.Id) 'The host loop can dequeue exactly the requested active video for cancellation'
    Assert ($null -eq $server.TakeJobStopRequest()) 'Each active-video stop request is delivered to the host loop exactly once'
    $stopActiveAgain = Request '/api/stop-job' 'POST' (@{jobId=$activeToStop.Id} | ConvertTo-Json -Compress)
    Assert ($stopActiveAgain.Status -eq 200) 'Stopping the same still-active video again is idempotent'
    Assert ($server.TakeJobStopRequest() -ceq $activeToStop.Id) 'A repeated stop request for the same video is still delivered once more'

    $server.UpdateJob($activeToStop.Id, 'cancelled', 'Fixture worker cancelled.')
    $stopTerminal = Request '/api/stop-job' 'POST' (@{jobId=$activeToStop.Id} | ConvertTo-Json -Compress)
    Assert ($stopTerminal.Status -eq 409) 'Stopping an already-finished video is rejected instead of silently no-oping'
    $stopMissing = Request '/api/stop-job' 'POST' (@{jobId=[guid]::NewGuid().ToString('D')} | ConvertTo-Json -Compress)
    Assert ($stopMissing.Status -eq 409) 'Stopping an unknown job id is rejected'
    $stopBadBody = Request '/api/stop-job' 'POST' '{}'
    Assert ($stopBadBody.Status -eq 400) 'Stopping without a jobId is rejected'
    $stopExtraField = Request '/api/stop-job' 'POST' (@{jobId=$otherQueued.Id;extra=$true} | ConvertTo-Json -Compress)
    Assert ($stopExtraField.Status -eq 400) 'Stopping with unexpected extra fields is rejected'
    $server.Dispose()
    $server = $null

    $pauseJobDirectory = Join-Path $directory 'pause-job'
    $server = New-Server $pauseJobDirectory
    $server.BrowserReady = $true
    $queuedToPause = Add-Job
    $pauseQueued = Request '/api/pause-job' 'POST' (@{jobId=$queuedToPause.Id} | ConvertTo-Json -Compress)
    Assert ($pauseQueued.Status -eq 200 -and $pauseQueued.Body.pausing -eq $true) 'Pausing a queued video succeeds'
    Assert ($server.GetJob($queuedToPause.Id).State -ceq 'cancelled') 'A queued video is cancelled immediately with no worker involved'
    Assert ($server.GetJob($queuedToPause.Id).Message -match 'Paused') 'A paused queued video has a distinct paused message'
    Assert ($null -eq $server.TakeJobStopRequest()) 'Pausing a still-queued video never enqueues a worker stop request'
    $retriedFromPause = Request '/api/retry' 'POST' (@{jobId=$queuedToPause.Id} | ConvertTo-Json -Compress)
    Assert ($retriedFromPause.Status -eq 200 -and $retriedFromPause.Body.State -ceq 'queued') 'A paused-while-queued video can be resumed via retry'

    $activeToPause = Add-Job
    $server.UpdateJob($activeToPause.Id, 'starting', 'Fixture worker running.')
    $pauseActive = Request '/api/pause-job' 'POST' (@{jobId=$activeToPause.Id} | ConvertTo-Json -Compress)
    Assert ($pauseActive.Status -eq 200 -and $pauseActive.Body.pausing -eq $true) 'Pausing an active video succeeds'
    Assert ($server.GetJob($activeToPause.Id).State -ceq 'starting') 'An active video state is unchanged until its own worker cancels its token'
    $takenPauseId = $server.TakeJobStopRequest()
    Assert ($takenPauseId -ceq $activeToPause.Id) 'The host loop can dequeue exactly the requested active video for cancellation'
    $server.UpdateJob($activeToPause.Id, 'cancelled', 'Paused by request. Resume anytime from its saved checkpoint; no progress was lost.')
    Assert ($server.GetJob($activeToPause.Id).State -ceq 'cancelled') 'A paused active video ends up cancelled once its own worker actually stops'

    $pauseTerminal = Request '/api/pause-job' 'POST' (@{jobId=$activeToPause.Id} | ConvertTo-Json -Compress)
    Assert ($pauseTerminal.Status -eq 409) 'Pausing an already-finished video is rejected instead of silently no-oping'
    $pauseMissing = Request '/api/pause-job' 'POST' (@{jobId=[guid]::NewGuid().ToString('D')} | ConvertTo-Json -Compress)
    Assert ($pauseMissing.Status -eq 409) 'Pausing an unknown job id is rejected'
    $pauseBadBody = Request '/api/pause-job' 'POST' '{}'
    Assert ($pauseBadBody.Status -eq 400) 'Pausing without a jobId is rejected'
    $otherQueuedDuringPause = Add-Job
    Assert ($server.GetJob($otherQueuedDuringPause.Id).State -ceq 'queued') 'Pausing one video leaves an unrelated queued video untouched'
    $server.Dispose()
    $server = $null

    $watchLaterDirectory = Join-Path $directory 'watch-later'
    $server = New-Server $watchLaterDirectory
    $server.BrowserReady = $true
    # A queued job marked Watch later stays in state "queued" (not cancelled, like Pause does)
    # so it is never silently retried/cleared, but it must be invisible to automatic dispatch.
    $queuedForLater = Add-Job
    $otherQueuedNormal = Add-Job
    $watchLaterQueued = Request '/api/watch-later' 'POST' (@{jobId=$queuedForLater.Id;watchLater=$true} | ConvertTo-Json -Compress)
    Assert ($watchLaterQueued.Status -eq 200 -and $watchLaterQueued.Body.updated -eq $true) 'Marking a queued video Watch later succeeds'
    Assert ($server.GetJob($queuedForLater.Id).State -ceq 'queued') 'A queued video marked Watch later stays queued, unlike Pause'
    Assert ($server.GetJob($queuedForLater.Id).WatchLater) 'The Watch later flag is set on the job'
    Assert ($null -eq $server.TakeJobStopRequest()) 'Marking a queued video Watch later never enqueues a worker stop request'
    Assert ($server.TakeJob().Id -ceq $otherQueuedNormal.Id) 'TakeJob skips a Watch-later queued video and dispatches the next eligible one instead'
    Assert ($null -eq $server.TakeJob()) 'The Watch-later video is never picked up automatically while marked'

    # Marking an active (already-dispatched) video reuses the exact same cancellation path as
    # the "Stop this video" button; the worker's own loop later records the terminal state.
    $activeForLater = Add-Job
    $server.UpdateJob($activeForLater.Id, 'summarizing', 'Fixture worker running.')
    $watchLaterActive = Request '/api/watch-later' 'POST' (@{jobId=$activeForLater.Id;watchLater=$true} | ConvertTo-Json -Compress)
    Assert ($watchLaterActive.Status -eq 200 -and $watchLaterActive.Body.updated -eq $true) 'Marking an active video Watch later succeeds'
    Assert ($server.GetJob($activeForLater.Id).WatchLater) 'The Watch later flag is set even while the video is still active'
    Assert ($server.GetJob($activeForLater.Id).State -ceq 'summarizing') 'The active video state is unchanged until its own worker cancels its token'
    $takenWatchLaterStopId = $server.TakeJobStopRequest()
    Assert ($takenWatchLaterStopId -ceq $activeForLater.Id) 'Watch later on an active video enqueues the exact same worker-cancellation request as Stop'
    $server.UpdateJob($activeForLater.Id, 'cancelled', 'Fixture worker cancelled by Watch later.')

    # Unmarking restores normal eligibility.
    $watchLaterOff = Request '/api/watch-later' 'POST' (@{jobId=$queuedForLater.Id;watchLater=$false} | ConvertTo-Json -Compress)
    Assert ($watchLaterOff.Status -eq 200 -and -not $server.GetJob($queuedForLater.Id).WatchLater) 'Watch later can be unmarked'
    Assert ($server.TakeJob().Id -ceq $queuedForLater.Id) 'Unmarking Watch later makes the queued video eligible for automatic dispatch again'

    # An explicit "Retry from checkpoint" click is the user asking for this video to run now.
    # It must release the Watch later hold too: TakeJob skips Watch-later videos, so a retry that
    # left the flag set parked the job in "queued" for ever while it claimed to be retrying.
    $watchLaterRetry = Add-Job
    $null = Request '/api/watch-later' 'POST' (@{jobId=$watchLaterRetry.Id;watchLater=$true} | ConvertTo-Json -Compress)
    $server.UpdateJob($watchLaterRetry.Id, 'error', 'Fixture failure while set aside.')
    $retriedWatchLater = Request '/api/retry' 'POST' (@{jobId=$watchLaterRetry.Id} | ConvertTo-Json -Compress)
    Assert ($retriedWatchLater.Status -eq 200) 'Retrying a Watch-later video is accepted'
    Assert (-not $server.GetJob($watchLaterRetry.Id).WatchLater) 'An explicit retry releases the Watch later hold'
    Assert ($server.GetJob($watchLaterRetry.Id).State -ceq 'queued') 'An explicit retry requeues the video'
    Assert ($server.GetJob($watchLaterRetry.Id).Message -match 'Removed from Watch later') 'The retry message states that the Watch later hold was released'
    Assert ($server.TakeJob().Id -ceq $watchLaterRetry.Id) 'A retried Watch-later video is dispatched instead of sitting in the queue for ever'

    # "Start now" is the single control that clears every hold at once. The restart hold in
    # particular is invisible on a job tile and is not cleared by removing Watch later, which is
    # what left queued videos sitting for ever with nothing useful to click.
    $startNowJob = Add-Job
    $null = Request '/api/watch-later' 'POST' (@{jobId=$startNowJob.Id;watchLater=$true} | ConvertTo-Json -Compress)
    $server.PauseForUsageLimit('Fixture restart hold.')
    Assert ($server.DispatchPaused) 'The fixture dispatch hold is in place'
    $startedNow = Request '/api/start-job' 'POST' (@{jobId=$startNowJob.Id} | ConvertTo-Json -Compress)
    Assert ($startedNow.Status -eq 200) 'Start now is accepted for a held video'
    Assert (-not $server.GetJob($startNowJob.Id).WatchLater) 'Start now clears the Watch later hold'
    Assert (-not $server.GetJob($startNowJob.Id).PausedByUser) 'Start now clears a per-video pause'
    Assert ($server.GetJob($startNowJob.Id).State -ceq 'queued') 'Start now queues the video'
    Assert ($server.GetJob($startNowJob.Id).AutoRetryAttempts -eq 0) 'Start now restores the automatic attempt budget'

    $startNowMissing = Request '/api/start-job' 'POST' (@{jobId=[guid]::NewGuid().ToString('D')} | ConvertTo-Json -Compress)
    Assert ($startNowMissing.Status -eq 409) 'Start now on an unknown job id is rejected'
    $startNowBadBody = Request '/api/start-job' 'POST' (@{} | ConvertTo-Json -Compress)
    Assert ($startNowBadBody.Status -eq 400) 'Start now without a jobId is rejected'
    $startNowDone = Add-Job
    $server.UpdateJob($startNowDone.Id, 'completed', 'Fixture finished.')
    $startNowFinished = Request '/api/start-job' 'POST' (@{jobId=$startNowDone.Id} | ConvertTo-Json -Compress)
    Assert ($startNowFinished.Status -eq 409) 'Start now refuses a video that already finished'

    # The restart hold is released by Start now, so the video genuinely dispatches afterwards.
    $server.PauseForUsageLimit('Fixture usage hold.')
    $restartHeld = Add-Job
    $server.GetJob($restartHeld.Id).WatchLater = $false
    $null = Request '/api/start-job' 'POST' (@{jobId=$restartHeld.Id} | ConvertTo-Json -Compress)
    Assert (-not $server.DispatchPaused) 'Start now releases the scheduler hold that kept the queue frozen'
    Assert ($null -ne $server.TakeJob()) 'A video started with Start now is actually dispatched'

    $watchLaterMissing = Request '/api/watch-later' 'POST' (@{jobId=[guid]::NewGuid().ToString('D');watchLater=$true} | ConvertTo-Json -Compress)
    Assert ($watchLaterMissing.Status -eq 409) 'Marking an unknown job id Watch later is rejected'
    $watchLaterBadBody = Request '/api/watch-later' 'POST' (@{jobId=$otherQueuedNormal.Id} | ConvertTo-Json -Compress)
    Assert ($watchLaterBadBody.Status -eq 400) 'Watch later without a watchLater boolean is rejected'
    $watchLaterWrongType = Request '/api/watch-later' 'POST' (@{jobId=$otherQueuedNormal.Id;watchLater='true'} | ConvertTo-Json -Compress)
    Assert ($watchLaterWrongType.Status -eq 400) 'Watch later with a non-boolean watchLater value is rejected'
    $server.Dispose()
    $server = $null

    $watchLaterCreateDirectory = Join-Path $directory 'watch-later-create'
    $server = New-Server $watchLaterCreateDirectory
    $server.BrowserReady = $true
    $createLaterRequest = @{
        videoId='later000001';requestId=[guid]::NewGuid().ToString('D')
        summaryLevel='reg';watchLater=$true
    } | ConvertTo-Json -Compress
    $createLater = Request '/api/jobs' 'POST' $createLaterRequest
    Assert ($createLater.Status -eq 202 -and $createLater.Body.SummaryLevel -ceq 'reg' -and
        $createLater.Body.WatchLater -eq $true -and $createLater.Body.State -ceq 'queued') `
        'Creating a Get later video atomically stores Reg level, queued state and Watch later'
    Assert ($null -eq $server.TakeJob()) `
        'A freshly created Watch-later job is excluded from TakeJob before it can ever dispatch'
    $changeLaterLevel = Request '/api/set-job-level' 'POST' (
        @{jobId=$createLater.Body.Id;summaryLevel='micro'} | ConvertTo-Json -Compress)
    Assert ($changeLaterLevel.Status -eq 200 -and
        $server.GetJob($createLater.Body.Id).SummaryLevel -ceq 'micro' -and
        $server.GetJob($createLater.Body.Id).WatchLater) `
        'A queued Watch-later job can change level afterward without clearing its hold'

    $createNormalRequest = @{
        videoId='normal00001';requestId=[guid]::NewGuid().ToString('D');summaryLevel='reg'
    } | ConvertTo-Json -Compress
    $createNormal = Request '/api/jobs' 'POST' $createNormalRequest
    Assert ($createNormal.Status -eq 202 -and $createNormal.Body.WatchLater -eq $false) `
        'Omitting watchLater preserves the existing false default'
    Assert ($server.TakeJob().Id -ceq $createNormal.Body.Id) `
        'A normally created queued job remains immediately eligible for dispatch'

    $badCreateLaterRequest = @{
        videoId='badlater001';requestId=[guid]::NewGuid().ToString('D')
        summaryLevel='reg';watchLater='true'
    } | ConvertTo-Json -Compress
    Assert ((Request '/api/jobs' 'POST' $badCreateLaterRequest).Status -eq 400) `
        'Job creation rejects a non-boolean watchLater value'
    $server.Dispose()
    $server = $null

    # A full helper restart: a brand new server instance over the same directory. The Watch
    # later flag must round-trip like every other job field, not be silently dropped.
    $server = New-Server $watchLaterDirectory
    Assert ($server.GetJob($activeForLater.Id).WatchLater) 'The Watch later flag on a now-cancelled video survives a helper restart'
    Assert (-not $server.GetJob($queuedForLater.Id).WatchLater) 'An unmarked video stays unmarked across a helper restart'
    $server.Dispose()
    $server = $null

    $setLevelDirectory = Join-Path $directory 'set-job-level'
    $server = New-Server $setLevelDirectory
    $server.BrowserReady = $true
    $queuedForLevel = Add-Job '' 'ultra'
    $levelChanged = Request '/api/set-job-level' 'POST' (@{jobId=$queuedForLevel.Id;summaryLevel='micro'} | ConvertTo-Json -Compress)
    Assert ($levelChanged.Status -eq 200 -and $levelChanged.Body.updated -eq $true) 'Changing the summary level of a queued video succeeds'
    Assert ($server.GetJob($queuedForLevel.Id).SummaryLevel -ceq 'micro') 'The queued video keeps the newly chosen summary level'
    $activeForLevel = Add-Job
    $server.UpdateJob($activeForLevel.Id, 'starting', 'Fixture worker running.')
    $levelActiveRejected = Request '/api/set-job-level' 'POST' (@{jobId=$activeForLevel.Id;summaryLevel='micro'} | ConvertTo-Json -Compress)
    Assert ($levelActiveRejected.Status -eq 409) 'Changing the summary level of an already-started video is rejected, so its checkpoint never mixes settings'
    Assert ($server.GetJob($activeForLevel.Id).SummaryLevel -ceq 'ultra') 'A rejected level change leaves the active video unchanged'
    $server.UpdateJob($activeForLevel.Id, 'completed', 'Fixture finished.')
    $server.SetResultUrl($activeForLevel.Id, 'https://chatgpt.com/c/12345678-1234-1234-1234-123456789abc')
    $levelTerminalChanged = Request '/api/set-job-level' 'POST' (@{jobId=$activeForLevel.Id;summaryLevel='micro'} | ConvertTo-Json -Compress)
    $changedHistoryJob = $server.GetJob($activeForLevel.Id)
    Assert ($levelTerminalChanged.Status -eq 200 -and $changedHistoryJob.SummaryLevel -ceq 'micro') `
        'Changing the summary level of a history video succeeds'
    Assert ($changedHistoryJob.State -ceq 'cancelled' -and -not $changedHistoryJob.ResultUrl -and
        $changedHistoryJob.StageIndex -eq 0 -and $changedHistoryJob.SuccessfulParts -eq 0) `
        'Changing a history level clears incompatible progress and keeps the job stopped for explicit retry'
    $levelMissing = Request '/api/set-job-level' 'POST' (@{jobId=[guid]::NewGuid().ToString('D');summaryLevel='micro'} | ConvertTo-Json -Compress)
    Assert ($levelMissing.Status -eq 409) 'Changing the summary level of an unknown job id is rejected'
    $levelInvalid = Request '/api/set-job-level' 'POST' (@{jobId=$queuedForLevel.Id;summaryLevel='bogus'} | ConvertTo-Json -Compress)
    Assert ($levelInvalid.Status -eq 400) 'An unknown summary level value is rejected'
    $levelBadBody = Request '/api/set-job-level' 'POST' (@{jobId=$queuedForLevel.Id} | ConvertTo-Json -Compress)
    Assert ($levelBadBody.Status -eq 400) 'Changing the level without a summaryLevel field is rejected'
    $levelExtraField = Request '/api/set-job-level' 'POST' (@{jobId=$queuedForLevel.Id;summaryLevel='micro';extra=$true} | ConvertTo-Json -Compress)
    Assert ($levelExtraField.Status -eq 400) 'Changing the level with unexpected extra fields is rejected'
    Assert ($server.GetJob($queuedForLevel.Id).SummaryLevel -ceq 'micro') 'Rejected level-change requests never alter the queued video'
    $server.Dispose()
    $server = $null

    $attachDirectory = Join-Path $directory 'attach-result'
    $server = New-Server $attachDirectory
    $server.BrowserReady = $true
    $ambiguousJob = Add-Job
    $server.UpdateJob($ambiguousJob.Id, 'error', 'Video summary: Ambiguous send automatically resent using the next provider.')
    $attachInvalid = Request '/api/attach-result' 'POST' (@{jobId=$ambiguousJob.Id;resultUrl='https://example.com/c/abc'} | ConvertTo-Json -Compress)
    Assert ($attachInvalid.Status -eq 400) 'Attaching a link outside the supported providers is rejected'
    $attachScript = Request '/api/attach-result' 'POST' (@{jobId=$ambiguousJob.Id;resultUrl='javascript:alert(1)'} | ConvertTo-Json -Compress)
    Assert ($attachScript.Status -eq 400) 'Attaching a script pseudo-URL is rejected'
    $attachExtra = Request '/api/attach-result' 'POST' (@{jobId=$ambiguousJob.Id;resultUrl='https://chatgpt.com/c/abc123';extra=$true} | ConvertTo-Json -Compress)
    Assert ($attachExtra.Status -eq 400) 'Attaching a link with unexpected extra fields is rejected'
    Assert ($server.GetJob($ambiguousJob.Id).State -ceq 'error') 'A rejected attach request leaves the ambiguous video untouched'
    $plainError = Add-Job
    $server.UpdateJob($plainError.Id, 'error', 'Transcript service verification was not completed. Nothing was sent.')
    Assert ($null -eq $server.TakeAmbiguousReconcile()) 'An error job with no ambiguous-send metadata is never queued for the automatic browser sweep'
    $attachPlain = Request '/api/attach-result' 'POST' (@{jobId=$plainError.Id;resultUrl='https://chatgpt.com/c/abc123'} | ConvertTo-Json -Compress)
    Assert ($attachPlain.Status -eq 200 -and $server.GetJob($plainError.Id).State -ceq 'completed') `
        'Any error job with no captured result link can be manually reconciled, regardless of its failure message'
    $withResult = Add-Job
    $server.UpdateJob($withResult.Id, 'error', 'Transcript service verification was not completed. Nothing was sent.')
    $server.SetResultUrl($withResult.Id, 'https://chatgpt.com/c/existing123')
    $attachHasResult = Request '/api/attach-result' 'POST' (@{jobId=$withResult.Id;resultUrl='https://chatgpt.com/c/other456'} | ConvertTo-Json -Compress)
    Assert ($attachHasResult.Status -eq 409) 'A job that already has a captured result link cannot be attached again'
    $completedJob = Add-Job
    $server.UpdateJob($completedJob.Id, 'completed', 'Video summary ready.')
    $attachCompleted = Request '/api/attach-result' 'POST' (@{jobId=$completedJob.Id;resultUrl='https://chatgpt.com/c/completed1'} | ConvertTo-Json -Compress)
    Assert ($attachCompleted.Status -eq 409) 'A completed job cannot be attached'
    $attachMissing = Request '/api/attach-result' 'POST' (@{jobId=[guid]::NewGuid().ToString('D');resultUrl='https://chatgpt.com/c/abc123'} | ConvertTo-Json -Compress)
    Assert ($attachMissing.Status -eq 409) 'Attaching a link to an unknown job id is rejected'
    $attachOk = Request '/api/attach-result' 'POST' (@{jobId=$ambiguousJob.Id;resultUrl='https://chatgpt.com/c/6aabe641'} | ConvertTo-Json -Compress)
    $attached = $server.GetJob($ambiguousJob.Id)
    Assert ($attachOk.Status -eq 200 -and $attached.State -ceq 'completed') 'A valid provider link reconciles the ambiguous send to completed'
    Assert ($attached.ResultUrl -ceq 'https://chatgpt.com/c/6aabe641') 'The attached conversation link is saved on the job'
    Assert ($attached.Message -match 'attached') 'The reconciled job explains that the link was attached locally'
    $attachAgain = Request '/api/attach-result' 'POST' (@{jobId=$ambiguousJob.Id;resultUrl='https://claude.ai/chat/other'} | ConvertTo-Json -Compress)
    Assert ($attachAgain.Status -eq 409) 'An already reconciled video cannot be re-attached to a different conversation'
    $sweepJob = Add-Job
    $server.UpdateJob($sweepJob.Id, 'error', 'Video summary: Ambiguous send automatically resent using the next provider.')
    $server.SetAmbiguousSend($sweepJob.Id, 'tab-a', ('a' * 64))
    $sweepTaken = $server.TakeAmbiguousReconcile()
    Assert ($null -ne $sweepTaken -and $sweepTaken.Id -eq $sweepJob.Id) 'A stranded ambiguous video is queued for the automatic browser sweep'
    Assert ($null -eq $server.TakeAmbiguousReconcile()) 'An in-flight sweep is never handed out twice'
    Assert (-not $server.GetJob($sweepJob.Id).ReconcileAttempted) 'A video waiting for its sweep is not yet marked as attempted'
    $server.CompleteAmbiguousReconcile($sweepJob.Id, $false)
    Assert ($server.GetJob($sweepJob.Id).ReconcileAttempted) 'A sweep that found nothing records the attempt so the dashboard can offer the manual link'
    Assert ($null -eq $server.TakeAmbiguousReconcile()) 'An already swept video is not swept again in a loop'
    Assert-Throws { $server.SetAmbiguousSend($sweepJob.Id, 'tab a', '') } 'An unexpected browser target id is rejected'
    Assert-Throws { $server.SetAmbiguousSend($sweepJob.Id, 'tab-a', 'not-a-hash') } 'An unexpected prompt hash is rejected'
    $busyJob = Add-Job
    $server.UpdateJob($busyJob.Id, 'error', 'Video summary: Ambiguous send automatically resent using the next provider.')
    $server.SetAmbiguousSend($busyJob.Id, 'tab-b', ('b' * 64))
    $null = $server.TakeAmbiguousReconcile()
    $server.CompleteAmbiguousReconcile($busyJob.Id, $false, $true)
    Assert (-not $server.GetJob($busyJob.Id).ReconcileAttempted) 'A conversation that is still generating stays eligible for another sweep'
    $busyAgain = $server.TakeAmbiguousReconcile()
    Assert ($null -ne $busyAgain -and $busyAgain.Id -eq $busyJob.Id) 'A deferred sweep is handed out again on the next pass'
    for ($deferral = 0; $deferral -lt 20; $deferral++) {
        $server.CompleteAmbiguousReconcile($busyJob.Id, $false, $true)
        $null = $server.TakeAmbiguousReconcile()
    }
    Assert ($server.GetJob($busyJob.Id).ReconcileAttempted) 'Deferred sweeps are bounded so a stuck tab cannot be retried forever'
    $autoAttached = $server.AttachJobResult($sweepJob.Id, 'https://claude.ai/chat/recovered', $true)
    Assert ($autoAttached.State -ceq 'completed' -and $autoAttached.Message -match 'Recovered automatically') `
        'An automatic browser recovery marks the video completed with its own explanation'
    $server.Dispose()
    $server = New-Server $attachDirectory
    $reloadedAttached = $server.GetJob($ambiguousJob.Id)
    Assert ($reloadedAttached.State -ceq 'completed' -and $reloadedAttached.ResultUrl -ceq 'https://chatgpt.com/c/6aabe641') `
        'The manually attached result survives a dashboard restart'
    $server.Dispose()
    $server = $null

    $deleteDirectory = Join-Path $directory 'delete-job'
    $server = New-Server $deleteDirectory
    $server.BrowserReady = $true
    $deleteTerminal = Add-Job
    $server.UpdateJob($deleteTerminal.Id, 'completed', 'Done.')
    $deletePath = Join-Path $deleteDirectory ($deleteTerminal.Id + '.json')
    Assert (Test-Path -LiteralPath $deletePath) 'A completed video has a saved job record before it is removed'
    $deleteOk = Request '/api/delete-job' 'POST' (@{jobId=$deleteTerminal.Id} | ConvertTo-Json -Compress)
    Assert ($deleteOk.Status -eq 200 -and $deleteOk.Body.deleted) 'A terminal video can be permanently removed from the list'
    Assert ($null -eq $server.GetJob($deleteTerminal.Id)) 'A removed video is gone from memory'
    Assert (-not (Test-Path -LiteralPath $deletePath)) 'A removed video is gone from disk'
    Assert (@((Request '/api/status' 'GET' '').Body.jobs | Where-Object { $_.Id -eq $deleteTerminal.Id }).Count -eq 0) `
        'A removed video no longer appears in the dashboard status'
    $deleteQueued = Add-Job
    Assert ((Request '/api/delete-job' 'POST' (@{jobId=$deleteQueued.Id} | ConvertTo-Json -Compress)).Status -eq 200) `
        'A video that never started can be removed without stopping it first'
    foreach ($activeState in @('starting','loading','verification','sending','summarizing','combining','paused')) {
        $activeJob = Add-Job
        $server.UpdateJob($activeJob.Id, $activeState, 'Working.')
        $deleteActive = Request '/api/delete-job' 'POST' (@{jobId=$activeJob.Id} | ConvertTo-Json -Compress)
        Assert ($deleteActive.Status -eq 409 -and $null -ne $server.GetJob($activeJob.Id)) `
            "A video in the $activeState state cannot be removed while a worker owns it"
    }
    Assert ((Request '/api/delete-job' 'POST' (@{jobId=[guid]::NewGuid().ToString('D')} | ConvertTo-Json -Compress)).Status -eq 409) `
        'Removing an unknown job id is rejected'
    Assert ((Request '/api/delete-job' 'POST' '{"jobId":"not-a-guid"}').Status -eq 400) 'Removing a malformed job id is rejected'
    Assert ((Request '/api/delete-job' 'POST' (@{jobId=$deleteQueued.Id;extra=$true} | ConvertTo-Json -Compress)).Status -eq 400) `
        'Removing a video with unexpected extra fields is rejected'
    $server.Dispose()
    $server = $null

    $cancelledDirectory = Join-Path $directory 'clear-cancelled'
    $server = New-Server $cancelledDirectory
    $server.BrowserReady = $true
    $retired = @{}
    foreach ($state in @('cancelled','reviewed')) {
        $retiredJob = Add-Job
        $server.UpdateJob($retiredJob.Id, $state, 'Retired.')
        $retired[$state] = $retiredJob
    }
    $keptError = Add-Job
    $server.UpdateJob($keptError.Id, 'error', 'Failed.')
    $keptCompleted = Add-Job
    $server.UpdateJob($keptCompleted.Id, 'completed', 'Done.')
    $keptActive = Add-Job
    $server.UpdateJob($keptActive.Id, 'summarizing', 'Working.')
    $keptQueued = Add-Job
    $clearCancelled = Request '/api/clear-cancelled'
    Assert ($clearCancelled.Status -eq 200 -and $clearCancelled.Body.cleared -eq 2) 'Bulk cleanup reports every removed cancelled/reviewed job'
    Assert ($null -eq $server.GetJob($retired['cancelled'].Id) -and $null -eq $server.GetJob($retired['reviewed'].Id)) `
        'Bulk cleanup removes cancelled and reviewed jobs from memory'
    Assert (-not (Test-Path -LiteralPath (Join-Path $cancelledDirectory ($retired['cancelled'].Id + '.json')))) `
        'Bulk cleanup removes retired progress from disk'
    Assert ($server.GetJob($keptError.Id).State -ceq 'error' -and $server.GetJob($keptCompleted.Id).State -ceq 'completed' -and
        $server.GetJob($keptActive.Id).State -ceq 'summarizing' -and $server.GetJob($keptQueued.Id).State -ceq 'queued') `
        'Bulk cleanup never touches failed, completed, active or queued videos'
    Assert ((Request '/api/clear-cancelled').Body.cleared -eq 0) 'Bulk cleanup is safe to repeat when nothing is left to retire'
    Assert ((Request '/api/clear-cancelled' 'POST' '{"all":true}').Status -eq 400) 'Bulk cancelled cleanup rejects unexpected fields'
    $server.Dispose()
    $server = $null

    # The user's exact report: a removed video came back after restarting the helper. The
    # pending-send journal lives outside the job state directory and is replayed on startup,
    # so a removal that leaves it behind silently recreates the job.
    $restartDeleteDirectory = Join-Path $directory 'delete-survives-restart'
    $restartJournalDirectory = Join-Path $directory 'delete-survives-restart-journal'
    $null = New-Item -ItemType Directory -Path $restartJournalDirectory -Force
    $server = New-Server $restartDeleteDirectory
    $server.PendingSendDirectory = $restartJournalDirectory
    $server.BrowserReady = $true
    $restartDeleted = Add-Job
    $server.UpdateJob($restartDeleted.Id, 'error', 'Final combined summary: Too many requests.')
    $server.SetFinalResult($restartDeleted.Id, 'Saved full transcript result.')
    $restartKept = Add-Job
    $server.UpdateJob($restartKept.Id, 'error', 'A different failure that is not removed.')
    $restartJournal = Join-Path $restartJournalDirectory ($restartDeleted.Id + '.json')
    $keptJournal = Join-Path $restartJournalDirectory ($restartKept.Id + '.json')
    foreach ($entry in @(@{Path=$restartJournal;Job=$restartDeleted}, @{Path=$keptJournal;Job=$restartKept})) {
        [IO.File]::WriteAllText($entry.Path,
            (@{requestId=$entry.Job.RequestId;videoId=$entry.Job.VideoId} | ConvertTo-Json -Compress))
    }
    Assert ((Request '/api/delete-job' 'POST' (@{jobId=$restartDeleted.Id} | ConvertTo-Json -Compress)).Status -eq 200) `
        'A failed video with an unfinished send journal can be removed'
    Assert (-not (Test-Path -LiteralPath (Join-Path $restartDeleteDirectory ($restartDeleted.Id + '.json')))) `
        'Removing a video deletes its saved job record'
    Assert (-not (Test-Path -LiteralPath (Join-Path $restartDeleteDirectory ($restartDeleted.Id + '.result.txt')))) `
        'Removing a video deletes its saved full transcript result'
    Assert (-not (Test-Path -LiteralPath $restartJournal)) `
        'Removing a video also deletes its pending-send journal so a restart cannot replay it'
    Assert (Test-Path -LiteralPath $keptJournal) 'Removing one video never touches another video pending-send journal'
    $server.Dispose()
    $server = $null
    # A full helper restart: a brand new server instance over the same directories, replaying
    # every leftover journal exactly as Start-YtSummary.ps1 does.
    $server = New-Server $restartDeleteDirectory
    $server.PendingSendDirectory = $restartJournalDirectory
    foreach ($file in @(Get-ChildItem -LiteralPath $restartJournalDirectory -Filter '*.json' -File)) {
        $record = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
        $null = $server.RestorePendingSend([Guid]::ParseExact($file.BaseName, 'D').ToString('D'), $record.requestId, $record.videoId)
    }
    Assert ($null -eq $server.GetJob($restartDeleted.Id)) 'A removed video does not come back after the helper restarts'
    Assert (@((Request '/api/status' 'GET' '').Body.jobs | Where-Object { $_.Id -eq $restartDeleted.Id }).Count -eq 0) `
        'A removed video never reappears in the dashboard after a restart'
    Assert ($null -ne $server.GetJob($restartKept.Id)) 'An unrelated video with its own journal still survives the restart'
    $server.Dispose()
    $server = $null

    # Bulk removal has exactly the same restart hazard.
    $bulkJournalDirectory = Join-Path $directory 'bulk-clear-journal'
    $bulkDirectory = Join-Path $directory 'bulk-clear'
    $null = New-Item -ItemType Directory -Path $bulkJournalDirectory -Force
    $server = New-Server $bulkDirectory
    $server.PendingSendDirectory = $bulkJournalDirectory
    $server.BrowserReady = $true
    $bulkCancelled = Add-Job
    $server.UpdateJob($bulkCancelled.Id, 'cancelled', 'Stopped.')
    $bulkFailed = Add-Job
    $server.UpdateJob($bulkFailed.Id, 'error', 'Failed.')
    foreach ($bulkJob in @($bulkCancelled, $bulkFailed)) {
        [IO.File]::WriteAllText((Join-Path $bulkJournalDirectory ($bulkJob.Id + '.json')),
            (@{requestId=$bulkJob.RequestId;videoId=$bulkJob.VideoId} | ConvertTo-Json -Compress))
    }
    Assert ((Request '/api/clear-cancelled').Body.cleared -eq 1) 'Bulk cancelled cleanup removes the retired video'
    Assert (-not (Test-Path -LiteralPath (Join-Path $bulkJournalDirectory ($bulkCancelled.Id + '.json')))) `
        'Bulk cancelled cleanup also removes the pending-send journal'
    Assert ((Request '/api/clear-errors').Body.cleared -eq 1) 'Bulk failed cleanup removes the failed video'
    Assert (-not (Test-Path -LiteralPath (Join-Path $bulkJournalDirectory ($bulkFailed.Id + '.json')))) `
        'Bulk failed cleanup also removes the pending-send journal'
    $server.Dispose()
    $server = $null

    $restartPauseDirectory = Join-Path $directory 'restart-auto-pause'
    $server = New-Server $restartPauseDirectory
    $server.BrowserReady = $true
    Assert (-not $server.DispatchPaused) 'A fresh state directory with no jobs never auto-pauses'
    $restartQueued = Add-Job
    $server.Dispose()
    $server = New-Server $restartPauseDirectory
    Assert ($server.DispatchPaused -and $server.PauseReason -match 'restarted') 'Restarting with an already-queued video auto-pauses dispatch instead of firing it'
    Assert ($null -eq $server.TakeJob()) 'Nothing dispatches automatically after a restart until the user clicks Resume'
    $server.BrowserReady = $true
    $resumeAfterRestart = Request '/api/resume' 'POST' '{}'
    Assert ($resumeAfterRestart.Status -eq 200 -and -not $server.DispatchPaused) 'An explicit Resume click unblocks dispatch after a restart'
    Assert ($server.TakeJob().Id -ceq $restartQueued.Id) 'The previously-queued video only starts after the user clicks Resume'
    $server.Dispose()
    $server = $null

    # The restart hold exists only so nothing runs unattended. Adding or retrying a video is an
    # explicit request to work, so it must release that hold instead of silently going nowhere.
    $holdDirectory = Join-Path $directory 'restart-hold-clears'
    $server = New-Server $holdDirectory
    $server.BrowserReady = $true
    $holdQueued = Add-Job
    $server.Dispose()
    $server = New-Server $holdDirectory
    $server.BrowserReady = $true
    Assert ($server.DispatchPaused -and $server.PauseKind -eq 'restart') 'The automatic restart hold is recorded as a restart, not a usage limit'
    $holdSaved = Get-Content -LiteralPath (Join-Path $holdDirectory 'scheduler.state') -Raw | ConvertFrom-Json
    Assert ($holdSaved.pauseKind -eq 'restart') 'The pause kind is persisted with the pause'
    Assert ((Request '/api/status' 'GET' '').Body.pauseKind -eq 'restart') 'Status exposes the pause kind so the dashboard can explain it'
    $holdAdded = Add-Job
    Assert (-not $server.DispatchPaused -and $server.PauseKind -eq '') 'Adding a video releases the automatic restart hold'
    Assert ($server.TakeJob().Id -ceq $holdQueued.Id) 'Releasing the restart hold lets the older queued video run too'
    $server.UpdateJob($holdAdded.Id, 'error', 'Fixture failed before retry.')
    $server.PauseForUsageLimit('Fixture usage limit.')
    $null = Add-Job
    Assert ($server.DispatchPaused -and $server.PauseKind -eq 'usage') 'Adding a video never overrides a real usage-limit pause'
    $null = $server.RetryJob($holdAdded.Id)
    Assert ($server.DispatchPaused -and $server.PauseKind -eq 'usage') 'Retrying a video never overrides a real usage-limit pause'
    $server.ResumeDispatch()
    Assert (-not $server.DispatchPaused -and $server.PauseKind -eq '') 'Resume clears the pause kind as well'
    $server.Dispose()
    $server = $null

    # A scheduler.state written before pause kinds existed can only be a usage pause, and
    # usage pauses are no longer honoured, so it must load released rather than strand the queue.
    $legacyPauseDirectory = Join-Path $directory 'legacy-pause-kind'
    $null = New-Item -ItemType Directory -Path $legacyPauseDirectory
    [IO.File]::WriteAllText((Join-Path $legacyPauseDirectory 'scheduler.state'),
        '{"paused":true,"pauseReason":"Legacy quota pause."}')
    $server = New-Server $legacyPauseDirectory
    Assert (-not $server.DispatchPaused -and $server.PauseKind -eq '' -and $server.PauseReason -eq '') 'A legacy two-field usage pause no longer strands the queue on load'
    $server.Dispose()
    $server = $null

    $staleUsageDirectory = Join-Path $directory 'stale-usage-pause'
    $null = New-Item -ItemType Directory -Path $staleUsageDirectory
    [IO.File]::WriteAllText((Join-Path $staleUsageDirectory 'scheduler.state'),
        '{"paused":true,"pauseReason":"Old quota pause.","pauseKind":"usage"}')
    $server = New-Server $staleUsageDirectory
    Assert (-not $server.DispatchPaused -and $server.PauseKind -eq '') 'A usage pause saved by an older build is dropped on load'
    $server.Dispose()
    $server = $null

    $restartPauseDirectory = Join-Path $directory 'restart-pause-kind'
    $null = New-Item -ItemType Directory -Path $restartPauseDirectory
    [IO.File]::WriteAllText((Join-Path $restartPauseDirectory 'scheduler.state'),
        '{"paused":true,"pauseReason":"Waiting for you to start them.","pauseKind":"restart"}')
    $server = New-Server $restartPauseDirectory
    Assert ($server.DispatchPaused -and $server.PauseKind -eq 'restart') 'A restart hold still survives a reload'
    $server.Dispose()
    $server = $null

    $noAutoPauseDirectory = Join-Path $directory 'restart-no-queue'
    $server = New-Server $noAutoPauseDirectory
    $server.BrowserReady = $true
    $noAutoPauseJob = Add-Job
    $server.UpdateJob($noAutoPauseJob.Id, 'completed', 'Fixture finished before restart.')
    $server.Dispose()
    $server = New-Server $noAutoPauseDirectory
    Assert (-not $server.DispatchPaused) 'Restarting with only terminal jobs never auto-pauses dispatch'
    $server.Dispose()
    $server = $null

    $badSettingsDirectory = Join-Path $directory 'invalid-settings'
    $null = New-Item -ItemType Directory -Path $badSettingsDirectory
    $badSettingsPath = Join-Path $badSettingsDirectory 'settings.state'
    foreach ($body in @('', 'not json', '{}', 'null', '[]', '{"summaryLevel":null}', '{"summaryLevel":1}',
        '{"summaryLevel":"legacy"}', '{"summaryLevel":"Ultra"}', '{"summaryLevel":"other"}',
        '{"summaryLevel":"max","extra":true}', '{"summaryLevel":"ultra","summaryLevel":"micro"}',
        '{"summaryLevel":"max","enabledProviders":[]}', '{"summaryLevel":"max","enabledProviders":["UnknownProvider"]}')) {
        [IO.File]::WriteAllText($badSettingsPath, $body)
        Assert-Throws { $badServer = New-Server $badSettingsDirectory; $badServer.Dispose() } 'Malformed saved summary settings fail clearly on startup' 'Invalid saved settings\.state'
        Assert ([IO.File]::ReadAllText($badSettingsPath) -ceq $body) 'Invalid saved settings are never silently replaced'
    }
    Remove-Item -LiteralPath $badSettingsPath
    $null = New-Item -ItemType Directory -Path $badSettingsPath
    Assert-Throws { $badServer = New-Server $badSettingsDirectory; $badServer.Dispose() } 'A settings path that is a directory fails clearly' 'Invalid saved settings\.state'
    Remove-Item -LiteralPath $badSettingsPath

    $legacyDirectory = Join-Path $directory 'legacy-levels'
    $null = New-Item -ItemType Directory -Path $legacyDirectory
    [IO.File]::WriteAllText((Join-Path $legacyDirectory 'settings.state'), '{"summaryLevel":"min"}')
    $legacyRecords = @{}
    $legacyContents = @{}
    foreach ($state in @('queued','sending','summarizing','completed','submitted')) {
        $script:videoNumber++
        $id = [guid]::NewGuid().ToString('D')
        $record = @{Id=$id;RequestId=[guid]::NewGuid().ToString('D');VideoId=('vid' + $script:videoNumber.ToString('D8'));
            State=$state;Message='Fixture pre-level job.';Sequence=$script:videoNumber;
            CreatedAt=[DateTime]::UtcNow.AddDays(-1);UpdatedAt=[DateTime]::UtcNow.AddDays(-1)}
        $legacyRecords[$state] = $record
        $legacyContents[$state] = $record | ConvertTo-Json -Compress
        [IO.File]::WriteAllText((Join-Path $legacyDirectory ($id + '.json')), $legacyContents[$state])
    }
    $server = New-Server $legacyDirectory
    Assert ($server.DispatchPaused -and $server.PauseKind -eq 'restart') 'Loading a directory with an already-queued legacy job auto-pauses dispatch'
    foreach ($state in $legacyRecords.Keys) {
        Assert ($server.GetJob($legacyRecords[$state].Id).SummaryLevel -ceq 'legacy') 'Saved jobs without a level retain legacy intent rather than taking the default'
    }
    foreach ($state in @('queued','completed','submitted')) {
        Assert ([IO.File]::ReadAllText((Join-Path $legacyDirectory ($legacyRecords[$state].Id + '.json'))) -ceq $legacyContents[$state]) 'Migration alone never rewrites queued or completed historical records'
    }
    foreach ($state in @('sending','summarizing')) {
        $job = $server.GetJob($legacyRecords[$state].Id)
        $savedJob = Get-Content -LiteralPath (Join-Path $legacyDirectory ($job.Id + '.json')) -Raw | ConvertFrom-Json
        Assert ($job.State -eq 'error' -and $savedJob.SummaryLevel -ceq 'legacy') 'Interrupted historical work becomes retryable while retaining legacy intent'
    }
    $restored = $server.RestorePendingSend([guid]::NewGuid().ToString('D'), [guid]::NewGuid().ToString('D'), 'restore0001')
    Assert ($restored.SummaryLevel -ceq 'legacy' -and $restored.State -eq 'error') 'Restoring a missing historical pending-send job assigns retryable legacy state'
    $legacyRetry = Request '/api/jobs' 'POST' (@{videoId=$restored.VideoId;requestId=$restored.RequestId} | ConvertTo-Json -Compress)
    Assert ($legacyRetry.Status -eq 200 -and $legacyRetry.Body.Id -eq $restored.Id -and $legacyRetry.Body.SummaryLevel -ceq 'legacy') 'An unchanged historical request remains idempotent'
    $legacyConflict = Request '/api/jobs' 'POST' (@{videoId=$restored.VideoId;requestId=$restored.RequestId;summaryLevel='min'} | ConvertTo-Json -Compress)
    Assert ($legacyConflict.Status -eq 409) 'An explicit new level cannot mutate a historical request'
    $legacyBlocked = Request '/api/jobs' 'POST' (@{videoId=$restored.VideoId;requestId=[guid]::NewGuid().ToString('D');summaryLevel='micro'} | ConvertTo-Json -Compress)
    Assert ($legacyBlocked.Status -eq 202) 'Historical ambiguous records allow automatic resend at a new level'
    $legacyQueued = $server.GetJob($legacyRecords.queued.Id)
    $newIntent = Add-Job $legacyQueued.VideoId
    Assert ($newIntent.SummaryLevel -ceq 'min' -and $newIntent.Id -ne $legacyQueued.Id) 'A current explicit intent is not silently deduplicated to queued legacy work'
    $server.BrowserReady = $true
    Assert (-not $server.DispatchPaused) 'Explicitly adding a video during the restart hold releases it for the legacy queue too'
    Assert ($server.TakeJob().Id -eq $legacyQueued.Id -and $legacyQueued.SummaryLevel -ceq 'legacy') 'Dispatch preserves legacy queued intent once the user resumes'
    $server.UpdateJob($legacyQueued.Id, 'completed', 'Fixture legacy processing finished.')
    $server.Dispose()
    $server = New-Server $legacyDirectory
    Assert ($server.GetJob($restored.Id).SummaryLevel -ceq 'legacy' -and $server.GetJob($legacyQueued.Id).SummaryLevel -ceq 'legacy') 'Explicitly persisted legacy levels remain valid on subsequent reload'
    $server.Dispose()
    $server = $null

    $badLevelDirectory = Join-Path $directory 'invalid-levels'
    $null = New-Item -ItemType Directory -Path $badLevelDirectory
    $badRecord = $legacyRecords.completed.Clone()
    $badLevelPath = Join-Path $badLevelDirectory ($badRecord.Id + '.json')
    foreach ($level in @('unknown','Ultra','MAX','reg ','legacy ',1)) {
        $badRecord.SummaryLevel = $level
        [IO.File]::WriteAllText($badLevelPath, ($badRecord | ConvertTo-Json -Compress))
        Assert-Throws { $badServer = New-Server $badLevelDirectory; $badServer.Dispose() } 'Unknown nonempty saved job levels fail clearly' 'Invalid saved job'
    }
    foreach ($level in @($null, '')) {
        $badRecord.SummaryLevel = $level
        [IO.File]::WriteAllText($badLevelPath, ($badRecord | ConvertTo-Json -Compress))
        $server = New-Server $badLevelDirectory
        Assert ($server.GetJob($badRecord.Id).SummaryLevel -ceq 'legacy') 'Null or empty historical levels migrate in memory to legacy'
        $server.Dispose()
        $server = $null
    }

    $server = New-Server $directory
    $server.BrowserReady = $true
    $active = Add-Job
    $queued = Add-Job
    Assert ($server.TakeJob().Id -eq $active.Id) 'First video dispatches'
    $server.UpdateJob($active.Id, 'summarizing', 'Fixture chunk 1 of 2.')
    $server.PauseForUsageLimit('Fixture account quota reached; wait for reset.')
    Assert ($server.DispatchPaused -and $null -eq $server.TakeJob()) 'Pause blocks new dispatch'
    Assert ($server.GetJob($active.Id).State -eq 'summarizing') 'Pause does not cancel an existing worker'
    $extra = Add-Job
    Assert ($server.GetJob($extra.Id).State -eq 'queued') 'Other videos may join the paused queue'
    $activePath = Join-Path $directory ($active.Id + '.json')
    foreach ($path in @($activePath, ($activePath + '.tmp'))) {
        if (-not (Test-Path -LiteralPath $path)) { [IO.File]::WriteAllText($path, 'Fixture stale temporary data.') }
        $temporaryLock = New-Object YtTemporaryFileLock -ArgumentList $path
        try { $server.UpdateJob($active.Id, 'combining', 'Fixture recovered after locking ' + [IO.Path]::GetFileName($path)) }
        finally { $temporaryLock.Dispose() }
        $savedJob = Get-Content -LiteralPath $activePath -Raw | ConvertFrom-Json
        Assert ($savedJob.State -eq 'combining' -and $savedJob.Message -eq $server.GetJob($active.Id).Message) 'A transient destination or temporary-file lock is retried until the stage is saved'
        Assert (-not (Test-Path -LiteralPath ($activePath + '.tmp'))) 'Successful lock recovery leaves no temporary status file'
    }
    $server.UpdateJob($active.Id, 'paused', 'Fixture waiting without composer lock.')
    $status = (Request '/api/status' 'GET' '').Body
    Assert ($status.paused -and $status.pauseReason -eq $server.PauseReason -and $status.pausedWorkers -eq 1) 'Status exposes global and worker pause'
    Assert ($status.active -eq 1 -and $status.queued -eq 2 -and $status.ready -and $status.jobs.Count -eq 3 -and $status.job.Id -eq $extra.Id) 'Legacy status fields are retained'
    $schedulerPath = Join-Path $directory 'scheduler.state'
    $temporaryLock = New-Object YtTemporaryFileLock -ArgumentList $schedulerPath
    try { $server.PauseForUsageLimit('Fixture quota state saved after a brief lock.') }
    finally { $temporaryLock.Dispose() }
    $saved = Get-Content -LiteralPath $schedulerPath -Raw | ConvertFrom-Json
    Assert ($saved.paused -and $saved.pauseReason -eq $server.PauseReason) 'Quota pause is durably saved separately'
    Assert (@(Get-ChildItem -LiteralPath $directory -Filter '*.json').Count -eq 3) 'Scheduler is not a job JSON file'

    foreach ($case in @(
        @{Headers=@{'X-YT-Token'=$null};Code=403},
        @{Headers=@{'X-YT-Token'=('a' * 64)};Code=403},
        @{Headers=@{Origin=$null};Code=403},
        @{Headers=@{Origin='https://example.invalid'};Code=403},
        @{Headers=@{Host='localhost:' + $server.Port};Code=421},
        @{Headers=@{'Sec-Fetch-Site'='cross-site'};Code=403},
        @{Headers=@{'Content-Type'='text/plain'};Code=403}
    )) {
        $requestBody = if ($case.Headers.ContainsKey('Host')) { '' } else { '{}' }
        Assert ((Request '/api/resume' 'POST' $requestBody $case.Headers).Status -eq $case.Code) 'Resume enforces existing request authorization'
        Assert $server.DispatchPaused 'Unauthorized resume never changes pause'
    }
    foreach ($body in @('', '[]', 'null', '{"resume":true}', '{ }', '{} ', "{}`n", '{"x":1,"x":2}')) {
        Assert ((Request '/api/resume' 'POST' $body).Status -eq 400) 'Resume requires the exact empty-object body'
        Assert $server.DispatchPaused 'Invalid resume body never changes pause'
    }
    Assert ((Request '/api/resume' 'GET' '').Status -eq 404) 'Resume is POST-only'

    $lock = [IO.File]::Open($schedulerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        Assert ((Request '/api/resume').Status -eq 503) 'Failed resume persistence returns an explicit error'
        Assert ($server.DispatchPaused -and $server.IsRunning) 'Failed resume preserves pause and the server'
    } finally { $lock.Dispose() }
    $resume = Request '/api/resume'
    $saved = Get-Content -LiteralPath $schedulerPath -Raw | ConvertFrom-Json
    Assert ($resume.Status -eq 200 -and -not $resume.Body.paused -and -not $saved.paused -and -not $server.DispatchPaused) 'Authenticated resume persists before success'
    Assert ($server.GetJob($active.Id).State -eq 'paused' -and $server.GetJob($queued.Id).State -eq 'queued') 'Resume does not restart or rewrite any worker'
    Assert ($server.TakeJob().Id -eq $queued.Id) 'Resume permits retained queued dispatch'
    $lock = [IO.File]::Open($schedulerPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        Assert-Throws { $server.PauseForUsageLimit('Unable to persist this fixture pause.') } 'Failed pause persistence is surfaced'
        Assert (-not $server.DispatchPaused -and $server.PauseReason -eq '') 'Failed pause leaves previous memory state intact'
    } finally { $lock.Dispose() }

    $url = 'https://chatgpt.com/c/fixture-final_123'
    $lockedJob = $server.GetJob($queued.Id)
    $jobPath = Join-Path $directory ($queued.Id + '.json')
    $savedBeforeLock = [IO.File]::ReadAllText($jobPath)
    $previousUpdatedAt = $lockedJob.UpdatedAt
    $lock = [IO.File]::Open((Join-Path $directory ($queued.Id + '.json')), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        Assert-Throws { $server.SetResultUrl($queued.Id, $url) } 'Failed result persistence is surfaced'
        Assert ([string]::IsNullOrEmpty($lockedJob.ResultUrl) -and $lockedJob.UpdatedAt -eq $previousUpdatedAt) 'Unpersisted result metadata is rolled back'
        Assert-Throws { $server.UpdateJob($queued.Id, 'completed', 'Must not appear completed without persistence.') } 'Failed completion persistence is surfaced'
        Assert ($lockedJob.State -eq 'starting' -and $lockedJob.UpdatedAt -eq $previousUpdatedAt) 'Unpersisted completion state is rolled back'
    } finally { $lock.Dispose() }
    Assert ([IO.File]::ReadAllText($jobPath) -ceq $savedBeforeLock) 'A persistent file lock never deletes or corrupts the last saved job'
    $temporaryLock = New-Object YtTemporaryFileLock -ArgumentList $jobPath
    try { $server.SetResultUrl($queued.Id, $url) }
    finally { $temporaryLock.Dispose() }
    $savedResult = Get-Content -LiteralPath $jobPath -Raw | ConvertFrom-Json
    Assert ($savedResult.ResultUrl -eq $url) 'The final result link survives a transient Windows file lock'
    $server.UpdateJob($queued.Id, 'completed', 'Fixture final assistant reply finished.')
    Assert ($server.GetJob($queued.Id).ResultUrl -eq $url) 'Final conversation URL is exposed on its job'
    Assert ([string]::IsNullOrEmpty($server.GetJob($active.Id).ResultUrl)) 'Result links are isolated by job'
    foreach ($providerUrl in @('https://gemini.google.com/app/gemini-summary_123', 'https://claude.ai/chat/claude-summary_123')) {
        $server.SetResultUrl($queued.Id, $providerUrl)
        Assert ($server.GetJob($queued.Id).ResultUrl -ceq $providerUrl) 'Canonical Gemini and Claude result links are accepted'
    }
    $server.SetResultUrl($queued.Id, $url)
    foreach ($bad in @('', 'https://chatgpt.com/c/', 'http://chatgpt.com/c/id', '//chatgpt.com/c/id',
        '/c/id', 'https://other.invalid/c/id', 'https://chatgpt.com.evil.invalid/c/id',
        'https://user@chatgpt.com/c/id', 'https://chatgpt.com:443/c/id', 'https://chatgpt.com:8443/c/id',
        'https://chatgpt.com/c/id?x=1', 'https://chatgpt.com/c/id#x', 'https://chatgpt.com/c/../id',
        'https://chatgpt.com/c/id/other', 'https://chatgpt.com/c/%0aid', "https://chatgpt.com/c/id`n", 'javascript:alert(1)')) {
        Assert-Throws { $server.SetResultUrl($queued.Id, $bad) } 'Noncanonical or unsafe result URLs are rejected'
        Assert ($server.GetJob($queued.Id).ResultUrl -eq $url) 'Rejected URLs never overwrite the result'
    }
    Assert-Throws { $server.SetResultUrl([guid]::NewGuid().ToString('D'), $url) } 'Unknown result job is rejected'

    $partUrl1 = 'https://chatgpt.com/c/part-one_123'
    $partUrl2 = 'https://gemini.google.com/app/part-two_123'
    Assert (@($server.GetJob($queued.Id).PartResultUrls).Count -eq 0) 'A job starts with no recorded part links'
    $server.AddPartResultUrl($queued.Id, $partUrl1)
    $server.AddPartResultUrl($queued.Id, $partUrl2)
    Assert ((@($server.GetJob($queued.Id).PartResultUrls) -join ',') -ceq "$partUrl1,$partUrl2") 'Part result links accumulate in call order'
    $server.AddPartResultUrl($queued.Id, $partUrl1)
    Assert (@($server.GetJob($queued.Id).PartResultUrls).Count -eq 2) 'Adding the exact same part link twice is not duplicated'
    Assert-Throws { $server.AddPartResultUrl($queued.Id, 'https://other.invalid/c/id') } 'Noncanonical or unsafe part result links are rejected'
    Assert-Throws { $server.AddPartResultUrl([guid]::NewGuid().ToString('D'), $partUrl1) } 'Unknown part-result job is rejected'
    $partsJobPath = Join-Path $directory ($queued.Id + '.json')
    $savedBeforePartLock = [IO.File]::ReadAllText($partsJobPath)
    $partLock = [IO.File]::Open($partsJobPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        Assert-Throws { $server.AddPartResultUrl($queued.Id, 'https://claude.ai/chat/part-three_123') } 'Failed part-result persistence is surfaced'
        Assert (@($server.GetJob($queued.Id).PartResultUrls).Count -eq 2) 'Unpersisted part link is rolled back'
    } finally { $partLock.Dispose() }
    Assert ([IO.File]::ReadAllText($partsJobPath) -ceq $savedBeforePartLock) 'A persistent file lock never corrupts the last saved job when adding a part link'
    $resetScratch = Add-Job
    $server.AddPartResultUrl($resetScratch.Id, $partUrl1)
    $server.AddPartResultUrl($resetScratch.Id, $partUrl2)
    Assert (@($server.GetJob($resetScratch.Id).PartResultUrls).Count -eq 2) 'Scratch job accumulates part links before its reset is tested'
    $server.UpdateJob($resetScratch.Id, 'completed', 'Fixture completed for level-reset test.')
    $server.SetJobSummaryLevel($resetScratch.Id, 'min')
    Assert (@($server.GetJob($resetScratch.Id).PartResultUrls).Count -eq 0) 'Changing summary level clears previously recorded part links along with the rest of the checkpoint'
    $server.AddPartResultUrl($resetScratch.Id, $partUrl1)
    $server.ClearJobProgress($resetScratch.Id)
    Assert (@($server.GetJob($resetScratch.Id).PartResultUrls).Count -eq 0) 'Clearing local progress clears previously recorded part links'

    $rotateScratch = Add-Job
    $server.AddPartResultUrl($rotateScratch.Id, $partUrl1)
    $server.AddPartResultUrl($rotateScratch.Id, $partUrl2)
    Assert (@($server.GetJob($rotateScratch.Id).PartResultUrls).Count -eq 2) 'Scratch job accumulates part links before a fresh-run reset is tested'
    $server.ClearJobPartResultUrls($rotateScratch.Id)
    Assert (@($server.GetJob($rotateScratch.Id).PartResultUrls).Count -eq 0) 'A fresh-run reset clears every previously recorded part link'
    $server.ClearJobPartResultUrls($rotateScratch.Id)
    Assert (@($server.GetJob($rotateScratch.Id).PartResultUrls).Count -eq 0) 'A fresh-run reset on an already-empty list is a harmless no-op'
    Assert-Throws { $server.ClearJobPartResultUrls([guid]::NewGuid().ToString('D')) } 'A fresh-run reset for an unknown job is rejected'
    $server.AddPartResultUrl($rotateScratch.Id, $partUrl1)
    $rotatePartsJobPath = Join-Path $directory ($rotateScratch.Id + '.json')
    $savedBeforeRotateLock = [IO.File]::ReadAllText($rotatePartsJobPath)
    $rotateLock = [IO.File]::Open($rotatePartsJobPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::None)
    try {
        Assert-Throws { $server.ClearJobPartResultUrls($rotateScratch.Id) } 'Failed fresh-run reset persistence is surfaced'
        Assert (@($server.GetJob($rotateScratch.Id).PartResultUrls).Count -eq 1) 'Unpersisted fresh-run reset is rolled back'
    } finally { $rotateLock.Dispose() }
    Assert ([IO.File]::ReadAllText($rotatePartsJobPath) -ceq $savedBeforeRotateLock) 'A persistent file lock never corrupts the last saved job when resetting part links'

    $duplicate = Request '/api/jobs' 'POST' (@{videoId=$queued.VideoId;requestId=[guid]::NewGuid().ToString('D')} | ConvertTo-Json -Compress)
    Assert ($duplicate.Status -eq 200 -and $duplicate.Body.Id -eq $queued.Id) 'Completed videos reuse the existing matching summary'
    $server.GetJob($queued.Id).UpdatedAt = [DateTime]::UtcNow.AddDays(-30)
    $oldDuplicate = Request '/api/jobs' 'POST' (@{videoId=$queued.VideoId;requestId=[guid]::NewGuid().ToString('D')} | ConvertTo-Json -Compress)
    Assert ($oldDuplicate.Status -eq 200 -and $oldDuplicate.Body.Id -eq $queued.Id) 'Old completed summaries remain deduplicated without a time cutoff'
    $null = Request '/api/settings' 'POST' '{"summaryLanguage":"english"}'
    $differentLanguage = Request '/api/jobs' 'POST' (@{videoId=$queued.VideoId;requestId=[guid]::NewGuid().ToString('D')} | ConvertTo-Json -Compress)
    Assert ($differentLanguage.Status -eq 200 -and $differentLanguage.Body.Id -eq $queued.Id) 'Legacy language settings cannot bypass Hebrew duplicate protection'
    $null = Request '/api/settings' 'POST' '{"summaryLanguage":"hebrew"}'

    $staged = @{}
    foreach ($state in @('splitting','summarizing','combining','paused','submitted')) {
        $job = Add-Job
        $server.UpdateJob($job.Id, $state, "Fixture $state.")
        $staged[$state] = $job
        $diskJob = Get-Content -LiteralPath (Join-Path $directory ($job.Id + '.json')) -Raw | ConvertFrom-Json
        Assert ($diskJob.State -eq $state) "State $state is persisted"
    }
    $server.PauseForUsageLimit('Fixture pause survives restart.')
    $server.Dispose()
    $server = New-Server $directory
    $server.BrowserReady = $true
    Assert ($server.PauseKind -ne 'usage' -and $null -eq $server.TakeJob()) 'A stale usage pause is dropped, and the restart hold still withholds queued work'
    Assert ($server.GetJob($extra.Id).State -eq 'queued') 'Untouched queued video survives restart'
    Assert ($server.GetJob($queued.Id).State -eq 'completed' -and $server.GetJob($queued.Id).ResultUrl -eq $url) 'Completed job and its result survive restart'
    Assert ($server.GetJob($staged.submitted.Id).State -eq 'submitted') 'Legacy submitted jobs remain terminal'
    Assert ($server.GetJob($staged.splitting.Id).State -eq 'cancelled') 'Interrupted preparation is not silently replayed'
    foreach ($state in @('summarizing','combining','paused')) {
        Assert ($server.GetJob($staged[$state].Id).State -eq 'error') "Interrupted $state work becomes retryable"
    }
    $reviewId = $staged.summarizing.Id
    Assert ((Request '/api/acknowledge').Status -eq 409) 'No manual acknowledgement is available for retryable jobs'
    Assert ((Request '/api/acknowledge' 'POST' (@{jobId=$reviewId} | ConvertTo-Json -Compress)).Status -eq 409) 'Retryable jobs do not require manual acknowledgement'
    Assert ($server.GetJob($reviewId).State -eq 'error' -and $server.GetJob($staged.combining.Id).State -eq 'error' -and $server.DispatchPaused) 'Retryable jobs remain independent of a quota pause'
    $null = Request '/api/resume'
    Assert ($server.GetJob($staged.combining.Id).State -eq 'error') 'Resume does not alter retryable job state'
    $server.Dispose()
    $server = New-Server $directory
    Assert ($server.DispatchPaused -and $server.PauseReason -match 'restarted') 'A restart still auto-pauses while a queued video remains, even after an earlier explicit resume'
    $server.ResumeDispatch()
    $clearErrors = Request '/api/clear-errors'
    Assert ($clearErrors.Status -eq 200 -and $clearErrors.Body.cleared -eq 4) 'Bulk error cleanup reports every removed error job'
    Assert ($null -eq $server.GetJob($staged.summarizing.Id) -and $null -eq $server.GetJob($staged.combining.Id) -and
        $null -eq $server.GetJob($staged.paused.Id)) 'Bulk error cleanup removes error jobs from memory'
    Assert (-not (Test-Path -LiteralPath (Join-Path $directory ($staged.summarizing.Id + '.json')))) 'Bulk error cleanup removes failed progress from disk'
    Assert ($server.GetJob($staged.splitting.Id).State -eq 'cancelled' -and
        $server.GetJob($queued.Id).State -eq 'completed') 'Bulk error cleanup preserves cancelled and completed jobs'
    Assert ((Request '/api/clear-errors' 'POST' '{"all":true}').Status -eq 400) 'Bulk error cleanup rejects unexpected fields'
    $server.Dispose()
    $server = $null

    $invalidDirectory = Join-Path $directory 'invalid'
    $null = New-Item -ItemType Directory -Path $invalidDirectory
    foreach ($invalid in @('not json', '{}', '{"paused":"true","pauseReason":"quota"}',
        '{"paused":true,"pauseReason":""}', '{"paused":false,"pauseReason":"quota"}',
        '{"paused":false,"pauseReason":"","extra":1}',
        '{"paused":true,"pauseReason":"quota","pauseKind":"nonsense"}',
        '{"paused":true,"pauseReason":"quota","pauseKind":7}',
        '{"paused":false,"pauseReason":"","pauseKind":"restart"}')) {
        [IO.File]::WriteAllText((Join-Path $invalidDirectory 'scheduler.state'), $invalid)
        Assert-Throws { $badServer = New-Server $invalidDirectory; $badServer.Dispose() } 'Invalid saved scheduler state is surfaced'
    }
    Remove-Item -LiteralPath (Join-Path $invalidDirectory 'scheduler.state')
    $badJob = Get-Content -LiteralPath (Join-Path $directory ($queued.Id + '.json')) -Raw | ConvertFrom-Json
    $badJob.ResultUrl = 'https://other.invalid/c/id'
    [IO.File]::WriteAllText((Join-Path $invalidDirectory ($badJob.Id + '.json')), ($badJob | ConvertTo-Json -Compress))
    Assert-Throws { $badServer = New-Server $invalidDirectory; $badServer.Dispose() } 'Unsafe result URLs in saved jobs are rejected'

    $duplicateDirectory = Join-Path $directory 'duplicates'
    $null = New-Item -ItemType Directory -Path $duplicateDirectory
    $duplicateVideo = 'duplicate01'
    $duplicateRecords = @(
        @{State='completed';Level='ultra';Language='hebrew';Result=$url;Age=4;Sequence=1},
        @{State='error';Level='ultra';Language='hebrew';Result='';Age=1;Sequence=2},
        @{State='cancelled';Level='ultra';Language='hebrew';Result='';Age=2;Sequence=3},
        @{State='completed';Level='full';Language='hebrew';Result=$url;Age=3;Sequence=4},
        @{State='queued';Level='ultra';Language='hebrew';Result='';Age=0;Sequence=5}
    )
    foreach ($record in $duplicateRecords) {
        $id = [guid]::NewGuid().ToString('D')
        $savedRecord = @{Id=$id;RequestId=[guid]::NewGuid().ToString('D');VideoId=$duplicateVideo;
            SummaryLevel=$record.Level;SummaryLanguage=$record.Language;State=$record.State;
            Message='Duplicate cleanup fixture.';ResultUrl=$record.Result;Sequence=$record.Sequence;
            CreatedAt=[DateTime]::UtcNow.AddHours(-5);UpdatedAt=[DateTime]::UtcNow.AddHours(-$record.Age)}
        [IO.File]::WriteAllText((Join-Path $duplicateDirectory ($id + '.json')), ($savedRecord | ConvertTo-Json -Compress))
    }
    $server = New-Server $duplicateDirectory
    $duplicateCleanup = Request '/api/clear-duplicates'
    Assert ($duplicateCleanup.Status -eq 200 -and $duplicateCleanup.Body.cleared -eq 2) 'Duplicate cleanup removes redundant terminal copies'
    $duplicateStatus = (Request '/api/status' 'GET' '').Body.jobs
    Assert (@($duplicateStatus | Where-Object {$_.VideoId -eq $duplicateVideo -and $_.SummaryLevel -eq 'ultra' -and $_.State -eq 'completed'}).Count -eq 1) 'Duplicate cleanup retains the completed result over failed copies'
    Assert (@($duplicateStatus | Where-Object {$_.VideoId -eq $duplicateVideo -and $_.SummaryLevel -eq 'full'}).Count -eq 1) 'Duplicate cleanup preserves a different summary level'
    Assert (@($duplicateStatus | Where-Object {$_.State -eq 'queued'}).Count -eq 1) 'Duplicate cleanup never removes active or queued work'
    Assert ((Request '/api/clear-duplicates' 'POST' '{"all":true}').Status -eq 400) 'Duplicate cleanup rejects unexpected fields'
    $server.Dispose()

    $historyDirectory = Join-Path $directory 'history'
    $null = New-Item -ItemType Directory -Path $historyDirectory
    foreach ($i in 1..102) {
        $id = [guid]::NewGuid().ToString('D')
        $record = @{Id=$id;RequestId=[guid]::NewGuid().ToString('D');VideoId=('old' + $i.ToString('D8'));
            State='completed';Message='Fixture completed reply.';ResultUrl=$url;Sequence=$i;
            CreatedAt=[DateTime]::UtcNow.AddDays(-1);UpdatedAt=[DateTime]::UtcNow.AddDays(-1)}
        [IO.File]::WriteAllText((Join-Path $historyDirectory ($id + '.json')), ($record | ConvertTo-Json -Compress))
    }
    $server = New-Server $historyDirectory
    $null = Add-Job
    $historyStatus = (Request '/api/status' 'GET' '').Body
    Assert (@($historyStatus.jobs | Where-Object State -eq 'completed').Count -eq 100) 'Completed jobs participate in history pruning'
    Assert (@(Get-ChildItem -LiteralPath $historyDirectory -Filter '*.json').Count -eq 101) 'Pruned completed jobs are removed from disk'
    $server.Dispose()
    $server = New-Server (Join-Path $directory 'capacity')
    $server.BrowserReady = $true
    $capacityJobs = @(foreach ($i in 1..21) { Add-Job })
    $newStates = @('splitting','summarizing','combining','paused')
    foreach ($i in 0..19) {
        $dispatched = $server.TakeJob()
        Assert ($dispatched.Id -eq $capacityJobs[$i].Id) 'New stage jobs dispatch in original queue order'
        $server.UpdateJob($dispatched.Id, $newStates[$i % 4], 'Fixture occupies one worker slot.')
    }
    Assert ($null -eq $server.TakeJob()) 'All four new nonterminal states count toward the twenty-worker cap'
    $server.UpdateJob($capacityJobs[0].Id, 'completed', 'Fixture final reply releases slot.')
    Assert ($server.TakeJob().Id -eq $capacityJobs[20].Id) 'Completed releases a worker slot'
    $server.Dispose()
    $server = New-Object YtSummary.LocalServer -ArgumentList 0, $token, '', '', 20, 150, (Join-Path $directory 'stagger')
    $server.Start()
    $server.BrowserReady = $true
    $null = Add-Job
    $null = Add-Job
    Assert ($null -ne $server.TakeJob() -and $null -eq $server.TakeJob()) 'Starts are still staggered'
    Start-Sleep -Milliseconds 180
    Assert ($null -ne $server.TakeJob()) 'Queued work starts after the stagger interval'

    # A failed video must repair itself instead of waiting for a manual click, but only within a
    # hard cap and never against an explicit user decision.
    $server.Dispose()
    $server = New-Server (Join-Path $directory 'auto-retry')
    $server.BrowserReady = $true
    Assert ($null -eq $server.TakeAutoRetryCandidate()) 'Nothing is auto-retried while no video has failed'
    $autoJob = Add-Job
    $server.UpdateJob($autoJob.Id, 'error', 'Transcript service verification was not completed. Nothing was sent.')
    $saved = Get-Content -LiteralPath (Join-Path (Join-Path $directory 'auto-retry') ($autoJob.Id + '.json')) -Raw | ConvertFrom-Json
    Assert ($saved.AutoRetryAttempts -eq 0) 'A first failure has not consumed any automatic attempt yet'
    Assert ($null -eq $server.TakeAutoRetryCandidate()) 'A brand new failure waits out its backoff before being retried'
    $server.GetJob($autoJob.Id).AutoRetryAfterUtc = [DateTime]::UtcNow.AddSeconds(-1)
    $candidate = $server.TakeAutoRetryCandidate()
    Assert ($null -ne $candidate -and $candidate.Id -eq $autoJob.Id) 'A failure whose backoff elapsed becomes an automatic retry candidate'
    Assert ($server.TakeAutoRetryCandidate().Id -eq $autoJob.Id) 'Taking a candidate does not consume it before it is actually requeued'
    $requeued = $server.RequeueForAutoRetry($autoJob.Id)
    Assert ($requeued.State -eq 'queued' -and $requeued.AutoRetryAttempts -eq 1) 'An automatic retry requeues the video and counts the attempt'
    Assert ($requeued.Message -match 'attempt 1 of 3') 'The dashboard message names the automatic attempt'
    Assert ($requeued.RetryReason -match 'Nothing was sent') 'The failure that triggered the automatic retry is preserved as the retry reason'
    Assert ($null -eq $server.TakeAutoRetryCandidate()) 'A requeued video is not picked up again while it waits to run'
    for ($autoAttempt = 2; $autoAttempt -le 3; $autoAttempt++) {
        $server.UpdateJob($autoJob.Id, 'error', "Fixture failure $autoAttempt.")
        $server.GetJob($autoJob.Id).AutoRetryAfterUtc = [DateTime]::UtcNow.AddSeconds(-1)
        Assert ($server.RequeueForAutoRetry($autoJob.Id).AutoRetryAttempts -eq $autoAttempt) "Automatic attempt $autoAttempt is counted"
    }
    $server.UpdateJob($autoJob.Id, 'error', 'Fixture failure after the cap.')
    $server.GetJob($autoJob.Id).AutoRetryAfterUtc = [DateTime]::UtcNow.AddSeconds(-1)
    Assert ($null -eq $server.TakeAutoRetryCandidate()) 'Automatic retries stop at the cap instead of looping forever'
    Assert-Throws { $server.RequeueForAutoRetry($autoJob.Id) } 'A video past the cap cannot be requeued automatically'
    $exhausted = $server.TakeUnrecordedFailure()
    Assert ($null -ne $exhausted -and $exhausted.Id -eq $autoJob.Id) 'A video that used up its attempts is offered for a diagnostic record'
    Assert ($server.TakeUnrecordedFailure().Id -eq $autoJob.Id) 'The failure stays pending until it is actually recorded'
    $server.MarkFailureRecorded($autoJob.Id)
    Assert ($null -eq $server.TakeUnrecordedFailure()) 'A recorded failure is not reported twice'
    $manual = $server.RetryJob($autoJob.Id)
    Assert ($manual.AutoRetryAttempts -eq 0) 'An explicit user retry restores the full automatic attempts budget'
    $server.UpdateJob($autoJob.Id, 'error', 'Fixture failure after the manual retry.')
    Assert ($null -eq $server.TakeUnrecordedFailure()) 'A failure inside a restored budget is not reported as given up'
    $server.GetJob($autoJob.Id).AutoRetryAfterUtc = [DateTime]::UtcNow.AddSeconds(-1)
    Assert ($null -ne $server.TakeAutoRetryCandidate()) 'The reset budget allows automatic repair again'
    $server.UpdateJob($autoJob.Id, 'completed', 'Fixture success.')
    Assert ($server.GetJob($autoJob.Id).AutoRetryAttempts -eq 0 -and $null -eq $server.TakeAutoRetryCandidate()) `
        'Success clears the automatic attempt history'

    $stoppedJob = Add-Job
    $server.UpdateJob($stoppedJob.Id, 'error', 'Fixture failure.')
    $server.GetJob($stoppedJob.Id).AutoRetryAfterUtc = [DateTime]::UtcNow.AddSeconds(-1)
    $server.GetJob($stoppedJob.Id).PausedByUser = $true
    Assert ($null -eq $server.TakeAutoRetryCandidate()) 'A video the user paused is never restarted automatically'
    $server.GetJob($stoppedJob.Id).PausedByUser = $false
    $server.GetJob($stoppedJob.Id).WatchLater = $true
    Assert ($null -eq $server.TakeAutoRetryCandidate()) 'A Watch later video is never restarted automatically'
    $server.GetJob($stoppedJob.Id).WatchLater = $false
    Assert ($null -ne $server.TakeAutoRetryCandidate()) 'Clearing the user hold makes the video eligible again'
    $server.PauseForUsageLimit('Fixture quota reached.')
    Assert ($null -eq $server.TakeAutoRetryCandidate()) 'Nothing is retried automatically while dispatch is paused'
    $server.ResumeDispatch()
    $server.BrowserReady = $false
    Assert ($null -eq $server.TakeAutoRetryCandidate()) 'Nothing is retried automatically without a browser'
    $server.BrowserReady = $true
    $cancelledJob = Add-Job
    $server.UpdateJob($cancelledJob.Id, 'cancelled', 'Stopped by the user.')
    $server.GetJob($stoppedJob.Id).WatchLater = $true
    Assert ($null -eq $server.TakeAutoRetryCandidate()) 'A stopped video is never restarted automatically'

    $clearedJob = Add-Job
    $server.UpdateJob($clearedJob.Id, 'error', 'Fixture failure.')
    $server.GetJob($clearedJob.Id).AutoRetryAfterUtc = [DateTime]::UtcNow.AddSeconds(-1)
    $null = $server.RequeueForAutoRetry($clearedJob.Id)
    $server.ClearJobProgress($clearedJob.Id)
    $cleared = $server.GetJob($clearedJob.Id)
    Assert ($cleared.AutoRetryAttempts -eq 0 -and $cleared.AutoRetryAfterUtc -eq [DateTime]::MinValue) `
        'Clearing local progress restores the full automatic attempts budget'

    $restoredId = [Guid]::NewGuid().ToString()
    $restored = $server.RestorePendingSend($restoredId, [Guid]::NewGuid().ToString(), 'abcdefghijk')
    Assert ($restored.State -eq 'error' -and $restored.AutoRetryAfterUtc -gt [DateTime]::UtcNow) `
        'A failure restored from a pending-send journal is scheduled for automatic repair'
    $server.GetJob($restoredId).AutoRetryAfterUtc = [DateTime]::UtcNow.AddSeconds(-1)
    Assert ($server.TakeAutoRetryCandidate().Id -eq $restoredId) 'A restored ambiguous send repairs itself without a manual click'

    $statusBody = (Request '/api/status' 'GET' '').Body
    Assert ($statusBody.autoRetryLimit -eq 3) 'The dashboard is told how many automatic attempts the server will make'

    # A leftover journal from a video that already finished must not resurrect it as a failure.
    $doneJob = Add-Job
    $server.UpdateJob($doneJob.Id, 'completed', 'Summary ready.')
    $staleResult = $server.RestorePendingSend($doneJob.Id, $doneJob.RequestId, $doneJob.VideoId)
    Assert ($null -eq $staleResult) 'A journal belonging to a finished video reports itself as stale'
    $stillDone = $server.GetJob($doneJob.Id)
    Assert ($stillDone.State -ceq 'completed' -and $stillDone.Message -ceq 'Summary ready.') `
        'A finished video keeps its result instead of being re-reported as a failure at every launch'
    $candidateAfterStale = $server.TakeAutoRetryCandidate()
    Assert ($null -eq $candidateAfterStale -or $candidateAfterStale.Id -ne $doneJob.Id) `
        'A finished video is never retried because of a leftover journal'

    $interruptedJob = Add-Job
    $server.UpdateJob($interruptedJob.Id, 'summarizing', 'Part 1/3.')
    $interruptedResult = $server.RestorePendingSend($interruptedJob.Id, $interruptedJob.RequestId, $interruptedJob.VideoId)
    Assert ($null -ne $interruptedResult -and $interruptedResult.State -ceq 'error') `
        'A genuinely interrupted send is still restored so it can be resent'

    Write-Output "ALL $assertions split-server assertions passed. Only loopback TCP was used; no browser was opened."
} finally {
    if ($null -ne $server) { $server.Dispose() }
    if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
}
