'use strict';

const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {test} = require('node:test');

const root = path.resolve(__dirname, '..');
const source = readFileSync(path.join(root, 'app.js'), 'utf8');
const html = readFileSync(path.join(root, 'index.html'), 'utf8');
const token = 'd'.repeat(64);
const origin = 'http://127.0.0.1:45678';
const fixtureNow = 1789578000000;
class FixtureDate extends Date {
  constructor(...args) { super(...(args.length ? args : [fixtureNow])); }
  static now() { return fixtureNow; }
}
const job = (id, state = 'queued', url) => ({
  Id: id, VideoId: 'vid00000001', State: state, Message: `Fixture ${state}.`, ResultUrl: url, SummaryLevel: 'ultra',
  Title: 'Fixture video title', DurationSeconds: 754, ChunkCount: 3,
  CreatedAt: '/Date(1789576800000)/', UpdatedAt: '/Date(1789577100000)/'
});
const settle = () => new Promise(resolve => setImmediate(resolve));

class Element {
  constructor(tag = 'div') {
    this.tagName = tag;
    this.textContent = '';
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.events = new Map();
    this.classes = new Set();
    this.dataset = {};
    this.classList = {toggle: (name, enabled) => enabled ? this.classes.add(name) : this.classes.delete(name)};
  }
  append(...children) {
    for (const child of children) { child.parentNode = this; this.children.push(child); }
  }
  remove() { this.parentNode.children = this.parentNode.children.filter(child => child !== this); this.parentNode = null; }
  removeAttribute(name) { delete this[name]; }
  addEventListener(name, handler) { this.events.set(name, handler); }
  async click() {
    if (!this.disabled) return this.events.get('click')?.({preventDefault() {}});
  }
  async change(value) {
    if (!this.disabled) { this.value = value; return this.events.get('change')?.(); }
  }
  async type(value) {
    if (!this.disabled) { this.value = value; return this.events.get('input')?.(); }
  }
  focus() {}
  select() {}
}

async function dashboard(initial, options = {}) {
  const elements = new Map();
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/gi)) {
    const element = new Element(match[1]);
    element.hidden = /\bhidden(?:\s|>|=)/.test(match[0]);
    element.disabled = /\bdisabled(?:\s|>|=)/.test(match[0]);
    elements.set(match[2], element);
  }
  const values = new Map([
    ['yt-summary-token', token],
    ['yt-summary-selected-job', 'selected'],
    ...Object.entries(options.saved || {})
  ]);
  const calls = [];
  const confirmations = [];
  const alerts = [];
  const prompts = [];
  let promptResult = options.promptResult === undefined ? null : options.promptResult;
  const timers = [];
  const documentEvents = new Map();
  const windowEvents = new Map();
  const windowOpenCalls = [];
  const defaultLocal = options.useFilterDefaults ? {} : {
    'yt-summary-status-filters': JSON.stringify({
      queued: true, active: true, attention: true, completed: true,
      failed: true, other: true, todayOnly: true, watchLaterOnly: false
    })
  };
  const localValues = new Map(Object.entries({...defaultLocal, ...(options.local || {})}));
  let data = initial;
  let failure = options.failure || null;
  let confirmResult = true;
  let navigated = null;
  const context = {
    document: {
      hidden: false,
      getElementById: id => elements.get(id),
      createElement: tag => new Element(tag),
      addEventListener: (name, handler) => documentEvents.set(name, handler)
    },
    window: {addEventListener: (name, handler) => windowEvents.set(name, handler),
      open: (...args) => { windowOpenCalls.push(args); }},
    location: {origin, hash: options.hash || '', assign: url => { navigated = url; }},
    history: {replaceState() {}},
    sessionStorage: {getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key)},
    localStorage: {
      getItem: key => localValues.get(key) || null,
      setItem: (key, value) => localValues.set(key, value),
      removeItem: key => localValues.delete(key)
    },
    URL, URLSearchParams, AbortSignal, Date: options.Date || FixtureDate,
    crypto: {randomUUID: () => '00000000-0000-4000-8000-000000000001'},
    navigator: {clipboard: {writeText: async () => {}}},
    confirm: text => { confirmations.push(text); return confirmResult; },
    alert: text => { alerts.push(text); },
    prompt: text => { prompts.push(text); return promptResult; },
    setTimeout: fn => { timers.push(fn); return timers.length; },
    clearTimeout() {},
    fetch: async (route, config) => {
      assert.ok(route.startsWith('/api/'), 'Dashboard calls only local relative APIs');
      calls.push({route, ...config});
      if (failure === route) throw new Error('Fixture connection failure.');
      const snapshot = data;
      if (options.onFetch) await options.onFetch(route, config);
      if (route === '/api/settings') {
        const requested = JSON.parse(config.body);
        data = {...data, ...requested};
        return {ok: true, json: async () => ({
          summaryLevel: data.summaryLevel, summaryLanguage: data.summaryLanguage,
          enabledProviders: data.enabledProviders, keepIntermediateTabs: Boolean(data.keepIntermediateTabs)
        })};
      }
      if (route === '/api/result') {
        return {ok: true, json: async () => ({finalResult: options.finalResult || 'Complete local transcript.'})};
      }
      return {ok: true, json: async () => route === '/api/status' ? snapshot :
        route === '/api/jobs' ? (options.jobResponse || job('accepted')) : {paused: false, pauseReason: ''}};
    }
  };
  vm.runInNewContext(source, context, {filename: path.join(root, 'app.js')});
  await settle();
  return {
    get: id => elements.get(id), calls, confirmations, alerts, prompts, values,
    localValues, windowOpenCalls,
    navigated: () => navigated,
    setConfirm: value => { confirmResult = value; },
    setPrompt: value => { promptResult = value; },
    fail: route => { failure = route; },
    async poll(next = data) { data = next; await timers.shift()(); await settle(); },
    async focus() { await windowEvents.get('focus')?.(); await settle(); }
  };
}

function state(overrides = {}) {
  return {ready: true, paused: false, pauseReason: '', summaryLevel: 'ultra', summaryLanguage: 'hebrew',
    jobs: [], active: 0, queued: 0,
    enabledProviders: ['ChatGPT', 'Gemini', 'Claude'], providerOrder: ['ChatGPT', 'Gemini', 'Claude'],
    keepIntermediateTabs: false,
    maxConcurrent: 20, startIntervalMilliseconds: 2000, ...overrides};
}

test('browser outage is prominent despite a selected queued video', async () => {
  const page = await dashboard(state({ready: false, jobs: [job('selected')]}));
  assert.equal(page.get('state').textContent, 'Waiting for browser');
  assert.equal(page.get('browser-unavailable').hidden, false);
  assert.equal(page.get('quota-pause').hidden, true);
  assert.equal(page.get('resume').hidden, true);
  assert.equal(page.get('jobs-active').children[0].children[0].children[1].textContent, 'queued');
});

test('quota pause and outage are independently visible, including after launch failure', async () => {
  const data = state({ready: false, paused: true, pauseReason: '<quota & reset>', jobs: [job('selected')]});
  const page = await dashboard(data);
  assert.equal(page.get('state').textContent, 'Paused for usage limit');
  assert.equal(page.get('browser-unavailable').hidden, false);
  assert.equal(page.get('quota-pause').hidden, false);
  assert.equal(page.get('pause-reason').textContent, '<quota & reset>');
  assert.equal(page.get('resume').hidden, false);
  const interrupted = await dashboard(data, {saved: {'yt-summary-launch': '{"videoId":"vid00000001","requestId":"00000000-0000-4000-8000-000000000001"}'}});
  assert.equal(interrupted.get('browser-unavailable').hidden, false);
  assert.equal(interrupted.get('quota-pause').hidden, false);
  assert.equal(interrupted.get('retry').hidden, false);
  assert.equal(interrupted.calls.filter(call => call.route === '/api/jobs').length, 0);
});

test('a restart hold is not reported as a usage limit', async () => {
  // The helper pauses itself after a restart so nothing runs unattended. Calling that a quota
  // pause told users to wait for a reset that was never going to come.
  const page = await dashboard(state({
    paused: true, pauseKind: 'restart', queued: 12,
    pauseReason: 'The helper restarted with already-queued videos.',
    jobs: [job('selected', 'queued')]
  }));
  assert.equal(page.get('state').textContent, 'Waiting for you to start');
  assert.match(page.get('message').textContent, /restarted with already-queued videos/);
  assert.equal(page.get('pause-title').textContent, 'Waiting for you to start the queued videos');
  assert.doesNotMatch(page.get('pause-advice').textContent, /quota/i);
  assert.equal(page.get('resume').textContent, 'Start 12 queued videos');
  assert.equal(page.get('quota-pause').hidden, false);
  assert.equal(page.get('resume').hidden, false);
  const usage = await dashboard(state({paused: true, pauseKind: 'usage', pauseReason: 'Quota reached.', jobs: [job('selected', 'queued')]}));
  assert.equal(usage.get('state').textContent, 'Paused for usage limit');
  assert.equal(usage.get('pause-title').textContent, 'Paused for a ChatGPT usage limit');
  assert.equal(usage.get('resume').textContent, 'Resume');
});

test('active and history sections separate in-progress jobs from terminal jobs', async () => {
  const stages = ['splitting', 'summarizing', 'combining', 'paused', 'completed', 'submitted'];
  const page = await dashboard(state({jobs: stages.map((stage, index) => job(`job${index}`, stage))}));
  const activeLabels = page.get('jobs-active').children.map(row => row.children[0].children[1].textContent);
  const historyLabels = page.get('jobs-history').children.map(row => row.children[0].children[1].textContent);
  assert.deepEqual(activeLabels, ['combining', 'summarizing', 'splitting', 'paused']);
  assert.deepEqual(historyLabels, ['submitted', 'completed']);
  assert.equal(page.get('jobs-active-block').hidden, false);
  assert.equal(page.get('jobs-history-block').hidden, false);
  assert.equal(page.get('active-count').textContent, '4');
  assert.equal(page.get('history-count').textContent, '2');
  assert.equal(page.get('resume').hidden, true, 'A paused job alone is not a global quota pause');
});

test('the history section is never collapsible; it is a plain always-visible block', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'completed')]}));
  assert.equal(page.get('jobs-history-block').tagName, 'div');
  assert.equal(page.get('jobs-history-block').hidden, false);
});

test('status filters default to hiding completed jobs while showing every other status', async () => {
  const jobs = [
    job('q', 'queued'), job('active', 'splitting'), job('paused', 'paused'), job('review', 'needs-review'),
    job('done', 'completed'), job('legacySent', 'submitted'), job('failed', 'error'),
    job('ack', 'reviewed'), job('stopped', 'cancelled')
  ];
  const page = await dashboard(state({jobs}), {useFilterDefaults: true});
  for (const id of ['status-filter-queued', 'status-filter-active', 'status-filter-attention',
    'status-filter-failed', 'status-filter-other']) {
    assert.equal(page.get(id).checked, true, `${id} is checked by default`);
  }
  assert.equal(page.get('status-filter-completed').checked, false,
    'Completed is unchecked by default');
  assert.equal(page.get('status-filter-today').checked, true, 'the today-only filter is checked by default');
  assert.equal(page.get('jobs-active').children.length, 3);
  assert.equal(page.get('jobs-history').children.length, 4);
});

test("today-only hides older jobs and combines with the selected status filters", async () => {
  const previousDay = '/Date(1789490400000)/';
  const jobs = [
    job('today-done', 'completed'),
    job('today-failed', 'error'),
    {...job('old-done', 'completed'), CreatedAt: previousDay},
    {...job('old-failed', 'error'), CreatedAt: previousDay}
  ];
  const page = await dashboard(state({jobs}));
  assert.equal(page.get('jobs-history').children.length, 2, 'old jobs are hidden by default');
  let visibleStates = page.get('jobs-history').children.map(row => row.children[0].children[1].textContent);
  assert.deepEqual(visibleStates, ['completed', 'error']);

  page.get('status-filter-failed').checked = false;
  await page.get('status-filter-failed').change();
  visibleStates = page.get('jobs-history').children.map(row => row.children[0].children[1].textContent);
  assert.deepEqual(visibleStates, ['completed'], 'a today job with a hidden status stays hidden');

  page.get('status-filter-today').checked = false;
  await page.get('status-filter-today').change();
  visibleStates = page.get('jobs-history').children.map(row => row.children[0].children[1].textContent);
  assert.deepEqual(visibleStates, ['completed', 'completed'],
    'turning today-only off restores old jobs but still applies the status filter');
});

