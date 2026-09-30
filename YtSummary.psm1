Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'TranscriptChunks.psm1') -Force -Scope Local -DisableNameChecking
Import-Module (Join-Path $PSScriptRoot 'Providers.psm1') -Force -Scope Local -DisableNameChecking

function Get-YtBrowser {
    param([ValidateSet('Chrome', 'Edge')][string]$Browser = 'Chrome')
    $vendor = if ($Browser -eq 'Chrome') { 'Google\Chrome' } else { 'Microsoft\Edge' }
    foreach ($hive in @('HKLM:', 'HKCU:')) {
        $key = "$hive\SOFTWARE\Policies\$vendor"
        if (Test-Path $key) {
            $policy = Get-ItemProperty $key
            if ($policy.PSObject.Properties['RemoteDebuggingAllowed'] -and $policy.RemoteDebuggingAllowed -eq 0) {
                throw "$Browser remote debugging is disabled by company policy."
            }
            if ($policy.PSObject.Properties['DeveloperToolsAvailability'] -and $policy.DeveloperToolsAvailability -eq 2) {
                throw "$Browser developer tools are disabled by company policy."
            }
            if ($policy.PSObject.Properties['UserDataDir'] -and $policy.UserDataDir) {
                throw "$Browser has a managed profile location. This helper will not override it."
            }
        }
    }
    $relative = if ($Browser -eq 'Chrome') { 'Google\Chrome\Application\chrome.exe' } else { 'Microsoft\Edge\Application\msedge.exe' }
    foreach ($root in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
        if ($root) {
            $path = Join-Path $root $relative
            if (Test-Path -LiteralPath $path) { return $path }
        }
    }
    throw "$Browser was not found. Install nothing automatically; select an already installed, permitted browser."
}

function Set-YtJobTitle {
    param($Server, $Job, [string]$Title)
    $clean = ($Title -replace '\s+', ' ').Trim()
    if (-not $clean -or $clean.Length -gt 300) { return }
    if ($Job.PSObject.Properties['Title']) { $Job.Title = $clean }
    if ($null -ne $Server -and $null -ne $Server.GetType().GetMethod('SetJobTitle')) {
        $Server.SetJobTitle($Job.Id, $clean)
    }
}

