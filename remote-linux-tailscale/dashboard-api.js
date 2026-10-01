'use strict';
// remote-linux-tailscale/dashboard-api.js
//
// The /api/* contract of the Windows helper (LoopbackServer.cs), implemented on top of this
// folder's pipeline so the SAME dashboard (../index.html + ../app.js) runs unchanged against
// the Linux server. Job fields, states and action rules mirror LoopbackServer.cs; the
// remote-specific differences are:
//   - one video runs at a time (one server browser), so maxConcurrent is 1;
//   - a finished summary is stored on the server as text (FinalResult "local", read through
//     /api/result) instead of a link into the user's own provider conversation;
//   - "Stop helper" stops all work and holds the queue instead of exiting the process, since
//     a remote server could not be started again from the dashboard;
//   - "Attach final summary link" opens that conversation in the server's browser and saves
//     its last answer as the result.
// Jobs, results and settings persist under the state directory, so history survives restarts.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LEVELS = ['legacy', 'ultra', 'max', 'reg', 'min', 'micro', 'full'];
const PROVIDERS = ['ChatGPT', 'Gemini', 'Claude'];
const TERMINAL = ['submitted', 'completed', 'error', 'needs-review', 'reviewed', 'cancelled'];
const AUTO_RETRY_LIMIT = 2;
const AUTO_RETRY_DELAY_MS = 2 * 60 * 1000;
const MAX_UNFINISHED = 200;
// Finished jobs kept (the Windows helper keeps 100). Higher here: on the server the summary
// text lives with the job, and one channel import can add 50 at once.
const HISTORY_KEEP = 1000;
const SOURCE_PEEK_INTERVAL_MS = 30 * 60 * 1000; // how often saved lists are checked for new videos
const SEEN_IDS_KEEP = 1000;
// The server browser grows with every video and froze once after ~50; restart it this often
// (and at once when it stops responding). Logins live in the profile and survive.
const BROWSER_RECYCLE_EVERY = 10;

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const isTerminal = (job) => TERMINAL.includes(job.State);
const now = () => new Date().toISOString();

function atomicWrite(file, text) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Jobs as <id>.json, results as <id>.result.txt, plus settings.json.
class JobStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.jobs = [];
    this.sequence = 0;
    for (const name of fs.readdirSync(dir)) {
      if (!/^[0-9a-f-]{36}\.json$/i.test(name)) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        this.jobs.push(job);
        this.sequence = Math.max(this.sequence, Number(job.Sequence) || 0);
      } catch { /* a damaged file is skipped, never fatal */ }
    }
    this.jobs.sort((a, b) => (a.Sequence || 0) - (b.Sequence || 0));
  }

  get(id) {
    return this.jobs.find((j) => j.Id === id) || null;
  }

  save(job) {
    job.UpdatedAt = now();
    atomicWrite(path.join(this.dir, `${job.Id}.json`), JSON.stringify(job));
  }

  add(job) {
    job.Sequence = ++this.sequence;
    this.jobs.push(job);
    this.save(job);
  }

  // Moves a job to the end of the list (most recent), as the Windows helper does on reuse.
  touch(job) {
    job.Sequence = ++this.sequence;
    this.jobs.splice(this.jobs.indexOf(job), 1);
    this.jobs.push(job);
    this.save(job);
  }

  remove(job) {
    this.jobs.splice(this.jobs.indexOf(job), 1);
    for (const file of [`${job.Id}.json`, `${job.Id}.result.txt`, `${job.Id}.parts.json`]) {
      fs.rmSync(path.join(this.dir, file), { force: true });
    }
  }

  // Finished parts of a chunked video: [{ index, provider, text, url }], saved as they arrive.
  getParts(job) {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, `${job.Id}.parts.json`), 'utf8')); } catch { return []; }
  }

  savePart(job, part) {
    const parts = this.getParts(job).filter((p) => p.index !== part.index);
    parts.push(part);
    parts.sort((a, b) => a.index - b.index);
    atomicWrite(path.join(this.dir, `${job.Id}.parts.json`), JSON.stringify(parts));
  }

  setResult(job, text) {
    atomicWrite(path.join(this.dir, `${job.Id}.result.txt`), text);
    job.FinalResult = 'local';
    job.TranscriptSaved = true;
  }

  getResult(job) {
    if (job.FinalResult !== 'local') throw new ApiError(409, 'This job has no saved local result.');
    return fs.readFileSync(path.join(this.dir, `${job.Id}.result.txt`), 'utf8');
  }

  clearResult(job) {
    fs.rmSync(path.join(this.dir, `${job.Id}.result.txt`), { force: true });
    fs.rmSync(path.join(this.dir, `${job.Id}.parts.json`), { force: true });
    job.FinalResult = '';
    job.TranscriptSaved = false;
  }

  // Playlists/channels imported before, so they can be checked again: [{ id, url, kind, title,
  // limit, summaryLevel, createdAt, lastRunAt, lastResult }].
  loadSources() {
    try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'sources.json'), 'utf8')); } catch { return []; }
  }

  saveSources(sources) {
    atomicWrite(path.join(this.dir, 'sources.json'), JSON.stringify(sources));
  }

  // Saved searches: searches/<id>.json holds the filters and the results as they were saved.
  searchesDir() {
    const dir = path.join(this.dir, 'searches');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  listSearches() {
    const dir = this.searchesDir();
    return fs.readdirSync(dir).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f)).map((f) => {
      try {
        const { results, ...entry } = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        return entry;
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => String(b.savedAt).localeCompare(String(a.savedAt)));
  }

  getSearch(id) {
    if (typeof id !== 'string' || !GUID.test(id)) throw new ApiError(400, 'A valid saved search id is required.');
    try { return JSON.parse(fs.readFileSync(path.join(this.searchesDir(), `${id}.json`), 'utf8')); }
    catch { throw new ApiError(409, 'That saved search no longer exists.'); }
  }

  saveSearch(entry) {
    atomicWrite(path.join(this.searchesDir(), `${entry.id}.json`), JSON.stringify(entry));
  }

  deleteSearch(id) {
    this.getSearch(id);
    fs.rmSync(path.join(this.searchesDir(), `${id}.json`), { force: true });
  }

  loadSettings() {
    const defaults = { summaryLevel: 'ultra', enabledProviders: [...PROVIDERS], keepIntermediateTabs: false };
    try {
      return { ...defaults, ...JSON.parse(fs.readFileSync(path.join(this.dir, 'settings.json'), 'utf8')) };
    } catch {
      return defaults;
    }
  }

  saveSettings(settings) {
    atomicWrite(path.join(this.dir, 'settings.json'), JSON.stringify(settings));
  }
}