test('hiding the Completed status filters completed/submitted cards but keeps other history visible', async () => {
  const jobs = [
    job('done', 'completed'), job('legacySent', 'submitted'), job('failed', 'error'),
    job('review', 'needs-review'), job('ack', 'reviewed'), job('stopped', 'cancelled')
  ];
  const page = await dashboard(state({jobs}));
  assert.equal(page.get('jobs-history').children.length, 6);
  page.get('status-filter-completed').checked = false;
  await page.get('status-filter-completed').change();
  const visibleLabels = page.get('jobs-history').children.map(row => row.children[0].children[1].textContent);
  assert.deepEqual(visibleLabels, ['needs-review', 'error', 'cancelled', 'reviewed']);
  assert.equal(page.get('jobs-history-block').hidden, false, 'the block stays visible so the filter can be turned back off');

  page.get('status-filter-completed').checked = true;
  await page.get('status-filter-completed').change();
  assert.equal(page.get('jobs-history').children.length, 6, 'unchecking restores every completed/submitted card');
});

test('hiding the Failed status filters error cards only', async () => {
  const jobs = [job('done', 'completed'), job('failed', 'error'), job('stopped', 'cancelled')];
  const page = await dashboard(state({jobs}));
  page.get('status-filter-failed').checked = false;
  await page.get('status-filter-failed').change();
  const visibleLabels = page.get('jobs-history').children.map(row => row.children[0].children[1].textContent);
  assert.deepEqual(visibleLabels, ['completed', 'cancelled']);
});

test('cards are grouped by status with one labelled group heading per status', async () => {
  const jobs = [
    job('q1', 'queued'), job('q2', 'queued'), job('run', 'summarizing'),
    job('done', 'completed'), job('failed1', 'error'), job('failed2', 'error')
  ];
  const page = await dashboard(state({jobs}));
  const active = page.get('jobs-active').children;
  const history = page.get('jobs-history').children;
  assert.deepEqual(active.map(row => row.className.includes('group-queued')), [true, true, false],
    'both queued cards sit together ahead of the running card');
  assert.deepEqual(active.map(row => row.dataset.groupLabel || ''), ['Queued · 2', '', 'Active · 1']);
  assert.deepEqual(history.map(row => row.dataset.groupLabel || ''),
    ['Completed · 1', 'Failed · 2', ''],
    'only the first card of each status group carries its heading and count');
  assert.equal(active.filter(row => row.className.includes('group-start')).length, 2,
    'each active status group starts exactly once');
  assert.equal(history.filter(row => row.className.includes('group-start')).length, 2,
    'each history status group starts exactly once');
});

test('the Active and History sections default to sorting by status, and each has its own sort control', async () => {
  const page = await dashboard(state({jobs: [job('done', 'completed'), job('failed', 'error')]}));
  assert.equal(page.get('active-sort').value, 'status');
  assert.equal(page.get('history-sort').value, 'status');
});

test('switching a section to "Last updated" reorders only that section, by real timestamps', async () => {
  const jobs = [
    {...job('older', 'completed'), UpdatedAt: '/Date(1789576800000)/'},
    {...job('newer', 'error'), UpdatedAt: '/Date(1789577900000)/'},
    {...job('run1', 'summarizing'), UpdatedAt: '/Date(1789576800000)/'},
    {...job('run2', 'queued'), UpdatedAt: '/Date(1789577900000)/'}
  ];
  const page = await dashboard(state({jobs}));
  await page.get('history-sort').change('updated');
  const historyIds = page.get('jobs-history').children.map(row => row.children[0].children[1].textContent);
  assert.deepEqual(historyIds, ['error', 'completed'], 'History now sorts newest-updated first, ignoring status');
  const activeIds = page.get('jobs-active').children.map(row => row.children[0].children[1].textContent);
  assert.deepEqual(activeIds, ['queued', 'summarizing'], 'Active is untouched and still grouped by status');
});

test('a non-status sort mode keeps the status tint color but drops the group heading and label', async () => {
  const jobs = [job('done', 'completed'), job('failed', 'error')];
  const page = await dashboard(state({jobs}));
  await page.get('history-sort').change('title');
  const rows = page.get('jobs-history').children;
  assert.ok(rows.every(row => row.className.includes('group-completed') || row.className.includes('group-failed')),
    'the status color class always applies regardless of sort mode');
  assert.ok(rows.every(row => !row.className.includes('group-start')),
    'grouping headings only make sense in status mode');
  assert.ok(rows.every(row => !row.dataset.groupLabel), 'no group label is set outside status mode');
});

test('job sort preference persists per section as one JSON value across a dashboard reload', async () => {
  const jobs = [job('done', 'completed'), job('failed', 'error')];
  const first = await dashboard(state({jobs}));
  await first.get('history-sort').change('created');
  const saved = JSON.parse(first.localValues.get('yt-summary-job-sort'));
  assert.equal(saved.history, 'created');
  assert.equal(saved.active, 'status', 'an untouched section keeps the default');

  const reopened = await dashboard(state({jobs}), {local: {'yt-summary-job-sort': first.localValues.get('yt-summary-job-sort')}});
  assert.equal(reopened.get('history-sort').value, 'created', 'the saved preference is restored on reload');
  assert.equal(reopened.get('active-sort').value, 'status');
});

test('length filter chips hide videos by duration bucket and default to all shown', async () => {
  const jobs = [
    {...job('short', 'completed'), DurationSeconds: 600},
    {...job('medium', 'completed'), DurationSeconds: 2400},
    {...job('long', 'completed'), DurationSeconds: 7200},
    {...job('extreme', 'completed'), DurationSeconds: 39600},
    {...job('unknown', 'completed'), DurationSeconds: 0}
  ];
  const page = await dashboard(state({jobs}));
  const bucketsOf = () => page.get('jobs-history').children.map(row => {
    const badge = row.children[1].children[5];
    return badge.hidden ? 'unknown' : badge.textContent.toLowerCase();
  });
  assert.deepEqual(bucketsOf(), ['unknown', 'extreme', 'long', 'medium', 'short'], 'every length bucket is visible by default');

  page.get('length-filter-extreme').checked = false;
  await page.get('length-filter-extreme').change();
  assert.deepEqual(bucketsOf(), ['unknown', 'long', 'medium', 'short'], 'unchecking Extreme hides only the 6h+ video');

  page.get('length-filter-unknown').checked = false;
  await page.get('length-filter-unknown').change();
  assert.deepEqual(bucketsOf(), ['long', 'medium', 'short'], 'unchecking Unknown length hides videos with no known duration');
});

test('length filter preference persists across a dashboard reload', async () => {
  const jobs = [{...job('short', 'completed'), DurationSeconds: 600}, {...job('long', 'completed'), DurationSeconds: 7200}];
  const first = await dashboard(state({jobs}));
  first.get('length-filter-long').checked = false;
  await first.get('length-filter-long').change();
  const saved = JSON.parse(first.localValues.get('yt-summary-length-filters'));
  assert.equal(saved.long, false);
  assert.equal(saved.short, true);

  const reopened = await dashboard(state({jobs}), {local: {'yt-summary-length-filters': first.localValues.get('yt-summary-length-filters')}});
  assert.equal(reopened.get('length-filter-long').checked, false, 'the saved preference is restored on reload');
  assert.equal(reopened.get('jobs-history').children.length, 1, 'the Long-duration video stays hidden after reload');
  assert.equal(reopened.get('jobs-history').children[0].children[1].children[5].textContent, 'Short');
});

test('status filter choices persist as one JSON preference across a dashboard reload', async () => {
  const first = await dashboard(state({jobs: [job('done', 'completed'), job('failed', 'error')]}));
  first.get('status-filter-completed').checked = false;
  await first.get('status-filter-completed').change();
  first.get('status-filter-failed').checked = false;
  await first.get('status-filter-failed').change();
  first.get('status-filter-today').checked = false;
  await first.get('status-filter-today').change();
  const saved = JSON.parse(first.localValues.get('yt-summary-status-filters'));
  assert.equal(saved.completed, false);
  assert.equal(saved.failed, false);
  assert.equal(saved.todayOnly, false);

  const reopened = await dashboard(state({jobs: [job('done', 'completed'), job('failed', 'error')]}),
    {local: {'yt-summary-status-filters': first.localValues.get('yt-summary-status-filters')}});
  assert.equal(reopened.get('status-filter-completed').checked, false, 'the saved preference is restored on reload');
  assert.equal(reopened.get('status-filter-failed').checked, false, 'the saved preference is restored on reload');
  assert.equal(reopened.get('status-filter-today').checked, false, 'the saved today-only preference is restored on reload');
  assert.equal(reopened.get('jobs-history').children.length, 0, 'both filtered statuses stay hidden after reload');
});

test('Watch later filter defaults off and, once on, shows only watch-later jobs combined with other filters', async () => {
  const jobs = [
    {...job('watched', 'error'), WatchLater: true},
    job('not-watched', 'error'),
    {...job('watched-done', 'completed'), WatchLater: true}
  ];
  const page = await dashboard(state({jobs}));
  assert.equal(page.get('status-filter-watch-later').checked, false, 'Watch later filtering is opt-in');
  assert.equal(page.get('jobs-history').children.length, 3, 'nothing is hidden until the filter is turned on');

  page.get('status-filter-watch-later').checked = true;
  await page.get('status-filter-watch-later').change();
  let visible = page.get('jobs-history').children.map(row => row.children[0].children[1].textContent);
  assert.deepEqual(visible, ['completed · Watch later', 'error · Watch later'], 'only jobs marked Watch later remain, in their existing order');

  page.get('status-filter-failed').checked = false;
  await page.get('status-filter-failed').change();
  visible = page.get('jobs-history').children.map(row => row.children[0].children[1].textContent);
  assert.deepEqual(visible, ['completed · Watch later'], 'Watch later AND-combines with the existing status filters');
});

test('the Watch later filter preference persists across a dashboard reload', async () => {
  const first = await dashboard(state({jobs: [{...job('watched', 'error'), WatchLater: true}]}));
  first.get('status-filter-watch-later').checked = true;
  await first.get('status-filter-watch-later').change();
  const reopened = await dashboard(state({jobs: [{...job('watched', 'error'), WatchLater: true}]}),
    {local: {'yt-summary-status-filters': first.localValues.get('yt-summary-status-filters')}});
  assert.equal(reopened.get('status-filter-watch-later').checked, true, 'the saved preference is restored on reload');
});


test('a per-section message appears when every job in that section is filtered out', async () => {
  const page = await dashboard(state({jobs: [job('done', 'completed')]}));
  assert.equal(page.get('active-filtered-empty').hidden, true, 'no active jobs exist at all, so no filtered-empty message');
  assert.equal(page.get('history-filtered-empty').hidden, true, 'completed is visible by default');
  page.get('status-filter-completed').checked = false;
  await page.get('status-filter-completed').change();
  assert.equal(page.get('jobs-history-block').hidden, true, 'no visible history cards remain');
  assert.equal(page.get('history-filtered-empty').hidden, false, 'a message explains the section is filtered to zero');
  assert.equal(page.get('empty-jobs').hidden, true, 'the global "no videos" message is unaffected since a job still exists');
});

test('searching by title shows matching videos and ignores the status filters', async () => {
  const jobs = [
    {...job('trading', 'completed'), Title: 'They lie to you about day trading', CreatedAt: '/Date(1789490400000)/'},
    {...job('cooking', 'queued'), Title: 'Cooking pasta at home'},
    {...job('market', 'queued'), Title: 'Market open routine'}
  ];
  const page = await dashboard(state({jobs}), {useFilterDefaults: true});
  const visibleIds = () => [...page.get('jobs-active').children, ...page.get('jobs-history').children]
    .map(card => card.children[0].children[0].textContent);
  assert.equal(page.get('job-search-clear').hidden, true, 'the clear button only appears while searching');
  assert.equal(page.get('job-search-hint').hidden, true);
  assert.equal(visibleIds().length, 2, 'the old completed video is hidden by the default filters');

  await page.get('job-search').type('DAY TRADING');
  assert.equal(page.get('jobs-active').children.length, 0);
  assert.equal(page.get('jobs-history').children.length, 1,
    'search spans completed and older jobs even though those filters are off');
  assert.equal(page.get('history-count').textContent, '1');
  assert.equal(page.get('job-search-clear').hidden, false);
  assert.equal(page.get('job-search-hint').hidden, false);

  await page.get('job-search').type('trading cooking');
  assert.equal(page.get('jobs-active').children.length + page.get('jobs-history').children.length, 0,
    'every word must match the same video');
  assert.equal(page.get('active-filtered-empty').textContent, 'No active jobs match this search.');
  assert.equal(page.get('history-filtered-empty').textContent, 'No history jobs match this search.');

  await page.get('job-search-clear').click();
  assert.equal(page.get('job-search').value, '');
  assert.equal(page.get('job-search-clear').hidden, true);
  assert.equal(page.get('job-search-hint').hidden, true);
  assert.equal(visibleIds().length, 2, 'clearing the search restores the status-filtered view');
  assert.equal(page.get('active-filtered-empty').textContent, 'No active jobs match the filters.');
});