function Open-YtCdp {
    param(
        [Parameter(Mandatory)][string]$WebSocketUrl,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    $uri = [Uri]$WebSocketUrl
    if ($uri.Scheme -ne 'ws' -or $uri.Host -notin @('127.0.0.1', 'localhost', '[::1]')) {
        throw 'Refusing a non-loopback browser debugging connection.'
    }
    $socket = New-Object System.Net.WebSockets.ClientWebSocket
    $socket.Options.Proxy = $null
    $cancel = [System.Threading.CancellationTokenSource]::CreateLinkedTokenSource(
        $CancellationToken, [System.Threading.CancellationToken]::None)
    $cancel.CancelAfter(10000)
    try {
        $null = $socket.ConnectAsync($uri, $cancel.Token).GetAwaiter().GetResult()
        return [pscustomobject]@{ Socket = $socket; NextId = 0; CancellationToken = $CancellationToken }
    } catch {
        $socket.Dispose()
        throw
    } finally {
        $cancel.Dispose()
    }
}

function Invoke-YtCdp {
    param(
        [Parameter(Mandatory)]$Connection,
        [Parameter(Mandatory)][string]$Method,
        [hashtable]$Parameters = @{},
        [string]$SessionId,
        [int]$TimeoutSeconds = 15,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    $Connection.NextId++
    $id = $Connection.NextId
    $request = @{ id = $id; method = $Method; params = $Parameters }
    if ($SessionId) { $request.sessionId = $SessionId }
    $bytes = [Text.Encoding]::UTF8.GetBytes(($request | ConvertTo-Json -Depth 30 -Compress))
    $connectionToken = [System.Threading.CancellationToken]::None
    if ($Connection.PSObject.Properties['CancellationToken']) { $connectionToken = $Connection.CancellationToken }
    $cancel = [System.Threading.CancellationTokenSource]::CreateLinkedTokenSource($connectionToken, $CancellationToken)
    $cancel.CancelAfter($TimeoutSeconds * 1000)
    try {
        $cancel.Token.ThrowIfCancellationRequested()
        $segment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$bytes)
        $null = $Connection.Socket.SendAsync($segment, [Net.WebSockets.WebSocketMessageType]::Text, $true, $cancel.Token).GetAwaiter().GetResult()
        while ($true) {
            $stream = New-Object IO.MemoryStream
            try {
                do {
                    $buffer = New-Object byte[] 16384
                    $receiveSegment = New-Object 'System.ArraySegment[byte]' -ArgumentList @(,$buffer)
                    $frame = $Connection.Socket.ReceiveAsync($receiveSegment, $cancel.Token).GetAwaiter().GetResult()
                    if ($frame.MessageType -eq [Net.WebSockets.WebSocketMessageType]::Close) {
                        throw 'The controlled browser disconnected.'
                    }
                    $stream.Write($buffer, 0, $frame.Count)
                    if ($stream.Length -gt 8388608) { throw 'Browser response exceeded the safety limit.' }
                } until ($frame.EndOfMessage)
                $response = [Text.Encoding]::UTF8.GetString($stream.ToArray()) | ConvertFrom-Json
            } finally {
                $stream.Dispose()
            }
            if ($response.PSObject.Properties['id'] -and $response.id -eq $id) {
                if ($response.PSObject.Properties['error']) {
                    throw "Browser command $Method failed: $($response.error.message)"
                }
                return $response.result
            }
        }
    } catch [System.OperationCanceledException] {
        if ($cancel.IsCancellationRequested -and -not $connectionToken.IsCancellationRequested -and
            -not $CancellationToken.IsCancellationRequested) {
            throw (New-Object System.TimeoutException -ArgumentList (
                "The browser did not respond to $Method within $TimeoutSeconds seconds. Check its tab and the job status before retrying."), $_.Exception)
        }
        throw
    } finally {
        $cancel.Dispose()
    }
}

function Invoke-YtPageScript {
    param($Connection, [string]$SessionId, [string]$Expression, [int]$TimeoutSeconds = 15)
    $response = Invoke-YtCdp $Connection 'Runtime.evaluate' @{
        expression = $Expression
        returnByValue = $true
        awaitPromise = $true
    } $SessionId $TimeoutSeconds
    if ($response.PSObject.Properties['exceptionDetails']) {
        $detail = if ($response.exceptionDetails.exception.PSObject.Properties['description']) {
            [string]$response.exceptionDetails.exception.description
        } else { '' }
        throw "Page script failed: $($response.exceptionDetails.text) $detail"
    }
    if ($response.result.PSObject.Properties['value']) { return $response.result.value }
}

function Invoke-YtNavigationProbe {
    param($Connection, [string]$SessionId, [string]$Expression, [int]$TimeoutSeconds = 15)
    try {
        return Invoke-YtPageScript $Connection $SessionId $Expression $TimeoutSeconds
    } catch [System.TimeoutException] {
        # Invoke-YtCdp raises this only when its own per-call watchdog fires, never for a real
        # stop or job cancellation (those rethrow the OperationCanceledException instead).
        # Cancelling ClientWebSocket I/O can abort the socket itself. Reusing that socket caused
        # the next poll to fail immediately with an opaque "invalid state ('Aborted')" error.
        # Let the worker reconnect when that happened; only a still-open socket gets a missed poll.
        $socketState = if ($null -ne $Connection -and $Connection.PSObject.Properties['Socket'] -and
            $null -ne $Connection.Socket -and $Connection.Socket.PSObject.Properties['State']) {
            [string]$Connection.Socket.State
        } else { '' }
        if ($socketState -and $socketState -ne 'Open') {
            throw (New-Object System.IO.IOException -ArgumentList (
                "The browser WebSocket became $socketState after Runtime.evaluate timed out; reconnecting this job."), $_.Exception)
        }
        # One slow round-trip on a socket that remains usable is a missed poll, so the caller's
        # longer transcript deadline remains in charge.
        return $null
    } catch {
        # Navigation invalidates execution contexts; only these errors are retried.
        if ($_.Exception.Message -match 'Execution context was destroyed|Cannot find context|Cannot find default execution context') {
            return $null
        }
        if ($_.Exception.Message -match 'WebSocket is in an invalid state.*Aborted') {
            throw (New-Object System.IO.IOException -ArgumentList (
                'The browser WebSocket became Aborted while reading the page; reconnecting this job.'), $_.Exception)
        }
        throw
    }
}

function Test-YtTransientInfrastructureFailure {
    param(
        [Parameter(Mandatory)][System.Exception]$Exception,
        $Server,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    if ($Exception -is [System.OperationCanceledException]) {
        return -not $CancellationToken.IsCancellationRequested -and
            ($null -eq $Server -or -not $Server.StopRequested)
    }
    return $Exception.Message -match (
        'Target\.createTarget failed|Failed to open a new tab|' +
        'Session with given id not found|internal WebSocket error|' +
        'browser WebSocket became .*?(?:after Runtime\.evaluate timed out|while reading the page)|' +
        'WebSocket is in an invalid state.*Aborted|' +
        'Unable to remove the file to be replaced|Could not persist .*(?:used by another process|lock|sharing violation)'
    )
}

function Invoke-YtWithInfrastructureRetry {
    param(
        [Parameter(Mandatory)][scriptblock]$Operation,
        [string]$Description = 'browser operation',
        $Server,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None,
        [ValidateRange(1, 3)][int]$MaxAttempts = 3
    )
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try { return & $Operation }
        catch {
            if ($attempt -ge $MaxAttempts -or
                -not (Test-YtTransientInfrastructureFailure $_.Exception $Server $CancellationToken)) {
                if ($attempt -ge $MaxAttempts) { $_.Exception.Data['YtRetriesExhausted'] = $true }
                throw
            }
            # Callers with a job provide the visible reason themselves; this helper stays reusable.
            Start-Sleep -Milliseconds (150 * $attempt)
        }
    }
}

function New-YtBrowserTab {
    param(
        $Connection, [string]$Url = 'about:blank', [switch]$Background,
        $Server,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    $parameters = @{ url = $Url }
    if ($Background) { $parameters.background = $true }
    $target = Invoke-YtWithInfrastructureRetry -Description 'opening a browser tab' -Server $Server `
        -CancellationToken $CancellationToken -Operation {
        try { Invoke-YtCdp $Connection 'Target.createTarget' $parameters }
        catch {
            $failure = $_
            if ($failure.Exception.Message -notmatch 'Failed to open a new tab') { throw }
            $targets = Invoke-YtCdp $Connection 'Target.getTargets'
            if (@($targets.targetInfos | Where-Object { $_.type -eq 'page' }).Count -gt 0) { throw $failure }
            Invoke-YtCdp $Connection 'Target.createTarget' @{ url=$Url; newWindow=$true }
        }
    }
    $attached = Invoke-YtWithInfrastructureRetry -Description 'attaching to a browser tab' -Server $Server `
        -CancellationToken $CancellationToken -Operation {
        Invoke-YtCdp $Connection 'Target.attachToTarget' @{ targetId = $target.targetId; flatten = $true }
    }
    Enable-YtBackgroundTabExecution $Connection $attached.sessionId
    if (-not $Background) { $null = Invoke-YtCdp $Connection 'Page.bringToFront' @{} $attached.sessionId }
    return [pscustomobject]@{ TargetId = $target.targetId; SessionId = $attached.sessionId }
}

function Enable-YtBackgroundTabExecution {
    param($Connection, [string]$SessionId, [switch]$BringToFront)
    # Provider sites are timer-driven SPAs. Chrome can still freeze an attached background
    # page despite process-level anti-throttling flags, especially when reusing an older
    # dedicated browser process. These CDP hints are best-effort because older Chrome
    # versions may not implement both methods. Focus emulation makes the page behave as if
    # it were foreground without activating its tab, so provider stages never steal the
    # user's view; -BringToFront stays reserved for tabs the user asked to see.
    try { $null = Invoke-YtCdp $Connection 'Page.setWebLifecycleState' @{ state = 'active' } $SessionId }
    catch { }
    try { $null = Invoke-YtCdp $Connection 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } $SessionId }
    catch { }
    if ($BringToFront) {
        try { $null = Invoke-YtCdp $Connection 'Page.bringToFront' @{} $SessionId }
        catch { }
    }
}

function Start-YtBrowser {
    param([string]$BrowserPath, [string]$ProfileDirectory, [string]$InitialUrl = 'https://chatgpt.com/')
    $null = New-Item -ItemType Directory -Path $ProfileDirectory -Force
    $endpointFile = Join-Path $ProfileDirectory 'YT-Summary-endpoint.json'
    if (Test-Path -LiteralPath $endpointFile) {
        $existing = Get-Content -LiteralPath $endpointFile -Raw | ConvertFrom-Json
        $existingPort = 0
        if (-not [int]::TryParse([string]$existing.port, [ref]$existingPort) -or
            $existingPort -lt 1024 -or $existingPort -gt 65535 -or
            $existing.webSocketDebuggerUrl -notlike "ws://127.0.0.1:$existingPort/devtools/browser/*") {
            throw 'The saved browser endpoint is invalid. No browser connection was opened.'
        }
        $listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() |
            Where-Object { $_.Port -eq $existingPort })
        if (@($listeners | Where-Object { -not [Net.IPAddress]::IsLoopback($_.Address) }).Count -gt 0) {
            throw 'The saved browser port is not loopback-only. No browser connection was opened.'
        }
        if ($listeners.Count -gt 0) {
            try {
                $version = Invoke-RestMethod -Uri "http://127.0.0.1:$existingPort/json/version" -TimeoutSec 3 -Proxy $null
            } catch [Net.WebException] {
                throw 'The existing YT Summary browser is not responding. Close only its separate Chrome window, then start the helper again.'
            }
            if ($version.webSocketDebuggerUrl -cne $existing.webSocketDebuggerUrl) {
                throw 'The saved browser port belongs to a different browser session. No connection was opened.'
            }
            return Open-YtCdp $existing.webSocketDebuggerUrl
        }
    }
    # Chrome's special port-0 mode enables its automation flag. Use an ordinary
    # loopback debugging port without changing browser security or page properties.
    $reservation = New-Object Net.Sockets.TcpListener -ArgumentList ([Net.IPAddress]::Loopback), 0
    $reservation.Start()
    try { $port = ([Net.IPEndPoint]$reservation.LocalEndpoint).Port }
    finally { $reservation.Stop() }
    $arguments = @(
        "--user-data-dir=`"$ProfileDirectory`"",
        '--remote-debugging-address=127.0.0.1',
        "--remote-debugging-port=$port",
        '--no-first-run',
        # Multiple videos keep several provider tabs open in the background at once. Without
        # these flags Chrome throttles/suspends background and occluded tabs' JavaScript
        # timers, so a background tab's own composer/response readiness can silently stall
        # until the user manually focuses or closes it. These flags keep every automated tab
        # running at full speed regardless of visibility; they do not change page content,
        # security, or network behavior.
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=CalculateNativeWinOcclusion',
        $InitialUrl
    )
    $process = Start-Process -FilePath $BrowserPath -ArgumentList $arguments -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    $lastError = 'No debugging endpoint appeared.'
    while ([DateTime]::UtcNow -lt $deadline) {
        $listeners = @([Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object { $_.Port -eq $port })
        if (@($listeners | Where-Object { -not [Net.IPAddress]::IsLoopback($_.Address) }).Count -gt 0) {
            throw 'Browser debugging is not loopback-only. Close the dedicated browser; automation was not connected.'
        }
        if ($listeners.Count -gt 0) {
            try {
                $version = Invoke-RestMethod -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 2 -Proxy $null
                if ($version.webSocketDebuggerUrl -notlike "ws://127.0.0.1:$port/devtools/browser/*") {
                    throw 'The browser returned an unexpected debugging address.'
                }
                $connection = Open-YtCdp $version.webSocketDebuggerUrl
                try {
                    $endpoint = @{ port = $port; webSocketDebuggerUrl = $version.webSocketDebuggerUrl }
                    [IO.File]::WriteAllText($endpointFile, ($endpoint | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
                } catch {
                    $connection.Socket.Dispose()
                    throw
                }
                return $connection
            } catch [System.Net.WebException] {
                $lastError = $_.Exception.Message
            }
        }
        Start-Sleep -Milliseconds 300
    }
    throw "Browser debugging did not start. It may be blocked by policy. No policy was changed. Close any old YT Summary browser window and retry. $lastError"
}

function Test-YtTranscriptTitleMatches {
    <#
    Defensive, fail-closed cross-check for a specific real production incident: a
    retried job's browser correctly navigated to the transcript site with the right
    videoId in the URL, yet the transcript text that was ultimately sent belonged to a
    different video. The URL/query-param check above only confirms the address bar,
    never the page's own rendered content, so it cannot catch a third-party site
    momentarily serving/rendering the wrong video for a matching URL (for example, an
    SPA history-state or CDN-cache artifact under concurrent load). This compares the
    transcript site's own displayed video title against the job's already-known,
    independently-verified title (set either from the request that created the job or
    from a direct YouTube lookup keyed to this job's own VideoId - see
    Get-YtYouTubeVideoMetadata / Invoke-YtTitleWorker.ps1) and refuses to proceed on a
    clear mismatch instead of silently sending the wrong content to an LLM.
    Comparison is intentionally tolerant (normalized, truncation-safe substring match)
    so it never blocks a legitimate send over whitespace/casing/truncation
    differences; it only fires on titles that plainly do not correspond to each other.
    #>
    param([string]$JobTitle, [string]$SiteTitle)
    # The transcript site's own generic placeholder page titles (matched to the same
    # strings LoopbackServer.cs treats as "no real title yet") are not a real per-video
    # title at all; comparing against one would only ever produce false refusals, so
    # treat them exactly like an unknown title.
    $placeholders = @(
        'youtube transcript generator extract download video transcripts',
        'youtube transcript generator',
        'transcript workspace youtube transcript ai'
    )
    $normalize = {
        param($value)
        $clean = ([string]$value -replace '[^\p{L}\p{Nd}\s]', ' ')
        return ($clean -replace '\s+', ' ').Trim().ToLowerInvariant()
    }
    $job = & $normalize $JobTitle
    $site = & $normalize $SiteTitle
    if (-not $job -or -not $site -or $site -in $placeholders) { return $true }
    if ($job.Length -lt 4 -or $site.Length -lt 4) { return $true }
    if ($job -ceq $site) { return $true }
    if ($job.Length -le $site.Length) { $shorter = $job; $longer = $site } else { $shorter = $site; $longer = $job }
    return $longer.Contains($shorter)
}

function Get-YtTranscriptSourceDomains {
    <#
    Ordered list of transcript-extraction websites tried in sequence when the
    current site's Cloudflare/bot-check does not clear within the per-attempt
    wait window. youtubetotranscript.com is the only source: it is the
    original, fully verified source. The previously supported
    youtube-transcript.io source is intentionally excluded because its
    anonymous-connection alert can block unattended browser automation, and
    youtube-transcript.ai is disabled for now until it is re-verified.
    If a site's real markup does not match, that attempt simply yields zero
    transcript text and the helper moves on without sending partial content.
    #>
    return @(
        [pscustomobject]@{ Hostnames=@('youtubetotranscript.com'); Path='/transcript'; QueryParam='v'; UrlTemplate='https://youtubetotranscript.com/transcript?v={0}' }
    )
}

function Get-YtTranscriptExpression {
    return @'
(() => {
  const KNOWN_HOSTS = {
    'youtubetotranscript.com': '/transcript'
  };
  const u = new URL(location.href);
  const titleElement = document.querySelector('[data-video-title], .video-title, h1');
  const videoTitle = (titleElement?.textContent || document.querySelector('meta[property="og:title"]')?.content || document.title || '')
    .replace(/\s+/g, ' ').replace(/\s*[-|]\s*YouTube(?:ToTranscript(?:\.com)?)?\s*$/i, '').trim().slice(0, 300);
  const result = {url:u.href, title:document.title, videoTitle, ready:document.readyState, count:0, text:'', challenge:false, failure:''};
  const expectedPath = KNOWN_HOSTS[u.hostname];
  if (!expectedPath || u.pathname !== expectedPath) return result;
  const CANDIDATE_SELECTORS = [
    '#transcript p span[data-start]',
    '[data-start]',
    '.transcript-segment',
    '.transcript-line',
    '.transcript p',
    'div[class*="transcript" i] p',
    'div[id*="transcript" i] p'
  ];
  let segments = [];
  for (const selector of CANDIDATE_SELECTORS) {
    segments = [...document.querySelectorAll(selector)]
      .filter(el => !/badge|button|copy|download|icon/i.test(el.className || ''));
    if (segments.length) break;
  }
  result.count = segments.length;
  result.text = segments.map(el => {
    const copy = el.cloneNode(true);
    copy.querySelectorAll('[class*="badge" i], button, [class*="copy" i], [class*="download" i]').forEach(n => n.remove());
    return (copy.textContent || '').replace(/\s+/g, ' ').trim();
  }).join(' ').replace(/\s+/g, ' ').trim();
  result.challenge = /just a moment|verify you are human|security verification|checking your browser/i.test(
    document.title + ' ' + (document.body?.innerText || '').slice(0, 3000));
  if (!result.count && !result.challenge &&
      /youtube\s+blocked\s+us|youtube\s+is\s+blocking/i.test((document.body?.innerText || '').slice(0, 16000))) {
    result.failure = 'YouTube blocked the transcript service.';
  }
  return result;
})()
'@
}

function Get-YtYouTubeTranscriptExpression {
    param(
        [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_-]{11}$')][string]$VideoId,
        [switch]$OpenTranscript
    )
    $expression = @'
(() => {
  const u = new URL(location.href);
  const expectedVideo = __YT_VIDEO_ID__;
  const result = {url:u.href, ready:document.readyState, count:0, text:'', challenge:false, failure:'',
    unavailable:false, captionsAvailable:false, action:'', phase:'waiting-page'};
  if (u.hostname === 'consent.youtube.com' || u.hostname === 'accounts.google.com') {
    result.challenge = true;
    result.phase = 'verification';
    return result;
  }

  if (u.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname)) return result;
  if (u.pathname !== '/watch' || u.searchParams.get('v') !== expectedVideo) {
    result.failure = 'The YouTube page changed to a different video. Nothing was sent to ChatGPT.';
    return result;
  }
  const watch = document.querySelector('ytd-watch-flexy');
  if (!watch || watch.getAttribute('video-id') !== expectedVideo) return result;
  const visible = el => !!el && !el.closest('[hidden], [aria-hidden="true"]') && !!el.getClientRects().length;
  const commandData = el => el?.data || el?.__data?.data || el?.__dataHost?.data || {};
  const hasTranscriptCommand = el => {
    const data = commandData(el);
    const endpoint = data.serviceEndpoint || data.navigationEndpoint || data.command ||
      data.onTap || data.buttonRenderer?.serviceEndpoint || {};
    return !!(endpoint.getTranscriptEndpoint ||
      endpoint.commandExecutorCommand?.commands?.some(command => command?.getTranscriptEndpoint));
  };
  const transcriptLabel = el => {
    const data = commandData(el);
    return [
      el?.getAttribute?.('aria-label'), el?.getAttribute?.('title'), el?.textContent,
      data.text?.simpleText, data.text?.runs?.map(run => run.text).join(''),
      data.title?.simpleText, data.title?.runs?.map(run => run.text).join('')
    ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
  };
  const looksLikeTranscript = el => hasTranscriptCommand(el) ||
    /(?:^|\s)(?:show\s+)?transcript(?:\s|$)|תמליל/.test(transcriptLabel(el));
  const player = document.querySelector('#movie_player');
  const response = typeof player?.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
  const captionTracks = response?.videoDetails?.videoId === expectedVideo &&
    response?.playabilityStatus?.status === 'OK'
      ? response?.captions?.playerCaptionsTracklistRenderer?.captionTracks
      : null;
  result.captionsAvailable = !!captionTracks?.length;
  const playerError = document.querySelector('yt-playability-error-supported-renderers');
  if (visible(playerError) && (playerError.innerText || '').trim()) {
    result.failure = 'YouTube cannot play this video in the helper browser. Open its tab to check access, sign-in or verification. Nothing was sent to ChatGPT.';
    return result;
  }
  const panel = [...document.querySelectorAll('ytd-engagement-panel-section-list-renderer[target-id*="transcript"]')]
    .find(el => el.getAttribute('visibility') === 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED' && visible(el));
  if (panel) {
    result.phase = 'panel-open';
    if ([...panel.querySelectorAll('input')].some(el => el.value.trim())) {
      result.failure = "Clear the search in YouTube's transcript before retrying. Filtered captions were not sent to ChatGPT.";
      return result;
    }
    const loading = [...panel.querySelectorAll('ytd-continuation-item-renderer, [aria-busy="true"], tp-yt-paper-spinner[active]')].some(visible);
    if (loading) {
      result.phase = 'panel-loading';
      return result;
    }
    const segments = [...panel.querySelectorAll('ytd-transcript-segment-renderer .segment-text')];
    result.count = segments.length;
    result.text = segments.map(el => (el.textContent || '').replace(/\s+/g, ' ').trim()).join(' ').trim();
    result.phase = result.count > 0 && result.text ? 'transcript-ready' : 'panel-empty';
    return result;
  }
  const expander = document.querySelector('#description-inline-expander');
  const expand = expander?.querySelector('#expand');
  if (expander && !expander.hasAttribute('is-expanded') && visible(expand)) {
    result.phase = 'description-collapsed';
    expand.click();
    result.action = 'expand-description';
    return result;
  }
  const enabled = el => visible(el) && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
  const directCandidates = [
    ...document.querySelectorAll(
      'ytd-video-description-transcript-section-renderer button,' +
      'ytd-video-description-transcript-section-renderer [role="button"],' +
      '[target-id*="transcript"] button,[target-id*="transcript"] [role="button"]')
  ];
  const button = directCandidates.find(enabled) ||
    [...document.querySelectorAll('ytd-watch-metadata button, ytd-watch-metadata [role="button"]')]
      .find(el => enabled(el) && looksLikeTranscript(el));
  if (button) {
    result.phase = 'transcript-control-found';
    if (__YT_OPEN__) {
      button.click();
      result.action = 'open-transcript';
    }
    return result;
  }
  if (expander?.hasAttribute('is-expanded') && response?.videoDetails?.videoId === expectedVideo &&
      response?.playabilityStatus?.status === 'OK' && !captionTracks?.length) {
    result.unavailable = true;
    result.phase = 'no-captions';
    return result;
  }

  // Some YouTube layouts expose Show transcript only inside the watch-page overflow menu.
  // Prefer command metadata because the visible label is localized and changes across cohorts.
  const menuItem = [
    ...document.querySelectorAll(
      'ytd-menu-popup-renderer ytd-menu-service-item-renderer,' +
      'ytd-menu-popup-renderer tp-yt-paper-item,' +
      'ytd-menu-popup-renderer yt-list-item-view-model,' +
      'tp-yt-iron-dropdown ytd-menu-service-item-renderer,' +
      'tp-yt-iron-dropdown tp-yt-paper-item,' +
      'tp-yt-iron-dropdown yt-list-item-view-model')
  ].find(el => enabled(el) && looksLikeTranscript(el));
  if (menuItem) {
    result.phase = 'transcript-menu-item-found';
    if (__YT_OPEN__) {
      menuItem.click();
      result.action = 'open-transcript';
    }
    return result;
  }
  const openMenu = [
    ...document.querySelectorAll('ytd-menu-popup-renderer, tp-yt-iron-dropdown')
  ].find(visible);
  if (openMenu) {
    result.phase = 'overflow-menu-open';
    return result;
  }
  const overflow = [
    ...document.querySelectorAll(
      'ytd-watch-metadata #actions ytd-menu-renderer > yt-icon-button.dropdown-trigger,' +
      'ytd-watch-metadata #actions ytd-menu-renderer > yt-icon-button#button,' +
      'ytd-watch-metadata #actions ytd-menu-renderer > button[aria-haspopup="true"],' +
      'ytd-watch-metadata #actions ytd-menu-renderer > yt-button-shape button[aria-haspopup="true"],' +
      'ytd-watch-metadata ytd-menu-renderer yt-icon-button.dropdown-trigger')
  ].find(enabled);
  if (overflow) {
    result.phase = 'overflow-control-found';
    if (__YT_OPEN__) {
      overflow.click();
      result.action = 'open-transcript-menu';
    }
    return result;
  }
  result.phase = result.captionsAvailable ? 'entry-missing-with-captions' : 'entry-missing';
  return result;
})()
'@
    return $expression.Replace('__YT_VIDEO_ID__', (ConvertTo-Json $VideoId -Compress)).
        Replace('__YT_OPEN__', $OpenTranscript.IsPresent.ToString().ToLowerInvariant())
}

function Get-YtYouTubeCaptionTrackExpression {
    param(
        [Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_-]{11}$')][string]$VideoId,
        [ValidateRange(250, 60000)][int]$FetchTimeoutMilliseconds = 10000
    )
    $expression = @'
(async () => {
  const u = new URL(location.href);
  const expectedVideo = __YT_VIDEO_ID__;
  const result = {url:u.href, count:0, text:'', failure:'', retryable:false,
    unavailable:false, captionsAvailable:false, phase:'caption-track-waiting'};
  if (u.hostname === 'consent.youtube.com' || u.hostname === 'accounts.google.com') {
    result.phase = 'verification';
    return result;
  }
  if (u.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname) ||
      u.pathname !== '/watch' || u.searchParams.get('v') !== expectedVideo) {
    result.failure = 'The YouTube page changed to a different video. Nothing was sent to ChatGPT.';
    return result;
  }
  const watch = document.querySelector('ytd-watch-flexy');
  if (!watch || watch.getAttribute('video-id') !== expectedVideo) return result;
  const player = document.querySelector('#movie_player');
  const response = typeof player?.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
  if (response?.videoDetails?.videoId !== expectedVideo || response?.playabilityStatus?.status !== 'OK') return result;
  const renderer = response?.captions?.playerCaptionsTracklistRenderer;
  const tracks = renderer?.captionTracks || [];
  const selectTrack = candidates => candidates.find(item =>
    item?.baseUrl && String(item.languageCode || '').toLowerCase() === 'en') ||
    candidates.find(item => item?.baseUrl && !item?.kind) ||
    candidates.find(item => item?.baseUrl);
  result.captionsAvailable = tracks.length > 0;
  if (!tracks.length) {
    result.unavailable = true;
    result.phase = 'no-caption-track';
    return result;
  }
  const defaultAudioIndex = Number.isInteger(renderer?.defaultAudioTrackIndex)
    ? renderer.defaultAudioTrackIndex : 0;
  const audioTrack = renderer?.audioTracks?.[defaultAudioIndex];
  const preferredIndex = Number.isInteger(audioTrack?.defaultCaptionTrackIndex)
    ? audioTrack.defaultCaptionTrackIndex
    : (Array.isArray(audioTrack?.captionTrackIndices) ? audioTrack.captionTrackIndices[0] : -1);
  const track = (Number.isInteger(preferredIndex) && tracks[preferredIndex]?.baseUrl
      ? tracks[preferredIndex] : null) ||
    selectTrack(tracks);
  if (!track?.baseUrl) {
    result.phase = 'caption-track-url-missing';
    return result;
  }
  const cacheKey = `__ytSummaryCaptionTrack_${expectedVideo}`;
  if (window[cacheKey]?.text) {
    result.count = window[cacheKey].count;
    result.text = window[cacheKey].text;
    result.phase = 'caption-track-ready';
    return result;
  }
  const inFlightKey = `${cacheKey}_inFlight`;
  if (window[inFlightKey]) {
    result.phase = 'caption-track-in-flight';
    return result;
  }
  window[inFlightKey] = true;
  try {
    const trackUrl = new URL(track.baseUrl);
    if (trackUrl.protocol !== 'https:' ||
        !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(trackUrl.hostname) ||
        trackUrl.pathname !== '/api/timedtext' ||
        trackUrl.searchParams.get('v') !== expectedVideo) {
      result.failure = 'YouTube exposed an unexpected caption-track URL. Nothing was sent to ChatGPT.';
      result.phase = 'caption-track-url-rejected';
      return result;
    }
    const fetchCaption = async url => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(250, Math.floor(__YT_FETCH_TIMEOUT_MS__ / 2)));
      try {
        const response = await fetch(url, {credentials:'include', cache:'no-store', signal:controller.signal});
        let body = '';
        if (response.ok) {
          body = typeof response.text === 'function'
            ? await response.text()
            : JSON.stringify(await response.json());
        }
        return {ok:response.ok, status:response.status, body};
      } finally {
        clearTimeout(timer);
      }
    };
    const validTrackUrl = candidate => {
      const url = new URL(candidate.baseUrl);
      if (url.protocol !== 'https:' ||
          !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname) ||
          url.pathname !== '/api/timedtext' || url.searchParams.get('v') !== expectedVideo)
        throw new Error('unexpected caption-track URL');
      return url;
    };
    const jsonLines = body => {
      if (!body?.trim()) throw new SyntaxError('YouTube returned an empty json3 caption body.');
      const parsed = JSON.parse(body), parsedLines = [];
      for (const event of parsed?.events || []) {
        if (event?.aAppend || !Array.isArray(event?.segs)) continue;
        const line = event.segs.map(segment => segment?.utf8 || '').join('').replace(/\s+/g, ' ').trim();
        if (line) parsedLines.push(line);
      }
      if (!parsedLines.length) throw new SyntaxError('json3 contained no text.');
      return parsedLines;
    };
    // YouTube pages enforce Trusted Types, which makes DOMParser.parseFromString throw.
    const xmlLines = body => {
      const decode = value => value.replace(/<[^>]*>/g, '')
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
      const cues = body?.trim() ? (body.match(/<(p|text)\b[^>]*>[\s\S]*?<\/\1>/g) || []) : [];
      const parsedLines = cues.map(cue => decode(cue.replace(/^<(?:p|text)\b[^>]*>/, '')
        .replace(/<\/(?:p|text)>$/, '')).replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (!parsedLines.length) throw new SyntaxError('XML was empty or malformed.');
      return parsedLines;
    };
    const readTrack = async candidate => {
      const base = validTrackUrl(candidate);
      const jsonUrl = new URL(base.href);
      jsonUrl.searchParams.set('fmt', 'json3');
      const jsonResponse = await fetchCaption(jsonUrl.href);
      if (!jsonResponse.ok) return {lines:[], failure:`json3 HTTP ${jsonResponse.status}`, retryable:jsonResponse.status === 429 || jsonResponse.status >= 500};
      try { return {lines:jsonLines(jsonResponse.body), failure:'', retryable:false}; }
      catch (jsonError) {
        const xmlUrl = new URL(base.href);
        xmlUrl.searchParams.set('fmt', 'srv3');
        const xmlResponse = await fetchCaption(xmlUrl.href);
        if (!xmlResponse.ok) return {lines:[], failure:`json3 ${jsonError.message}; XML HTTP ${xmlResponse.status}`, retryable:xmlResponse.status === 429 || xmlResponse.status >= 500};
        try { return {lines:xmlLines(xmlResponse.body), failure:'', retryable:false}; }
        catch (xmlError) { return {lines:[], failure:`json3 ${jsonError.message}; ${xmlError.message}`, retryable:true}; }
      }
    };
    let read;
    try { read = await readTrack(track); }
    catch (error) {
      result.failure = error.message === 'unexpected caption-track URL'
        ? 'YouTube exposed an unexpected caption-track URL. Nothing was sent to ChatGPT.'
        : `YouTube caption-track read failed: ${error.message || error}.`;
      result.retryable = error.name === 'AbortError' || error instanceof TypeError;
      result.phase = error.message === 'unexpected caption-track URL' ? 'caption-track-url-rejected' : 'caption-track-error';
      return result;
    }
    let lines = read.lines;
    let failure = read.failure;
    let retryable = read.retryable;
    if (!lines.length) {
      // WEB caption requests can be accepted with an empty body for videos whose Android
      // player response exposes perfectly valid tracks. Ask YouTube from this same signed-in
      // page; no API key, URL or transcript leaves the browser or reaches diagnostics.
      const key = window.ytcfg?.get?.('INNERTUBE_API_KEY') || window.ytcfg?.data_?.INNERTUBE_API_KEY;
      if (key) {
        try {
          const androidResponse = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`, {
            method:'POST', credentials:'include', cache:'no-store',
            headers:{'content-type':'application/json', 'x-youtube-client-name':'3', 'x-youtube-client-version':'20.10.38'},
            body:JSON.stringify({videoId:expectedVideo, contentCheckOk:true, racyCheckOk:true,
              context:{client:{clientName:'ANDROID', clientVersion:'20.10.38', androidSdkVersion:30, hl:'en', gl:'US'}}})
          });
          const android = androidResponse.ok ? await androidResponse.json() : null;
          const androidTracks = android?.playabilityStatus?.status === 'OK'
            ? android?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [] : [];
          const androidTrack = selectTrack(androidTracks);
          if (androidTrack) {
            const androidRead = await readTrack(androidTrack);
            if (androidRead.lines.length) {
              lines = androidRead.lines;
              failure = '';
              retryable = false;
            } else {
              failure += `; Android player ${androidRead.failure}`;
              retryable = retryable || androidRead.retryable;
            }
          } else {
            failure += '; Android player exposed no usable caption track';
          }
        } catch {
          failure += '; Android player fallback did not return usable captions';
        }
      }
    }
    if (!lines.length) {
      result.failure = `YouTube caption-track formats failed: ${failure || 'contained no text'}.`;
      result.retryable = retryable;
      result.phase = 'caption-track-format-error';
      return result;
    }
    let totalLength = 0;
    for (const line of lines) {
      totalLength += line.length + 1;
      if (totalLength > 750000) {
        result.failure = 'The YouTube caption track exceeds the helper safety limit. It was not downloaded into the job or sent.';
        result.phase = 'caption-track-too-large';
        return result;
      }
    }
    result.count = lines.length;
    result.text = lines.join(' ').replace(/\s+/g, ' ').trim();
    result.phase = result.count && result.text ? 'caption-track-ready' : 'caption-track-empty';
    if (result.text) window[cacheKey] = {count:result.count, text:result.text};
    return result;
  } catch (error) {
    result.failure = `YouTube caption-track read failed: ${error?.message || error}.`;
    result.retryable = error?.name === 'AbortError' || error instanceof TypeError;
    result.phase = 'caption-track-error';
    return result;
  } finally {
    window[inFlightKey] = false;
  }
})()
'@
    return $expression.Replace('__YT_VIDEO_ID__', (ConvertTo-Json $VideoId -Compress)).
        Replace('__YT_FETCH_TIMEOUT_MS__', $FetchTimeoutMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture))
}

