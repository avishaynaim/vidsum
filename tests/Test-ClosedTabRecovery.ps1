param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $HelperRoot 'YtSummary.psm1'
$assertions = 0
function Assert([bool]$Value, [string]$Message) {
    if (-not $Value) { throw "FAILED: $Message" }
    $script:assertions++
    Write-Output "PASS: $Message"
}

Import-Module $modulePath -Force -DisableNameChecking
$module = Get-Module YtSummary

Assert (Test-YtStageTabGone ([InvalidOperationException]::new('Session with given id not found.'))) 'a closed provider tab is recognised as a recoverable tab loss'
Assert (-not (Test-YtStageTabGone ([InvalidOperationException]::new('You are sending messages too quickly.')))) 'a provider content rejection is not treated as a tab loss'

$result = & $module {
    $script:probeCalls = 0
    $script:reopenedUrls = @()
    $script:statusMessages = @()
    function Start-Sleep { param($Milliseconds) }
    function Remove-YtStageJournal { param($Path, $JobId, $Hash) }
    function Assert-YtRunning { param($Server, $CancellationToken) }
    function New-YtBrowserTab {
        param($Connection, $Url, [switch]$Background, $Server, $CancellationToken)
        $script:reopenedUrls += $Url
        return [pscustomobject]@{SessionId='reopened';TargetId='reopened'}
    }
    function Invoke-YtNavigationProbe {
        param($Connection, $SessionId, $Expression)
        $script:probeCalls++
        # The user closes the tab right after the answer finishes rendering.
        if ($script:probeCalls -eq 1) { throw [InvalidOperationException]::new('Session with given id not found.') }
        if ($SessionId -ne 'reopened') { throw "the stage kept polling the dead session $SessionId" }
        return [pscustomobject]@{
            url='https://chatgpt.com/c/abc'; messageCount=1; lastMessage='prompt text'
            assistantMessageCount=1; lastAssistantText='finished summary'; busy=$false
            failureKind=''; failureMessage=''
        }
    }
    $server = [pscustomobject]@{StopRequested=$false}
    $server | Add-Member -MemberType ScriptMethod -Name UpdateJob -Value {
        param($JobId, $State, $Message) $script:statusMessages += $Message
    }
    $stage = [pscustomobject]@{
        Tab=[pscustomobject]@{SessionId='closed';TargetId='closed'}
        ExpectedText='prompt text'; ExpectedHash='hash'; UserCount=1; AssistantCount=0
        Label='Part 1'; ConversationUrl='https://chatgpt.com/c/abc'
    }
    $reply = Wait-YtAssistantReply $null $server ([pscustomobject]@{Id='job-1'}) $stage 'journal.json' 30 `
        ([System.Threading.CancellationToken]::None) 'ChatGPT'
    [pscustomobject]@{
        Text=$reply.Text; Reopened=$script:reopenedUrls; Messages=$script:statusMessages
        FinalSession=$stage.Tab.SessionId
    }
}

Assert ($result.Text -eq 'finished summary') 'a summary finished before the tab was closed is still returned'
Assert (@($result.Reopened).Count -eq 1 -and $result.Reopened[0] -eq 'https://chatgpt.com/c/abc') 'the same conversation is reopened exactly once'
Assert ($result.FinalSession -eq 'reopened') 'the stage keeps polling the reopened tab'
Assert ((@($result.Messages) -match 'tab was closed').Count -ge 1) 'the dashboard explains that the closed tab is being reopened'

$fatal = & $module {
    $script:reopened = 0
    function Start-Sleep { param($Milliseconds) }
    function Remove-YtStageJournal { param($Path, $JobId, $Hash) }
    function Assert-YtRunning { param($Server, $CancellationToken) }
    function New-YtBrowserTab {
        param($Connection, $Url, [switch]$Background, $Server, $CancellationToken)
        $script:reopened++
        return [pscustomobject]@{SessionId='reopened';TargetId='reopened'}
    }
    function Invoke-YtNavigationProbe {
        param($Connection, $SessionId, $Expression)
        throw [InvalidOperationException]::new('Session with given id not found.')
    }
    $server = [pscustomobject]@{StopRequested=$false}
    $server | Add-Member -MemberType ScriptMethod -Name UpdateJob -Value { param($JobId, $State, $Message) }
    $stage = [pscustomobject]@{
        Tab=[pscustomobject]@{SessionId='closed';TargetId='closed'}
        ExpectedText='prompt text'; ExpectedHash='hash'; UserCount=1; AssistantCount=0
        Label='Part 1'; ConversationUrl='https://chatgpt.com/c/abc'
    }
    $failed = $false
    try {
        $null = Wait-YtAssistantReply $null $server ([pscustomobject]@{Id='job-1'}) $stage 'journal.json' 30 `
            ([System.Threading.CancellationToken]::None) 'ChatGPT'
    } catch { $failed = $true }
    [pscustomobject]@{Failed=$failed;Reopened=$script:reopened}
}