function newJob({ videoId, requestId, title, summaryLevel, watchLater }) {
  const at = now();
  return {
    Id: crypto.randomUUID(), RequestId: requestId, VideoId: videoId, Title: title || '',
    DurationSeconds: 0, SummaryLevel: summaryLevel, SummaryLanguage: 'hebrew',
    State: 'queued', Message: 'Queued for the server browser.',
    ResultUrl: '', PartResultUrls: [], ProviderName: 'ChatGPT', RotationCursor: 0, StageIndex: 0,
    Progress: '', RetryReason: '', TranscriptHash: '', TranscriptLength: 0, ChunkCount: 0,
    SuccessfulParts: 0, PausedByUser: false, WatchLater: !!watchLater, TranscriptSaved: false,
    AmbiguousTargetId: '', AmbiguousTextSha256: '', ReconcileAttempted: false,
    AutoRetryAttempts: 0, AutoRetryAfterUtc: null, FinalResult: '', CreatedAt: at, UpdatedAt: at, Sequence: 0,
  };
}

function resetProgress(job) {
  Object.assign(job, {
    ResultUrl: '', PartResultUrls: [], ProviderName: 'ChatGPT', RotationCursor: 0, StageIndex: 0,
    Progress: '', RetryReason: '', TranscriptHash: '', TranscriptLength: 0, ChunkCount: 0, SuccessfulParts: 0,
  });
}

// Turns the pipeline's status lines into the job fields the dashboard shows.
function applyStatus(job, message) {
  let m;
  job.Message = message;
  if (/^(Fetching transcript|Reusing cached transcript|Cleared saved progress)/.test(message)) job.State = 'loading';
  if ((m = /^Transcript fetched \((\d+) chars\)/.exec(message))) job.TranscriptLength = Number(m[1]);
  if ((m = /^Chunk part (\d+)\/(\d+): starting/.exec(message))) {
    job.State = 'summarizing';
    job.ChunkCount = Number(m[2]);
    job.StageIndex = Number(m[1]) - 1;
    job.Progress = `Part ${m[1]} of ${m[2]}`;
  }
  if ((m = /^Chunk part (\d+)\/(\d+): done via/.exec(message))) job.SuccessfulParts = Number(m[1]);
  if (/^Combining \d+ parts/.test(message)) {
    job.State = 'combining';
    job.Progress = 'Final summary';
  }
  if ((m = /^Sending to (ChatGPT|Gemini|Claude)/.exec(message))) {
    job.ProviderName = m[1];
    if (job.State !== 'combining') job.State = m[1].toLowerCase();
  }
}

