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
// A store whose settings run one video at a time (what most of these flows assert).
function serialStore(dir = tmpDir()) {
  const store = new JobStore(dir);
  if (!fs.existsSync(path.join(dir, 'settings.json'))) store.saveSettings({ ...store.loadSettings(), maxConcurrent: 1 });
  return store;
}

// A runner whose videos finish only when the test says so.
function controllableRunner() {
  const pending = new Map();
  const statuses = new Map();
  const runner = (args, onStatus) => new Promise((resolve, reject) => {
    statuses.set(args.videoId, onStatus);
    onStatus('Fetching transcript...');
    onStatus('Transcript fetched (1234 chars).');
    onStatus('Chunk part 1/2: starting.');
    onStatus('Sending to Gemini...');
    args.onInfo({ title: 'Real title', durationSeconds: 3600 });
    pending.set(args.videoId, { resolve, reject, args });
    args.signal.addEventListener('abort', () => reject(Object.assign(new Error('Stopped at your request.'), { stopped: true })));
  });
  return { runner, pending, statusOf: (videoId) => statuses.get(videoId) };
}

function makeScheduler(dir = tmpDir(), runner = controllableRunner().runner) {
  const store = serialStore(dir);
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
  // "Retry all failed" brings back failed videos from any day.
  job.CreatedAt = '2020-01-01T00:00:00.000Z';
  assert.deepStrictEqual(await handleApi(scheduler, 'POST', '/api/retry-failed', {}), { retried: 1 });
  await tick();
  assert.notStrictEqual(job.State, 'error');
  assert.strictEqual(job.AutoRetryAttempts, 0, 'a manual retry gets a fresh automatic-retry budget');
  fake.pending.get('CCCCCCCCCCC').reject(new Error('No caption tracks are available for this video.'));
  await tick(); await tick();
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
  assert.match(page.script, /row.source.className = 'job-source'/, 'tiles show where the video came from');
  assert.match(page.script, /\$\{job.SourceTitle \|\| ''\}`.toLowerCase\(\)/, 'search matches the source name');
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

async function testImportList() {
  const { normalizeListUrl, listVideos } = require('../import-list');
  assert.deepStrictEqual(normalizeListUrl('https://www.youtube.com/playlist?list=PLabc_123'),
    { kind: 'playlist', url: 'https://www.youtube.com/playlist?list=PLabc_123' });
  assert.strictEqual(normalizeListUrl('https://youtube.com/watch?v=AAAAAAAAAAA&list=PLxyz').kind, 'playlist', 'a video link inside a playlist means the playlist');
  assert.deepStrictEqual(normalizeListUrl('https://www.youtube.com/@SomeChannel'), { kind: 'channel', url: 'https://www.youtube.com/@SomeChannel/videos' });
  assert.strictEqual(normalizeListUrl('https://m.youtube.com/@SomeChannel/featured').url, 'https://www.youtube.com/@SomeChannel/videos');
  assert.strictEqual(normalizeListUrl('https://www.youtube.com/channel/UCzfDH06s9l74j37DvqMUycg/streams').url,
    'https://www.youtube.com/channel/UCzfDH06s9l74j37DvqMUycg/streams');
  for (const bad of ['https://youtu.be/AAAAAAAAAAA', 'https://example.com/@x', 'not a link']) {
    assert.throws(() => normalizeListUrl(bad), (e) => e.status === 400, bad);
  }

  let lastArgs;
  const entries = [
    { id: 'AAAAAAAAAAA', title: 'One', duration: 60 },
    { id: 'BBBBBBBBBBB', title: 'Upcoming', live_status: 'is_upcoming' },
    { id: 'AAAAAAAAAAA', title: 'Duplicate entry' },
    { id: 'CCCCCCCCCCC', title: 'Three', duration: 3600.4 },
    { id: 'DDDDDDDDDDD', title: 'Four' },
  ];
  const fakeYtDlp = async (args) => { lastArgs = args; return JSON.stringify({ title: 'My channel', entries }); };
  const listed = await listVideos('https://www.youtube.com/@x', { limit: 2 }, { runYtDlp: fakeYtDlp });
  assert.deepStrictEqual(listed.videos.map((v) => v.videoId), ['AAAAAAAAAAA', 'CCCCCCCCCCC'], 'latest N, skipping upcoming and repeats');
  assert.strictEqual(listed.videos[1].durationSeconds, 3600);
  assert.ok(lastArgs.includes('--flat-playlist') && lastArgs[lastArgs.indexOf('--playlist-end') + 1] === '22', 'extra entries so skipped streams do not reduce the count');
  await listVideos('https://www.youtube.com/@x', { limit: 7.8 }, { runYtDlp: fakeYtDlp });
  assert.strictEqual(lastArgs[lastArgs.indexOf('--playlist-end') + 1], '27', 'a typed number is used as a whole number (7 + 20 spare)');
  await listVideos('https://www.youtube.com/@x', { limit: 999 }, { runYtDlp: fakeYtDlp });
  assert.strictEqual(lastArgs[lastArgs.indexOf('--playlist-end') + 1], '1019', 'no upper limit for channels (999 + 20 spare)');
  await listVideos('https://www.youtube.com/playlist?list=PLa', { limit: 1 }, { runYtDlp: fakeYtDlp });
  assert.strictEqual(lastArgs[lastArgs.indexOf('--playlist-end') + 1], '200', 'a playlist takes all its videos (up to 200)');

  // Import: each video its own job; one already summarized at this level is skipped.
  const fake = controllableRunner();
  const store = new JobStore(tmpDir());
  const scheduler = new Scheduler({
    store, runner: fake.runner, fetchTitle: async () => '',
    listVideos: async () => ({ kind: 'channel', title: 'My channel', videos: [
      { videoId: 'AAAAAAAAAAA', title: 'One', durationSeconds: 60 },
      { videoId: 'CCCCCCCCCCC', title: 'Three', durationSeconds: 3600 },
      { videoId: 'DDDDDDDDDDD', title: 'Four', durationSeconds: 0 },
    ] }),
  });
  const done = await add(scheduler, 'AAAAAAAAAAA', { summaryLevel: 'reg' });
  await tick();
  fake.pending.get('AAAAAAAAAAA').resolve({ text: 'x', provider: 'Claude' });
  await tick(); await tick();
  assert.strictEqual(done.State, 'completed');
  const other = await add(scheduler, 'DDDDDDDDDDD', { summaryLevel: 'reg' });

  const result = await handleApi(scheduler, 'POST', '/api/import', { url: 'https://www.youtube.com/@x', limit: 5, summaryLevel: 'reg' });
  assert.deepStrictEqual(
    { found: result.found, added: result.added, alreadyDone: result.alreadyDone, alreadyListed: result.alreadyListed },
    { found: 3, added: 1, alreadyDone: 1, alreadyListed: 1 });
  const added = store.jobs.find((j) => j.VideoId === 'CCCCCCCCCCC');
  assert.strictEqual(added.Title, 'Three');
  assert.deepStrictEqual({ kind: added.SourceKind, title: added.SourceTitle }, { kind: 'channel', title: 'My channel' }, 'the job knows where it came from');
  assert.strictEqual(done.SourceTitle, 'My channel', 'an existing job without a source gets labeled');
  assert.deepStrictEqual((await handleApi(scheduler, 'POST', '/api/details', { jobId: added.Id })).source.title, 'My channel');
  assert.strictEqual(added.DurationSeconds, 3600);
  assert.strictEqual(store.jobs.filter((j) => j.VideoId === 'AAAAAAAAAAA').length, 1, 'no second job for a summarized video');
  assert.ok(other);

  // A different level is a different summary, so it is added.
  const ultra = await handleApi(scheduler, 'POST', '/api/import', { url: 'https://www.youtube.com/@x', limit: 5, summaryLevel: 'ultra' });
  assert.strictEqual(ultra.added, 3);
  await assert.rejects(handleApi(scheduler, 'POST', '/api/import', { url: '' }), (e) => e.status === 400);

  // Imported lists are remembered: one entry per link, updated by later imports.
  let { sources } = await handleApi(scheduler, 'GET', '/api/sources', null);
  assert.strictEqual(sources.length, 1, 'importing the same link twice keeps one saved entry');
  assert.deepStrictEqual({ kind: sources[0].kind, title: sources[0].title, limit: sources[0].limit, level: sources[0].summaryLevel },
    { kind: 'channel', title: 'My channel', limit: 5, level: 'ultra' });
  assert.strictEqual(sources[0].lastResult.added, 3);

  // Checking it again adds nothing new: every video already has a job at that level.
  const before = store.jobs.length;
  const labelOnly = await handleApi(scheduler, 'POST', '/api/sources/run', { id: sources[0].id, labelOnly: true });
  assert.strictEqual(labelOnly.added, 0);
  assert.strictEqual(store.jobs.length, before, 'label-only adds nothing');
  const again = await handleApi(scheduler, 'POST', '/api/sources/run', { id: sources[0].id });
  assert.deepStrictEqual({ added: again.added, skipped: again.alreadyDone + again.alreadyListed }, { added: 0, skipped: 3 });

  const updated = await handleApi(scheduler, 'POST', '/api/sources/update', { id: sources[0].id, limit: 20, summaryLevel: 'min' });
  assert.deepStrictEqual({ limit: updated.limit, level: updated.summaryLevel }, { limit: 20, level: 'min' });
  assert.strictEqual((await handleApi(scheduler, 'POST', '/api/sources/update', { id: sources[0].id, limit: 120 })).limit, 120, 'more than 50 is allowed');
  await handleApi(scheduler, 'POST', '/api/sources/update', { id: sources[0].id, limit: 20 });
  await assert.rejects(handleApi(scheduler, 'POST', '/api/sources/update', { id: sources[0].id, limit: 0 }), (e) => e.status === 400);
  const all = await handleApi(scheduler, 'POST', '/api/sources/run-all', {});
  assert.strictEqual(all.results[0].added, 3, 'check all uses the saved (now Min) level');

  await handleApi(scheduler, 'POST', '/api/sources/delete', { id: sources[0].id });
  ({ sources } = await handleApi(scheduler, 'GET', '/api/sources', null));
  assert.strictEqual(sources.length, 0);
  assert.ok(store.jobs.length >= 7, 'removing a saved list keeps its videos and summaries');
  await assert.rejects(handleApi(scheduler, 'POST', '/api/sources/run', { id: 'gone' }), (e) => e.status === 409);
}

async function testNewVideoCounts() {
  // The channel's newest-first list; tests change it between checks.
  let channel = ['V3xxxxxxxxx', 'V2xxxxxxxxx', 'V1xxxxxxxxx'];
  let playlist = ['P1xxxxxxxxx', 'P2xxxxxxxxx'];
  const fake = controllableRunner();
  const store = new JobStore(tmpDir());
  const scheduler = new Scheduler({
    store, runner: fake.runner, fetchTitle: async () => '',
    listVideos: async (url, { limit }) => {
      const ids = url.includes('playlist') ? playlist : channel;
      return { kind: url.includes('playlist') ? 'playlist' : 'channel', url, title: 'T', videos: ids.slice(0, url.includes('playlist') ? 200 : limit).map((videoId) => ({ videoId, title: videoId, durationSeconds: 0 })) };
    },
  });
  const chanUrl = 'https://www.youtube.com/@c/videos';
  const listUrl = 'https://www.youtube.com/playlist?list=PLx';
  await handleApi(scheduler, 'POST', '/api/import', { url: chanUrl, limit: 2, summaryLevel: 'reg' }); // takes V3, V2
  await handleApi(scheduler, 'POST', '/api/import', { url: listUrl, summaryLevel: 'reg' });
  let { sources } = await handleApi(scheduler, 'GET', '/api/sources', null);
  const chan = sources.find((x) => x.kind === 'channel');
  const list = sources.find((x) => x.kind === 'playlist');
  assert.strictEqual(chan.pending.count, 0, 'right after an import nothing is new');

  // Nothing uploaded yet: V1 is older than what was imported, so it is not "new".
  let peek = await handleApi(scheduler, 'POST', '/api/sources/peek', { id: chan.id });
  assert.strictEqual(peek.count, 0);

  // Three uploads on the channel, two videos added to the playlist.
  channel = ['V6xxxxxxxxx', 'V5xxxxxxxxx', 'V4xxxxxxxxx', ...channel];
  playlist = [...playlist, 'P3xxxxxxxxx', 'P4xxxxxxxxx'];
  const all = await handleApi(scheduler, 'POST', '/api/sources/peek', {});
  assert.deepStrictEqual(all.results.map((r) => r.count).sort(), [2, 3]);
  ({ sources } = await handleApi(scheduler, 'GET', '/api/sources', null));
  assert.deepStrictEqual(sources.find((x) => x.id === chan.id).pending.ids, ['V6xxxxxxxxx', 'V5xxxxxxxxx', 'V4xxxxxxxxx']);
  assert.strictEqual(store.jobs.length, 4, 'counting never adds jobs');

  // One of the new ones gets summarized some other way: it no longer counts.
  await add(scheduler, 'V4xxxxxxxxx', { summaryLevel: 'reg' });
  peek = await handleApi(scheduler, 'POST', '/api/sources/peek', { id: chan.id });
  assert.deepStrictEqual(peek.ids, ['V6xxxxxxxxx', 'V5xxxxxxxxx']);

  // A third upload: 3 new videos against a saved "latest 2"; "Add new videos" must take all 3.
  channel = ['V7xxxxxxxxx', ...channel];
  peek = await handleApi(scheduler, 'POST', '/api/sources/peek', { id: chan.id });
  assert.strictEqual(peek.count, 3);
  const run = await handleApi(scheduler, 'POST', '/api/sources/run', { id: chan.id });
  assert.strictEqual(run.added, 3, 'all new videos are added, not just the latest 2');
  ({ sources } = await handleApi(scheduler, 'GET', '/api/sources', null));
  const after = sources.find((x) => x.id === chan.id);
  assert.strictEqual(after.limit, 2, 'the saved "latest N" setting is kept');
  assert.strictEqual(after.pending.count, 0);
  peek = await handleApi(scheduler, 'POST', '/api/sources/peek', { id: list.id });
  assert.deepStrictEqual(peek.ids, ['P3xxxxxxxxx', 'P4xxxxxxxxx']);
}

async function testSearch() {
  const { findMatches, buildPassages } = require('../search');
  assert.strictEqual(findMatches('הַלּוּלָב והלולב', 'לולב').length, 2, 'vowel marks are ignored');
  assert.strictEqual(findMatches('The  Lulav\nwas', 'lulav was').length, 1, 'case and whitespace are ignored');
  const home = 'Home sweet home. Home Alone is a film. At home alone again; home.';
  assert.strictEqual(findMatches(home, 'home').length, 5);
  assert.strictEqual(findMatches(home, 'home', ['home alone']).length, 3, '"home" inside "home alone" is left out');
  assert.strictEqual(findMatches(home, 'home', ['home alone', 'sweet home']).length, 2, 'several "not" phrases');
  assert.strictEqual(findMatches(home, 'home', ['  ']).length, 5, 'an empty "not" is ignored');
  const words = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}`).join(' ');
  const text = `אתרוג ${words(40, 'a')} אתרוג ${words(10, 'b')} אתרוג ${words(100, 'c')} אתרוג`;
  const passages = buildPassages(text, findMatches(text, 'אתרוג'), 30);
  assert.deepStrictEqual(passages.map((p) => p.rangeIndexes), [[0, 1, 2], [3]], 'nearby matches merge; a far one stands alone');
  assert.ok(passages[0].clippedAfter && !passages[0].clippedBefore && passages[1].clippedBefore);
  assert.strictEqual(passages[0].text.split(' ').pop(), 'c29', 'the merged passage ends 30 words after its LAST match');

  const fake = controllableRunner();
  const store = new JobStore(tmpDir());
  const scheduler = new Scheduler({ store, runner: fake.runner, fetchTitle: async () => '' });
  const a = await add(scheduler, 'AAAAAAAAAAA', { title: 'First' });
  await tick();
  fake.pending.get('AAAAAAAAAAA').resolve({ text: 'הסיכום מדבר על הלולב', provider: 'Claude',
    parts: [{ index: 1, provider: 'ChatGPT', text: 'חלק על הלולב והאתרוג', url: null }] });
  await tick(); await tick();
  const b = await add(scheduler, 'BBBBBBBBBBB', { title: 'Second' });
  await tick();
  fake.pending.get('BBBBBBBBBBB').resolve({ text: 'עוד לולב כאן', provider: 'Gemini' });
  await tick(); await tick();
  await add(scheduler, 'CCCCCCCCCCC'); // still running: no text, not searchable

  const { videos } = await handleApi(scheduler, 'GET', '/api/search/videos', null);
  assert.deepStrictEqual(videos.map((v) => v.videoId).sort(), ['AAAAAAAAAAA', 'BBBBBBBBBBB']);

  let r = await handleApi(scheduler, 'POST', '/api/search', { query: 'לולב' });
  assert.deepStrictEqual({ searched: r.searched, matches: r.matches, videos: r.results.length }, { searched: 2, matches: 3, videos: 2 });
  assert.strictEqual(r.results[0].videoId, 'AAAAAAAAAAA', 'most matches first');
  assert.deepStrictEqual(r.results[0].sections.map((x) => x.key), ['final', 'part-1']);
  const hit = r.results[0].sections[0].passages[0];
  assert.strictEqual(hit.text.slice(...hit.highlights[0]), 'לולב');

  r = await handleApi(scheduler, 'POST', '/api/search', { query: 'לולב', jobIds: [b.Id] });
  assert.deepStrictEqual(r.results.map((x) => x.videoId), ['BBBBBBBBBBB'], 'only the chosen videos are searched');
  r = await handleApi(scheduler, 'POST', '/api/search', { query: 'אתרוג', jobIds: [a.Id, b.Id] });
  assert.deepStrictEqual(r.results[0].sections.map((x) => x.key), ['part-1'], 'parts are searched too');
  r = await handleApi(scheduler, 'POST', '/api/search', { query: 'לולב', exclude: ['על הלולב'] });
  assert.strictEqual(r.matches, 1, 'the API applies "not" phrases (only "עוד לולב כאן" is left)');
  assert.deepStrictEqual(r.exclude, ['על הלולב']);
  await assert.rejects(handleApi(scheduler, 'POST', '/api/search', { query: 'a' }), (e) => e.status === 400);

  // Saved searches keep the filters and the results as they were.
  const saved = await handleApi(scheduler, 'POST', '/api/searches/save',
    { query: 'לולב', exclude: ['על הלולב'], contextWords: 20, jobIds: [a.Id, b.Id] });
  assert.strictEqual(saved.name, 'לולב, not "על הלולב"', 'a default name from the filters');
  assert.deepStrictEqual({ matches: saved.matches, videos: saved.videos, context: saved.contextWords, ids: saved.jobIds.length },
    { matches: 1, videos: 1, context: 20, ids: 2 });
  assert.strictEqual(saved.results, undefined, 'the save answer is a summary, not the whole result set');
  let { searches } = await handleApi(scheduler, 'GET', '/api/searches', null);
  assert.strictEqual(searches.length, 1);
  assert.strictEqual(searches[0].results, undefined, 'the list stays light');
  const full = await handleApi(scheduler, 'POST', '/api/searches/get', { id: saved.id });
  assert.strictEqual(full.results.results[0].videoId, 'BBBBBBBBBBB', 'opening shows the stored results');

  // Update in place (same id, new name/results) and save another.
  const updated = await handleApi(scheduler, 'POST', '/api/searches/save', { id: saved.id, name: 'Lulav only', query: 'לולב' });
  assert.deepStrictEqual({ id: updated.id, name: updated.name, matches: updated.matches }, { id: saved.id, name: 'Lulav only', matches: 3 });
  await handleApi(scheduler, 'POST', '/api/searches/save', { query: 'אתרוג' });
  ({ searches } = await handleApi(scheduler, 'GET', '/api/searches', null));
  assert.strictEqual(searches.length, 2);

  await handleApi(scheduler, 'POST', '/api/searches/delete', { id: saved.id });
  ({ searches } = await handleApi(scheduler, 'GET', '/api/searches', null));
  assert.deepStrictEqual(searches.map((x) => x.query), ['אתרוג']);
  await assert.rejects(handleApi(scheduler, 'POST', '/api/searches/get', { id: saved.id }), (e) => e.status === 409);
  await assert.rejects(handleApi(scheduler, 'POST', '/api/searches/save', { id: saved.id, query: 'לולב' }), (e) => e.status === 409);
}

