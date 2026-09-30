'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const required = [
  'start.js', 'server.js', 'index.html', 'launch-chrome.js', 'net-guard.js', 'display.js',
  'cli.js', 'cdp.js', 'checkpoint.js', 'chunk.js', 'providers.json',
  'rejections.js', 'rotate.js', 'send.js', 'transcript.js',
  'setup.sh', 'yt-summary.service.example', 'yt-summary.user.service.example', 'AI-INSTRUCTIONS.md', 'README.md',
];
for (const file of required) {
  assert.ok(fs.existsSync(path.join(root, file)), `missing ${file}`);
}

const netGuard = require('../net-guard');
assert.strictEqual(netGuard.isAllowedAddress('100.64.0.1'), true);
assert.strictEqual(netGuard.isAllowedAddress('100.127.255.255'), true);
assert.strictEqual(netGuard.isAllowedAddress('100.128.0.1'), false);
assert.strictEqual(netGuard.isAllowedAddress('8.8.8.8'), false);

const launcher = require('../launch-chrome');
const args = launcher.buildArgs({
  port: 9222,
  profileDir: '/home/test/.yt-summary-termux/chrome-profile',
  headless: true,
});
assert.ok(args.includes('--remote-debugging-port=9222'));
assert.ok(args.includes('--headless=new'));
assert.ok(!args.find((arg) => arg.startsWith('--user-data-dir=')).includes('"'));

const { parseArgs, randomToken } = require('../start');
const parsed = parseArgs(['--port', '9000', '--token', 'secret', '--headed']);
assert.strictEqual(parsed.apiPort, 9000);
assert.strictEqual(parsed.token, 'secret');
assert.strictEqual(parsed.displayMode, 'current');
assert.strictEqual(parseArgs(['--headless']).displayMode, 'headless');
assert.strictEqual(parseArgs([]).displayMode, null);

const headed = launcher.buildArgs({ port: 1, profileDir: '/p', headless: false, windowSize: { width: 800, height: 600 } });
assert.ok(headed.includes('--window-size=800,600'));
assert.ok(!headed.includes('--headless=new'));

const display = require('../display');
assert.strictEqual(display.findFreeDisplay(90, (p) => p.includes('X90')), 91);
const env = display.displayEnv(':91', { WAYLAND_DISPLAY: 'wayland-0', XDG_SESSION_TYPE: 'wayland', HOME: '/h' });
assert.deepStrictEqual(env, { DISPLAY: ':91', XDG_SESSION_TYPE: 'x11', HOME: '/h' });
assert.deepStrictEqual(display.missingTools({ which: () => null, findNoVncDir: () => null }),
  ['Xvfb', 'x11vnc', 'websockify', 'novnc']);
assert.match(randomToken(), /^[A-HJ-NP-Za-km-z2-9]{20}$/);

