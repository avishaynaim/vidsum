'use strict';
// remote-linux-tailscale/launch-chrome.js
//
// Launches a REAL desktop Chrome/Chromium process with CDP remote debugging enabled, for
// the "remote Linux box (with real Chrome) + Tailscale" deployment described in README.md.
// This is a materially better fit than the on-device Termux/ADB path: a Linux server can run
// actual desktop Chrome, exposing the exact same DOM the Windows engine's already-tested
// `Providers.psm1` selectors (mirrored in providers.json here) target - no mobile-Chrome DOM
// differences to debug, and no `adb pair`/`adb forward` dance at all.
//
// UNVERIFIED IN THIS SANDBOX: there is no Linux box, no installed Chrome/Chromium, and no
// network access available here, so this module has only been syntax-checked
// (`node --check`) and had its pure argument-construction/binary-discovery logic covered by
// tests/test-bundle.js with injected fakes. Confirm on your actual Linux box before
// trusting it end to end.

const { spawnSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');

// Candidate binary names/paths to try, in order, mirroring the intent (if not the exact
// mechanism) of the Windows engine's Get-YtBrowser: prefer a real Chrome install, fall back
// to Chromium. `command` entries are resolved via `which`; `path` entries are checked
// directly for existence, covering common Linux package/distro layouts.
const DEFAULT_CANDIDATES = [
  { command: 'google-chrome-stable' },
  { command: 'google-chrome' },
  { command: 'chromium-browser' },
  { command: 'chromium' },
  { path: '/usr/bin/google-chrome-stable' },
  { path: '/usr/bin/google-chrome' },
  { path: '/usr/bin/chromium-browser' },
  { path: '/usr/bin/chromium' },
  { path: '/opt/google/chrome/chrome' },
  { path: '/snap/bin/chromium' },
];

// Resolves a `command` candidate to an absolute path via `which` (POSIX) without invoking a
// shell, or accepts a `path` candidate directly if it exists. Injectable via `runWhich`/`exists`
// so tests can exercise the search order without touching the real filesystem/PATH.
function findChromeBinary(candidates = DEFAULT_CANDIDATES, deps = {}) {
  const runWhich = deps.runWhich || ((cmd) => {
    const result = spawnSync('which', [cmd], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout) return result.stdout.trim();
    return null;
  });
  const exists = deps.exists || ((p) => fs.existsSync(p));

  for (const candidate of candidates) {
    if (candidate.command) {
      const resolved = runWhich(candidate.command);
      if (resolved) return resolved;
    } else if (candidate.path && exists(candidate.path)) {
      return candidate.path;
    }
  }
  return null;
}

// Finds a free loopback TCP port for --remote-debugging-port, the same "reserve an ephemeral
// port, don't hardcode 9222" approach Start-YtBrowser uses on Windows so multiple runs (or a
// port already in use) never collide.
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// Builds the argv array for launching Chrome headlessly with CDP enabled. Deliberately does
// NOT wrap --user-data-dir's value in embedded literal quote characters (unlike the Windows
// engine's Start-YtBrowser, which needs that for Windows CreateProcess re-parsing): on Linux,
// child_process.spawn passes argv entries directly with no shell re-parsing, so embedding
// quote characters would corrupt the path by making them part of the literal value.
function buildArgs({ port, profileDir, headless, url }) {
  const args = [
    `--remote-debugging-port=${port}`,
    `--remote-debugging-address=127.0.0.1`, // stays loopback-only; server.js is the network boundary
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-fre',
  ];
  if (headless) args.push('--headless=new');
  if (url) args.push(url);
  return args;
}

async function waitForCdpReady(port, timeoutMs = 20000, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const res = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return true;
    } catch (err) {
      lastError = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`internal WebSocket error: Chrome CDP did not become ready on port ${port} within ${timeoutMs}ms` +
    (lastError ? ` (${lastError.message})` : ''));
}

// Launches Chrome/Chromium and returns { proc, port } once its CDP endpoint answers. Caller
// is responsible for setting CDP_PORT=port (and CDP_HOST=127.0.0.1) before using cdp.js, and
// for calling proc.kill() on shutdown - mirrors the lifecycle Start-YtBrowser manages on
// Windows (spawn once, reuse across the whole run, terminate on Stop).
async function launchChrome(options = {}) {
  const headless = options.headless !== false; // default true: a remote Linux box typically has no display
  const profileDir = options.profileDir || path.join(os.homedir(), '.yt-summary-termux', 'chrome-profile');
  fs.mkdirSync(profileDir, { recursive: true });

  const binary = options.binary || findChromeBinary(options.candidates);
  if (!binary) {
    throw new Error('Chrome/Chromium binary not found. Install google-chrome-stable or chromium and retry, ' +
      'or pass { binary: "/path/to/chrome" } explicitly.');
  }

  const port = options.port || await findFreePort();
  const args = buildArgs({ port, profileDir, headless, url: options.url });
  const proc = (options.spawnImpl || spawn)(binary, args, { stdio: 'ignore', detached: false });

  proc.once('error', () => { /* surfaced via waitForCdpReady's timeout/failure instead */ });

  if (!options.skipReadyCheck) {
    await waitForCdpReady(port, options.readyTimeoutMs, options);
  }
  return { proc, port, binary };
}

module.exports = { findChromeBinary, findFreePort, buildArgs, waitForCdpReady, launchChrome, DEFAULT_CANDIDATES };