function Get-YtYouTubeTitleExpression {
    param([Parameter(Mandatory)][ValidatePattern('^[A-Za-z0-9_-]{11}$')][string]$VideoId)
    $expression = @'
(() => {
  const u = new URL(location.href), expectedVideo = __YT_VIDEO_ID__;
  const result = {url:u.href, ready:document.readyState, videoTitle:'', durationSeconds:0, challenge:false};
  if (u.hostname === 'consent.youtube.com' || u.hostname === 'accounts.google.com') {
    result.challenge = true;
    return result;
  }
  if (u.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname) ||
      u.pathname !== '/watch' || u.searchParams.get('v') !== expectedVideo) return result;
  const player = document.querySelector('#movie_player');
  try { player?.mute?.(); player?.pauseVideo?.(); } catch {}
  const response = typeof player?.getPlayerResponse === 'function' ? player.getPlayerResponse() : null;
  const title = response?.videoDetails?.videoId === expectedVideo ? response.videoDetails.title : '';
  const rawDuration = response?.videoDetails?.videoId === expectedVideo ? response.videoDetails.lengthSeconds : '';
  const durationSeconds = Number.parseInt(rawDuration, 10);
  result.durationSeconds = Number.isSafeInteger(durationSeconds) && durationSeconds > 0 ? durationSeconds : 0;
  result.videoTitle = (title || document.querySelector('meta[property="og:title"]')?.content ||
    document.querySelector('h1 yt-formatted-string,h1')?.textContent || document.title || '')
    .replace(/\s+-\s+YouTube$/i, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  return result;
})()
'@
    return $expression.Replace('__YT_VIDEO_ID__', (ConvertTo-Json $VideoId -Compress))
}