Assert ($fatal.Failed) 'a permanently unreachable tab still fails instead of looping forever'
Assert ($fatal.Reopened -eq 3) 'tab recovery is bounded to three attempts'

# ChatGPT/Gemini/Claude show rate-limit banners while still generating a good answer.
$banner = & $module {
    Set-YtUsageBannerGraceSeconds 60
    $script:polls = 0
    $script:messages = @()
    function Start-Sleep { param($Milliseconds) }
    function Remove-YtStageJournal { param($Path, $JobId, $Hash) }
    function Assert-YtRunning { param($Server, $CancellationToken) }
    function Invoke-YtNavigationProbe {
        param($Connection, $SessionId, $Expression)
        $script:polls++
        # The banner shows up first; the real answer lands a few polls later.
        if ($script:polls -le 2) {
            return [pscustomobject]@{
                url='https://chatgpt.com/c/abc'; messageCount=1; lastMessage='prompt text'
                assistantMessageCount=0; lastAssistantText=''; busy=$true
                failureKind='usage'
                failureMessage="Too many requests You're making requests too quickly."
            }
        }
        return [pscustomobject]@{
            url='https://chatgpt.com/c/abc'; messageCount=1; lastMessage='prompt text'
            assistantMessageCount=1; lastAssistantText='the answer arrived anyway'; busy=$false
            failureKind=''; failureMessage=''
        }
    }
    $server = [pscustomobject]@{StopRequested=$false}
    $server | Add-Member -MemberType ScriptMethod -Name UpdateJob -Value {
        param($JobId, $State, $Message) $script:messages += $Message
    }
    $stage = [pscustomobject]@{
        Tab=[pscustomobject]@{SessionId='s';TargetId='s'}
        ExpectedText='prompt text'; ExpectedHash='hash'; UserCount=1; AssistantCount=0
        Label='Part 1'; ConversationUrl='https://chatgpt.com/c/abc'
    }
    $reply = Wait-YtAssistantReply $null $server ([pscustomobject]@{Id='job-1'}) $stage 'journal.json' 30 `
        ([System.Threading.CancellationToken]::None) 'ChatGPT'
    [pscustomobject]@{Text=$reply.Text;Messages=$script:messages}
}
Assert ($banner.Text -eq 'the answer arrived anyway') 'a rate-limit banner no longer discards an answer that still arrives'
Assert ((@($banner.Messages) -match 'rate-limit notice').Count -ge 1) 'the dashboard reports that it is still waiting through the banner'

$persistentBanner = & $module {
    Set-YtUsageBannerGraceSeconds 0
    function Start-Sleep { param($Milliseconds) }
    function Remove-YtStageJournal { param($Path, $JobId, $Hash) }
    function Assert-YtRunning { param($Server, $CancellationToken) }
    function Invoke-YtNavigationProbe {
        param($Connection, $SessionId, $Expression)
        return [pscustomobject]@{
            url='https://chatgpt.com/c/abc'; messageCount=1; lastMessage='prompt text'
            assistantMessageCount=0; lastAssistantText=''; busy=$true
            failureKind='usage'; failureMessage='You have reached your message limit.'
        }
    }
    $server = [pscustomobject]@{StopRequested=$false}
    $server | Add-Member -MemberType ScriptMethod -Name UpdateJob -Value { param($JobId, $State, $Message) }
    $stage = [pscustomobject]@{
        Tab=[pscustomobject]@{SessionId='s';TargetId='s'}
        ExpectedText='prompt text'; ExpectedHash='hash'; UserCount=1; AssistantCount=0
        Label='Part 1'; ConversationUrl='https://chatgpt.com/c/abc'
    }
    $caught = ''
    try {
        $null = Wait-YtAssistantReply $null $server ([pscustomobject]@{Id='job-1'}) $stage 'journal.json' 30 `
            ([System.Threading.CancellationToken]::None) 'ChatGPT'
    } catch { $caught = $_.Exception.Message }
    $caught
}
Assert ($persistentBanner -match 'message limit') 'a banner that outlives its grace window still rotates to the next provider'

