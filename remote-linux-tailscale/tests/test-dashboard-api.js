'use strict';
// The Windows dashboard's /api contract as served by the Linux server (dashboard-api.js),
// plus the served page itself (remote-dashboard.js). No network, browser or real pipeline:
// the runner is a controllable fake.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const { JobStore, Scheduler, handleApi, applyStatus } = require('../dashboard-api');
const { buildDashboard } = require('../remote-dashboard');

const tick = () => new Promise((r) => setImmediate(r));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yt-dash-test-'));

// A runner whose videos finish only when the test says so.
function controllableRunner() {
  const pending = new Map();
  const runner = (args, onStatus) => new Promise((resolve, reject) => {
    onStatus('Fetching transcript...');
    onStatus('Transcript fetched (1234 chars).');
    onStatus('Chunk part 1/2: starting.');
    onStatus('Sending to Gemini...');
    args.onInfo({ title: 'Real title', durationSeconds: 3600 });
    pending.set(args.videoId, { resolve, reject, args });
    args.signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped at your request.'), { stopped: true })));
  });
  return { runner, pending };
}

function makeScheduler(dir = tmpDir(), runner = controllableRunner().runner) {
  const store = new JobStore(dir);
  const scheduler = new Scheduler({ store, runner, fetchTitle: async () => '' });
  return { store, scheduler, dir };
}

const add = (scheduler, videoId, extra = {}) =>
  handleApi(scheduler, 'POST', '/api/jobs', { videoId, requestId: crypto.randomUUID(), ...extra });