function Get-YtYouTubeVideoMetadata {
    param(
        $Connection, [Parameter(Mandatory)][string]$VideoId,
        [int]$WaitSeconds = 20,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    $tab = $null
    try {
        $tab = New-YtBrowserTab $Connection "https://www.youtube.com/watch?v=$VideoId" -Background `
            -CancellationToken $CancellationToken
        $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
        $polls = 0
        while ([DateTime]::UtcNow -lt $deadline) {
            $CancellationToken.ThrowIfCancellationRequested()
            $snapshot = Invoke-YtNavigationProbe $Connection $tab.SessionId (Get-YtYouTubeTitleExpression $VideoId)
            if ($null -ne $snapshot -and $snapshot.PSObject.Properties['videoTitle'] -and $snapshot.videoTitle) {
                $duration = 0
                if ($snapshot.PSObject.Properties['durationSeconds']) {
                    $duration = [int]$snapshot.durationSeconds
                }
                return [pscustomobject]@{
                    Title = ([string]$snapshot.videoTitle -replace '\s+', ' ').Trim()
                    DurationSeconds = [Math]::Max(0, $duration)
                }
            }
            $polls++
            if ($polls -eq 8) { Enable-YtBackgroundTabExecution $Connection $tab.SessionId -BringToFront }
            Start-Sleep -Milliseconds 500
        }
        throw "YouTube did not expose metadata for video $VideoId within $WaitSeconds seconds."
    } finally {
        if ($null -ne $tab) { Close-YtStageTab $Connection $tab }
    }
}

function Get-YtYouTubeVideoTitle {
    param(
        $Connection, [Parameter(Mandatory)][string]$VideoId,
        [int]$WaitSeconds = 20,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    return (Get-YtYouTubeVideoMetadata -Connection $Connection -VideoId $VideoId `
        -WaitSeconds $WaitSeconds -CancellationToken $CancellationToken).Title
}

function Wait-YtTranscriptService {
    param(
        $Connection, $Server, $Job, $Tab, $Source,
        [int]$WaitSeconds = 15,
        [switch]$AllowForegroundWake,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $probeTimeoutSeconds = [Math]::Min(60, [Math]::Max(1, $WaitSeconds))
    $previous = ''
    $stable = 0
    $unchangedPolls = 0
    $titleMismatches = 0
    $verificationRequired = $false
    while ([DateTime]::UtcNow -lt $deadline) {
        Assert-YtRunning $Server $CancellationToken
        $snapshot = Invoke-YtNavigationProbe $Connection $Tab.SessionId (Get-YtTranscriptExpression) $probeTimeoutSeconds
        if ($null -ne $snapshot -and $snapshot.PSObject.Properties['failure'] -and $snapshot.failure) {
            return [pscustomobject]@{ Text=''; DefiniteFailure=[string]$snapshot.failure; VerificationRequired=$false }
        }
        if ($null -ne $snapshot -and $snapshot.count -gt 0 -and $snapshot.text -and $snapshot.ready -eq 'complete') {
            $actual = [Uri]$snapshot.url
            if ($actual.Host -notin $Source.Hostnames -or $actual.AbsolutePath -ne $Source.Path -or
                $actual.Query -notmatch "(?:^\?|&)$($Source.QueryParam)=$([regex]::Escape($Job.VideoId))(?:&|$)") {
                throw 'The transcript page changed to a different video.'
            }
            if ($snapshot.text -ceq $previous) { $stable++ }
            else { $stable = 0; $unchangedPolls = 0; $titleMismatches = 0; $previous = $snapshot.text }
            if ($stable -ge 3) {
                $jobTitle = if ($Job.PSObject.Properties['Title']) { [string]$Job.Title } else { '' }
                $siteTitle = if ($snapshot.PSObject.Properties['videoTitle']) { [string]$snapshot.videoTitle } else { '' }
                if (-not (Test-YtTranscriptTitleMatches $jobTitle $siteTitle)) {
                    # The transcript text can finish rendering before the page's own
                    # heading/title element has hydrated, so a title read at the exact
                    # instant the text stabilizes can briefly disagree even though this is
                    # genuinely the right video. Confirm a real mismatch by continuing to
                    # re-read the title a bounded number of times (the already-stable text
                    # is not re-fetched) before treating it as an actual cross-video
                    # rejection.
                    $titleMismatches++
                    if ($titleMismatches -lt 5) {
                        Start-Sleep -Milliseconds 500
                        continue
                    }
                    return [pscustomobject]@{
                        Text=''
                        DefiniteFailure="The transcript page's title does not match this video's known title; that service result was rejected."
                        VerificationRequired=$verificationRequired
                    }
                }
                return [pscustomobject]@{ Text=[string]$snapshot.text; DefiniteFailure=''; VerificationRequired=$verificationRequired }
            }
        } else {
            $stable = 0
            if ($null -ne $snapshot -and $snapshot.challenge) {
                $verificationRequired = $true
                $Server.UpdateJob($Job.Id, 'verification',
                    "Transcript verification is still pending on $($Source.Hostnames[0]); YouTube's own transcript is loading in parallel.")
            }
        }
        $unchangedPolls++
        if ($unchangedPolls -ge 8) {
            Enable-YtBackgroundTabExecution $Connection $Tab.SessionId -BringToFront:$AllowForegroundWake
            $unchangedPolls = 0
        }
        Start-Sleep -Milliseconds 500
    }
    return [pscustomobject]@{ Text=''; DefiniteFailure=''; VerificationRequired=$verificationRequired }
}

function Get-YtYouTubeTranscript {
    param(
        $Connection, $Server, $Job, $Tab,
        [int]$WaitSeconds = 60,
        [System.Threading.SemaphoreSlim]$ComposerGate,
        [switch]$SkipNavigation,
        $ServiceTab,
        $ServiceSource,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    $gateHeld = $false
    try {
        if ($null -ne $ComposerGate) {
            $Server.UpdateJob($Job.Id, 'loading', 'Waiting for browser access to try YouTube''s own transcript.')
            while (-not $gateHeld) {
                Assert-YtRunning $Server $CancellationToken
                $gateHeld = $ComposerGate.Wait(200, $CancellationToken)
            }
        }
        Assert-YtRunning $Server $CancellationToken
        try {
            $Server.UpdateJob($Job.Id, 'loading', 'Trying YouTube''s own transcript while the transcript service remains available as a fallback.')
            if (-not $SkipNavigation) {
                $navigation = Invoke-YtCdp $Connection 'Page.navigate' @{url="https://www.youtube.com/watch?v=$($Job.VideoId)"} $Tab.SessionId
                if ($navigation.PSObject.Properties['errorText']) { throw "YouTube transcript navigation failed: $($navigation.errorText). Nothing was sent to ChatGPT." }
            }
            # YouTube can leave transcript requests suspended in a background tab.
            $null = Invoke-YtCdp $Connection 'Page.bringToFront' @{} $Tab.SessionId
        } finally {
            if ($gateHeld) { $null = $ComposerGate.Release(); $gateHeld = $false }
        }
        $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
        $probeTimeoutSeconds = [Math]::Min(60, [Math]::Max(1, $WaitSeconds))
        $previous = ''
        $stable = 0
        $unavailable = 0
        $opened = $false
        $lastPhase = 'waiting-page'
        $lastDiagnostic = 'waiting for the YouTube watch page to finish loading'
        $servicePrevious = ''
        $serviceStable = 0
        $directCaptionFailure = ''
        $directCaptionEnabled = $true
        $directCaptionAttempts = 0
        $directCaptionRetryAt = [DateTime]::MinValue
        while ([DateTime]::UtcNow -lt $deadline) {
            Assert-YtRunning $Server $CancellationToken
            $directSnapshot = $null
            if ($directCaptionEnabled -and [DateTime]::UtcNow -ge $directCaptionRetryAt) {
                $directCaptionAttempts++
                $fetchTimeoutMilliseconds = [Math]::Max(250, [Math]::Min(30000, 10000 * $directCaptionAttempts))
                # An aborted read is retried with a longer deadline, so the CDP probe itself
                # must outlive that longer fetch instead of timing out first.
                $captionProbeSeconds = [Math]::Min(60, [Math]::Max($probeTimeoutSeconds,
                    [int][Math]::Ceiling($fetchTimeoutMilliseconds / 1000.0) + 5))
                $directSnapshot = Invoke-YtNavigationProbe $Connection $Tab.SessionId `
                    (Get-YtYouTubeCaptionTrackExpression -VideoId $Job.VideoId `
                        -FetchTimeoutMilliseconds $fetchTimeoutMilliseconds) $captionProbeSeconds
                if ($null -ne $directSnapshot -and $directSnapshot.PSObject.Properties['count'] -and
                    $directSnapshot.count -gt 0 -and $directSnapshot.text) {
                    $directActual = [Uri]$directSnapshot.url
                    if ($directActual.Scheme -ne 'https' -or
                        $directActual.Host -notin @('www.youtube.com', 'youtube.com', 'm.youtube.com') -or
                        $directActual.AbsolutePath -ne '/watch' -or
                        $directActual.Query -notmatch "(?:^\?|&)v=$([regex]::Escape($Job.VideoId))(?:&|$)") {
                        throw 'The YouTube page changed to a different video. Nothing was sent to ChatGPT.'
                    }
                    return [pscustomobject]@{ Text=[string]$directSnapshot.text; UsedService=$false }
                }
                if ($null -ne $directSnapshot -and $directSnapshot.PSObject.Properties['failure'] -and
                    $directSnapshot.failure) {
                    $directCaptionFailure = [string]$directSnapshot.failure
                    $retryableDirectFailure = $directSnapshot.PSObject.Properties['retryable'] -and
                        [bool]$directSnapshot.retryable
                    if ($retryableDirectFailure -and $directCaptionAttempts -lt 3) {
                        $directCaptionRetryAt = [DateTime]::UtcNow.AddMilliseconds(500 * $directCaptionAttempts)
                    } else {
                        $directCaptionEnabled = $false
                    }
                } elseif ($null -ne $directSnapshot -and $directSnapshot.PSObject.Properties['phase'] -and
                    $directSnapshot.phase -in @('caption-track-empty', 'caption-track-url-missing')) {
                    $directCaptionEnabled = $false
                }
            }
            if ($null -ne $ComposerGate) {
                while (-not $gateHeld) {
                    Assert-YtRunning $Server $CancellationToken
                    $gateHeld = $ComposerGate.Wait(200, $CancellationToken)
                }
            }
            try {
                $expression = Get-YtYouTubeTranscriptExpression -VideoId $Job.VideoId -OpenTranscript:(-not $opened)
                $snapshot = Invoke-YtNavigationProbe $Connection $Tab.SessionId $expression $probeTimeoutSeconds
            } finally {
                if ($gateHeld) { $null = $ComposerGate.Release(); $gateHeld = $false }
            }
            if ($null -ne $snapshot) {
                if ($snapshot.failure) { throw $snapshot.failure }
                if ($snapshot.action -eq 'open-transcript') { $opened = $true }
                if ($snapshot.PSObject.Properties['phase'] -and $snapshot.phase) {
                    $phase = [string]$snapshot.phase
                    $diagnostic = switch ($phase) {
                        'verification' { 'waiting for YouTube sign-in or consent verification' }
                        'description-collapsed' { 'expanding the video description' }
                        'transcript-control-found' { 'opening YouTube''s transcript control' }
                        'overflow-control-found' { 'opening YouTube''s video actions menu' }
                        'overflow-menu-open' { 'looking for Show transcript in YouTube''s open video actions menu' }
                        'transcript-menu-item-found' { 'choosing Show transcript from YouTube''s video actions menu' }
                        'panel-open' { 'waiting for YouTube''s transcript panel' }
                        'panel-loading' { 'waiting for YouTube''s transcript panel to finish loading' }
                        'panel-empty' { 'waiting for caption text in YouTube''s open transcript panel' }
                        'entry-missing-with-captions' { 'looking for the transcript entry point even though YouTube reported caption tracks' }
                        'entry-missing' { 'looking for YouTube''s transcript entry point' }
                        'no-captions' { 'checking whether YouTube exposes native captions' }
                        'transcript-ready' { 'waiting for the complete transcript text to stabilize' }
                        default { 'waiting for the YouTube watch page to finish loading' }
                    }
                    if ($phase -cne $lastPhase) {
                        $lastPhase = $phase
                        $lastDiagnostic = $diagnostic
                        $Server.UpdateJob($Job.Id, 'loading', "Trying YouTube's own transcript: $diagnostic.")
                    } else {
                        $lastDiagnostic = $diagnostic
                    }
                }
                if ($snapshot.challenge) {
                    $Server.UpdateJob($Job.Id, 'verification', 'Complete YouTube sign-in or consent in this video''s tab. The helper will resume automatically.')
                }
                if ($snapshot.unavailable -and $snapshot.ready -eq 'complete') { $unavailable++ } else { $unavailable = 0 }
                if ($unavailable -ge 3) {
                    throw 'The transcript service could not provide captions, and YouTube exposes no native transcript for this video. Try again later or supply a transcript separately. Nothing was sent to ChatGPT.'
                }
                if ($snapshot.count -gt 0 -and $snapshot.text -and $snapshot.ready -eq 'complete') {
                    $actual = [Uri]$snapshot.url
                    if ($actual.Scheme -ne 'https' -or $actual.Host -notin @('www.youtube.com', 'youtube.com', 'm.youtube.com') -or
                        $actual.AbsolutePath -ne '/watch' -or
                        $actual.Query -notmatch "(?:^\?|&)v=$([regex]::Escape($Job.VideoId))(?:&|$)") {
                        throw 'The YouTube page changed to a different video. Nothing was sent to ChatGPT.'
                    }
                    if ($snapshot.text -ceq $previous) {
                        $stable++
                    } else {
                        $stable = 0
                        $previous = $snapshot.text
                    }
                    if ($stable -ge 3) {
                        return [pscustomobject]@{ Text=[string]$snapshot.text; UsedService=$false }
                    }
                } else { $stable = 0 }
            } else { $stable = 0; $unavailable = 0 }
            if ($null -ne $ServiceTab -and $null -ne $ServiceSource) {
                $serviceSnapshot = Invoke-YtNavigationProbe $Connection $ServiceTab.SessionId `
                    (Get-YtTranscriptExpression) $probeTimeoutSeconds
                if ($null -ne $serviceSnapshot -and $serviceSnapshot.PSObject.Properties['failure'] -and
                    $serviceSnapshot.failure) {
                    $Server.UpdateJob($Job.Id, 'loading',
                        $serviceSnapshot.failure + " Continuing with YouTube's own transcript.")
                    $ServiceTab = $null
                    $ServiceSource = $null
                } elseif ($null -ne $serviceSnapshot -and $serviceSnapshot.count -gt 0 -and
                    $serviceSnapshot.text -and $serviceSnapshot.ready -eq 'complete') {
                    $serviceActual = [Uri]$serviceSnapshot.url
                    if ($serviceActual.Host -notin $ServiceSource.Hostnames -or
                        $serviceActual.AbsolutePath -ne $ServiceSource.Path -or
                        $serviceActual.Query -notmatch "(?:^\?|&)$($ServiceSource.QueryParam)=$([regex]::Escape($Job.VideoId))(?:&|$)") {
                        throw 'The transcript page changed to a different video.'
                    }
                    if ($serviceSnapshot.text -ceq $servicePrevious) { $serviceStable++ }
                    else { $serviceStable = 0; $servicePrevious = $serviceSnapshot.text }
                    if ($serviceStable -ge 3) {
                        $jobTitle = if ($Job.PSObject.Properties['Title']) { [string]$Job.Title } else { '' }
                        $siteTitle = if ($serviceSnapshot.PSObject.Properties['videoTitle']) { [string]$serviceSnapshot.videoTitle } else { '' }
                        if (-not (Test-YtTranscriptTitleMatches $jobTitle $siteTitle)) {
                            $Server.UpdateJob($Job.Id, 'loading',
                                "The transcript service returned a title for another video; rejecting that result and continuing with YouTube's own captions.")
                            $ServiceTab = $null
                            $ServiceSource = $null
                            $serviceStable = 0
                            continue
                        }
                        return [pscustomobject]@{ Text=[string]$serviceSnapshot.text; UsedService=$true }
                    }
                } else {
                    $serviceStable = 0
                }
            }
            Start-Sleep -Milliseconds 500
        }
        $directDetail = if ($directCaptionFailure) { " Direct caption-track result: $directCaptionFailure" } else { '' }
        throw "The transcript service failed, and YouTube's own transcript timed out while $lastDiagnostic.$directDetail Check the video's YouTube tab and retry later. Nothing was sent to ChatGPT."
    } finally {
        if ($gateHeld) { $null = $ComposerGate.Release() }
    }
}

# Some providers (observed with Claude) auto-convert a very large paste into a file
# attachment instead of literal editor text. Without live DOM access this is deliberately
# a generic, defensive heuristic (testid/class based) rather than one guessed selector, and
# it is shared verbatim between the ready-to-send probe and Send-YtComposer's own equality
# safety check so both places agree on the exact same "prompt accepted" signal. Buttons are
# excluded: a chip's own "Remove attachment"-style control commonly repeats the word
# "attachment" in its own aria-label/testid and must not be double-counted as a second chip.
$script:YtAttachmentSelector = '[data-testid*="file" i]:not(button),[data-testid*="attachment" i]:not(button),' +
    '[class*="attachment-chip" i]:not(button),[class*="file-attachment" i]:not(button),' +
    'figure[class*="file" i]'

function Get-YtSendPickerScript {
    <#
        Shared JS that picks the one real Send control. Gemini (and Claude, to a lesser
        extent) render other buttons whose aria-label contains "Send" -- most notably
        "Send feedback" -- and the composer often is not inside a <form>, so a flat
        "exactly one match in the whole document" rule found two candidates and refused to
        click forever. Selectors are tried in the provider's own priority order and the
        search starts at the composer's own container, so the genuine Send button wins and
        only a real tie at the same priority is reported as ambiguous. A real Send control
        that is merely still disabled stops the search instead of widening it, so an
        unrelated submit button elsewhere on the page is never clicked as a stand-in.
    #>
    param([Parameter(Mandatory)][string[]]$SendSelectors)
    $list = ConvertTo-Json -InputObject ([string[]]$SendSelectors) -Compress
    if ($SendSelectors.Count -eq 1) { $list = "[$list]" }
    return @"
  const sendSelectors = $list;
  const notSendControl = b => b.matches('[data-testid="stop-button"]') ||
    /stop generating/i.test(b.getAttribute('aria-label') || '') ||
    // Labels are localised, so the language-independent Material icon name is checked too:
    // on a Hebrew Gemini the mic and upload buttons carry no English word at all.
    /^(mic|plus|add|attach_file|photo_camera|image|settings|more_vert)$/i.test(
      (b.querySelector('mat-icon')?.getAttribute('data-mat-icon-name') || '').trim()) ||
    /feedback|share|upload|attach|microphone|voice|image|photo|camera|canvas|settings|menu/i
      .test((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('data-testid') || ''));
  const pickSendIn = root => {
    for (const selector of sendSelectors) {
      const all = [...root.querySelectorAll(selector)].filter(b => visible(b) && !notSendControl(b));
      const found = all.filter(b => !b.disabled && b.getAttribute('aria-disabled') !== 'true');
      if (found.length === 1) return {button:found[0]};
      // Either a genuine tie at this priority, or the real Send exists but is still
      // disabled. Both mean "do not go looking further out on the page".
      if (all.length) return {stop:true};
    }
    return null;
  };
  const pickSend = () => {
    if (!editorElement) return null;
    const containers = [editorElement.closest('form'),
      // "text-input-field" is Gemini's real composer container; without input-field here the
      // search skipped straight to the whole document and met unrelated buttons.
      editorElement.closest('[class*="input-area" i],[class*="input-field" i],[class*="composer" i],[class*="chat-input" i],footer'),
      document];
    for (const container of containers) {
      if (!container) continue;
      const result = pickSendIn(container);
      if (!result) continue;
      return result.stop ? null : result.button;
    }
    return null;
  };
"@
}

function Get-YtComposerExpression {
    param(
        [ValidateSet('ChatGPT','Gemini','Claude')][string]$ProviderName = 'ChatGPT',
        [switch]$AllowFixture
    )
    $provider = Get-YtProvider $ProviderName
    $editors = ConvertTo-Json ($provider.EditorSelectors -join ',') -Compress
    $stops = ConvertTo-Json ($provider.StopSelectors -join ',') -Compress
    $logins = ConvertTo-Json ($provider.LoginSelectors -join ',') -Compress
    $hostPattern = ($provider.Hosts | ForEach-Object { [regex]::Escape($_) }) -join '|'
    $userSelector = ConvertTo-Json $provider.UserMessageSelector -Compress
    $assistantSelector = ConvertTo-Json $provider.AssistantMessageSelector -Compress
    $assistantTextSelector = ConvertTo-Json $provider.AssistantTextSelector -Compress
    $errorSelector = ConvertTo-Json $provider.ErrorSelector -Compress
    $attachmentSelector = ConvertTo-Json $script:YtAttachmentSelector -Compress
    $sendPicker = Get-YtSendPickerScript -SendSelectors $provider.SendSelectors
    $guard = if ($AllowFixture) { '' } else { "if (!/^(?:$hostPattern)$/.test(location.hostname)) return {kind:'login',url:location.href};" }
    return @"
(() => {
  $guard
  const visible = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const login = [...document.querySelectorAll('a,button')].some(e => visible(e) &&
    (e.matches($logins) || /^(log in|sign in)$/i.test(e.innerText.trim())));
  const editors = [...document.querySelectorAll($editors)];
  const editor = editors.find(e => visible(e) && !e.disabled && e.getAttribute('aria-disabled') !== 'true');
  const editorElement = editor;
  const form = editor?.closest('form');
  const scope = form || document;
  const stop = [...scope.querySelectorAll('button')].find(b => visible(b) &&
    (b.matches($stops) || /stop generating/i.test(b.getAttribute('aria-label') || '')));
$sendPicker
  const sendButton = pickSend();
  // A very large paste can be auto-converted by the site into a file/attachment chip
  // instead of literal editor text (observed with Claude). Count visible attachment-like
  // chips near the composer so callers can treat "one attachment, no other stray text" as
  // an alternative valid "prompt accepted" state instead of requiring a literal text match.
  const attachments = [...scope.querySelectorAll($attachmentSelector)].filter(visible);
  const messages = [...document.querySelectorAll($userSelector)];
  const last = messages.at(-1);
  // Long-message wrappers also contain Show more / Show less controls.
  const messageBody = last?.querySelector('.whitespace-pre-wrap') || last;
  const errorSelector = $errorSelector;
  const notices = [...document.querySelectorAll(errorSelector + ',[role="alert"],[role="dialog"]')]
    .filter(e => visible(e) && !e.closest('[data-message-author-role="user"]'))
    .map(e => ({text:e.innerText.replace(/\s+/g,' ').trim(), explicit:e.matches(errorSelector)}))
    .filter(e => e.text);
  let failureKind = '', failureMessage = '';
  for (const notice of notices) {
    let kind = '';
    if (/(?:message|text|prompt|input|context).{0,100}(?:too long|exceed|maximum|length limit)|too many tokens|maximum.{0,40}(?:length|context)/i.test(notice.text)) kind = 'size';
    else if (/(?:you(?:'ve| have)? (?:hit|reached)).{0,100}(?:limit|cap)|(?:usage|message|daily|rate|request).{0,30}(?:limit|cap)|too many requests|out of (?:messages|credits)|limit resets/i.test(notice.text)) kind = 'usage';
    else if (notice.explicit || /something went wrong|error generating|failed to generate|network error/i.test(notice.text)) kind = 'service';
    if (kind) { failureKind = kind; failureMessage = notice.text.slice(0,2000); break; }
  }
  const assistants = [...document.querySelectorAll($assistantSelector)];
  const assistant = assistants.at(-1);
  // Rejection messages can themselves be rendered in .markdown inside an error box.
  const answer = assistant ? [...assistant.querySelectorAll($assistantTextSelector)]
    .filter(e => visible(e) && !e.closest(errorSelector + ',[role="alert"],details,[aria-hidden="true"],[data-testid*="reasoning"],[data-testid*="thinking"]')).at(-1) : null;
  const streaming = !!assistant?.querySelector('[data-is-streaming="true"],[data-streaming="true"]');
  return {
    kind:login ? 'login' : editor ? 'ready' : 'waiting',url:location.href,
    text:editor instanceof HTMLTextAreaElement ? editor.value : editor?.innerText || '',
    busy:!!stop || streaming,canSend:!!sendButton,attachmentCount:attachments.length,
    messageCount:messages.length,
    lastMessage:messageBody ? messageBody.innerText : '',
    assistantMessageCount:assistants.length,
    lastAssistantText:answer ? answer.innerText.trim() : '',
    failureKind,failureMessage
  };
})()
"@
}

function Focus-YtComposer {
    param($Connection, [string]$SessionId, [ValidateSet('ChatGPT','Gemini','Claude')][string]$ProviderName = 'ChatGPT', [switch]$AllowFixture)
    $provider = Get-YtProvider $ProviderName
    $editors = ConvertTo-Json ($provider.EditorSelectors -join ',') -Compress
    $hostPattern = ($provider.Hosts | ForEach-Object { [regex]::Escape($_) }) -join '|'
    $guard = if ($AllowFixture) { '' } else { "if (!/^(?:$hostPattern)$/.test(location.hostname)) throw new Error('Unexpected page');" }
    $expression = @"
(() => {
  $guard
  const editors = [...document.querySelectorAll($editors)];
  const e = editors.find(x => x && x.getClientRects().length && getComputedStyle(x).visibility !== 'hidden' &&
    !x.disabled && x.getAttribute('aria-disabled') !== 'true');
  if (!e) throw new Error('Composer disappeared');
  if ((e.value || e.innerText || '').trim()) throw new Error('Composer has an existing draft; nothing was overwritten');
  e.focus();
  if (document.activeElement !== e && !e.contains(document.activeElement)) throw new Error('Composer could not be focused');
  return true;
})()
"@
    $null = Invoke-YtPageScript $Connection $SessionId $expression
}

function Invoke-YtComposerNudge {
    <#
        Tells the site's own framework that text is now present in the composer.

        Gemini's editor is an Angular-backed rich text area whose Send button stays disabled
        until its value accessor observes an input event. A CDP Input.insertText can land the
        characters in the DOM without that observation ever happening, so the text is visibly
        there, Send never enables, and the helper times out having sent nothing - exactly the
        "did not accept the full text or enable Send" failure. Replaying the input/change
        notifications re-runs that check without altering a single character of the prompt.
    #>
    param($Connection, [string]$SessionId,
        [ValidateSet('ChatGPT','Gemini','Claude')][string]$ProviderName = 'ChatGPT', [switch]$AllowFixture)
    $provider = Get-YtProvider $ProviderName
    $editors = ConvertTo-Json ($provider.EditorSelectors -join ',') -Compress
    $hostPattern = ($provider.Hosts | ForEach-Object { [regex]::Escape($_) }) -join '|'
    $guard = if ($AllowFixture) { '' } else { "if (!/^(?:$hostPattern)$/.test(location.hostname)) throw new Error('Unexpected page');" }
    $expression = @"
(() => {
  $guard
  const visible = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const editors = [...document.querySelectorAll($editors)];
  const e = editors.find(x => visible(x) && !x.disabled && x.getAttribute('aria-disabled') !== 'true');
  if (!e) throw new Error('Composer disappeared');
  const text = e instanceof HTMLTextAreaElement ? e.value : e.innerText;
  if (!text || !text.trim()) return false;
  e.focus();
  // The prompt is already in the DOM; these only re-announce it. inputType is the one a
  // real paste reports, so frameworks that branch on it take their normal path.
  e.dispatchEvent(new InputEvent('input', {bubbles:true, cancelable:false, inputType:'insertFromPaste', data:text}));
  e.dispatchEvent(new Event('change', {bubbles:true}));
  e.dispatchEvent(new KeyboardEvent('keyup', {bubbles:true, key:'Unidentified'}));
  return true;
})()
"@
    return [bool](Invoke-YtPageScript $Connection $SessionId $expression)
}

function Send-YtComposer {
    param($Connection, [string]$SessionId, [string]$ExpectedText, [ValidateSet('ChatGPT','Gemini','Claude')][string]$ProviderName = 'ChatGPT', [switch]$AllowFixture)
    $provider = Get-YtProvider $ProviderName
    $editors = ConvertTo-Json ($provider.EditorSelectors -join ',') -Compress
    $stops = ConvertTo-Json ($provider.StopSelectors -join ',') -Compress
    $sendPicker = Get-YtSendPickerScript -SendSelectors $provider.SendSelectors
    $hostPattern = ($provider.Hosts | ForEach-Object { [regex]::Escape($_) }) -join '|'
    $guard = if ($AllowFixture) { '' } else { "if (!/^(?:$hostPattern)$/.test(location.hostname)) throw new Error('Unexpected page');" }
    $literal = ConvertTo-Json -InputObject $ExpectedText -Compress
    $attachmentSelector = ConvertTo-Json $script:YtAttachmentSelector -Compress
    $expression = @"
(() => {
  $guard
  const visible = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const editors = [...document.querySelectorAll($editors)];
  const e = editors.find(x => visible(x) && !x.disabled && x.getAttribute('aria-disabled') !== 'true');
  if (!e) throw new Error('Composer disappeared');
  const form = e.closest('form');
  const scope = form || document;
  const norm = s => s.replace(/\s+/g,' ').trim();
  const currentText = norm(e instanceof HTMLTextAreaElement ? e.value : e.innerText);
  // Reuse the identical "one attachment chip, no other stray editor text" signal the
  // ready-to-send probe uses, so this safety check and that probe never disagree.
  const attachments = [...scope.querySelectorAll($attachmentSelector)].filter(visible);
  const textAccepted = currentText === norm($literal) || (attachments.length === 1 && currentText === '');
  if (!textAccepted) throw new Error('Composer changed; refusing to send different text');
  const buttons = [...scope.querySelectorAll('button')];
  if (buttons.some(b => visible(b) && (b.matches($stops) ||
    /stop generating/i.test(b.getAttribute('aria-label') || ''))))
    throw new Error('$ProviderName is already generating');
  const editorElement = e;
$sendPicker
  const sendButton = pickSend();
  if (!sendButton) throw new Error('Send is unavailable or ambiguous');
  const inViewport = (r) => r.top >= 0 && r.left >= 0 &&
    r.bottom <= (window.innerHeight || document.documentElement.clientHeight) &&
    r.right <= (window.innerWidth || document.documentElement.clientWidth);
  let rect = sendButton.getBoundingClientRect();
  if (!inViewport(rect)) {
    sendButton.scrollIntoView({block:'center',inline:'center',behavior:'instant'});
    rect = sendButton.getBoundingClientRect();
  }
  if (!rect.width || !rect.height) throw new Error('Send has no clickable bounds');
  return {x:rect.left + rect.width / 2,y:rect.top + rect.height / 2};
})()
"@
    try { $null = Invoke-YtCdp $Connection 'Emulation.setFocusEmulationEnabled' @{ enabled = $true } $SessionId } catch { }
    try { $null = Invoke-YtCdp $Connection 'Page.setWebLifecycleState' @{ state = 'active' } $SessionId } catch { }
    $point = $null
    $lastError = $null
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        try {
            $point = Invoke-YtPageScript $Connection $SessionId $expression
            if ($null -ne $point -and $null -ne $point.x -and $null -ne $point.y) {
                break
            }
        } catch {
            $lastError = $_
            if ($_.Exception.Message -notmatch 'Send is unavailable or ambiguous|Send has no clickable bounds') {
                throw
            }
        }
        Start-Sleep -Milliseconds 250
    }
    if ($null -eq $point -or $null -eq $point.x -or $null -eq $point.y) {
        if ($null -ne $lastError) { throw $lastError }
        throw 'Send did not expose a clickable position.'
    }
    # Gemini ignores HTMLElement.click() in some UI builds because its Angular handler
    # expects a trusted pointer event. CDP mouse input is browser-generated and works for
    # all providers while preserving the DOM-side draft and ambiguity checks above.
    $coordinates = @{x=[double]$point.x;y=[double]$point.y;button='left';clickCount=1}
    $null = Invoke-YtCdp $Connection 'Input.dispatchMouseEvent' (@{type='mouseMoved';x=$coordinates.x;y=$coordinates.y}) $SessionId
    $null = Invoke-YtCdp $Connection 'Input.dispatchMouseEvent' (@{type='mousePressed';x=$coordinates.x;y=$coordinates.y;button='left';clickCount=1}) $SessionId
    $null = Invoke-YtCdp $Connection 'Input.dispatchMouseEvent' (@{type='mouseReleased';x=$coordinates.x;y=$coordinates.y;button='left';clickCount=1}) $SessionId
}

function Test-YtComposerTextAccepted {
    <#
        The single shared "prompt accepted" signal used by both the ready-to-send poll and
        Send-YtComposer's own equality safety check, so they can never disagree: either the
        editor's literal text matches, or exactly one attachment chip is present with no
        other stray editor text (a very large paste auto-converted into a file attachment).
    #>
    param($State, [string]$Expected)
    if ($null -eq $State) { return $false }
    $actual = [regex]::Replace($State.text, '\s+', ' ').Trim()
    if ($actual -ceq $Expected) { return $true }
    $attachmentCount = if ($State.PSObject.Properties['attachmentCount']) { [int]$State.attachmentCount } else { 0 }
    return ($attachmentCount -eq 1 -and -not $actual)
}

function Clear-YtComposerDraft {
    <#
        Best-effort clears a stuck draft/attachment left in the composer by an earlier,
        abandoned insertion attempt (e.g. a large paste that Claude auto-converted into a
        file attachment before the job errored out). Must only ever be called for a
        background/automation-owned tab -- never the one final-stage tab a human may be
        looking at or typing into; the caller enforces that with its own FinalStage guard.
    #>
    param($Connection, [string]$SessionId, [ValidateSet('ChatGPT','Gemini','Claude')][string]$ProviderName = 'ChatGPT', [switch]$AllowFixture)
    $provider = Get-YtProvider $ProviderName
    $editors = ConvertTo-Json ($provider.EditorSelectors -join ',') -Compress
    $hostPattern = ($provider.Hosts | ForEach-Object { [regex]::Escape($_) }) -join '|'
    $guard = if ($AllowFixture) { '' } else { "if (!/^(?:$hostPattern)$/.test(location.hostname)) throw new Error('Unexpected page');" }
    $attachmentSelector = ConvertTo-Json $script:YtAttachmentSelector -Compress
    $expression = @"
(() => {
  $guard
  const visible = e => e && e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
  const editors = [...document.querySelectorAll($editors)];
  const e = editors.find(x => visible(x) && !x.disabled && x.getAttribute('aria-disabled') !== 'true');
  if (!e) throw new Error('Composer disappeared');
  const form = e.closest('form');
  const scope = form || document;
  const chips = [...scope.querySelectorAll($attachmentSelector)].filter(visible);
  for (const chip of chips) {
    const remove = chip.querySelector('button[aria-label*="remove" i],button[aria-label*="delete" i],[data-testid*="remove" i]') ||
      (chip.matches('button') ? chip : [...chip.querySelectorAll('button')].find(b => visible(b)));
    if (remove) remove.click();
  }
  e.focus();
  if (e instanceof HTMLTextAreaElement) { e.value = ''; e.dispatchEvent(new Event('input', {bubbles:true})); }
  else { e.textContent = ''; e.dispatchEvent(new Event('input', {bubbles:true})); }
  return true;
})()
"@
    $null = Invoke-YtPageScript $Connection $SessionId $expression
}

function Assert-YtRunning {
    param($Server, [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None)
    $CancellationToken.ThrowIfCancellationRequested()
    if ($Server.StopRequested) { throw (New-Object System.OperationCanceledException -ArgumentList 'The helper was stopped.') }
    if (-not $Server.IsRunning) { throw "Local server stopped: $($Server.LastServerError)" }
}

function Wait-YtDispatchPermission {
    param($Server, $Job, [System.Threading.CancellationToken]$CancellationToken)
    while ($Server.DispatchPaused) {
        Assert-YtRunning $Server $CancellationToken
        $Server.UpdateJob($Job.Id, 'paused', 'ChatGPT usage limit: wait for the limit to reset, then use Resume on the dashboard.')
        Start-Sleep -Milliseconds 500
    }
    Assert-YtRunning $Server $CancellationToken
}

function Assert-YtPageHealthy {
    param($State, $Server, [string]$Label)
    if ($null -eq $State -or -not $State.failureKind) { return }
    $exception = New-Object InvalidOperationException -ArgumentList $State.failureMessage
    $exception.Data['YtStage'] = $Label
    $exception.Data['YtFailureKind'] = $State.failureKind
    if ($State.failureKind -in @('size', 'usage', 'unavailable')) { $exception.Data['YtDefiniteRejection'] = $true }
    throw $exception
}

function Suspend-YtDispatchForUsageLimit {
    <#
        Deliberately does NOT pause the queue any more. A provider banner that looks like a
        usage or rate limit is usually transient and provider-specific, so globally halting
        every queued video behind a "Paused for a ChatGPT usage limit" wall was wrong far more
        often than it was right. The stage still fails retryably for this one video, rotation
        still moved through every provider, and the rest of the queue keeps running.
    #>
    param($Server, [string]$Label)
    return
}

function Remove-YtStageJournal {
    param([string]$JournalPath, [string]$JobId, [string]$ExpectedHash)
    $record = Get-Content -LiteralPath $JournalPath -Raw | ConvertFrom-Json
    if ($record.jobId -ne $JobId -or $record.expectedTextSha256 -cne $ExpectedHash) {
        throw 'The send journal changed unexpectedly. It was not removed.'
    }
    Remove-Item -LiteralPath $JournalPath -ErrorAction Stop
}

function Get-YtConversationUrl {
    <#
        Returns the canonical provider conversation URL for a page URL, or '' when the page is
        not a saved conversation. A provider only rewrites the address bar to one of these after
        it accepted a prompt, so this doubles as send evidence and as the result link.
    #>
    param([AllowNull()][AllowEmptyString()][string]$Url,
        [ValidateSet('ChatGPT','Gemini','Claude')][string]$ProviderName = 'ChatGPT')
    if ([string]::IsNullOrWhiteSpace($Url)) { return '' }
    $provider = Get-YtProvider $ProviderName
    try { $uri = [Uri]$Url } catch { return '' }
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -ne 'https' -or $uri.Host -ne $provider.ResultHost) { return '' }
    if ($uri.AbsolutePath -notmatch $provider.ResultPathPattern) { return '' }
    return 'https://' + $provider.ResultHost + $uri.AbsolutePath
}

# How long an ambiguous send keeps watching its own conversation before the helper gives up and
# resends elsewhere. A provider can take many seconds to render the accepted prompt or start
# generating, and abandoning that window is what used to strand finished summaries in error.
$script:YtAmbiguousReconcileSeconds = 30

function Set-YtAmbiguousReconcileSeconds {
    param([Parameter(Mandatory)][ValidateRange(0, 600)][int]$Seconds)
    $script:YtAmbiguousReconcileSeconds = $Seconds
}

function Resolve-YtAmbiguousSend {
    param(
        $Connection, [string]$SessionId, [string]$ExpectedText,
        [ValidateSet('ChatGPT','Gemini','Claude')][string]$ProviderName,
        [int]$BeforeUserCount, [int]$BeforeAssistantCount,
        $Server, $Job,
        [int]$WaitSeconds = -1,
        [System.Threading.CancellationToken]$CancellationToken
    )
    if ($WaitSeconds -lt 0) { $WaitSeconds = $script:YtAmbiguousReconcileSeconds }
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $attempt = 0
    $emptyReadyPolls = 0
    $lastConversationUrl = ''
    while ($true) {
        $attempt++
        try {
            Assert-YtRunning $Server $CancellationToken
            $state = Invoke-YtNavigationProbe $Connection $SessionId (Get-YtComposerExpression -ProviderName $ProviderName)
            if ($null -ne $state) {
                $conversationUrl = Get-YtConversationUrl ([string]$state.url) $ProviderName
                if ($conversationUrl) { $lastConversationUrl = $conversationUrl }
                $actual = [regex]::Replace([string]$state.lastMessage, '\s+', ' ').Trim()
                $sent = $state.messageCount -ge ($BeforeUserCount + 1)
                $promptConfirmed = $sent -and $actual -ceq $ExpectedText
                # Without the prompt echo, only exactly one added turn in this conversation can
                # be attributed to the single send that was attempted.
                $singleAddedTurn = $state.messageCount -eq ($BeforeUserCount + 1)
                $assistantConfirmed = $singleAddedTurn -and
                    $state.assistantMessageCount -gt $BeforeAssistantCount -and [bool]$state.lastAssistantText
                # A provider only starts generating, or moves the tab onto its own conversation
                # URL, once it has accepted the single prompt that was sent.
                $generationConfirmed = $singleAddedTurn -and [bool]$state.busy
                $urlConfirmed = $singleAddedTurn -and [bool]$conversationUrl
                if ($promptConfirmed -or $assistantConfirmed -or $generationConfirmed -or $urlConfirmed) {
                    return [pscustomobject]@{
                        Outcome='confirmed-success'; State=$state
                        UserCount=[Math]::Max(($BeforeUserCount + 1), [int]$state.messageCount)
                        AssistantCount=$BeforeAssistantCount
                        ReconciledByAssistant=(-not $promptConfirmed)
                        ConversationUrl=$conversationUrl
                    }
                }
                if ($state.failureKind -and (Test-YtDefiniteRejection $state.failureKind)) {
                    return [pscustomobject]@{Outcome='confirmed-failure';State=$state;ConversationUrl=''}
                }
                # A composer that still holds the exact prompt that was supposedly "sent" means
                # the click never actually happened at all (e.g. Send-YtComposer's own button
                # lookup threw on a transient re-render before dispatching any mouse event). That
                # is just as much proof of "nothing was sent" as an empty composer is, and without
                # it this case could never resolve to anything but 'ambiguous' after the full
                # reconcile window, needlessly abandoning the tab with its untouched draft still
                # visible and moving on to another provider.
                $draftStillUnsent = $actual -ceq $ExpectedText
                if ($state.kind -eq 'ready' -and $state.messageCount -eq $BeforeUserCount -and
                    -not $state.busy -and -not $conversationUrl -and (-not $state.text.Trim() -or $draftStillUnsent)) {
                    # A provider briefly looks exactly like this between clearing the composer and
                    # rendering the accepted turn, so one observation is never proof of rejection.
                    $emptyReadyPolls++
                    if ($emptyReadyPolls -ge 3) {
                        return [pscustomobject]@{Outcome='confirmed-failure';State=$state;ConversationUrl=''}
                    }
                } else {
                    $emptyReadyPolls = 0
                }
            }
        } catch {
            if ($_.Exception -is [System.OperationCanceledException] -or
                $CancellationToken.IsCancellationRequested -or $Server.StopRequested) { throw }
        }
        if ([DateTime]::UtcNow -ge $deadline) { break }
        Start-Sleep -Milliseconds ([Math]::Min(1000, 200 * $attempt))
    }
    return [pscustomobject]@{Outcome='ambiguous';State=$null;ConversationUrl=$lastConversationUrl}
}

function Save-YtAmbiguousSendMetadata {
    <#
        Keeps just enough identity to reconcile the abandoned conversation later: which browser
        tab carried the send and the hash of the exact prompt it carried. No transcript text is
        stored. Mocks that predate the method simply skip it.
    #>
    param($Server, $Job, [AllowNull()]$Tab, [string]$ExpectedHash)
    if ($null -eq $Server -or $null -eq $Job) { return }
    $targetId = if ($null -ne $Tab -and $Tab.PSObject.Properties['TargetId']) { [string]$Tab.TargetId } else { '' }
    try { $Server.SetAmbiguousSend($Job.Id, $targetId, $ExpectedHash) } catch { }
}

function Test-YtAmbiguousTabMatch {
    <#
        Only exact identity counts as evidence that an open conversation belongs to a stranded
        job: the very tab the send used, or a conversation whose first user message hashes to the
        exact prompt that was sent. Anything weaker could attach another video's summary.
    #>
    param($Job, [AllowNull()][AllowEmptyString()][string]$TargetId, [AllowNull()]$State)
    if ($null -eq $Job) { return $false }
    $expectedTarget = if ($Job.PSObject.Properties['AmbiguousTargetId']) { [string]$Job.AmbiguousTargetId } else { '' }
    if ($expectedTarget -and $TargetId -and $expectedTarget -ceq $TargetId) { return $true }
    $expectedHash = if ($Job.PSObject.Properties['AmbiguousTextSha256']) { [string]$Job.AmbiguousTextSha256 } else { '' }
    if (-not $expectedHash -or $null -eq $State) { return $false }
    $text = [regex]::Replace([string]$State.lastMessage, '\s+', ' ').Trim()
    if (-not $text) { return $false }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    return $actual -ceq $expectedHash
}

function Invoke-YtAmbiguousTabRecovery {
    <#
        Sweeps the helper's own browser for a finished conversation belonging to a job that was
        stranded by an ambiguous send, and attaches it automatically. Jobs with no safe match are
        marked once so the dashboard can fall back to asking the user for the link.
    #>
    param($Connection, $Server, $Job,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None)
    if ($null -eq $Job) { return $false }
    $reconciled = $false
    $stillGenerating = $false
    try {
        $targets = @()
        try { $targets = @((Invoke-YtCdp $Connection 'Target.getTargets').targetInfos) } catch { $targets = @() }
        foreach ($target in $targets) {
            if ($CancellationToken.IsCancellationRequested -or $Server.StopRequested) { break }
            if ($target.type -ne 'page') { continue }
            $providerName = ''
            foreach ($candidate in (Get-YtProviderOrder)) {
                if (Get-YtConversationUrl ([string]$target.url) $candidate) { $providerName = $candidate; break }
            }
            if (-not $providerName) { continue }
            $conversationUrl = Get-YtConversationUrl ([string]$target.url) $providerName
            $session = ''
            try { $session = (Invoke-YtCdp $Connection 'Target.attachToTarget' @{targetId=$target.targetId;flatten=$true}).sessionId }
            catch { continue }
            $state = $null
            try { $state = Invoke-YtNavigationProbe $Connection $session (Get-YtComposerExpression -ProviderName $providerName) } catch { $state = $null }
            try { $null = Invoke-YtCdp $Connection 'Target.detachFromTarget' @{sessionId=$session} } catch { }
            if ($null -eq $state) { continue }
            if (-not (Test-YtAmbiguousTabMatch $Job ([string]$target.targetId) $state)) { continue }
            # Only a finished, non-empty answer proves the summary actually exists. A matching
            # conversation that is still generating stays eligible for a later sweep.
            if ($state.busy -or -not $state.lastAssistantText) { $stillGenerating = $true; break }
            try {
                $null = $Server.AttachJobResult($Job.Id, $conversationUrl, $true)
                $reconciled = $true
            } catch { }
            break
        }
    } finally {
        try { $Server.CompleteAmbiguousReconcile($Job.Id, $reconciled, $stillGenerating) } catch { }
    }
    return $reconciled
}

function Invoke-YtChatStage {
    param(
        $Connection, $Server, $Job, $Tab,
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$JournalPath,
        [int]$WaitSeconds = 60,
        [int]$MaxMessageCharacters = 22000,
        [System.Threading.SemaphoreSlim]$ComposerGate,
        [System.Collections.IDictionary]$ProviderGates,
        [ValidateSet('ChatGPT','Gemini','Claude')][string]$ProviderName = 'ChatGPT',
        # How long to wait for this provider's single in-flight slot before giving up so the
        # caller can try another provider. -1 keeps the historical unbounded wait.
        [int]$GateWaitSeconds = -1,
        [switch]$FinalStage,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    if ($Prompt.Length -gt $MaxMessageCharacters) { throw 'An internal prompt exceeded the configured size budget. Nothing was sent.' }
    $sendAttempted = $false
    $gateHeld = $false
    $handoffGate = $false
    $journalOwned = $false
    $createdTab = $false
    $navigatedProvider = $false
    $closedAbandonedTab = $false
    $expected = [regex]::Replace($Prompt, '\s+', ' ').Trim()
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $expectedHash = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($expected))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    try {
        $gateDeadline = if ($GateWaitSeconds -ge 0) { [DateTime]::UtcNow.AddSeconds($GateWaitSeconds) } else { [DateTime]::MaxValue }
        while ($true) {
            Wait-YtDispatchPermission $Server $Job $CancellationToken
            $gate = if ($null -ne $ProviderGates -and $ProviderGates.Contains($ProviderName)) { $ProviderGates[$ProviderName] } else { $ComposerGate }
            if ($null -eq $gate) { break }
            $Server.UpdateJob($Job.Id, 'waiting-composer', "${Label}: waiting for the $ProviderName composer.")
            $gateHeld = $gate.Wait(200, $CancellationToken)
            if (-not $gateHeld) {
                if ([DateTime]::UtcNow -ge $gateDeadline) {
                    # Another video owns this provider's only slot. That is not a failure, so
                    # the caller rotates to a free provider instead of queueing behind it.
                    $busy = [InvalidOperationException]::new("$ProviderName is busy with another video; trying another provider.")
                    $busy.Data['YtProviderBusy'] = $true
                    throw $busy
                }
                continue
            }
            if ($Server.DispatchPaused) {
                $null = $gate.Release()
                $gateHeld = $false
                continue
            }
            break
        }
        Assert-YtRunning $Server $CancellationToken
        if ($null -eq $Tab) {
            $Tab = New-YtBrowserTab $Connection 'about:blank' -Background -Server $Server `
                -CancellationToken $CancellationToken
            $createdTab = $true
        }
        $session = $Tab.SessionId
        if ($Tab.PSObject.Properties['PreviousConversation']) {
            $prior = $Tab.PreviousConversation
            $current = Invoke-YtNavigationProbe $Connection $session (Get-YtComposerExpression)
            if ($null -eq $current -or $current.kind -ne 'ready') {
                throw 'The previous part''s tab changed or became unavailable. It was not navigated.'
            }
            if ($current.text.Trim()) { throw 'The previous part''s tab contains an unsaved draft. It was not overwritten.' }
            if ($current.busy) { throw 'The previous part''s tab is generating a response. It was not navigated.' }
            if ($current.messageCount -ne $prior.UserCount -or
                [regex]::Replace($current.lastMessage, '\s+', ' ').Trim() -cne $prior.Text) {
                throw 'The previous part''s conversation changed. It was not navigated.'
            }
        }
        # Intermediate parts/merge stages never steal focus or stay open; only the final
        # stage (brought to front explicitly by the caller once the job completes) is meant
        # to be seen or interacted with.
        $provider = Get-YtProvider $ProviderName
        $Server.UpdateJob($Job.Id, $ProviderName.ToLowerInvariant(), "${Label}: opening a fresh $ProviderName conversation. Sign in there if needed.")
        $originalTargetId = [string]$Tab.TargetId
        $Tab = Invoke-YtProviderNavigation -Connection $Connection -Server $Server -Job $Job -Tab $Tab `
            -ProviderName $ProviderName -ProviderUrl $provider.Url -Label $Label -CancellationToken $CancellationToken
        $session = $Tab.SessionId
        if ([string]$Tab.TargetId -cne $originalTargetId) { $createdTab = $true }
        $navigatedProvider = $true
        Enable-YtBackgroundTabExecution $Connection $session
        $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
        $state = $null
        $unchangedPolls = 0
        while ([DateTime]::UtcNow -lt $deadline) {
            Assert-YtRunning $Server $CancellationToken
            $state = Invoke-YtNavigationProbe $Connection $session (Get-YtComposerExpression -ProviderName $ProviderName)
            Assert-YtPageHealthy $state $Server $Label
            if ($null -ne $state -and $state.kind -eq 'ready' -and $state.messageCount -eq 0 -and
                (([Uri]$state.url).Host -in $provider.Hosts)) { break }
            $unchangedPolls++
            if ($unchangedPolls -ge 8) {
                $Server.UpdateJob($Job.Id, $ProviderName.ToLowerInvariant(),
                    "${Label}: waking the background $ProviderName tab while its composer loads.")
                Enable-YtBackgroundTabExecution $Connection $session
                $unchangedPolls = 0
            }
            Start-Sleep -Milliseconds 500
        }
        if ($null -eq $state -or $state.kind -ne 'ready' -or $state.messageCount -ne 0 -or
            (([Uri]$state.url).Host -notin $provider.Hosts)) {
            throw "A fresh $ProviderName conversation did not become available. Complete login or verification, then try again."
        }
        if ($state.busy) { throw "$ProviderName is already generating a response. Nothing was inserted or sent." }
        if ($state.text.Trim()) {
            if ($FinalStage) {
                throw "$ProviderName contains an existing draft. Nothing was overwritten or sent. Clear or save that draft before retrying."
            }
            # This fresh tab is exclusively owned by this automation and has never been
            # shown to the user (Show-YtFinalStageTab only runs once the job completes), so
            # a leftover draft/attachment here can only be this automation's own abandoned
            # insertion from an earlier attempt. Self-heal instead of cascading the stuck
            # state to every later job that gets routed to this same provider.
            $Server.UpdateJob($Job.Id, $ProviderName.ToLowerInvariant(), "${Label}: clearing a leftover draft left by an earlier attempt.")
            Clear-YtComposerDraft $Connection $session -ProviderName $ProviderName
            $state = Invoke-YtNavigationProbe $Connection $session (Get-YtComposerExpression -ProviderName $ProviderName)
            Assert-YtPageHealthy $state $Server $Label
            if ($null -eq $state -or $state.kind -ne 'ready' -or $state.text.Trim()) {
                throw "$ProviderName contains an existing draft that could not be cleared automatically. Clear or save that draft before retrying."
            }
        }
        if ($state.messageCount -ne 0) { throw "$ProviderName opened an existing conversation. Nothing was inserted or sent." }
        $beforeCount = $state.messageCount
        $beforeAssistantCount = $state.assistantMessageCount
        Wait-YtDispatchPermission $Server $Job $CancellationToken
        $Server.UpdateJob($Job.Id, 'inserting', "${Label}: inserting $($Prompt.Length) characters.")
        Assert-YtRunning $Server $CancellationToken
        Focus-YtComposer $Connection $session -ProviderName $ProviderName
        Assert-YtRunning $Server $CancellationToken
        $null = Invoke-YtCdp $Connection 'Input.insertText' @{ text = $Prompt } $session
        # A very large prompt can legitimately take a site longer to accept/render (e.g.
        # Claude converting a huge paste into a file attachment); scale the wait bounded by
        # prompt size instead of a fixed 20s that can starve only the largest prompts.
        $sendReadySeconds = [Math]::Min(90, 20 + [int][Math]::Floor($Prompt.Length / 1000))
        $deadline = [DateTime]::UtcNow.AddSeconds($sendReadySeconds)
        $ready = $false
        $unchangedPolls = 0
        $textAccepted = $false
        $nudges = 0
        $nudgePolls = 0
        while ([DateTime]::UtcNow -lt $deadline) {
            Assert-YtRunning $Server $CancellationToken
            $state = Invoke-YtNavigationProbe $Connection $session (Get-YtComposerExpression -ProviderName $ProviderName)
            Assert-YtPageHealthy $state $Server $Label
            if ($null -ne $state -and $state.kind -eq 'ready' -and (Test-YtComposerTextAccepted $state $expected)) {
                $textAccepted = $true
                if ($state.canSend -and -not $state.busy) {
                    $ready = $true
                    break
                }
                # The prompt is in the composer but Send is still dead. Re-announcing the text
                # to the site's own framework is what wakes Gemini's Send button; without it
                # the helper waits out the whole window and sends nothing at all.
                $nudgePolls++
                if ($nudgePolls -ge 4 -and $nudges -lt 3 -and -not $state.busy) {
                    $nudges++
                    $nudgePolls = 0
                    $Server.UpdateJob($Job.Id, 'inserting',
                        "${Label}: the $ProviderName text is in place but Send is still disabled; re-announcing it (attempt $nudges of 3).")
                    try { $null = Invoke-YtComposerNudge $Connection $session -ProviderName $ProviderName }
                    catch { Write-Verbose "Composer nudge failed: $($_.Exception.Message)" }
                }
            }
            $unchangedPolls++
            if ($unchangedPolls -ge 8) {
                $Server.UpdateJob($Job.Id, 'inserting',
                    "${Label}: waking the background $ProviderName tab while Send becomes ready.")
                Enable-YtBackgroundTabExecution $Connection $session
                $unchangedPolls = 0
            }
            Start-Sleep -Milliseconds 250
        }
        if (-not $ready) {
            # Naming the half that actually failed is the difference between a fixable report
            # and another round of guessing: the text never landing and Send never enabling
            # have completely different causes.
            throw $(if ($textAccepted) {
                "$ProviderName accepted the full text but never enabled Send, even after re-announcing it. The helper did not press Send; inspect the browser."
            } else {
                "$ProviderName did not accept the full text or enable Send. The helper did not press Send; inspect the browser."
            })
        }
        Wait-YtDispatchPermission $Server $Job $CancellationToken
        $record = @{
            jobId = $Job.Id; targetId = $Tab.TargetId; videoId = $Job.VideoId; requestId = $Job.RequestId
            stage = $Label; provider = $ProviderName; startedUtc = [DateTime]::UtcNow.ToString('o')
            expectedTextSha256 = $expectedHash
        } | ConvertTo-Json -Compress
        $recordBytes = [Text.Encoding]::UTF8.GetBytes($record)
        $journal = [IO.File]::Open($JournalPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        $journalOwned = $true
        try {
            $journal.Write($recordBytes, 0, $recordBytes.Length)
            $journal.Flush($true)
        } finally {
            $journal.Dispose()
        }
        Wait-YtDispatchPermission $Server $Job $CancellationToken
        $Server.UpdateJob($Job.Id, 'sending', "${Label}: sending once.")
        Assert-YtRunning $Server $CancellationToken
        # Once a send command is attempted, its outcome may be ambiguous after a disconnect.
        $sendAttempted = $true
        Send-YtComposer $Connection $session $Prompt -ProviderName $ProviderName
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        $unclickedPolls = 0
        $sendClicks = 1
        while ([DateTime]::UtcNow -lt $deadline) {
            Assert-YtRunning $Server $CancellationToken
            $state = Invoke-YtNavigationProbe $Connection $session (Get-YtComposerExpression -ProviderName $ProviderName)
            Assert-YtPageHealthy $state $Server $Label
            if ($null -ne $state -and $state.messageCount -eq ($beforeCount + 1) -and
                [regex]::Replace($state.lastMessage, '\s+', ' ').Trim() -ceq $expected) {
                $Server.UpdateJob($Job.Id, 'summarizing', "${Label}: waiting for the complete assistant response.")
                $handoffGate = $null -ne $ProviderGates
                return [pscustomobject]@{
                    Tab=$Tab; ExpectedText=$expected; ExpectedHash=$expectedHash; UserCount=($beforeCount + 1)
                    AssistantCount=$beforeAssistantCount; Label=$Label
                    ConversationUrl=(Get-YtConversationUrl ([string]$state.url) $ProviderName)
                    ProviderGate=$(if($handoffGate){$gate}else{$null})
                }
            }
            # If after sending, the composer STILL has the exact prompt, no new message appeared,
            # the site is not generating/busy, and Send is clearly enabled: the click did not land.
            # Re-click Send rather than burning the whole 30-second window and failing ambiguously.
            if ($sendClicks -lt 3 -and $null -ne $state -and $state.messageCount -eq $beforeCount -and
                -not $state.busy -and $state.canSend -and
                [regex]::Replace($state.text, '\s+', ' ').Trim() -ceq $expected) {
                $unclickedPolls++
                if ($unclickedPolls -ge 4) {
                    $unclickedPolls = 0
                    $sendClicks++
                    $Server.UpdateJob($Job.Id, 'sending',
                        "${Label}: prompt is still in composer and Send is enabled; re-clicking Send (attempt $sendClicks of 3).")
                    try {
                        Send-YtComposer $Connection $session $Prompt -ProviderName $ProviderName
                    } catch {
                        Write-Verbose "Send retry click failed: $($_.Exception.Message)"
                    }
                }
            } else {
                $unclickedPolls = 0
            }
            Start-Sleep -Milliseconds 500
        }
        throw 'Submission could not be confirmed. Check ChatGPT before retrying; the helper will not send a second time.'
    } catch {
        $failure = $_
        if ($null -ne $ProviderGates -and $journalOwned -and $sendAttempted -and
            -not $failure.Exception.Data['YtDefiniteRejection'] -and
            -not $CancellationToken.IsCancellationRequested -and -not $Server.StopRequested) {
            $reconciled = Resolve-YtAmbiguousSend -Connection $Connection -SessionId $session `
                -ExpectedText $expected -ProviderName $ProviderName -BeforeUserCount $beforeCount `
                -BeforeAssistantCount $beforeAssistantCount -Server $Server -Job $Job `
                -CancellationToken $CancellationToken
            if ($reconciled.Outcome -eq 'confirmed-success') {
                $Server.UpdateJob($Job.Id, 'summarizing', "${Label}: send reconciled from the provider conversation.")
                $handoffGate = $null -ne $ProviderGates
                return [pscustomobject]@{
                    Tab=$Tab; ExpectedText=$expected; ExpectedHash=$expectedHash
                    UserCount=$reconciled.UserCount; AssistantCount=$reconciled.AssistantCount; Label=$Label
                    ReconciledByAssistant=[bool]$reconciled.ReconciledByAssistant
                    ConversationUrl=[string]$reconciled.ConversationUrl
                    ProviderGate=$(if($handoffGate){$gate}else{$null})
                }
            }
            Remove-YtStageJournal $JournalPath $Job.Id $expectedHash
            $journalOwned = $false
            $resendMessage = if ($reconciled.Outcome -eq 'confirmed-failure') {
                # A confirmed failure means nothing was ever sent, so this tab holds nothing but
                # an abandoned, unsubmitted draft. Unlike a genuinely ambiguous send (which may
                # hold real, possibly-successful generation worth reconciling later), there is
                # nothing to preserve here, so close it instead of leaving a visibly stuck draft
                # sitting open next to whichever tab the retry opens for the next provider.
                Close-YtStageTab $Connection $Tab
                $closedAbandonedTab = $true
                'The provider conversation confirmed that the send failed; trying the next provider.'
            } else {
                # Only the job's own final stage may ever be attached as the finished summary;
                # an abandoned chunk or merge conversation must never stand in for the result.
                if ($FinalStage) { Save-YtAmbiguousSendMetadata $Server $Job $Tab $expectedHash }
                'Ambiguous send automatically resent using the next provider.'
            }
            $resend = New-Object InvalidOperationException -ArgumentList $resendMessage
            $resend.Data['YtAutomaticResend'] = $true
            throw $resend
        }
        if ($journalOwned -and (-not $sendAttempted -or $failure.Exception.Data['YtDefiniteRejection'])) {
            Remove-YtStageJournal $JournalPath $Job.Id $expectedHash
        }
        if (-not $sendAttempted -and -not $closedAbandonedTab -and ($createdTab -or $navigatedProvider)) {
            Close-YtStageTab $Connection $Tab
            $closedAbandonedTab = $true
        }
        $stageState = if ($CancellationToken.IsCancellationRequested -or $Server.StopRequested) { 'cancelled' }
            else { 'error' }
        $Server.UpdateJob($Job.Id, $stageState, "${Label}: " + $failure.Exception.Message)
        throw $failure
    } finally {
        if ($gateHeld -and -not $handoffGate) {
            $gate = if ($null -ne $ProviderGates -and $ProviderGates.Contains($ProviderName)) { $ProviderGates[$ProviderName] } else { $ComposerGate }
            if ($null -ne $gate) { $null = $gate.Release() }
        }
    }
}

# How long a provider rate-limit banner is tolerated while its answer may still arrive.
# ChatGPT/Gemini/Claude all render these next to a normal, working generation.
$script:YtUsageBannerGraceSeconds = 120

function Set-YtUsageBannerGraceSeconds {
    param([Parameter(Mandatory)][ValidateRange(0, 900)][int]$Seconds)
    $script:YtUsageBannerGraceSeconds = $Seconds
}

function Test-YtStageTabGone {
    <#
        True when a CDP call failed because its own tab/session disappeared - typically because
        the user closed the provider tab. The conversation itself still exists on the provider,
        so the stage can recover by reopening that conversation instead of failing the video.
    #>
    param([Parameter(Mandatory)][System.Exception]$Exception)
    return $Exception.Message -match (
        'Session with given id not found|No target with given id|' +
        'Inspected target navigated or closed|Target closed'
    )
}

function Invoke-YtProviderNavigation {
    param(
        $Connection, $Server, $Job,
        [Parameter(Mandatory)]$Tab,
        [Parameter(Mandatory)][string]$ProviderName,
        [Parameter(Mandatory)][string]$ProviderUrl,
        [Parameter(Mandatory)][string]$Label,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    $currentTab = $Tab
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            $navigation = Invoke-YtCdp $Connection 'Page.navigate' @{ url = $ProviderUrl } $currentTab.SessionId
            if ($navigation.PSObject.Properties['errorText']) {
                throw "$ProviderName navigation failed: $($navigation.errorText)"
            }
            return $currentTab
        } catch {
            if ($attempt -ge 3 -or
                -not (Test-YtStageTabGone $_.Exception) -or
                $CancellationToken.IsCancellationRequested -or
                ($null -ne $Server -and $Server.StopRequested)) {
                if ($attempt -ge 3 -and (Test-YtStageTabGone $_.Exception)) {
                    # Do not let the worker add another outer three-attempt loop after this
                    # navigation boundary already exhausted its bounded recovery.
                    $_.Exception.Data['YtRetriesExhausted'] = $true
                }
                throw
            }
            if ($null -ne $Server) {
                $Server.UpdateJob($Job.Id, $ProviderName.ToLowerInvariant(),
                    "${Label}: Chrome discarded the new $ProviderName tab session; replacing it before anything is sent (attempt $($attempt + 1)/3).")
            }
            Close-YtStageTab $Connection $currentTab
            $currentTab = New-YtBrowserTab $Connection 'about:blank' -Background -Server $Server `
                -CancellationToken $CancellationToken
        }
    }
}

function Wait-YtAssistantReply {
    param($Connection, $Server, $Job, $Stage, [string]$JournalPath, [int]$WaitSeconds,
        [System.Threading.CancellationToken]$CancellationToken,
        [ValidateSet('ChatGPT','Gemini','Claude')][string]$ProviderName = 'ChatGPT')
    $deadline = [DateTime]::UtcNow.AddSeconds($WaitSeconds)
    $previous = ''
    $stable = 0
    $unchangedPolls = 0
    $turnMismatches = 0
    $tabRecoveries = 0
    $usageBannerDeadline = $null
    try {
        while ([DateTime]::UtcNow -lt $deadline) {
            Assert-YtRunning $Server $CancellationToken
            $state = $null
            try {
                $state = Invoke-YtNavigationProbe $Connection $Stage.Tab.SessionId (Get-YtComposerExpression -ProviderName $ProviderName)
            } catch {
                # The user closed this provider tab while the answer was still being read.
                # The prompt was already accepted, so reopen that same conversation and keep
                # reading instead of failing a video whose summary may already be finished.
                $conversationUrl = if ($Stage.PSObject.Properties['ConversationUrl']) { [string]$Stage.ConversationUrl } else { '' }
                if ($tabRecoveries -ge 3 -or -not $conversationUrl -or
                    -not (Test-YtStageTabGone $_.Exception) -or
                    $CancellationToken.IsCancellationRequested -or $Server.StopRequested) { throw }
                $tabRecoveries++
                $Server.UpdateJob($Job.Id, 'summarizing',
                    "$($Stage.Label): its $ProviderName tab was closed; reopening that conversation to read the response.")
                $Stage.Tab = New-YtBrowserTab -Connection $Connection -Url $conversationUrl -Background `
                    -Server $Server -CancellationToken $CancellationToken
                Start-Sleep -Milliseconds 1500
                continue
            }
            # A rate-limit/failure banner can render on the same page as an already-completed,
            # genuine assistant answer (lastAssistantText already excludes error/alert boxes).
            # Never let a co-occurring banner discard a real answer that has already arrived;
            # only treat the page as unhealthy when this poll has no valid new answer yet.
            $hasValidAnswer = $null -ne $state -and $state.assistantMessageCount -gt $Stage.AssistantCount -and
                $state.lastAssistantText -and -not $state.busy
            if (-not $hasValidAnswer) {
                try { Assert-YtPageHealthy $state $Server $Stage.Label }
                catch {
                    # ChatGPT, Gemini and Claude all show rate/usage banners while still
                    # generating a perfectly good answer. Abandoning the stage the moment one
                    # appears threw away working summaries, so a usage banner only buys a
                    # bounded grace window here: if the answer arrives it is used, and only a
                    # banner that outlives the window rotates to the next provider.
                    $bannerIsUsage = $_.Exception.Data['YtFailureKind'] -eq 'usage'
                    if (-not $bannerIsUsage) { throw }
                    if ($null -eq $usageBannerDeadline) {
                        $usageBannerDeadline = [DateTime]::UtcNow.AddSeconds($script:YtUsageBannerGraceSeconds)
                        $Server.UpdateJob($Job.Id, 'summarizing',
                            "$($Stage.Label): $ProviderName showed a rate-limit notice; still waiting for its answer.")
                    }
                    if ([DateTime]::UtcNow -ge $usageBannerDeadline) { throw }
                    Start-Sleep -Milliseconds 1000
                    continue
                }
            }
            if ($null -ne $state) {
                $assistantReconciled = $Stage.PSObject.Properties['ReconciledByAssistant'] -and
                    [bool]$Stage.ReconciledByAssistant
                $conversationUrlChanged = $Stage.PSObject.Properties['ConversationUrl'] -and $Stage.ConversationUrl -and
                    (Get-YtConversationUrl ([string]$state.url) $ProviderName) -cne $Stage.ConversationUrl
                $turnMismatch = if ($assistantReconciled) {
                    # A reconciled send may still be mid-generation, so the accepted turn count
                    # must stay exactly where reconciliation found it, on the same conversation.
                    $state.messageCount -ne $Stage.UserCount
                } else {
                    $state.messageCount -ne $Stage.UserCount -or
                        [regex]::Replace($state.lastMessage, '\s+', ' ').Trim() -cne $Stage.ExpectedText
                }
                if ($conversationUrlChanged) {
                    # A different conversation really is a different conversation; there is
                    # nothing transient about it and nothing here can still arrive.
                    throw 'The conversation changed while waiting for its response. Nothing else was sent.'
                }
                if ($turnMismatch) {
                    # Providers re-render their own turn list while generating: a single poll
                    # can momentarily report a different count or rewritten prompt markup even
                    # though the conversation is untouched. Failing on the first such poll
                    # destroyed working videos and burned every automatic retry, so a mismatch
                    # must be confirmed by consecutive polls on the same conversation before it
                    # is believed. Progress is held back meanwhile so a half-rendered answer is
                    # never accepted as finished.
                    $turnMismatches++
                    $stable = 0
                    if ($turnMismatches -ge 4) {
                        throw 'The conversation changed while waiting for its response. Nothing else was sent.'
                    }
                    $Server.UpdateJob($Job.Id, 'summarizing',
                        "$($Stage.Label): the $ProviderName conversation briefly looked different; rechecking before giving up.")
                    Start-Sleep -Milliseconds 1000
                    continue
                }
                $turnMismatches = 0
                if ($hasValidAnswer) {
                    if ($state.lastAssistantText -ceq $previous) {
                        $stable++
                        $unchangedPolls++
                    } else {
                        $stable = 0
                        $unchangedPolls = 0
                        $previous = $state.lastAssistantText
                    }
                    if ($stable -ge 2) {
                        Remove-YtStageJournal $JournalPath $Job.Id $Stage.ExpectedHash
                        return [pscustomobject]@{Text=$state.lastAssistantText;Url=$state.url}
                    }
                } else {
                    $stable = 0
                    $unchangedPolls++
                }
                if ($unchangedPolls -ge 8) {
                    $Server.UpdateJob($Job.Id, 'summarizing',
                        "$($Stage.Label): response has not advanced; waking its background $ProviderName tab.")
                    Enable-YtBackgroundTabExecution $Connection $Stage.Tab.SessionId
                    $unchangedPolls = 0
                }
            }
            Start-Sleep -Milliseconds 1000
        }
        throw "The assistant response did not finish in time. Review that $ProviderName tab; nothing will be resent automatically."
    } catch {
        if ($_.Exception.Data['YtDefiniteRejection']) {
            Remove-YtStageJournal $JournalPath $Job.Id $Stage.ExpectedHash
        }
        throw
    } finally {
        if ($Stage.PSObject.Properties['ProviderGate'] -and $null -ne $Stage.ProviderGate) {
            $null = $Stage.ProviderGate.Release()
            $Stage.ProviderGate = $null
        }
    }
}