test('searching also matches the video id and survives polling', async () => {
  const jobs = [
    {...job('alpha', 'queued'), VideoId: 'aaaaaaaaaa1', Title: 'First video'},
    {...job('beta', 'queued'), VideoId: 'bbbbbbbbbb2', Title: 'Second video'}
  ];
  const page = await dashboard(state({jobs}));
  await page.get('job-search').type('bbbbbbbbbb2');
  assert.deepEqual(page.get('jobs-active').children.map(card => card.children[0].children[0].textContent),
    ['bbbbbbbbbb2']);
  await page.poll(state({jobs}));
  assert.deepEqual(page.get('jobs-active').children.map(card => card.children[0].children[0].textContent),
    ['bbbbbbbbbb2'], 'a refresh keeps the active search applied');
});

test('a search is never persisted across a dashboard reload', async () => {
  const first = await dashboard(state({jobs: [job('one', 'queued')]}));
  await first.get('job-search').type('nothing matches this');
  assert.equal(first.get('jobs-active').children.length, 0);
  for (const key of first.localValues.keys()) {
    assert.ok(!String(first.localValues.get(key)).includes('nothing matches this'),
      'the search text is not written to local storage');
  }
  const reopened = await dashboard(state({jobs: [job('one', 'queued')]}));
  assert.equal(reopened.get('job-search').value, '');
  assert.equal(reopened.get('jobs-active').children.length, 1);
});

test('each status filter chip shows how many videos it would reveal', async () => {
  const older = '/Date(1789490400000)/';
  const jobs = [
    job('q1', 'queued'), job('q2', 'queued'),
    job('a1', 'summarizing'),
    job('f1', 'error'),
    {...job('done1', 'completed')}, {...job('done2', 'completed'), CreatedAt: older},
    {...job('later', 'error'), WatchLater: true}
  ];
  const page = await dashboard(state({jobs}), {useFilterDefaults: true});
  assert.equal(page.get('status-count-queued').textContent, '2');
  assert.equal(page.get('status-count-active').textContent, '1');
  assert.equal(page.get('status-count-attention').textContent, '0');
  assert.equal(page.get('status-count-failed').textContent, '2', 'the watch-later failure counts too');
  assert.equal(page.get('status-count-other').textContent, '0');
  assert.equal(page.get('status-count-completed').textContent, '1',
    'today-only is on, so the older completed video is not promised by the Completed chip');
  assert.equal(page.get('status-count-watch-later').textContent, '1');
  assert.equal(page.get('status-count-today').textContent, '5',
    'the today chip counts jobs from today that the status chips already allow, so the hidden completed one is excluded');

  page.get('status-filter-today').checked = false;
  await page.get('status-filter-today').change();
  assert.equal(page.get('status-count-completed').textContent, '2',
    'switching today-only off makes the Completed chip promise both completed videos');
  assert.equal(page.get('status-count-today').textContent, '5');

  page.get('status-filter-completed').checked = true;
  await page.get('status-filter-completed').change();
  assert.equal(page.get('status-count-today').textContent, '6',
    'allowing completed jobs adds the completed video from today to the today chip');
  assert.equal(page.get('jobs-history').children.length, 4, 'the chip delivered exactly what it promised');
});

test('a zero status filter chip is dimmed and a search rewrites the chip counts', async () => {
  const jobs = [
    {...job('trading', 'completed'), Title: 'Day trading truth'},
    {...job('pasta', 'queued'), Title: 'Cooking pasta'}
  ];
  const page = await dashboard(state({jobs}), {useFilterDefaults: true});
  assert.ok(page.get('status-count-attention').classes.has('chip-zero'), 'an empty chip is dimmed');
  assert.ok(!page.get('status-count-queued').classes.has('chip-zero'));

  await page.get('job-search').type('trading');
  assert.equal(page.get('status-count-completed').textContent, '1',
    'a search reports its own per-status totals even where the chip is off');
  assert.equal(page.get('status-count-queued').textContent, '0');
  assert.ok(page.get('status-count-queued').classes.has('chip-zero'));

  await page.get('job-search-clear').click();
  assert.equal(page.get('status-count-queued').textContent, '1');
  assert.equal(page.get('status-count-completed').textContent, '1');
});

test('a failed video says it is repairing itself and stops promising that once the budget is spent', async () => {
  const soon = new Date(Date.now() + 30000).toISOString();
  const pending = await dashboard(state({jobs: [{...job('f', 'error'), Message: 'Part 1/3 [Gemini]: send failed.', AutoRetryAttempts: 1, AutoRetryAfterUtc: soon}]}));
  const pendingText = pending.get('jobs-history').children[0].children[2].textContent;
  assert.match(pendingText, /Part 1\/3 \[Gemini\]: send failed\./);
  assert.match(pendingText, /Retrying automatically shortly \(1\/3 automatic attempts used\)/);

  const spent = await dashboard(state({jobs: [{...job('f', 'error'), Message: 'Part 1/3 [Gemini]: send failed.', AutoRetryAttempts: 3, AutoRetryAfterUtc: soon}]}));
  const spentText = spent.get('jobs-history').children[0].children[2].textContent;
  assert.match(spentText, /Automatic retries are used up \(3\/3\)/);
  assert.match(spentText, /recorded for investigation/);

  const held = await dashboard(state({jobs: [{...job('f', 'error'), Message: 'Stopped.', PausedByUser: true, AutoRetryAttempts: 0}]}));
  const heldText = held.get('jobs-history').children[0].children[2].textContent;
  assert.doesNotMatch(heldText, /Retrying automatically/,
    'a video the user paused is never promised an automatic retry');

  const running = await dashboard(state({jobs: [{...job('r', 'summarizing'), Message: 'Part 2/3.', AutoRetryAttempts: 2}]}));
  assert.match(running.get('jobs-active').children[0].children[2].textContent, /Automatic attempt 2 of 3/);
});

test('the dashboard only promises an automatic retry the helper will actually run', async () => {
  const soon = new Date(Date.now() + 30000).toISOString();
  const failed = (extra = {}) => ({...job('f', 'error'), Message: 'Send failed.', AutoRetryAttempts: 1, ...extra});
  const messageOf = (page) => page.get('jobs-history').children[0].children[2].textContent;

  // DateTime.MinValue arrives as year 1: nothing was scheduled, so nothing may be promised.
  const unscheduled = await dashboard(state({jobs: [failed({AutoRetryAfterUtc: '0001-01-01T00:00:00'})]}));
  assert.match(messageOf(unscheduled), /No automatic retry is scheduled; use Retry from checkpoint\./);
  assert.doesNotMatch(messageOf(unscheduled), /Retrying automatically shortly/);

  const paused = await dashboard(state({paused: true, pauseReason: 'Usage limit.',
    jobs: [failed({AutoRetryAfterUtc: soon})]}));
  assert.match(messageOf(paused), /Queued for an automatic retry \(1\/3 used\) once dispatch resumes\./);

  const offline = await dashboard(state({ready: false, jobs: [failed({AutoRetryAfterUtc: soon})]}));
  assert.match(messageOf(offline), /once dispatch resumes/);

  // The server owns the real cap; the wording follows it rather than a hard-coded 3.
  const wider = await dashboard(state({autoRetryLimit: 5, jobs: [failed({AutoRetryAfterUtc: soon})]}));
  assert.match(messageOf(wider), /\(1\/5 automatic attempts used\)/);
});

test('reopening the dashboard with no token in the link reuses the token saved locally on this computer', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'summarizing')]}),
    {hash: '', saved: {'yt-summary-token': undefined}, local: {'yt-summary-token': token}});
  assert.notEqual(page.get('state').textContent, 'Setup required');
  assert.equal(page.get('jobs-active').children.length, 1);
});

test('a job moves from the active section to history once it reaches a terminal state', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'summarizing')]}));
  assert.equal(page.get('jobs-active').children.length, 1);
  assert.equal(page.get('jobs-history').children.length, 0);
  await page.poll(state({jobs: [job('selected', 'completed')]}));
  assert.equal(page.get('jobs-active').children.length, 0);
  assert.equal(page.get('jobs-history').children.length, 1);
  assert.equal(page.get('jobs-history').children[0].children[0].children[1].textContent, 'completed');
});

test('video jobs show local created and updated times and refresh the updated time', async () => {
  const original = job('selected', 'summarizing');
  const page = await dashboard(state({jobs: [original]}));
  const timestamps = page.get('jobs-active').children[0].children[1].children[1];
  assert.match(timestamps.textContent, /^Created .+ · Updated .+\(.+ago\)$/, 'the updated time carries a live elapsed hint so a stalled job is easy to spot');
  const first = timestamps.textContent;
  await page.poll(state({jobs: [{...original, UpdatedAt: '/Date(1789580700000)/'}]}));
  assert.notEqual(timestamps.textContent, first);

  await page.poll(state({jobs: [{...original, CreatedAt: null, UpdatedAt: null}]}));
  assert.equal(timestamps.textContent, '', 'legacy jobs without timestamps remain readable');
});

test('video cards identify their local calendar day with a consistent color', async () => {
  const first = job('first', 'completed');
  const sameDay = {...job('second', 'completed'), CreatedAt: first.CreatedAt};
  const otherDay = {...job('third', 'completed'), CreatedAt: '/Date(1789490400000)/'};
  const page = await dashboard(state({jobs: [first, sameDay, otherDay]}), {
    local: {'yt-summary-status-filters': JSON.stringify({completed: true, todayOnly: false})}
  });
  const rows = page.get('jobs-history').children;
  assert.match(rows[0].children[1].children[2].textContent, /Today|Yesterday|[A-Za-z]+/);
  const dayColorOf = element => element.className.match(/day-color-\d/)[0];
  assert.equal(dayColorOf(rows[1]), dayColorOf(rows[2]), 'jobs created on the same day share an accent color');
  assert.notEqual(dayColorOf(rows[0]), dayColorOf(rows[1]), 'different days receive different accent colors');
  assert.ok(rows[0].className.includes('day-start'), 'the first card of a new day group is marked as the day start');
  assert.ok(rows[1].className.includes('day-start'), 'the first card of the next day group is marked as the day start');
  assert.ok(!rows[2].className.includes('day-start'), 'later same-day cards are not re-marked as a day start');
  assert.equal(rows[1].dataset.dayLabel, rows[1].children[1].children[2].textContent, 'the day-start marker carries the same label as the badge');
});

test('video cards show persisted title, formatted duration and number of parts', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'summarizing')]}));
  const metadata = page.get('jobs-active').children[0].children[1].children;
  assert.equal(metadata[3].textContent, 'Title: Fixture video title');
  assert.equal(metadata[4].textContent, 'Length: 12:34');
  assert.equal(metadata[6].textContent, 'Parts: 3');
  await page.poll(state({jobs: [{...job('selected', 'loading'), Title: '', DurationSeconds: 0, ChunkCount: 0}]}));
  assert.equal(metadata[3].textContent, 'Title: YouTube video vid00000001 · looking up title…');
  assert.equal(metadata[4].textContent, 'Length: unknown');
  assert.equal(metadata[6].textContent, 'Parts: pending');
});

test('video cards format durations longer than one hour as H:MM:SS', async () => {
  const page = await dashboard(state({jobs: [{...job('selected', 'completed'), DurationSeconds: 3723}]}));
  const metadata = page.get('jobs-history').children[0].children[1].children;
  assert.equal(metadata[4].textContent, 'Length: 1:02:03');
});

