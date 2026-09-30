param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $HelperRoot 'YtSummary.psm1'
$journal = Join-Path $PSScriptRoot 'stuck-recovery-journal.json'
$assertions = 0
function Assert([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "FAILED: $Message" }
    $script:assertions++
    Write-Output "PASS: $Message"
}

Import-Module $modulePath -Force -DisableNameChecking
$module = Get-Module YtSummary
try {
    $infraAttempts = 0
    $infraResult = Invoke-YtWithInfrastructureRetry -Operation {
        $script:infraAttempts++
        if ($script:infraAttempts -lt 3) { throw 'An internal WebSocket error occurred.' }
        'recovered'
    }
    Assert ($infraResult -eq 'recovered' -and $infraAttempts -eq 3) 'transient infrastructure failure succeeds on its bounded third attempt'
    $result = & $module {
        param($Journal)
        $script:scenario = ''
        # Keep the production reconciliation window bounded for deterministic offline runs.
        Set-YtAmbiguousReconcileSeconds 1
        $script:phase = ''
        $script:inserted = ''
        $script:sends = 0
        $script:providerHost = 'chatgpt.com'
        $script:transcriptNavigations = @{}
        $script:backgroundWakeCount = 0
        $script:providerForegroundCalls = 0
        $script:totalProviderForegroundCalls = 0
        $script:missedPollCount = 0
        $transcriptSources = @(Get-YtTranscriptSourceDomains)
        $titleJob = [pscustomobject]@{Id='title-fixture';Title=''}
        Set-YtJobTitle $null $titleJob "  Fixture`nvideo   title  "
        $normalizedTitle = $titleJob.Title
        function Start-Sleep {
            param($Milliseconds)
            if ($script:scenario -eq 'verification-failure') {
                [Threading.Thread]::Sleep([Math]::Min(250, $Milliseconds))
            }
        }
        function New-YtBrowserTab {
            param($Connection,$Url,[switch]$Background)
            $script:phase = if ($Url -match '^https://www\.youtube\.com/watch') { 'title' } else { 'transcript' }
            return [pscustomobject]@{SessionId=$script:scenario;TargetId=$script:scenario}
        }
        function Invoke-YtNavigationProbe {
            param($Connection,$SessionId,$Expression)
            if ($Expression -match 'KNOWN_HOSTS' -and
                $script:scenario -in @('verification-failure','verification-native')) {
                return [pscustomobject]@{
                    url="https://youtubetotranscript.com/transcript?v=$script:videoId"
                    count=0;text='';ready='complete';challenge=$true;failure=''
                }
            }
            if ($Expression -match 'captionsAvailable') {
                $script:phase = 'native'
                if ($script:scenario -eq 'verification-native') {
                    return [pscustomobject]@{
                        url="https://www.youtube.com/watch?v=$script:videoId"
                        count=3;text='Native YouTube transcript.';ready='complete';challenge=$false
                        failure='';unavailable=$false;action='';captionsAvailable=$true;phase='transcript-ready'
                    }
                }
                return [pscustomobject]@{
                    url="https://www.youtube.com/watch?v=$script:videoId"
                    count=0;text='';ready='complete';challenge=$false
                    failure='';unavailable=$false;action='';captionsAvailable=$true
                    phase='entry-missing-with-captions'
                }
            }
            if ($script:phase -eq 'title') {
                return [pscustomobject]@{
                    url='https://www.youtube.com/watch?v=success0001';ready='complete'
                    videoTitle='Automatically discovered title';challenge=$false
                }
            }
            if ($script:phase -eq 'transcript') {
                if ($script:scenario -eq 'transcript-missed-poll' -and $script:missedPollCount -lt 2) {
                    $script:missedPollCount++
                    return $null
                }
                if ($script:scenario -in @('verification-failure','verification-native')) {
                    return [pscustomobject]@{
                        url="https://youtubetotranscript.com/transcript?v=$script:videoId"
                        count=0;text='';ready='complete';challenge=$true;failure=''
                    }
                }
                if ($script:scenario -eq 'background-transcript' -and $script:backgroundWakeCount -eq 0) {
                    return [pscustomobject]@{
                        url='https://youtubetotranscript.com/transcript?v=success0001'
                        count=0;text='';ready='loading';challenge=$false;failure=''
                    }
                }
                return [pscustomobject]@{
                    url='https://youtubetotranscript.com/transcript?v=success0001'
                    count=3
                    text=$(if($script:scenario -eq 'ambiguous-multipart'){
                        ('A detailed statement with numbers and facts. ' * 2000).Substring(0,74522)
                    }else{'Independent transcript.'})
                    ready='complete';challenge=$false;failure=''
                }
            }
            if ($script:phase -eq 'native') {
                if ($script:scenario -eq 'verification-native') {
                    return [pscustomobject]@{
                        url="https://www.youtube.com/watch?v=$script:videoId"
                        count=3;text='Native YouTube transcript.';ready='complete';challenge=$false
                        failure='';unavailable=$false;action=''
                    }
                }
                return [pscustomobject]@{
                    url="https://www.youtube.com/watch?v=$script:videoId"
                    count=0;text='';ready='complete';challenge=$false
                    failure='';unavailable=$false;action='';captionsAvailable=$true
                    phase='entry-missing-with-captions'
                }
            }
            $sent = $script:phase -eq 'sent'
            $baseUrl = switch ($script:providerHost) {
                'gemini.google.com' { 'https://gemini.google.com/app' }
                'claude.ai' { 'https://claude.ai/new' }
                default { 'https://chatgpt.com/' }
            }
            $conversationUrl = switch ($script:providerHost) {
                'gemini.google.com' { 'https://gemini.google.com/app/independent' }
                'claude.ai' { 'https://claude.ai/chat/independent' }
                default { 'https://chatgpt.com/c/independent' }
            }
            if ($script:phase -eq 'generating') {
                # The provider accepted the prompt and started generating even though the send
                # command itself reported a transport failure.
                $script:generatingPolls++
                if ($script:generatingPolls -lt 2) {
                    return [pscustomobject]@{
                        kind='ready';url=$baseUrl;text='';busy=$true;canSend=$false
                        messageCount=1;lastMessage='';assistantMessageCount=0;lastAssistantText=''
                        failureKind='';failureMessage=''
                    }
                }
                $script:phase = 'sent'
                $sent = $true
            }
            if ($script:scenario -eq 'background-composer' -and -not $sent -and
                -not $script:inserted -and $script:backgroundWakeCount -eq 0) {
                return [pscustomobject]@{
                    kind='waiting';url=$baseUrl;text='';busy=$false;canSend=$false
                    messageCount=0;lastMessage='';assistantMessageCount=0;lastAssistantText=''
                    failureKind='';failureMessage=''
                }
            }
            $stuck = (($script:scenario -eq 'reply-timeout' -and
                $script:providerHost -eq $script:replyTimeoutFirstHost) -or
                ($script:scenario -eq 'background-suspended' -and $script:backgroundWakeCount -eq 0)) -and $sent
            if ($stuck) {
                return [pscustomobject]@{
                    kind='ready';url=$baseUrl.TrimEnd('/') + '/chat/independent'
                    text='';busy=$true;canSend=$false
                    messageCount=1;lastMessage=$script:inserted
                    assistantMessageCount=0;lastAssistantText=''
                    failureKind='';failureMessage=''
                }
            }
            $assistantText = if ($script:scenario -eq 'full-fidelity' -and $sent) {
                if ($script:scenarioSends -eq 1) { 'Independent' } else { 'Independent transcript.' }
            } elseif ($script:scenario -eq 'usage-reply' -and $sent -and $script:scenarioSends -eq 1) {
                # No valid answer has arrived yet on this attempt; a banner here must still rotate.
                ''
            } elseif ($sent) { 'Independent summary.' } else { '' }
            $result = [pscustomobject]@{
                kind='ready';url=$(if($sent){$conversationUrl}else{$baseUrl})
                text=$(if($sent){''}else{$script:inserted});busy=$false;canSend=(-not $sent -and [bool]$script:inserted)
                messageCount=[int]$sent
                lastMessage=$(if($sent -and $script:scenario -ne 'assistant-reconcile'){$script:inserted}else{''})
                assistantMessageCount=[int]$sent;lastAssistantText=$assistantText
                failureKind='';failureMessage=''
            }
            if ($script:scenario -eq 'usage-reply' -and $sent -and $script:scenarioSends -eq 1) {
                $script:usagePolls++
                if ($script:usagePolls -gt 1) {
                    $result.failureKind = 'usage'
                    $result.failureMessage = 'Too many requests. You are making requests too quickly.'
                }
            }
            if ($script:scenario -eq 'usage-with-answer' -and $sent -and $script:scenarioSends -eq 1) {
                # A real, stable answer has already rendered; a co-occurring banner must not
                # discard it, so no rotation and no second send should ever happen here.
                $script:usageAnswerPolls++
                if ($script:usageAnswerPolls -gt 1) {
                    $result.failureKind = 'usage'
                    $result.failureMessage = 'Too many requests. You are making requests too quickly.'
                }
            }
            if ($script:scenario -eq 'background-send-ready' -and -not $sent -and
                $script:inserted -and $script:backgroundWakeCount -eq 0) {
                $result.canSend = $false
            }
            return $result
        }
        function Invoke-YtCdp {
            param($Connection,$Method,$Parameters,$SessionId)
            if ($Method -eq 'Page.navigate') {
                if ($Parameters.url -match 'youtubetotranscript\.com|youtube-transcript\.io|youtube-transcript\.ai') {
                    $script:transcriptNavigations[$script:scenario] = 1 + [int]$script:transcriptNavigations[$script:scenario]
                    $script:phase = 'transcript'
                } elseif ($Parameters.url -match '^https://www\.youtube\.com/watch') {
                    $script:phase = 'native'
                } else {
                    $script:phase = 'chat'
                    $script:inserted = ''
                    $script:providerHost = ([Uri]$Parameters.url).Host
                    if ($script:scenario -eq 'reply-timeout' -and -not $script:replyTimeoutFirstHost) {
                        $script:replyTimeoutFirstHost = $script:providerHost
                    }
                }
                return [pscustomobject]@{frameId='fixture'}
            }
            if ($Method -eq 'Input.insertText') { $script:inserted=$Parameters.text; return [pscustomobject]@{} }
            if ($Method -eq 'Page.setWebLifecycleState' -or $Method -eq 'Emulation.setFocusEmulationEnabled') {
                # Provider tabs must be revived without activating them, so these focus-free
                # hints are what counts as a wake for provider stages.
                if ($Method -eq 'Page.setWebLifecycleState' -and (
                    ($script:scenario -eq 'background-suspended' -and $script:phase -eq 'sent') -or
                    ($script:scenario -eq 'background-composer' -and $script:phase -eq 'chat') -or
                    ($script:scenario -eq 'background-send-ready' -and $script:phase -eq 'chat' -and $script:inserted))) {
                    $script:backgroundWakeCount++
                }
                return [pscustomobject]@{}
            }
            if ($Method -eq 'Page.bringToFront') {
                if ($script:phase -in @('chat','sent','generating')) {
                    $script:providerForegroundCalls++
                    $script:totalProviderForegroundCalls++
                }
                if ($script:scenario -eq 'background-transcript' -and $script:phase -eq 'transcript') {
                    $script:backgroundWakeCount++
                }
                return [pscustomobject]@{}
            }
            if ($Method -eq 'Target.closeTarget') {
                $script:closedTargets = 1 + [int]$script:closedTargets
                return [pscustomobject]@{success=$true}
            }
            throw "Unexpected command $Method"
        }
        function Focus-YtComposer { param($Connection,$SessionId,[string]$ProviderName) }
        function Send-YtComposer {
            param($Connection,$SessionId,$ExpectedText,[string]$ProviderName)
            $script:sends++
            $script:scenarioSends++
            if ($script:scenario -eq 'ambiguous-resend' -and $script:scenarioSends -eq 1) {
                throw 'An internal WebSocket error occurred.'
            }
            if ($script:scenario -eq 'ambiguous-multipart' -and $script:scenarioSends -eq 2) {
                throw 'Session with given id not found.'
            }
            if ($script:scenario -eq 'wraparound-resend' -and $script:scenarioSends -le 3) {
                throw 'An internal WebSocket error occurred.'
            }
            if ($script:scenario -eq 'assistant-reconcile' -and $script:scenarioSends -eq 1) {
                $script:phase='sent'
                throw 'An internal WebSocket error occurred.'
            }
            if ($script:scenario -eq 'ambiguous-generating' -and $script:scenarioSends -eq 1) {
                $script:phase='generating'
                throw 'An internal WebSocket error occurred.'
            }
            $script:phase='sent'
        }
        function Invoke-One([string]$Scenario,[string]$VideoId,$ProviderGates=$null) {
            $script:scenario=$Scenario
            $script:videoId=$VideoId
            $script:phase='transcript'
            $script:inserted=''
            $script:scenarioSends=0
            $script:replyTimeoutFirstHost=$null
            $script:closedTargets=0
            $script:backgroundWakeCount=0
            $script:providerForegroundCalls=0
            $script:generatingPolls=0
            $script:usagePolls=0
            $script:usageAnswerPolls=0
            $script:missedPollCount=0
            $job=[pscustomobject]@{
                Id=$Scenario;RequestId=[guid]::NewGuid().ToString();VideoId=$VideoId;State='queued'
                StageIndex=0;SuccessfulParts=0;ProviderName='';RotationCursor=0;Progress=''
                TranscriptHash='';TranscriptLength=0;ChunkCount=0
            }
            if ($Scenario -eq 'full-fidelity') { $job | Add-Member SummaryLevel full }
            $server=[pscustomobject]@{Job=$job;StopRequested=$false;IsRunning=$true;LastServerError='';DispatchPaused=$false;Message='';ResultUrl='';FinalResult='';AmbiguousSaves=0;UsagePauses=0}
            $server | Add-Member ScriptMethod UpdateJob {param($Id,$State,$Message)$this.Job.State=$State;$this.Message=$Message}
            $server | Add-Member ScriptMethod SetResultUrl {param($Id,$Url)$this.ResultUrl=$Url}
            $server | Add-Member ScriptMethod SetFinalResult {param($Id,$Text)$this.FinalResult=$Text}
            $server | Add-Member ScriptMethod SetAmbiguousSend {param($Id,$TargetId,$Hash)$this.AmbiguousSaves++}
            $server | Add-Member ScriptMethod PauseForUsageLimit {param($Reason)$this.UsagePauses++}
            $server | Add-Member ScriptMethod AddPartResultUrl {param($Id,$Url) }
            $server | Add-Member ScriptMethod ClearJobPartResultUrls {param($Id) }
            Invoke-YtSummaryJob $null $server $job -JournalPath $Journal -WaitSeconds 1 `
                -ProviderGates $ProviderGates -WarningAction SilentlyContinue
            return [pscustomobject]@{
                State=$job.State;Message=$server.Message;FinalResult=$server.FinalResult
                ResultUrl=$server.ResultUrl;SuccessfulParts=$job.SuccessfulParts;ChunkCount=$job.ChunkCount
                ScenarioSends=$script:scenarioSends;AmbiguousSaves=$server.AmbiguousSaves
                ClosedTargets=$script:closedTargets;UsagePauses=$server.UsagePauses
            }
        }
        $failed = Invoke-One 'verification-failure' 'verify00001'
        $nativeFallback = Invoke-One 'verification-native' 'native00001'
        $successful = Invoke-One 'independent-success' 'success0001'
        $missedPoll = Invoke-One 'transcript-missed-poll' 'success0001'
        $missedPollCount = $script:missedPollCount
        $successfulSends = $successful.ScenarioSends
        $gates=@{}
        foreach($name in @('ChatGPT','Gemini','Claude')){$gates[$name]=[Threading.SemaphoreSlim]::new(1,1)}
        try {
            $resent = Invoke-One 'ambiguous-resend' 'success0001' $gates
            $wrapped = Invoke-One 'wraparound-resend' 'success0001' $gates
            $assistantReconciled = Invoke-One 'assistant-reconcile' 'success0001' $gates
            $generatingReconciled = Invoke-One 'ambiguous-generating' 'success0001' $gates
            $multipartResent = Invoke-One 'ambiguous-multipart' 'success0001' $gates
            $sendsBeforeTimeout = $script:sends
            $timedOut = Invoke-One 'reply-timeout' 'success0001' $gates
            $timedOutSends = $script:sends - $sendsBeforeTimeout
            $timedOutClosedTargets = $script:closedTargets
            $usageRotated = Invoke-One 'usage-reply' 'success0001' $gates
            $usageAnswerWins = Invoke-One 'usage-with-answer' 'success0001' $gates
            $sendsBeforeFidelity = $script:sends
            $fidelity = Invoke-One 'full-fidelity' 'success0001' $gates
            $fidelitySends = $script:sends - $sendsBeforeFidelity
            $fidelityClosedTargets = $script:closedTargets
            $backgroundSuspended = Invoke-One 'background-suspended' 'success0001' $gates
            $backgroundWakeCount = $script:backgroundWakeCount
            $backgroundComposer = Invoke-One 'background-composer' 'success0001' $gates
            $backgroundComposerWakeCount = $script:backgroundWakeCount
            $backgroundSendReady = Invoke-One 'background-send-ready' 'success0001' $gates
            $backgroundSendReadyWakeCount = $script:backgroundWakeCount
            $backgroundTranscript = Invoke-One 'background-transcript' 'success0001' $gates
            $backgroundTranscriptWakeCount = $script:backgroundWakeCount
            $gateCounts = @($gates.Values | ForEach-Object { $_.CurrentCount })
        }
        finally { foreach($gate in $gates.Values){$gate.Dispose()} }
        [pscustomobject]@{
            Failed=$failed;NativeFallback=$nativeFallback;Successful=$successful;SuccessfulSends=$successfulSends;Resent=$resent
            Wrapped=$wrapped;AssistantReconciled=$assistantReconciled;MultipartResent=$multipartResent
            GeneratingReconciled=$generatingReconciled
            MissedPoll=$missedPoll;MissedPollCount=$missedPollCount
            Sends=$sendsBeforeTimeout
            VerificationRetries=[int]$script:transcriptNavigations['verification-failure']
            SuccessRetries=[int]$script:transcriptNavigations['independent-success']
            GateCounts=$gateCounts;TimedOut=$timedOut;TimedOutSends=$timedOutSends;TimedOutClosedTargets=$timedOutClosedTargets
            UsageRotated=$usageRotated
            UsageAnswerWins=$usageAnswerWins
            Fidelity=$fidelity;FidelitySends=$fidelitySends;FidelityClosedTargets=$fidelityClosedTargets
            BackgroundSuspended=$backgroundSuspended;BackgroundWakeCount=$backgroundWakeCount
            BackgroundComposer=$backgroundComposer;BackgroundComposerWakeCount=$backgroundComposerWakeCount
            BackgroundSendReady=$backgroundSendReady;BackgroundSendReadyWakeCount=$backgroundSendReadyWakeCount
            BackgroundTranscript=$backgroundTranscript;BackgroundTranscriptWakeCount=$backgroundTranscriptWakeCount
            NormalizedTitle=$normalizedTitle
            ProviderForegroundCalls=$script:totalProviderForegroundCalls
            TranscriptSourceUrls=@($transcriptSources | ForEach-Object { $_.UrlTemplate })
            AutomaticTitle=(Get-YtYouTubeVideoTitle $null 'success0001' -WaitSeconds 1)
        }
    } $journal
    Assert ($result.Failed.State -eq 'error' -and
        $result.Failed.Message -match 'timed out while looking for the transcript entry point even though YouTube reported caption tracks') `
        'a transcript-site verification challenge fails only after the native YouTube fallback is also exhausted'
    Assert ($result.NativeFallback.State -eq 'completed' -and $result.NativeFallback.ScenarioSends -eq 1) `
        'a persistent transcript-site verification challenge falls back to YouTube native captions and completes'
    Assert ($result.VerificationRetries -eq 0) 'with a single enabled transcript source there is no domain to fall back to, so no switch-navigation happens'
    Assert ($result.TranscriptSourceUrls.Count -eq 1 -and
        @($result.TranscriptSourceUrls | Where-Object { $_ -match 'youtube-transcript\.io|youtube-transcript\.ai' }).Count -eq 0) `
        'youtube-transcript.io and youtube-transcript.ai are fully excluded from transcript source rotation'
    Assert ($result.Successful.State -eq 'completed' -and $result.SuccessfulSends -eq 1) 'a second independent video completes after the first verification failure'
    Assert ($result.SuccessRetries -eq 0) 'the second video does not inherit poisoned transcript retry state'
    Assert ($result.MissedPoll.State -eq 'completed' -and $result.MissedPollCount -eq 2) `
        'a transcript poll that returns nothing is tolerated as a missed poll, and the loop keeps polling until a later poll succeeds'
    if ($result.Resent.State -ne 'completed' -or $result.Resent.ScenarioSends -ne 2) { Write-Output ($result | ConvertTo-Json -Depth 5) }
    Assert ($result.Resent.State -eq 'completed' -and $result.Resent.ScenarioSends -eq 2) 'an ambiguous provider send is automatically resent instead of entering needs-review'
    Assert ($result.Wrapped.State -eq 'completed' -and $result.Wrapped.ScenarioSends -eq 4 -and
        $result.Wrapped.ResultUrl -match '^https://') `
        'an ambiguous send on the final provider gets one bounded wraparound resend and completes with a result URL'
    Assert ($result.AssistantReconciled.State -eq 'completed' -and
        $result.AssistantReconciled.ScenarioSends -eq 1 -and $result.AssistantReconciled.ResultUrl -match '^https://') `
        'assistant generation reconciles an ambiguous send even when the submitted prompt is not exposed in the DOM'
    Assert ($result.GeneratingReconciled.State -eq 'completed' -and
        $result.GeneratingReconciled.ScenarioSends -eq 1 -and
        $result.GeneratingReconciled.ResultUrl -match '^https://') `
        'a provider that is already generating proves the ambiguous send landed, so the job completes without a resend'
    Assert ($result.MultipartResent.State -eq 'completed' -and
        $result.MultipartResent.SuccessfulParts -eq $result.MultipartResent.ChunkCount -and
        $result.MultipartResent.SuccessfulParts -gt 1 -and $result.MultipartResent.ResultUrl -match '^https://') `
        'a multipart ambiguous stage falls back and preserves completed-part progress through the final merge'
    Assert ($result.MultipartResent.AmbiguousSaves -eq 0) `
        'an ambiguous transcript part is never recorded as an attachable final summary conversation'
    Assert ($result.Resent.AmbiguousSaves -eq 1) `
        'an ambiguous final summary send records exactly one conversation for later reconciliation'
    Assert (@($result.GateCounts | Where-Object { $_ -ne 1 }).Count -eq 0) 'automatic resend releases every provider semaphore'
    Assert ($result.TimedOut.State -eq 'completed' -and $result.TimedOutSends -eq 2) 'a stalled reply on one provider automatically rotates to the next provider instead of erroring the job'
    Assert ($result.TimedOutClosedTargets -eq 1) 'the abandoned tab from a stalled reply is closed so it cannot deliver a duplicate answer alongside the next provider'
    Assert ($result.UsageRotated.State -eq 'completed' -and $result.UsageRotated.ScenarioSends -eq 2) `
        'a usage rejection while waiting for a reply rotates to the next enabled provider'
    Assert ($result.UsageRotated.ClosedTargets -eq 1) `
        'the rate-limited provider tab is closed before the next provider attempts the stage'
    Assert ($result.UsageAnswerWins.State -eq 'completed' -and $result.UsageAnswerWins.ScenarioSends -eq 1 -and
        $result.UsageAnswerWins.ClosedTargets -eq 0) `
        'a usage banner that co-occurs with an already-stable, genuine assistant answer completes with that answer instead of rotating'
    Assert ($result.Fidelity.State -eq 'completed' -and $result.FidelitySends -eq 2 -and
        $result.Fidelity.FinalResult -ceq 'Independent transcript.') 'a lossy Full response rotates to another provider and saves only the complete response'
    Assert ($result.FidelityClosedTargets -eq 1) 'the rejected lossy Full response tab is closed before fallback'
    Assert ($result.BackgroundSuspended.State -eq 'completed' -and $result.BackgroundWakeCount -ge 1) `
        'a background-suspended provider tab is activated and completes without user interaction'
    Assert ($result.BackgroundComposer.State -eq 'completed' -and $result.BackgroundComposerWakeCount -ge 1) `
        'a background-suspended composer is activated and becomes ready without user interaction'
    Assert ($result.BackgroundSendReady.State -eq 'completed' -and $result.BackgroundSendReadyWakeCount -ge 1) `
        'a background-suspended Send control is activated and becomes ready without user interaction'
    Assert ($result.BackgroundTranscript.State -eq 'completed' -and $result.BackgroundTranscriptWakeCount -ge 1) `
        'a background-suspended transcript tab is activated and completes without user interaction'
    Assert ($result.ProviderForegroundCalls -eq 0) `
        'no provider stage ever brings its tab to the foreground, so concurrent jobs cannot steal the browser view'
    Assert ($result.NormalizedTitle -ceq 'Fixture video title') `
        'transcript-discovered titles are normalized by the module-scope production helper'
    Assert ($result.AutomaticTitle -ceq 'Automatically discovered title') `
        'metadata lookup reads a real title without starting summary work'

    $sweep = & $module {
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $promptHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes('The exact stranded prompt.'))).Replace('-','').ToLowerInvariant() }
        finally { $sha.Dispose() }
        $script:sweepTabs = @()
        $script:sweepBusy = $false
        $script:sweepText = 'The exact stranded prompt.'
        function Invoke-YtCdp {
            param($Connection,$Method,$Parameters,$SessionId)
            if ($Method -eq 'Target.getTargets') {
                return [pscustomobject]@{targetInfos=$script:sweepTabs}
            }
            if ($Method -eq 'Target.attachToTarget') { return [pscustomobject]@{sessionId='session-' + $Parameters.targetId} }
            throw "Unexpected command $Method"
        }
        function Invoke-YtNavigationProbe {
            param($Connection,$SessionId,$Expression)
            return [pscustomobject]@{
                kind='ready';url='https://chatgpt.com/c/stranded';text='';busy=$script:sweepBusy;canSend=$false
                messageCount=1;lastMessage=$script:sweepText
                assistantMessageCount=1;lastAssistantText='The finished summary.'
                failureKind='';failureMessage=''
            }
        }
        function New-SweepServer {
            $server = [pscustomobject]@{StopRequested=$false;AttachedUrl='';AttachedAutomatically=$false;Completions=@()}
            $server | Add-Member ScriptMethod AttachJobResult {
                param($Id,$Url,$Automatic)
                $this.AttachedUrl=$Url;$this.AttachedAutomatically=[bool]$Automatic
                return [pscustomobject]@{Id=$Id;ResultUrl=$Url}
            }
            $server | Add-Member ScriptMethod CompleteAmbiguousReconcile {
                param($Id,$Reconciled,$RetryLater)
                $this.Completions += [pscustomobject]@{Id=$Id;Reconciled=[bool]$Reconciled;RetryLater=[bool]$RetryLater}
            }
            return $server
        }
        $matchedJob = [pscustomobject]@{Id='sweep-target';VideoId='success0001';AmbiguousTargetId='tab-a';AmbiguousTextSha256=''}
        $script:sweepTabs = @(
            [pscustomobject]@{type='page';targetId='other';url='https://www.youtube.com/watch?v=success0001'}
            [pscustomobject]@{type='page';targetId='tab-a';url='https://chatgpt.com/c/stranded'}
        )
        $matchedServer = New-SweepServer
        $matched = Invoke-YtAmbiguousTabRecovery $null $matchedServer $matchedJob

        $hashJob = [pscustomobject]@{Id='sweep-hash';VideoId='success0001';AmbiguousTargetId='';AmbiguousTextSha256=$promptHash}
        $script:sweepTabs = @([pscustomobject]@{type='page';targetId='tab-b';url='https://chatgpt.com/c/stranded'})
        $hashServer = New-SweepServer
        $hashed = Invoke-YtAmbiguousTabRecovery $null $hashServer $hashJob

        $strangerJob = [pscustomobject]@{Id='sweep-stranger';VideoId='success0001';AmbiguousTargetId='tab-z';AmbiguousTextSha256='f' * 64}
        $strangerServer = New-SweepServer
        $stranger = Invoke-YtAmbiguousTabRecovery $null $strangerServer $strangerJob

        $script:sweepBusy = $true
        $script:sweepTabs = @([pscustomobject]@{type='page';targetId='tab-a';url='https://chatgpt.com/c/stranded'})
        $busyServer = New-SweepServer
        $busy = Invoke-YtAmbiguousTabRecovery $null $busyServer $matchedJob

        [pscustomobject]@{
            Matched=$matched;MatchedUrl=$matchedServer.AttachedUrl;MatchedAutomatic=$matchedServer.AttachedAutomatically
            MatchedCompletions=$matchedServer.Completions
            Hashed=$hashed;HashedUrl=$hashServer.AttachedUrl
            Stranger=$stranger;StrangerUrl=$strangerServer.AttachedUrl;StrangerCompletions=$strangerServer.Completions
            Busy=$busy;BusyUrl=$busyServer.AttachedUrl;BusyCompletions=$busyServer.Completions
            NonConversation=(Get-YtConversationUrl 'https://chatgpt.com/' 'ChatGPT')
            Canonical=(Get-YtConversationUrl 'https://chatgpt.com/c/abc123?utm=1' 'ChatGPT')
            ForeignHost=(Get-YtConversationUrl 'https://chatgpt.com/c/abc123' 'Claude')
        }
    }
    Assert ($sweep.Matched -and $sweep.MatchedUrl -ceq 'https://chatgpt.com/c/stranded' -and $sweep.MatchedAutomatic) `
        'a stranded ambiguous job is reconciled automatically from its own still-open provider tab'
    Assert (@($sweep.MatchedCompletions).Count -eq 1 -and @($sweep.MatchedCompletions)[0].Reconciled) `
        'an automatic reconciliation reports success exactly once and never queues a manual prompt'
    Assert ($sweep.Hashed -and $sweep.HashedUrl -ceq 'https://chatgpt.com/c/stranded') `
        'a conversation whose first message hashes to the stranded prompt is safe evidence even after the tab id is lost'
    Assert (-not $sweep.Stranger -and -not $sweep.StrangerUrl -and
        @($sweep.StrangerCompletions).Count -eq 1 -and -not @($sweep.StrangerCompletions)[0].Reconciled) `
        'an unrelated conversation is never attached, and the job falls back to the manual link'
    Assert (-not $sweep.Busy -and -not $sweep.BusyUrl -and @($sweep.BusyCompletions)[0].RetryLater) `
        'a conversation that is still generating is not attached yet and stays eligible for a later sweep'
    Assert (-not @($sweep.StrangerCompletions)[0].RetryLater) `
        'a video with no matching conversation is not kept in the sweep queue forever'
    Assert (-not $sweep.NonConversation -and $sweep.Canonical -ceq 'https://chatgpt.com/c/abc123' -and -not $sweep.ForeignHost) `
        'only canonical same-provider conversation URLs are accepted as result links'
} finally {
    if (Test-Path -LiteralPath $journal) { Remove-Item -LiteralPath $journal -Force }
}
Write-Output "ALL $assertions stuck-recovery assertions passed. No browser or network was used."
