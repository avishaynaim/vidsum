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

const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

// --- yt-dlp source (preferred) ---------------------------------------------------------
// YouTube now serves empty caption bodies to plain timedtext fetches (they need a player
// proof-of-origin token). yt-dlp keeps up with that, so it is tried first; the direct fetch
// below remains as the fallback when yt-dlp is not installed.

function findYtDlp(deps = {}) {
  const exists = deps.exists || fs.existsSync;
  const candidates = [
    process.env.YTDLP_BIN,
    // systemd user services do not have ~/.local/bin on PATH, so check it explicitly.
    path.join(os.homedir(), '.local', 'bin', 'yt-dlp'),
    '/usr/local/bin/yt-dlp',
    '/usr/bin/yt-dlp',
  ].filter(Boolean);
  return candidates.find((c) => exists(c)) || null;
}

function runYtDlp(bin, args) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      if (err) {
        const lastError = String(stderr).split('\n').filter((l) => l.startsWith('ERROR')).pop();
        // Killed by our timeout (no ERROR line): say so instead of a bare "Command failed".
        const reason = err.killed ? 'YouTube did not answer within 2 minutes' : (lastError || err.message);
        reject(new Error(`yt-dlp failed: ${reason}`));
      } else resolve(stdout);
    });
  });
}

// Picks the caption track to download from yt-dlp's metadata: creator-made captions in the
// video's language first, then the auto-generated original-language track, then anything.
// Returns { lang, auto } or null.
function chooseYtDlpTrack(info) {
  const manual = Object.keys(info.subtitles || {}).filter((k) => k !== 'live_chat');
  // YouTube lists every language as an automatic track, but all except the "-orig" one (and its
  // plain twin, "en" for "en-orig") are machine translations of it. Those are refused with
  // HTTP 429 almost every time, which looked like a rate limit on this server, so they are
  // never picked.
  const allAuto = Object.keys(info.automatic_captions || {});
  const origBases = new Set(allAuto.filter((k) => k.endsWith('-orig')).map((k) => k.slice(0, -5)));
  const auto = origBases.size ? allAuto.filter((k) => k.endsWith('-orig') || origBases.has(k)) : allAuto;
  const videoLang = String(info.language || '').toLowerCase();
  const sameLang = (k) => videoLang && (k.toLowerCase() === videoLang || k.toLowerCase().startsWith(`${videoLang}-`));
  // Hebrew first (YouTube calls it "iw"): creator-made, then auto-generated original. The
  // summary is always written in Hebrew anyway (chunk.js), so this is the best source.
  const isHebrew = (k) => /^(iw|he)(-|$)/i.test(k);
  const hebrewManual = manual.find(isHebrew);
  if (hebrewManual) return { lang: hebrewManual, auto: false };
  const hebrewOrig = auto.find((k) => isHebrew(k) && k.endsWith('-orig'));
  if (hebrewOrig) return { lang: hebrewOrig, auto: true };

  const pick = manual.find(sameLang) || null;
  if (pick) return { lang: pick, auto: false };
  // Several "-orig" tracks can be listed (e.g. en-US-orig on a Hebrew video); the one in the
  // video's own language is the real original.
  const orig = auto.find((k) => k.endsWith('-orig') && sameLang(k)) || (videoLang ? null : auto.find((k) => k.endsWith('-orig')));
  if (orig) return { lang: orig, auto: true };
  const autoSame = auto.find(sameLang);
  if (autoSame) return { lang: autoSame, auto: true };
  if (manual.length) return { lang: manual.find((k) => k.startsWith('en')) || manual[0], auto: false };
  const anyOrig = auto.find((k) => k.endsWith('-orig'));
  if (anyOrig) return { lang: anyOrig, auto: true };
  if (auto.length) return { lang: auto.find((k) => k === 'en') || auto[0], auto: true };
  return null;
}