function Close-YtStageTab {
    <#
        Best-effort close of a completed part/merge-stage tab. Every part or merge stage is
        a fresh, already-captured conversation; only the very last stage of a job is kept open
        (in the background, never activated) so the user only ever finds the final result,
        never a pop-up per part.
    #>
    param($Connection, $Tab)
    if ($null -eq $Tab -or -not $Tab.PSObject.Properties['TargetId']) { return }
    try { $null = Invoke-YtCdp $Connection 'Target.closeTarget' @{ targetId = $Tab.TargetId } }
    catch { }
}

function Show-YtFinalStageTab {
    <#
        Keeps the finished summary tab open and responsive without activating it. Several
        videos can finish while the user is reading something else, so the helper never
        steals the browser view; the dashboard links to the finished conversation instead.
    #>
    param($Connection, $Tab)
    if ($null -eq $Tab -or -not $Tab.PSObject.Properties['SessionId']) { return }
    Enable-YtBackgroundTabExecution $Connection $Tab.SessionId
}

function Save-YtTabCheckpoint {
    param($Stage)
    $Stage.Tab | Add-Member -NotePropertyName PreviousConversation -NotePropertyValue (
        [pscustomobject]@{UserCount=$Stage.UserCount;Text=$Stage.ExpectedText}
    ) -Force
}

