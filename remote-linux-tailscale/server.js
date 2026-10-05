'use strict';
// remote-linux-tailscale/server.js
//
// Minimal authenticated HTTP endpoint so an Android phone (reached over Tailscale, not the
// same Wi-Fi/LAN) can queue and check on video summaries running on this Linux box, without
// needing shell/SSH access to it. This is the missing piece that turns the already-built
// `cli.js` pipeline (transcript -> chunk/rotate -> merge, atomic checkpoints, provider
// rotation) into something usable purely from a phone browser.
//
// This is an OPTIONAL second way to run the tool; the Windows engine is unaffected by it.
//
// Security model (read before exposing this to a network):
// - Requires `--token <secret>` (or YT_SUMMARY_TOKEN / YT_TERMUX_TOKEN env var) as a bearer
//   header, `?token=` query, or the HttpOnly cookie set when the dashboard is opened with a
//   valid `?token=`. Without Tailscale's own device auth, do NOT rely on the address check
//   alone - see net-guard.js's security note.
// - Only binds to 0.0.0.0 if you pass --bind-all; defaults to loopback-only.
// - Every inbound connection's remote address is checked with net-guard.js's
//   isAllowedAddress (loopback, RFC1918, or Tailscale's 100.64.0.0/10 CGNAT range); anything
//   else gets a 403 before the request body is even read.
// - /vnc/ (the sign-in screen, see display.js) passes the same checks; the VNC/noVNC
//   processes themselves listen on 127.0.0.1 only.
//
// Endpoints:
//   GET  /                                                    -> the Windows dashboard (../index.html + ../app.js,
//                                                                see remote-dashboard.js), or the login form
//   GET/POST /api/*                                           -> its API (dashboard-api.js), X-YT-Token header
//   GET  /simple                                              -> the minimal one-video page (simple.html)
//   POST /run   { videoId, level?, clear? }                   -> { jobId }   (same job queue as /api)
//   GET  /status?jobId=...                                    -> { state, log[], result? }
//   GET  /jobs                                                -> { jobs: [...] } newest first
//   GET  /health                                              -> { ok: true }
//   GET  /config                                              -> { signIn, ipRotation }
//   POST /signin/open                                         -> opens ChatGPT/Gemini/Claude tabs
//   GET  /signin/status                                       -> { status: { ChatGPT: 'signed-in'|... } }
//   GET  /vnc/...                                             -> noVNC view of the server's Chrome
//   GET  /ip                                                  -> rotation state + public IP
//   POST /ip/rotate                                           -> reconnect router for a new IP
//
// Jobs run ONE AT A TIME (dashboard-api.js's Scheduler) - this avoids two jobs fighting over
// the single launched Chrome. An IP rotation holds the queue so no job starts mid-reconnect.

const http = require('http');
const zlib = require('zlib');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const os = require('os');
const { runVideo } = require('./cli');
const netGuard = require('./net-guard');
const { JobStore, Scheduler, handleApi } = require('./dashboard-api');
const { buildDashboard } = require('./remote-dashboard');
const { Thumbs, handleThumb } = require('./thumbs');
const { widgetKey, sameKey, widgetCounts, WidgetPush } = require('./widget');

const COOKIE_NAME = 'ytsum_token';

function parseArgs(argv) {
  const args = {
    port: 8787,
    bindAll: false,
    token: process.env.YT_SUMMARY_TOKEN || process.env.YT_TERMUX_TOKEN || null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') args.port = parseInt(argv[++i], 10);
    else if (a === '--bind-all') args.bindAll = true;
    else if (a === '--token') args.token = argv[++i];
  }
  return args;
}

function log(...parts) {
  console.log(new Date().toISOString(), ...parts);
}

// Runs ~/apps/router-ip-rotator (or $ROUTER_ROTATOR_DIR) to reconnect the LTE router and get
// a new public IP. The internet (and therefore Tailscale) drops for ~1-2 minutes meanwhile,
// so the queue is held and a running job must finish first.
function defaultRotatorRunner(dir) {
  return () => new Promise((resolve, reject) => {
    const proc = spawn('python3', ['-m', 'router_ip_rotator', '--json'], { cwd: dir });
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => { out += d; });
    proc.stderr.on('data', (d) => { err += d; });
    proc.once('error', reject);
    proc.once('exit', (code) => {
      const line = out.trim().split('\n').pop();
      if (code === 0 && line) {
        try { resolve(JSON.parse(line)); return; } catch { /* fall through */ }
      }
      reject(new Error((err.trim().split('\n').pop()) || `router rotator exited with code ${code}`));
    });
  });
}