test('video cards show completed-of-total parts progress once a part has finished, as a stuck-job signal', async () => {
  const page = await dashboard(state({jobs: [{...job('selected', 'summarizing'), SuccessfulParts: 0}]}));
  const metadata = page.get('jobs-active').children[0].children[1].children;
  assert.equal(metadata[6].textContent, 'Parts: 3', 'no completed parts yet: show only the planned total');
  await page.poll(state({jobs: [{...job('selected', 'summarizing'), SuccessfulParts: 2}]}));
  assert.equal(metadata[6].textContent, 'Parts: 2/3', 'a completed part count turns this into a live progress signal');
});

test('failed error jobs can be cleared in bulk without targeting other states', async () => {
  const page = await dashboard(state({jobs: [
    job('failed', 'error'),
    job('cancelled', 'cancelled'),
    job('done', 'completed')
  ]}));
  assert.equal(page.get('clear-errors').hidden, false);
  await page.get('clear-errors').click();
  const call = page.calls.find(item => item.route === '/api/clear-errors');
  assert.equal(call.method, 'POST');
  assert.equal(call.body, '{}');
  assert.match(page.confirmations.at(-1), /Completed and other jobs are kept/);
  assert.match(page.get('action-message').textContent, /failed\/error job/);
});

test('cancelled/reviewed cleanup appears only when such jobs exist and states its count', async () => {
  assert.match(html, /id="clear-cancelled"[^>]*>Clear cancelled</);
  const none = await dashboard(state({jobs: [job('failed', 'error'), job('done', 'completed')]}));
  assert.equal(none.get('clear-cancelled').hidden, true, 'nothing to retire means no button');
  const page = await dashboard(state({jobs: [
    job('stopped', 'cancelled'),
    job('seen', 'reviewed'),
    job('failed', 'error'),
    job('done', 'completed'),
    job('busy', 'summarizing')
  ]}));
  const button = page.get('clear-cancelled');
  assert.equal(button.hidden, false);
  page.setConfirm(false);
  await button.click();
  assert.equal(page.calls.filter(item => item.route === '/api/clear-cancelled').length, 0,
    'cancelling the confirmation clears nothing');
  assert.match(page.confirmations.at(-1), /Permanently remove 2 cancelled\/reviewed jobs/);
  assert.match(page.confirmations.at(-1), /ChatGPT, Gemini and Claude conversations are untouched/);
  page.setConfirm(true);
  await button.click();
  const call = page.calls.find(item => item.route === '/api/clear-cancelled');
  assert.equal(call.method, 'POST');
  assert.equal(call.body, '{}');
  assert.equal(call.headers['X-YT-Token'], token);
  assert.match(page.get('action-message').textContent, /cancelled\/reviewed job/);
  await page.poll(state({jobs: [job('failed', 'error'), job('done', 'completed')]}));
  assert.equal(page.get('clear-cancelled').hidden, true, 'the button disappears once nothing is left to retire');
});

test('a failed cancelled/reviewed cleanup reports the problem and stays retryable', async () => {
  const page = await dashboard(state({jobs: [job('stopped', 'cancelled')]}));
  page.fail('/api/clear-cancelled');
  await page.get('clear-cancelled').click();
  assert.match(page.get('action-message').textContent, /Unable to clear cancelled\/reviewed jobs/);
  assert.equal(page.get('clear-cancelled').disabled, false);
});

test("retry today's jobs targets only today's retryable states", async () => {
  const previousDay = '/Date(1789490400000)/';
  const none = await dashboard(state({jobs: [
    job('queued', 'queued'),
    job('done', 'completed'),
    {...job('old-error', 'error'), CreatedAt: previousDay}
  ]}));
  assert.equal(none.get('retry-today').hidden, true, 'queued, completed and prior-day failures are not eligible');

  const jobs = [
    job('today-error', 'error'),
    job('today-cancelled', 'cancelled'),
    job('today-review', 'needs-review'),
    job('today-queued', 'queued'),
    job('today-done', 'completed'),
    job('today-reviewed', 'reviewed'),
    {...job('old-error', 'error'), CreatedAt: previousDay}
  ];
  const page = await dashboard(state({jobs}));
  const button = page.get('retry-today');
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, "Retry all today's jobs (3)");
  page.setConfirm(false);
  await button.click();
  assert.equal(page.calls.filter(call => call.route === '/api/retry').length, 0,
    'cancelling the confirmation retries nothing');
  assert.match(page.confirmations.at(-1), /Retry 3 eligible jobs created today/);

  page.setConfirm(true);
  await button.click();
  const retriedIds = page.calls.filter(call => call.route === '/api/retry')
    .map(call => JSON.parse(call.body).jobId);
  assert.deepEqual(retriedIds, ['today-error', 'today-cancelled', 'today-review']);
  assert.match(page.get('action-message').textContent, /^3 jobs retried\.$/);
});

test("retry today's jobs excludes jobs the user set aside with Watch later", async () => {
  const jobs = [
    job('today-error', 'error'),
    {...job('today-watched', 'error'), WatchLater: true},
    job('today-cancelled', 'cancelled')
  ];
  const page = await dashboard(state({jobs}));
  assert.equal(page.get('retry-today').textContent, "Retry all today's jobs (2)",
    'a job on Watch later is not counted as eligible');
  await page.get('retry-today').click();
  const retriedIds = page.calls.filter(call => call.route === '/api/retry')
    .map(call => JSON.parse(call.body).jobId);
  assert.deepEqual(retriedIds, ['today-error', 'today-cancelled'], 'the Watch later job is never retried');
});

test("retry today's jobs reports partial failures and continues the batch", async () => {
  const page = await dashboard(state({jobs: [
    job('first', 'error'), job('raced', 'cancelled'), job('last', 'needs-review')
  ]}), {
    onFetch: async (route, config) => {
      if (route === '/api/retry' && JSON.parse(config.body).jobId === 'raced') {
        throw new Error('Fixture race.');
      }
    }
  });
  await page.get('retry-today').click();
  assert.equal(page.calls.filter(call => call.route === '/api/retry').length, 3,
    'one raced job does not prevent later eligible jobs from retrying');
  assert.match(page.get('action-message').textContent, /^2 jobs retried; 1 failed/);
  assert.equal(page.get('retry-today').disabled, false);
});

test('duplicate cleanup appears only for matching terminal video intent', async () => {
  const older = job('older', 'error');
  const newer = {...job('newer', 'completed'), VideoId: older.VideoId};
  const active = {...job('active', 'summarizing'), VideoId: older.VideoId};
  const page = await dashboard(state({jobs: [older, newer, active]}));
  assert.equal(page.get('clear-duplicates').hidden, false);
  await page.get('clear-duplicates').click();
  const call = page.calls.find(item => item.route === '/api/clear-duplicates');
  assert.equal(call.method, 'POST');
  assert.equal(call.body, '{}');
  assert.match(page.confirmations.at(-1), /Active work is never removed/);
});

test('different summary levels are not treated as duplicate jobs', async () => {
  const page = await dashboard(state({jobs: [
    job('ultra', 'completed'),
    {...job('full', 'completed'), SummaryLevel: 'full'}
  ]}));
  assert.equal(page.get('clear-duplicates').hidden, true);
});

test('status badges carry a color class per state category, not color alone', async () => {
  const cases = [
    ['queued', 'jobs-active', 'badge-queued', false],
    ['splitting', 'jobs-active', 'badge-active', true],
    ['verification', 'jobs-active', 'badge-attention', false],
    ['paused', 'jobs-active', 'badge-attention', false],
    ['completed', 'jobs-history', 'badge-success', false],
    ['error', 'jobs-history', 'badge-error', false],
    ['needs-review', 'jobs-history', 'badge-attention', false],
    ['reviewed', 'jobs-history', 'badge-muted', false],
    ['cancelled', 'jobs-history', 'badge-muted', false]
  ];
  for (const [jobState, section, badgeClass, pulses] of cases) {
    const page = await dashboard(state({jobs: [job('selected', jobState)]}));
    const badge = page.get(section).children[0].children[0].children[1];
    assert.equal(badge.textContent, jobState, `${jobState} keeps its state name as a text label, not color alone`);
    assert.ok(badge.className.split(/\s+/).includes(badgeClass), `${jobState} should carry ${badgeClass}, got ${badge.className}`);
    assert.equal(badge.className.split(/\s+/).includes('pulse'), pulses, `${jobState} pulse indicator mismatch`);
  }
});

test('the status badge shows a Watch later indicator on the tile itself, not only on the toggle button', async () => {
  const watched = await dashboard(state({jobs: [{...job('selected', 'error'), WatchLater: true}]}));
  const watchedBadge = watched.get('jobs-history').children[0].children[0].children[1];
  assert.match(watchedBadge.textContent, /Watch later/, 'a Watch later job shows an indicator directly on its badge');
  assert.equal(watchedBadge.textContent, 'error · Watch later');

  const unwatched = await dashboard(state({jobs: [job('selected', 'error')]}));
  const unwatchedBadge = unwatched.get('jobs-history').children[0].children[0].children[1];
  assert.equal(unwatchedBadge.textContent, 'error', 'a job not on Watch later shows no such indicator');
});

test('a duration badge on each tile categorizes the video length into Short/Medium/Long/Extreme buckets', async () => {
  const durationCases = [
    [0, null], // unknown/not looked up yet
    [1, 'Short'],
    [1799, 'Short'], // 29:59
    [1800, 'Medium'], // exactly 30:00
    [3599, 'Medium'], // 59:59
    [3600, 'Long'], // exactly 1:00:00
    [21599, 'Long'], // 5:59:59
    [21600, 'Extreme'] // exactly 6:00:00
  ];
  for (const [seconds, expected] of durationCases) {
    const page = await dashboard(state({jobs: [{...job('selected', 'queued'), DurationSeconds: seconds}]}));
    const meta = page.get('jobs-active').children[0].children[1];
    const durationBadge = meta.children[5];
    if (expected === null) {
      assert.equal(durationBadge.hidden, true, `DurationSeconds=${seconds} should hide the duration badge`);
    } else {
      assert.equal(durationBadge.hidden, false, `DurationSeconds=${seconds} should show a duration badge`);
      assert.equal(durationBadge.textContent, expected, `DurationSeconds=${seconds} should be categorized as ${expected}`);
    }
  }
});

test('the Parts text is visually emphasized beyond plain muted text', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'queued')]}));
  const meta = page.get('jobs-active').children[0].children[1];
  const parts = meta.children[6];
  assert.match(parts.textContent, /^Parts:/, 'the parts element still shows the existing Parts label');
  assert.ok(parts.className.split(/\s+/).includes('job-parts-emphasis'),
    `the parts element should carry an emphasis class, got ${parts.className}`);
});

test('final summary links are explicit user actions and strictly validated', async () => {
  const valid = 'https://chatgpt.com/c/final-id_123';
  const bad = [
    'https://chatgpt.com:443/c/id', 'https://user@chatgpt.com/c/id', 'https://chatgpt.com.evil.invalid/c/id',
    'https://other.invalid/c/id', '/c/id', 'javascript:alert(1)', 'https://chatgpt.com/c/',
    'https://chatgpt.com/c/id?x=1', 'https://chatgpt.com/c/id#x', 'https://chatgpt.com/c/id/other',
    'https://chatgpt.com/c/id\n', 'https://chatgpt.com/c/id\r\n', 'https://chatgpt.com/c/../id'
  ];
  const page = await dashboard(state({jobs: [...bad.map((url, i) => job(`bad${i}`, 'completed', url)), job('selected', 'completed', valid)]}));
  const rows = page.get('jobs-history').children;
  assert.equal(rows[0].children[3].children[0].textContent, 'Open final summary');
  assert.equal(rows[0].children[3].children[0].href, valid);
  assert.equal(rows[0].children[3].children[0].hidden, false);
  assert.equal(rows[0].children[3].children[0].target, '_blank');
  assert.equal(rows[0].children[3].children[0].rel, 'noopener noreferrer');
  for (const row of rows.slice(1)) {
    assert.equal(row.children[3].children[0].hidden, true);
    assert.equal(row.children[3].children[0].href, undefined);
  }
  await page.poll(state({jobs: [job('selected', 'completed', bad[0])]}));
  assert.equal(page.get('jobs-history').children.length, 1);
  assert.equal(page.get('jobs-history').children[0].children[3].children[0].href, undefined);
  assert.equal(page.calls.length, 2, 'Rendering never opens a remote URL');
});