async function fetchOEmbedTitle(videoId) {
  try {
    const res = await fetch(`https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`,
      { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return '';
    return String((await res.json()).title || '').trim().slice(0, 300);
  } catch {
    return '';
  }
}

class Scheduler {
  constructor({ store, runner, fetchTitle = fetchOEmbedTitle, browserReady = async () => true, attachRunner = null, log = () => {},
    listVideos = (url, options) => require('./import-list').listVideos(url, options),
    recycleBrowser = null,
    loadCheckpoint = (videoId) => require('./checkpoint').loadCheckpoint(videoId) }) {
    this.loadCheckpoint = loadCheckpoint;
    this.listVideos = listVideos;
    this.recycleBrowser = recycleBrowser;
    this.videosSinceRecycle = 0;
    this.recycling = false;
    this.store = store;
    this.runner = runner;
    this.fetchTitle = fetchTitle;
    this.browserReady = browserReady;
    this.attachRunner = attachRunner;
    this.log = log;
    this.settings = store.loadSettings();
    this.current = null; // { job, controller, mode: 'stop'|'pause'|'watch-later'|'helper' }
    this.held = false;   // IP change in progress
    this.paused = false;
    this.pauseKind = '';
    this.pauseReason = '';
    this.ready = true;
    this.browserMessage = '';

    // Anything left mid-run by a crash/restart goes back to the queue, and like the Windows
    // helper nothing starts on its own after a restart until the user says so.
    for (const job of store.jobs) {
      if (!isTerminal(job) && job.State !== 'queued') {
        job.State = 'queued';
        job.Message = 'Interrupted by a server restart; it resumes from its saved checkpoint.';
        store.save(job);
      }
    }
    if (store.jobs.some((j) => j.State === 'queued')) this.hold('restart', 'The server restarted.');
  }

  get busy() {
    return !!this.current;
  }

  hold(kind, reason) {
    this.paused = true;
    this.pauseKind = kind;
    this.pauseReason = reason;
  }

  clearHold() {
    this.paused = false;
    this.pauseKind = '';
    this.pauseReason = '';
    this.pump();
  }

  setHeld(held) {
    this.held = held;
    if (!held) this.pump();
  }

  startTimer() {
    this.timer = setInterval(() => this.tick().catch(() => {}), 5000);
    this.timer.unref();
    // Saved channels/playlists: count new videos shortly after start, then every 30 minutes.
    const peek = () => this.peekAllSources().catch(() => {});
    this.peekStart = setTimeout(peek, 60 * 1000);
    this.peekStart.unref();
    this.peekTimer = setInterval(peek, SOURCE_PEEK_INTERVAL_MS);
    this.peekTimer.unref();
  }

  async tick() {
    if (this.recycling) return; // browserMessage already explains the short pause
    this.ready = await this.browserReady();
    this.browserMessage = this.ready ? '' : 'The server browser is not responding; queued videos wait until it is back.';
    // Due automatic retries go back to the queue.
    for (const job of this.store.jobs) {
      if (job.State === 'error' && job.AutoRetryAfterUtc && !job.PausedByUser && !job.WatchLater &&
          Date.parse(job.AutoRetryAfterUtc) <= Date.now()) {
        job.State = 'queued';
        job.AutoRetryAfterUtc = null;
        job.Message = `Automatic retry ${job.AutoRetryAttempts} of ${AUTO_RETRY_LIMIT}, from its saved checkpoint.`;
        this.store.save(job);
      }
    }
    this.pump();
  }

  status() {
    const jobs = this.store.jobs;
    return {
      app: 'YT Summary', ready: this.ready, stopping: false, browserMessage: this.browserMessage,
      summaryLevel: this.settings.summaryLevel, summaryLanguage: 'hebrew',
      enabledProviders: this.settings.enabledProviders, keepIntermediateTabs: this.settings.keepIntermediateTabs,
      paused: this.paused, pauseReason: this.pauseReason, pauseKind: this.pauseKind,
      autoRetryLimit: AUTO_RETRY_LIMIT, pausedWorkers: jobs.filter((j) => j.State === 'paused').length,
      maxConcurrent: 1, startIntervalMilliseconds: 0, mobileOrigin: '',
      providerOrder: PROVIDERS,
      active: jobs.filter((j) => !isTerminal(j) && j.State !== 'queued').length,
      queued: jobs.filter((j) => j.State === 'queued').length,
      reviewRequired: jobs.some((j) => j.State === 'needs-review'),
      job: jobs[jobs.length - 1] || null, jobs,
    };
  }

  find(id) {
    if (typeof id !== 'string' || !GUID.test(id)) throw new ApiError(400, 'A valid jobId is required.');
    const job = this.store.get(id);
    if (!job) throw new ApiError(409, 'Unknown job.');
    return job;
  }

  enqueue(body) {
    const { videoId, requestId } = body;
    const hasLevel = body.summaryLevel !== undefined;
    if (typeof videoId !== 'string' || !VIDEO_ID.test(videoId) || typeof requestId !== 'string' || !GUID.test(requestId) ||
        (hasLevel && !LEVELS.includes(body.summaryLevel)) ||
        (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim().length > 300)) ||
        (body.watchLater !== undefined && typeof body.watchLater !== 'boolean')) {
      throw new ApiError(400, 'A video ID and request ID, with optional valid summaryLevel, title and watchLater, are required.');
    }
    const title = (body.title || '').trim();
    const level = hasLevel ? body.summaryLevel : this.settings.summaryLevel;
    const byRequest = this.store.jobs.find((j) => j.RequestId === requestId);
    if (byRequest) {
      if (byRequest.VideoId !== videoId) throw new ApiError(409, 'Request ID already belongs to another video.');
      if (hasLevel && byRequest.SummaryLevel !== level) throw new ApiError(409, 'Request ID already belongs to another summary level.');
      if (!byRequest.Title && title) { byRequest.Title = title; this.store.save(byRequest); }
      return byRequest;
    }
    const existing = [...this.store.jobs].reverse().find((j) => j.VideoId === videoId && j.SummaryLevel === level);
    if (existing) {
      if (!existing.Title && title) existing.Title = title;
      if (existing.State === 'completed' && existing.FinalResult === 'local') this.store.touch(existing);
      else this.store.save(existing);
      return existing;
    }
    if (this.store.jobs.filter((j) => !isTerminal(j) || j.State === 'needs-review').length >= MAX_UNFINISHED) {
      throw new ApiError(429, 'The queue is full (200 unfinished videos). Wait or review pending sends.');
    }
    const job = newJob({ videoId, requestId, title, summaryLevel: level, watchLater: body.watchLater });
    this.store.add(job);
    if (this.pauseKind === 'restart') this.clearHold(); // adding a video is an explicit request to work
    // Keep only the most recent finished history.
    const history = this.store.jobs.filter((j) => isTerminal(j) && j.State !== 'needs-review');
    for (const old of history.slice(0, Math.max(0, history.length - HISTORY_KEEP))) this.store.remove(old);
    if (!job.Title) {
      this.fetchTitle(videoId).then((found) => {
        if (found && !job.Title && this.store.get(job.Id)) { job.Title = found; this.store.save(job); }
      });
    }
    this.pump();
    return job;
  }

  // "Add a playlist or channel": every video becomes its own job. A video that already has a
  // job at this summary level is not processed again (enqueue returns the existing job).
  async importList(body) {
    const level = body.summaryLevel === undefined ? this.settings.summaryLevel : body.summaryLevel;
    if (!LEVELS.includes(level)) throw new ApiError(400, 'Unknown summary level.');
    if (typeof body.url !== 'string' || !body.url.trim()) throw new ApiError(400, 'Paste a YouTube playlist or channel link.');
    let listed;
    try {
      listed = await this.listVideos(body.url, { limit: body.limit });
    } catch (err) {
      throw new ApiError(err.status || 502, err.status ? err.message : `Could not read that link: ${err.message}`);
    }
    const result = { kind: listed.kind, title: listed.title, found: listed.videos.length, added: 0, alreadyDone: 0, alreadyListed: 0, notAdded: 0, error: '' };
    const limit = listed.kind === 'channel' ? Math.max(1, Math.floor(Number(body.limit)) || 1) : null;
    // Each job remembers where it came from; shown on its tile and searchable.
    const source = { SourceKind: listed.kind, SourceTitle: listed.title || listed.url || body.url, SourceUrl: listed.url || body.url };
    for (const video of listed.videos) {
      const existing = this.store.jobs.find((j) => j.VideoId === video.videoId && j.SummaryLevel === level);
      if (existing) {
        if (existing.State === 'completed') result.alreadyDone++; else result.alreadyListed++;
        if (!existing.SourceTitle) { Object.assign(existing, source); this.store.save(existing); result.labeled = (result.labeled || 0) + 1; }
        continue;
      }
      if (body.labelOnly) continue; // only label videos that already have a job
      try {
        const job = this.enqueue({ videoId: video.videoId, requestId: crypto.randomUUID(), title: video.title, summaryLevel: level });
        if (video.durationSeconds && !job.DurationSeconds) job.DurationSeconds = video.durationSeconds;
        Object.assign(job, source);
        this.store.save(job);
        result.added++;
      } catch (err) {
        result.notAdded = listed.videos.length - result.added - result.alreadyDone - result.alreadyListed;
        result.error = err.message;
        break;
      }
    }
    if (!body.labelOnly) {
      result.source = this.rememberSource({
        url: listed.url || body.url, kind: listed.kind, title: listed.title, limit, summaryLevel: level, result,
        seenIds: listed.videos.map((v) => v.videoId),
      });
    }
    return result;
  }

  // Every successful import is remembered (one entry per link; importing it again updates it).
  rememberSource({ url, kind, title, limit, summaryLevel, result, seenIds = [] }) {
    const sources = this.store.loadSources();
    let source = sources.find((s) => s.url === url);
    if (!source) {
      source = { id: crypto.randomUUID(), url, kind, createdAt: now() };
      sources.push(source);
    }
    Object.assign(source, {
      title: title || source.title || url, limit, summaryLevel, lastRunAt: now(),
      lastResult: { found: result.found, added: result.added, alreadyDone: result.alreadyDone, alreadyListed: result.alreadyListed, error: result.error },
      // Every video listed at this check counts as seen, so later checks can tell what is new.
      seenIds: [...new Set([...seenIds, ...(source.seenIds || [])])].slice(0, SEEN_IDS_KEEP),
      pending: { count: 0, ids: [], checkedAt: now(), error: '' },
    });
    this.store.saveSources(sources);
    return source;
  }

  // Videos that appeared since the last import and have no job at the list's level yet.
  // A channel lists newest first, so its new videos are the ones above the newest video that
  // was already seen or already has a job; a playlist's are the entries not seen before.
  async peekSource(id) {
    const source = this.findSource(id);
    const hasJob = (videoId) => this.store.jobs.some((j) => j.VideoId === videoId && j.SummaryLevel === source.summaryLevel);
    const seen = new Set(source.seenIds || []);
    let pending;
    try {
      const listed = await this.listVideos(source.url, { limit: Math.max(source.limit || 1, 50) });
      let ids;
      if (source.kind === 'channel') {
        const stop = listed.videos.findIndex((v) => seen.has(v.videoId) || hasJob(v.videoId));
        ids = listed.videos.slice(0, stop < 0 ? listed.videos.length : stop).map((v) => v.videoId);
      } else {
        ids = listed.videos.filter((v) => !seen.has(v.videoId) && !hasJob(v.videoId)).map((v) => v.videoId);
      }
      pending = { count: ids.length, ids, checkedAt: now(), error: '' };
    } catch (err) {
      pending = { ...(source.pending || { count: 0, ids: [] }), checkedAt: now(), error: err.message };
    }
    const sources = this.store.loadSources();
    const entry = sources.find((s) => s.id === id);
    if (entry) { entry.pending = pending; this.store.saveSources(sources); }
    return { id, ...pending };
  }

  async peekAllSources() {
    if (this.peeking) return { results: [], busy: true };
    this.peeking = true;
    try {
      const results = [];
      for (const source of this.store.loadSources()) results.push(await this.peekSource(source.id).catch((err) => ({ id: source.id, error: err.message })));
      return { results };
    } finally {
      this.peeking = false;
    }
  }

  findSource(id) {
    const source = this.store.loadSources().find((s) => s.id === id);
    if (!source) throw new ApiError(409, 'That saved channel or playlist no longer exists.');
    return source;
  }

  // Checks a saved channel/playlist again with its saved count and level.
  // labelOnly: tag videos that already have a job with this source, without adding any.
  runSource(id, { labelOnly = false } = {}) {
    const source = this.findSource(id);
    // Never leave a known new video behind: take at least as many as are waiting.
    const limit = Math.max(source.limit || 1, (source.pending && source.pending.count) || 0);
    return this.importList({ url: source.url, limit, summaryLevel: source.summaryLevel, labelOnly }).then((result) => {
      if (limit !== (source.limit || 1)) {
        // Keep the user's own "latest N" setting; the larger count was only for this run.
        const sources = this.store.loadSources();
        const entry = sources.find((s) => s.id === id);
        if (entry) { entry.limit = source.limit; this.store.saveSources(sources); }
      }
      return result;
    });
  }

  async runAllSources() {
    const results = [];
    for (const source of this.store.loadSources()) {
      try { results.push({ id: source.id, ...(await this.runSource(source.id)) }); }
      catch (err) { results.push({ id: source.id, title: source.title, error: err.message }); }
    }
    return { results };
  }

  updateSource(body) {
    const sources = this.store.loadSources();
    const source = sources.find((s) => s.id === body.id);
    if (!source) throw new ApiError(409, 'That saved channel or playlist no longer exists.');
    if (body.limit !== undefined) {
      const limit = Number(body.limit);
      if (!Number.isInteger(limit) || limit < 1) throw new ApiError(400, 'Latest videos must be a whole number, 1 or more.');
      if (source.kind === 'channel') source.limit = limit;
    }
    if (body.summaryLevel !== undefined) {
      if (!LEVELS.includes(body.summaryLevel)) throw new ApiError(400, 'Unknown summary level.');
      source.summaryLevel = body.summaryLevel;
    }
    this.store.saveSources(sources);
    return source;
  }

  deleteSource(id) {
    this.findSource(id);
    this.store.saveSources(this.store.loadSources().filter((s) => s.id !== id));
  }

  pump() {
    if (this.current || this.held || this.paused || !this.ready || this.recycling) return;
    const job = this.store.jobs.find((j) => j.State === 'queued' && !j.WatchLater);
    if (job) this.run(job);
  }

  async run(job, { force = false } = {}) {
    const controller = new AbortController();
    this.current = { job, controller, mode: null };
    job.State = 'starting';
    job.Message = 'Starting in the server browser.';
    job.PausedByUser = false;
    this.store.save(job);
    const clear = !!job.clearRequested;
    delete job.clearRequested;
    let frozenProviders = 0; // providers that failed only because the browser stopped answering
    try {
      const result = await this.runner({
        videoId: job.VideoId, level: job.SummaryLevel, clear, signal: controller.signal,
        out: process.env.YT_SUMMARY_OUT || process.cwd(), maxMessageChars: 22000,
        providers: this.settings.enabledProviders,
        onPart: (part) => {
          this.store.savePart(job, part);
          job.PartResultUrls = this.store.getParts(job).map((p) => p.url).filter(Boolean);
          this.store.save(job);
        },
        onInfo: ({ title, durationSeconds }) => {
          if (title && title !== job.VideoId && !job.Title) job.Title = title;
          if (durationSeconds) job.DurationSeconds = durationSeconds;
          this.store.save(job);
        },
      }, (message) => {
        if (/transient infrastructure error persisted/.test(message)) frozenProviders++;
        applyStatus(job, message);
        this.store.save(job);
        this.log(`[${job.VideoId}] ${message}`);
      });
      this.store.setResult(job, result.text);
      for (const part of result.parts || []) this.store.savePart(job, part);
      job.ResultUrl = result.url || '';
      job.PartResultUrls = (result.parts || []).map((p) => p.url).filter(Boolean);
      job.FinalProvider = result.provider;
      job.State = 'completed';
      job.Message = `Summary ready (final part via ${result.provider}).`;
      job.ProviderName = result.provider;
      job.AutoRetryAttempts = 0;
      job.AutoRetryAfterUtc = null;
    } catch (err) {
      const mode = this.current.mode;
      if (mode === 'pause') {
        job.State = 'cancelled';
        job.PausedByUser = true;
        job.Message = 'Paused. Progress is saved; use Start now or Retry from checkpoint to continue.';
      } else if (mode === 'watch-later') {
        job.State = 'cancelled';
        job.Message = 'Set aside for Watch later. Progress is saved.';
      } else if (mode === 'helper') {
        job.State = 'queued';
        job.Message = 'Stopped with all work; it resumes from its saved checkpoint when you start the queue.';
      } else if (mode === 'stop') {
        job.State = 'cancelled';
        job.Message = 'Stopped at your request. Progress is saved; Retry from checkpoint continues it.';
      } else {
        job.State = 'error';
        job.Message = frozenProviders >= 2
          ? 'The server browser stopped responding. It is being restarted; this video retries automatically.'
          : err.message;
        job.RetryReason = err.message;
        if (err.retryable && job.AutoRetryAttempts < AUTO_RETRY_LIMIT) {
          job.AutoRetryAttempts += 1;
          job.AutoRetryAfterUtc = new Date(Date.now() + AUTO_RETRY_DELAY_MS).toISOString();
        } else {
          job.AutoRetryAfterUtc = null;
        }
      }
    } finally {
      this.store.save(job);
      this.current = null;
      this.videosSinceRecycle++;
      const frozen = job.State === 'error' && frozenProviders >= 2;
      if (this.recycleBrowser && (frozen || this.videosSinceRecycle >= BROWSER_RECYCLE_EVERY)) {
        this.restartBrowser(frozen ? 'it stopped responding' : `routine refresh after ${this.videosSinceRecycle} videos`);
      } else {
        setImmediate(() => this.pump());
      }
    }
  }

  // Between videos only: restart the server browser, then carry on with the queue.
  async restartBrowser(reason) {
    this.recycling = true;
    this.browserMessage = `Restarting the server browser (${reason}); the queue continues in a moment.`;
    this.log(`Restarting the server browser: ${reason}.`);
    try {
      await this.recycleBrowser();
      this.videosSinceRecycle = 0;
      this.log('Server browser restarted.');
    } catch (err) {
      this.log(`Server browser restart failed: ${err.message}`);
    } finally {
      this.recycling = false;
      this.browserMessage = '';
      setImmediate(() => this.pump());
    }
  }

  cancelCurrent(job, mode) {
    if (!this.current || this.current.job !== job) return false;
    this.current.mode = mode;
    this.current.controller.abort();
    job.Message = 'Stopping after the current step…';
    this.store.save(job);
    return true;
  }

  // --- actions (same rules as LoopbackServer.cs) ---

  retry(id) {
    const job = this.find(id);
    if (!['error', 'cancelled', 'needs-review'].includes(job.State)) throw new ApiError(409, 'Only a stopped or failed video can be retried.');
    const wasWatchLater = job.WatchLater;
    Object.assign(job, {
      State: 'queued', RetryReason: '', PausedByUser: false, WatchLater: false, AutoRetryAttempts: 0, AutoRetryAfterUtc: null,
      Message: wasWatchLater ? 'Retrying from its saved checkpoint. Removed from Watch later so it can actually run.'
        : 'Retrying from its saved checkpoint.',
    });
    this.store.save(job);
    if (this.pauseKind === 'restart') this.clearHold(); else this.pump();
    return job;
  }

  // Every failed video from any day (the dashboard's own button only covers today's).
  retryAllFailed() {
    const failed = this.store.jobs.filter((j) => j.State === 'error' && !j.WatchLater);
    for (const job of failed) {
      Object.assign(job, {
        State: 'queued', RetryReason: '', PausedByUser: false, AutoRetryAttempts: 0, AutoRetryAfterUtc: null,
        Message: 'Retrying from its saved checkpoint.',
      });
      this.store.save(job);
    }
    if (failed.length) {
      if (this.pauseKind === 'restart') this.clearHold(); else this.pump();
    }
    return { retried: failed.length };
  }

  startNow(id) {
    const job = this.find(id);
    if (job.State === 'completed' || job.State === 'submitted') throw new ApiError(409, 'This video already finished; there is nothing to start.');
    if (this.current && this.current.job === job) return job;
    Object.assign(job, {
      State: 'queued', RetryReason: '', PausedByUser: false, WatchLater: false, AutoRetryAttempts: 0, AutoRetryAfterUtc: null,
      Message: 'Starting now at your request; it runs as soon as the server browser is free.',
    });
    // Put it first in line.
    this.store.jobs.splice(this.store.jobs.indexOf(job), 1);
    const firstQueued = this.store.jobs.findIndex((j) => j.State === 'queued');
    this.store.jobs.splice(firstQueued < 0 ? this.store.jobs.length : firstQueued, 0, job);
    this.store.save(job);
    this.paused = false;
    this.pauseKind = '';
    this.pauseReason = '';
    this.pump();
    return job;
  }

  clearProgress(id) {
    const job = this.find(id);
    if (this.current && this.current.job === job) throw new ApiError(409, 'This video is still being processed. Stop it first.');
    resetProgress(job);
    this.store.clearResult(job);
    Object.assign(job, {
      State: 'queued', Message: 'Local transcript and summary progress cleared.', PausedByUser: false,
      AutoRetryAttempts: 0, AutoRetryAfterUtc: null, clearRequested: true,
    });
    this.store.save(job);
    if (this.pauseKind === 'restart') this.clearHold(); else this.pump();
  }

  stopJob(id) {
    const job = this.find(id);
    if (isTerminal(job)) throw new ApiError(409, 'This video already finished; there is nothing to stop.');
    if (job.State === 'queued') {
      job.State = 'cancelled';
      job.Message = 'Stopped while queued, before any provider was used. Other queued videos continue.';
      this.store.save(job);
      return;
    }
    this.cancelCurrent(job, 'stop');
  }

  pauseJob(id) {
    const job = this.find(id);
    if (isTerminal(job)) throw new ApiError(409, 'This video already finished; there is nothing to pause.');
    job.PausedByUser = true;
    if (job.State === 'queued') {
      job.State = 'cancelled';
      job.Message = 'Paused while queued, before any provider was used. Resume anytime; other queued videos continue.';
      this.store.save(job);
      return;
    }
    this.cancelCurrent(job, 'pause');
  }

  setWatchLater(id, watchLater) {
    const job = this.find(id);
    if (typeof watchLater !== 'boolean') throw new ApiError(400, 'A valid jobId and watchLater (true/false) are required.');
    if (job.WatchLater === watchLater) return;
    job.WatchLater = watchLater;
    this.store.save(job);
    if (watchLater) this.cancelCurrent(job, 'watch-later');
    else this.pump();
  }

  setLevel(id, level) {
    const job = this.find(id);
    if (!LEVELS.includes(level)) throw new ApiError(400, 'A valid jobId and summaryLevel are required.');
    if (job.State !== 'queued' && !isTerminal(job)) throw new ApiError(409, 'A video that is currently running cannot have its summary level changed.');
    if (job.SummaryLevel === level) return;
    job.SummaryLevel = level;
    if (isTerminal(job)) {
      resetProgress(job);
      this.store.clearResult(job);
      Object.assign(job, {
        State: 'cancelled', PausedByUser: true,
        Message: 'Summary level changed. Previous progress was cleared; click Retry from checkpoint when you want to run it.',
      });
    }
    this.store.save(job);
  }

  deleteJob(id) {
    const job = this.find(id);
    if (job.State !== 'queued' && !isTerminal(job)) throw new ApiError(409, 'This video is still being processed. Stop it first, then remove it.');
    this.store.remove(job);
  }

  clearWhere(predicate) {
    const doomed = this.store.jobs.filter(predicate);
    for (const job of doomed) this.store.remove(job);
    return doomed.length;
  }

  clearDuplicates() {
    const rank = (j) => (j.State === 'completed' && (j.ResultUrl || j.FinalResult === 'local') ? 5
      : j.State === 'completed' ? 4 : j.State === 'submitted' ? 3 : ['error', 'needs-review'].includes(j.State) ? 2
        : j.State === 'reviewed' ? 1 : 0);
    const groups = new Map();
    for (const job of this.store.jobs.filter(isTerminal)) {
      const key = `${job.VideoId}\n${job.SummaryLevel || 'legacy'}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(job);
    }
    const doomed = [];
    for (const list of groups.values()) {
      list.sort((a, b) => rank(b) - rank(a) || Date.parse(b.UpdatedAt) - Date.parse(a.UpdatedAt) || b.Sequence - a.Sequence);
      doomed.push(...list.slice(1));
    }
    return this.clearWhere((j) => doomed.includes(j));
  }

  // "Stop helper": remotely this stops all work and holds the queue (see module comment).
  stopAll() {
    if (this.current) this.cancelCurrent(this.current.job, 'helper');
    this.hold('restart', 'All work was stopped from the dashboard.');
  }

  resume() {
    this.clearHold();
    for (const job of this.store.jobs) {
      if (job.State === 'paused') { job.State = 'queued'; this.store.save(job); }
    }
    this.pump();
  }

  async attachResult(id, url) {
    const job = this.find(id);
    let parsed;
    try { parsed = new URL(url); } catch { parsed = null; }
    if (!parsed || parsed.protocol !== 'https:' || !['chatgpt.com', 'gemini.google.com', 'claude.ai'].includes(parsed.host)) {
      throw new ApiError(400, 'A valid jobId and supported provider conversation URL are required.');
    }
    if (!['error', 'needs-review'].includes(job.State) || job.ResultUrl) {
      throw new ApiError(409, 'Only an ambiguous send with no saved result link can be reconciled this way.');
    }
    if (!this.attachRunner) throw new ApiError(501, 'Attaching a conversation is not available on this server.');
    if (this.current) throw new ApiError(409, 'A video is running in the server browser. Try again when it finishes.');
    const text = await this.attachRunner(parsed.href);
    this.store.setResult(job, text);
    Object.assign(job, {
      State: 'completed', ResultUrl: '', AutoRetryAfterUtc: null,
      Message: 'Reconciled: the answer in the attached conversation was saved as this video\'s summary.',
    });
    this.store.save(job);
    return job;
  }

  // Everything the tile viewer shows: the final summary (if done) and every finished part.
  details(id) {
    const job = this.find(id);
    let final = null;
    if (job.FinalResult === 'local') {
      final = { text: this.store.getResult(job), provider: job.FinalProvider || job.ProviderName || '', url: job.ResultUrl || '' };
    }
    let parts = this.store.getParts(job);
    if (!parts.length) {
      // Videos summarized before parts were stored: the pipeline's own checkpoint still has
      // them (without conversation links) while it matches this video's level.
      const ckpt = this.loadCheckpoint(job.VideoId);
      if (ckpt && ckpt.isChunked && ckpt.summaryLevel === job.SummaryLevel) {
        parts = (ckpt.parts || []).map(({ index, provider, text, url }) => ({ index, provider, text, url: url || null }))
          .sort((a, b) => a.index - b.index);
      }
    }
    return {
      id: job.Id, videoId: job.VideoId, title: job.Title, level: job.SummaryLevel, state: job.State,
      message: job.Message, final, parts,
      source: job.SourceTitle ? { kind: job.SourceKind, title: job.SourceTitle, url: job.SourceUrl } : null,
    };
  }

  // ---- Search in summaries ----

  // Videos that have summary text to search (finished, or with finished parts).
  searchableVideos() {
    return [...this.store.jobs].reverse()
      .filter((job) => job.FinalResult === 'local' || this.store.getParts(job).length)
      .map((job) => ({
        id: job.Id, videoId: job.VideoId, title: job.Title, level: job.SummaryLevel, state: job.State,
        createdAt: job.CreatedAt, sourceKind: job.SourceKind || '', sourceTitle: job.SourceTitle || '',
      }));
  }

  // body: { query, exclude?: ["not" phrases], jobIds?: [...] (default: every searchable video), contextWords? }
  search(body) {
    const { searchSections, normalizeQuery, DEFAULT_CONTEXT_WORDS } = require('./search');
    const query = typeof body.query === 'string' ? body.query : '';
    if (normalizeQuery(query).length < 2) throw new ApiError(400, 'Type at least 2 letters to search.');
    const contextWords = Math.min(200, Math.max(0, Math.floor(Number(body.contextWords ?? DEFAULT_CONTEXT_WORDS)) || 0));
    const wanted = Array.isArray(body.jobIds) ? new Set(body.jobIds) : null;
    const exclude = (Array.isArray(body.exclude) ? body.exclude : [])
      .filter((x) => typeof x === 'string' && normalizeQuery(x)).slice(0, 20);
    const videos = this.searchableVideos().filter((v) => !wanted || wanted.has(v.id));
    const results = [];
    let matches = 0;
    for (const video of videos) {
      const d = this.details(video.id);
      const sections = [];
      if (d.final) sections.push({ key: 'final', label: 'Final summary', provider: d.final.provider, text: d.final.text });
      for (const part of d.parts) {
        sections.push({ key: `part-${part.index}`, label: `Part ${part.index} of ${d.parts.length}`, provider: part.provider, text: part.text });
      }
      const found = searchSections(sections, query, contextWords, exclude);
      if (!found.length) continue;
      const count = found.reduce((sum, section) => sum + section.ranges.length, 0);
      matches += count;
      results.push({ ...video, matchCount: count, sections: found });
    }
    results.sort((a, b) => b.matchCount - a.matchCount || String(b.createdAt).localeCompare(String(a.createdAt)));
    return { query, exclude, contextWords, searched: videos.length, matches, results };
  }

  // body: the search's own fields (query, exclude, contextWords, jobIds?) + name, and id to
  // update an existing saved search. The search runs now and its results are stored with it.
  saveSearchEntry(body) {
    const results = this.search(body);
    const name = typeof body.name === 'string' && body.name.trim()
      ? body.name.trim().slice(0, 120)
      : [results.query, ...results.exclude.map((x) => `not "${x}"`)].join(', ');
    let id = crypto.randomUUID();
    let createdAt = now();
    if (body.id !== undefined) {
      const previous = this.store.getSearch(body.id); // throws if it is gone
      id = previous.id;
      createdAt = previous.createdAt || createdAt;
    }
    const entry = {
      id, name, createdAt, savedAt: now(),
      query: results.query, exclude: results.exclude, contextWords: results.contextWords,
      jobIds: Array.isArray(body.jobIds) ? body.jobIds.filter((x) => typeof x === 'string') : null,
      searched: results.searched, matches: results.matches, videos: results.results.length, results,
    };
    this.store.saveSearch(entry);
    const { results: omitted, ...summary } = entry;
    return summary;
  }

  saveSettings(body) {
    const next = { ...this.settings };
    let valid = false;
    if (body.summaryLevel !== undefined) {
      if (!LEVELS.includes(body.summaryLevel)) throw new ApiError(400, 'Unknown summary level.');
      next.summaryLevel = body.summaryLevel;
      valid = true;
    }
    if (body.enabledProviders !== undefined) {
      const list = body.enabledProviders;
      if (!Array.isArray(list) || !list.length || list.some((p) => !PROVIDERS.includes(p))) {
        throw new ApiError(400, 'Enable at least one provider: ChatGPT, Gemini, Claude.');
      }
      next.enabledProviders = PROVIDERS.filter((p) => list.includes(p));
      valid = true;
    }
    if (body.keepIntermediateTabs !== undefined) {
      if (typeof body.keepIntermediateTabs !== 'boolean') throw new ApiError(400, 'keepIntermediateTabs must be true or false.');
      next.keepIntermediateTabs = body.keepIntermediateTabs;
      valid = true;
    }
    if (body.summaryLanguage !== undefined) valid = true; // always Hebrew, as on Windows
    if (!valid) throw new ApiError(400, 'Provide a valid summaryLevel, summaryLanguage, keepIntermediateTabs, and/or enabledProviders.');
    this.store.saveSettings(next);
    this.settings = next;
    return {
      summaryLevel: next.summaryLevel, enabledProviders: next.enabledProviders,
      summaryLanguage: 'hebrew', keepIntermediateTabs: next.keepIntermediateTabs,
    };
  }
}

// Routes one /api/* request. `body` is the parsed JSON object (POST) or null (GET).
async function handleApi(scheduler, method, pathname, body) {
  if (method === 'GET' && pathname === '/api/status') return scheduler.status();
  if (method === 'GET' && pathname === '/api/search/videos') return { videos: scheduler.searchableVideos() };
  if (method === 'GET' && pathname === '/api/searches') return { searches: scheduler.store.listSearches() };
  if (method === 'GET' && pathname === '/api/sources') return { sources: scheduler.store.loadSources() };
  if (method !== 'POST') throw new ApiError(404, 'Unknown endpoint.');
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ApiError(400, 'A JSON object is required.');
  switch (pathname) {
    case '/api/jobs': return scheduler.enqueue(body);
    case '/api/settings': return scheduler.saveSettings(body);
    case '/api/resume': scheduler.resume(); return { paused: false, pauseReason: '' };
    case '/api/stop': scheduler.stopAll(); return { stopping: true };
    case '/api/retry': return scheduler.retry(body.jobId);
    case '/api/retry-failed': return scheduler.retryAllFailed();
    case '/api/clear': scheduler.clearProgress(body.jobId); return { cleared: true };
    case '/api/start-job': return scheduler.startNow(body.jobId);
    case '/api/stop-job': scheduler.stopJob(body.jobId); return { stopping: true };
    case '/api/pause-job': scheduler.pauseJob(body.jobId); return { pausing: true };
    case '/api/delete-job': scheduler.deleteJob(body.jobId); return { deleted: true };
    case '/api/watch-later': scheduler.setWatchLater(body.jobId, body.watchLater); return { updated: true };
    case '/api/set-job-level': scheduler.setLevel(body.jobId, body.summaryLevel); return { updated: true };
    case '/api/attach-result': return scheduler.attachResult(body.jobId, body.resultUrl);
    case '/api/details': return scheduler.details(body.jobId);
    case '/api/import': return scheduler.importList(body);
    case '/api/search': return scheduler.search(body);
    case '/api/searches/save': return scheduler.saveSearchEntry(body);
    case '/api/searches/get': return scheduler.store.getSearch(body.id);
    case '/api/searches/delete': scheduler.store.deleteSearch(body.id); return { deleted: true };
    case '/api/browser/restart':
      if (!scheduler.recycleBrowser) throw new ApiError(501, 'Browser restart is not available on this server.');
      if (scheduler.current || scheduler.recycling) throw new ApiError(409, 'A video is running (or a restart is underway). Try again when it finishes.');
      await scheduler.restartBrowser('requested from the dashboard');
      return { restarted: true };
    case '/api/sources/run': return scheduler.runSource(body.id, { labelOnly: body.labelOnly === true });
    case '/api/sources/run-all': return scheduler.runAllSources();
    case '/api/sources/peek': return body.id ? scheduler.peekSource(body.id) : scheduler.peekAllSources();
    case '/api/sources/update': return scheduler.updateSource(body);
    case '/api/sources/delete': scheduler.deleteSource(body.id); return { deleted: true };
    case '/api/result': return { finalResult: scheduler.store.getResult(scheduler.find(body.jobId)) };
    case '/api/clear-errors': return { cleared: scheduler.clearWhere((j) => j.State === 'error') };
    case '/api/clear-cancelled': return { cleared: scheduler.clearWhere((j) => ['cancelled', 'reviewed'].includes(j.State)) };
    case '/api/clear-duplicates': return { cleared: scheduler.clearDuplicates() };
    case '/api/acknowledge': throw new ApiError(409, 'This video has no pending send to review.');
    default: throw new ApiError(404, 'Unknown endpoint.');
  }
}

module.exports = { JobStore, Scheduler, handleApi, applyStatus, ApiError, AUTO_RETRY_LIMIT };
