param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $HelperRoot 'Providers.psm1') -Force
$assertions = 0
function Assert([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "FAILED: $Message" }
    $script:assertions++
    Write-Output "PASS: $Message"
}
function Assert-Throws([scriptblock]$Action, [string]$Message) {
    $threw = $false
    try { & $Action } catch { $threw = $true }
    Assert $threw $Message
}

$order = Get-YtProviderOrder
Assert (($order -join ',') -eq 'ChatGPT,Gemini,Claude') 'rotation order is stable and canonical'
Assert ((Get-YtNextProviderIndex 2) -eq 0) 'rotation wraps after Claude'
Assert ((Get-YtProviderIndex 'Claude') -eq 2) 'provider indexes are persisted-compatible'
Assert (((Get-YtEnabledProviderOrder @('Claude','ChatGPT')) -join ',') -eq 'ChatGPT,Claude') 'enabled provider order remains canonical'
Assert ((Get-YtNextEnabledProviderIndex 0 @('ChatGPT','Claude')) -eq 2) 'rotation skips a disabled provider'
Assert ((Get-YtNextEnabledProviderIndex 2 @('ChatGPT','Claude')) -eq 0) 'enabled rotation wraps correctly'
Assert-Throws { Get-YtEnabledProviderOrder @() } 'an empty enabled-provider set is rejected'
Assert ((Get-YtFailureClassification 'Too many requests') -eq 'usage') 'literal too-many-requests is definite usage rejection'
Assert ((Get-YtFailureClassification 'You are making requests too quickly') -eq 'usage') 'rapid-request wording is definite usage rejection'
Assert ((Get-YtFailureClassification 'temporarily limited') -eq 'usage') 'temporarily limited is definite usage rejection'
Assert ((Get-YtFailureClassification 'The prompt is too long for this context') -eq 'size') 'size rejection is classified separately'
Assert ((Get-YtFailureClassification 'A fresh Gemini conversation did not become available. Complete login or verification, then try again.') -eq 'unavailable') 'a missing fresh Gemini conversation is a definite pre-send provider failure'
Assert ((Get-YtFailureClassification 'Gemini did not accept the full text or enable Send. The helper did not press Send; inspect the browser.') -eq 'unavailable') 'a definite unsent Gemini composer failure rotates immediately'
Assert ((Get-YtFailureClassification 'Something went wrong') -eq 'service') 'ambiguous service state stays separate'
Assert ((Get-YtFailureClassification 'Claude contains an existing draft. Nothing was overwritten or sent. Clear or save that draft before retrying.') -eq 'unavailable') 'a leftover draft makes that one provider unusable, not the whole video'
Assert ((Get-YtFailureClassification 'Gemini is already generating a response. Nothing was inserted or sent.') -eq 'unavailable') 'a busy provider is a definite pre-send provider failure'
Assert ((Get-YtFailureClassification 'ChatGPT opened an existing conversation. Nothing was inserted or sent.') -eq 'unavailable') 'an unexpected existing conversation rotates instead of failing the video'
Assert (-not (Test-YtDefiniteRejection 'service')) 'ambiguous service state is not a definite rejection'
$summaryModule = Import-Module (Join-Path $HelperRoot 'YtSummary.psm1') -Force -DisableNameChecking -PassThru
$selection = & $summaryModule {
    param($Server)
    function Invoke-YtChatStage {
        param($Connection,$Server,$Job,$Tab,$Prompt,$Label,$JournalPath,$WaitSeconds,
            $MaxMessageCharacters,$ComposerGate,$ProviderGates,$ProviderName,$CancellationToken)
        $script:SelectedProvider = $ProviderName
        return [pscustomobject]@{Tab=$Tab}
    }
    $cursor = [pscustomobject]@{Index=1}
    $null = Invoke-YtRotatingChatStage -Server $Server -Job ([pscustomobject]@{Id='fixture'}) `
        -Prompt 'fixture' -Label 'fixture' -JournalPath 'fixture.json' -ProviderGates @{} `
        -RotationCursor $cursor -FirstProvider Gemini
    [pscustomobject]@{Provider=$script:SelectedProvider;Cursor=$cursor.Index}
} ([pscustomobject]@{EnabledProviders=@('ChatGPT','Claude')})
Assert ($selection.Provider -ceq 'Claude') 'production stage selection skips a disabled scheduled provider'
Assert ($selection.Cursor -eq 0) 'production rotation advances to the next enabled provider cursor'
$fallbackServer = [pscustomobject]@{EnabledProviders=@('ChatGPT','Gemini','Claude')}
$fallbackServer | Add-Member ScriptMethod UpdateJob { param($Id,$State,$Message) }
$preSendFallbacks = & $summaryModule {
    param($Server)
    $messages = @(
        'A fresh Gemini conversation did not become available. Complete login or verification, then try again.',
        'Gemini did not accept the full text or enable Send. The helper did not press Send; inspect the browser.',
        'Gemini contains an existing draft. Nothing was overwritten or sent. Clear or save that draft before retrying.',
        'Gemini is already generating a response. Nothing was inserted or sent.'
    )
    $results = @()
    foreach ($message in $messages) {
        $script:AttemptedProviders = New-Object 'Collections.Generic.List[string]'
        $script:GeminiFailure = $message
        function Invoke-YtChatStage {
            param($Connection,$Server,$Job,$Tab,$Prompt,$Label,$JournalPath,$WaitSeconds,
                $MaxMessageCharacters,$ComposerGate,$ProviderGates,$ProviderName,$CancellationToken)
            $script:AttemptedProviders.Add($ProviderName)
            if ($ProviderName -eq 'Gemini') { throw $script:GeminiFailure }
            return [pscustomobject]@{Tab=[pscustomobject]@{SessionId='fixture';TargetId='fixture'}}
        }
        $cursor = [pscustomobject]@{Index=1}
        $stage = Invoke-YtRotatingChatStage -Server $Server -Job ([pscustomobject]@{Id='fixture'}) `
            -Prompt 'fixture' -Label 'fixture' -JournalPath 'fixture.json' -ProviderGates @{} `
            -RotationCursor $cursor -FirstProvider Gemini
        $results += [pscustomobject]@{
            Providers=$script:AttemptedProviders.ToArray()
            Winner=$stage.ProviderName
            Cursor=$cursor.Index
        }
    }
    return $results
} $fallbackServer
foreach ($fallback in $preSendFallbacks) {
    Assert (($fallback.Providers -join ',') -eq 'Gemini,Claude' -and
        $fallback.Winner -eq 'Claude' -and $fallback.Cursor -eq 0) `
        'a definite unsent Gemini setup/composer failure immediately rotates to Claude and advances the cursor'
}

# When literally every enabled provider is rate limited, the video still fails retryably, but
# the queue must keep running: these banners are usually transient and provider-specific, so a
# global "paused for a usage limit" wall was wrong far more often than it was right.
$exhaustedServer = [pscustomobject]@{EnabledProviders=@('ChatGPT','Gemini','Claude');Paused=$false;PauseReason=''}
$exhaustedServer | Add-Member ScriptMethod UpdateJob { param($Id,$State,$Message) }
$exhaustedServer | Add-Member ScriptMethod PauseForUsageLimit {
    param($Reason) $this.Paused = $true; $this.PauseReason = $Reason
}
$exhausted = & $summaryModule {
    param($Server)
    $script:UsageAttempts = New-Object 'Collections.Generic.List[string]'
    function Invoke-YtChatStage {
        param($Connection,$Server,$Job,$Tab,$Prompt,$Label,$JournalPath,$WaitSeconds,
            $MaxMessageCharacters,$ComposerGate,$ProviderGates,$ProviderName,$CancellationToken)
        $script:UsageAttempts.Add($ProviderName)
        throw 'Too many requests You''re making requests too quickly. We''ve temporarily limited access.'
    }
    $caught = ''
    try {
        $null = Invoke-YtRotatingChatStage -Server $Server -Job ([pscustomobject]@{Id='fixture'}) `
            -Prompt 'fixture' -Label 'Part 4/5' -JournalPath 'fixture.json' -ProviderGates @{}
    } catch { $caught = $_.Exception.Message }
    [pscustomobject]@{Providers=$script:UsageAttempts.ToArray();Caught=$caught}
} $exhaustedServer
Assert (($exhausted.Providers -join ',') -eq 'ChatGPT,Gemini,Claude') 'a literal too-many-requests rejection tries every enabled provider before giving up'
Assert ($exhausted.Caught -match 'Too many requests') 'the real provider rejection text is still surfaced to the user'
Assert (-not $exhaustedServer.Paused) `
    'exhausting every provider with usage limits never pauses the whole queue'
$partialServer = [pscustomobject]@{EnabledProviders=@('ChatGPT','Gemini','Claude');Paused=$false;PauseReason=''}
$partialServer | Add-Member ScriptMethod UpdateJob { param($Id,$State,$Message) }
$partialServer | Add-Member ScriptMethod PauseForUsageLimit { param($Reason) $this.Paused = $true }
$partial = & $summaryModule {
    param($Server)
    function Invoke-YtChatStage {
        param($Connection,$Server,$Job,$Tab,$Prompt,$Label,$JournalPath,$WaitSeconds,
            $MaxMessageCharacters,$ComposerGate,$ProviderGates,$ProviderName,$CancellationToken)
        if ($ProviderName -eq 'ChatGPT') { throw 'Too many requests. Please wait a few minutes before trying again.' }
        return [pscustomobject]@{Tab=[pscustomobject]@{SessionId='fixture';TargetId='fixture'}}
    }
    $stage = Invoke-YtRotatingChatStage -Server $Server -Job ([pscustomobject]@{Id='fixture'}) `
        -Prompt 'fixture' -Label 'Part 1/2' -JournalPath 'fixture.json' -ProviderGates @{}
    $stage.ProviderName
} $partialServer
Assert ($partial -ceq 'Gemini' -and -not $partialServer.Paused) `
    'one rate-limited provider rotates to the next one and never pauses the queue'

# A provider whose single in-flight slot is held by another video is not a failure. The
# scheduled video must move to a free provider instead of queueing behind that slot forever
# (the real symptom was a video parked on "waiting for the Gemini composer" for hours).
$busyServer = [pscustomobject]@{EnabledProviders=@('ChatGPT','Gemini','Claude');Paused=$false;DispatchPaused=$false;StopRequested=$false;IsRunning=$true;LastServerError=''}
$busyServer | Add-Member ScriptMethod UpdateJob { param($Id,$State,$Message) $this.LastState = $State }
$busyServer | Add-Member NoteProperty LastState ''
$busy = & $summaryModule {
    param($Server)
    $script:BusyAttempts = New-Object 'Collections.Generic.List[string]'
    function Invoke-YtChatStage {
        param($Connection,$Server,$Job,$Tab,$Prompt,$Label,$JournalPath,$WaitSeconds,
            $MaxMessageCharacters,$ComposerGate,$ProviderGates,$ProviderName,$CancellationToken)
        $script:BusyAttempts.Add($ProviderName)
        if ($ProviderName -eq 'Gemini') {
            $exception = New-Object InvalidOperationException -ArgumentList "$ProviderName is busy with another video; trying another provider."
            $exception.Data['YtProviderBusy'] = $true
            throw $exception
        }
        return [pscustomobject]@{Tab=[pscustomobject]@{SessionId='fixture';TargetId='fixture'}}
    }
    $cursor = [pscustomobject]@{Index=1}
    $stage = Invoke-YtRotatingChatStage -Server $Server -Job ([pscustomobject]@{Id='fixture'}) `
        -Prompt 'fixture' -Label 'Part 1/3' -JournalPath 'fixture.json' -ProviderGates @{} `
        -RotationCursor $cursor -FirstProvider Gemini
    [pscustomobject]@{Providers=$script:BusyAttempts.ToArray();Winner=$stage.ProviderName;Cursor=$cursor.Index}
} $busyServer
Assert (($busy.Providers -join ',') -eq 'Gemini,Claude' -and $busy.Winner -ceq 'Claude') `
    'a provider slot held by another video rotates immediately to a free provider'