// A JS window.open() loop only ever opens the browser's one allowed popup per click; every
// modern browser silently blocks the rest. "Open all parts" reveals a list of real
// <a target="_blank"> links instead, since an ordinary link click has no such limit.
test('"Open all parts" is hidden with no recorded part links and reveals a real link per part when clicked', async () => {
  const noParts = job('no-parts', 'completed', 'https://chatgpt.com/c/final-a');
  const withParts = {
    ...job('with-parts', 'completed', 'https://chatgpt.com/c/final-b'),
    PartResultUrls: ['https://chatgpt.com/c/part-1', 'https://gemini.google.com/app/part-2', 'https://claude.ai/chat/part-3']
  };
  const page = await dashboard(state({jobs: [noParts, withParts]}));
  const rows = page.get('jobs-history').children;
  assert.equal(rows[1].children[3].children[1].hidden, true, 'a job with no recorded parts hides the action');
  const button = rows[0].children[3].children[1];
  const list = rows[0].children[3].children.at(-1);
  assert.equal(button.hidden, false, 'a job with recorded parts shows the action');
  assert.equal(button.textContent, 'Open all parts (3)');
  assert.equal(list.hidden, true, 'the list starts collapsed');
  await button.click();
  assert.equal(list.hidden, false, 'clicking the toggle reveals the list');
  assert.equal(list.children.length, 3, 'one real link per recorded part, not a window.open() call');
  assert.equal(page.windowOpenCalls.length, 0, 'no popup was ever attempted, so none can be blocked');
  assert.deepEqual(list.children.map(link => link.href), withParts.PartResultUrls);
  assert.deepEqual(list.children.map(link => link.textContent), ['Part 1', 'Part 2', 'Part 3']);
  for (const link of list.children) {
    assert.equal(link.target, '_blank');
    assert.equal(link.rel, 'noopener noreferrer');
  }
  await button.click();
  assert.equal(list.hidden, true, 'clicking again collapses the list');
});

test('"Open all parts" filters out noncanonical or unsafe part links the same way as the final summary link', async () => {
  const withMixedParts = {
    ...job('mixed-parts', 'completed', 'https://chatgpt.com/c/final-c'),
    PartResultUrls: ['https://chatgpt.com/c/good-part', 'javascript:alert(1)', 'https://other.invalid/c/id']
  };
  const page = await dashboard(state({jobs: [withMixedParts]}));
  const button = page.get('jobs-history').children[0].children[3].children[1];
  const list = page.get('jobs-history').children[0].children[3].children.at(-1);
  assert.equal(button.hidden, false);
  assert.equal(button.textContent, 'Open all parts (1)');
  await button.click();
  assert.deepEqual(list.children.map(link => link.href), ['https://chatgpt.com/c/good-part']);
});


test('missing result URLs and error-state URLs never render a final-summary action', async () => {
  const valid = 'https://chatgpt.com/c/not-proven-final';
  const page = await dashboard(state({jobs: [
    job('missing', 'error', null),
    job('empty', 'error', ''),
    job('stale', 'error', valid)
  ]}));
  for (const row of page.get('jobs-history').children) {
    const link = row.children[3].children[0];
    assert.equal(link.hidden, true);
    assert.equal(link.href, undefined);
  }
  assert.match(html, /\.job-card-actions a\[hidden\]\s*\{\s*display:\s*none\s*!important/);
});

test('canonical Gemini and Claude conversation links are exposed safely', async () => {
  for (const url of ['https://gemini.google.com/app/gemini-id_123', 'https://claude.ai/chat/claude-id_123']) {
    const page = await dashboard(state({jobs: [job('selected', 'completed', url)]}));
    const link = page.get('jobs-history').children[0].children[3].children[0];
    assert.equal(link.hidden, false);
    assert.equal(link.href, url);
    assert.equal(link.rel, 'noopener noreferrer');
  }
});

test('resume requires explicit quota-reset confirmation and sends exactly {} once', async () => {
  const page = await dashboard(state({paused: true, jobs: [job('selected', 'paused')]}));
  page.setConfirm(false);
  await page.get('resume').click();
  assert.equal(page.calls.filter(call => call.method === 'POST').length, 0);
  page.setConfirm(true);
  await page.get('resume').click();
  const resumeCalls = page.calls.filter(call => call.route === '/api/resume');
  assert.equal(resumeCalls.length, 1);
  assert.equal(resumeCalls[0].body, '{}');
  assert.equal(resumeCalls[0].method, 'POST');
  assert.equal(resumeCalls[0].headers['X-YT-Token'], token);
  assert.equal(resumeCalls[0].headers['Content-Type'], 'application/json');
  assert.match(page.confirmations[0], /quota has reset/);
  assert.match(page.confirmations[0], /does not bypass/);
  await page.poll(state({jobs: [job('selected', 'paused')]}));
  assert.equal(page.get('resume').hidden, true);
  assert.equal(page.get('quota-pause').hidden, true);
  assert.equal(page.calls.filter(call => call.route === '/api/jobs').length, 0);
});

test('failed resume is not retried by status polling and is recoverable manually', async () => {
  const data = state({paused: true});
  const page = await dashboard(data);
  page.fail('/api/resume');
  await page.get('resume').click();
  assert.match(page.get('action-message').textContent, /Unable to confirm resume/);
  await page.poll();
  await page.poll();
  assert.equal(page.calls.filter(call => call.route === '/api/resume').length, 1);
  assert.equal(page.get('resume').disabled, false);
  page.fail('/api/status');
  await page.poll();
  assert.equal(page.get('state').textContent, 'Helper offline');
  assert.equal(page.get('resume').disabled, true);
});

test('controller shutdown keeps the last jobs visible and marks every local action offline', async () => {
  const previous = state({jobs: [
    job('active', 'summarizing'),
    job('selected', 'completed', 'https://chatgpt.com/c/saved-result')
  ], active: 1, token: 'must-not-persist', transcript: 'private source text'});
  const page = await dashboard(previous);
  assert.ok(page.localValues.has('yt-summary-status-snapshot-v1'));
  assert.doesNotMatch(page.localValues.get('yt-summary-status-snapshot-v1'), /must-not-persist|private source text/);
  page.fail('/api/status');
  await page.poll();
  assert.equal(page.get('state').textContent, 'Helper offline');
  assert.equal(page.get('controller-offline').hidden, false);
  assert.match(page.get('offline-message').textContent, /last known jobs and history/);
  assert.match(page.get('offline-updated').textContent, /Last successful controller update/);
  assert.equal(page.get('jobs-active').children.length, 1, 'the last active job remains visible as a snapshot');
  assert.equal(page.get('jobs-history').children.length, 1, 'completed history remains visible');
  const actions = page.get('jobs-history').children[0].children[3].children;
  assert.equal(actions[0].href, 'https://chatgpt.com/c/saved-result', 'remote completed results remain openable');
  assert.equal(actions[3].disabled, true, 'retry actions are disabled offline');
  assert.equal(actions[5].disabled, true, 'clear actions are disabled offline');
});

test('a saved status snapshot renders before an unavailable controller reconnects', async () => {
  const snapshot = state({jobs: [job('selected', 'completed', 'https://chatgpt.com/c/snapshot')]});
  const saved = JSON.stringify({updatedAt: '2026-09-16T12:00:00.000Z', data: snapshot});
  const page = await dashboard(state(), {
    failure: '/api/status',
    local: {'yt-summary-status-snapshot-v1': saved}
  });
  assert.equal(page.get('state').textContent, 'Helper offline');
  assert.equal(page.get('jobs-history').children.length, 1);
  assert.equal(page.get('jobs-history').children[0].children[3].children[0].href,
    'https://chatgpt.com/c/snapshot');
});

test('legacy bookmark protocol and automatic retry action are preserved', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'needs-review')]}));
  const bookmark = page.get('bookmark').href;
  let launched;
  vm.runInNewContext(bookmark.slice('javascript:'.length), {
    URL, URLSearchParams, location: {href: 'https://www.youtube.com/watch?v=vid00000001'},
    crypto: {randomUUID: () => '00000000-0000-4000-8000-000000000001'},
    window: {open: (...args) => { launched = args; }},
    alert: message => assert.fail(message)
  });
  const link = new URL(launched[0]);
  assert.equal(link.origin, origin);
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('token'), token);
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('video'), 'vid00000001');
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('request'), '00000000-0000-4000-8000-000000000001');
  assert.equal(new URLSearchParams(link.hash.slice(1)).get('level'), 'ultra');
  assert.equal(launched[2], 'noopener,noreferrer');
  await page.get('jobs-history').children[0].children[3].children[3].click();
  const retry = page.calls.find(call => call.route === '/api/retry');
  assert.deepEqual(JSON.parse(retry.body), {jobId: 'selected'});
});

test('six distinct level bookmarklets are generated and embed their respective levels', async () => {
  const page = await dashboard(state());
  const expectedLevels = ['ultra', 'max', 'reg', 'min', 'micro', 'full'];
  for (const lvl of expectedLevels) {
    const el = lvl === 'ultra' ? page.get('bookmark') : page.get(`bookmark-${lvl}`);
    assert.ok(el, `Bookmark element for ${lvl} should exist`);
    let launched;
    vm.runInNewContext(el.href.slice('javascript:'.length), {
      URL, URLSearchParams, location: {href: 'https://www.youtube.com/watch?v=vid00000001'},
      crypto: {randomUUID: () => '00000000-0000-4000-8000-000000000001'},
      window: {open: (...args) => { launched = args; }},
      alert: message => assert.fail(message)
    });
    const link = new URL(launched[0]);
    assert.equal(new URLSearchParams(link.hash.slice(1)).get('level'), lvl);
    assert.equal(new URLSearchParams(link.hash.slice(1)).get('token'), token);
    assert.equal(new URLSearchParams(link.hash.slice(1)).get('video'), 'vid00000001');
  }
  assert.ok(page.get('copy-level'));
  await page.get('copy-level').change('min');
  assert.ok(page.get('bookmark-code').value.includes('level:"min"'));
});

test('batch submission remains an explicit local action', async () => {
  const page = await dashboard(state({paused: true}));
  page.get('batch').value = 'https://www.youtube.com/watch?v=vid00000001\nvid00000002';
  await page.get('add-batch').click();
  assert.equal(page.calls.filter(call => call.route === '/api/jobs').length, 2);
  assert.match(page.get('batch-result').textContent, /2 request\(s\) accepted/);
  assert.equal(page.get('batch').value, '');
  assert.equal(page.get('resume').hidden, false);
  assert.ok(page.calls.filter(call => call.route === '/api/jobs').every(call => JSON.parse(call.body).summaryLevel === 'ultra'));
});

test('adding an already completed video opens its saved summary and selects its bumped tile', async () => {
  const existing = {...job('existing', 'completed', 'https://chatgpt.com/c/existing-summary'),
    CreatedAt: '/Date(1789490400000)/'};
  const other = job('other-completed', 'completed', 'https://chatgpt.com/c/other-summary');
  const page = await dashboard(state(), {jobResponse: existing, useFilterDefaults: true});
  page.get('batch').value = 'vid00000001';
  await page.get('add-batch').click();
  assert.equal(page.windowOpenCalls.length, 1);
  assert.deepEqual(page.windowOpenCalls[0],
    ['https://chatgpt.com/c/existing-summary', '_blank', 'noopener,noreferrer']);
  assert.equal(page.values.get('yt-summary-selected-job'), 'existing');
  await page.poll(state({jobs: [other, existing]}));
  assert.equal(page.get('status-filter-completed').checked, false,
    'surfacing one reused result does not change the Completed filter default');
  assert.equal(page.get('jobs-history').children.length, 1);
  assert.equal(page.get('jobs-history').children[0].children[0].children[0].textContent, 'vid00000001');
});

test('Ultra is shown from saved settings and changing it does not alter existing jobs', async () => {
  const page = await dashboard(state({jobs: [job('selected')]}));
  assert.equal(page.get('summary-level').value, 'ultra');
  assert.match(page.get('summary-level-description').textContent, /2,000-4,000/);
  assert.equal(page.get('summary-level').disabled, false);
  assert.equal(page.calls.filter(call => call.route === '/api/settings').length, 0);
  await page.get('summary-level').change('micro');
  const saves = page.calls.filter(call => call.route === '/api/settings');
  assert.equal(saves.length, 1);
  assert.deepEqual(JSON.parse(saves[0].body), {summaryLevel: 'micro'});
  assert.equal(page.get('summary-level').value, 'micro');
  assert.match(page.get('summary-level-description').textContent, /Only the conclusion in 1-3 sentences/);
  await page.poll();
  assert.equal(page.get('jobs-active').children[0].children[1].children[0].textContent, 'Ultra');
  assert.equal(page.calls.filter(call => call.route === '/api/jobs').length, 0);
});

