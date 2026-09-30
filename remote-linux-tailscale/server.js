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
//   GET  /                                                    -> dashboard (index.html)
//   POST /run   { videoId, level?, firstProvider?, clear? }  -> { jobId }
//   GET  /status?jobId=...                                    -> { state, log[], result? }
//   GET  /jobs                                                -> { jobs: [...] } newest first
//   GET  /health                                              -> { ok: true }
//   GET  /config                                              -> { signIn, ipRotation }
//   POST /signin/open                                         -> opens ChatGPT/Gemini/Claude tabs
//   GET  /vnc/...                                             -> noVNC view of the server's Chrome
//   GET  /ip                                                  -> rotation state + public IP
//   POST /ip/rotate                                           -> reconnect router for a new IP
//
// Jobs run ONE AT A TIME (a simple FIFO queue) - this avoids two jobs fighting over the
// single launched Chrome. An IP rotation holds the queue so no job starts mid-reconnect.

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { URL } = require('url');

const { runVideo } = require('./cli');
const netGuard = require('./net-guard');

const COOKIE_NAME = 'ytsum_token';
const MAX_JOBS_KEPT = 50;

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

// In-memory job registry: { id, state: 'queued'|'running'|'done'|'error', log: [], result, error }.
// Intentionally not persisted separately - cli.js's own checkpoint.js already durably persists
// actual pipeline progress per video, so a server restart loses only the in-memory job/log
// listing, never the underlying resumable summary progress.
class JobQueue {
  constructor(runner = runVideo) {
    this.runner = runner;
    this.jobs = new Map();
    this.queue = [];
    this.busy = false;
    this.held = false;
  }

  enqueue({ videoId, level, firstProvider, clear }) {
    const id = crypto.randomUUID();
    const job = {
      id, videoId, level, firstProvider, clear,
      state: 'queued', log: [], result: null, error: null, createdAt: new Date().toISOString(),
    };
    this.jobs.set(id, job);
    this.queue.push(job);
    this._trim();
    this._pump();
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  list() {
    return [...this.jobs.values()].reverse().map((job) => ({
      id: job.id, videoId: job.videoId, level: job.level, state: job.state,
      createdAt: job.createdAt, lastLog: job.log[job.log.length - 1] || null, error: job.error,
    }));
  }

  // While held, queued jobs wait; the running job (if any) is unaffected.
  setHeld(held) {
    this.held = held;
    if (!held) this._pump();
  }

  // Drops the oldest finished jobs so the in-memory listing cannot grow without bound.
  _trim() {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS_KEPT) break;
      if (job.state === 'done' || job.state === 'error') this.jobs.delete(id);
    }
  }

  async _pump() {
    if (this.busy || this.held) return; // one job at a time - see module comment
    const job = this.queue.shift();
    if (!job) return;
    this.busy = true;
    job.state = 'running';
    const onStatus = (msg) => { job.log.push(msg); log(`[${job.videoId}]`, msg); };
    try {
      const args = {
        videoId: job.videoId,
        level: job.level || 'legacy',
        firstProvider: job.firstProvider || null,
        out: job.out || process.env.YT_SUMMARY_OUT || process.cwd(),
        clear: !!job.clear,
        maxMessageChars: job.maxMessageChars || 22000,
      };
      const result = await this.runner(args, onStatus);
      job.result = result;
      job.state = 'done';
    } catch (err) {
      job.error = err.message;
      job.state = 'error';
    } finally {
      this.busy = false;
      this._pump(); // process next queued job, if any
    }
  }
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
async function openSignInTabs() {
  const cdp = require('./cdp');
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'providers.json'), 'utf8'));
  const targets = await cdp.listTargets();
  const opened = [];
  for (const name of config.rotationOrder) {
    const url = config.providers[name].url;
    const host = new URL(url).host;
    if (!targets.some((t) => t.type === 'page' && t.url && t.url.includes(host))) {
      await cdp.newTab(url);
      opened.push(name);
    }
  }
  return opened;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendDashboard(res, extraHeaders = {}) {
  const payload = fs.readFileSync(path.join(__dirname, 'index.html'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
    ...extraHeaders,
  });
  res.end(payload);
}