Assert ($busyServer.LastState -ne 'error') 'a busy provider slot is never reported as a video failure'

# The busy signal itself comes from production code: a held provider gate must raise it
# instead of blocking, and it must not leak the semaphore.
$gateServer = [pscustomobject]@{EnabledProviders=@('Gemini');DispatchPaused=$false;StopRequested=$false;IsRunning=$true;LastServerError=''}
$gateServer | Add-Member ScriptMethod UpdateJob { param($Id,$State,$Message) }
$heldGate = New-Object System.Threading.SemaphoreSlim(1, 1)
$null = $heldGate.Wait(0)
$gateResult = & $summaryModule {
    param($Server, $Gate)
    $flagged = $false
    $message = ''
    try {
        $null = Invoke-YtChatStage -Connection $null -Server $Server -Job ([pscustomobject]@{Id='fixture'}) `
            -Tab $null -Prompt 'fixture' -Label 'Part 1/3' -JournalPath 'fixture.json' `
            -ProviderGates @{Gemini=$Gate} -ProviderName 'Gemini' -GateWaitSeconds 0
    } catch {
        $flagged = [bool]$_.Exception.Data['YtProviderBusy']
        $message = $_.Exception.Message
    }
    [pscustomobject]@{Flagged=$flagged;Message=$message}
} $gateServer $heldGate
Assert ($gateResult.Flagged -and $gateResult.Message -match 'busy with another video') `
    'a held provider gate reports a busy slot instead of waiting for it forever'
Assert ($heldGate.CurrentCount -eq 0) 'giving up on a busy provider never releases another video''s slot'
$heldGate.Dispose()

# ChatGPT/Gemini/Claude throttle the conversation list while still answering normally. That
# banner must not be treated as a rejection at all.
foreach ($benign in @(
    "Too many requests You're making requests too quickly. We've temporarily limited access to your conversations to protect your data. Please wait a few minutes before trying again.",
    'We have temporarily limited access to your conversations to protect your data.')) {
    $benignResult = & $summaryModule { param($Text)
        [pscustomobject]@{Kind=(Get-YtFailureClassification -Text $Text);Benign=(Test-YtBenignBanner $Text)}
    } $benign
    Assert ($benignResult.Kind -eq '') `
        'a conversation-list throttling banner is not classified as a provider rejection'
    Assert ($benignResult.Benign) 'the conversation-list throttling banner is recognised as benign'
}
$realLimit = & $summaryModule { param($Text)
    [pscustomobject]@{Kind=(Get-YtFailureClassification -Text $Text);Benign=(Test-YtBenignBanner $Text)}
} 'You have reached your message limit for GPT-5.'
Assert ($realLimit.Kind -eq 'usage') `
    'a real message-limit notice is still a definite usage rejection'
Assert (-not $realLimit.Benign) `
    'a real message-limit notice is not treated as benign'