# Recorded in the real failure log: one poll reported a different turn count while ChatGPT was
# re-rendering its own conversation, and the stage threw fatally on that single poll. Every
# automatic retry hit the same momentary re-render, so a working video was lost outright.
$transientChange = & $module {
    Set-YtUsageBannerGraceSeconds 60
    $script:polls = 0
    $script:messages = @()
    function Start-Sleep { param($Milliseconds) }
    function Remove-YtStageJournal { param($Path, $JobId, $Hash) }
    function Assert-YtRunning { param($Server, $CancellationToken) }
    function Invoke-YtNavigationProbe {
        param($Connection, $SessionId, $Expression)
        $script:polls++
        # Poll 2 momentarily reports a re-rendered prompt on the very same conversation.
        if ($script:polls -eq 2) {
            return [pscustomobject]@{
                url='https://chatgpt.com/c/abc'; messageCount=1; lastMessage='(rewriting)'
                assistantMessageCount=0; lastAssistantText=''; busy=$true
                failureKind=''; failureMessage=''
            }
        }
        $answered = $script:polls -ge 3
        return [pscustomobject]@{
            url='https://chatgpt.com/c/abc'; messageCount=1; lastMessage='prompt text'
            assistantMessageCount=$(if ($answered) { 1 } else { 0 })
            lastAssistantText=$(if ($answered) { 'the summary survived the re-render' } else { '' })
            busy=(-not $answered); failureKind=''; failureMessage=''
        }
    }
    $server = [pscustomobject]@{StopRequested=$false}
    $server | Add-Member -MemberType ScriptMethod -Name UpdateJob -Value {
        param($JobId, $State, $Message) $script:messages += $Message
    }
    $stage = [pscustomobject]@{
        Tab=[pscustomobject]@{SessionId='s';TargetId='s'}
        ExpectedText='prompt text'; ExpectedHash='hash'; UserCount=1; AssistantCount=0
        Label='Part 2/4'; ConversationUrl='https://chatgpt.com/c/abc'
    }
    $reply = Wait-YtAssistantReply $null $server ([pscustomobject]@{Id='job-1'}) $stage 'journal.json' 30 `
        ([System.Threading.CancellationToken]::None) 'ChatGPT'
    [pscustomobject]@{Text=$reply.Text;Messages=$script:messages}
}
Assert ($transientChange.Text -eq 'the summary survived the re-render') `
    'one momentary turn-count mismatch on the same conversation no longer throws away a working summary'
Assert ((@($transientChange.Messages) -match 'briefly looked different').Count -ge 1) `
    'the dashboard reports that it is rechecking the conversation instead of failing silently'

$realChange = & $module {
    Set-YtUsageBannerGraceSeconds 60
    function Start-Sleep { param($Milliseconds) }
    function Remove-YtStageJournal { param($Path, $JobId, $Hash) }
    function Assert-YtRunning { param($Server, $CancellationToken) }
    function Invoke-YtNavigationProbe {
        param($Connection, $SessionId, $Expression)
        return [pscustomobject]@{
            url='https://chatgpt.com/c/abc'; messageCount=3; lastMessage='someone typed something else'
            assistantMessageCount=0; lastAssistantText=''; busy=$false
            failureKind=''; failureMessage=''
        }
    }
    $server = [pscustomobject]@{StopRequested=$false}
    $server | Add-Member -MemberType ScriptMethod -Name UpdateJob -Value { param($JobId, $State, $Message) }
    $stage = [pscustomobject]@{
        Tab=[pscustomobject]@{SessionId='s';TargetId='s'}
        ExpectedText='prompt text'; ExpectedHash='hash'; UserCount=1; AssistantCount=0
        Label='Part 2/4'; ConversationUrl='https://chatgpt.com/c/abc'
    }
    $caught = ''
    try {
        $null = Wait-YtAssistantReply $null $server ([pscustomobject]@{Id='job-1'}) $stage 'journal.json' 30 `
            ([System.Threading.CancellationToken]::None) 'ChatGPT'
    } catch { $caught = $_.Exception.Message }
    $caught
}
Assert ($realChange -match 'conversation changed') `
    'a mismatch that persists across polls is still reported instead of waiting out the whole window'

$navigatedAway = & $module {
    Set-YtUsageBannerGraceSeconds 60
    $script:polls = 0
    function Start-Sleep { param($Milliseconds) }
    function Remove-YtStageJournal { param($Path, $JobId, $Hash) }
    function Assert-YtRunning { param($Server, $CancellationToken) }
    function Invoke-YtNavigationProbe {
        param($Connection, $SessionId, $Expression)
        $script:polls++
        return [pscustomobject]@{
            url='https://chatgpt.com/c/completely-different'; messageCount=1; lastMessage='prompt text'
            assistantMessageCount=0; lastAssistantText=''; busy=$false
            failureKind=''; failureMessage=''
        }
    }
    $server = [pscustomobject]@{StopRequested=$false}
    $server | Add-Member -MemberType ScriptMethod -Name UpdateJob -Value { param($JobId, $State, $Message) }
    $stage = [pscustomobject]@{
        Tab=[pscustomobject]@{SessionId='s';TargetId='s'}
        ExpectedText='prompt text'; ExpectedHash='hash'; UserCount=1; AssistantCount=0
        Label='Part 2/4'; ConversationUrl='https://chatgpt.com/c/abc'
    }
    $caught = ''
    try {
        $null = Wait-YtAssistantReply $null $server ([pscustomobject]@{Id='job-1'}) $stage 'journal.json' 30 `
            ([System.Threading.CancellationToken]::None) 'ChatGPT'
    } catch { $caught = $_.Exception.Message }
    [pscustomobject]@{Message=$caught;Polls=$script:polls}
}
Assert ($navigatedAway.Message -match 'conversation changed' -and $navigatedAway.Polls -eq 1) `
    'a genuinely different conversation URL fails on the first poll, with no pointless recheck'

Write-Output "OK: $assertions assertions"
