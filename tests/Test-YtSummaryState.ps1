param([string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$modulePath = Join-Path $HelperRoot 'YtSummary.psm1'
$journal = Join-Path $PSScriptRoot 'test-pending-send.json'
$total = 0

foreach ($scenario in @('success', 'draft', 'wrong-video', 'disconnect')) {
    Import-Module $modulePath -Force -DisableNameChecking
    $module = Get-Module YtSummary
    try {
        $result = & $module {
            param($Scenario, $Journal)
            $script:scenario = $Scenario
            $script:phase = 'transcript'
            $script:inserted = ''
            $script:sendCount = 0
            $script:durableBeforeSend = $false
            $script:journal = $Journal
            function Start-Sleep { param($Milliseconds) }
            function New-YtBrowserTab { param($Connection, $Url) return [pscustomobject]@{SessionId='fixture';TargetId='fixture'} }
            function Invoke-YtNavigationProbe {
                param($Connection, $SessionId, $Expression)
                if ($script:phase -eq 'transcript') {
                    $id = if ($script:scenario -eq 'wrong-video') { '14RP8liACqo' } else { 'JZn5RLXQFtg' }
                    return [pscustomobject]@{url="https://youtubetotranscript.com/transcript?v=$id";count=3;text='Full clean transcript.';ready='complete';challenge=$false}
                }
                $text = if ($script:scenario -eq 'draft') { 'My unsaved draft' } else { $script:inserted }
                $sent = $script:phase -eq 'sent'
                return [pscustomobject]@{
                    kind='ready';busy=$false;text=$text;canSend=$true;messageCount=[int]$sent;lastMessage=$(if ($sent) {$script:inserted} else {''})
                    assistantMessageCount=[int]$sent;lastAssistantText=$(if ($sent) {'Complete summary.'} else {''})
                    failureKind='';failureMessage='';url=$(if($sent){'https://chatgpt.com/c/fixture'}else{'https://chatgpt.com/'})
                }
            }
            function Invoke-YtCdp {
                param($Connection, $Method, $Parameters, $SessionId)
                if ($Method -eq 'Page.navigate') {
                    $script:phase = 'chatgpt'
                    return [pscustomobject]@{frameId='fixture'}
                }
                if ($Method -eq 'Input.insertText') { $script:inserted = $Parameters.text; return [pscustomobject]@{} }
                throw "Unexpected fixture command: $Method"
            }
            function Focus-YtComposer { param($Connection, $SessionId) }
            function Send-YtComposer {
                param($Connection, $SessionId, $ExpectedText)
                $script:sendCount++
                $script:durableBeforeSend = Test-Path -LiteralPath $script:journal
                if ($script:scenario -eq 'disconnect') { throw 'Fixture browser disconnected during send.' }
                $script:phase = 'sent'
            }
            $server = [pscustomobject]@{
                StopRequested=$false;IsRunning=$true;LastServerError='';DispatchPaused=$false;ResultUrl='';
                State='queued';Message='';States=(New-Object 'Collections.Generic.List[string]')
            }
            $server | Add-Member -MemberType ScriptMethod -Name UpdateJob -Value {
                param($Id, $State, $Message)
                $this.State = $State
                $this.Message = $Message
                $this.States.Add($State)
            }
            $server | Add-Member -MemberType ScriptMethod -Name SetResultUrl -Value { param($Id,$Url) $this.ResultUrl=$Url }
            $server | Add-Member -MemberType ScriptMethod -Name ClearJobPartResultUrls -Value { param($Id) }
            $job = [pscustomobject]@{Id='fixture';RequestId=[guid]::NewGuid().ToString();VideoId='JZn5RLXQFtg'}
            Invoke-YtSummaryJob $null $server $job -JournalPath $Journal -WaitSeconds 1 -WarningAction SilentlyContinue
            return [pscustomobject]@{
                State=$server.State;Message=$server.Message;Sent=$script:sendCount;
                Text=$script:inserted;Durable=$script:durableBeforeSend;JournalExists=(Test-Path -LiteralPath $Journal);
                States=($server.States -join ',')
            }
        } $scenario $journal
        switch ($scenario) {
            'success' {
                $expectedPrompt = "Full clean transcript.`n`n" +
                    "Start your reply with exactly these two lines, then one blank line, then the requested output:`n" +
                    "JZn5RLXQFtg`nhttps://www.youtube.com/watch?v=JZn5RLXQFtg`n" +
                    "Do not translate, shorten or alter those two header lines.`n" +
                    'Summarize this video.'
                if ($result.State -ne 'completed' -or $result.Sent -ne 1 -or -not $result.Durable -or $result.JournalExists -or
                    $result.Text -cne $expectedPrompt) { throw ($result | ConvertTo-Json) }
            }
            'draft' {
                if ($result.State -ne 'error' -or $result.Sent -ne 0 -or $result.Text -ne '' -or $result.JournalExists) { throw ($result | ConvertTo-Json) }
            }
            'wrong-video' {
                if ($result.State -ne 'error' -or $result.Sent -ne 0 -or $result.Text -ne '') { throw ($result | ConvertTo-Json) }
            }
            'disconnect' {
                if ($result.State -ne 'error' -or $result.Sent -ne 1 -or -not $result.Durable -or -not $result.JournalExists) {
                    throw ($result | ConvertTo-Json)
                }
            }
        }
        Write-Output "PASS: offline state-machine scenario '$scenario'"
        $total++
    } finally {
        if (Test-Path -LiteralPath $journal) { Remove-Item -LiteralPath $journal }
    }
}
Write-Output "ALL $total offline state-machine scenarios passed. No browser or network connection was used."