// Shown instead of a JSON 401 when a browser opens the dashboard without a valid key, so a
// cut-off or missing ?token= link still lets the user paste the key and get in.
function sendLogin(res, failed) {
  const payload = Buffer.from(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>YT Summary Remote</title>
<style>body{font:16px system-ui,sans-serif;max-width:420px;margin:auto;padding:24px;background:#111827;color:#f9fafb}
form{background:#1f2937;border-radius:14px;padding:18px;margin:16px 0}
input,button{box-sizing:border-box;width:100%;padding:12px;margin:7px 0;border-radius:8px;border:1px solid #4b5563;font:inherit}
button{background:#2563eb;color:white;border:0;font-weight:700}.error{color:#fca5a5}</style></head>
<body><h1>YT Summary Remote</h1><form method="post" action="/login">
<label for="token">Access key</label>
<input id="token" name="token" type="password" required autocomplete="current-password" autofocus>
${failed ? '<p class="error">Wrong key, try again.</p>' : ''}
<button>Enter</button></form></body></html>`);
  res.writeHead(failed ? 401 : 200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
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

// Returns null when the request may proceed, else { status, error }.
function checkAccess(req, url, token) {
  const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!netGuard.isAllowedAddress(remoteAddress)) {
    return { status: 403, error: 'Only loopback, private-network, or Tailscale clients are allowed.' };
  }
  if (!token) return null;
  const authHeader = req.headers['authorization'];
  const candidates = [
    authHeader ? authHeader.replace(/^Bearer\s+/i, '') : null,
    url.searchParams.get('token'),
    readCookie(req, COOKIE_NAME),
  ];
  if (candidates.some((c) => c && tokenMatches(token, c))) return null;
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

function createServer({ token, runner, vncPort = null, rotatorRunner = null, openTabs = openSignInTabs, publicIp = fetchPublicIp } = {}) {
  const queue = new JobQueue(runner);
  const rotation = new IpRotation({ runner: rotatorRunner, queue });

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');

      if (url.pathname === '/login' && req.method === 'POST' && token) {
        const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
        if (!netGuard.isAllowedAddress(remoteAddress)) { sendJson(res, 403, { error: 'Forbidden.' }); return; }
        const supplied = (new URLSearchParams(await readBody(req, 4096)).get('token') || '').trim();
        if (!tokenMatches(token, supplied)) { sendLogin(res, true); return; }
        res.writeHead(303, { Location: '/', 'Set-Cookie': sessionCookie(supplied), 'Cache-Control': 'no-store' });
        res.end();
        return;
      }

      const denied = checkAccess(req, url, token);
      if (denied && denied.status === 401 && url.pathname === '/' && req.method === 'GET') {
        sendLogin(res, url.searchParams.has('token'));
        return;
      }
      if (denied) {
        sendJson(res, denied.status, { error: denied.error });
        return;
      }

      if (url.pathname === '/' && req.method === 'GET') {
        // Opening the dashboard once with ?token= remembers it in an HttpOnly cookie, so the
        // sign-in screen (plain links/WebSockets, no custom headers) is authorized too.
        const supplied = url.searchParams.get('token');
        const headers = supplied && token
          ? { 'Set-Cookie': sessionCookie(supplied) }
          : {};
        sendDashboard(res, headers);
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
        const job = queue.enqueue(parsed);
        sendJson(res, 202, { jobId: job.id, state: job.state });
        return;
      }

      if (url.pathname === '/status' && req.method === 'GET') {
        const jobId = url.searchParams.get('jobId');
        const job = jobId && queue.get(jobId);
        if (!job) { sendJson(res, 404, { error: 'Unknown jobId.' }); return; }
        sendJson(res, 200, { id: job.id, videoId: job.videoId, state: job.state, log: job.log, result: job.result, error: job.error });
        return;
      }

      if (url.pathname === '/jobs' && req.method === 'GET') {
        sendJson(res, 200, { jobs: queue.list(), held: queue.held });
        return;
      }

      if (url.pathname === '/signin/open' && req.method === 'POST') {
        const opened = await openTabs();
        sendJson(res, 200, { opened });
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

  return { server, queue, rotation };
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

  const { server } = createServer({ token: args.token, vncPort, rotatorRunner });
  const bindAddress = args.bindAll ? '0.0.0.0' : '127.0.0.1';
  server.listen(args.port, bindAddress, () => {
    log(`Listening on ${bindAddress}:${args.port} (bindAll=${args.bindAll}, signIn=${!!vncPort}, ipRotation=${!!rotatorRunner}).`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer, JobQueue, IpRotation, tokenMatches, checkAccess, readCookie };
