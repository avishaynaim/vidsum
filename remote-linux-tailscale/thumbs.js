'use strict';
// remote-linux-tailscale/thumbs.js
//
// Pictures for the dashboard: a video's channel avatar, and the avatar/cover of a saved
// channel or playlist. A video's own thumbnail needs no lookup (i.ytimg.com/vi/<id>/...), but
// avatars only appear in YouTube's pages, so each one is looked up once (oEmbed gives a
// video's channel, the channel/playlist page's og:image gives the picture) and remembered in
// thumbs.json in the state directory. GET /thumb/... answers with a redirect to the image.

const fs = require('fs');
const path = require('path');

const FAIL_RETRY_MS = 10 * 60 * 1000; // a failed lookup is tried again after this long (the LTE link drops often)

function decode(s) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Two tries: on this box's LTE link a single YouTube request times out now and then.
async function fetchText(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' },
        signal: AbortSignal.timeout(20000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (attempt >= 2) throw err;
    }
  }
}

// The og:image of a YouTube channel or playlist page. Channel avatars are asked for at 176px.
async function pageImage(url) {
  const html = await fetchText(url);
  const m = /<meta property="og:image" content="([^"]+)"/.exec(html);
  if (!m) throw new Error('no og:image');
  return decode(m[1]).replace(/=s\d+-c-k/, '=s176-c-k');
}

async function videoChannel(videoId) {
  const info = JSON.parse(await fetchText(
    `https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`));
  if (!info.author_url) throw new Error('no channel');
  return { url: info.author_url, name: info.author_name || '' };
}

function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && ['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(u.hostname);
  } catch { return false; }
}

class Thumbs {
  constructor(dir) {
    this.file = path.join(dir, 'thumbs.json');
    try { this.cache = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.cache = {}; }
    this.inflight = new Map();
  }

  save() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.cache));
    fs.renameSync(tmp, this.file);
  }

  // Cached lookup: one network round per key, failures remembered for FAIL_RETRY_MS.
  async lookup(key, fn) {
    const hit = this.cache[key];
    if (hit && (hit.value || Date.now() - hit.at < FAIL_RETRY_MS)) return hit.value || null;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = fn().then((value) => value, () => null).then((value) => {
      this.cache[key] = { value, at: Date.now() };
      this.save();
      this.inflight.delete(key);
      return value;
    });
    this.inflight.set(key, p);
    return p;
  }

  // Avatar image URL of a channel or cover image of a playlist page.
  listImage(url) {
    if (!isYouTubeUrl(url)) return Promise.resolve(null);
    // A channel's tab (/@x/videos) shows the same avatar as the channel itself.
    const page = url.replace(/\/(videos|streams|shorts)\/?$/, '');
    return this.lookup(`page:${page}`, () => pageImage(page));
  }

  async videoChannelImage(videoId) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId || '')) return null;
    const channel = await this.lookup(`video:${videoId}`, () => videoChannel(videoId));
    return channel ? this.listImage(channel.url) : null;
  }
}

// Handles GET /thumb/channel?video=ID and GET /thumb/list?url=URL. Returns true if handled.
async function handleThumb(thumbs, url, res) {
  let image = null;
  if (url.pathname === '/thumb/channel') image = await thumbs.videoChannelImage(url.searchParams.get('video'));
  else if (url.pathname === '/thumb/list') image = await thumbs.listImage(url.searchParams.get('url') || '');
  else return false;
  if (image) {
    res.writeHead(302, { Location: image, 'Cache-Control': 'private, max-age=86400' });
  } else {
    res.writeHead(404, { 'Cache-Control': 'private, max-age=3600' });
  }
  res.end();
  return true;
}

module.exports = { Thumbs, handleThumb };