class IpRotation {
  constructor({ runner, queue } = {}) {
    this.runner = runner || null;
    this.queue = queue;
    this.state = 'idle'; // idle | rotating | done | error
    this.startedAt = null;
    this.result = null;
    this.error = null;
  }

  get available() {
    return !!this.runner;
  }

  snapshot() {
    return { available: this.available, state: this.state, startedAt: this.startedAt, result: this.result, error: this.error };
  }

  // Throws { status } errors for the HTTP layer; otherwise starts the rotation in the
  // background and returns immediately (the caller's connection may drop mid-rotation).
  start() {
    if (!this.runner) throw Object.assign(new Error('IP rotation is not configured on this server.'), { status: 501 });
    if (this.state === 'rotating') throw Object.assign(new Error('An IP change is already in progress.'), { status: 409 });
    if (this.queue.busy) throw Object.assign(new Error('A summary is running. Wait for it to finish, then change IP.'), { status: 409 });
    this.state = 'rotating';
    this.startedAt = new Date().toISOString();
    this.result = null;
    this.error = null;
    this.queue.setHeld(true);
    log('IP rotation started.');
    return Promise.resolve()
      .then(() => this.runner())
      .then((result) => { this.result = result; this.state = 'done'; log('IP rotation finished:', JSON.stringify(result)); })
      .catch((err) => { this.error = err.message; this.state = 'error'; log('IP rotation failed:', err.message); })
      .finally(() => this.queue.setHeld(false));
  }
}

