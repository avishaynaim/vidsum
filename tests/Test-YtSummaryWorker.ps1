param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $HelperRoot 'YtSummary.psm1'
$workerPath = Join-Path $HelperRoot 'Invoke-YtSummaryWorker.ps1'
$testDirectory = Join-Path $PSScriptRoot ("worker-regression-" + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testDirectory
$script:assertions = 0

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAILED: $Message" }
    $script:assertions++
    Write-Output "PASS: $Message"
}

if (-not ('YtWorkerTest.Server' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Net.WebSockets;

namespace YtWorkerTest {
    public sealed class Job {
        public string Id = Guid.NewGuid().ToString("N");
        public string RequestId = Guid.NewGuid().ToString();
        public string VideoId;
        public string State = "queued", Message = "", CreatedAt = DateTime.UtcNow.ToString("o");
        public string Scenario;
        public int Opened, Targets, Closed, Sent, Focused, Insertions, Probes, NativeNavigations, NativeOpens;
        public string Inserted = "", JournalAtSend = "", ResultUrl = "";
        public ConcurrentQueue<string> States = new ConcurrentQueue<string>();
        public Job(string scenario, int index) {
            Scenario = scenario;
            VideoId = "fixture" + index.ToString("D4");
        }
    }
    public sealed class Socket {
        public int Disposals;
        public void Dispose() { Interlocked.Increment(ref Disposals); }
    }
    public sealed class Server {
        public volatile bool StopRequested;
        public volatile bool IsRunning = true;
        public volatile bool DispatchPaused;
        public string PauseReason = "";
        public string LastServerError = "";
        public string[] EnabledProviders { get { return new [] { "ChatGPT", "Gemini", "Claude" }; } }
        public readonly ConcurrentDictionary<string, Job> Jobs = new ConcurrentDictionary<string, Job>();
        public readonly ConcurrentBag<Socket> Sockets = new ConcurrentBag<Socket>();
        public readonly ConcurrentDictionary<string, bool> Targets = new ConcurrentDictionary<string, bool>();
        public readonly CountdownEvent Transcripts;
        public readonly SemaphoreSlim Gate;
        public readonly CancellationTokenSource Cancel;
        public bool UseGate = true;
        public int Violations;
        private string owner;
        private readonly object sync = new object();
        public Server(int workers, SemaphoreSlim gate, CancellationTokenSource cancel) {
            Transcripts = new CountdownEvent(workers); Gate = gate; Cancel = cancel;
        }
        public void UpdateJob(string id, string state, string message) {
            Job job = Jobs[id];
            job.State = state; job.Message = message; job.States.Enqueue(state);
            if (state == "sending" && job.Scenario == "cancel-before-send") Cancel.Cancel();
            if (state == "inserting" && job.Scenario == "cancel-inserting") Cancel.Cancel();
            if (state == "waiting-composer" && job.Scenario == "cancel-wait") Cancel.CancelAfter(100);
            if (state == "waiting-composer" && job.Scenario == "stop-wait")
                ThreadPool.QueueUserWorkItem(delegate { Thread.Sleep(100); StopRequested = true; });
            if (state == "verification" && job.Scenario == "verification-cancel") Cancel.Cancel();
            if (state == "loading" && message.StartsWith("Waiting for browser access") && job.Scenario == "native-wait-cancel") Cancel.CancelAfter(100);
            if (state == "summarizing" || state == "completed" || state == "submitted" || state == "error" || state == "needs-review" || state == "cancelled")
                lock (sync) { if (owner == id) owner = null; }
        }
        public void PauseForUsageLimit(string reason) { PauseReason=reason; DispatchPaused=true; }
        public void SetResultUrl(string id,string url) { Jobs[id].ResultUrl=url; }
        public void ClearJobPartResultUrls(string id) { }
        public void BeginComposer(string id) {
            if (!UseGate) return;
            lock (sync) {
                if (Gate.CurrentCount != 0 || owner != null) {
                    Interlocked.Increment(ref Violations);
                    throw new InvalidOperationException("Concurrent composer navigation/focus.");
                }
                owner = id;
            }
        }
        public void AssertComposer(string id) {
            if (!UseGate) return;
            lock (sync) {
                if (Gate.CurrentCount != 0 || owner != id) {
                    Interlocked.Increment(ref Violations);
                    throw new InvalidOperationException("Composer used outside its exclusive gate.");
                }
            }
        }
    }
    public sealed class ProtocolSocket {
        public bool BlockSend, BlockReceive;
        public int Sends;
        public async Task SendAsync(ArraySegment<byte> bytes, WebSocketMessageType type, bool end, CancellationToken token) {
            Interlocked.Increment(ref Sends);
            token.ThrowIfCancellationRequested();
            if (BlockSend) await Task.Delay(Timeout.Infinite, token);
        }
        public async Task<WebSocketReceiveResult> ReceiveAsync(ArraySegment<byte> bytes, CancellationToken token) {
            token.ThrowIfCancellationRequested();
            if (BlockReceive) await Task.Delay(Timeout.Infinite, token);
            byte[] response = Encoding.UTF8.GetBytes("{\"id\":1,\"result\":{\"ok\":true}}");
            Array.Copy(response, 0, bytes.Array, bytes.Offset, response.Length);
            return new WebSocketReceiveResult(response.Length, WebSocketMessageType.Text, true);
        }
    }
}
'@
}

$mockCode = @'
param($Server, $Job, $Journal, $Gate, $Cancel)
$script:fixtureServer = $Server
$script:fixtureJob = $Job
$script:fixtureJournal = $Journal
$script:fixtureGate = $Gate
$script:fixtureCancel = $Cancel
$script:WarningPreference = 'SilentlyContinue'
function script:Start-Sleep { param($Milliseconds) [Threading.Thread]::Sleep(2) }
function script:Open-YtCdp {
    param($WebSocketUrl, $CancellationToken)
    $script:fixtureJob.Opened++
    if ($script:fixtureJob.Scenario -eq 'connection-error') { throw 'Fixture connection failed.' }
    $socket = New-Object YtWorkerTest.Socket
    $script:fixtureServer.Sockets.Add($socket)
    return [pscustomobject]@{
        Socket=$socket; NextId=0; CancellationToken=$CancellationToken
        TargetId=[guid]::NewGuid().ToString('N'); SessionId=[guid]::NewGuid().ToString('N')
        Phase='transcript'
    }
}
function script:Invoke-YtCdp {
    param($Connection, $Method, $Parameters, $SessionId)
    $job = $script:fixtureJob
    $server = $script:fixtureServer
    switch ($Method) {
        'Target.createTarget' {
            if ($server.UseGate -and (-not $Parameters.ContainsKey('background') -or -not $Parameters.background)) {
                throw 'Transcript target stole foreground focus.'
            }
            $job.Targets++
            if (-not $server.Targets.TryAdd($Connection.TargetId, $true)) { throw 'Target was reused.' }
            if ($server.Transcripts.CurrentCount -gt 0) { $null = $server.Transcripts.Signal() }
            return [pscustomobject]@{targetId=$Connection.TargetId}
        }
        'Target.attachToTarget' {
            if ($Parameters.targetId -ne $Connection.TargetId) { throw 'Attached to another job target.' }
            return [pscustomobject]@{sessionId=$Connection.SessionId}
        }
        'Target.closeTarget' {
            if ($Parameters.targetId -ne $Connection.TargetId) { throw 'Closed another job target.' }
            $job.Closed++
            return [pscustomobject]@{success=$true}
        }
        'Page.bringToFront' {
            if ($Connection.Phase -eq 'youtube' -and $job.State -eq 'loading') {
                if ($server.UseGate -and $script:fixtureGate.CurrentCount -ne 0) { throw 'Native transcript stole foreground focus outside the gate.' }
                return [pscustomobject]@{}
            }
            if ($job.State -eq 'summarizing') {
                throw 'A finished summary tab stole the foreground instead of staying in the background.'
            }
            $server.BeginComposer($job.Id); return [pscustomobject]@{}
        }
        'Page.navigate' {
            if ($Parameters.url -like 'https://www.youtube.com/watch?v=*') {
                if ($server.UseGate -and $script:fixtureGate.CurrentCount -ne 0) { throw 'Native transcript navigation ran outside the gate.' }
                if ($Parameters.url -cne "https://www.youtube.com/watch?v=$($job.VideoId)") { throw 'Native fallback requested another video.' }
                $job.NativeNavigations++
                if ($job.Scenario -eq 'native-navigation-error') { throw 'Fixture native navigation failed.' }
                if ($job.Scenario -eq 'native-navigation-rejected') { return [pscustomobject]@{errorText='net::ERR_CONNECTION_REFUSED'} }
                $Connection.Phase = 'youtube'
                return [pscustomobject]@{frameId='fixture'}
            }
            # Navigating to the provider is the first composer action taken once the gate is
            # held (no separate bringToFront call is made for intermediate/background stages).
            $server.BeginComposer($job.Id)
            if ($job.Scenario -eq 'navigation-error') { throw 'Fixture navigation failed.' }
            if ($job.Scenario -eq 'navigation-timeout') { throw (New-Object Threading.Tasks.TaskCanceledException -ArgumentList 'Fixture command timed out.') }
            $Connection.Phase = 'chatgpt'
            return [pscustomobject]@{frameId='fixture'}
        }
        'Input.insertText' {
            $server.AssertComposer($job.Id)
            $job.Insertions++
            $job.Inserted = $Parameters.text
            if ($job.Scenario -eq 'journal-race') { [IO.File]::WriteAllText($script:fixtureJournal, '{"prior":true}') }
            return [pscustomobject]@{}
        }
        default { throw "Unexpected browser command: $Method" }
    }
}
function script:Invoke-YtNavigationProbe {
    param($Connection, $SessionId, $Expression)
    $job = $script:fixtureJob
    $server = $script:fixtureServer
    if ($Connection.Phase -eq 'transcript') {
        if (-not $server.Transcripts.Wait(20000)) { throw 'Transcript workers did not run concurrently.' }
        $job.Probes++
        if ($job.Scenario -eq 'transcript-aborted' -and $job.Opened -eq 1) {
            throw 'Exception calling "GetResult" with "0" argument(s): "The WebSocket is in an invalid state (''Aborted'') for this operation. Valid states are: ''Open, CloseReceived''"'
        }
        if ($job.Scenario -like 'native-*') {
            return [pscustomobject]@{url="https://youtubetotranscript.com/transcript?v=$($job.VideoId)";count=0;text='';ready='complete';challenge=$false;failure='YouTube blocked the transcript service.'}
        }
        if ($job.Scenario -eq 'empty-service') {
            return [pscustomobject]@{url="https://youtubetotranscript.com/transcript?v=$($job.VideoId)";count=0;text='';ready='complete';challenge=$false;failure=''}
        }
        if ($job.Scenario -eq 'verification-cancel' -or ($job.Scenario -eq 'verification' -and $job.Probes -eq 1)) {
            return [pscustomobject]@{url='https://youtubetotranscript.com/transcript';count=0;text='';ready='complete';challenge=$true}
        }
        $video = if ($job.Scenario -eq 'wrong-video') { 'wrongvideo1' } else { $job.VideoId }
        return [pscustomobject]@{
            url="https://youtubetotranscript.com/transcript?v=$video"; count=3
            text="Full clean transcript for $($job.VideoId)."; ready='complete'; challenge=$false
        }
    }
    if ($Connection.Phase -eq 'youtube') {
        if ($Expression.Contains('caption-track-waiting')) {
            if ($job.Scenario -eq 'native-direct-success') {
                return [pscustomobject]@{
                    url="https://www.youtube.com/watch?v=$($job.VideoId)";count=3
                    text="Native full transcript for $($job.VideoId).";failure='';retryable=$false
                    unavailable=$false;captionsAvailable=$true;phase='caption-track-ready'
                }
            }
            return [pscustomobject]@{
                url="https://www.youtube.com/watch?v=$($job.VideoId)";count=0;text=''
                failure='Fixture direct caption track unavailable.';retryable=$false
                unavailable=$false;captionsAvailable=$true;phase='caption-track-error'
            }
        }
        if ($server.UseGate -and $script:fixtureGate.CurrentCount -ne 0) { throw 'Native transcript controls ran outside the gate.' }
        if ($job.Scenario -eq 'native-cancel') { $script:fixtureCancel.Cancel() }
        $video = if ($job.Scenario -eq 'native-wrong-video') { 'wrongvideo1' } else { $job.VideoId }
        $result = [pscustomobject]@{
            url="https://www.youtube.com/watch?v=$video";count=3;text="Native full transcript for $($job.VideoId)."
            ready='complete';challenge=$false;failure='';unavailable=($job.Scenario -eq 'native-unavailable');action=''
            captionsAvailable=$true;phase='transcript-ready'
        }
        if ($job.Scenario -eq 'native-unavailable') {
            $result.count=0; $result.text=''; $result.captionsAvailable=$false; $result.phase='no-captions'
        }
        if ($job.Scenario -eq 'native-timeout') {
            $result.count=0; $result.text=''; $result.phase='entry-missing-with-captions'
        }
        if ($Expression.Contains('if (true) {')) {
            $job.NativeOpens++
            $result.action='open-transcript'
        }
        return $result
    }
    if ($job.State -ne 'summarizing') { $server.AssertComposer($job.Id) }
    if ($Connection.Phase -eq 'sent' -and $job.Scenario -eq 'confirmation-error') { throw 'Fixture confirmation disconnected.' }
    $text = if ($job.Scenario -eq 'draft') { 'My unsaved draft' } else { $job.Inserted }
    $lastMessage = if ($Connection.Phase -eq 'sent') { $job.Inserted } else { '' }
    if ($Connection.Phase -eq 'sent' -and $job.Scenario -eq 'wrong-confirmation') {
        $lastMessage = 'Some other message'
        $script:fixtureCancel.Cancel()
    }
    return [pscustomobject]@{
        kind='ready';busy=($job.Scenario -eq 'busy');text=$text;canSend=$true
        messageCount=[int]($Connection.Phase -eq 'sent');lastMessage=$lastMessage
        assistantMessageCount=[int]($Connection.Phase -eq 'sent')
        lastAssistantText=$(if ($Connection.Phase -eq 'sent') {'Complete summary.'} else {''})
        failureKind='';failureMessage='';url=$(if($Connection.Phase -eq 'sent'){"https://chatgpt.com/c/$($job.Id)"}else{'https://chatgpt.com/'})
    }
}
function script:Focus-YtComposer {
    param($Connection, $SessionId)
    $script:fixtureServer.AssertComposer($script:fixtureJob.Id)
    $script:fixtureJob.Focused++
}
function script:Send-YtComposer {
    param($Connection, $SessionId, $ExpectedText)
    $job = $script:fixtureJob
    $script:fixtureServer.AssertComposer($job.Id)
    $job.Sent++
    $job.JournalAtSend = [IO.File]::ReadAllText($script:fixtureJournal)
    if ($job.Inserted -cne $ExpectedText) { throw 'Fixture sent incomplete text.' }
    if ($job.Scenario -eq 'disconnect') { throw 'Fixture disconnected while sending.' }
    if ($job.Scenario -eq 'send-timeout') { throw (New-Object Threading.Tasks.TaskCanceledException -ArgumentList 'Fixture send timed out.') }
    if ($job.Scenario -eq 'cancel-after-send') { $script:fixtureCancel.Cancel() }
    if ($job.Scenario -eq 'stop-after-send') { $script:fixtureServer.StopRequested = $true }
    $Connection.Phase = 'sent'
}
'@

$runner = {
    param($ModulePath, $WorkerPath, $Server, $Job, $Journal, $Gate, $Cancel, $MockCode, $Direct)
    $ErrorActionPreference = 'Stop'
    $WarningPreference = 'SilentlyContinue'
    $module = Microsoft.PowerShell.Core\Import-Module $ModulePath -Force -DisableNameChecking -PassThru
    & $module ([scriptblock]::Create($MockCode)) $Server $Job $Journal $Gate $Cancel
    function Import-Module {
        [CmdletBinding()]
        param($Name, [switch]$Force, [switch]$DisableNameChecking)
        if ($Job.Scenario -eq 'import-error') { throw 'Fixture module import failed.' }
    }
    function Open-YtCdp {
        param($WebSocketUrl, $CancellationToken)
        & $module { param($Url, $Token) Open-YtCdp $Url $Token } $WebSocketUrl $CancellationToken
    }
    if ($Direct) {
        $connection = Open-YtCdp 'ws://127.0.0.1:1/devtools/browser/fixture' $Cancel.Token
        try {
            $arguments = @{Connection=$connection;Server=$Server;Job=$job;JournalPath=$Journal;WaitSeconds=$(if($Job.Scenario -in @('native-timeout','empty-service')){1}else{5})}
            if ($Server.UseGate) { $arguments.ComposerGate = $Gate }
            Invoke-YtSummaryJob @arguments
        } finally { $connection.Socket.Dispose() }
    } else {
        & $WorkerPath -ModulePath $ModulePath -BrowserWebSocketUrl 'ws://127.0.0.1:1/devtools/browser/fixture' `
            -Server $Server -Job $Job -JournalPath $Journal -ComposerGate $Gate -CancellationToken $Cancel.Token
    }
}

$pool = $null
$running = New-Object 'Collections.Generic.List[object]'
$gate = $null
$cancel = $null
try {
    $gate = New-Object Threading.SemaphoreSlim -ArgumentList 1, 1
    $cancel = New-Object Threading.CancellationTokenSource
    $server = New-Object YtWorkerTest.Server -ArgumentList 20, $gate, $cancel
    $scenarios = @('disconnect', 'draft', 'wrong-video', 'navigation-error', 'confirmation-error', 'verification') + @('success') * 14
    $pool = [RunspaceFactory]::CreateRunspacePool(1, 20)
    $pool.Open()
    for ($i = 0; $i -lt $scenarios.Count; $i++) {
        $job = New-Object YtWorkerTest.Job -ArgumentList $scenarios[$i], $i
        $server.Jobs[$job.Id] = $job
        $journal = Join-Path $testDirectory ($job.Id + '.json')
        $ps = [PowerShell]::Create()
        $ps.RunspacePool = $pool
        $null = $ps.AddScript($runner.ToString()).AddArgument($modulePath).AddArgument($workerPath).
            AddArgument($server).AddArgument($job).AddArgument($journal).AddArgument($gate).AddArgument($cancel).
            AddArgument($mockCode).AddArgument($false)
        $running.Add([pscustomobject]@{PowerShell=$ps;Result=$ps.BeginInvoke();Job=$job;Journal=$journal})
    }
    foreach ($entry in $running) {
        $null = $entry.PowerShell.EndInvoke($entry.Result)
        if ($entry.PowerShell.Streams.Error.Count) { throw ($entry.PowerShell.Streams.Error | Out-String) }
    }
    if ($server.Targets.Count -ne 20 -or $server.Sockets.Count -ne 20) {
        $server.Jobs.Values | Select-Object Scenario, State, Opened, Targets, Message | Format-Table -Wrap | Out-Host
    }
    Assert ($server.Targets.Count -eq 20 -and $server.Sockets.Count -eq 20) 'Twenty runspaces own twenty distinct targets and connections'
    Assert ($server.Transcripts.CurrentCount -eq 0) 'All twenty transcript jobs advance before any composer is allowed to run'
    if ($server.Violations -ne 0 -or $gate.CurrentCount -ne 1) {
        Write-Output "Gate violations=$($server.Violations); available=$($gate.CurrentCount)"
        $server.Jobs.Values | Select-Object Scenario,State,Message | Format-Table -Wrap | Out-Host
    }
    Assert ($server.Violations -eq 0 -and $gate.CurrentCount -eq 1) 'Navigation, focus, insertion, Send and confirmation stay inside the shared gate'
    Assert (@($server.Sockets | Where-Object { $_.Disposals -ne 1 }).Count -eq 0) 'Each worker disposes exactly its own connection'
    $draftJob = @($server.Jobs.Values | Where-Object Scenario -eq 'draft')[0]
    $disconnectJob = @($server.Jobs.Values | Where-Object Scenario -eq 'disconnect')[0]
    Assert ($draftJob.Closed -eq 1) `
        'Pre-send provider failures close their abandoned empty/draft tabs instead of accumulating Gemini tabs'
    Assert ($disconnectJob.Closed -eq 0) 'Ambiguous post-send provider tabs stay open for automatic reconciliation'
    Assert (-not $cancel.IsCancellationRequested -and -not $server.StopRequested) 'Job errors never stop or cancel sibling workers'
    foreach ($entry in $running) {
        $job = $entry.Job
        $expectedState = if ($job.Scenario -in @('disconnect', 'confirmation-error', 'draft', 'wrong-video', 'navigation-error')) { 'error' }
            else { 'completed' }
        $expectedSends = if ($job.Scenario -in @('disconnect', 'confirmation-error')) { 1 }
            elseif ($expectedState -eq 'error') { 0 } else { 1 }
        Assert ($job.State -eq $expectedState -and $job.Sent -eq $expectedSends) "Independent $($job.Scenario) job ends $expectedState with $expectedSends Send attempt(s); actual=$($job.State)/$($job.Sent): $($job.Message)"
        if ($job.Sent -eq 1) {
            $record = $job.JournalAtSend | ConvertFrom-Json
            $sha = [Security.Cryptography.SHA256]::Create()
            try { $hash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(([regex]::Replace($job.Inserted, '\s+', ' ').Trim())))).Replace('-', '').ToLowerInvariant() }
            finally { $sha.Dispose() }
            if ($record.jobId -ne $job.Id -or $record.requestId -ne $job.RequestId -or $record.videoId -ne $job.VideoId -or
                -not $server.Targets.ContainsKey($record.targetId) -or $record.expectedTextSha256 -cne $hash -or
                -not $record.startedUtc -or $job.JournalAtSend.Contains('Full clean transcript')) {
                throw 'Durable journal metadata was incomplete or contained transcript text.'
            }
        }
        if ((Test-Path -LiteralPath $entry.Journal) -ne ($job.Scenario -in @('disconnect','confirmation-error'))) { throw 'Incorrect journal cleanup.' }
        if ($job.Scenario -eq 'draft' -and ($job.Focused -ne 0 -or $job.Insertions -ne 0)) { throw 'Existing draft was touched.' }
        $openedBefore = $job.Opened
        if ($expectedState -eq 'completed') {
            & $runner $modulePath $workerPath $server $job $entry.Journal $gate $cancel $mockCode $false
            if ($job.Opened -ne $openedBefore -or $job.Sent -ne 1) { throw 'Completed/uncertain job was replayed.' }
        }
    }
    Assert ($null -eq $server.PSObject.Properties['ReviewRequired']) 'Per-job review works without any writable global ReviewRequired property'
    Assert ($true) 'Send journals are durable metadata-only records; production retries reconcile before automatic resend'
    foreach ($entry in $running) { $entry.PowerShell.Dispose() }
    $running.Clear()
    $pool.Dispose(); $pool = $null
    $server.Transcripts.Dispose()
    $gate.Dispose(); $gate = $null
    $cancel.Dispose(); $cancel = $null

    $cases = @(
        @{Name='cancel-start';State='cancelled';Sends=0;Held=$false},
        @{Name='cancel-wait';State='cancelled';Sends=0;Held=$true},
        @{Name='stop-wait';State='cancelled';Sends=0;Held=$true},
        @{Name='verification-cancel';State='cancelled';Sends=0;Held=$true},
        @{Name='cancel-inserting';State='cancelled';Sends=0;Held=$false},
        @{Name='cancel-before-send';State='cancelled';Sends=0;Held=$false},
        @{Name='cancel-after-send';State='cancelled';Sends=1;Held=$false},
        @{Name='stop-after-send';State='cancelled';Sends=1;Held=$false},
        @{Name='wrong-confirmation';State='cancelled';Sends=1;Held=$false},
        @{Name='existing-journal';State='completed';Sends=1;Held=$false},
        @{Name='journal-race';State='error';Sends=0;Held=$false},
        @{Name='previous-sending';State='completed';Sends=1;Held=$false},
        @{Name='previous-review';State='completed';Sends=1;Held=$false},
        @{Name='connection-error';State='error';Sends=0;Held=$false},
        @{Name='import-error';State='error';Sends=0;Held=$false},
        @{Name='server-error';State='error';Sends=0;Held=$false},
        @{Name='navigation-timeout';State='error';Sends=0;Held=$false},
        @{Name='transcript-aborted';State='completed';Sends=1;Held=$false},
        @{Name='send-timeout';State='error';Sends=1;Held=$false},
        @{Name='busy';State='error';Sends=0;Held=$false},
        @{Name='native-direct-success';State='completed';Sends=1;Held=$false},
        @{Name='native-success';State='completed';Sends=1;Held=$false},
        @{Name='native-no-gate';State='completed';Sends=1;Held=$false},
        @{Name='empty-service';State='completed';Sends=1;Held=$false},
        @{Name='native-unavailable';State='error';Sends=0;Held=$false},
        @{Name='native-wrong-video';State='error';Sends=0;Held=$false},
        @{Name='native-timeout';State='error';Sends=0;Held=$false},
        @{Name='native-navigation-error';State='error';Sends=0;Held=$false},
        @{Name='native-navigation-rejected';State='error';Sends=0;Held=$false},
        @{Name='native-cancel';State='cancelled';Sends=0;Held=$false},
        @{Name='native-wait-cancel';State='cancelled';Sends=0;Held=$true},
        @{Name='no-gate';State='completed';Sends=1;Held=$false},
        @{Name='token-from-connection';State='cancelled';Sends=0;Held=$false}
    )
    foreach ($case in $cases) {
        $gate = New-Object Threading.SemaphoreSlim -ArgumentList 1, 1
        $cancel = New-Object Threading.CancellationTokenSource
        $server = New-Object YtWorkerTest.Server -ArgumentList 1, $gate, $cancel
        $job = New-Object YtWorkerTest.Job -ArgumentList $case.Name, 9999
        $server.Jobs[$job.Id] = $job
        $journal = Join-Path $testDirectory ($job.Id + '.json')
        if ($case.Held) { $null = $gate.Wait(0) }
        if ($case.Name -in @('cancel-start', 'token-from-connection')) { $cancel.Cancel() }
        if ($case.Name -eq 'existing-journal') { [IO.File]::WriteAllText($journal, '{"prior":true}') }
        if ($case.Name -eq 'previous-sending') { $job.State = 'sending' }
        if ($case.Name -eq 'previous-review') { $job.State = 'needs-review' }
        if ($case.Name -eq 'server-error') { $server.IsRunning = $false; $server.LastServerError = 'Fixture listener failed.' }
        if ($case.Name -in @('no-gate', 'native-no-gate')) { $server.UseGate = $false }
        & $runner $modulePath $workerPath $server $job $journal $gate $cancel $mockCode ($case.Name -in @('no-gate', 'native-no-gate', 'token-from-connection', 'native-timeout', 'empty-service'))
        $expectedGate = if ($case.Held) { 0 } else { 1 }
        if ($job.State -ne $case.State -or $job.Sent -ne $case.Sends -or $gate.CurrentCount -ne $expectedGate) {
            $job | Select-Object Scenario,State,Message,Sent,NativeNavigations,NativeOpens | Format-List | Out-Host
        }
        Assert ($job.State -eq $case.State -and $job.Sent -eq $case.Sends -and $gate.CurrentCount -eq $expectedGate) "$($case.Name): $($case.State), once-only Send and correct gate ownership"
        if ($case.Name -eq 'transcript-aborted') {
            Assert ($job.Opened -eq 2 -and $job.Probes -ge 4) `
                'An aborted transcript WebSocket gets one fresh connection and then completes without user intervention'
        }
        if ($case.Name -eq 'journal-race' -and [IO.File]::ReadAllText($journal) -cne '{"prior":true}') {
            throw 'An existing journal was overwritten or deleted.'
        }
        if ($case.Name -eq 'cancel-before-send' -and (Test-Path -LiteralPath $journal)) { throw 'Definitely unsent cancellation retained its own new journal.' }
        if ($case.Sends -eq 1 -and $case.State -in @('error','cancelled') -and -not (Test-Path -LiteralPath $journal)) { throw 'Ambiguous send lost its journal.' }
        if ($case.Name -in @('cancel-wait', 'stop-wait', 'verification-cancel') -and $job.Focused -gt 0) { throw 'Cancelled waiting job touched composer.' }
        if ($case.Name -in @('existing-journal', 'previous-sending', 'previous-review') -and $job.Opened -eq 0) { throw 'Automatic recovery did not open a browser connection.' }
        if ($case.Name -in @('connection-error', 'import-error') -and $job.Message -notmatch 'Fixture.+failed') { throw 'Startup error was not surfaced.' }
        if ($case.Name -eq 'native-direct-success' -and
            ($job.NativeNavigations -ne 1 -or $job.NativeOpens -ne 0 -or -not $job.Inserted.Contains("Native full transcript for $($job.VideoId)."))) {
            throw 'The direct native caption track was not retrieved once and included completely.'
        }
        if ($case.Name -eq 'busy' -and $job.Closed -ne 1) { throw 'A pre-send provider-busy tab was not closed.' }
        if ($case.Name -in @('native-success', 'native-no-gate', 'empty-service') -and
            ($job.NativeNavigations -ne 1 -or $job.NativeOpens -ne 1 -or -not $job.Inserted.Contains("Native full transcript for $($job.VideoId)."))) {
            throw 'The native transcript was not retrieved once and included completely.'
        }
        if ($case.Name -eq 'native-unavailable' -and $job.Message -notmatch 'YouTube exposes no native transcript') { throw 'Missing captions were not explained.' }
        if ($case.Name -eq 'native-wrong-video' -and $job.Message -notmatch 'different video') { throw 'A different native video was accepted.' }
        if ($case.Name -eq 'native-timeout' -and
            $job.Message -notmatch 'timed out while looking for the transcript entry point even though YouTube reported caption tracks') {
            throw 'Native transcript timeout did not report that captions existed but the entry point remained missing.'
        }
        if ($case.Name -eq 'native-navigation-rejected' -and $job.Message -notmatch 'YouTube transcript navigation failed: net::ERR_CONNECTION_REFUSED') { throw 'Native navigation errors were not surfaced immediately.' }
        if ($case.Name -eq 'native-wait-cancel' -and $job.NativeNavigations -ne 0) { throw 'A cancelled native waiter navigated the browser.' }
        if (@($server.Sockets | Where-Object { $_.Disposals -ne 1 }).Count) { throw 'Worker connection leaked.' }
        $server.Transcripts.Dispose()
        $gate.Dispose(); $gate = $null
        $cancel.Dispose(); $cancel = $null
    }

    Microsoft.PowerShell.Core\Import-Module $modulePath -Force -DisableNameChecking
    $expression = Get-YtComposerExpression
    Assert ($expression.Contains("last?.querySelector('.whitespace-pre-wrap') || last")) 'Confirmation still reads the actual user-message body, not Show more controls'
    Assert ((Get-YtTranscriptExpression).Contains('[class*="badge" i], button, [class*="copy" i], [class*="download" i]')) 'Clean transcript extraction still removes timestamp badges'
    $socket = New-Object YtWorkerTest.ProtocolSocket
    $connection = [pscustomobject]@{Socket=$socket;NextId=0}
    $response = Invoke-YtCdp $connection 'Fixture.command'
    Assert (@($response).Count -eq 1 -and $response.ok) 'Legacy connections work and async void task results do not leak into return values'
    foreach ($mode in @('connection-send', 'connection-receive', 'explicit-receive', 'timeout')) {
        $cancel = New-Object Threading.CancellationTokenSource
        $socket = New-Object YtWorkerTest.ProtocolSocket
        if ($mode -eq 'connection-send') { $socket.BlockSend = $true } else { $socket.BlockReceive = $true }
        $connection = [pscustomobject]@{Socket=$socket;NextId=0;CancellationToken=[Threading.CancellationToken]::None}
        $arguments = @{Connection=$connection;Method='Fixture.command';TimeoutSeconds=5}
        if ($mode -like 'connection-*') { $connection.CancellationToken = $cancel.Token }
        if ($mode -eq 'explicit-receive') { $arguments.CancellationToken = $cancel.Token }
        if ($mode -eq 'timeout') { $arguments.TimeoutSeconds = 1 } else { $cancel.CancelAfter(100) }
        $watch = [Diagnostics.Stopwatch]::StartNew()
        $failed = $false
        $failure = $null
        try { $null = Invoke-YtCdp @arguments } catch { $failed = $true; $failure = $_.Exception }
        $watch.Stop()
        Assert ($failed -and $watch.Elapsed.TotalSeconds -lt 4 -and ($mode -ne 'timeout' -or -not $cancel.IsCancellationRequested)) "CDP $mode uses cancellable, per-command timeout tokens without cancelling the parent"
        if ($mode -eq 'timeout') {
            Assert ($failure -is [TimeoutException] -and $failure.Message -match 'Fixture.command within 1 seconds' -and
                $failure.Message -notmatch 'GetResult') 'Browser timeouts name the command instead of exposing a GetResult cancellation wrapper'
        } else {
            Assert ($failure -isnot [TimeoutException]) 'User cancellation is not mislabeled as a browser timeout'
        }
        $cancel.Dispose(); $cancel = $null
    }
    # A single slow Runtime.evaluate -- a huge transcript DOM on a very long video, or a loaded
    # machine running several workers -- used to abort the whole job. The real per-call watchdog
    # below fires against a genuinely blocked socket, and the production probe must classify it
    # as a missed poll so the caller's own much longer deadline stays in charge.
    $socket = New-Object YtWorkerTest.ProtocolSocket
    $socket.BlockReceive = $true
    $connection = [pscustomobject]@{Socket=$socket;NextId=0;CancellationToken=[Threading.CancellationToken]::None}
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $timedOutProbe = & (Get-Module YtSummary) { param($c) Invoke-YtNavigationProbe $c 'fixture-session' 'return 1' } $connection
    $watch.Stop()
    Assert ($null -eq $timedOutProbe -and $watch.Elapsed.TotalSeconds -ge 10) `
        'A browser command that exceeds the per-call watchdog is a tolerated missed poll, not a job failure'
    $abortedFailure = $null
    try {
        $null = & (Get-Module YtSummary) {
            $connection = [pscustomobject]@{Socket=[pscustomobject]@{State='Aborted'}}
            function Invoke-YtPageScript { throw (New-Object TimeoutException -ArgumentList 'Fixture transcript probe timed out.') }
            Invoke-YtNavigationProbe $connection 'fixture-session' 'return 1' 60
        }
    } catch { $abortedFailure = $_.Exception }
    Assert ($null -ne $abortedFailure -and $abortedFailure.Message -match 'WebSocket became Aborted' -and
        (Test-YtTransientInfrastructureFailure $abortedFailure $server ([Threading.CancellationToken]::None))) `
        'A timed-out transcript probe whose WebSocket became Aborted triggers a bounded worker reconnect instead of reusing the dead socket'
    $rawAborted = New-Object InvalidOperationException -ArgumentList (
        'Exception calling "GetResult" with "0" argument(s): "The WebSocket is in an invalid state (''Aborted'') for this operation."')
    Assert (Test-YtTransientInfrastructureFailure $rawAborted $server ([Threading.CancellationToken]::None)) `
        'The real wrapped invalid-state Aborted error is classified as transient infrastructure failure'
    # The same wrapper must never hide a real stop: cancellation takes a different rethrow branch
    # inside Invoke-YtCdp and has to keep propagating.
    $cancel = New-Object Threading.CancellationTokenSource
    $socket = New-Object YtWorkerTest.ProtocolSocket
    $socket.BlockReceive = $true
    $connection = [pscustomobject]@{Socket=$socket;NextId=0;CancellationToken=$cancel.Token}
    $cancel.CancelAfter(100)
    $failed = $false
    $failure = $null
    try { $null = & (Get-Module YtSummary) { param($c) Invoke-YtNavigationProbe $c 'fixture-session' 'return 1' } $connection }
    catch { $failed = $true; $failure = $_.Exception }
    Assert ($failed -and $failure -isnot [TimeoutException]) `
        'A user stop or job cancellation is still surfaced by the probe and never swallowed as a missed poll'
    $cancel.Dispose(); $cancel = $null
    # An unrelated page-script failure must still abort rather than silently poll forever.
    $failed = $false
    try {
        $null = & (Get-Module YtSummary) {
            function Invoke-YtPageScript { throw 'Page script failed: ReferenceError' }
            Invoke-YtNavigationProbe $null 'fixture-session' 'return 1'
        }
    } catch { $failed = $true }
    Assert $failed 'A genuine page-script error is still raised instead of being treated as a missed poll'
    $cancel = New-Object Threading.CancellationTokenSource
    $cancel.Cancel()
    $failed = $false
    try { $null = Open-YtCdp 'ws://127.0.0.1:1/devtools/browser/fixture' $cancel.Token } catch { $failed = $true }
    Assert $failed 'CDP connection startup honors a pre-cancelled shared token'
    $failed = $false
    try { $null = Open-YtCdp 'ws://example.invalid:9222/devtools/browser/fixture' } catch { $failed = $_.Exception.Message -like '*non-loopback*' }
    Assert $failed 'Non-loopback CDP endpoints are rejected before connecting'
    $cancel.Dispose(); $cancel = $null
    Write-Output "ALL $script:assertions worker assertions passed. No browser, external connection, clipboard, or real prompt was used."
} finally {
    foreach ($entry in $running) {
        try { $entry.PowerShell.Stop() } catch {}
        $entry.PowerShell.Dispose()
    }
    if ($null -ne $pool) { $pool.Dispose() }
    if ($null -ne $gate) { $gate.Dispose() }
    if ($null -ne $cancel) { $cancel.Dispose() }
    if (Test-Path -LiteralPath $testDirectory) { Remove-Item -LiteralPath $testDirectory -Recurse -Force }
}
