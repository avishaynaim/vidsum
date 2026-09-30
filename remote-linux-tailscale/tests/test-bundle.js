'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const required = [
  'start.js', 'server.js', 'index.html', 'launch-chrome.js', 'net-guard.js',
  'cli.js', 'cdp.js', 'checkpoint.js', 'chunk.js', 'providers.json',
  'rejections.js', 'rotate.js', 'send.js', 'transcript.js',
  'setup.sh', 'yt-summary.service.example', 'AI-INSTRUCTIONS.md', 'README.md',
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
assert.strictEqual(parsed.headless, false);
assert.match(randomToken(), /^[a-f0-9]{48}$/);

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

    const health = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Authorization: 'Bearer bundle-test-token' },
    });
    assert.strictEqual(health.status, 200);
    assert.deepStrictEqual(await health.json(), { ok: true });

    const dashboard = await fetch(`http://127.0.0.1:${port}/?token=bundle-test-token`);
    assert.strictEqual(dashboard.status, 200);
    assert.match(await dashboard.text(), /YT Summary Remote/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

testDashboard()
  .then(() => console.log(`${required.length + 13} bundle checks passed`))
  .catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