async function fetchPublicIp(timeoutMs = 5000) {
  try {
    const res = await fetch('https://api.ipify.org', { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok ? (await res.text()).trim() : null;
  } catch {
    return null;
  }
}

// Opens one tab per provider in the server's Chrome (skipping ones already open) so the user
// can sign in through the /vnc/ view.
// The login check and the sign-in screen use their OWN tab per provider, tracked by id.
// Videos open a separate tab for every stage (send.js), and those must never be touched here:
// matching tabs by site name let this check grab a video's working tab and, when it was busy
// loading, close it mid-stage.
const loginTabIds = new Map(); // provider name -> CDP target id
let loginTabsBusy = Promise.resolve();

async function ensureLoginTabs() {
  const cdp = require('./cdp');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf8'));
  const alive = new Set((await cdp.listTargets()).map((t) => t.id));
  const opened = [];
  for (const name of config.rotationOrder) {
    if (loginTabIds.has(name) && alive.has(loginTabIds.get(name))) continue;
    const tab = await cdp.newTab(config.providers[name].url);
    loginTabIds.set(name, tab.id);
    opened.push(name);
  }
  return { config, opened };
}

// Serialized: several open dashboards poll this, and each run may open tabs.
function withLoginTabs(fn) {
  const run = loginTabsBusy.then(fn, fn);
  loginTabsBusy = run.catch(() => {});
  return run;
}

async function openSignInTabs() {
  return withLoginTabs(async () => (await ensureLoginTabs()).opened);
}

// Runs in a provider's tab: 'loading', 'signed-out' (a login page or a visible "Log in" /
// "Sign in" / "Sign up" button) or 'signed-in'. (Restored: it went missing in ede1da9, so every
// check threw, the tab was closed as "hung" and the dashboard said "Checking logins..." forever.)
const SIGNED_IN_CHECK = `(() => {
  if (document.readyState !== 'complete') return 'loading';
  if (/^\\/(login|auth|signin)/i.test(location.pathname)) return 'signed-out';
  const labels = [...document.querySelectorAll('a,button')]
    .filter((el) => el.offsetParent !== null)
    .map((el) => el.innerText.trim().toLowerCase());
  return labels.some((t) => t === 'log in' || t === 'sign in' || t === 'sign up') ? 'signed-out' : 'signed-in';
})()`;

async function signInStatus() {
  return withLoginTabs(async () => {
    const cdp = require('./cdp');
    const { config, opened } = await ensureLoginTabs();
    if (opened.length) await new Promise((r) => setTimeout(r, 4000)); // let new tabs load
    const targets = await cdp.listTargets();
    const status = {};
    for (const name of config.rotationOrder) {
      const target = targets.find((t) => t.id === loginTabIds.get(name));
      if (!target) { status[name] = 'no-tab'; continue; }
      let ws;
      try {
        ws = await cdp.connect(target.webSocketDebuggerUrl);
        const result = await cdp.sendCommand(ws, 'Runtime.evaluate', { expression: SIGNED_IN_CHECK, returnByValue: true }, 6000);
        status[name] = result.result ? result.result.value : 'unknown';
      } catch {
        // Our own login tab crashed or hung: replace it (never a video's tab).
        await cdp.closeTab(target.id).catch(() => {});
        loginTabIds.delete(name);
        status[name] = 'loading';
      } finally {
        if (ws) ws.close();
      }
    }
    return status;
  });
}

function sendJson(res, status, body, extraHeaders = {}) {
  let payload = Buffer.from(JSON.stringify(body));
  // The status poll is ~270 KB every 1.5 s; gzip makes it ~10x smaller for phones on mobile data.
  const gzip = res.acceptsGzip && payload.length > 2048;
  if (gzip) payload = zlib.gzipSync(payload, { level: 5 });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...(gzip ? { 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' } : {}),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendPage(res, content, type = 'text/html; charset=utf-8', extraHeaders = {}) {
  const payload = Buffer.isBuffer(content) ? content : Buffer.from(content);
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' https://i.ytimg.com https://yt3.googleusercontent.com https://yt3.ggpht.com; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'; connect-src 'self'; frame-ancestors 'none'",
    ...extraHeaders,
  });
  res.end(payload);
}

// The two dashboards (see SPACES in dashboard-api.js), each at /<space>.
const DASHBOARD_PATHS = ['/torah', '/general'];

// '/': choose a dashboard. A #videos=/#video= link from an old bookmark is passed on to the
// chosen one, so nothing it carried is lost.
const CHOOSER_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>YT Summary</title>
<style>body{font:16px system-ui,sans-serif;max-width:520px;margin:auto;padding:24px 16px;background:#0b111a;color:#e8eef7}
h1{font-size:22px;color:#7dd3fc;margin:0 0 18px}a{display:block;text-decoration:none;color:inherit;background:#111823;border:1px solid #233044;
border-radius:16px;padding:22px 20px;margin:14px 0}a:hover{border-color:#7dd3fc}b{display:block;font-size:21px;margin-bottom:4px}
span{color:#93a4b8;font-size:14px}.n{color:#5eead4;font-weight:700}</style></head>
<body><h1>YT Summary</h1>
<a href="/torah" data-space="torah"><b>📜 Torah videos</b><span>Shiurim and Torah lessons · <span class="n"></span></span></a>
<a href="/general" data-space="general"><b>🎓 Regular videos</b><span>Other studies and everything else · <span class="n"></span></span></a>
<script>
for (const a of document.querySelectorAll('a[data-space]')) {
  a.href += location.hash;
  fetch('/api/status', { headers: { 'X-Space': a.dataset.space } }).then((r) => r.json()).then((s) => {
    const done = s.jobs.filter((j) => j.State === 'completed').length;
    a.querySelector('.n').textContent = s.jobs.length + ' videos · ' + s.active + ' running · ' + s.queued + ' queued · ' + done + ' done';
  }).catch(() => {});
}
</script></body></html>`;

// Shown instead of a JSON 401 when a browser opens the dashboard without a valid key, so a
// cut-off or missing ?token= link still lets the user paste the key and get in.
function sendLogin(res, failed, next = '') {
  const payload = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>YT Summary Remote</title>
<style>body{font:16px system-ui,sans-serif;max-width:420px;margin:auto;padding:24px;background:#111827;color:#f9fafb}
form{background:#1f2937;border-radius:14px;padding:18px;margin:16px 0}
input,button{box-sizing:border-box;width:100%;padding:12px;margin:7px 0;border-radius:8px;border:1px solid #4b5563;font:inherit}
button{background:#2563eb;color:white;border:0;font-weight:700}.error{color:#fca5a5}</style></head>
<body><h1>YT Summary Remote</h1><form method="post" action="/login">
<label for="token">Access key</label>
<input id="token" name="token" type="password" required autocomplete="current-password" autofocus>
<input type="hidden" name="next" id="next" value="${DASHBOARD_PATHS.includes(next) ? next : ''}">
${failed ? '<p class="error">Wrong key, try again.</p>' : ''}
<button>Enter</button></form>
<script>
// After the key, come back to the page that asked for it (/torah or /general), not the picker.
if (location.pathname !== '/login') document.getElementById('next').value = location.pathname;
// A bookmark link carries the key after '#'; log in with it and reopen the same link.
const key = new URLSearchParams(location.hash.slice(1)).get('token');
if (key) fetch('/login', {method: 'POST', body: new URLSearchParams({token: key}), redirect: 'manual'})
  .then(() => location.reload());
</script></body></html>`);
  res.writeHead(failed ? 401 : 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'",
  });
  res.end(payload);
}

function sessionCookie(value) {
  return `${COOKIE_NAME}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`;
}

function readBody(req, maxBytes = 65536) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) { reject(new Error('Request body too large.')); req.destroy(); return; }
      data += chunk;
    });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// Constant-time-ish comparison to avoid trivial timing side channels on the token check.
