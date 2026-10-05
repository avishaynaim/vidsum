'use strict';
// widget.js: the Android widget's counts, its read-only key and the throttled push.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { widgetKey, sameKey, widgetCounts, WidgetPush, MIN_GAP_MS } = require('../widget');

const today = new Date().toISOString();
const jobs = [
  { State: 'completed', UpdatedAt: today, ReadAt: null },
  { State: 'completed', UpdatedAt: '2020-01-01T00:00:00Z', ReadAt: '2020-01-02T00:00:00Z' },
  { State: 'queued' },
  { State: 'queued', WatchLater: true },
  { State: 'gemini' },
  { State: 'error' },
  { State: 'cancelled' },
];
assert.deepStrictEqual(widgetCounts(jobs), { running: 1, queued: 1, unread: 1, doneToday: 1, failed: 1, paused: false },
  'watch-later videos are not "queued"; cancelled is nothing');

const key = widgetKey('a'.repeat(64));
assert.strictEqual(key.length, 40);
assert.notStrictEqual(key, widgetKey('b'.repeat(64)));
assert.ok(sameKey(key, widgetKey('a'.repeat(64))));
assert.ok(!sameKey(key, 'x'.repeat(40)) && !sameKey(key, '') && !sameKey(key, null));

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-test-'));
  let t = 1_000_000;
  let counts = { running: 1 };
  const sent = [];
  let reply = 200;
  const push = new WidgetPush({ stateDir: dir, getCounts: () => counts, now: () => t,
    post: async (endpoint, body) => { sent.push({ endpoint, body: JSON.parse(body) }); return reply; } });

  assert.throws(() => push.register('http://ntfy.sh/up1'), /https/);
  assert.throws(() => push.register('https://evil.example/up1'), /ntfy\.sh/, 'the server only posts to the push service');
  push.register('https://ntfy.sh/upABC?up=1');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'widget-push.json'), 'utf8')).endpoints, ['https://ntfy.sh/upABC?up=1']);

  await push.tick();
  assert.strictEqual(sent.length, 1, 'a new phone gets the counts at once');
  assert.strictEqual(sent[0].body.running, 1);
  await push.tick();
  assert.strictEqual(sent.length, 1, 'nothing changed: nothing sent');

  counts = { running: 2 };
  t += 10_000;
  await push.tick();
  assert.strictEqual(sent.length, 1, 'a change within the gap waits');
  t += MIN_GAP_MS;
  await push.tick();
  assert.strictEqual(sent.length, 2, '...and goes out once the gap has passed');
  assert.strictEqual(sent[1].body.running, 2);

  counts = { running: 3 };
  t += MIN_GAP_MS;
  reply = 429;
  await push.tick();
  counts = { running: 4 };
  t += MIN_GAP_MS;
  await push.tick();
  assert.strictEqual(sent.length, 3, 'a rate limit pauses pushes');

  reply = 410;
  t += 11 * 60 * 1000;
  await push.tick();
  assert.strictEqual(push.endpoints.length, 0, 'a gone endpoint (app removed) is dropped');
  console.log('widget tests passed');
})().catch((err) => { console.error(err); process.exit(1); });