async function testParallel() {
  const fake = controllableRunner();
  const store = new JobStore(tmpDir()); // default settings: 3 at once
  let free = 8000;
  const scheduler = new Scheduler({ store, runner: fake.runner, fetchTitle: async () => '', memoryAvailable: () => free });
  assert.strictEqual(scheduler.status().maxConcurrent, 3);
  const ids = ['P1xxxxxxxxx', 'P2xxxxxxxxx', 'P3xxxxxxxxx', 'P4xxxxxxxxx'];
  for (const id of ids) await add(scheduler, id);
  await tick();
  const state = () => ids.map((id) => store.jobs.find((j) => j.VideoId === id).State);
  assert.deepStrictEqual(state(), ['gemini', 'gemini', 'gemini', 'queued'], 'three videos run at once, the 4th waits');
  fake.pending.get('P2xxxxxxxxx').resolve({ text: 'x', provider: 'Claude' });
  await tick(); await tick();
  assert.deepStrictEqual(state(), ['gemini', 'completed', 'gemini', 'gemini'], 'a free slot starts the next one');

  // Stopping one running video leaves the others running.
  await handleApi(scheduler, 'POST', '/api/stop-job', { jobId: store.jobs.find((j) => j.VideoId === 'P1xxxxxxxxx').Id });
  await tick(); await tick();
  assert.deepStrictEqual(state(), ['cancelled', 'completed', 'gemini', 'gemini']);

  // Low memory: no additional parallel videos start (one always may).
  free = 900;
  await add(scheduler, 'P5xxxxxxxxx');
  await tick();
  assert.strictEqual(store.jobs.find((j) => j.VideoId === 'P5xxxxxxxxx').State, 'queued', 'low memory holds extra videos');
  free = 8000;
  fake.pending.get('P3xxxxxxxxx').resolve({ text: 'x', provider: 'Claude' });
  await tick(); await tick();
  assert.strictEqual(store.jobs.find((j) => j.VideoId === 'P5xxxxxxxxx').State, 'gemini');

  // The setting: 1 at a time; validation.
  const saved = await handleApi(scheduler, 'POST', '/api/settings', { maxConcurrent: 1 });
  assert.strictEqual(saved.maxConcurrent, 1);
  await assert.rejects(handleApi(scheduler, 'POST', '/api/settings', { maxConcurrent: 4 }), (e) => e.status === 400);
  ['P4xxxxxxxxx', 'P5xxxxxxxxx'].forEach((id) => fake.pending.get(id).resolve({ text: 'x', provider: 'Claude' }));
  await tick(); await tick();

  // A due browser restart waits until every running video has finished.
  const store2 = new JobStore(tmpDir());
  let restarts = 0;
  const s2 = new Scheduler({ store: store2, runner: fake.runner, fetchTitle: async () => '', recycleBrowser: async () => { restarts++; }, memoryAvailable: () => 8000 });
  s2.videosSinceRecycle = 9;
  for (const id of ['Q1xxxxxxxxx', 'Q2xxxxxxxxx']) await add(s2, id);
  await tick();
  fake.pending.get('Q1xxxxxxxxx').resolve({ text: 'x', provider: 'Claude' });
  await tick(); await tick();
  assert.strictEqual(restarts, 0, 'not while Q2 still uses the browser');
  fake.pending.get('Q2xxxxxxxxx').resolve({ text: 'x', provider: 'Claude' });
  await tick(); await tick();
  assert.strictEqual(restarts, 1, 'restarted once both finished');
}