test('Hebrew is the only normal-summary language and cannot be changed', async () => {
  const page = await dashboard(state());
  assert.equal(page.get('summary-language').value, 'hebrew');
  assert.equal(page.get('summary-language').disabled, true);
  assert.match(html, /except Full is written in Hebrew/);
  await page.get('summary-language').change('english');
  assert.equal(page.calls.filter(call => call.route === '/api/settings').length, 0);
  assert.equal(page.get('summary-language').value, 'hebrew');
});

const ambiguous = (id = 'selected') => ({
  ...job(id, 'error'),
  Message: 'Video summary: Ambiguous send automatically resent using the next provider.',
  AmbiguousTargetId: 'tab-a', AmbiguousTextSha256: 'a'.repeat(64)
});
const sweptAmbiguous = (id = 'selected') => ({...ambiguous(id), ReconcileAttempted: true});
const unrecoverableAmbiguous = (id = 'selected') => ({
  ...job(id, 'error'),
  Message: 'Video summary: Ambiguous send automatically resent using the next provider.',
  AmbiguousTargetId: '', AmbiguousTextSha256: '', ReconcileAttempted: true
});

const attachButton = page => page.get('jobs-history').children[0].children[3].children[4];

test('an ambiguous job waits for the automatic browser sweep before offering a manual link', async () => {
  const page = await dashboard(state({jobs: [ambiguous()]}));
  const attach = attachButton(page);
  assert.equal(attach.hidden, true, 'the helper reconciles from its own browser first');
  const card = page.get('jobs-history').children[0];
  assert.match(card.children[2].textContent, /Checking the browser for a completed summary/);
  await page.poll(state({jobs: [sweptAmbiguous()]}));
  assert.equal(attach.hidden, false, 'the manual link is the fallback once the sweep found nothing');
  assert.match(card.children[2].textContent, /could not safely find the completed/);
  await page.poll(state({ready: false, jobs: [ambiguous()]}));
  assert.equal(attach.hidden, false, 'with no browser open there is nothing to sweep');
});

test('an ambiguous job with no saved browser target or prompt hash never shows the checking state', async () => {
  // Old jobs from before this metadata existed (or ones whose sweep already ran) have nothing
  // safe left to match against, so the dashboard must show the fallback immediately, no matter
  // what ReconcileAttempted says and even if the browser is open right now.
  const page = await dashboard(state({jobs: [unrecoverableAmbiguous()]}));
  const attach = attachButton(page);
  const card = page.get('jobs-history').children[0];
  assert.equal(attach.hidden, false, 'the manual link is offered immediately with no metadata to sweep');
  assert.match(card.children[2].textContent, /could not safely find the completed/);
  assert.doesNotMatch(card.children[2].textContent, /Checking the browser/);
});

test('any error or needs-review job with no captured result link offers the manual attach action' , async () => {
  const page = await dashboard(state({jobs: [sweptAmbiguous()]}));
  const attach = attachButton(page);
  assert.equal(attach.textContent, 'Attach final summary link');
  assert.equal(attach.hidden, false);
  await page.poll(state({jobs: [{...sweptAmbiguous(), ResultUrl: 'https://chatgpt.com/c/abc123'}]}));
  assert.equal(attach.hidden, true, 'a captured conversation needs no manual repair');
  await page.poll(state({jobs: [job('selected', 'error')]}));
  assert.equal(attach.hidden, false,
    'an ordinary failure with no result link may still have completed in its provider, so attach stays available');
  await page.poll(state({jobs: [job('selected', 'needs-review')]}));
  assert.equal(attach.hidden, false, 'a needs-review job with no result link is also attachable');
  await page.poll(state({jobs: [job('selected', 'completed', 'https://chatgpt.com/c/abc123')]}));
  assert.equal(attach.hidden, true);
  await page.poll(state({jobs: [job('selected', 'cancelled')]}));
  assert.equal(attach.hidden, true, 'a cancelled job is not attachable');
});

test('attaching a valid provider link reconciles exactly that job', async () => {
  const page = await dashboard(state({jobs: [sweptAmbiguous()]}),
    {promptResult: '  https://chatgpt.com/c/6aabe641  '});
  await attachButton(page).click();
  assert.match(page.prompts.at(-1), /vid00000001/);
  const call = page.calls.find(item => item.route === '/api/attach-result');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['X-YT-Token'], token);
  assert.deepEqual(JSON.parse(call.body), {jobId: 'selected', resultUrl: 'https://chatgpt.com/c/6aabe641'});
  assert.match(page.get('action-message').textContent, /attached/);
});

test('a cancelled or invalid attach prompt changes nothing on the server', async () => {
  const page = await dashboard(state({jobs: [sweptAmbiguous()]}), {promptResult: null});
  await attachButton(page).click();
  assert.equal(page.calls.filter(item => item.route === '/api/attach-result').length, 0);
  assert.match(page.get('action-message').textContent, /left unchanged/);
  page.setPrompt('javascript:alert(1)');
  await attachButton(page).click();
  assert.equal(page.calls.filter(item => item.route === '/api/attach-result').length, 0);
  assert.match(page.get('action-message').textContent, /not a supported ChatGPT, Gemini or Claude/);
  page.setPrompt('https://chatgpt.com/c/ok123');
  page.fail('/api/attach-result');
  await attachButton(page).click();
  assert.match(page.get('action-message').textContent, /Unable to attach that link/);
  assert.equal(attachButton(page).disabled, false, 'a failed attach stays retryable');
});

test('a transcript failure that never reached a provider is not offered a conversation to attach', async () => {
  // Real report: every transcript-stage error also claimed an automatic check could not find
  // the completed summary tab, for a video where nothing was ever sent to a provider.
  const transcriptFailure = {
    ...job('selected', 'error'),
    Message: "Transcript: The transcript service failed, and YouTube's own transcript timed out. " +
      'Nothing was sent to ChatGPT.'
  };
  const page = await dashboard(state({jobs: [transcriptFailure]}));
  const card = page.get('jobs-history').children[0];
  assert.equal(attachButton(page).hidden, true, 'there is no provider conversation to attach');
  assert.doesNotMatch(card.children[2].textContent, /could not safely find the completed/);
  assert.doesNotMatch(card.children[2].textContent, /Checking the browser/);
  await page.poll(state({jobs: [{...transcriptFailure, SuccessfulParts: 1, ChunkCount: 3}]}));
  assert.equal(attachButton(page).hidden, false,
    'once some parts landed in a provider, the conversation is attachable again');
});

const removeButton = page => page.get('jobs-history').children[0].children[3].children[10];

test('a queued or terminal job can be permanently removed after confirmation', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'error')]}));
  const remove = removeButton(page);
  assert.equal(remove.textContent, 'Remove from list');
  assert.equal(remove.hidden, false);
  page.setConfirm(false);
  await remove.click();
  assert.equal(page.calls.filter(item => item.route === '/api/delete-job').length, 0, 'cancelling the confirmation changes nothing');
  assert.match(page.confirmations.at(-1), /vid00000001/);
  assert.match(page.confirmations.at(-1), /does not touch ChatGPT, Gemini, Claude/);
  page.setConfirm(true);
  await remove.click();
  const call = page.calls.find(item => item.route === '/api/delete-job');
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['X-YT-Token'], token);
  assert.deepEqual(JSON.parse(call.body), {jobId: 'selected'});
  await page.poll(state({jobs: []}));
  assert.equal(page.get('jobs-history').children.length, 0, 'the card is gone once the server confirms removal');
});

test('an active job never shows the remove action', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'sending')]}));
  assert.equal(page.get('jobs-active').children[0].children[3].children[10].hidden, true,
    'a job still owned by a worker must be stopped before it can be removed');
});

test('a failed removal leaves the card in place with a clear message', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'completed', 'https://chatgpt.com/c/abc123')]}));
  page.fail('/api/delete-job');
  const remove = removeButton(page);
  await remove.click();
  assert.match(page.get('action-message').textContent, /Unable to remove/);
  assert.equal(page.get('jobs-history').children.length, 1, 'the card stays until removal actually succeeds');
  assert.equal(remove.disabled, false);
});

test('a removal refused because the job started again is impossible to miss', async () => {
  // A queued video can be taken by a worker between the render that showed Remove and the
  // click, so the server refuses it. The user must not be left believing it was removed.
  const page = await dashboard(state({jobs: [job('selected', 'queued')]}));
  page.fail('/api/delete-job');
  await page.get('jobs-active').children[0].children[3].children[10].click();
  assert.equal(page.alerts.length, 1, 'the refusal is announced, not only written in small text');
  assert.match(page.alerts.at(-1), /Unable to remove/);
  assert.match(page.alerts.at(-1), /vid00000001/);
  assert.match(page.get('action-message').textContent, /Unable to remove/);
  assert.ok(page.calls.some(item => item.route === '/api/status'),
    're-syncing after a refused removal shows the job true current state');
});

test('a successful removal never interrupts the user with a dialog', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'error')]}));
  await removeButton(page).click();
  assert.equal(page.alerts.length, 0);
});

const watchLaterButton = (page, section = 'jobs-history') => page.get(section).children[0].children[3].children[8];

test('the Watch later button appears in every job state and toggles the flag', async () => {
  for (const [section, testState] of [['jobs-active', 'queued'], ['jobs-active', 'sending'], ['jobs-history', 'error'], ['jobs-history', 'completed']]) {
    const page = await dashboard(state({jobs: [job('selected', testState)]}));
    const button = watchLaterButton(page, section);
    assert.equal(button.hidden, false, `Watch later must be shown for state ${testState}`);
    assert.equal(button.textContent, 'Watch later');
  }
});

test('marking a queued job Watch later just sets the flag; no work is running to stop', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'queued')]}));
  const button = watchLaterButton(page, 'jobs-active');
  await button.click();
  const call = page.calls.find(item => item.route === '/api/watch-later');
  assert.deepEqual(JSON.parse(call.body), {jobId: 'selected', watchLater: true});
  assert.match(page.confirmations.at(-1), /Watch later/);
  assert.doesNotMatch(page.confirmations.at(-1), /Its current work will be stopped/,
    'a queued job has nothing running, so the confirmation must not claim work will be stopped');
});

test('marking an active job Watch later warns that its current work is stopped first', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'sending')]}));
  const button = watchLaterButton(page, 'jobs-active');
  await button.click();
  const call = page.calls.find(item => item.route === '/api/watch-later');
  assert.deepEqual(JSON.parse(call.body), {jobId: 'selected', watchLater: true});
  assert.match(page.confirmations.at(-1), /current work will be stopped/);
});

test('cancelling the Watch later confirmation sends no request', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'error')]}));
  page.setConfirm(false);
  await watchLaterButton(page).click();
  assert.equal(page.calls.filter(item => item.route === '/api/watch-later').length, 0);
});

// The restart hold is invisible on a job tile and is not released by removing Watch later, so a
// queued video could sit for ever with no control on its card able to start it.
test('a queued job held by a paused scheduler offers Start now and explains the hold', async () => {
  const stuck = {...job('selected', 'queued'), Message: 'Retrying from its saved checkpoint.'};
  const page = await dashboard(state({paused: true, pauseKind: 'restart', pauseReason: 'Restarted.', jobs: [stuck]}));
  const row = page.get('jobs-active').children[0];
  assert.match(row.children[2].textContent, /Dispatch is paused, so nothing starts on its own\. Use Start now/);
  const start = row.children[3].children.find(button => button.textContent === 'Start now');
  assert.equal(start.hidden, false, 'Start now is offered on the tile itself');
  await start.click();
  const call = page.calls.find(item => item.route === '/api/start-job');
  assert.deepEqual(JSON.parse(call.body), {jobId: 'selected'});
});

test('Start now is hidden for a running job and for one that already finished', async () => {
  const startOf = (page, section) => page.get(section).children[0].children[3].children
    .find(button => button.textContent === 'Start now');
  const running = await dashboard(state({jobs: [job('selected', 'summarizing')]}));
  assert.equal(startOf(running, 'jobs-active').hidden, true, 'a video already being worked on needs no Start now');
  const done = await dashboard(state({jobs: [job('selected', 'completed')]}));
  assert.equal(startOf(done, 'jobs-history').hidden, true, 'a finished video has nothing to start');
  const failed = await dashboard(state({jobs: [job('selected', 'error')]}));
  assert.equal(startOf(failed, 'jobs-history').hidden, false, 'a failed video can be forced to run now');
});