function Save-YtStageCheckpoint {
    param($Server, $Job, [int]$StageIndex, [int]$SuccessfulParts, [string]$ProviderName, [int]$RotationCursor,
        [string]$Progress, [string]$TranscriptHash, [int]$TranscriptLength, [int]$ChunkCount)
    foreach ($pair in @{
        StageIndex=$StageIndex; SuccessfulParts=$SuccessfulParts; ProviderName=$ProviderName
        RotationCursor=$RotationCursor; Progress=$Progress; TranscriptHash=$TranscriptHash
        TranscriptLength=$TranscriptLength; ChunkCount=$ChunkCount
    }.GetEnumerator()) {
        if ($Job.PSObject.Properties[$pair.Key]) { $Job.($pair.Key) = $pair.Value }
    }
    if ($null -ne $Server) {
        $state = if ($Job.PSObject.Properties['State']) { [string]$Job.State } else { 'summarizing' }
        $Server.UpdateJob($Job.Id, $state, $Progress)
    }
}

function Get-YtServerEnabledProviders {
    param($Server)
    if ($null -eq $Server) { return Get-YtProviderOrder }
    try { $configured = @($Server.EnabledProviders) }
    catch { return Get-YtProviderOrder }
    return Get-YtEnabledProviderOrder $configured
}

