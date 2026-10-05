'use strict';
// remote-linux-tailscale/widget.js
//
// The Android home-screen widget (../android-widget): a few counts, pushed to the phone the
// moment they change.
//
//   GET  /api/widget            -> the counts (widget key: X-Widget-Key header or ?key=)
//   POST /api/widget/register   -> { endpoint } the phone's UnifiedPush endpoint (widget key)
//   GET  /api/widget/setup      -> { key } for the dashboard's "Connect" link (full dashboard key)
//
// The widget key is derived from the dashboard key but only reads counts: a lost phone cannot
// control anything with it. Pushes go through ntfy.sh (UnifiedPush; the phone runs the ntfy app
// as its distributor). ntfy.sh allows 250 messages a day per sender, so a change is pushed at
// once only if the last push is MIN_GAP_MS old; otherwise it waits for the gap (latest counts win).

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const TERMINAL = ['submitted', 'completed', 'error', 'needs-review', 'reviewed', 'cancelled'];
const MIN_GAP_MS = 60 * 1000;
const BACKOFF_MS = 10 * 60 * 1000; // after ntfy says "too many requests"
const MAX_ENDPOINTS = 5;
const PUSH_HOSTS = (process.env.YT_WIDGET_PUSH_HOSTS || 'ntfy.sh').split(',').map((h) => h.trim()).filter(Boolean);

function widgetKey(token) {
  return token ? crypto.createHash('sha256').update(`yt-summary-widget:${token}`).digest('hex').slice(0, 40) : null;
}

function sameKey(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

const isToday = (iso, now = new Date()) => {
  if (!iso) return false;
  const day = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Jerusalem' });
  return day(new Date(iso)) === day(now);
};

// The numbers on the widget. `paused` names why nothing runs, when that is the case.
function widgetCounts(jobs, { paused = false } = {}) {
  const queued = jobs.filter((j) => j.State === 'queued' && !j.WatchLater).length;
  const running = jobs.filter((j) => !TERMINAL.includes(j.State) && j.State !== 'queued').length;
  const completed = jobs.filter((j) => j.State === 'completed');
  return {
    running,
    queued,
    unread: completed.filter((j) => !j.ReadAt).length,
    doneToday: completed.filter((j) => isToday(j.UpdatedAt) || isToday(j.ReadAt)).length,
    failed: jobs.filter((j) => j.State === 'error' || j.State === 'needs-review').length,
    paused: !!paused,
  };
}

class WidgetPush {
  constructor({ stateDir, getCounts, post = defaultPost, log = () => {}, now = () => Date.now() }) {
    this.file = path.join(stateDir, 'widget-push.json');
    this.getCounts = getCounts;
    this.post = post;
    this.log = log;
    this.now = now;
    this.endpoints = [];
    try { this.endpoints = JSON.parse(fs.readFileSync(this.file, 'utf8')).endpoints || []; } catch { /* none yet */ }
    this.lastSent = null; // JSON of the counts last pushed
    this.lastSentAt = 0;
    this.blockedUntil = 0;
    this.sending = false;
  }

  register(endpoint) {
    let url;
    try { url = new URL(String(endpoint)); } catch { throw Object.assign(new Error('endpoint must be a URL.'), { status: 400 }); }
    if (url.protocol !== 'https:' || !PUSH_HOSTS.includes(url.hostname)) {
      throw Object.assign(new Error(`endpoint must be an https URL on ${PUSH_HOSTS.join(', ')}.`), { status: 400 });
    }
    const href = url.href;
    this.endpoints = [href, ...this.endpoints.filter((e) => e !== href)].slice(0, MAX_ENDPOINTS);
    this.save();
    this.lastSent = null; // the new phone gets the current counts on the next tick
    this.lastSentAt = 0;
    return { registered: true, endpoints: this.endpoints.length };
  }

  save() {
    fs.writeFileSync(this.file, JSON.stringify({ endpoints: this.endpoints }));
  }

  // Called every few seconds; pushes when the counts changed and the gap allows it.
  async tick() {
    if (this.sending || !this.endpoints.length) return;
    const t = this.now();
    if (t < this.blockedUntil || t - this.lastSentAt < MIN_GAP_MS) return;
    const counts = JSON.stringify(this.getCounts());
    if (counts === this.lastSent) return;
    this.sending = true;
    try {
      const body = JSON.stringify({ ...JSON.parse(counts), at: new Date(t).toISOString() });
      for (const endpoint of [...this.endpoints]) {
        let status;
        try { status = await this.post(endpoint, body); } catch (err) { this.log(`Widget push failed: ${err.message}`); continue; }
        if (status === 404 || status === 410) { // the phone unregistered (app removed / reinstalled)
          this.endpoints = this.endpoints.filter((e) => e !== endpoint);
          this.save();
        } else if (status === 429) {
          this.blockedUntil = t + BACKOFF_MS;
          this.log('Widget push: ntfy.sh rate limit reached; pausing pushes for 10 minutes.');
        }
      }
      this.lastSent = counts;
      this.lastSentAt = t;
    } finally {
      this.sending = false;
    }
  }
}

async function defaultPost(endpoint, body) {
  const res = await fetch(endpoint, { method: 'POST', body, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(15000) });
  return res.status;
}

module.exports = { widgetKey, sameKey, widgetCounts, WidgetPush, MIN_GAP_MS };