async function fetchTranscriptWithYtDlp(videoId, bin) {
  const url = `https://www.youtube.com/watch?v=${videoId}`;
  const common = ['--no-warnings', '--no-playlist', '--js-runtimes', `node:${process.execPath}`];
  const info = JSON.parse(await runYtDlp(bin, [...common, '--skip-download', '-J', url]));
  const track = chooseYtDlpTrack(info);
  if (!track) throw new Error('No caption tracks are available for this video.');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-summary-subs-'));
  try {
    await runYtDlp(bin, [...common, '--skip-download', track.auto ? '--write-auto-subs' : '--write-subs',
      '--sub-langs', track.lang, '--sub-format', 'json3', '-o', path.join(dir, '%(id)s'), url]);
    const file = fs.readdirSync(dir).find((f) => f.endsWith('.json3'));
    if (!file) throw new Error(`yt-dlp did not produce the ${track.lang} caption file.`);
    const lines = parseJson3(fs.readFileSync(path.join(dir, file), 'utf8'));
    const text = lines.join(' ').replace(/\s+/g, ' ').trim();
    if (!text) throw new Error('Caption track produced no text after parsing.');
    return { text, title: info.title || videoId, durationSeconds: Math.round(Number(info.duration) || 0),
      language: track.lang, videoLanguage: String(info.language || '') };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// --- pacing, rate limits and the audio fallback ----------------------------------------
// YouTube blocks this server's IP (HTTP 429) after a burst of caption downloads, e.g. several
// videos starting together after a restart, and the block lasts well over 10 minutes. So
// caption fetches run one at a time with a gap between them, and a block is reported as
// `rateLimited` (retry much later) instead of looking like "no captions".
const CAPTION_GAP_MS = Number(process.env.YT_CAPTION_GAP_MS) || 15000;
let captionQueue = Promise.resolve();
let lastCaptionStart = 0;

function paced(fn) {
  const run = captionQueue.then(async () => {
    const wait = lastCaptionStart + CAPTION_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCaptionStart = Date.now();
    return fn();
  });
  captionQueue = run.catch(() => {});
  return run;
}

const RATE_LIMITED = /\b429\b|Too Many Requests|RequestBlocked|confirm you.re not a bot/i;
const NO_CAPTIONS = /No caption tracks are available/;

// Videos with no captions at all (YouTube never auto-captioned them) are transcribed from
// their audio by ~/apps/yt-transcript (NotebookLM). One at a time: it downloads ~20 MB per
// hour of video and takes minutes.
function findYtTranscript(deps = {}) {
  const exists = deps.exists || fs.existsSync;
  return [process.env.YT_TRANSCRIPT_BIN, path.join(os.homedir(), 'apps', 'yt-transcript', '.venv', 'bin', 'yt-transcript')]
    .filter(Boolean).find((c) => exists(c)) || null;
}

let audioQueue = Promise.resolve();

function transcribeAudio(videoId, bin, signal = null) {
  const run = audioQueue.then(() => new Promise((resolve, reject) => {
    execFile(bin, ['--json', '-q', '--retry-failed', '--lang', 'iw', '--lang', 'he', videoId],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90 * 60 * 1000, ...(signal ? { signal } : {}) }, (err, stdout, stderr) => {
        if (signal && signal.aborted) return reject(Object.assign(new Error('Stopped.'), { stopped: true }));
        let out = null;
        try { out = JSON.parse(stdout); } catch { /* reported below */ }
        const t = out && out.transcripts && out.transcripts[0];
        if (t && t.text) return resolve({ text: t.text, title: t.title || videoId, durationSeconds: 0 });
        const why = (out && out.failures && out.failures[0] && out.failures[0].error)
          || String(stderr).trim().split('\n').pop() || (err && err.message) || 'no text';
        reject(new Error(`audio transcription failed: ${why}`));
      });
  }));
  audioQueue = run.catch(() => {});
  return run;
}

/**
 * Fetches the transcript text and best-effort title for a public YouTube video: captions via
 * yt-dlp (else the direct watch-page method below); for a video with no captions at all, a
 * NotebookLM transcription of its audio, then (options.whisper) local Whisper as a last resort.
 * Errors carry `rateLimited` (YouTube block: retry much later), `noCaptions` (confirmed: no
 * captions exist, so a retry can skip that check: options.noCaptionsConfirmed) and
 * `whisperBusy` (Whisper is busy with another video: wait in the queue, not a failure).
 */
async function fetchTranscript(videoId, { onStatus = () => {}, whisper = false, noCaptionsConfirmed = false, signal = null } = {}) {
  assertValidVideoId(videoId);
  if (!noCaptionsConfirmed) {
    let captionError;
    try {
      const captions = await paced(() => fetchCaptions(videoId));
      // A Hebrew lecture whose only captions are in another language (YouTube sometimes
      // auto-captions Hebrew speech as English): a real Hebrew transcript from the audio is
      // better; the foreign captions are kept in case that fails (the summary is Hebrew anyway).
      const hebrew = (lang) => /^(iw|he)(-|$)/i.test(lang || '');
      const audioBin = hebrew(captions.videoLanguage) && captions.language && !hebrew(captions.language) && findYtTranscript();
      if (!audioBin) return captions;
      onStatus(`No Hebrew captions (only ${captions.language}); transcribing the Hebrew audio instead (takes a few minutes)...`);
      try {
        return await transcribeAudio(videoId, audioBin, signal);
      } catch (err) {
        onStatus(`Audio transcription failed (${err.message}); using the ${captions.language} captions instead.`);
        return captions;
      }
    } catch (err) {
      captionError = err;
    }
    if (RATE_LIMITED.test(captionError.message)) {
      throw Object.assign(new Error(`YouTube is rate-limiting this server right now (${captionError.message})`), { rateLimited: true });
    }
    if (!NO_CAPTIONS.test(captionError.message)) throw captionError;
  }
  const noCaptions = (err, extra = {}) => Object.assign(err, { noCaptions: true }, extra);
  const failures = [];
  const bin = findYtTranscript();
  if (bin) {
    onStatus('This video has no captions on YouTube; transcribing its audio instead (takes a few minutes)...');
    try {
      return await transcribeAudio(videoId, bin, signal);
    } catch (err) {
      failures.push(err.message);
      if (!whisper && RATE_LIMITED.test(err.message)) {
        throw noCaptions(new Error(`This video has no captions on YouTube, and ${err.message}`), { rateLimited: true });
      }
    }
  }
  if (whisper) {
    const { transcribeWithWhisper } = require('./whisper');
    try {
      return await transcribeWithWhisper(videoId, { onStatus, findYtDlp, signal });
    } catch (err) {
      if (err.stopped) throw err;
      if (err.whisperBusy) throw noCaptions(err);
      failures.push(`Whisper failed: ${err.message}`);
    }
  }
  throw noCaptions(new Error(`This video has no captions on YouTube${failures.length ? `, and ${failures.join('; ')}` : ''}.`));
}

async function fetchCaptions(videoId) {
  const bin = findYtDlp();
  if (!bin) return fetchTranscriptDirect(videoId);
  try {
    return await fetchTranscriptWithYtDlp(videoId, bin);
  } catch (ytDlpError) {
    try {
      return await fetchTranscriptDirect(videoId);
    } catch (directError) {
      throw new Error(`${ytDlpError.message} (direct fallback also failed: ${directError.message})`);
    }
  }
}

/**
 * Fetches the transcript text and best-effort title for a public YouTube video.
 * Returns { text, title }. Throws with a descriptive message on failure - callers should
 * treat any thrown error here as a (probably) non-retryable "no transcript available"
 * condition unless it's a network-level error (fetch throwing TypeError / timeout).
 */
async function fetchTranscriptDirect(videoId) {
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
  const durationSeconds = Number(player?.videoDetails?.lengthSeconds) || 0;
  const tracks = player?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) throw new Error('No caption tracks are available for this video.');
  const track = selectTrack(tracks);
  if (!track) throw new Error('No usable caption track baseUrl was found.');
  const lines = await readTrack(track);
  const text = lines.join(' ').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('Caption track produced no text after parsing.');
  return { text, title, durationSeconds };
}

module.exports = { fetchTranscript, fetchTranscriptDirect, assertValidVideoId, chooseYtDlpTrack, findYtDlp, runYtDlp, findYtTranscript, RATE_LIMITED };