function Get-YtServerKeepIntermediateTabs {
    <#
        Whether to leave every part/merge-stage tab open instead of auto-closing it once its
        reply is saved. Defaults to false (auto-close) for any server/mock that does not expose
        the property, matching the historical behavior.
    #>
    param($Server)
    if ($null -eq $Server) { return $false }
    try { return [bool]$Server.KeepIntermediateTabs }
    catch { return $false }
}

function Invoke-YtRotatingChatStage {
    param(
        $Connection, $Server, $Job, $Tab,
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][string]$Label,
        [Parameter(Mandatory)][string]$JournalPath,
        [int]$WaitSeconds = 60,
        [int]$MaxMessageCharacters = 22000,
        [System.Collections.IDictionary]$ProviderGates,
        [System.Threading.SemaphoreSlim]$ComposerGate,
        [pscustomobject]$RotationCursor,
        [ValidateSet('ChatGPT','Gemini','Claude')][string]$FirstProvider = 'ChatGPT',
        [switch]$FinalStage,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    if ($null -eq $ProviderGates) {
        $stage = Invoke-YtChatStage -Connection $Connection -Server $Server -Job $Job -Tab $Tab `
            -Prompt $Prompt -Label $Label -JournalPath $JournalPath -WaitSeconds $WaitSeconds `
            -MaxMessageCharacters $MaxMessageCharacters -ComposerGate $ComposerGate `
            -ProviderName 'ChatGPT' -FinalStage:$FinalStage -CancellationToken $CancellationToken
        $stage | Add-Member -NotePropertyName ProviderName -NotePropertyValue 'ChatGPT' -Force
        return $stage
    }
    $order = Get-YtProviderOrder
    $enabledProviders = Get-YtServerEnabledProviders $Server
    $start = if ($null -ne $RotationCursor -and $RotationCursor.PSObject.Properties['Index']) {
        [int]$RotationCursor.Index
    } else { Get-YtProviderIndex $FirstProvider }
    $lastFailure = $null
    $lastClassification = ''
    $wraparoundResendGranted = $false
    # A provider whose single slot is held by another video is skipped, not failed. Only when
    # every usable slot is busy does this wait, briefly and boundedly, and re-check.
    $busyWaitDeadline = [DateTime]::UtcNow.AddMinutes(20)
    while ($true) {
    $busyProviders = 0
    $attemptLimit = $order.Count
    for ($attempt = 0; $attempt -lt $attemptLimit; $attempt++) {
        $index = ($start + $attempt) % $order.Count
        $providerName = $order[$index]
        $currentlyEnabled = Get-YtServerEnabledProviders $Server
        if ($providerName -notin $currentlyEnabled) { continue }
        $stage = $null
        try {
            $stage = Invoke-YtChatStage -Connection $Connection -Server $Server -Job $Job -Tab $Tab `
                -Prompt $Prompt -Label "$Label [$providerName]" -JournalPath $JournalPath `
                -WaitSeconds $WaitSeconds -MaxMessageCharacters $MaxMessageCharacters `
                -ComposerGate $ComposerGate -ProviderGates $ProviderGates -ProviderName $providerName `
                -GateWaitSeconds 3 -FinalStage:$FinalStage -CancellationToken $CancellationToken
            $stage | Add-Member -NotePropertyName ProviderName -NotePropertyValue $providerName -Force
            if ($null -ne $RotationCursor) {
                $RotationCursor.Index = Get-YtNextEnabledProviderIndex $index (Get-YtServerEnabledProviders $Server)
            }
            return $stage
        } catch {
            if ($null -ne $stage -and $stage.PSObject.Properties['ProviderGate'] -and
                $null -ne $stage.ProviderGate) {
                $null = $stage.ProviderGate.Release()
                $stage.ProviderGate = $null
            }
            if ($_.Exception.Data['YtProviderBusy']) {
                $busyProviders++
                continue
            }
            $lastFailure = $_
            $classification = Get-YtFailureClassification -Text $_.Exception.Message
            $lastClassification = $classification
            if ($_.Exception.Data['YtDefiniteRejection']) {
                # Every definite rejection rotates, but only a genuine usage/rate limit may pause
                # dispatch, so the real kind is remembered instead of the rotation shorthand.
                $definiteKind = [string]$_.Exception.Data['YtFailureKind']
                $lastClassification = if ($definiteKind) { $definiteKind } else { 'usage' }
                $classification = 'usage'
            }
            $automaticResend = [bool]$_.Exception.Data['YtAutomaticResend']
            if (-not $automaticResend -and -not (Test-YtDefiniteRejection $classification)) { throw }
            if ($automaticResend -and -not $wraparoundResendGranted) {
                # If the final enabled provider has the ambiguous send, wrapping once gives
                # the user's accepted duplicate-risk policy an actual next-provider attempt.
                # The single added attempt keeps this recovery bounded.
                $attemptLimit++
                $wraparoundResendGranted = $true
            }
            $reason = if ($automaticResend) { $_.Exception.Message }
                else { "$providerName rejected the request ($classification); trying the next provider." }
            if ($null -ne $Server) { $Server.UpdateJob($Job.Id, 'error', "$Label [$providerName]: $reason") }
            if ($automaticResend) { $Tab = $null }
        }
    }
    if ($busyProviders -eq 0) { break }
    if ($null -ne $lastFailure) { break }
    if ([DateTime]::UtcNow -ge $busyWaitDeadline) {
        throw "Every enabled provider stayed busy with other videos for $Label. Saved progress is kept; retry from the checkpoint."
    }
    if ($null -ne $Server) {
        $Server.UpdateJob($Job.Id, 'waiting-composer',
            "${Label}: every provider is busy with another video; waiting for the first free one.")
        Assert-YtRunning $Server $CancellationToken
    }
    $CancellationToken.ThrowIfCancellationRequested()
    Start-Sleep -Seconds 2
    }
    if ($null -ne $lastFailure) {
        if ($lastClassification -eq 'usage') { Suspend-YtDispatchForUsageLimit $Server $Label }
        throw $lastFailure
    }
    throw "No enabled provider was available for $Label."
}

function Invoke-YtStageWithReply {
    <#
        Sends a prompt (with full rotation/fallback) and waits for the assistant's reply.
        If the reply itself times out (the provider accepted the send but never finished
        generating), that is not a send-time failure the rotation loop already handles --
        this treats a stalled generation or a definite usage rejection as a rotatable
        condition instead of failing the whole job over one slow/rate-limited provider.
        Bounded by the number of currently enabled providers so it cannot loop forever.
    #>
    param(
        [Parameter(Mandatory)][hashtable]$StageArguments,
        $Tab,
        [Parameter(Mandatory)][string]$Prompt,
        [Parameter(Mandatory)][string]$Label,
        $Connection, $Server, $Job,
        [Parameter(Mandatory)][string]$JournalPath,
        [int]$ReplyWaitSeconds,
        [string]$FullFidelitySource,
        [string]$ValidationFailureMessage = 'The provider response did not preserve the requested content.',
        [switch]$FinalStage,
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    $maxAttempts = [Math]::Max(1, @(Get-YtServerEnabledProviders $Server).Count)
    for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
        $stage = Invoke-YtRotatingChatStage @StageArguments -Tab $Tab -Prompt $Prompt -Label $Label -FinalStage:$FinalStage
        try {
            $reply = Wait-YtAssistantReply $Connection $Server $Job $stage $JournalPath $ReplyWaitSeconds $CancellationToken $stage.ProviderName
            if ($FullFidelitySource -and
                -not (Test-YtFullTranscriptFidelity -Source $FullFidelitySource -Result $reply.Text)) {
                throw [InvalidOperationException]::new("FULL_FIDELITY_REJECTION: $ValidationFailureMessage")
            }
            return [pscustomobject]@{ Stage = $stage; Reply = $reply }
        } catch {
            $replyTimedOut = $_.Exception.Message -match 'did not finish in time'
            $fidelityRejected = $_.Exception.Message -match '^FULL_FIDELITY_REJECTION:'
            $usageRejected = $_.Exception.Data['YtDefiniteRejection'] -and
                $_.Exception.Data['YtFailureKind'] -eq 'usage'
            if ($attempt -ge $maxAttempts -or
                (-not $replyTimedOut -and -not $fidelityRejected -and -not $usageRejected)) {
                if ($usageRejected) { Suspend-YtDispatchForUsageLimit $Server $Label }
                throw
            }
            # The send itself was accepted, so the journal is still marking it pending; the
            # stalled reply is a deliberate, known outcome (not a crash), so clear it before
            # the next provider attempt reuses the same journal path.
            if (Test-Path -LiteralPath $JournalPath) {
                Remove-YtStageJournal $JournalPath $Job.Id $stage.ExpectedHash
            }
            # The abandoned tab may still be generating in the background. Close it so it
            # cannot keep running and eventually deliver a second, duplicate answer for the
            # same part alongside the next provider's attempt.
            if ($null -ne $stage.Tab -and $stage.Tab.PSObject.Properties['TargetId']) {
                try { $null = Invoke-YtCdp $Connection 'Target.closeTarget' @{ targetId = $stage.Tab.TargetId } }
                catch { }
            }
            $reason = if ($fidelityRejected) {
                "$($stage.ProviderName) changed or omitted source content in Full mode"
            } elseif ($usageRejected) {
                "$($stage.ProviderName) reported a usage limit"
            } else {
                "$($stage.ProviderName) did not respond in time"
            }
            $Server.UpdateJob($Job.Id, 'error',
                "${Label}: $reason; closing that tab and trying the next provider.")
            $Tab = $null
        }
    }
}

function Invoke-YtSummaryJob {
    param(
        $Connection, $Server, $Job,
        [Parameter(Mandatory)][string]$JournalPath,
        [int]$WaitSeconds = 60,
        [ValidateRange(2048, 100000)][int]$MaxMessageCharacters = 22000,
        [System.Threading.SemaphoreSlim]$ComposerGate,
        [System.Collections.IDictionary]$ProviderGates,
        [ValidateSet('ChatGPT','Gemini','Claude')][string]$FirstProvider = 'ChatGPT',
        [System.Threading.CancellationToken]$CancellationToken = [System.Threading.CancellationToken]::None
    )
    if (-not $PSBoundParameters.ContainsKey('CancellationToken') -and $null -ne $Connection -and
        $Connection.PSObject.Properties['CancellationToken']) { $CancellationToken = $Connection.CancellationToken }
    $label = 'Transcript'
    try {
        $previousState = if ($Job.PSObject.Properties['State']) { $Job.State } else { '' }
        if ((Test-Path -LiteralPath $JournalPath) -or $previousState -in @('sending', 'needs-review')) {
            if (Test-Path -LiteralPath $JournalPath) {
                try {
                    $pendingRecord = Get-Content -LiteralPath $JournalPath -Raw | ConvertFrom-Json
                    Remove-YtStageJournal $JournalPath $Job.Id $pendingRecord.expectedTextSha256
                } catch {
                    Remove-Item -LiteralPath $JournalPath -Force -ErrorAction Stop
                }
            }
            $Server.UpdateJob($Job.Id, 'starting',
                'A previous send was ambiguous; it is being automatically resent with duplicate risk recorded.')
        }
        if ($previousState -in @('submitted', 'completed', 'reviewed', 'cancelled')) { return }
        # Keep successful part progress visible while the transcript is fetched again. It is
        # resumed only after the newly fetched transcript hash, length, chunk plan and summary
        # level match the private persisted part checkpoint exactly.
        $enabledProviders = Get-YtServerEnabledProviders $Server
        $firstIndex = Get-YtProviderIndex $FirstProvider
        if ($FirstProvider -notin $enabledProviders) {
            $firstIndex = Get-YtNextEnabledProviderIndex (($firstIndex + 2) % 3) $enabledProviders
        }
        $effectiveFirstProvider = (Get-YtProviderOrder)[$firstIndex]
        $Server.UpdateJob($Job.Id, 'starting', 'Checking saved progress before continuing this video.')
        $summaryLevel = if ($Job.PSObject.Properties['SummaryLevel'] -and $Job.SummaryLevel) { $Job.SummaryLevel } else { 'legacy' }
        $requestedLanguage = if ($Job.PSObject.Properties['SummaryLanguage'] -and $Job.SummaryLanguage) { $Job.SummaryLanguage } else { 'auto' }
        $profile = Get-YtSummaryProfile -SummaryLevel $summaryLevel
        $waitWasExplicit = $PSBoundParameters.ContainsKey('WaitSeconds')
        $transcriptWaitSeconds = if ($waitWasExplicit) { $WaitSeconds } else { [Math]::Max($WaitSeconds, 180) }
        $replyWaitSeconds = if ($waitWasExplicit) { $WaitSeconds }
            else { [Math]::Max($WaitSeconds, $profile.ResponseWaitSeconds) }
        Assert-YtRunning $Server $CancellationToken
        $cachedTranscript = ''
        if ($null -ne $Server -and ($null -ne $Server.GetType().GetMethod('GetTranscriptCache') -or
            $null -ne $Server.PSObject.Methods['GetTranscriptCache'])) {
            try { $cachedTranscript = [string]$Server.GetTranscriptCache($Job.Id, $Job.VideoId) }
            catch { $cachedTranscript = '' }
        }
        $transcriptDomains = @(Get-YtTranscriptSourceDomains)
        $currentTranscriptDomain = $transcriptDomains[0]
        if ($cachedTranscript) {
            # Resuming must not depend on an external transcript service still being
            # reachable, and must not lose completed parts because that service returned
            # slightly different text this time.
            $Server.UpdateJob($Job.Id, 'loading',
                'Reusing the transcript saved with this video''s progress; the transcript service is not contacted again.')
            $tab = New-YtBrowserTab $Connection 'about:blank' `
                -Background:($null -ne $ComposerGate) -Server $Server -CancellationToken $CancellationToken
        } else {
            $Server.UpdateJob($Job.Id, 'loading', 'Opening the transcript page.')
            $tab = New-YtBrowserTab $Connection ($currentTranscriptDomain.UrlTemplate -f $Job.VideoId) `
                -Background:($null -ne $ComposerGate) -Server $Server -CancellationToken $CancellationToken
        }
        $nativeTab = $null
        $text = $cachedTranscript
        $transcriptReady = $false
        try {
            $serviceFailure = ''
            if (-not $text) {
                $Server.UpdateJob($Job.Id, 'loading',
                    'Giving the transcript service a brief head start before opening YouTube in parallel.')
                $serviceHeadStartSeconds = [Math]::Min($transcriptWaitSeconds, 5)
                $serviceResult = Wait-YtTranscriptService -Connection $Connection -Server $Server -Job $Job -Tab $tab `
                    -Source $currentTranscriptDomain -WaitSeconds $serviceHeadStartSeconds -AllowForegroundWake `
                    -CancellationToken $CancellationToken
                $text = $serviceResult.Text
                $serviceFailure = [string]$serviceResult.DefiniteFailure
            }
            if (-not $text) {
                try {
                    $nativeTab = New-YtBrowserTab $Connection "https://www.youtube.com/watch?v=$($Job.VideoId)" `
                        -Background -Server $Server -CancellationToken $CancellationToken
                } catch {
                    Write-Warning "Job $($Job.Id): Could not preload YouTube's native transcript tab: $($_.Exception.Message)"
                }
            }
            if (-not $text -and $null -ne $nativeTab -and -not $serviceFailure) {
                $Server.UpdateJob($Job.Id, 'loading',
                    "YouTube's own transcript is loading in parallel with one more transcript-service check.")
                $serviceResult = Wait-YtTranscriptService -Connection $Connection -Server $Server -Job $Job -Tab $tab `
                    -Source $currentTranscriptDomain -WaitSeconds ([Math]::Min($transcriptWaitSeconds, 10)) `
                    -CancellationToken $CancellationToken
                $text = $serviceResult.Text
                $serviceFailure = [string]$serviceResult.DefiniteFailure
                if ($text) {
                    Close-YtStageTab $Connection $nativeTab
                    $nativeTab = $null
                }
            }
            if (-not $text -and $null -ne $nativeTab) {
                if ($serviceFailure) {
                    $Server.UpdateJob($Job.Id, 'loading',
                        $serviceFailure + " Closing the rejected transcript-service tab and reading YouTube's captions.")
                    # This source has made a definite failure, so keeping its tab around only
                    # looks like a stuck second attempt. The native reader does not need it.
                    Close-YtStageTab $Connection $tab
                    $tab = $null
                }
                $nativeError = $null
                try {
                    $nativeResult = Get-YtYouTubeTranscript -Connection $Connection -Server $Server -Job $Job -Tab $nativeTab `
                        -WaitSeconds $transcriptWaitSeconds -ComposerGate $ComposerGate -SkipNavigation `
                        -ServiceTab $(if ($serviceFailure) { $null } else { $tab }) `
                        -ServiceSource $(if ($serviceFailure) { $null } else { $currentTranscriptDomain }) `
                        -CancellationToken $CancellationToken
                    $text = $nativeResult.Text
                    if ($nativeResult.UsedService) {
                        Close-YtStageTab $Connection $nativeTab
                        $nativeTab = $null
                    } else {
                        Close-YtStageTab $Connection $tab
                        $tab = $nativeTab
                        $nativeTab = $null
                    }
                } catch {
                    if ($CancellationToken.IsCancellationRequested -or $Server.StopRequested -or
                        (Test-YtTransientInfrastructureFailure $_.Exception $Server $CancellationToken)) { throw }
                    $nativeError = $_
                }
                if (-not $text -and -not $serviceFailure) {
                    $Server.UpdateJob($Job.Id, 'loading',
                        "YouTube's own transcript did not complete; giving the still-open transcript service one final check.")
                    $serviceResult = Wait-YtTranscriptService -Connection $Connection -Server $Server -Job $Job -Tab $tab `
                        -Source $currentTranscriptDomain -WaitSeconds ([Math]::Min($transcriptWaitSeconds, 15)) `
                        -CancellationToken $CancellationToken
                    $text = $serviceResult.Text
                    $serviceFailure = [string]$serviceResult.DefiniteFailure
                }
                if (-not $text -and $null -ne $nativeError) {
                    if ($serviceFailure) {
                        throw "$serviceFailure YouTube's own transcript also failed: $($nativeError.Exception.Message)"
                    }
                    throw $nativeError
                }
            }
            if (-not $text) {
                $nativeResult = Get-YtYouTubeTranscript -Connection $Connection -Server $Server -Job $Job -Tab $tab `
                    -WaitSeconds $transcriptWaitSeconds -ComposerGate $ComposerGate -CancellationToken $CancellationToken
                $text = $nativeResult.Text
            }
            $transcriptReady = [bool]$text
        } finally {
            if ($null -ne $nativeTab) { Close-YtStageTab $Connection $nativeTab; $nativeTab = $null }
            if (-not $transcriptReady -and $null -ne $tab) { Close-YtStageTab $Connection $tab; $tab = $null }
        }
        if ($text.Length -gt 750000) { throw 'The transcript exceeds the helper safety limit. It was not truncated or sent.' }
        if (-not $cachedTranscript -and $null -ne $Server -and
            ($null -ne $Server.GetType().GetMethod('SaveTranscriptCache') -or
             $null -ne $Server.PSObject.Methods['SaveTranscriptCache'])) {
            # Saved before any provider is contacted, so even a first-part failure resumes
            # without the transcript service. It is deleted again as soon as the video
            # finishes or its progress is cleared.
            try { $Server.SaveTranscriptCache($Job.Id, $Job.VideoId, $text) }
            catch { Write-Warning "Job $($Job.Id): Could not save the transcript for resuming: $($_.Exception.Message)" }
        }
        # Normal summaries are always Hebrew. Full prompts ignore this instruction and preserve
        # the source verbatim, so legacy auto/English jobs cannot leak an English instruction.
        $effectiveLanguage = 'hebrew'
        # Every reply opens with the video's own title and link, so a part or the final
        # summary still identifies its video when it is read on its own.
        $videoHeaderTitle = if ($Job.PSObject.Properties['Title']) { [string]$Job.Title } else { '' }
        $plan = Get-YtTranscriptPlan -Transcript $text -VideoId $Job.VideoId -MaxMessageCharacters $MaxMessageCharacters -SummaryLevel $summaryLevel -Language $effectiveLanguage -Title $videoHeaderTitle
        $hashProvider = [Security.Cryptography.SHA256]::Create()
        try { $transcriptHash = [BitConverter]::ToString($hashProvider.ComputeHash([Text.Encoding]::UTF8.GetBytes($text))).Replace('-', '').ToLowerInvariant() }
        finally { $hashProvider.Dispose() }
        $chunkCount = if ($plan.IsChunked) { $plan.ChunkPrompts.Count } else { 1 }
        $planIdentity = if ($plan.IsChunked) {
            [string]::Join([char]0x1e, [string[]]$plan.ChunkPrompts)
        } else { [string]$plan.SinglePrompt }
        $planHashProvider = [Security.Cryptography.SHA256]::Create()
        try { $planHash = [BitConverter]::ToString($planHashProvider.ComputeHash([Text.Encoding]::UTF8.GetBytes($planIdentity))).Replace('-', '').ToLowerInvariant() }
        finally { $planHashProvider.Dispose() }
        $savedPartCheckpoint = $null
        if ($null -ne $Server -and ($null -ne $Server.GetType().GetMethod('GetPartCheckpoint') -or
            $null -ne $Server.PSObject.Methods['GetPartCheckpoint'])) {
            $savedPartCheckpoint = $Server.GetPartCheckpoint($Job.Id)
        }
        $resumeParts = 0
        if ($plan.IsChunked -and $null -ne $savedPartCheckpoint -and
            $savedPartCheckpoint.TranscriptHash -ceq $transcriptHash -and
            [int]$savedPartCheckpoint.TranscriptLength -eq $text.Length -and
            [int]$savedPartCheckpoint.ChunkCount -eq $chunkCount -and
            [string]$savedPartCheckpoint.SummaryLevel -ceq $summaryLevel -and
            [string]$savedPartCheckpoint.PlanHash -ceq $planHash -and
            $null -ne $savedPartCheckpoint.Parts -and
            $savedPartCheckpoint.Parts.Count -le $chunkCount) {
            $resumeParts = [int]$savedPartCheckpoint.Parts.Count
        } else {
            if ($null -ne $Server -and ($null -ne $Server.GetType().GetMethod('ResetPartCheckpoint') -or
                $null -ne $Server.PSObject.Methods['ResetPartCheckpoint'])) {
                $Server.ResetPartCheckpoint($Job.Id, $transcriptHash, $text.Length, $chunkCount,
                    $summaryLevel, $planHash, $effectiveFirstProvider, $firstIndex)
            } else {
                if ($null -ne $Server) { $Server.ClearJobPartResultUrls($Job.Id) }
                Save-YtStageCheckpoint $Server $Job 0 0 $effectiveFirstProvider $firstIndex `
                    "Prepared transcript and $chunkCount stage(s)." $transcriptHash $text.Length $chunkCount
            }
        }
        $resumeRotation = if ($resumeParts -gt 0 -and $Job.PSObject.Properties['RotationCursor']) {
            [int]$Job.RotationCursor
        } else { $firstIndex }
        $stageArguments = @{
            Connection=$Connection; Server=$Server; Job=$Job; JournalPath=$JournalPath
            WaitSeconds=$WaitSeconds; MaxMessageCharacters=$MaxMessageCharacters
            ComposerGate=$ComposerGate; ProviderGates=$ProviderGates; CancellationToken=$CancellationToken
            RotationCursor=([pscustomobject]@{Index=$resumeRotation}); FirstProvider=$effectiveFirstProvider
        }
        if ($plan.IsChunked) {
            $stage = $null
            $reply = $null
            $Server.UpdateJob($Job.Id, 'splitting', "Splitting $($text.Length) characters into $($plan.ChunkPrompts.Count) parts.")
            $notes = New-Object 'Collections.Generic.List[string]'
            $lastPartProvider = ''
            $lastPartUrl = ''
            if ($resumeParts -gt 0) {
                foreach ($savedPart in $savedPartCheckpoint.Parts) {
                    $notes.Add([string]$savedPart.Text)
                    $lastPartProvider = [string]$savedPart.ProviderName
                    $lastPartUrl = [string]$savedPart.ResultUrl
                    if ($savedPart.ResultUrl -and $null -ne $Server) {
                        $Server.AddPartResultUrl($Job.Id, [string]$savedPart.ResultUrl)
                    }
                }
                $Server.UpdateJob($Job.Id, 'splitting',
                    "Resuming from saved progress at Part $($resumeParts + 1)/$($plan.ChunkPrompts.Count); $resumeParts completed part(s) will not be resent.")
            }
            for ($i = $resumeParts; $i -lt $plan.ChunkPrompts.Count; $i++) {
                $label = "Part $($i + 1)/$($plan.ChunkPrompts.Count)"
                $sourceChunk = $plan.Chunks[$i]
                $fidelitySource = if ($summaryLevel -eq 'full') { $sourceChunk } else { $null }
                $result = Invoke-YtStageWithReply -StageArguments $stageArguments -Tab $tab -Prompt $plan.ChunkPrompts[$i] `
                    -Label $label -Connection $Connection -Server $Server -Job $Job -JournalPath $JournalPath `
                    -ReplyWaitSeconds $replyWaitSeconds -FullFidelitySource $fidelitySource `
                    -ValidationFailureMessage 'The response changed or omitted transcript content.' `
                    -CancellationToken $CancellationToken
                $stage = $result.Stage; $reply = $result.Reply
                $notes.Add($reply.Text)
                $lastPartProvider = $stage.ProviderName
                $lastPartUrl = $reply.Url
                Save-YtTabCheckpoint $stage
                # Record this split part's own conversation link so the dashboard's "Open all
                # parts" action can reopen every part later, even after its tab is closed below.
                # Merge-round stages are intentionally not recorded here; "Parts: N/M" elsewhere
                # in the dashboard already only counts these first-level chunk stages.
                $partUri = [Uri]$reply.Url
                $partProvider = Get-YtProvider $stage.ProviderName
                $partResultUrl = ''
                if ($partUri.Scheme -eq 'https' -and $partUri.Host -eq $partProvider.ResultHost -and
                    $partUri.AbsolutePath -match $partProvider.ResultPathPattern) {
                    $partResultUrl = "https://$($partProvider.ResultHost)$($partUri.AbsolutePath)"
                }
                if ($null -ne $Server -and ($null -ne $Server.GetType().GetMethod('SavePartCheckpoint') -or
                    $null -ne $Server.PSObject.Methods['SavePartCheckpoint'])) {
                    $Server.SavePartCheckpoint($Job.Id, $i, $reply.Text, $partResultUrl,
                        $stage.ProviderName, [int]$stageArguments.RotationCursor.Index)
                } elseif ($partResultUrl) {
                    $Server.AddPartResultUrl($Job.Id, $partResultUrl)
                }
                Save-YtStageCheckpoint $Server $Job ($i + 1) $notes.Count $stage.ProviderName `
                    ([int]$stageArguments.RotationCursor.Index) "Completed $label." $transcriptHash $text.Length $chunkCount
                # A part's tab is never the job's final result unless this is Full mode's very
                # last chunk (no merge follows it); every other part/tab is closed immediately
                # so nothing lingers or pops to the front for the user to review, unless the
                # user opted in to keeping every intermediate tab open for their own review.
                if ($summaryLevel -eq 'full' -and $i -eq $plan.ChunkPrompts.Count - 1) {
                    $tab = $stage.Tab
                } elseif (Get-YtServerKeepIntermediateTabs $Server) {
                    $tab = $null
                } else {
                    Close-YtStageTab $Connection $stage.Tab
                    $tab = $null
                }
            }
            if ($summaryLevel -eq 'full') {
                $assembledResult = [string]::Concat([string[]]$notes.ToArray())
                $Server.SetFinalResult($Job.Id, $assembledResult)
                Save-YtStageCheckpoint $Server $Job $plan.ChunkPrompts.Count $notes.Count $lastPartProvider `
                    ([int]$stageArguments.RotationCursor.Index) 'Full transcript assembled locally without a lossy merge.' `
                    $transcriptHash $text.Length $chunkCount
                if ($lastPartUrl -and $lastPartProvider) {
                    $resultUri = [Uri]$lastPartUrl
                    $resultProvider = Get-YtProvider $lastPartProvider
                    if ($resultUri.Scheme -eq 'https' -and $resultUri.Host -eq $resultProvider.ResultHost -and
                        $resultUri.AbsolutePath -match $resultProvider.ResultPathPattern) {
                        $Server.SetResultUrl($Job.Id, "https://$($resultProvider.ResultHost)$($resultUri.AbsolutePath)")
                    }
                }
                if ($null -ne $stage) { Show-YtFinalStageTab $Connection $stage.Tab }
                elseif ($null -ne $tab) { Close-YtStageTab $Connection $tab; $tab = $null }
                $Server.UpdateJob($Job.Id, 'completed',
                    'The complete structured transcript is ready locally. Every part passed the no-omission check; no lossy merge was used.')
                if ($null -ne $Server -and ($null -ne $Server.GetType().GetMethod('CompletePartCheckpoint') -or
                    $null -ne $Server.PSObject.Methods['CompletePartCheckpoint'])) {
                    try { $Server.CompletePartCheckpoint($Job.Id) }
                    catch { Write-Warning "Completed job $($Job.Id), but could not remove its private part checkpoint: $($_.Exception.Message)" }
                }
                return
            }
            $finalPrompt = New-YtCombinePrompt -Summaries $notes.ToArray() -VideoId $Job.VideoId -Final -SummaryLevel $summaryLevel -Language $effectiveLanguage -Title $videoHeaderTitle
            $round = 0
            while ($finalPrompt.Length -gt $MaxMessageCharacters) {
                if (++$round -gt 6) { throw 'The notes did not fit after six merge rounds. Nothing was truncated; partial summaries remain in ChatGPT history.' }
                $previousLength = $finalPrompt.Length
                $groups = @(Get-YtSummaryGroups -Summaries $notes.ToArray() -VideoId $Job.VideoId -MaxMessageCharacters $MaxMessageCharacters -SummaryLevel $summaryLevel -Language $effectiveLanguage -Title $videoHeaderTitle)
                $next = New-Object 'Collections.Generic.List[string]'
                for ($g = 0; $g -lt $groups.Count; $g++) {
                    $label = "Merge round $round, group $($g + 1)/$($groups.Count)"
                    $Server.UpdateJob($Job.Id, 'combining', $label)
                    $result = Invoke-YtStageWithReply -StageArguments $stageArguments -Tab $tab -Prompt $groups[$g].Prompt `
                        -Label $label -Connection $Connection -Server $Server -Job $Job -JournalPath $JournalPath `
                        -ReplyWaitSeconds $replyWaitSeconds -CancellationToken $CancellationToken
                    $stage = $result.Stage; $reply = $result.Reply
                    $next.Add($reply.Text)
                    Save-YtTabCheckpoint $stage
                    Save-YtStageCheckpoint $Server $Job ($i + 1) $notes.Count $stage.ProviderName `
                        ([int]$stageArguments.RotationCursor.Index) "Completed $label." $transcriptHash $text.Length $chunkCount
                    # A merge-round group is never the job's final result: a later "Final
                    # combined summary" (or another merge round) always follows. Close it so
                    # it never accumulates as a background tab or needs manual attention,
                    # unless the user opted in to keeping every intermediate tab open.
                    if (Get-YtServerKeepIntermediateTabs $Server) { $tab = $null }
                    else { Close-YtStageTab $Connection $stage.Tab; $tab = $null }
                }
                $notes = $next
                $finalPrompt = New-YtCombinePrompt -Summaries $notes.ToArray() -VideoId $Job.VideoId -Final -SummaryLevel $summaryLevel -Language $effectiveLanguage -Title $videoHeaderTitle
                if ($finalPrompt.Length -ge $previousLength) { throw 'The generated notes are not getting smaller. Stopped without truncating or repeating any send.' }
            }
            $label = 'Final combined summary'
            $Server.UpdateJob($Job.Id, 'combining', $label)
            $finalStagePrompt = $finalPrompt
        } else {
            $label = 'Video summary'
            $finalStagePrompt = $plan.SinglePrompt
        }
        $finalFidelitySource = if ($summaryLevel -eq 'full') { $text } else { $null }
        $result = Invoke-YtStageWithReply -StageArguments $stageArguments -Tab $tab -Prompt $finalStagePrompt `
            -Label $label -Connection $Connection -Server $Server -Job $Job -JournalPath $JournalPath `
            -ReplyWaitSeconds $replyWaitSeconds -FullFidelitySource $finalFidelitySource `
            -ValidationFailureMessage 'The response changed or omitted transcript content.' `
            -FinalStage -CancellationToken $CancellationToken
        $stage = $result.Stage; $reply = $result.Reply
        if ($summaryLevel -eq 'full') { $Server.SetFinalResult($Job.Id, $reply.Text) }
        $savedStageIndex = if ($Job.PSObject.Properties['StageIndex']) { [int]$Job.StageIndex } else { 0 }
        $savedParts = if ($Job.PSObject.Properties['SuccessfulParts']) { [int]$Job.SuccessfulParts } else { 0 }
        Save-YtStageCheckpoint $Server $Job $savedStageIndex $savedParts $stage.ProviderName `
            ([int]$stageArguments.RotationCursor.Index) 'Final response completed.' $transcriptHash $text.Length $chunkCount
        $resultUri = [Uri]$reply.Url
        $resultProvider = Get-YtProvider $stage.ProviderName
        if ($resultUri.Scheme -eq 'https' -and $resultUri.Host -eq $resultProvider.ResultHost -and
            $resultUri.AbsolutePath -match $resultProvider.ResultPathPattern) {
            $Server.SetResultUrl($Job.Id, "https://$($resultProvider.ResultHost)$($resultUri.AbsolutePath)")
        }
        Show-YtFinalStageTab $Connection $stage.Tab
        $message = if ($summaryLevel -eq 'full') {
            'The complete structured transcript is ready locally and passed the no-omission check.'
        } elseif ($plan.IsChunked) {
            'The final combined summary is ready in ChatGPT. Every transcript part was included.'
        } else {
            'The video summary is ready in ChatGPT.'
        }
        $Server.UpdateJob($Job.Id, 'completed', $message)
        if ($null -ne $Server -and ($null -ne $Server.GetType().GetMethod('CompletePartCheckpoint') -or
            $null -ne $Server.PSObject.Methods['CompletePartCheckpoint'])) {
            try { $Server.CompletePartCheckpoint($Job.Id) }
            catch { Write-Warning "Completed job $($Job.Id), but could not remove its private part checkpoint: $($_.Exception.Message)" }
        }
    } catch {
        $stateName = if ($CancellationToken.IsCancellationRequested -or $Server.StopRequested) { 'cancelled' }
            else { 'error' }
        $message = "${label}: " + $_.Exception.Message
        $Server.UpdateJob($Job.Id, $stateName, $message)
        Write-Warning "Job $($Job.Id): $message"
        if ($null -ne $ProviderGates -and
            (Test-YtTransientInfrastructureFailure $_.Exception $Server $CancellationToken)) { throw }
    }
}

Export-ModuleMember -Function Get-YtBrowser, Open-YtCdp, Invoke-YtCdp, Invoke-YtPageScript,
    New-YtBrowserTab, Start-YtBrowser, Get-YtTranscriptExpression, Get-YtYouTubeTranscriptExpression, Get-YtYouTubeCaptionTrackExpression, Get-YtYouTubeVideoMetadata, Get-YtYouTubeVideoTitle, Get-YtComposerExpression,
    Focus-YtComposer, Send-YtComposer, Clear-YtComposerDraft, Invoke-YtComposerNudge, Invoke-YtSummaryJob, Test-YtTransientInfrastructureFailure,
    Invoke-YtWithInfrastructureRetry, Get-YtConversationUrl, Set-YtAmbiguousReconcileSeconds,
    Test-YtStageTabGone, Wait-YtAssistantReply, Set-YtUsageBannerGraceSeconds, Invoke-YtProviderNavigation,
    Test-YtAmbiguousTabMatch, Invoke-YtAmbiguousTabRecovery, Test-YtTranscriptTitleMatches
