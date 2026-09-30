'use strict';
// Fetches a YouTube video's own caption track directly over the network (no CDP / browser
// needed for this part - YouTube's public watch page and /api/timedtext endpoint are plain
// HTTPS). This mirrors the intent of Get-YtYouTubeCaptionTrackExpression in YtSummary.psm1
// (same track-selection preference and json3-then-XML fallback), but implemented as a
// direct Node fetch instead of in-page JS, since Termux's Node already has full network
// access and does not need a browser tab merely to download caption text.
//
// UNVERIFIED: written without network access in the authoring sandbox. YouTube's watch-page
// markup and undocumented internal JSON shape change over time and by region/consent state;
// this WILL need live debugging (e.g. logging the raw watch-page HTML) if it fails to find
// `ytInitialPlayerResponse` or caption tracks for a given video/account.

const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

function assertValidVideoId(videoId) {
  if (!VIDEO_ID_PATTERN.test(videoId)) throw new Error(`Invalid YouTube video id: ${videoId}`);
}

async function fetchText(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
  return res.text();
}

function extractPlayerResponse(html) {
  // ytInitialPlayerResponse is assigned as `var ytInitialPlayerResponse = {...};` in a
  // <script> tag. Find the balanced JSON object rather than relying on a single greedy
  // regex, since the object itself may contain the literal substring "};".
  const marker = 'ytInitialPlayerResponse = ';
  const start = html.indexOf(marker);
  if (start < 0) throw new Error('ytInitialPlayerResponse not found on watch page (markup may have changed, or consent/sign-in interstitial was served instead).');
  const jsonStart = start + marker.length;
  let depth = 0;
  let inString = false;
  let escapeNext = false;
  for (let i = jsonStart; i < html.length; i++) {
    const ch = html[i];
    if (escapeNext) { escapeNext = false; continue; }
    if (ch === '\\') { escapeNext = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const jsonText = html.slice(jsonStart, i + 1);
        return JSON.parse(jsonText);
      }
    }
  }
  throw new Error('Could not find the end of ytInitialPlayerResponse JSON (unbalanced braces).');
}

function selectTrack(tracks) {
  return (
    tracks.find((t) => t && t.baseUrl && String(t.languageCode || '').toLowerCase() === 'en') ||
    tracks.find((t) => t && t.baseUrl && !t.kind) ||
    tracks.find((t) => t && t.baseUrl) ||
    null
  );
}

function parseJson3(body) {
  if (!body || !body.trim()) throw new Error('empty json3 caption body');
  const parsed = JSON.parse(body);
  const lines = [];
  for (const event of parsed.events || []) {
    if (event.aAppend || !Array.isArray(event.segs)) continue;
    const line = event.segs.map((seg) => seg.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (line) lines.push(line);
  }
  if (!lines.length) throw new Error('json3 contained no text');
  return lines;
}

function decodeXmlEntities(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseXmlCaptions(body) {
  const cues = body && body.trim() ? body.match(/<(p|text)\b[^>]*>[\s\S]*?<\/\1>/g) || [] : [];
  const lines = cues
    .map((cue) => decodeXmlEntities(cue.replace(/^<(?:p|text)\b[^>]*>/, '').replace(/<\/(?:p|text)>$/, '')).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  if (!lines.length) throw new Error('XML caption body was empty or malformed');
  return lines;
}

async function readTrack(track) {
  const base = new URL(track.baseUrl);
  const jsonUrl = new URL(base.href);
  jsonUrl.searchParams.set('fmt', 'json3');
  try {
    const jsonBody = await fetchText(jsonUrl.href);
    return parseJson3(jsonBody);
  } catch (jsonError) {
    const xmlUrl = new URL(base.href);
    xmlUrl.searchParams.set('fmt', 'srv3');
    const xmlBody = await fetchText(xmlUrl.href);
    return parseXmlCaptions(xmlBody);
  }
}

/**
 * Fetches the transcript text and best-effort title for a public YouTube video.
 * Returns { text, title }. Throws with a descriptive message on failure - callers should
 * treat any thrown error here as a (probably) non-retryable "no transcript available"
 * condition unless it's a network-level error (fetch throwing TypeError / timeout).
 */
async function fetchTranscript(videoId) {
  assertValidVideoId(videoId);
  const html = await fetchText(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: {
      // A plain server-side fetch without a browser UA is more likely to get an
      // unexpected consent/interstitial page from YouTube; a common desktop UA reduces
      // (but does not eliminate) that risk. This is a best-effort heuristic.
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'accept-language': 'en-US,en;q=0.9',
    },
  });
  const player = extractPlayerResponse(html);
  if (player?.videoDetails?.videoId !== videoId) {
    throw new Error('YouTube returned a player response for a different video (unexpected).');
  }
  if (player?.playabilityStatus?.status !== 'OK') {
    const reason = player?.playabilityStatus?.reason || player?.playabilityStatus?.status || 'unknown';
    throw new Error(`Video is not playable/available: ${reason}`);
  }
  const title = player?.videoDetails?.title || videoId;
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) throw new Error('No caption tracks are available for this video.');
  const track = selectTrack(tracks);
  if (!track) throw new Error('No usable caption track baseUrl was found.');
  const lines = await readTrack(track);
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Caption track produced no text after parsing.');
  return { text, title };
}

module.exports = { fetchTranscript, assertValidVideoId };