async function testLifecycle() {
  const fake = controllableRunner();
  const { scheduler, store, dir } = makeScheduler(tmpDir(), fake.runner);
  const job = await add(scheduler, 'AAAAAAAAAAA', { summaryLevel: 'reg', title: 'Given title' });
  await tick();
  assert.strictEqual(job.State, 'gemini', 'status lines map onto dashboard states');
  assert.strictEqual(job.ChunkCount, 2);
  assert.strictEqual(job.TranscriptLength, 1234);
  assert.strictEqual(job.Title, 'Given title', 'a given title is kept');
  assert.strictEqual(job.DurationSeconds, 3600);
  assert.deepStrictEqual(fake.pending.get('AAAAAAAAAAA').args.providers, ['ChatGPT', 'Gemini', 'Claude']);
  const runArgs = fake.pending.get('AAAAAAAAAAA').args;
  assert.ok(runArgs.out && runArgs.maxMessageChars === 22000, 'the pipeline gets its output folder and message budget');

  // A second video waits: one browser, one video at a time.
  const second = await add(scheduler, 'BBBBBBBBBBB');
  assert.strictEqual(second.State, 'queued');

  // A finished part is visible (with its conversation link) before the video completes.
  fake.pending.get('AAAAAAAAAAA').args.onPart({ index: 1, provider: 'ChatGPT', text: 'חלק 1', url: 'https://chatgpt.com/c/p1' });
  let details = await handleApi(scheduler, 'POST', '/api/details', { jobId: job.Id });
  assert.strictEqual(details.final, null);
  assert.deepStrictEqual(details.parts.map((p) => p.text), ['חלק 1']);
  assert.deepStrictEqual(job.PartResultUrls, ['https://chatgpt.com/c/p1']);

  fake.pending.get('AAAAAAAAAAA').resolve({
    text: 'סיכום', provider: 'Claude', url: 'https://claude.ai/chat/final1',
    parts: [{ index: 1, provider: 'ChatGPT', text: 'חלק 1', url: 'https://chatgpt.com/c/p1' },
      { index: 2, provider: 'Gemini', text: 'חלק 2', url: 'https://gemini.google.com/app/p2' }],
  });
  await tick(); await tick();
  assert.strictEqual(job.State, 'completed');
  assert.strictEqual(job.ResultUrl, 'https://claude.ai/chat/final1', '"Open final summary" opens the LLM conversation');
  assert.deepStrictEqual(job.PartResultUrls, ['https://chatgpt.com/c/p1', 'https://gemini.google.com/app/p2']);
  details = await handleApi(scheduler, 'POST', '/api/details', { jobId: job.Id });
  assert.deepStrictEqual(details.final, { text: 'סיכום', provider: 'Claude', url: 'https://claude.ai/chat/final1' });
  assert.deepStrictEqual(details.parts.map((p) => `${p.index}:${p.provider}`), ['1:ChatGPT', '2:Gemini']);
  assert.strictEqual(job.FinalResult, 'local');
  assert.deepStrictEqual(await handleApi(scheduler, 'POST', '/api/result', { jobId: job.Id }), { finalResult: 'סיכום' });
  assert.strictEqual(second.State, 'gemini', 'the next queued video starts');

  // Same video + level again returns the existing job, not a duplicate.
  const again = await add(scheduler, 'AAAAAAAAAAA', { summaryLevel: 'reg' });
  assert.strictEqual(again.Id, job.Id);

  // Persisted: a new store sees the finished job and its result.
  const reloaded = new JobStore(dir);
  assert.strictEqual(reloaded.get(job.Id).State, 'completed');
  assert.strictEqual(reloaded.getResult(reloaded.get(job.Id)), 'סיכום');

  // Stop the running one: cancelled, retry puts it back in the queue.
  await handleApi(scheduler, 'POST', '/api/stop-job', { jobId: second.Id });
  await tick(); await tick();
  assert.strictEqual(second.State, 'cancelled');
  await handleApi(scheduler, 'POST', '/api/retry', { jobId: second.Id });
  await tick();
  assert.strictEqual(second.State, 'gemini');

  // Pause the running one.
  await handleApi(scheduler, 'POST', '/api/pause-job', { jobId: second.Id });
  await tick(); await tick();
  assert.strictEqual(second.State, 'cancelled');
  assert.strictEqual(second.PausedByUser, true);

  // Level change on a finished job clears its result and needs an explicit retry.
  await handleApi(scheduler, 'POST', '/api/set-job-level', { jobId: job.Id, summaryLevel: 'min' });
  assert.strictEqual(job.State, 'cancelled');
  assert.strictEqual(job.FinalResult, '');
  await assert.rejects(handleApi(scheduler, 'POST', '/api/result', { jobId: job.Id }), (e) => e.status === 409);

  // Clear cancelled removes both.
  assert.deepStrictEqual(await handleApi(scheduler, 'POST', '/api/clear-cancelled', {}), { cleared: 2 });
  assert.strictEqual(store.jobs.length, 0);
  assert.strictEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'settings.json').length, 0);
}

async function testFailuresAndRetries() {
  const fake = controllableRunner();
  const { scheduler } = makeScheduler(tmpDir(), fake.runner);
  const job = await add(scheduler, 'CCCCCCCCCCC');
  await tick();
  fake.pending.get('CCCCCCCCCCC').reject(Object.assign(new Error('STOPPED (retryable): every provider failed'), { retryable: true }));
  await tick(); await tick();
  assert.strictEqual(job.State, 'error');
  assert.strictEqual(job.AutoRetryAttempts, 1);
  assert.ok(Date.parse(job.AutoRetryAfterUtc) > Date.now(), 'an automatic retry is scheduled');

  job.AutoRetryAfterUtc = new Date(Date.now() - 1000).toISOString();
  await scheduler.tick();
  await tick();
  assert.strictEqual(job.State, 'gemini', 'a due automatic retry runs again');

  fake.pending.get('CCCCCCCCCCC').reject(new Error('No caption tracks are available for this video.'));
  await tick(); await tick();
  assert.strictEqual(job.State, 'error');
  assert.strictEqual(job.AutoRetryAfterUtc, null, 'a non-retryable failure is not retried automatically');
  assert.deepStrictEqual(await handleApi(scheduler, 'POST', '/api/clear-errors', {}), { cleared: 1 });
}