async function testDashboard() {
  const { createServer } = require('../server');
  const { server } = createServer({
    token: 'bundle-test-token',
    runner: async () => ({ text: 'unused', provider: 'ChatGPT' }),
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  try {
    const port = server.address().port;
    const denied = await fetch(`http://127.0.0.1:${port}/health`);
    assert.strictEqual(denied.status, 401);

    // A browser without the key gets a login form, and the right key logs it in.
    const loginPage = await fetch(`http://127.0.0.1:${port}/?token=cut-off`);
    assert.strictEqual(loginPage.status, 401);
    assert.match(await loginPage.text(), /Wrong key/);
    const wrong = await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST', body: new URLSearchParams({ token: 'nope' }), redirect: 'manual' });
    assert.strictEqual(wrong.status, 401);
    const login = await fetch(`http://127.0.0.1:${port}/login`, { method: 'POST', body: new URLSearchParams({ token: ' bundle-test-token ' }), redirect: 'manual' });
    assert.strictEqual(login.status, 303);
    assert.match(login.headers.get('set-cookie'), /^ytsum_token=bundle-test-token;/);

    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: 'Bearer bundle-test-token' },
    });
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(await health.json(), { ok: true });

    const dashboard = await fetch(`http://127.0.0.1:${port}/?token=bundle-test-token`);
    assert.strictEqual(dashboard.status, 200);
    assert.match(await dashboard.text(), /YT Summary Remote/);
    const cookie = dashboard.headers.get('set-cookie');
    assert.match(cookie, /^ytsum_token=bundle-test-token;.*HttpOnly/);

    // The cookie alone authorizes later requests (the sign-in screen cannot send headers).
    const viaCookie = await fetch(`http://127.0.0.1:${port}/config`, { headers: { Cookie: cookie.split(';')[0] } });
    assert.strictEqual(viaCookie.status, 200);
    assert.deepStrictEqual(await viaCookie.json(), { signIn: false, ipRotation: false });
    const badCookie = await fetch(`http://127.0.0.1:${port}/config`, { headers: { Cookie: 'ytsum_token=wrong-token-value' } });
    assert.strictEqual(badCookie.status, 401);

    const noVnc = await fetch(`http://127.0.0.1:${port}/vnc/vnc.html`, { headers: { Authorization: 'Bearer bundle-test-token' } });
    assert.strictEqual(noVnc.status, 404);
    const noRotate = await fetch(`http://127.0.0.1:${port}/ip/rotate`, { method: 'POST', headers: { Authorization: 'Bearer bundle-test-token' } });
    assert.strictEqual(noRotate.status, 501);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

// Sign-in screen: /vnc/ is proxied (HTTP) to the local noVNC server only with a valid token.
async function testVncProxy() {
  const http = require('http');
  const upstream = http.createServer((req, res) => res.end(`novnc:${req.url}`));
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { createServer } = require('../server');
  const { server } = createServer({ token: 'bundle-test-token', vncPort: upstream.address().port });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = server.address().port;
    const denied = await fetch(`http://127.0.0.1:${port}/vnc/vnc.html`);
    assert.strictEqual(denied.status, 401);
    const ok = await fetch(`http://127.0.0.1:${port}/vnc/vnc.html?autoconnect=1`, { headers: { Cookie: 'ytsum_token=bundle-test-token' } });
    assert.strictEqual(await ok.text(), 'novnc:/vnc.html?autoconnect=1');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await new Promise((resolve) => upstream.close(resolve));
  }
}

// IP change: refused while a summary runs; otherwise holds queued jobs until it finishes.
async function testIpRotation() {
  const { JobQueue, IpRotation } = require('../server');
  let releaseJob;
  const ran = [];
  const queue = new JobQueue(async (args) => {
    ran.push(args.videoId);
    if (args.videoId === 'AAAAAAAAAAA') await new Promise((r) => { releaseJob = r; });
    return { text: 'x', provider: 'ChatGPT' };
  });
  let releaseRotation;
  const rotation = new IpRotation({ queue, runner: () => new Promise((r) => { releaseRotation = r; }) });

  queue.enqueue({ videoId: 'AAAAAAAAAAA' });
  assert.throws(() => rotation.start(), (err) => err.status === 409);
  releaseJob();
  await new Promise((r) => setImmediate(r));

  const done = rotation.start();
  assert.strictEqual(rotation.state, 'rotating');
  assert.throws(() => rotation.start(), (err) => err.status === 409);
  queue.enqueue({ videoId: 'BBBBBBBBBBB' });
  await new Promise((r) => setImmediate(r));
  assert.deepStrictEqual(ran, ['AAAAAAAAAAA'], 'queued job must wait while the IP is changing');

  releaseRotation({ changed: true, before: '1.1.1.1', after: '2.2.2.2' });
  await done;
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(rotation.state, 'done');
  assert.deepStrictEqual(ran, ['AAAAAAAAAAA', 'BBBBBBBBBBB']);
}

testDashboard()
  .then(testVncProxy)
  .then(testIpRotation)
  .then(() => console.log(`${required.length + 44} bundle checks passed`))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