test('a failed Start now is reported without losing the card', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'error')]}));
  page.fail('/api/start-job');
  const start = page.get('jobs-history').children[0].children[3].children
    .find(button => button.textContent === 'Start now');
  await start.click();
  assert.match(page.get('action-message').textContent, /Unable to start this video/);
  assert.equal(start.disabled, false);
});

test('a job already on Watch later shows the removal label and toggles it off on click', async () => {
  const page = await dashboard(state({jobs: [{...job('selected', 'error'), WatchLater: true}]}));
  const button = watchLaterButton(page);
  assert.equal(button.textContent, 'Remove from Watch later');
  await button.click();
  const call = page.calls.find(item => item.route === '/api/watch-later');
  assert.deepEqual(JSON.parse(call.body), {jobId: 'selected', watchLater: false});
  assert.match(page.confirmations.at(-1), /eligible for normal automatic processing again/);
});

// A queued Watch-later video is skipped by automatic dispatch and shows no Retry (it is not
// failed), so the tile has to name the control that actually releases it.
test('a queued Watch later job explains that dispatch skips it and names the control that starts it', async () => {
  const stuck = {...job('selected', 'queued'), WatchLater: true,
    Message: 'Retrying from its saved checkpoint.'};
  const page = await dashboard(state({jobs: [stuck]}));
  const message = page.get('jobs-active').children[0].children[2].textContent;
  assert.match(message, /set aside for Watch later, so automatic dispatch skips it/);
  assert.match(message, /Use Start now to run it/);
});

test('a completed Watch later job is not described as being skipped by dispatch', async () => {
  const page = await dashboard(state({jobs: [{...job('selected', 'completed'), WatchLater: true}]}));
  assert.equal(watchLaterButton(page).textContent, 'Remove from Watch later');
  assert.doesNotMatch(page.get('jobs-history').children[0].children[2].textContent, /automatic dispatch skips it/);
});

test('a failed Watch later update is reported without losing the card', async () => {
  const page = await dashboard(state({jobs: [job('selected', 'error')]}));
  page.fail('/api/watch-later');
  await watchLaterButton(page).click();
  assert.match(page.get('action-message').textContent, /Unable to update Watch later/);
  assert.equal(watchLaterButton(page).disabled, false);
});

test('a completed Full job opens its authenticated local result without embedding it in status', async () => {
  const full = {...job('selected', 'completed'), SummaryLevel: 'full', FinalResult: 'local'};
  const page = await dashboard(state({jobs: [full]}), {finalResult: 'Every transcript word.'});
  const open = page.get('jobs-history').children[0].children[3].children[2];
  assert.equal(open.textContent, 'Open full transcript');
  assert.equal(open.hidden, false);
  await open.click();
  const resultCalls = page.calls.filter(call => call.route === '/api/result');
  assert.equal(resultCalls.length, 1);
  assert.deepEqual(JSON.parse(resultCalls[0].body), {jobId: 'selected'});
  assert.equal(page.get('full-result-text').value, 'Every transcript word.');
  assert.equal(page.get('full-result').hidden, false);
});

test('provider toggles persist, hide disabled first-provider choices, and keep one enabled', async () => {
  const page = await dashboard(state());
  assert.equal(page.get('provider-chatgpt').checked, true);
  assert.equal(page.get('provider-gemini').checked, true);
  assert.equal(page.get('provider-claude').checked, true);

  page.get('provider-chatgpt').checked = false;
  await page.get('provider-chatgpt').change();
  let saves = page.calls.filter(call => call.route === '/api/settings');
  assert.deepEqual(JSON.parse(saves.at(-1).body), {enabledProviders: ['Gemini', 'Claude']});
  assert.equal(page.get('first-provider-chatgpt').hidden, true);
  assert.equal(page.get('first-provider').value, 'Gemini');

  page.get('provider-gemini').checked = false;
  await page.get('provider-gemini').change();
  saves = page.calls.filter(call => call.route === '/api/settings');
  assert.deepEqual(JSON.parse(saves.at(-1).body), {enabledProviders: ['Claude']});
  assert.equal(page.get('first-provider').value, 'Claude');

  const before = saves.length;
  page.get('provider-claude').checked = false;
  await page.get('provider-claude').change();
  assert.equal(page.calls.filter(call => call.route === '/api/settings').length, before);
  assert.equal(page.get('provider-claude').checked, true);
  assert.match(page.get('provider-settings-status').textContent, /At least one provider must remain enabled/);
});

test('saved provider settings render enabled-only first-provider choices', async () => {
  const page = await dashboard(state({enabledProviders: ['ChatGPT', 'Claude']}));
  assert.equal(page.get('provider-gemini').checked, false);
  assert.equal(page.get('first-provider-gemini').hidden, true);
  assert.equal(page.get('first-provider-gemini').disabled, true);
  assert.equal(page.get('first-provider-chatgpt').hidden, false);
  assert.equal(page.get('first-provider-claude').hidden, false);
  assert.match(page.get('provider-order').textContent, /ChatGPT → Claude/);
});

test('keeping intermediate part/merge tabs open defaults to off and can be toggled and persisted', async () => {
  const page = await dashboard(state());
  assert.equal(page.get('keep-intermediate-tabs').checked, false, 'closing intermediate tabs is the default');

  page.get('keep-intermediate-tabs').checked = true;
  await page.get('keep-intermediate-tabs').change();
  const saves = page.calls.filter(call => call.route === '/api/settings');
  assert.deepEqual(JSON.parse(saves.at(-1).body), {keepIntermediateTabs: true});
  assert.match(page.get('keep-intermediate-tabs-status').textContent, /stays open for review/);

  await page.poll(state({keepIntermediateTabs: true}));
  assert.equal(page.get('keep-intermediate-tabs').checked, true, 'the saved setting survives a status refresh');
});

test('a queued video job shows a summary-level selector that saves a change through the API', async () => {
  const page = await dashboard(state({jobs: [{...job('selected', 'queued'), SummaryLevel: 'ultra'}]}));
  const actions = page.get('jobs-active').children[0].children[3];
  const levelSelect = actions.children[9];
  assert.equal(levelSelect.tagName, 'select');
  assert.equal(levelSelect.hidden, false, 'a queued video may still have its level changed');
  assert.equal(levelSelect.value, 'ultra');
  await levelSelect.change('micro');
  const call = page.calls.find(c => c.route === '/api/set-job-level');
  assert.deepEqual(JSON.parse(call.body), {jobId: 'selected', summaryLevel: 'micro'});
});

test('the summary-level selector is hidden while a video is active, so its checkpoint is not mixed', async () => {
  const page = await dashboard(state({jobs: [{...job('selected', 'starting'), SummaryLevel: 'ultra'}]}));
  const actions = page.get('jobs-active').children[0].children[3];
  const levelSelect = actions.children[9];
  assert.equal(levelSelect.hidden, true, 'a video that already started keeps its checkpoint level fixed');
});

test('a history video exposes a level selector and changes only after explicit confirmation', async () => {
  const completed = {...job('selected', 'completed'), SummaryLevel: 'ultra'};
  const page = await dashboard(state({jobs: [completed]}));
  const actions = page.get('jobs-history').children[0].children[3];
  const levelSelect = actions.children[9];
  assert.equal(levelSelect.hidden, false, 'history videos expose the summary-level selector');
  await levelSelect.change('max');
  const call = page.calls.find(c => c.route === '/api/set-job-level');
  assert.deepEqual(JSON.parse(call.body), {jobId: 'selected', summaryLevel: 'max'});
});

test('a saved nondefault level and legacy job labels survive a dashboard reload', async () => {
  const page = await dashboard(state({summaryLevel: 'min', jobs: [{...job('selected'), SummaryLevel: 'legacy'}]}));
  assert.equal(page.get('summary-level').value, 'min');
  assert.match(page.get('summary-level-description').textContent, /100-200/);
  assert.equal(page.get('jobs-active').children[0].children[1].children[0].textContent, 'Earlier default');
  assert.equal(page.calls.filter(call => call.method === 'POST').length, 0);
});

test('a failed setting save is not retried and reconciles with the next authoritative status', async () => {
  const page = await dashboard(state());
  page.fail('/api/settings');
  await page.get('summary-level').change('max');
  assert.match(page.get('summary-level-status').textContent, /Unable to confirm/);
  assert.equal(page.get('add-batch').disabled, true);
  await page.poll(state({summaryLevel: 'max'}));
  assert.equal(page.get('summary-level').value, 'max', 'The server may have saved a request whose response was lost');
  assert.equal(page.get('add-batch').disabled, false);
  assert.equal(page.calls.filter(call => call.route === '/api/settings').length, 1);
  assert.equal(page.calls.filter(call => call.route === '/api/jobs').length, 0);
});

test('saving a level disables new submissions until the saved level is confirmed', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const page = await dashboard(state(), {onFetch: async route => { if (route === '/api/settings') await gate; }});
  const save = page.get('summary-level').change('reg');
  await settle();
  assert.equal(page.get('summary-level').disabled, true);
  assert.equal(page.get('add-batch').disabled, true);
  assert.equal(page.get('retry').disabled, true);
  await page.poll();
  assert.equal(page.get('summary-level').value, 'reg', 'Polling cannot overwrite an in-flight selection');
  release();
  await save;
  page.get('batch').value = 'vid00000001';
  await page.get('add-batch').click();
  const request = page.calls.find(call => call.route === '/api/jobs');
  assert.equal(JSON.parse(request.body).summaryLevel, 'reg');
});

test('an old status response cannot overwrite a newer saved level', async () => {
  let holdStatus = false;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const page = await dashboard(state(), {onFetch: async route => { if (holdStatus && route === '/api/status') await gate; }});
  holdStatus = true;
  const oldPoll = page.poll(state());
  await settle();
  await page.get('summary-level').change('max');
  release();
  await oldPoll;
  assert.equal(page.get('summary-level').value, 'max');
});

test('batch retries retain their original requested level and request ID', async () => {
  const page = await dashboard(state());
  page.get('batch').value = 'vid00000001';
  page.fail('/api/jobs');
  await page.get('add-batch').click();
  await page.get('summary-level').change('micro');
  page.fail(null);
  await page.get('add-batch').click();
  const jobs = page.calls.filter(call => call.route === '/api/jobs').map(call => JSON.parse(call.body));
  assert.equal(jobs.length, 2);
  assert.equal(jobs[0].requestId, jobs[1].requestId);
  assert.equal(jobs[1].summaryLevel, 'ultra');
});

test('a scanned-page hash pre-fills the batch textarea with deduped video IDs', async () => {
  const page = await dashboard(state(), {
    hash: `#token=${token}&videos=vid00000001,vid00000002,vid00000001&titles=${encodeURIComponent('First title\nSecond title\nDuplicate title')}`
  });
  assert.equal(page.get('batch').value, 'vid00000001\nvid00000002');
  assert.match(page.get('batch-result').textContent, /2 video link\(s\) found on that YouTube page/);
  await page.get('add-batch').click();
  const jobs = page.calls.filter(call => call.route === '/api/jobs').map(call => JSON.parse(call.body));
  assert.deepEqual(jobs.map(item => item.title), ['First title', 'Second title']);
});

test('a scanned-page hash merges into an already-restored pending batch instead of replacing it', async () => {
  const page = await dashboard(state(), {
    hash: `#token=${token}&videos=vid00000002`,
    saved: {'yt-summary-batch': JSON.stringify([{videoId: 'vid00000001', requestId: '00000000-0000-4000-8000-000000000009', summaryLevel: 'ultra'}])}
  });
  assert.equal(page.get('batch').value, 'vid00000001\nvid00000002');
});

test('a scanned-page hash with no recognizable video links reports nothing found', async () => {
  const page = await dashboard(state(), {hash: `#token=${token}&videos=short,x`});
  assert.match(page.get('batch-result').textContent, /did not contain any recognizable/);
});