async function testHoldsAndSettings() {
  const dir = tmpDir();
  const fake = controllableRunner();
  const first = makeScheduler(dir, fake.runner);
  const running = await add(first.scheduler, 'DDDDDDDDDDD');
  await add(first.scheduler, 'EEEEEEEEEEE', { watchLater: true });
  await tick();
  assert.strictEqual(running.State, 'gemini');

  // A server restart: the interrupted job is re-queued and nothing starts by itself.
  const restarted = makeScheduler(dir, controllableRunner().runner);
  const status = restarted.scheduler.status();
  assert.strictEqual(status.paused, true);
  assert.strictEqual(status.pauseKind, 'restart');
  assert.strictEqual(restarted.store.get(running.Id).State, 'queued');
  assert.strictEqual(status.maxConcurrent, 1);
  await handleApi(restarted.scheduler, 'POST', '/api/resume', {});
  await tick();
  assert.strictEqual(restarted.store.get(running.Id).State, 'gemini');

  // Watch later is skipped by the queue until Start now.
  const later = restarted.store.jobs.find((j) => j.VideoId === 'EEEEEEEEEEE');
  assert.strictEqual(later.State, 'queued');
  await handleApi(restarted.scheduler, 'POST', '/api/start-job', { jobId: later.Id });
  assert.strictEqual(later.WatchLater, false);

  // "Stop helper" stops the running video back into the queue and holds everything.
  await handleApi(restarted.scheduler, 'POST', '/api/stop', {});
  await tick(); await tick();
  assert.strictEqual(restarted.store.get(running.Id).State, 'queued');
  assert.strictEqual(restarted.scheduler.status().paused, true);

  // Settings persist and feed the pipeline.
  const saved = await handleApi(restarted.scheduler, 'POST', '/api/settings', { enabledProviders: ['Claude', 'ChatGPT'] });
  assert.deepStrictEqual(saved.enabledProviders, ['ChatGPT', 'Claude']);
  assert.deepStrictEqual(new JobStore(dir).loadSettings().enabledProviders, ['ChatGPT', 'Claude']);
  await assert.rejects(handleApi(restarted.scheduler, 'POST', '/api/settings', { enabledProviders: [] }), (e) => e.status === 400);
  await assert.rejects(handleApi(restarted.scheduler, 'POST', '/api/jobs', { videoId: 'bad', requestId: 'x' }), (e) => e.status === 400);
  await assert.rejects(handleApi(restarted.scheduler, 'POST', '/api/nope', {}), (e) => e.status === 404);
}

function testStatusMapping() {
  const job = {};
  applyStatus(job, 'Chunk part 2/3: starting.');
  assert.strictEqual(job.Progress, 'Part 2 of 3');
  applyStatus(job, 'Chunk part 2/3: done via ChatGPT.');
  assert.strictEqual(job.SuccessfulParts, 2);
  applyStatus(job, 'Combining 3 parts into the final summary.');
  applyStatus(job, 'Sending to Claude...');
  assert.strictEqual(job.State, 'combining', 'the merge stage stays "combining" while sending');
}