# A definite rejection that is not a usage limit (an existing draft, an oversized part) must still
# rotate, but it says nothing about rate limits, so it must never pause the rest of the queue.
$draftServer = [pscustomobject]@{EnabledProviders=@('ChatGPT','Gemini','Claude');Paused=$false;PauseReason=''}
$draftServer | Add-Member ScriptMethod UpdateJob { param($Id,$State,$Message) }
$draftServer | Add-Member ScriptMethod PauseForUsageLimit { param($Reason) $this.Paused = $true }
$draftExhausted = & $summaryModule {
    param($Server)
    $script:DraftAttempts = New-Object 'Collections.Generic.List[string]'
    function Invoke-YtChatStage {
        param($Connection,$Server,$Job,$Tab,$Prompt,$Label,$JournalPath,$WaitSeconds,
            $MaxMessageCharacters,$ComposerGate,$ProviderGates,$ProviderName,$CancellationToken)
        $script:DraftAttempts.Add($ProviderName)
        $exception = [InvalidOperationException]::new(
            "$ProviderName contains an existing draft. Nothing was overwritten or sent.")
        $exception.Data['YtFailureKind'] = 'unavailable'
        $exception.Data['YtDefiniteRejection'] = $true
        throw $exception
    }
    try { $null = Invoke-YtRotatingChatStage -Server $Server -Job ([pscustomobject]@{Id='fixture'}) `
        -Prompt 'fixture' -Label 'Part 2/2' -JournalPath 'fixture.json' -ProviderGates @{} } catch { }
    $script:DraftAttempts.ToArray()
} $draftServer
Assert (($draftExhausted -join ',') -eq 'ChatGPT,Gemini,Claude') `
    'a leftover draft rotates through every enabled provider'
Assert (-not $draftServer.Paused) `
    'exhausting providers on a non-usage rejection never pauses dispatch'

# A very large paste can be auto-converted by a provider (observed with Claude) into a file
# attachment instead of literal editor text. Test-YtComposerTextAccepted is the single shared
# signal the ready-to-send probe and Send-YtComposer's own equality check both rely on.
$acceptedLiteral = & $summaryModule { Test-YtComposerTextAccepted ([pscustomobject]@{text='Hello world';attachmentCount=0}) 'Hello world' }
Assert $acceptedLiteral 'A literal text match is still accepted'
$acceptedAttachment = & $summaryModule { Test-YtComposerTextAccepted ([pscustomobject]@{text='';attachmentCount=1}) 'A huge transcript that became an attachment' }
Assert $acceptedAttachment 'A single attachment chip with no stray text is accepted as a prompt-accepted state'
$rejectedMultipleAttachments = & $summaryModule { Test-YtComposerTextAccepted ([pscustomobject]@{text='';attachmentCount=2}) 'Hello' }
Assert (-not $rejectedMultipleAttachments) 'More than one attachment chip is never treated as an unambiguous accepted state'
$rejectedStrayText = & $summaryModule { Test-YtComposerTextAccepted ([pscustomobject]@{text='partial';attachmentCount=1}) 'Hello' }
Assert (-not $rejectedStrayText) 'An attachment alongside unexpected stray editor text is not accepted'
$rejectedNoMatch = & $summaryModule { Test-YtComposerTextAccepted ([pscustomobject]@{text='wrong';attachmentCount=0}) 'Hello' }
Assert (-not $rejectedNoMatch) 'Mismatched literal text without any attachment is still rejected'

# Self-heal: a fresh, automation-owned background tab (never shown to the user) that shows a
# leftover draft/attachment from an earlier abandoned insertion must be cleared automatically
# instead of cascading the stuck state to every later job routed to the same provider.
$mockServer = [pscustomobject]@{}
$mockServer | Add-Member -MemberType ScriptMethod -Name UpdateJob -Value { param($Id,$State,$Message) }
$mockServer | Add-Member -MemberType NoteProperty -Name StopRequested -Value $false
$selfHeal = & $summaryModule {
    param($Server)
    $script:ProbeCalls = 0
    $script:Cleared = $false
    function Wait-YtDispatchPermission { param($Server,$Job,$CancellationToken) }
    function Assert-YtRunning { param($Server,$CancellationToken) }
    function Assert-YtPageHealthy { param($State,$Server,$Label) }
    function New-YtBrowserTab { param($Connection,$Url,[switch]$Background,$Server,$CancellationToken) [pscustomobject]@{SessionId='fixture-session';TargetId='fixture-target'} }
    function Invoke-YtCdp { param($Connection,$Method,$Parameters,$SessionId) [pscustomobject]@{} }
    function Enable-YtBackgroundTabExecution { param($Connection,$SessionId,[switch]$BringToFront) }
    function Clear-YtComposerDraft { param($Connection,$SessionId,$ProviderName) $script:Cleared = $true }
    function Focus-YtComposer { param($Connection,$SessionId,$ProviderName) throw (New-Object InvalidOperationException -ArgumentList 'TEST-STOP-AFTER-HEAL') }
    function Invoke-YtNavigationProbe {
        param($Connection,$SessionId,$Expression)
        $script:ProbeCalls++
        $text = if ($script:ProbeCalls -eq 1) { 'Stuck leftover attachment draft' } else { '' }
        return [pscustomobject]@{kind='ready';url='https://claude.ai/new';messageCount=0;text=$text;busy=$false;attachmentCount=0;assistantMessageCount=0}
    }
    $caught = ''
    try {
        $null = Invoke-YtChatStage -Server $Server -Job ([pscustomobject]@{Id='fixture'}) `
            -Prompt 'fixture prompt' -Label 'fixture' -JournalPath (Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N') + '.json')) `
            -ProviderName Claude -CancellationToken ([System.Threading.CancellationToken]::None)
    } catch { $caught = $_.Exception.Message }
    [pscustomobject]@{Cleared=$script:Cleared;ProbeCalls=$script:ProbeCalls;Caught=$caught}
} $mockServer
Assert $selfHeal.Cleared 'A leftover draft on a fresh non-final-stage tab is cleared automatically'
Assert ($selfHeal.ProbeCalls -eq 2) 'The composer is re-probed once after the automatic clear'
Assert ($selfHeal.Caught -eq 'TEST-STOP-AFTER-HEAL') 'Clearing the draft lets the stage proceed to insertion instead of throwing "existing draft"'

# The one final-stage tab that may ever be shown to the user must keep refusing to clear a
# draft automatically, unchanged from the existing safety behavior.
$finalRefusal = & $summaryModule {
    param($Server)
    $script:Cleared2 = $false
    function Wait-YtDispatchPermission { param($Server,$Job,$CancellationToken) }
    function Assert-YtRunning { param($Server,$CancellationToken) }
    function Assert-YtPageHealthy { param($State,$Server,$Label) }
    function New-YtBrowserTab { param($Connection,$Url,[switch]$Background,$Server,$CancellationToken) [pscustomobject]@{SessionId='fixture-session';TargetId='fixture-target'} }
    function Invoke-YtCdp { param($Connection,$Method,$Parameters,$SessionId) [pscustomobject]@{} }
    function Enable-YtBackgroundTabExecution { param($Connection,$SessionId,[switch]$BringToFront) }
    function Clear-YtComposerDraft { param($Connection,$SessionId,$ProviderName) $script:Cleared2 = $true }
    function Focus-YtComposer { param($Connection,$SessionId,$ProviderName) throw (New-Object InvalidOperationException -ArgumentList 'TEST-STOP-AFTER-HEAL') }
    function Invoke-YtNavigationProbe {
        param($Connection,$SessionId,$Expression)
        return [pscustomobject]@{kind='ready';url='https://claude.ai/new';messageCount=0;text='Stuck leftover attachment draft';busy=$false;attachmentCount=0;assistantMessageCount=0}
    }
    $caught = ''
    try {
        $null = Invoke-YtChatStage -Server $Server -Job ([pscustomobject]@{Id='fixture'}) `
            -Prompt 'fixture prompt' -Label 'fixture' -JournalPath (Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString('N') + '.json')) `
            -ProviderName Claude -FinalStage -CancellationToken ([System.Threading.CancellationToken]::None)
    } catch { $caught = $_.Exception.Message }
    [pscustomobject]@{Cleared=$script:Cleared2;Caught=$caught}
} $mockServer
Assert (-not $finalRefusal.Cleared) 'The final-stage tab a user may be looking at is never auto-cleared'
Assert ($finalRefusal.Caught -eq 'Claude contains an existing draft. Nothing was overwritten or sent. Clear or save that draft before retrying.') 'The final-stage draft refusal message is unchanged'

# Defensive cross-check: the transcript-site URL check only confirms the address bar, never
# the page's own rendered content, so a wrong-video transcript could otherwise be accepted and
# sent to an LLM under a matching URL. Test-YtTranscriptTitleMatches is the shared, fail-closed
# comparison used once the job's own independently-known title is available.
$titleMatch = & $summaryModule { Test-YtTranscriptTitleMatches 'How Neural Networks Really Work' 'How Neural Networks Really Work' }
Assert $titleMatch 'An identical title is accepted'
$titleMatchNormalized = & $summaryModule { Test-YtTranscriptTitleMatches 'How Neural Networks  Really Work!' 'how neural networks really work' }
Assert $titleMatchNormalized 'Whitespace, punctuation and casing differences are tolerated'
$titleMatchTruncated = & $summaryModule { Test-YtTranscriptTitleMatches 'How Neural Networks Really Work (Full Explanation With Diagrams)' 'How Neural Networks Really Work' }
Assert $titleMatchTruncated 'A truncated site title that is a prefix of the known job title is tolerated'
$titleMismatch = & $summaryModule { Test-YtTranscriptTitleMatches 'How Neural Networks Really Work' 'My Cooking Channel: Best Pasta Recipe' }
Assert (-not $titleMismatch) 'A clearly different video title is rejected as a mismatch'
$titleUnknownJob = & $summaryModule { Test-YtTranscriptTitleMatches '' 'Any Site Title At All' }
Assert $titleUnknownJob 'The check is skipped gracefully when the job title is not yet known'
$titleUnknownSite = & $summaryModule { Test-YtTranscriptTitleMatches 'A Known Job Title' '' }
Assert $titleUnknownSite 'The check is skipped gracefully when the site title could not be read'

# An aborted direct caption read ("signal is aborted without reason") is retryable, but a
# retry with the exact same short deadline just aborts again on a slow caption response.
# Each bounded retry must get a longer fetch deadline.
$captionServer = [pscustomobject]@{}
$captionServer | Add-Member ScriptMethod UpdateJob { param($Id,$State,$Message) }
$captionTimeouts = & $summaryModule {
    param($Server)
    $script:CaptionTimeouts = New-Object 'Collections.Generic.List[int]'
    function Assert-YtRunning { param($Server,$CancellationToken) }
    function Invoke-YtCdp { param($Connection,$Method,$Parameters,$SessionId) [pscustomobject]@{} }
    function Start-Sleep { param($Milliseconds) }
    function Invoke-YtNavigationProbe {
        param($Connection,$SessionId,$Expression,$TimeoutSeconds)
        if ($Expression -match 'caption-track-waiting') {
            if ($Expression -match 'Math\.floor\((\d+) / 2\)') {
                $script:CaptionTimeouts.Add([int]$Matches[1])
            }
            return [pscustomobject]@{
                url='https://www.youtube.com/watch?v=fixture9999';count=0;text=''
                failure='YouTube caption-track read failed: signal is aborted without reason.'
                retryable=$true;phase='caption-track-error';unavailable=$false;captionsAvailable=$true
            }
        }
        return $null
    }
    try {
        $null = Get-YtYouTubeTranscript -Connection $null -Server $Server `
            -Job ([pscustomobject]@{Id='fixture';VideoId='fixture9999';Title=''}) `
            -Tab ([pscustomobject]@{SessionId='fixture';TargetId='fixture'}) -WaitSeconds 4 -SkipNavigation
    } catch { }
    $script:CaptionTimeouts.ToArray()
} $captionServer
Assert ($captionTimeouts.Count -eq 3) 'an aborted direct caption read is retried a bounded three times'
Assert ($captionTimeouts[1] -gt $captionTimeouts[0] -and $captionTimeouts[2] -gt $captionTimeouts[1]) `
    'each bounded caption retry waits longer, so a slow caption response is not aborted identically every time'
$titlePlaceholder = & $summaryModule { Test-YtTranscriptTitleMatches 'A Completely Different Known Job Title' 'YouTube Transcript Generator' }
Assert $titlePlaceholder 'The transcript site''s own generic placeholder page title is never treated as a real mismatch'
$titleTooShort = & $summaryModule { Test-YtTranscriptTitleMatches 'Q&A' 'Something Else Entirely' }
Assert $titleTooShort 'A too-short title on either side is too ambiguous to compare and is not refused'

Write-Output "ALL $assertions provider assertions passed. No browser or network was used."
