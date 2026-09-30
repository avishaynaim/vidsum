param([switch]$LocalServerOnly, [string]$HelperRoot = (Split-Path $PSScriptRoot -Parent))
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$root = $HelperRoot
Import-Module (Join-Path $root 'YtSummary.psm1') -Force -DisableNameChecking
Add-Type -Path (Join-Path $root 'LoopbackServer.cs') -ReferencedAssemblies 'System.dll', 'System.Core.dll', 'System.Web.Extensions.dll'
$token = 'a' * 64
$server = $null
$cdp = $null
$profile = Join-Path $PSScriptRoot 'yt-summary-test-profile'
$count = 0

function Assert([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw "FAILED: $Message" }
    $script:count++
    Write-Output "PASS: $Message"
}

function Wait-FixtureSend($Connection, [string]$SessionId, [string]$Expected) {
    $normalized = [regex]::Replace($Expected, '\s+', ' ').Trim()
    $deadline = [DateTime]::UtcNow.AddSeconds(5)
    do {
        $state = Invoke-YtPageScript $Connection $SessionId (Get-YtComposerExpression -AllowFixture)
        if ($state.canSend -and [regex]::Replace($state.text, '\s+', ' ').Trim() -ceq $normalized) { return $state }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Fixture input did not settle: actual characters=$($state.text.Length), expected=$($Expected.Length), Send=$($state.canSend)."
}

function Http([string]$Method, [string]$Path, [string]$Body = '', [hashtable]$Extra = @{}) {
    $client = New-Object Net.Sockets.TcpClient
    $client.Connect('127.0.0.1', $server.Port)
    try {
        $headers = @{ Host = "127.0.0.1:$($server.Port)"; Connection = 'close' }
        foreach ($key in $Extra.Keys) { $headers[$key] = $Extra[$key] }
        $bodyBytes = [Text.Encoding]::UTF8.GetBytes($Body)
        if ($Method -eq 'POST' -and -not $headers.ContainsKey('Content-Length')) { $headers['Content-Length'] = $bodyBytes.Length }
        $text = "$Method $Path HTTP/1.1`r`n"
        foreach ($key in $headers.Keys) { $text += "${key}: $($headers[$key])`r`n" }
        $text += "`r`n"
        $stream = $client.GetStream()
        $head = [Text.Encoding]::ASCII.GetBytes($text)
        $stream.Write($head, 0, $head.Length)
        if ($bodyBytes.Length) { $stream.Write($bodyBytes, 0, $bodyBytes.Length) }
        $reader = New-Object IO.StreamReader -ArgumentList $stream
        $response = $reader.ReadToEnd()
        $parts = $response -split "`r`n`r`n", 2
        return [pscustomobject]@{ Status = [int]($parts[0].Split(' ')[1]); Body = $parts[1] }
    } finally {
        $client.Dispose()
    }
}

try {
    $server = New-Object YtSummary.LocalServer -ArgumentList 0, $token,
        ([IO.File]::ReadAllText((Join-Path $root 'index.html'))), ([IO.File]::ReadAllText((Join-Path $root 'app.js')))
    $server.Start()
    $auth = @{ 'X-YT-Token' = $token; Origin = $server.Origin; 'Content-Type' = 'application/json' }
    Assert ((Http GET '/').Status -eq 200) 'Static setup page is reachable'
    Assert ((Http GET '/api/status').Status -eq 403) 'Unauthenticated status is rejected'
    Assert ((Http GET '/' '' @{Host = "evil.example:$($server.Port)"}).Status -eq 421) 'Unexpected Host is rejected'
    Assert ((Http GET '/api/status' '' @{'X-YT-Token' = $token; Origin = 'https://youtube.com'}).Status -eq 403) 'Cross-origin request is rejected even with token'
    Assert ((Http POST '/api/jobs' '{}' @{'X-YT-Token' = $token; Origin = $server.Origin; 'Content-Type' = 'text/plain'}).Status -eq 403) 'Simple-form content type is rejected'
    Assert ((Http POST '/api/jobs' '' @{'X-YT-Token' = $token; Origin = $server.Origin; 'Content-Type' = 'application/json'; 'Content-Length' = 3000}).Status -eq 413) 'Oversized request is rejected before reading its body'
    Assert ((Http POST '/api/jobs' '{"videoId":"bad","requestId":"bad"}' $auth).Status -eq 400) 'Malformed video and request IDs are rejected'
    $body = @{videoId='JZn5RLXQFtg';requestId=[guid]::NewGuid().ToString()} | ConvertTo-Json -Compress
    Assert ((Http POST '/api/jobs' $body $auth).Status -eq 202) 'Jobs queue safely before browser readiness'
    Assert ($null -eq $server.TakeJob()) 'No queued job starts before browser readiness'
    $server.BrowserReady = $true
    $accepted = Http POST '/api/jobs' $body $auth
    Assert ($accepted.Status -eq 200) 'Accepted requests remain idempotent across browser readiness'
    $job = $server.TakeJob()
    $repeat = Http POST '/api/jobs' $body $auth
    Assert ($repeat.Status -eq 200 -and ($repeat.Body | ConvertFrom-Json).Id -eq $job.Id) 'Identical request returns the same job'
    Assert ($null -eq $server.TakeJob()) 'Idempotent retry does not enqueue a duplicate'
    $body2 = @{videoId='14RP8liACqo';requestId=[guid]::NewGuid().ToString()} | ConvertTo-Json -Compress
    Assert ((Http POST '/api/jobs' $body2 $auth).Status -eq 202) 'Another video is queued without blocking'
    $server.UpdateJob($job.Id, 'needs-review', 'Fixture uncertain send')
    Assert ((Http POST '/api/jobs' $body2 $auth).Status -eq 200) 'An uncertain send does not block another video'
    $retryBody = @{videoId=$job.VideoId;requestId=[guid]::NewGuid().ToString()} | ConvertTo-Json -Compress
    $uncertainDuplicate = Http POST '/api/jobs' $retryBody $auth
    Assert ($uncertainDuplicate.Status -eq 200 -and ($uncertainDuplicate.Body | ConvertFrom-Json).Id -eq $job.Id) 'An uncertain matching video reuses its existing retryable job'
    Assert ((Http POST '/api/acknowledge' '{}' $auth).Status -eq 200) 'A legacy acknowledgement works when exactly one video needs review'
    $review = $server.TakeReviewAcknowledgement()
    Assert ($review.Id -eq $job.Id) 'The acknowledgement identifies the correct video'
    $server.CompleteReview($review.Id)
    Assert ($server.GetJob($job.Id).State -eq 'reviewed') 'Controller completes only the acknowledged review'
    $server.UpdateJob($job.Id, 'error', 'Fixture complete')
    if ($LocalServerOnly) {
        Assert ((Http POST '/api/stop' '{}' $auth).Status -eq 200 -and $server.StopRequested) 'Authenticated stop is supported'
        Write-Output "ALL $count local-only assertions passed. No browser was started."
        return
    }
    $cdp = Start-YtBrowser (Get-YtBrowser) $profile 'about:blank'
    Assert ($cdp.Socket.State -eq [Net.WebSockets.WebSocketState]::Open) 'Real Chrome opens with a loopback CDP connection'
    $launchedProcess = Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe'" |
        Where-Object { $_.CommandLine -like "*$profile*" } | Select-Object -First 1
    Assert ($null -ne $launchedProcess -and $launchedProcess.CommandLine -like '*--disable-background-timer-throttling*' -and
        $launchedProcess.CommandLine -like '*--disable-backgrounding-occluded-windows*' -and
        $launchedProcess.CommandLine -like '*--disable-renderer-backgrounding*') `
        'Background tabs are never throttled, so parallel videos never stall until a tab is manually opened or closed'
    $reconnected = Start-YtBrowser (Get-YtBrowser) $profile 'about:blank'
    Assert ($reconnected.Socket.State -eq [Net.WebSockets.WebSocketState]::Open -and $reconnected.Socket -ne $cdp.Socket) 'A restarted helper can reconnect to its existing dedicated browser'
    $reconnected.Socket.Dispose()
    $fixture = New-Object Uri (Join-Path $PSScriptRoot 'yt-summary-fixture.html')
    $tab = New-YtBrowserTab $cdp $fixture.AbsoluteUri
    Start-Sleep -Milliseconds 800
    $automationFlag = Invoke-YtPageScript $cdp $tab.SessionId 'navigator.webdriver'
    Assert ($automationFlag -eq $false) 'Ordinary debugging does not enable the special port-0 automation mode'
    $expression = (Get-YtTranscriptExpression).Replace('if (!expectedPath || u.pathname !== expectedPath) return result;', '')
    $transcript = Invoke-YtPageScript $cdp $tab.SessionId $expression
    Assert ($transcript.count -eq 2 -and $transcript.text -ceq 'Hello & welcome. Second segment.') 'Transcript extraction excludes timestamps and injected ads'
    $null = Invoke-YtPageScript $cdp $tab.SessionId @'
window.savedTranscript = document.querySelector('#transcript');
window.savedTranscript.remove();
document.body.insertAdjacentHTML('afterbegin', '<h1 id="provider-error">Oops! YouTube Blocked Us This Time</h1>');
true
'@
    $blockedTranscript = Invoke-YtPageScript $cdp $tab.SessionId $expression
    Assert ($blockedTranscript.failure -eq 'YouTube blocked the transcript service.' -and -not $blockedTranscript.text) 'Provider block pages are identified without treating their message as captions'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.body.prepend(window.savedTranscript); true'
    $validTranscript = Invoke-YtPageScript $cdp $tab.SessionId $expression
    Assert (-not $validTranscript.failure -and $validTranscript.count -eq 2) 'A provider warning does not discard an available transcript'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("#provider-error").remove(); true'
    $null = Invoke-YtPageScript $cdp $tab.SessionId @'
document.body.insertAdjacentHTML('beforeend', `
<div id="native-fixture">
  <ytd-watch-flexy video-id="fixture9999"></ytd-watch-flexy>
  <div id="movie_player"></div>
  <div id="description-inline-expander"><button id="expand">More</button></div>
  <ytd-video-description-transcript-section-renderer hidden><button id="native-open">Show transcript</button></ytd-video-description-transcript-section-renderer>
  <ytd-watch-metadata>
    <div id="actions"><ytd-menu-renderer><button id="native-overflow" aria-label="More actions" aria-haspopup="true">More</button></ytd-menu-renderer></div>
  </ytd-watch-metadata>
  <ytd-menu-popup-renderer id="native-menu" hidden>
    <ytd-menu-service-item-renderer id="native-menu-transcript"><span>Localized menu action</span></ytd-menu-service-item-renderer>
  </ytd-menu-popup-renderer>
  <ytd-engagement-panel-section-list-renderer id="native-panel" target-id="engagement-panel-searchable-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN" style="display:none">
    <input id="native-search">
    <h2>Transcript heading, not a caption</h2>
    <ytd-transcript-segment-renderer><span>00:00</span><span class="segment-text" aria-hidden="true"> Native &amp; first. </span></ytd-transcript-segment-renderer>
    <ytd-transcript-segment-renderer><span>00:01</span><span class="segment-text" aria-hidden="true">Second caption.</span></ytd-transcript-segment-renderer>
  </ytd-engagement-panel-section-list-renderer>
  <ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN" hidden>
    <ytd-transcript-segment-renderer><span class="segment-text">Hidden duplicate must not be sent.</span></ytd-transcript-segment-renderer>
  </ytd-engagement-panel-section-list-renderer>
</div>`);
window.nativeOpenCount = 0;
document.querySelector('#expand').onclick = () => {
  document.querySelector('#description-inline-expander').setAttribute('is-expanded', '');
  document.querySelector('ytd-video-description-transcript-section-renderer').hidden = false;
};
document.querySelector('#native-open').onclick = () => {
  window.nativeOpenCount++;
  const panel = document.querySelector('#native-panel');
  panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
  panel.style.display = 'block';
};
document.querySelector('#native-overflow').onclick = () => document.querySelector('#native-menu').hidden = false;
document.querySelector('#native-menu-transcript').data = {serviceEndpoint:{getTranscriptEndpoint:{params:'fixture'}}};
document.querySelector('#native-menu-transcript').onclick = () => {
  window.nativeOpenCount++;
  document.querySelector('#native-menu').hidden = true;
  const panel = document.querySelector('#native-panel');
  panel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
  panel.style.display = 'block';
};
window.nativePlayerResponse = {videoDetails:{videoId:'fixture9999'},playabilityStatus:{status:'OK'}};
document.querySelector('#movie_player').getPlayerResponse = () => window.nativePlayerResponse;
true
'@
    $null = Invoke-YtPageScript $cdp $tab.SessionId @'
window.nativePlayerResponse.captions = {playerCaptionsTracklistRenderer:{captionTracks:[
  {languageCode:"en",baseUrl:"https://www.youtube.com/api/timedtext?v=fixture9999&lang=en"}
]}};
window.nativeOriginalFetch = window.fetch;
window.fetch = async url => {
  window.nativeCaptionTrackUrl = url;
  return {
    ok:true,status:200,
    text:async () => JSON.stringify({events:[
      {segs:[{utf8:"Direct first. "},{utf8:"Line"}]},
      {segs:[{utf8:"Second\ncaption."}]}
    ]})
  };
};
true
'@
    $directNativeExpression = (Get-YtYouTubeCaptionTrackExpression -VideoId 'fixture9999').
        Replace('const u = new URL(location.href);', "const u = new URL('https://www.youtube.com/watch?v=fixture9999');")
    $directNative = Invoke-YtPageScript $cdp $tab.SessionId $directNativeExpression
    $directNativeUrl = Invoke-YtPageScript $cdp $tab.SessionId 'window.nativeCaptionTrackUrl'
    Assert ($directNative.count -eq 2 -and $directNative.text -ceq 'Direct first. Line Second caption.' -and
        $directNative.phase -eq 'caption-track-ready' -and $directNativeUrl -match '[?&]fmt=json3(?:&|$)') `
        'Native fallback reads and normalizes YouTube json3 caption tracks before clicking the transcript control'
    $null = Invoke-YtPageScript $cdp $tab.SessionId @'
delete window.__ytSummaryCaptionTrack_fixture9999;
window.nativeCaptionTrackUrls = [];
window.fetch = async url => {
  window.nativeCaptionTrackUrls.push(url);
  if (new URL(url).searchParams.get("fmt") === "json3") {
    return {ok:true,status:200,text:async () => '{"events":['};
  }
  return {
    ok:true,status:200,
    text:async () => '<timedtext><body><p t="0"><s>XML first.</s></p><p t="1000"><s>XML </s><s>&amp; second.</s></p></body></timedtext>'
  };
};
true
'@
    $directNative = Invoke-YtPageScript $cdp $tab.SessionId $directNativeExpression
    $directNativeUrls = @(Invoke-YtPageScript $cdp $tab.SessionId 'window.nativeCaptionTrackUrls')
    Assert ($directNative.count -eq 2 -and $directNative.text -ceq 'XML first. XML & second.' -and
        $directNative.phase -eq 'caption-track-ready' -and $directNativeUrls.Count -eq 2 -and
        $directNativeUrls[0] -match '[?&]fmt=json3(?:&|$)' -and
        $directNativeUrls[1] -match '[?&]fmt=srv3(?:&|$)') `
        'A truncated json3 caption response falls back to YouTube srv3 XML instead of failing the video'
    Assert ((Get-YtYouTubeCaptionTrackExpression -VideoId 'fixture9999') -notmatch 'new DOMParser') `
        'The caption reader never uses DOMParser, which YouTube Trusted Types blocks'
    $null = Invoke-YtPageScript $cdp $tab.SessionId @'
delete window.__ytSummaryCaptionTrack_fixture9999;
window.fetch = async url => ({
  ok:true,status:200,
  text:async () => new URL(url).searchParams.get("fmt") === "json3" ? '{"events":[' : '<timedtext>'
});
true
'@
    $directNative = Invoke-YtPageScript $cdp $tab.SessionId $directNativeExpression
    Assert ($directNative.phase -eq 'caption-track-format-error' -and $directNative.retryable -and
        $directNative.failure -like '*json3*XML was empty or malformed*') `
        'Malformed json3 and XML caption bodies remain retryable for the native transcript-panel fallback'
    $null = Invoke-YtPageScript $cdp $tab.SessionId @'
delete window.__ytSummaryCaptionTrack_fixture9999;
window.nativeRequests = [];
window.ytcfg = {get:key => key === 'INNERTUBE_API_KEY' ? 'fixture-api-key' : ''};
window.fetch = async (url, options = {}) => {
  const parsed = new URL(url, location.origin);
  window.nativeRequests.push({url:parsed.href,method:options.method || 'GET',
    headers:options.headers || {},body:options.body || ''});
  if (parsed.pathname === '/youtubei/v1/player') {
    window.nativeAndroidPlayerFetched = true;
    return {ok:true,status:200,json:async () => ({
      playabilityStatus:{status:'OK'},
      captions:{playerCaptionsTracklistRenderer:{captionTracks:[
        {languageCode:'fr',baseUrl:'https://www.youtube.com/api/timedtext?v=fixture9999&lang=fr'},
        {languageCode:'en',baseUrl:'https://www.youtube.com/api/timedtext?v=fixture9999&lang=en'}
      ]}}
    })};
  }
  if (window.nativeAndroidPlayerFetched && parsed.searchParams.get('lang') === 'en' &&
      parsed.searchParams.get('fmt') === 'json3') {
    return {ok:true,status:200,text:async () => JSON.stringify({events:[
      {segs:[{utf8:'Android player captions.'}]}
    ]})};
  }
  return {ok:true,status:200,text:async () => ''};
};
true
'@
    $directNative = Invoke-YtPageScript $cdp $tab.SessionId $directNativeExpression
    $androidRequests = @(Invoke-YtPageScript $cdp $tab.SessionId 'window.nativeRequests')
    $androidPlayerRequest = @($androidRequests | Where-Object { $_.url -match '/youtubei/v1/player' })[0]
    Assert ($directNative.phase -eq 'caption-track-ready' -and
        $directNative.text -eq 'Android player captions.') `
        'An empty WEB caption response falls back to Android player captions instead of leaving the transcript stuck'
    Assert ($null -ne $androidPlayerRequest -and $androidPlayerRequest.method -eq 'POST' -and
        $androidPlayerRequest.url -match 'key=fixture-api-key' -and
        $androidPlayerRequest.headers.'x-youtube-client-name' -eq '3' -and
        $androidPlayerRequest.headers.'x-youtube-client-version' -eq '20.10.38' -and
        (($androidPlayerRequest.body | ConvertFrom-Json).context.client.clientName -eq 'ANDROID') -and
        (($androidPlayerRequest.body | ConvertFrom-Json).context.client.androidSdkVersion -eq 30)) `
        'Android fallback uses the same-origin player endpoint and the required Android client request shape'
    $null = Invoke-YtPageScript $cdp $tab.SessionId @'
window.nativePlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks[0].baseUrl =
  "https://example.com/api/timedtext?v=fixture9999&lang=en";
window.nativeCaptionTrackUrl = "";
delete window.__ytSummaryCaptionTrack_fixture9999;
true
'@
    $directNative = Invoke-YtPageScript $cdp $tab.SessionId $directNativeExpression
    $directNativeUrl = Invoke-YtPageScript $cdp $tab.SessionId 'window.nativeCaptionTrackUrl'
    Assert ($directNative.phase -eq 'caption-track-url-rejected' -and
        $directNative.failure -like '*unexpected caption-track URL*' -and -not $directNativeUrl) `
        'Native direct extraction refuses a caption URL outside the validated YouTube video endpoint'
    $null = Invoke-YtPageScript $cdp $tab.SessionId @'
delete window.nativePlayerResponse.captions;
delete window.__ytSummaryCaptionTrack_fixture9999;
delete window.__ytSummaryCaptionTrack_fixture9999_inFlight;
window.fetch = window.nativeOriginalFetch;
delete window.nativeOriginalFetch;
true
'@
    $nativeExpression = (Get-YtYouTubeTranscriptExpression -VideoId 'fixture9999' -OpenTranscript).
        Replace('const u = new URL(location.href);', "const u = new URL('https://www.youtube.com/watch?v=fixture9999');")
    $native = Invoke-YtPageScript $cdp $tab.SessionId $nativeExpression
    Assert ($native.action -eq 'expand-description' -and $native.phase -eq 'description-collapsed') 'Native fallback expands only the video description'
    $native = Invoke-YtPageScript $cdp $tab.SessionId $nativeExpression
    Assert ($native.action -eq 'open-transcript' -and $native.phase -eq 'transcript-control-found') 'Native fallback opens the scoped Show transcript control'
    $native = Invoke-YtPageScript $cdp $tab.SessionId $nativeExpression
    Assert ($native.count -eq 2 -and $native.text -ceq 'Native & first. Second caption.' -and $native.phase -eq 'transcript-ready') 'Native captions exclude timestamps, headings and duplicate hidden panels'
    $nativeReadOnly = (Get-YtYouTubeTranscriptExpression -VideoId 'fixture9999').
        Replace('const u = new URL(location.href);', "const u = new URL('https://www.youtube.com/watch?v=fixture9999');")
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("#native-search").value = "caption"; true'
    $native = Invoke-YtPageScript $cdp $tab.SessionId $nativeReadOnly
    Assert ($native.failure -like '*Filtered captions*' -and -not $native.text) 'Filtered native transcripts are refused rather than submitted partially'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("#native-search").value = ""; document.querySelector("#native-panel").insertAdjacentHTML("beforeend", "<ytd-continuation-item-renderer>Loading</ytd-continuation-item-renderer>"); true'
    $native = Invoke-YtPageScript $cdp $tab.SessionId $nativeReadOnly
    Assert ($native.count -eq 0 -and -not $native.text) 'Native captions are not accepted while more transcript content is loading'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("ytd-continuation-item-renderer").remove(); true'
    $wrongNative = $nativeExpression.Replace('watch?v=fixture9999', 'watch?v=wrongvideo1')
    $native = Invoke-YtPageScript $cdp $tab.SessionId $wrongNative
    Assert ($native.failure -like '*different video*' -and -not $native.text) 'Native extraction refuses another video before reading or clicking'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("#native-panel").style.display = "none"; document.querySelector("#native-panel").setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"); true'
    $native = Invoke-YtPageScript $cdp $tab.SessionId $nativeReadOnly
    $nativeOpens = Invoke-YtPageScript $cdp $tab.SessionId 'window.nativeOpenCount'
    Assert ($nativeOpens -eq 1 -and -not $native.action) 'An already requested native transcript is not opened repeatedly'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("ytd-video-description-transcript-section-renderer").remove(); true'
    $null = Invoke-YtPageScript $cdp $tab.SessionId @'
document.querySelector("#native-menu").hidden = true;
window.nativePlayerResponse.captions = {playerCaptionsTracklistRenderer:{captionTracks:[{languageCode:"he"}]}};
true
'@
    $native = Invoke-YtPageScript $cdp $tab.SessionId $nativeExpression
    Assert ($native.action -eq 'open-transcript-menu' -and $native.phase -eq 'overflow-control-found' -and $native.captionsAvailable) `
        'Native fallback opens the scoped watch-page overflow menu when the description renderer is absent'
    $native = Invoke-YtPageScript $cdp $tab.SessionId $nativeExpression
    Assert ($native.action -eq 'open-transcript' -and $native.phase -eq 'transcript-menu-item-found') `
        'Native fallback recognizes the localized overflow item by its getTranscriptEndpoint command metadata'
    $native = Invoke-YtPageScript $cdp $tab.SessionId $nativeExpression
    Assert ($native.count -eq 2 -and $native.text -ceq 'Native & first. Second caption.') `
        'The overflow-menu path opens and reads the same complete native transcript'
    $null = Invoke-YtPageScript $cdp $tab.SessionId @'
document.querySelector("#native-panel").style.display = "none";
document.querySelector("#native-panel").setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
document.querySelector("#native-menu").hidden = true;
document.querySelector("ytd-watch-metadata").remove();
delete window.nativePlayerResponse.captions;
true
'@
    $native = Invoke-YtPageScript $cdp $tab.SessionId $nativeReadOnly
    Assert ($native.unavailable -and -not $native.text -and $native.phase -eq 'no-captions') 'An expanded video without caption tracks or transcript controls is reported unavailable'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("#native-fixture").remove(); true'
    $longText = ('Complete transcript "quotes" & symbols. ' * 800) + "`n`nSummarize this video."
    Focus-YtComposer $cdp $tab.SessionId -AllowFixture
    $null = Invoke-YtCdp $cdp 'Input.insertText' @{text=$longText} $tab.SessionId
    $state = Wait-FixtureSend $cdp $tab.SessionId $longText
    $normalizedLong = [regex]::Replace($longText, '\s+', ' ').Trim()
    Assert ([regex]::Replace($state.text, '\s+', ' ').Trim() -ceq $normalizedLong -and $state.canSend) 'Full contenteditable input is preserved across fragmented CDP responses'
    $blocked = $false
    try { Focus-YtComposer $cdp $tab.SessionId -AllowFixture } catch { $blocked = $true }
    Assert $blocked 'An existing draft is not overwritten'
    $blocked = $false
    try { Send-YtComposer $cdp $tab.SessionId 'wrong text' -AllowFixture } catch { $blocked = $true }
    Assert $blocked 'Send refuses mismatched text'
    Send-YtComposer $cdp $tab.SessionId $longText -AllowFixture
    $state = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert ($state.messageCount -eq 1 -and [regex]::Replace($state.lastMessage, '\s+', ' ').Trim() -ceq $normalizedLong) 'Submission is observable as the full user message'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("[data-message-author-role=user] button").click()'
    $expanded = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert ($expanded.lastMessage -ceq $state.lastMessage) 'Expanded and collapsed message controls do not affect confirmation'
    $plainText = 'This transcript literally says Show more and Show less.'
    $plainLiteral = ConvertTo-Json -InputObject $plainText -Compress
    $null = Invoke-YtPageScript $cdp $tab.SessionId "document.querySelector('[data-message-author-role=user]').textContent=$plainLiteral"
    $plain = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert ($plain.lastMessage -ceq $plainText) 'Plain messages and literal control-like words are preserved'
    $counts = Invoke-YtPageScript $cdp $tab.SessionId '({sent:window.sendCount,unrelated:window.unrelatedCount})'
    Assert ($counts.sent -eq 1 -and $counts.unrelated -eq 0) 'Only the composer Send button was clicked once'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'window.useTextarea()'
    $text = "Textarea line one`nLine two" + [char]0x05D0 + [char]0x05D1
    Focus-YtComposer $cdp $tab.SessionId -AllowFixture
    $null = Invoke-YtCdp $cdp 'Input.insertText' @{text=$text} $tab.SessionId
    $null = Wait-FixtureSend $cdp $tab.SessionId $text
    Send-YtComposer $cdp $tab.SessionId $text -AllowFixture
    $state = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    $state = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert ($state.messageCount -eq 2 -and $state.lastMessage -ceq $text) 'Textarea, newlines and Unicode are preserved'
    Focus-YtComposer $cdp $tab.SessionId -AllowFixture
    $null = Invoke-YtCdp $cdp 'Input.insertText' @{text='Do not stop'} $tab.SessionId
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("[data-testid=stop-button]").hidden=false'
    $blocked = $false
    try { Send-YtComposer $cdp $tab.SessionId 'Do not stop' -AllowFixture } catch { $blocked = $true }
    Assert $blocked 'An active Stop generating control is never clicked'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'window.addAssistantReply("The message you submitted was too long, please edit it and resubmit.",true)'
    $rejected = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert ($rejected.failureKind -eq 'size' -and $rejected.lastAssistantText -eq '') 'ChatGPT size rejection is not mistaken for an assistant summary'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("[data-message-author-role=assistant]").remove();window.addAssistantReply("You have reached your usage limit. Try again later.",true)'
    $limited = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert ($limited.failureKind -eq 'usage' -and $limited.lastAssistantText -eq '') 'Account usage limits are distinct from text-size rejection'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("[data-message-author-role=assistant]").remove();window.addAssistantReply("The video discusses message limits and how long messages can be.");'
    $answer = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert ($answer.failureKind -eq '' -and $answer.lastAssistantText -like 'The video discusses*' -and $answer.busy) 'Real answer text is preserved while generation remains marked busy'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'document.querySelector("[data-testid=stop-button]").hidden=true'
    $answer = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert (-not $answer.busy -and $answer.assistantMessageCount -eq 1) 'Completed assistant content is readable separately from composer controls'
    $beforeAttachment = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'window.attachFile()'
    $attached = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert ($attached.attachmentCount -eq 1 -and $attached.text -eq '' -and $attached.canSend) 'A very large paste auto-converted into a single attachment chip is detected separately from literal editor text'
    $hugeExpected = ('A huge transcript that Claude auto-attached instead of pasting literally. ' * 200)
    Send-YtComposer $cdp $tab.SessionId $hugeExpected -AllowFixture
    $afterAttachmentSend = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert ($afterAttachmentSend.messageCount -eq $beforeAttachment.messageCount + 1) 'Send proceeds for a single-attachment composer instead of timing out on a literal text mismatch'
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'window.attachFile();window.attachFile()'
    $twoChips = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert ($twoChips.attachmentCount -eq 2) 'Two attachment chips are both counted'
    $blocked = $false
    try { Send-YtComposer $cdp $tab.SessionId 'unrelated expected text' -AllowFixture } catch { $blocked = $true }
    Assert $blocked 'More than one attachment chip never counts as an unambiguous accepted state'
    Clear-YtComposerDraft $cdp $tab.SessionId -AllowFixture
    $cleared = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    Assert ($cleared.attachmentCount -eq 0 -and $cleared.text -eq '') 'Clear-YtComposerDraft removes leftover attachment chips and editor text so a background tab can self-heal'

    # Gemini's composer is not inside a <form>, and the page also carries a "Send feedback"
    # button. The old document-wide "exactly one Send" rule saw two candidates and never
    # clicked, so the prompt was pasted and then silently left unsent.
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'window.useGeminiLayout(); true'
    $geminiText = 'Summarize this Gemini fixture transcript.'
    Focus-YtComposer $cdp $tab.SessionId -ProviderName Gemini -AllowFixture
    $null = Invoke-YtCdp $cdp 'Input.insertText' @{text=$geminiText} $tab.SessionId
    $geminiState = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -ProviderName Gemini -AllowFixture)
    Assert ($geminiState.canSend) 'A nearby Send feedback button no longer makes the Gemini Send control look ambiguous'
    Send-YtComposer $cdp $tab.SessionId $geminiText -ProviderName Gemini -AllowFixture
    $geminiCounts = Invoke-YtPageScript $cdp $tab.SessionId '({sent:window.geminiSendCount,feedback:window.geminiFeedbackCount,trusted:window.geminiSendWasTrusted})'
    Assert ($geminiCounts.sent -eq 1 -and $geminiCounts.feedback -eq 0) 'Gemini Send is clicked exactly once and Send feedback is never clicked'
    Assert ($geminiCounts.trusted) 'Gemini Send receives a trusted browser mouse click rather than a synthetic DOM click'
    $geminiSent = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -ProviderName Gemini -AllowFixture)
    Assert ($geminiSent.messageCount -eq 1 -and $geminiSent.lastMessage -ceq $geminiText) 'The Gemini prompt is observable as a submitted user query'

    # The real Gemini Send button is driven by an Angular value accessor, so text inserted
    # straight into the contenteditable is visible but invisible to the framework: Send stays
    # disabled, the whole wait window is burned, and the prompt is never sent.
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'window.useGeminiFrameworkLayout(); true'
    $frameworkText = 'Part 2/4 of the Gemini fixture transcript.'
    Focus-YtComposer $cdp $tab.SessionId -ProviderName Gemini -AllowFixture
    $null = Invoke-YtCdp $cdp 'Input.insertText' @{text=$frameworkText} $tab.SessionId
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'window.geminiFrameworkNotified = 0; true'
    $beforeNudge = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -ProviderName Gemini -AllowFixture)
    Assert ($beforeNudge.text -ceq $frameworkText -and -not $beforeNudge.canSend) `
        'The reported Gemini failure is reproduced: the text is in place but Send stays disabled'
    Assert (Invoke-YtComposerNudge $cdp $tab.SessionId -ProviderName Gemini -AllowFixture) `
        'Re-announcing the prompt to the framework reports that it had text to announce'
    $afterNudge = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -ProviderName Gemini -AllowFixture)
    Assert ($afterNudge.canSend) 'Re-announcing the prompt enables the Gemini Send button instead of timing out'
    Assert ($afterNudge.text -ceq $frameworkText) 'Re-announcing the prompt does not alter a single character of it'
    Send-YtComposer $cdp $tab.SessionId $frameworkText -ProviderName Gemini -AllowFixture
    $frameworkCounts = Invoke-YtPageScript $cdp $tab.SessionId '({sent:window.geminiSendCount,feedback:window.geminiFeedbackCount,notified:window.geminiFrameworkNotified})'
    Assert ($frameworkCounts.sent -eq 1 -and $frameworkCounts.feedback -eq 0) 'The nudged Gemini prompt is actually sent exactly once'
    Assert ($frameworkCounts.notified -ge 1) 'The framework really observed the re-announced input'
    $nudgeEmpty = Invoke-YtPageScript $cdp $tab.SessionId 'window.useGeminiFrameworkLayout(); true'
    Assert (-not (Invoke-YtComposerNudge $cdp $tab.SessionId -ProviderName Gemini -AllowFixture)) `
        'An empty composer reports nothing to re-announce instead of faking readiness'

    # Observed live on the reporter's own signed-in profile: their Gemini UI is Hebrew, so
    # the real Send button is aria-label "שליחת הודעה" with no .send-button class and no
    # English word anywhere, and it only exists while the composer holds text. Every
    # English-only selector matched zero elements, so every part was pasted and never sent.
    $null = Invoke-YtPageScript $cdp $tab.SessionId 'window.useGeminiHebrewLayout(); true'
    $hebrewText = 'Summarize part 2 of 3 from this Hebrew Gemini fixture.'
    $emptyHebrew = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -ProviderName Gemini -AllowFixture)
    Assert (-not $emptyHebrew.canSend) 'An empty Hebrew Gemini composer renders no Send button at all, exactly as the live page does'
    Focus-YtComposer $cdp $tab.SessionId -ProviderName Gemini -AllowFixture
    $null = Invoke-YtCdp $cdp 'Input.insertText' @{text=$hebrewText} $tab.SessionId
    $hebrewState = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -ProviderName Gemini -AllowFixture)
    Assert ($hebrewState.canSend) 'A Hebrew-labelled Gemini Send button is found through its language-independent icon name'
    Send-YtComposer $cdp $tab.SessionId $hebrewText -ProviderName Gemini -AllowFixture
    $hebrewCounts = Invoke-YtPageScript $cdp $tab.SessionId '({sent:window.geminiSendCount,mic:window.geminiMicCount,plus:window.geminiPlusCount})'
    Assert ($hebrewCounts.sent -eq 1) 'The Hebrew Gemini prompt is actually sent exactly once instead of sitting unsent in the composer'
    Assert ($hebrewCounts.mic -eq 0 -and $hebrewCounts.plus -eq 0) 'The unlabelled Hebrew microphone and upload icon buttons are never clicked as a stand-in for Send'
    $hebrewSent = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -ProviderName Gemini -AllowFixture)
    Assert ($hebrewSent.lastMessage -ceq $hebrewText) 'The Hebrew Gemini prompt is observable as a submitted user query'
    $ui = New-YtBrowserTab $cdp "$($server.Origin)/#token=$token"
    Start-Sleep -Milliseconds 700
    $uiState = Invoke-YtPageScript $cdp $ui.SessionId '({hash:location.hash,code:document.getElementById("bookmark").getAttribute("href"),state:document.getElementById("state").textContent})'
    Assert ($uiState.hash -eq '' -and $uiState.code.StartsWith('javascript:')) 'Setup page generates a bookmark and removes the token fragment'
    Assert ($uiState.state -eq 'Ready') 'Dashboard can authenticate and render concurrent controller status'
    $detail = Invoke-YtPageScript $cdp $ui.SessionId '(() => {const select=document.getElementById("summary-level");select.focus();return {value:select.value,options:[...select.options].map(option=>option.value).join(","),focused:document.activeElement===select,disabled:select.disabled}})()'
    Assert ($detail.value -eq 'ultra' -and $detail.options -eq 'ultra,max,reg,min,micro,full' -and $detail.focused -and -not $detail.disabled) 'The real dashboard exposes six accessible levels with Ultra selected'
    $language = Invoke-YtPageScript $cdp $ui.SessionId '(() => {const select=document.getElementById("summary-language");return {value:select.value,options:[...select.options].map(option=>option.value).join(","),disabled:select.disabled}})()'
    Assert ($language.value -eq 'hebrew' -and $language.options -eq 'hebrew' -and $language.disabled) 'The real dashboard exposes Hebrew as the only normal-summary language'
    $null = Invoke-YtPageScript $cdp $ui.SessionId '(() => {const select=document.getElementById("summary-level");select.value="micro";select.dispatchEvent(new Event("change",{bubbles:true}));return true})()'
    Start-Sleep -Milliseconds 700
    $detail = Invoke-YtPageScript $cdp $ui.SessionId '({disabled:document.getElementById("summary-level").disabled,description:document.getElementById("summary-level-description").textContent,status:document.getElementById("summary-level-status").textContent})'
    Assert ($server.DefaultSummaryLevel -eq 'micro' -and -not $detail.disabled -and $detail.description -like '*Only the conclusion*') 'Changing the real selector saves the level through the authenticated local API'
    Assert ($server.GetJob($job.Id).SummaryLevel -eq 'ultra') 'Changing the dashboard default does not rewrite an existing job'
    $newRequest = [guid]::NewGuid().ToString()
    $ui2 = New-YtBrowserTab $cdp "$($server.Origin)/#token=$token&video=JZn5RLXQFtg&request=$newRequest"
    Start-Sleep -Milliseconds 700
    $allJobs = (Http GET '/api/status' '' $auth).Body | ConvertFrom-Json
    $queued = @($allJobs.jobs | Where-Object { $_.RequestId -eq $newRequest })
    Assert ($queued.Count -eq 1) 'The browser launch page hands off its own job automatically'
    Assert ($queued[0].SummaryLevel -eq 'micro') 'The unchanged browser bookmark uses the newly saved summary level'
    $batchState = Invoke-YtPageScript $cdp $ui.SessionId '(() => {document.getElementById("batch").value="abcdefghijk\n12345678901";document.getElementById("add-batch").click();return true})()'
    Start-Sleep -Milliseconds 800
    $batchResult = Invoke-YtPageScript $cdp $ui.SessionId 'document.getElementById("batch-result").textContent'
    Assert ($batchResult -like '2 request(s) accepted.*') 'Batch entry accepts multiple independent videos'
    $allJobs = (Http GET '/api/status' '' $auth).Body | ConvertFrom-Json
    $batchJobs = @($allJobs.jobs | Where-Object { $_.VideoId -in @('abcdefghijk','12345678901') })
    Assert ($batchJobs.Count -eq 2 -and @($batchJobs | Where-Object SummaryLevel -ne 'micro').Count -eq 0) 'Real batch submissions snapshot the selected summary level'
    $null = Invoke-YtCdp $cdp 'Emulation.setDeviceMetricsOverride' @{width=360;height=800;deviceScaleFactor=1;mobile=$false} $ui.SessionId
    $layout = Invoke-YtPageScript $cdp $ui.SessionId '({width:innerWidth,content:document.documentElement.scrollWidth})'
    Assert ($layout.content -le $layout.width) 'Summary controls and job labels fit a narrow dashboard without horizontal overflow'
    $targets = Invoke-YtCdp $cdp 'Target.getTargets'
    foreach ($page in @($targets.targetInfos | Where-Object {$_.type -eq 'page' -and $_.targetId -ne $tab.TargetId})) {
        $null = Invoke-YtCdp $cdp 'Target.closeTarget' @{targetId=$page.targetId}
    }
    $null = Invoke-YtCdp $cdp 'Page.navigate' @{url=($fixture.AbsoluteUri + '?stage=next')} $tab.SessionId
    Start-Sleep -Milliseconds 800
    $fresh = Invoke-YtPageScript $cdp $tab.SessionId (Get-YtComposerExpression -AllowFixture)
    $remaining = Invoke-YtCdp $cdp 'Target.getTargets'
    Assert ($fresh.kind -eq 'ready' -and $fresh.messageCount -eq 0 -and $fresh.text -eq '' -and
        @($remaining.targetInfos | Where-Object {$_.type -eq 'page'}).Count -eq 1) 'Navigating the only remaining tab keeps Chrome open and starts with a fresh message context'
    Assert ((Http POST '/api/stop' '{}' $auth).Status -eq 200 -and $server.StopRequested) 'Authenticated stop is supported'
    Write-Output "ALL $count assertions passed."
} finally {
    if ($null -ne $server) { $server.Dispose() }
    if ($null -ne $cdp) {
        try { $null = Invoke-YtCdp $cdp 'Browser.close' @{} -TimeoutSeconds 3 }
        catch { Write-Warning $_.Exception.Message }
        $cdp.Socket.Dispose()
    }
}
