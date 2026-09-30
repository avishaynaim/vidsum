'use strict';
// remote-linux-tailscale/server.js
//
// Minimal authenticated HTTP endpoint so an Android phone (reached over Tailscale, not the
// same Wi-Fi/LAN) can queue and check on video summaries running on this Linux box, without
// needing shell/SSH access to it. This is the missing piece that turns the already-built
// `cli.js` pipeline (transcript -> chunk/rotate -> merge, atomic checkpoints, provider
// rotation) into something usable purely from a phone browser.
//
// UNVERIFIED IN THIS SANDBOX: no Linux box, no real Tailscale network, no device to test
// against. Only syntax-checked and covered by pure-logic tests (net-guard address rules,
// job-queue serialization) using injected fakes - see tests/test-bundle.js.
//
// Security model (read before exposing this to a network):
// - Requires `--token <secret>` (or YT_TERMUX_TOKEN env var) as a bearer-style query/header
//   token on every request. Without Tailscale's own device auth, do NOT rely on the address
//   check alone - see net-guard.js's security note.
// - Only binds to 0.0.0.0 if you pass --bind-all; defaults to loopback-only, matching the
//   Windows engine's default-safe posture (Kiwi/mobile access there is opt-in via
//   -EnableKiwi, never automatic either).
// - Every inbound connection's remote address is checked with net-guard.js's
//   isAllowedAddress (loopback, RFC1918, or Tailscale's 100.64.0.0/10 CGNAT range); anything
//   else gets a 403 before the request body is even read.
//
// Endpoints:
//   POST /run   { videoId, level?, firstProvider?, clear? }  -> { jobId }
//   GET  /status?jobId=...                                    -> { state, log[], result? }
//   GET  /health                                              -> { ok: true }
//
// Jobs run ONE AT A TIME (a simple FIFO queue), matching cli.js's existing single-video-at-a-
// time design (see README's "What's intentionally NOT ported" - no MaxConcurrent/per-provider
// semaphore port here) - this avoids two jobs fighting over the single launched Chrome tab.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const { runVideo } = require('./cli');
const netGuard = require('./net-guard');

function parseArgs(argv) {
  const args = { port: 8787, bindAll: false, token: process.env.YT_TERMUX_TOKEN || null };
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
  }

  enqueue({ videoId, level, firstProvider, clear }) {
    const id = crypto.randomUUID();
    const job = { id, videoId, level, firstProvider, clear, state: 'queued', log: [], result: null, error: null };
    this.jobs.set(id, job);
    this.queue.push(job);
    this._pump();
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  async _pump() {
    if (this.busy) return; // one job at a time - see module comment
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
        out: job.out || process.cwd(),
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

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

function sendDashboard(res) {
  const payload = fs.readFileSync(path.join(__dirname, 'index.html'));
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(payload);
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

function createServer({ token, runner } = {}) {
  const queue = new JobQueue(runner);

  const server = http.createServer(async (req, res) => {
    try {
      const remoteAddress = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
      if (!netGuard.isAllowedAddress(remoteAddress)) {
        sendJson(res, 403, { error: 'Only loopback, private-network, or Tailscale clients are allowed.' });
        return;
      }

      const url = new URL(req.url, 'http://localhost');
      const authHeader = req.headers['authorization'];
      const headerToken = authHeader ? authHeader.replace(/^Bearer\s+/i, '') : null;
      const suppliedToken = headerToken || url.searchParams.get('token');
      if (token && !tokenMatches(token, suppliedToken || '')) {
        sendJson(res, 401, { error: 'Missing or invalid token.' });
        return;
      }

      if (url.pathname === '/' && req.method === 'GET') {
        sendDashboard(res);
        return;
      }

      if (url.pathname === '/health' && req.method === 'GET') {
        sendJson(res, 200, { ok: true });
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

      sendJson(res, 404, { error: 'Not found.' });
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
  });

  return { server, queue };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.token) {
    console.error('Refusing to start without a token. Pass --token <secret> or set YT_TERMUX_TOKEN.');
    process.exit(1);
  }
  const { server } = createServer({ token: args.token });
  const bindAddress = args.bindAll ? '0.0.0.0' : '127.0.0.1';
  server.listen(args.port, bindAddress, () => {
    log(`Listening on ${bindAddress}:${args.port} (bindAll=${args.bindAll}). ` +
      `Reach it over Tailscale at http://<this-box-tailscale-ip>:${args.port}/run once --bind-all is set.`);
  });
}

if (require.main === module) {
  main();
}

module.exports = { createServer, JobQueue, tokenMatches };
