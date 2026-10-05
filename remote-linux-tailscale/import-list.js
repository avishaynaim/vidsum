'use strict';
// remote-linux-tailscale/import-list.js
//
// Turns a YouTube playlist or channel link into its videos, for the dashboard's "Add a
// playlist or channel": a playlist gives all its videos (up to MAX_PLAYLIST), a channel gives
// its latest N uploads from the Videos tab. Listing uses yt-dlp's flat mode (one request, no
// per-video lookups), the same tool transcript.js already relies on.

const MAX_PLAYLIST = 200;
const YOUTUBE_HOSTS = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'];
const CHANNEL_PATH = /^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)(\/[^/]*)?\/?$/;
const CHANNEL_TABS = ['videos', 'streams', 'shorts'];

// Classifies a link: { kind: 'playlist' | 'channel', url } (url = what yt-dlp should list).
function normalizeListUrl(input) {
  let url;
  try { url = new URL(String(input || '').trim()); } catch { url = null; }
  if (!url || !YOUTUBE_HOSTS.includes(url.hostname)) {
    throw Object.assign(new Error('Paste a YouTube playlist or channel link.'), { status: 400 });
  }
  const list = url.searchParams.get('list');
  if (list && /^[A-Za-z0-9_-]+$/.test(list)) {
    return { kind: 'playlist', url: `https://www.youtube.com/playlist?list=${list}` };
  }
  const m = CHANNEL_PATH.exec(url.pathname);
  if (m) {
    const tab = m[2] ? m[2].slice(1) : '';
    return { kind: 'channel', url: `https://www.youtube.com/${m[1]}/${CHANNEL_TABS.includes(tab) ? tab : 'videos'}` };
  }
  throw Object.assign(new Error('That link is not a playlist or a channel. Use "Add videos" above for single videos.'), { status: 400 });
}

// Lists { videoId, title, durationSeconds } for a playlist/channel link.
// deps.runYtDlp(args) -> stdout (injectable for tests).
async function listVideos(input, { limit = 1 } = {}, deps = {}) {
  const target = normalizeListUrl(input);
  // A channel takes any number of latest videos (the queue's own 200-unfinished cap still applies).
  const max = target.kind === 'channel' ? Math.max(1, Math.floor(Number(limit)) || 1) : MAX_PLAYLIST;
  let runYtDlp = deps.runYtDlp;
  if (!runYtDlp) {
    const transcript = require('./transcript');
    const bin = transcript.findYtDlp();
    if (!bin) throw Object.assign(new Error('yt-dlp is not installed on the server.'), { status: 503 });
    runYtDlp = (args) => transcript.runYtDlp(bin, args);
  }
  // Ask for extra entries: upcoming premieres/live streams at the top of a channel are skipped
  // below and must not eat into the requested count.
  const fetchCount = target.kind === 'channel' ? max + 20 : max;
  const info = JSON.parse(await runYtDlp(['--no-warnings', '--flat-playlist', '-J', '--playlist-end', String(fetchCount), target.url]));
  const seen = new Set();
  const videos = [];
  for (const entry of info.entries || []) {
    const videoId = entry && entry.id;
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '') || seen.has(videoId)) continue;
    // A premiere or live stream that has not happened yet has no captions to summarize.
    if (['is_upcoming', 'is_live'].includes(entry.live_status)) continue;
    seen.add(videoId);
    videos.push({
      videoId,
      title: String(entry.title || '').trim().slice(0, 300),
      durationSeconds: Math.round(Number(entry.duration) || 0),
    });
    if (videos.length >= max) break;
  }
  // yt-dlp names a channel's tab list "<channel> - Videos"; keep just the channel name.
  const title = String(info.title || '').trim().replace(/\s+-\s+(Videos|Streams|Shorts|Live)$/i, '');
  return { kind: target.kind, url: target.url, title, videos, channelId: /^UC[\w-]{22}$/.test(info.channel_id || '') ? info.channel_id : null };
}

// A channel's RSS feed: its latest 15 videos with the ORIGINAL titles (the yt-dlp listing returns
// YouTube's auto-translated ones), the publish date and the view count. id -> { title, publishedAt, views }.
async function channelFeed(channelId, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`,
    { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`feed answered ${res.status}`);
  const xml = await res.text();
  const decode = (t) => t.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const feed = new Map();
  for (const [, entry] of xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)) {
    const id = (/<yt:videoId>([\w-]{11})</.exec(entry) || [])[1];
    if (!id) continue;
    feed.set(id, {
      title: decode((/<title>([\s\S]*?)<\/title>/.exec(entry) || [])[1] || '').trim(),
      publishedAt: (/<published>([^<]+)</.exec(entry) || [])[1] || null,
      views: Number((/views="(\d+)"/.exec(entry) || [])[1]) || null,
    });
  }
  return feed;
}

module.exports = { channelFeed, normalizeListUrl, listVideos, MAX_PLAYLIST };
