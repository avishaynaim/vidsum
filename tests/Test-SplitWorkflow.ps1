param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$journal = Join-Path $PSScriptRoot 'split-workflow-journal.json'
$assertions = 0
function Assert([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "FAILED: $Message" }
    $script:assertions++
    Write-Output "PASS: $Message"
}

$scenarios = @('single','split','split-rerun','split-partial-resume','parallel-native','parallel-service-wins','parallel-both-fail','hierarchical','quota','size-rejection','disconnect','no-progress','existing-chat','part-draft','part-edited','part-busy','delayed-navigation','keep-tabs-split','title-match','title-mismatch')
foreach ($level in @('ultra','max','reg','min','micro')) {
    foreach ($kind in @('single','split','hierarchical')) { $scenarios += "level-$level-$kind" }
}
$scenarios += @('level-full-single', 'level-full-split', 'level-full-split-rerun')
foreach ($scenario in $scenarios) {
    Import-Module (Join-Path $HelperRoot 'YtSummary.psm1') -Force -DisableNameChecking
    $module = Get-Module YtSummary
    $gate = New-Object Threading.SemaphoreSlim -ArgumentList 1, 1
    try {
        $result = & $module {
            param($Scenario,$Journal,$Gate)
            $script:scenario = $Scenario
            $script:journalPath = $Journal
            $script:pages = @{}
            $script:nextTarget = 0
            $script:navigations = 0
            $script:sent = New-Object 'Collections.Generic.List[string]'
            $script:closed = New-Object 'Collections.Generic.List[string]'
            $script:outsideGateReads = 0
            $script:nativeSawServiceOpen = $false
            $script:nativeProbes = 0
            $script:failureInjected = $false
            $script:transcript = if ($Scenario -in @('single','parallel-native','parallel-service-wins','parallel-both-fail','existing-chat','title-match','title-mismatch') -or $Scenario -like 'level-*-single') { 'A short transcript with facts.' }
                else { ('A detailed statement with numbers and facts. ' * 2000).Substring(0,74522) }
            function Start-Sleep { param($Milliseconds) }
            function New-YtBrowserTab {
                param($Connection,$Url,[switch]$Background)
                $script:nextTarget++
                $id = 'target' + $script:nextTarget
                $phase = if ($Url -like '*youtubetotranscript*') { 'transcript' }
                    elseif ($Url -like 'https://www.youtube.com/watch*') { 'youtube' }
                    else { 'blank' }
                $script:pages[$id] = [pscustomobject]@{Phase=$phase;Input='';User='';Answer='';Failure='';Polls=0;Conversation=0;StaleUser='';StaleRemaining=0}
                return [pscustomobject]@{TargetId=$id;SessionId=$id}
            }
            function Invoke-YtCdp {
                param($Connection,$Method,$Parameters,$SessionId)
                if ($Method -eq 'Target.closeTarget') { $script:closed.Add($Parameters.targetId); return [pscustomobject]@{success=$true} }
                $page = $script:pages[$SessionId]
                switch ($Method) {
                    'Page.bringToFront' { if($Gate.CurrentCount -ne 0){throw 'Focus changed outside gate'};return [pscustomobject]@{} }
                    'Page.navigate' {
                        $script:navigations++
                        if ($script:scenario -eq 'delayed-navigation' -and $page.User) { $page.StaleUser=$page.User;$page.StaleRemaining=1 }
                        $page.Phase='chat';$page.Input='';$page.User='';$page.Answer='';$page.Failure='';$page.Polls=0
                        $page.Conversation++
                        return [pscustomobject]@{frameId='fixture'}
                    }
                    'Input.insertText' { if($Gate.CurrentCount -ne 0){throw 'Input outside gate'};$page.Input=$Parameters.text;return [pscustomobject]@{} }
                    default { throw "Unexpected command $Method" }
                }
            }
            function Invoke-YtNavigationProbe {
                param($Connection,$SessionId,$Expression)
                $page = $script:pages[$SessionId]
                if ($page.Phase -eq 'transcript') {
                    if ($script:scenario -in @('parallel-native','parallel-both-fail')) {
                        return [pscustomobject]@{url='https://youtubetotranscript.com/transcript?v=BWMe84H0CEg';count=0;text='';ready='complete';challenge=$false;failure='YouTube blocked the transcript service.'}
                    }
                    if ($script:scenario -eq 'parallel-service-wins' -and $script:nativeProbes -eq 0) {
                        return [pscustomobject]@{url='https://youtubetotranscript.com/transcript?v=BWMe84H0CEg';count=0;text='';ready='complete';challenge=$false;failure=''}
                    }
                    $siteTitle = if ($script:scenario -eq 'title-mismatch') { 'My Cooking Channel: Best Pasta Recipe' }
                        elseif ($script:scenario -eq 'title-match') { 'How Neural Networks Actually Work' } else { '' }
                    return [pscustomobject]@{url='https://youtubetotranscript.com/transcript?v=BWMe84H0CEg';count=100;text=$script:transcript;ready='complete';challenge=$false;videoTitle=$siteTitle}
                }
                if ($page.Phase -eq 'youtube') {
                    if ($Expression.Contains('caption-track-waiting')) {
                        return [pscustomobject]@{
                            url='https://www.youtube.com/watch?v=BWMe84H0CEg';count=0;text=''
                            failure='Fixture direct caption track unavailable.';retryable=$false
                            unavailable=$false;captionsAvailable=$true;phase='caption-track-error'
                        }
                    }
                    if ($Gate.CurrentCount -ne 0) { throw 'Native transcript controls ran outside the browser gate.' }
                    $script:nativeProbes++
                    $script:nativeSawServiceOpen = -not $script:closed.Contains('target1')
                    if ($script:scenario -eq 'parallel-both-fail') {
                        return [pscustomobject]@{
                            url='https://www.youtube.com/watch?v=BWMe84H0CEg';count=0;text=''
                            ready='complete';challenge=$false;failure='YouTube native transcript fixture failed.'
                            unavailable=$false;action='';captionsAvailable=$true;phase='panel-empty'
                        }
                    }
                    if ($script:scenario -eq 'parallel-service-wins') {
                        return [pscustomobject]@{
                            url='https://www.youtube.com/watch?v=BWMe84H0CEg';count=0;text=''
                            ready='complete';challenge=$false;failure='';unavailable=$false;action=''
                            captionsAvailable=$true;phase='panel-loading'
                        }
                    }
                    return [pscustomobject]@{
                        url='https://www.youtube.com/watch?v=BWMe84H0CEg';count=100;text=$script:transcript
                        ready='complete';challenge=$false;failure='';unavailable=$false;action=''
                        captionsAvailable=$true;phase='transcript-ready'
                    }
                }
                $isSent = $page.Phase -eq 'sent'
                if (-not $isSent -and $page.StaleRemaining -gt 0) {
                    $page.StaleRemaining--
                    return [pscustomobject]@{
                        kind='ready';url='https://chatgpt.com/c/previous';text='';busy=$false;canSend=$false
                        messageCount=1;lastMessage=$page.StaleUser;assistantMessageCount=1
                        lastAssistantText='Prior answer';failureKind='';failureMessage=''
                    }
                }
                $betweenParts = $isSent -and $script:job.State -eq 'waiting-composer' -and $script:sent.Count -eq 1
                if ($betweenParts -and $script:scenario -eq 'part-draft') { $page.Input='An unsaved user draft.' }
                if ($betweenParts -and $script:scenario -eq 'part-edited') { $page.User='A different conversation message.' }
                if ($isSent -and $script:job.State -eq 'summarizing') {
                    if ($Gate.CurrentCount -ne 1) { throw 'Assistant generation held the shared composer gate.' }
                    $script:outsideGateReads++
                }
                $page.Polls++
                $failure = if ($page.Failure -eq 'size') { 'The message you submitted was too long, please edit it and resubmit.' }
                    elseif ($page.Failure -eq 'usage') { 'You have reached your usage limit.' } else { '' }
                return [pscustomobject]@{
                    kind='ready';url=$(if($isSent){"https://chatgpt.com/c/$SessionId-c$($page.Conversation)"}else{'https://chatgpt.com/'});text=$page.Input
                    busy=(($isSent -and $page.Polls -le 2) -or ($betweenParts -and $script:scenario -eq 'part-busy'));canSend=($page.Input.Length -gt 0)
                    messageCount=$(if($script:scenario -eq 'existing-chat'){1}else{[int]$isSent});lastMessage=$page.User
                    assistantMessageCount=[int]$isSent;lastAssistantText=$page.Answer
                    failureKind=$page.Failure;failureMessage=$failure
                }
            }
            function Focus-YtComposer {
                param($Connection,$SessionId)
                if($Gate.CurrentCount -ne 0){throw 'Focus outside gate'}
            }
            function Send-YtComposer {
                param($Connection,$SessionId,$ExpectedText)
                if($Gate.CurrentCount -ne 0){throw 'Send outside gate'}
                $page = $script:pages[$SessionId]
                if ($page.User) { throw 'The same stage was sent twice.' }
                if ($page.Input -cne $ExpectedText) { throw 'Incorrect stage prompt.' }
                $record = Get-Content -LiteralPath $script:journalPath -Raw | ConvertFrom-Json
                if (-not $record.stage -or $record.targetId -ne $SessionId) { throw 'Stage journal metadata is missing.' }
                $script:sent.Add($ExpectedText)
                if (($script:scenario -eq 'disconnect' -or $script:scenario -eq 'split-partial-resume') -and
                    $script:sent.Count -eq 2 -and -not $script:failureInjected) {
                    $script:failureInjected = $true
                    throw 'Disconnected during part 2.'
                }
                $page.User=$ExpectedText
                $page.Input=''
                $page.Phase='sent'
                $page.Polls=0
                if ($script:scenario -eq 'size-rejection') { $page.Failure='size';$page.Answer='This must not become summary notes.';return }
                if ($script:scenario -eq 'quota' -and $script:sent.Count -eq 2) { $page.Failure='usage';$page.Answer='This must not become summary notes.';return }
                if ($script:scenario -like 'level-full-*') {
                    $source = [regex]::Match($ExpectedText,
                        '(?s)--- BEGIN (?:SOURCE PART \d+/\d+|TRANSCRIPT) ---\r?\n(.*?)\r?\n--- END (?:SOURCE PART|TRANSCRIPT) ---')
                    if (-not $source.Success) { throw 'Full fixture could not find the source boundary.' }
                    $page.Answer = $source.Groups[1].Value
                    return
                }
                $isPart=$ExpectedText.StartsWith('Summarize part ')
                if (($script:scenario -in @('hierarchical','no-progress') -or $script:scenario -like 'level-*-hierarchical') -and $isPart) {
                    $page.Answer="Notes for $SessionId. " + ('x' * 9000)
                } elseif ($script:scenario -eq 'no-progress') {
                    $page.Answer='y' * 22000
                } else {
                    $page.Answer="Grounded summary from $SessionId conversation $($page.Conversation)."
                }
            }
            $script:job = [pscustomobject]@{
                Id=[Guid]::NewGuid().ToString('D');RequestId=[Guid]::NewGuid().ToString('D')
                VideoId='BWMe84H0CEg';State='queued';StageIndex=0;SuccessfulParts=0
                ProviderName='ChatGPT';RotationCursor=0;Progress='';TranscriptHash=''
                TranscriptLength=0;ChunkCount=0
            }
            if ($Scenario -in @('title-match','title-mismatch')) {
                $script:job | Add-Member -NotePropertyName Title -NotePropertyValue 'How Neural Networks Actually Work'
            }
            if ($Scenario -like 'level-*') {
                $script:job | Add-Member -NotePropertyName SummaryLevel -NotePropertyValue ($Scenario.Split('-')[1])
            }
            $server = [pscustomobject]@{Job=$script:job;StopRequested=$false;IsRunning=$true;LastServerError='';DispatchPaused=$false;PauseReason='';ResultUrl='';FinalResult='';Message='';PartResultUrls=(New-Object 'Collections.Generic.List[string]');PartCheckpoint=$null}
            $server | Add-Member ScriptMethod UpdateJob {param($Id,$State,$Message) $this.Job.State=$State;$this.Message=$Message}
            $server | Add-Member ScriptMethod PauseForUsageLimit {param($Reason) $this.DispatchPaused=$true;$this.PauseReason=$Reason}
            $server | Add-Member ScriptMethod SetResultUrl {param($Id,$Url) $this.ResultUrl=$Url}
            $server | Add-Member ScriptMethod SetFinalResult {param($Id,$Text) $this.FinalResult=$Text}
            $server | Add-Member ScriptMethod AddPartResultUrl {
                param($Id,$Url)
                if (-not $this.PartResultUrls.Contains($Url)) { $this.PartResultUrls.Add($Url) }
            }
            $script:tabsBeforeClearCalls = New-Object 'Collections.Generic.List[int]'
            $server | Add-Member ScriptMethod ClearJobPartResultUrls {
                param($Id)
                $script:tabsBeforeClearCalls.Add($script:nextTarget - $script:runStartTabs)
                $this.PartResultUrls.Clear()
            }
            $server | Add-Member ScriptMethod GetPartCheckpoint { param($Id) return $this.PartCheckpoint }
            $server | Add-Member ScriptMethod ResetPartCheckpoint {
                param($Id,$Hash,$Length,$Count,$Level,$PlanHash,$Provider,$Cursor)
                $this.PartCheckpoint = [pscustomobject]@{
                    TranscriptHash=$Hash;TranscriptLength=$Length;ChunkCount=$Count
                    SummaryLevel=$Level;PlanHash=$PlanHash;Parts=(New-Object 'Collections.Generic.List[object]')
                }
                $this.PartResultUrls.Clear()
                $this.Job.StageIndex=0;$this.Job.SuccessfulParts=0;$this.Job.ProviderName=$Provider
                $this.Job.RotationCursor=$Cursor;$this.Job.TranscriptHash=$Hash
                $this.Job.TranscriptLength=$Length;$this.Job.ChunkCount=$Count
            }
            $server | Add-Member ScriptMethod SavePartCheckpoint {
                param($Id,$Index,$Text,$Url,$Provider,$Cursor)
                if ($this.PartCheckpoint.Parts.Count -ne $Index) { throw 'Non-sequential fixture checkpoint.' }
                $this.PartCheckpoint.Parts.Add([pscustomobject]@{Text=$Text;ResultUrl=$Url;ProviderName=$Provider})
                if ($Url -and -not $this.PartResultUrls.Contains($Url)) { $this.PartResultUrls.Add($Url) }
                $this.Job.StageIndex=$Index+1;$this.Job.SuccessfulParts=$Index+1
                $this.Job.ProviderName=$Provider;$this.Job.RotationCursor=$Cursor
            }
            if ($Scenario -eq 'keep-tabs-split') {
                $server | Add-Member -NotePropertyName KeepIntermediateTabs -NotePropertyValue $true
            }
            $script:runStartTabs = 0
            Invoke-YtSummaryJob -Connection $null -Server $server -Job $script:job -JournalPath $Journal -ComposerGate $Gate -WaitSeconds 5 -WarningAction SilentlyContinue
            $firstRunPartResultUrls = $server.PartResultUrls.ToArray()
            $firstRunPrompts = $script:sent.ToArray()
            if ($Scenario -eq 'split-partial-resume') {
                $script:job.State = 'queued'
                $script:sent.Clear(); $script:closed.Clear(); $script:navigations = 0
                $script:runStartTabs = $script:nextTarget
                Invoke-YtSummaryJob -Connection $null -Server $server -Job $script:job -JournalPath $Journal -ComposerGate $Gate -WaitSeconds 5 -WarningAction SilentlyContinue
            }
            if ($Scenario -in @('split-rerun','level-full-split-rerun')) {
                # Simulates "Retry from checkpoint" (or any restart) on a job that already
                # recorded part links from an earlier, now-abandoned attempt: the job goes back
                # to 'queued' and every part is resent from scratch, into brand-new conversations.
                $script:job.State = 'queued'
                $script:sent.Clear(); $script:closed.Clear(); $script:navigations = 0
                $script:runStartTabs = $script:nextTarget
                Invoke-YtSummaryJob -Connection $null -Server $server -Job $script:job -JournalPath $Journal -ComposerGate $Gate -WaitSeconds 5 -WarningAction SilentlyContinue
            }
            return [pscustomobject]@{
                State=$script:job.State;Message=$server.Message;Paused=$server.DispatchPaused;ResultUrl=$server.ResultUrl;FinalResult=$server.FinalResult
                Prompts=$script:sent.ToArray();Closed=$script:closed.Count;Targets=$script:nextTarget
                Navigations=$script:navigations
                PartResultUrls=$server.PartResultUrls.ToArray();FirstRunPartResultUrls=$firstRunPartResultUrls
                FirstRunPrompts=$firstRunPrompts
                JournalExists=(Test-Path -LiteralPath $Journal);GateCount=$Gate.CurrentCount
                ConcurrentReads=$script:outsideGateReads;Transcript=$script:transcript
                TabsBeforeClearCalls=$script:tabsBeforeClearCalls.ToArray()
                NativeSawServiceOpen=$script:nativeSawServiceOpen
                NativeProbes=$script:nativeProbes
            }
        } $scenario $journal $gate
        Write-Output ("Scenario={0}; State={1}; Sends={2}; Message={3}" -f $scenario, $result.State, $result.Prompts.Count, $result.Message)
        if ($result.State -notin @('completed','error','needs-review')) { throw ($result | ConvertTo-Json -Depth 3) }
        Assert ($result.GateCount -eq 1) "$scenario always releases the composer gate"
        Assert (@($result.Prompts | Where-Object {$_.Length -gt 22000}).Count -eq 0) "$scenario never submits an oversized prompt"
        switch ($scenario) {
            'single' {
                Assert ($result.State -eq 'completed' -and $result.Prompts.Count -eq 1 -and $result.Closed -eq 0 -and -not $result.JournalExists) 'Short video uses one chat and waits for its actual summary'
                Assert ($result.ConcurrentReads -gt 0 -and $result.ResultUrl -like 'https://chatgpt.com/c/*') 'Reply collection releases the composer and records the final conversation'
            }
            'split' {
                Assert ($result.State -eq 'completed' -and $result.Prompts.Count -eq 5 -and $result.Targets -eq 5 -and
                    $result.Closed -eq 4 -and $result.Navigations -eq 5) 'Four part chats and a final combined chat each get their own tab, and every part tab is closed once its reply is captured'
                Assert ($result.Prompts[-1] -like '*coherent final summary*' -and -not $result.JournalExists) 'Final combination uses collected summaries and clears successful journals'
                $final = $result.Prompts[-1]
                Assert ([regex]::Matches($final, '--- NOTE \d+ ---').Count -eq 4) 'The final merge contains exactly four notes'
                $previousPosition = -1
                foreach ($part in 1..4) {
                    $position = $final.IndexOf("--- NOTE $part ---`nGrounded summary from target$part conversation 1.`n--- END NOTE ---", [StringComparison]::Ordinal)
                    Assert ($position -gt $previousPosition) "Part $part is included in the final merge in source order"
                    $previousPosition = $position
                }
                Assert ($result.ResultUrl -eq 'https://chatgpt.com/c/target5-c1') 'The result link opens the final combined conversation in its own fresh tab, not a closed source part'
                Assert ($result.PartResultUrls.Count -eq 4 -and (Compare-Object $result.PartResultUrls @(1..4 | ForEach-Object { "https://chatgpt.com/c/target$_-c1" }) | Measure-Object).Count -eq 0) 'Each split part conversation link is recorded for "Open all parts", excluding the merge stage'
            }
            'split-rerun' {
                Assert ($result.State -eq 'completed') 'A rerun of a split video (simulating Retry from checkpoint) still completes'
                Assert ($result.FirstRunPartResultUrls.Count -eq 4 -and (Compare-Object $result.FirstRunPartResultUrls @(1..4 | ForEach-Object { "https://chatgpt.com/c/target$_-c1" }) | Measure-Object).Count -eq 0) 'The first attempt records its own four part links before the rerun'
                Assert ($result.PartResultUrls.Count -eq 4 -and (Compare-Object $result.PartResultUrls $result.FirstRunPartResultUrls | Measure-Object).Count -eq 0) 'A retry preserves the validated successful part links rather than replacing them'
                Assert ($result.Prompts.Count -eq 1 -and $result.Prompts[0] -like '*coherent final summary*') 'A retry after all parts succeeded sends only the unfinished final merge and never resends Parts 1-4'
                Assert ($result.TabsBeforeClearCalls.Count -eq 0) 'A retry does not clear saved progress before or after transcript validation when the transcript and settings still match'
            }
            'split-partial-resume' {
                Assert ($result.State -eq 'completed' -and $result.FirstRunPrompts.Count -eq 2) 'The first attempt fails while sending Part 2 after Part 1 was saved'
                Assert ($result.FirstRunPartResultUrls.Count -eq 1 -and $result.PartResultUrls.Count -eq 4) 'Retry keeps the saved Part 1 conversation and adds only Parts 2-4'
                Assert ($result.Prompts.Count -eq 4) 'Retry sends the three unfinished parts plus the final merge, not Part 1 again'
                Assert ($result.Prompts[-1] -like '*Grounded summary from target1 conversation 1*') 'The final merge includes the Part 1 text restored from the durable checkpoint'
            }
            'level-full-split-rerun' {
                Assert ($result.State -eq 'completed' -and $result.FirstRunPrompts.Count -gt 1) 'The first Full run saves every verified transcript part'
                Assert ($result.Prompts.Count -eq 0) 'A Full retry with every part saved performs no provider sends'
                Assert ($result.FinalResult -ceq $result.Transcript) 'A Full retry assembles the exact transcript locally from its saved parts'
            }
            'parallel-native' {
                Assert ($result.State -eq 'completed' -and $result.Prompts.Count -eq 1) 'A definite transcript-service failure continues with the preloaded native YouTube transcript and sends exactly once'
                Assert (-not $result.NativeSawServiceOpen -and $result.Targets -eq 2 -and $result.Closed -eq 1) 'A definitely rejected transcript-service tab is closed before native caption reading begins'
                Assert ($result.ResultUrl -eq 'https://chatgpt.com/c/target2-c1') 'The winning native transcript tab is reused for the provider conversation'
            }
            'parallel-service-wins' {
                Assert ($result.State -eq 'completed' -and $result.Prompts.Count -eq 1 -and $result.NativeProbes -gt 0) 'A slow transcript service can still win after native YouTube probing has started'
                Assert ($result.NativeSawServiceOpen -and $result.Targets -eq 2 -and $result.Closed -eq 1) 'True alternating probes keep both sources live until the service wins, then close only the native loser'
                Assert ($result.ResultUrl -eq 'https://chatgpt.com/c/target1-c1') 'The winning service tab is reused for the provider conversation'
            }
            'parallel-both-fail' {
                Assert ($result.State -eq 'error' -and $result.Prompts.Count -eq 0) 'No provider send occurs when both transcript sources fail'
                Assert ($result.Targets -eq 2 -and $result.Closed -eq 2) 'Both transcript tabs are closed when neither source succeeds'
                Assert ($result.Message -like '*YouTube blocked the transcript service*YouTube native transcript fixture failed*') 'The final retryable error preserves both source failure reasons'
            }
            'keep-tabs-split' {
                Assert ($result.State -eq 'completed' -and $result.Prompts.Count -eq 5 -and $result.Targets -eq 5 -and
                    $result.Closed -eq 0 -and $result.Navigations -eq 5) 'Opting in to KeepIntermediateTabs leaves every part and merge-stage tab open instead of closing it'
                Assert ($result.ResultUrl -eq 'https://chatgpt.com/c/target5-c1') 'The final tab still opens the same way when intermediate tabs are kept open'
            }
            'hierarchical' {
                Assert ($result.State -eq 'completed' -and @($result.Prompts | Where-Object {$_ -like '*compact consolidated notes*'}).Count -gt 0 -and
                    $result.Targets -gt 1 -and $result.Closed -eq ($result.Targets - 1)) 'Hierarchical merge chats each get their own tab; only the final stage tab is left open'
                Assert ($result.PartResultUrls.Count -eq (@($result.Prompts | Where-Object {$_ -like 'Summarize part *'}).Count)) 'Only first-level split parts are recorded for "Open all parts", not merge rounds'
            }
            'quota' {
                Assert ($result.State -eq 'error' -and -not $result.Paused -and $result.Prompts.Count -eq 2 -and -not $result.JournalExists) 'An explicit usage rejection fails this video retryably without pausing the whole queue'
            }
            'size-rejection' {
                Assert ($result.State -eq 'error' -and -not $result.Paused -and $result.Prompts.Count -eq 1 -and -not $result.JournalExists) 'A definite size rejection is surfaced and never merged or retried automatically'
            }
            'disconnect' {
                Assert ($result.State -eq 'error' -and $result.JournalExists -and $result.Prompts.Count -eq 2) 'Legacy single-provider mode records an uncertain send as retryable error'
            }
            'no-progress' {
                Assert ($result.State -eq 'error' -and $result.Message -like '*not getting smaller*' -and -not $result.JournalExists) 'Nonshrinking generated notes stop rather than looping or truncating'
            }
            'existing-chat' {
                Assert ($result.State -eq 'error' -and $result.Prompts.Count -eq 0) 'A stage refuses to append to an existing conversation'
            }
            'title-match' {
                Assert ($result.State -eq 'completed' -and $result.Prompts.Count -eq 1) 'A transcript-site title that matches the job''s own known title proceeds normally'
            }
            'title-mismatch' {
                Assert ($result.State -eq 'completed' -and $result.Prompts.Count -eq 1 -and
                    $result.NativeProbes -gt 0 -and -not $result.JournalExists) `
                    'A wrong-title transcript-service result is rejected without failing the video, then verified native YouTube captions complete it'
            }
            {$_ -in @('part-draft','part-edited','part-busy')} {
                Assert ($result.State -eq 'completed' -and $result.Prompts.Count -eq 5 -and $result.Targets -eq 5 -and
                    $result.Closed -eq 4) "$scenario no longer risks stale reused-tab state, since every part now gets its own tab that is closed once its reply is captured"
            }
            'delayed-navigation' {
                Assert ($result.State -eq 'completed' -and $result.Prompts.Count -eq 5 -and $result.Targets -eq 5 -and
                    $result.Closed -eq 4) 'Each stage now gets a fresh tab, so a stale echo on a previously used tab can no longer be observed'
            }
            {$_ -like 'level-*' -and $_ -notlike '*-rerun'} {
                $chosen = $scenario.Split('-')[1]
                $kind = $scenario.Split('-')[2]
                $profile = & $module { param($Level) Get-YtSummaryProfile $Level } $chosen
                $expectedTargets = if ($kind -eq 'single') { 1 } else { $null }
                Assert ($result.State -eq 'completed' -and -not $result.JournalExists -and
                    ($(if ($null -ne $expectedTargets) { $result.Targets -eq $expectedTargets } else { $result.Targets -gt 1 -and $result.Closed -eq ($result.Targets - 1) }))) `
                    "$chosen $kind finishes without replaying stages, closing every non-final tab, and keeping only the final tab open"
                if ($chosen -eq 'full') {
                    $preserved = & $module {
                        param($Source,$Result) Test-YtFullTranscriptFidelity -Source $Source -Result $Result
                    } $result.Transcript $result.FinalResult
                    Assert $preserved "full $kind assembles every source word locally without a lossy merge"
                    Assert (@($result.Prompts | Where-Object { $_ -match 'consolidated|Combine these ordered' }).Count -eq 0) "full $kind never asks a provider to shrink or combine the transcript"
                } else {
                    Assert ($result.Prompts[-1].Contains($profile.FinalInstruction)) "$chosen reaches the final answer instructions for $kind videos"
                }
                if ($kind -eq 'single') {
                    Assert ($result.Prompts.Count -eq 1) "$chosen also applies to ordinary, unsplit videos"
                } else {
                    $partPrompts = @($result.Prompts | Where-Object { $_.StartsWith($(if ($chosen -eq 'full') {'Reproduce part '} else {'Summarize part '})) })
                    if ($chosen -eq 'full') {
                        Assert ($partPrompts.Count -gt 4) 'full uses smaller reply-safe source chunks'
                    } else {
                        Assert ($partPrompts.Count -eq 4) "$chosen preserves the four source parts"
                    }
                    foreach ($prompt in $partPrompts) {
                        if ($chosen -eq 'full') {
                            Assert ($prompt.Contains($profile.Detail)) 'full instructions forbid omissions in every part'
                        } else {
                            Assert ($prompt.Contains($profile.Detail) -and $prompt.Contains("$($profile.NoteCharacters) characters")) "$chosen detail is retained before the final combination"
                        }
                    }
                    if ($kind -eq 'hierarchical') {
                        $merges = @($result.Prompts | Where-Object { $_.Contains("Produce consolidated $chosen working notes") })
                        Assert ($merges.Count -gt 0) "$chosen also controls intermediate merge rounds"
                        foreach ($prompt in $merges) { Assert ($prompt.Contains($profile.Detail)) "$chosen merge notes preserve the selected detail" }
                    } else {
                        $expectedCount = if ($chosen -eq 'full') { $partPrompts.Count } else { 5 }
                        Assert ($result.Prompts.Count -eq $expectedCount) "$chosen uses the expected lossless stage count"
                    }
                }
            }
        }
    } finally {
        $gate.Dispose()
        if (Test-Path -LiteralPath $journal) { Remove-Item -LiteralPath $journal }
    }
}
Write-Output "ALL $assertions split-workflow assertions passed. No browser or network connection was used."