async function testProviderPool() {
  const { ProviderPool } = require('../rotate');
  const pool = new ProviderPool();
  const order = ['ChatGPT', 'Gemini', 'Claude'];
  const a = await pool.acquire(order, new Set());
  const b = await pool.acquire(order, new Set());
  assert.deepStrictEqual([a, b], ['ChatGPT', 'Gemini'], 'a busy provider is skipped for a free one');
  const c = await pool.acquire(order, new Set(['Gemini']));
  assert.strictEqual(c, 'Claude');
  let got = null;
  const waiting = pool.acquire(order, new Set()).then((p) => { got = p; });
  await tick();
  assert.strictEqual(got, null, 'all busy: it waits');
  pool.release('Gemini');
  await waiting;
  assert.strictEqual(got, 'Gemini', 'the released provider goes to the waiter');
  assert.strictEqual(await pool.acquire(order, new Set(order)), null, 'nothing left to try');
}

async function testBrowserRecycling() {
  const fake = controllableRunner();
  const store = serialStore();
  let recycles = 0;
  let finishRecycle;
  const scheduler = new Scheduler({
    store, runner: fake.runner, fetchTitle: async () => '',
    recycleBrowser: () => { recycles++; return new Promise((r) => { finishRecycle = r; }); },
  });
  const ids = Array.from({ length: 12 }, (_, i) => `R${String(i).padStart(2, '0')}xxxxxxxx`);
  for (const id of ids) await add(scheduler, id);
  for (let i = 0; i < 9; i++) {
    await tick();
    fake.pending.get(ids[i]).resolve({ text: 'x', provider: 'Claude' });
    await tick(); await tick();
  }
  assert.strictEqual(recycles, 0, 'no restart before 10 videos');
  await tick();
  fake.pending.get(ids[9]).resolve({ text: 'x', provider: 'Claude' });
  await tick(); await tick();
  assert.strictEqual(recycles, 1, 'the browser restarts after 10 videos');
  assert.strictEqual(store.jobs.find((j) => j.VideoId === ids[10]).State, 'queued', 'the next video waits for the restart');
  assert.match(scheduler.status().browserMessage, /Restarting the server browser/);
  finishRecycle();
  await tick(); await tick();
  assert.strictEqual(store.jobs.find((j) => j.VideoId === ids[10]).State, 'gemini', 'the queue continues after the restart');

  // A freeze (every provider failed with infrastructure errors) restarts it at once.
  const job = store.jobs.find((j) => j.VideoId === ids[10]);
  // Replay what rotate.js reports when the browser stops answering, then the retryable stop.
  const onStatusLines = ['ChatGPT', 'Gemini', 'Claude'].map((p) => `${p}: transient infrastructure error persisted after 3 attempts; rotating.`);
  onStatusLines.forEach((line) => fake.statusOf(ids[10])(line));
  fake.pending.get(ids[10]).reject(Object.assign(new Error('STOPPED (retryable): Chunk part 1 failed on every provider'), { retryable: true }));
  await tick(); await tick();
  assert.strictEqual(recycles, 2, 'a frozen browser is restarted right away');
  assert.match(job.Message, /stopped responding/);
  assert.ok(job.AutoRetryAfterUtc, 'the frozen video retries automatically');
  finishRecycle();
  await tick();
}

module.exports = async function run() {
  await testLifecycle();
  await testFailuresAndRetries();
  await testHoldsAndSettings();
  testStatusMapping();
  testServedPage();
  await testServerRoutes();
  await testImportList();
  await testNewVideoCounts();
  await testSearch();
  await testBrowserRecycling();
  await testParallel();
  await testProviderPool();
};

if (require.main === module) {
  module.exports().then(() => console.log('dashboard API checks passed'), (error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}