function tokenMatches(expected, actual) {
  if (!expected || !actual || expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

// The Windows dashboard's app.js only accepts a 64-hex-character key, while people type the
// short access key. The server derives a fixed 64-hex dashboard key from it and accepts both.
function dashboardToken(token) {
  return token ? crypto.createHash('sha256').update(`yt-summary-dashboard:${token}`).digest('hex') : null;
}

function keyMatches(token, candidate) {
  return !!candidate && (tokenMatches(token, candidate) || tokenMatches(dashboardToken(token), candidate));
}

// Returns null when the request may proceed, else { status, error }.
function checkAccess(req, url, token) {
  const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!netGuard.isAllowedAddress(remoteAddress)) {
    return { status: 403, error: 'Only loopback, private-network, or Tailscale clients are allowed.' };
  }
  if (!token) return null;
  const authHeader = req.headers['authorization'];
  const candidates = [
    req.headers['x-yt-token'] || null, // the Windows dashboard's app.js
    authHeader ? authHeader.replace(/^Bearer\s+/i, '') : null,
    url.searchParams.get('token'),
    readCookie(req, COOKIE_NAME),
  ];
  if (candidates.some((c) => keyMatches(token, c))) return null;
  return { status: 401, error: 'Missing or invalid token.' };
}

// Forwards /vnc/<rest> to the local websockify+noVNC web server, including the WebSocket
// upgrade that carries the actual screen.
function proxyVncHttp(req, res, url, vncPort) {
  const upstream = http.request({
    host: '127.0.0.1',
    port: vncPort,
    method: req.method,
    path: (url.pathname.slice('/vnc'.length) || '/') + url.search,
    headers: { ...req.headers, host: `127.0.0.1:${vncPort}` },
  }, (upRes) => {
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => sendJson(res, 502, { error: `Sign-in screen unavailable: ${err.message}` }));
  req.pipe(upstream);
}

function proxyVncUpgrade(req, socket, head, url, vncPort) {
  const upstream = net.connect(vncPort, '127.0.0.1', () => {
    const lines = [`${req.method} ${(url.pathname.slice('/vnc'.length) || '/')}${url.search} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const key = req.rawHeaders[i];
      lines.push(`${key}: ${key.toLowerCase() === 'host' ? `127.0.0.1:${vncPort}` : req.rawHeaders[i + 1]}`);
    }
    upstream.write(lines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => { upstream.destroy(); socket.destroy(); };
  upstream.on('error', close);
  socket.on('error', close);
}

// The job state the old minimal page (/simple, /run, /status, /jobs) understands.
function simpleState(job) {
  if (job.State === 'completed') return 'done';
  if (['error', 'cancelled', 'needs-review', 'reviewed'].includes(job.State)) return 'error';
  return job.State === 'queued' ? 'queued' : 'running';
}

function createServer({
  token, runner = runVideo, vncPort = null, rotatorRunner = null, openTabs = openSignInTabs, publicIp = fetchPublicIp,
  loginStatus = signInStatus, stateDir = null, attachRunner = null, browserReady = async () => true, recycleBrowser = null,
} = {}) {
  // Jobs, results and settings persist in stateDir; tests get a throwaway directory.
  const store = new JobStore(stateDir || fs.mkdtempSync(path.join(os.tmpdir(), 'yt-summary-state-')));
  const scheduler = new Scheduler({ store, runner, attachRunner, browserReady, recycleBrowser, log: (msg) => log(msg) });
  // Android home-screen widget (widget.js): counts on request, pushed to the phone on change.
  const counts = () => widgetCounts(store.jobs, { paused: scheduler.paused || scheduler.held });
  const widgetPush = new WidgetPush({ stateDir: store.dir, getCounts: counts, log: (msg) => log(msg) });
  const widgetTimer = setInterval(() => widgetPush.tick().catch(() => {}), 5000);
  widgetTimer.unref();
  const wKey = widgetKey(token);
  const rotation = new IpRotation({ runner: rotatorRunner, queue: scheduler });
  const thumbs = new Thumbs(store.dir);

  const server = http.createServer(async (req, res) => {
    res.acceptsGzip = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
    try {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/login' && req.method === 'POST' && token) {
        const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (!netGuard.isAllowedAddress(remoteAddress)) { sendJson(res, 403, { error: 'Forbidden.' }); return; }
        const form = new URLSearchParams(await readBody(req, 4096));
        const supplied = (form.get('token') || '').trim();
        if (!keyMatches(token, supplied)) { sendLogin(res, true, form.get('next')); return; }
        const next = DASHBOARD_PATHS.includes(form.get('next')) ? form.get('next') : '/';
        res.writeHead(303, { Location: next, 'Set-Cookie': sessionCookie(supplied), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      // The dashboard's code is not secret (the Windows helper serves it openly too); the
      // page itself, the API and everything else need the key.
      const STATIC = { '/remote-extras.js': 'application/javascript; charset=utf-8', '/remote-responsive.css': 'text/css; charset=utf-8',
        '/eye-scroll.js': 'application/javascript; charset=utf-8' };
      // MediaPipe for the viewer's eye page-turn (fetch-mediapipe.sh). Large and unchanging, so
      // cached by the phone for a month instead of downloaded on every page load.
      const VENDOR = /^\/vendor\/mediapipe\/(vision_bundle\.mjs|face_landmarker\.task|wasm\/vision_wasm_(nosimd_)?internal\.(js|wasm))$/;
      if (req.method === 'GET' && VENDOR.test(url.pathname)) {
        const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (!netGuard.isAllowedAddress(remoteAddress)) { sendJson(res, 403, { error: 'Forbidden.' }); return; }
        const file = path.join(__dirname, url.pathname.slice(1));
        if (!fs.existsSync(file)) { sendJson(res, 404, { error: 'MediaPipe is not installed on the server (run fetch-mediapipe.sh).' }); return; }
        const type = url.pathname.endsWith('.wasm') ? 'application/wasm'
          : url.pathname.endsWith('.task') ? 'application/octet-stream' : 'application/javascript; charset=utf-8';
        const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '') && fs.existsSync(`${file}.gz`);
        const body = fs.readFileSync(gz ? `${file}.gz` : file);
        res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'public, max-age=2592000, immutable',
          'X-Content-Type-Options': 'nosniff', Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
        res.end(body);
        return;
      }
      if (req.method === 'GET' && (url.pathname === '/app.js' || STATIC[url.pathname])) {
        const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (!netGuard.isAllowedAddress(remoteAddress)) { sendJson(res, 403, { error: 'Forbidden.' }); return; }
        if (url.pathname === '/app.js') sendPage(res, buildDashboard().script, 'application/javascript; charset=utf-8');
        else sendPage(res, fs.readFileSync(path.join(__dirname, url.pathname.slice(1))), STATIC[url.pathname]);
        return;
      }

      // The widget's own read-only key (widget.js), checked before the dashboard key.
      if (url.pathname === '/api/widget' || url.pathname === '/api/widget/register') {
        const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (!netGuard.isAllowedAddress(remoteAddress)) { sendJson(res, 403, { error: 'Forbidden.' }); return; }
        const supplied = req.headers['x-widget-key'] || url.searchParams.get('key') || '';
        if (wKey && !sameKey(wKey, supplied)) { sendJson(res, 401, { error: 'Missing or invalid widget key.' }); return; }
        if (url.pathname === '/api/widget' && req.method === 'GET') { sendJson(res, 200, { ...counts(), at: new Date().toISOString() }); return; }
        if (url.pathname === '/api/widget/register' && req.method === 'POST') {
          try {
            const body = JSON.parse((await readBody(req, 4096)) || '{}');
            sendJson(res, 200, widgetPush.register(body.endpoint));
            log('Android widget registered for push updates.');
          } catch (err) { sendJson(res, err.status || 400, { error: err.message }); }
          return;
        }
        sendJson(res, 405, { error: 'Method not allowed.' });
        return;
      }

      const denied = checkAccess(req, url, token);
      if (denied && denied.status === 401 && ['/', '/simple', ...DASHBOARD_PATHS].includes(url.pathname) && req.method === 'GET') {
        sendLogin(res, url.searchParams.has('token'));
        return;
      }
      if (denied) {
        sendJson(res, denied.status, { error: denied.error });
        return;
      }

      if ((url.pathname === '/' || url.pathname === '/simple' || DASHBOARD_PATHS.includes(url.pathname)) && req.method === 'GET') {
        // Opening a page once with ?token= remembers it in an HttpOnly cookie, so the sign-in
        // screen (plain links/WebSockets, no custom headers) is authorized too.
        const supplied = url.searchParams.get('token');
        const headers = supplied && token ? { 'Set-Cookie': sessionCookie(supplied) } : {};
        // '/' picks one of the two dashboards (Torah / regular videos); each lives at its own path.
        const page = url.pathname === '/' ? CHOOSER_PAGE
          : url.pathname === '/simple' ? fs.readFileSync(path.join(__dirname, 'simple.html'))
            : buildDashboard({ seedToken: dashboardToken(token), space: url.pathname.slice(1) }).html;
        sendPage(res, page, 'text/html; charset=utf-8', headers);
        return;
      }

      if (url.pathname.startsWith('/thumb/') && req.method === 'GET' && await handleThumb(thumbs, url, res)) return;

      // The dashboard's "Connect the Android widget" link (needs the full dashboard key).
      if (url.pathname === '/api/widget/setup' && req.method === 'GET') { sendJson(res, 200, { key: wKey }); return; }

      // The phone's eye page-turn reports its steps and errors here, so a problem on the phone
      // shows up in this server's log (journalctl --user -u yt-summary).
      if (url.pathname === '/api/client-log' && req.method === 'POST') {
        const text = String((await readBody(req, 4096)) || '').replace(/[\r\n]+/g, ' ').slice(0, 600);
        log(`[phone] ${text}`);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        let body = null;
        if (req.method === 'POST') {
          try { body = JSON.parse((await readBody(req)) || '{}'); } catch { sendJson(res, 400, { error: 'Invalid JSON.' }); return; }
        }
        try {
          sendJson(res, 200, await handleApi(scheduler, req.method, url.pathname, body, req.headers['x-space'] || null));
        } catch (err) {
          sendJson(res, err.status || 500, { error: err.message });
        }
        return;
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === '/config' && req.method === 'GET') {
        sendJson(res, 200, { signIn: !!vncPort, ipRotation: rotation.available });
        return;
      }

      if (url.pathname === '/run' && req.method === 'POST') {
        const raw = await readBody(req);
        let parsed;
        try { parsed = JSON.parse(raw || '{}'); } catch { parsed = null; }
        if (!parsed || !parsed.videoId) {
          sendJson(res, 400, { error: 'JSON body with a "videoId" field is required.' });
          return;
        }
        try {
          const job = scheduler.enqueue({
            videoId: parsed.videoId, requestId: crypto.randomUUID(),
            ...(parsed.level ? { summaryLevel: parsed.level } : {}),
          });
          if (parsed.clear && !scheduler.busy) scheduler.clearProgress(job.Id);
          else if (['error', 'cancelled'].includes(job.State)) scheduler.retry(job.Id);
          sendJson(res, 202, { jobId: job.Id, state: simpleState(job) });
        } catch (err) {
          sendJson(res, err.status || 500, { error: err.message });
        }
        return;
      }

      if (url.pathname === '/status' && req.method === 'GET') {
        const job = store.get(url.searchParams.get('jobId') || '');
        if (!job) { sendJson(res, 404, { error: 'Unknown jobId.' }); return; }
        const state = simpleState(job);
        const result = state === 'done' ? { text: store.getResult(job), provider: job.ProviderName } : null;
        sendJson(res, 200, {
          id: job.Id, videoId: job.VideoId, state, log: [job.Message], result, error: state === 'error' ? job.Message : null,
        });
        return;
      }

      if (url.pathname === '/jobs' && req.method === 'GET') {
        const jobs = [...store.jobs].reverse().map((job) => ({
          id: job.Id, videoId: job.VideoId, level: job.SummaryLevel, state: simpleState(job),
          createdAt: job.CreatedAt, lastLog: job.Message, error: simpleState(job) === 'error' ? job.Message : null,
        }));
        sendJson(res, 200, { jobs, held: scheduler.held });
        return;
      }

      if (url.pathname === '/signin/open' && req.method === 'POST') {
        const opened = await openTabs();
        sendJson(res, 200, { opened });
        return;
      }

      if (url.pathname === '/signin/status' && req.method === 'GET') {
        sendJson(res, 200, { status: await loginStatus() });
        return;
      }

      if (url.pathname === '/vnc' || url.pathname.startsWith('/vnc/')) {
        if (!vncPort) { sendJson(res, 404, { error: 'Sign-in screen is not enabled (server started without the virtual display).' }); return; }
        proxyVncHttp(req, res, url, vncPort);
        return;
      }

      if (url.pathname === '/ip' && req.method === 'GET') {
        const snapshot = rotation.snapshot();
        snapshot.publicIp = rotation.state === 'rotating' ? null : await publicIp();
        sendJson(res, 200, snapshot);
        return;
      }

      if (url.pathname === '/ip/rotate' && req.method === 'POST') {
        try {
          rotation.start();
        } catch (err) {
          sendJson(res, err.status || 500, { error: err.message });
          return;
        }
        sendJson(res, 202, rotation.snapshot());
        return;
      }

      sendJson(res, 404, { error: 'Not found.' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    const denied = checkAccess(req, url, token);
    if (denied || !vncPort || !url.pathname.startsWith('/vnc/')) {
      socket.end(`HTTP/1.1 ${denied ? denied.status : 404} Denied\r\nConnection: close\r\n\r\n`);
      return;
    }
    proxyVncUpgrade(req, socket, head, url, vncPort);
  });

  return { server, scheduler, store, rotation };
}

// Asks start.js (over the IPC channel) to restart the browser; resolves with its new CDP port.
let browserRestartSeq = 0;
function requestBrowserRestart(timeoutMs = 120000) {
  if (!process.send) return Promise.reject(new Error('Browser restart is only available when started by start.js.'));
  const id = ++browserRestartSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { process.off('message', onMessage); reject(new Error('Browser restart timed out.')); }, timeoutMs);
    function onMessage(message) {
      if (!message || message.id !== id) return;
      clearTimeout(timer);
      process.off('message', onMessage);
      if (message.type === 'browser-restarted') {
        process.env.CDP_PORT = String(message.port);
        resolve(message.port);
      } else reject(new Error(message.error || 'Browser restart failed.'));
    }
    process.on('message', onMessage);
    process.send({ type: 'restart-browser', id });
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.token) {
    console.error('Refusing to start without a token. Pass --token <secret> or set YT_SUMMARY_TOKEN.');
    process.exit(1);
  }
  const vncPort = process.env.VNC_WEB_PORT ? Number(process.env.VNC_WEB_PORT) : null;
  const rotatorDir = process.env.ROUTER_ROTATOR_DIR || path.join(require('os').homedir(), 'apps', 'router-ip-rotator');
  const rotatorRunner = fs.existsSync(path.join(rotatorDir, 'router_ip_rotator')) ? defaultRotatorRunner(rotatorDir) : null;

  const cdp = require('./cdp');
  const { readConversation } = require('./send');
  const stateDir = process.env.YT_SUMMARY_STATE_DIR || path.join(os.homedir(), '.yt-summary-termux', 'dashboard');
  const { server, scheduler } = createServer({
    token: args.token, vncPort, rotatorRunner, stateDir,
    attachRunner: (url) => readConversation(url),
    browserReady: () => cdp.listTargets().then(() => true, () => false),
    recycleBrowser: process.send ? () => requestBrowserRestart() : null,
  });
  scheduler.startTimer();
  const bindAddress = args.bindAll ? '0.0.0.0' : '127.0.0.1';
  server.listen(args.port, bindAddress, () => {
    log(`Listening on ${bindAddress}:${args.port} (bindAll=${args.bindAll}, signIn=${!!vncPort}, ipRotation=${!!rotatorRunner}).`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer, IpRotation, tokenMatches, checkAccess, readCookie, dashboardToken };