function testServedPage() {
  const page = buildDashboard({ seedToken: 'seed-token' });
  assert.deepStrictEqual(page.missing, [], 'every remote wording change must still match the Windows files');
  assert.match(page.html, /<span>remote server<\/span>/);
  assert.match(page.html, /const k="seed-token"/);
  assert.match(page.html, /setItem\('yt-summary-token',k\)/, 'the key is stored where app.js reads it');
  assert.match(page.html, /<script src="\/remote-extras.js" defer><\/script>/);
  assert.match(page.script, /'Open summary'/);
  assert.match(page.script, /element.dataset.jobId = job.Id;/, 'tiles carry their job id for the viewer');
  assert.match(page.html, /#full-result-text \{ min-height: 1280px;/);
  assert.match(page.html, /<link rel="stylesheet" href="\/remote-responsive.css">\n<\/head>/);
  assert.match(page.script, /Title: \u2068\$\{job.Title\}\u2069/, 'titles are direction-isolated');
  // No user-visible string (quoted literal) may still point at the Windows launcher/browser.
  assert.doesNotMatch(page.script, /'[^'\n]*(Start YT Summary|launcher|dedicated browser|local helper|local controller)[^'\n]*'/);
  assert.doesNotMatch(buildDashboard().html, /seed-token/);
}

async function testServerRoutes() {
  const { createServer } = require('../server');
  const { server } = createServer({ token: 'route-test-token', runner: controllableRunner().runner, stateDir: tmpDir() });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.strictEqual((await fetch(`${base}/api/status`)).status, 401);
    const status = await fetch(`${base}/api/status`, { headers: { 'X-YT-Token': 'route-test-token' } });
    assert.strictEqual(status.status, 200);
    assert.strictEqual((await status.json()).app, 'YT Summary');
    const created = await fetch(`${base}/api/jobs`, {
      method: 'POST', headers: { 'X-YT-Token': 'route-test-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoId: 'FFFFFFFFFFF', requestId: crypto.randomUUID() }),
    });
    assert.strictEqual((await created.json()).VideoId, 'FFFFFFFFFFF');
    assert.strictEqual((await fetch(`${base}/app.js`)).status, 200, 'dashboard code is served like on Windows');
    const css = await fetch(`${base}/remote-responsive.css`);
    assert.strictEqual(css.headers.get('content-type'), 'text/css; charset=utf-8');
    assert.match(await css.text(), /@media \(max-width: 759px\)/);
    assert.strictEqual((await fetch(`${base}/server.js`)).status, 401, 'only the listed static files are public');
    const page = await fetch(`${base}/`, { headers: { Cookie: 'ytsum_token=route-test-token' } });
    const pageText = await page.text();
    assert.match(pageText, /Video jobs/);
    // app.js requires a 64-hex key: the page is seeded with the derived one, which also works.
    const { dashboardToken } = require('../server');
    const derived = dashboardToken('route-test-token');
    assert.match(derived, /^[a-f0-9]{64}$/);
    assert.ok(pageText.includes(derived));
    assert.strictEqual((await fetch(`${base}/api/status`, { headers: { 'X-YT-Token': derived } })).status, 200);
    const loginDerived = await fetch(`${base}/login`, { method: 'POST', body: new URLSearchParams({ token: derived }), redirect: 'manual' });
    assert.strictEqual(loginDerived.status, 303, 'a bookmark link carrying the dashboard key logs in too');
    const simple = await fetch(`${base}/simple`, { headers: { Cookie: 'ytsum_token=route-test-token' } });
    assert.match(await simple.text(), /YT Summary Remote/);
    const login = await (await fetch(`${base}/`)).text();
    assert.match(login, /location\.hash/, 'the login form carries a #token= bookmark link through');
    const run = await fetch(`${base}/run`, {
      method: 'POST', headers: { Authorization: 'Bearer route-test-token' }, body: JSON.stringify({ videoId: 'GGGGGGGGGGG' }),
    });
    const { jobId } = await run.json();
    const simpleStatus = await (await fetch(`${base}/status?jobId=${jobId}`, { headers: { Authorization: 'Bearer route-test-token' } })).json();
    assert.ok(['queued', 'running'].includes(simpleStatus.state));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

module.exports = async function run() {
  await testLifecycle();
  await testFailuresAndRetries();
  await testHoldsAndSettings();
  testStatusMapping();
  testServedPage();
  await testServerRoutes();
};

if (require.main === module) {
  module.exports().then(() => console.log('dashboard API checks passed'), (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