test('dropping a YouTube link onto the batch dropzone queues and submits it immediately', async () => {
  const page = await dashboard(state());
  const dropzone = page.get('batch-dropzone');
  await dropzone.events.get('drop')({
    preventDefault() {},
    dataTransfer: {getData: type => type === 'text/uri-list' ? 'https://www.youtube.com/watch?v=vid00000001' :
      type === 'text/html' ? '<a href="https://www.youtube.com/watch?v=vid00000001" title="Dragged video title">Video</a>' : ''}
  });
  await settle();
  const calls = page.calls.filter(call => call.route === '/api/jobs');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].body), {
    videoId: 'vid00000001', requestId: '00000000-0000-4000-8000-000000000001',
    summaryLevel: 'ultra', title: 'Dragged video title'
  });
});

test('dropping several link formats merges unique IDs and skips unrecognizable drops', async () => {
  const page = await dashboard(state());
  const dropzone = page.get('batch-dropzone');
  await dropzone.events.get('drop')({
    preventDefault() {},
    dataTransfer: {
      getData: type => type === 'text/plain'
        ? 'https://youtu.be/vid00000002\nhttps://example.com/not-a-video\nvid00000002'
        : ''
    }
  });
  await settle();
  const calls = page.calls.filter(call => call.route === '/api/jobs');
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].body).videoId, 'vid00000002');
});

test('dropping an unrecognizable link reports no match without submitting', async () => {
  const page = await dashboard(state());
  const dropzone = page.get('batch-dropzone');
  await dropzone.events.get('drop')({
    preventDefault() {},
    dataTransfer: {getData: () => 'https://example.com/nothing-here'}
  });
  await settle();
  assert.equal(page.calls.filter(call => call.route === '/api/jobs').length, 0);
  assert.match(page.get('batch-result').textContent, /did not contain a recognizable YouTube link/);
});

test('the batch bookmark generates javascript that scans a YouTube listing page for video links', () => {
  assert.match(source, /makeBatchBookmarkCode/);
  assert.match(source, /watch\?v=.*youtu\.be\/.*\/shorts\//);
  assert.match(source, /titles:titles\.join/);
});

test('dropping a link onto a specific level dropzone queues it at that level, ignoring the default', async () => {
  const page = await dashboard(state({summaryLevel: 'ultra'}));
  const zone = page.get('level-dropzone-micro');
  await zone.events.get('drop')({
    preventDefault() {},
    dataTransfer: {getData: type => type === 'text/uri-list' ? 'https://www.youtube.com/watch?v=vid00000001' :
      type === 'text/html' ? '<a aria-label="Specific level title">Video</a>' : ''}
  });
  await settle();
  const calls = page.calls.filter(call => call.route === '/api/jobs');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].body).summaryLevel, 'micro');
  assert.deepEqual(JSON.parse(calls[0].body).title, 'Specific level title');
  assert.match(page.get('batch-result').textContent, /accepted at Micro level/);
});

test('dropping several links onto a level dropzone dedupes and submits each once at that level', async () => {
  const page = await dashboard(state());
  const zone = page.get('level-dropzone-full');
  await zone.events.get('drop')({
    preventDefault() {},
    dataTransfer: {
      getData: type => type === 'text/plain'
        ? 'https://youtu.be/vid00000002\nvid00000002\nhttps://www.youtube.com/watch?v=vid00000003'
        : ''
    }
  });
  await settle();
  const calls = page.calls.filter(call => call.route === '/api/jobs').map(call => JSON.parse(call.body));
  assert.equal(calls.length, 2);
  assert.ok(calls.every(call => call.summaryLevel === 'full'));
});

test('dropping an unrecognizable link on a level dropzone reports no match without submitting', async () => {
  const page = await dashboard(state());
  const zone = page.get('level-dropzone-reg');
  await zone.events.get('drop')({
    preventDefault() {},
    dataTransfer: {getData: () => 'https://example.com/nothing-here'}
  });
  await settle();
  assert.equal(page.calls.filter(call => call.route === '/api/jobs').length, 0);
  assert.match(page.get('batch-result').textContent, /did not contain a recognizable YouTube link/);
});

test('Get later dropzone creates a held Reg job atomically regardless of the saved default', async () => {
  const page = await dashboard(state({summaryLevel: 'ultra'}));
  const zone = page.get('level-dropzone-later');
  let prevented = false;
  zone.events.get('dragover')({preventDefault() { prevented = true; }});
  assert.equal(prevented, true);
  assert.equal(zone.classes.has('drag-over'), true);
  zone.events.get('dragleave')();
  assert.equal(zone.classes.has('drag-over'), false);

  await zone.events.get('drop')({
    preventDefault() {},
    dataTransfer: {getData: type => type === 'text/uri-list' ? 'https://www.youtube.com/watch?v=vid00000001' :
      type === 'text/html' ? '<a aria-label="Get later title">Video</a>' : ''}
  });
  await settle();
  const calls = page.calls.filter(call => call.route === '/api/jobs').map(call => JSON.parse(call.body));
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    videoId: 'vid00000001',
    requestId: '00000000-0000-4000-8000-000000000001',
    summaryLevel: 'reg',
    watchLater: true,
    title: 'Get later title'
  });
  assert.match(page.get('batch-result').textContent,
    /^1 request\(s\) accepted at Reg level and marked Watch later\.$/);
});

test('Get later multi-drop dedupes, continues after failures and lists each failed video', async () => {
  const page = await dashboard(state(), {
    onFetch: async (route, config) => {
      if (route === '/api/jobs' && JSON.parse(config.body).videoId === 'vid00000003') {
        throw new Error('Fixture rejected.');
      }
    }
  });
  const zone = page.get('level-dropzone-later');
  await zone.events.get('drop')({
    preventDefault() {},
    dataTransfer: {
      getData: type => type === 'text/plain'
        ? 'https://youtu.be/vid00000002\nvid00000002\nhttps://www.youtube.com/watch?v=vid00000003\nhttps://youtu.be/vid00000004'
        : ''
    }
  });
  await settle();
  const calls = page.calls.filter(call => call.route === '/api/jobs').map(call => JSON.parse(call.body));
  assert.deepEqual(calls.map(call => call.videoId), ['vid00000002', 'vid00000003', 'vid00000004']);
  assert.ok(calls.every(call => call.summaryLevel === 'reg' && call.watchLater === true));
  assert.match(page.get('batch-result').textContent,
    /^2 request\(s\) accepted at Reg level and marked Watch later\./);
  assert.match(page.get('batch-result').textContent, /vid00000003: Fixture rejected\./);
});

test('an existing bookmark launch still uses the original protocol and server default', async () => {
  const page = await dashboard(state({summaryLevel: 'max'}), {
    hash: `#token=${token}&video=vid00000001&request=00000000-0000-4000-8000-000000000001`
  });
  const calls = page.calls.filter(call => call.route === '/api/jobs');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].body), {videoId: 'vid00000001', requestId: '00000000-0000-4000-8000-000000000001'});
  assert.equal(page.get('summary-level').value, 'max');
});

test('a bookmark launch carries the YouTube title into the queued job', async () => {
  const page = await dashboard(state(), {
    hash: `#token=${token}&video=vid00000001&title=${encodeURIComponent('Visible video title - YouTube')}&request=00000000-0000-4000-8000-000000000001`
  });
  const call = page.calls.find(item => item.route === '/api/jobs');
  assert.deepEqual(JSON.parse(call.body), {
    videoId: 'vid00000001', title: 'Visible video title',
    requestId: '00000000-0000-4000-8000-000000000001'
  });
});

test('a bookmark launch with a level parameter overrides the server default for that job', async () => {
  const page = await dashboard(state({summaryLevel: 'ultra'}), {
    hash: `#token=${token}&video=vid00000001&request=00000000-0000-4000-8000-000000000001&level=min`
  });
  const calls = page.calls.filter(call => call.route === '/api/jobs');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].body), {
    videoId: 'vid00000001',
    requestId: '00000000-0000-4000-8000-000000000001',
    summaryLevel: 'min'
  });
});

test('a bookmark launch with an invalid level parameter falls back to server default', async () => {
  const page = await dashboard(state({summaryLevel: 'reg'}), {
    hash: `#token=${token}&video=vid00000001&request=00000000-0000-4000-8000-000000000001&level=invalid`
  });
  const calls = page.calls.filter(call => call.route === '/api/jobs');
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(calls[0].body), {
    videoId: 'vid00000001',
    requestId: '00000000-0000-4000-8000-000000000001'
  });
});

test('each video job tile emphasizes when its transcript has been saved to disk', async () => {
  const savedJob = {...job('saved-job', 'summarizing'), VideoId: 'vid-saved', TranscriptSaved: true};
  const unsavedJob = {...job('unsaved-job', 'queued'), VideoId: 'vid-unsaved', TranscriptSaved: false};
  const fullJob = {...job('full-job', 'completed'), VideoId: 'vid-full', FinalResult: 'local'};
  const page = await dashboard(state({jobs: [savedJob, unsavedJob, fullJob]}), {
    saved: {'yt-summary-status-filters': JSON.stringify({completed: true, todayOnly: false, queued: true, active: true})}
  });

  const allCards = [...page.get('jobs-active').children, ...page.get('jobs-history').children];
  const findCard = videoId => allCards.find(card => card.children[0].children[0].textContent === videoId);

  const activeCard = findCard('vid-saved');
  assert.ok(activeCard, 'saved-job card was rendered');
  const activeTranscriptBadge = activeCard.children[1].children[7];
  assert.equal(activeTranscriptBadge.hidden, false, 'active job with TranscriptSaved=true shows the badge');
  assert.equal(activeTranscriptBadge.textContent, '💾 Transcript saved to disk');
  assert.ok(activeCard.className.includes('has-saved-transcript'),
    'active card with TranscriptSaved=true carries the has-saved-transcript emphasis class');

  const queuedCard = findCard('vid-unsaved');
  assert.ok(queuedCard, 'unsaved-job card was rendered');
  const queuedTranscriptBadge = queuedCard.children[1].children[7];
  assert.equal(queuedTranscriptBadge.hidden, true, 'queued job without saved transcript hides the badge');
  assert.ok(!queuedCard.className.includes('has-saved-transcript'),
    'card without saved transcript does not have the emphasis class');

  const historyCard = findCard('vid-full');
  assert.ok(historyCard, 'full-job card was rendered');
  const historyTranscriptBadge = historyCard.children[1].children[7];
  assert.equal(historyTranscriptBadge.hidden, false, 'completed Full job with local result shows the badge');
  assert.equal(historyTranscriptBadge.textContent, '💾 Transcript saved to disk');
  assert.ok(historyCard.className.includes('has-saved-transcript'),
    'completed Full job card carries the has-saved-transcript emphasis class');
});

test('Kiwi pairing controls appear only when private-network access is enabled', async () => {
  const local = await dashboard(state({mobileOrigin: ''}));
  assert.equal(local.get('kiwi-setup').hidden, true);
  assert.equal(local.get('kiwi-pairing-url').value, '');

  const mobile = await dashboard(state({mobileOrigin: 'http://192.168.50.20:8765'}));
  assert.equal(mobile.get('kiwi-setup').hidden, false);
  assert.equal(mobile.get('kiwi-pairing-url').value,
    `http://192.168.50.20:8765/#token=${token}`);
});

test('a duplicate completed bookmark opens its existing provider summary', async () => {
  const existing = job('existing', 'completed', 'https://chatgpt.com/c/existing-summary');
  const page = await dashboard(state({jobs: [existing]}), {
    hash: `#token=${token}&video=vid00000001&request=00000000-0000-4000-8000-000000000001&level=ultra`,
    jobResponse: existing
  });
  assert.equal(page.calls.filter(call => call.route === '/api/jobs').length, 1);
  assert.equal(page.navigated(), 'https://chatgpt.com/c/existing-summary');
});

test('a duplicate completed Full bookmark opens its existing local result', async () => {
  const existing = {...job('existing-full', 'completed'), SummaryLevel: 'full', FinalResult: 'local'};
  const page = await dashboard(state({jobs: [existing]}), {
    hash: `#token=${token}&video=vid00000001&request=00000000-0000-4000-8000-000000000001&level=full`,
    jobResponse: existing,
    finalResult: 'Previously completed full transcript.'
  });
  assert.equal(page.calls.filter(call => call.route === '/api/jobs').length, 1);
  assert.equal(page.calls.filter(call => call.route === '/api/result').length, 1);
  assert.equal(page.get('full-result-text').value, 'Previously completed full transcript.');
  assert.equal(page.get('full-result').hidden, false);
});
