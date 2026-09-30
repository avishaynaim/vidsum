'use strict';

(() => {
  const byId = id => document.getElementById(id);
  const fragment = new URLSearchParams(location.hash.slice(1));
  const token = fragment.get('token') || sessionStorage.getItem('yt-summary-token') || localStorage.getItem('yt-summary-token');
  const videoId = fragment.get('video');
  const videosParam = fragment.get('videos');
  const titleParam = fragment.get('title');
  const titlesParam = fragment.get('titles');
  const requestId = fragment.get('request');
  const requestedLevel = fragment.get('level');
  const importedVideoIds = !videoId && videosParam
    ? [...new Set(videosParam.split(',').map(v => v.trim()).filter(id => /^[A-Za-z0-9_-]{11}$/.test(id)))].slice(0, 200)
    : [];
  const importedTitles = new Map();
  if (videosParam && titlesParam) {
    const rawIds = videosParam.split(',');
    const rawTitles = titlesParam.split('\n');
    rawIds.forEach((id, index) => {
      const cleanTitle = normalizeVideoTitle(rawTitles[index]);
      if (/^[A-Za-z0-9_-]{11}$/.test(id) && cleanTitle && !importedTitles.has(id)) importedTitles.set(id, cleanTitle);
    });
  }
  history.replaceState(null, '', '/');
  let stopped = false;
  let launchFailed = false;
  let launch = null;
  let pollTimer;
  let selectedJob = sessionStorage.getItem('yt-summary-selected-job');
  let lastRenderedJobs = [];
  let pendingBatch = [];
  const pendingTitles = new Map(importedTitles);
  let resumePending = false;
  let summaryLevel = null;
  let summaryLanguage = null;
  let firstProvider = 'ChatGPT';
  let enabledProviders = [];
  let keepIntermediateTabs = null;
  let settingsPending = false;
  let settingsEpoch = 0;
  let settingsError = false;
  let batchPending = false;
  let clearErrorsPending = false;
  let clearDuplicatesPending = false;
  let clearCancelledPending = false;
  let cancelledJobCount = 0;
  let retryTodayPending = false;
  let retryTodayJobs = [];
  let controllerOnline = false;
  let browserReady = false;
  let pollInFlight = false;
  let lastStatusUpdatedAt = null;
  const statusSnapshotKey = 'yt-summary-status-snapshot-v1';
  const rows = new Map();
  const levels = {
    ultra: {label: 'Ultra', description: 'Comprehensive study notes: arguments, reasoning, examples, numbers and caveats. Target: 2,000-4,000 words when the source supports it.'},
    max: {label: 'Max', description: 'Every major point with important supporting details. Target: 1,000-2,000 words when the source supports it.'},
    reg: {label: 'Reg', description: 'A balanced overview of the main ideas and key explanations. Target: 400-800 words when the source supports it.'},
    min: {label: 'Min', description: 'Essential points and the takeaway. Target: 100-200 words, without unnecessary background.'},
    micro: {label: 'Micro', description: 'Only the conclusion in 1-3 sentences. No introduction, headings or recap.'},
    full: {label: 'Full', description: 'The complete transcript verbatim, with punctuation, paragraph structure and (for Hebrew sources) niqqud added. Nothing is summarized, shortened or omitted.'}
  };
  // Classifies a raw job state into a badge color/animation and which of the two
  // dashboard sections (active vs. history) the job card belongs in.
  const STATE_META = {
    queued: {badge: 'badge-queued', section: 'active'},
    starting: {badge: 'badge-active', section: 'active', pulse: true},
    loading: {badge: 'badge-active', section: 'active', pulse: true},
    verification: {badge: 'badge-attention', section: 'active'},
    'waiting-composer': {badge: 'badge-active', section: 'active', pulse: true},
    chatgpt: {badge: 'badge-active', section: 'active', pulse: true},
    gemini: {badge: 'badge-active', section: 'active', pulse: true},
    claude: {badge: 'badge-active', section: 'active', pulse: true},
    inserting: {badge: 'badge-active', section: 'active', pulse: true},
    sending: {badge: 'badge-active', section: 'active', pulse: true},
    splitting: {badge: 'badge-active', section: 'active', pulse: true},
    summarizing: {badge: 'badge-active', section: 'active', pulse: true},
    combining: {badge: 'badge-active', section: 'active', pulse: true},
    paused: {badge: 'badge-attention', section: 'active'},
    completed: {badge: 'badge-success', section: 'history'},
    submitted: {badge: 'badge-success', section: 'history'},
    error: {badge: 'badge-error', section: 'history'},
    'needs-review': {badge: 'badge-attention', section: 'history'},
    reviewed: {badge: 'badge-muted', section: 'history'},
    cancelled: {badge: 'badge-muted', section: 'history'}
  };
  function classifyState(state) {
    return STATE_META[state] || {badge: 'badge-muted', section: 'active'};
  }
  // Groups every job state into one of six user-facing filter categories. Any state not
  // explicitly listed (e.g. a future working state) falls back to "active" so it is never
  // silently hidden by an older saved filter preference.
  const STATUS_CATEGORIES = [
    {id: 'queued', label: 'Queued', states: ['queued']},
    {id: 'active', label: 'Active', states: ['starting', 'loading', 'verification', 'waiting-composer',
      'chatgpt', 'gemini', 'claude', 'inserting', 'sending', 'splitting', 'summarizing', 'combining']},
    {id: 'attention', label: 'Paused / needs attention', states: ['paused', 'needs-review']},
    {id: 'completed', label: 'Completed', states: ['completed', 'submitted']},
    {id: 'failed', label: 'Failed', states: ['error']},
    {id: 'other', label: 'Cancelled / reviewed', states: ['cancelled', 'reviewed']}
  ];
  const STATE_TO_CATEGORY = new Map();
  for (const category of STATUS_CATEGORIES) {
    for (const state of category.states) STATE_TO_CATEGORY.set(state, category.id);
  }
  const categoryForState = state => STATE_TO_CATEGORY.get(state) || 'active';
  const CATEGORY_RANK = new Map(STATUS_CATEGORIES.map((category, index) => [category.id, index]));
  const CATEGORY_LABEL = new Map(STATUS_CATEGORIES.map(category => [category.id, category.label]));
  function loadStatusFilters() {
    const defaults = {...Object.fromEntries(STATUS_CATEGORIES.map(category => [category.id, true])), todayOnly: true, watchLaterOnly: false};
    defaults.completed = false;
    try {
      const saved = JSON.parse(localStorage.getItem('yt-summary-status-filters') || 'null');
      if (saved && typeof saved === 'object') {
        for (const category of STATUS_CATEGORIES) {
          if (typeof saved[category.id] === 'boolean') defaults[category.id] = saved[category.id];
        }
        if (typeof saved.todayOnly === 'boolean') defaults.todayOnly = saved.todayOnly;
        if (typeof saved.watchLaterOnly === 'boolean') defaults.watchLaterOnly = saved.watchLaterOnly;
        return defaults;
      }
    } catch { /* ignore malformed saved preferences and use the documented defaults */ }
    // One-time migration from the earlier single "hide completed/failed history" checkbox.
    if (localStorage.getItem('yt-summary-hide-history-done') === '1') {
      defaults.completed = false;
      defaults.failed = false;
    }
    return defaults;
  }
  const statusFilters = loadStatusFilters();
  // Mirrors LocalServer.MaxAutoRetryAttempts. The live value arrives with every status poll,
  // so the wording can never promise more automatic attempts than the server will run.
  let autoRetryLimit = 3;
  let dispatchPaused = false;
  // Free-text search over the video title and id. It is deliberately not persisted: a saved
  // search would silently hide every job on the next launch.
  let searchTokens = [];
  const searchTextOf = job => `${job.Title || ''} ${job.VideoId || ''}`.toLowerCase();
  const tokenizeSearch = value => String(value || '').toLowerCase().split(/\s+/).filter(Boolean);
  const matchesSearch = job => {
    const haystack = searchTextOf(job);
    return searchTokens.every(token => haystack.includes(token));
  };
  function saveStatusFilters() {
    localStorage.setItem('yt-summary-status-filters', JSON.stringify(statusFilters));
    localStorage.removeItem('yt-summary-hide-history-done');
  }
  // Reuses the exact Short/Medium/Long/Extreme buckets already shown as the duration badge on
  // every card (see durationBucket below), plus "unknown" for a video whose length has not
  // been looked up yet, so the filter never invents a second set of length definitions.
  const LENGTH_CATEGORIES = [
    {id: 'short', label: 'Short'},
    {id: 'medium', label: 'Medium'},
    {id: 'long', label: 'Long'},
    {id: 'extreme', label: 'Extreme'},
    {id: 'unknown', label: 'Unknown length'}
  ];
  function lengthCategoryForJob(job) {
    const bucket = durationBucket(job.DurationSeconds);
    return bucket ? bucket.className.replace('duration-', '') : 'unknown';
  }
  function loadLengthFilters() {
    const defaults = Object.fromEntries(LENGTH_CATEGORIES.map(category => [category.id, true]));
    try {
      const saved = JSON.parse(localStorage.getItem('yt-summary-length-filters') || 'null');
      if (saved && typeof saved === 'object') {
        for (const category of LENGTH_CATEGORIES) {
          if (typeof saved[category.id] === 'boolean') defaults[category.id] = saved[category.id];
        }
      }
    } catch { /* ignore malformed saved preferences and use the documented defaults */ }
    return defaults;
  }
  const lengthFilters = loadLengthFilters();
  function saveLengthFilters() {
    localStorage.setItem('yt-summary-length-filters', JSON.stringify(lengthFilters));
  }
  const SORT_MODES = ['updated', 'status', 'created', 'title'];
  function loadSortPreference() {
    // Matches the dashboard's long-standing default: grouped by status, newest first within
    // each group. Adding the other modes must not silently reorder anyone's existing view.
    const defaults = {active: 'status', history: 'status'};
    try {
      const saved = JSON.parse(localStorage.getItem('yt-summary-job-sort') || 'null');
      if (saved && typeof saved === 'object') {
        for (const section of ['active', 'history']) {
          if (SORT_MODES.includes(saved[section])) defaults[section] = saved[section];
        }
      }
    } catch { /* ignore malformed saved preferences and use the documented default */ }
    return defaults;
  }
  const sortPreference = loadSortPreference();
  function saveSortPreference() {
    localStorage.setItem('yt-summary-job-sort', JSON.stringify(sortPreference));
  }
  const SORT_COMPARATORS = {
    // A stable tie-break on VideoId keeps the order deterministic when two jobs share the exact
    // same timestamp or title, instead of jittering between renders.
    updated: (left, right) => (jobSortTime(right.UpdatedAt) - jobSortTime(left.UpdatedAt)) ||
      String(left.VideoId).localeCompare(String(right.VideoId)),
    created: (left, right) => (jobSortTime(right.CreatedAt) - jobSortTime(left.CreatedAt)) ||
      String(left.VideoId).localeCompare(String(right.VideoId)),
    title: (left, right) => (left.Title || left.VideoId).localeCompare(right.Title || right.VideoId)
  };
  // A job with no parseable timestamp sorts to the bottom of a newest-first list rather than
  // floating to the top as if it were the most recent thing that happened.
  function jobSortTime(value) {
    const parsed = parseJobDate(value);
    return parsed ? parsed.getTime() : -Infinity;
  }
  const validLevel = value => typeof value === 'string' && Object.hasOwn(levels, value);
  function normalizeVideoTitle(value) {
    return String(value || '').replace(/\s+-\s+YouTube$/i, '').replace(/\s+/g, ' ').trim().slice(0, 300);
  }
  const languages = {
    hebrew: {label: 'Hebrew'}
  };
  const validLanguage = value => typeof value === 'string' && Object.hasOwn(languages, value);
  const providerOrder = ['ChatGPT', 'Gemini', 'Claude'];
  const providerControls = {
    ChatGPT: {toggle: 'provider-chatgpt', option: 'first-provider-chatgpt'},
    Gemini: {toggle: 'provider-gemini', option: 'first-provider-gemini'},
    Claude: {toggle: 'provider-claude', option: 'first-provider-claude'}
  };
  const validProviders = value => Array.isArray(value) && value.length > 0 &&
    new Set(value).size === value.length && value.every(provider => providerOrder.includes(provider));

  function updateSummaryControls() {
    const unavailable = stopped || !controllerOnline || settingsPending || !summaryLevel;
    byId('summary-level').disabled = unavailable || batchPending;
    byId('summary-language').disabled = true;
    byId('first-provider').disabled = unavailable || batchPending;
    for (const provider of providerOrder) byId(providerControls[provider].toggle).disabled = unavailable || batchPending;
    byId('keep-intermediate-tabs').disabled = unavailable || batchPending || keepIntermediateTabs === null;
    byId('add-batch').disabled = unavailable || batchPending;
    byId('retry').disabled = unavailable;
  }

  function updateJobActionAvailability() {
    for (const row of rows.values()) {
      row.retry.disabled = !controllerOnline || stopped;
      row.clear.disabled = !controllerOnline || stopped;
      row.localResult.disabled = !controllerOnline || stopped;
    }
  }

  function formatSnapshotTime(value) {
    if (!value) return 'No successful status update was recorded in this tab.';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'The last update time is unavailable.' :
      `Last successful controller update: ${date.toLocaleString()}.`;
  }

  function setControllerAvailability(online, message = '') {
    controllerOnline = online;
    byId('controller-offline').hidden = online;
    if (!online) {
      byId('offline-message').textContent = message ||
        'Showing the last known jobs and history. Running work cannot continue while the helper is offline; its final state is reconciled after restart.';
      byId('offline-updated').textContent = formatSnapshotTime(lastStatusUpdatedAt);
    }
    updateSummaryControls();
    updateJobActionAvailability();
    byId('clear-errors').disabled = !online || stopped || clearErrorsPending;
    byId('clear-duplicates').disabled = !online || stopped || clearDuplicatesPending;
    byId('clear-cancelled').disabled = !online || stopped || clearCancelledPending;
    byId('retry-today').disabled = !online || stopped || retryTodayPending;
  }

  function saveStatusSnapshot(data) {
    lastStatusUpdatedAt = new Date().toISOString();
    try {
      const serialized = JSON.stringify({updatedAt: lastStatusUpdatedAt, data}, (key, value) =>
        /token|transcript|prompt|notes/i.test(key) ? undefined : value);
      localStorage.setItem(statusSnapshotKey, serialized);
    } catch (error) {
      byId('action-message').textContent =
        'The live dashboard is working, but its offline status snapshot could not be saved: ' + error.message;
    }
  }

  function loadStatusSnapshot() {
    try {
      const raw = localStorage.getItem(statusSnapshotKey);
      if (!raw) return null;
      const snapshot = JSON.parse(raw);
      if (!snapshot || typeof snapshot.updatedAt !== 'string' || !snapshot.data ||
          !Array.isArray(snapshot.data.jobs)) return null;
      lastStatusUpdatedAt = snapshot.updatedAt;
      return snapshot.data;
    } catch (error) {
      byId('action-message').textContent = 'The previous offline status snapshot could not be read: ' + error.message;
      return null;
    }
  }

  function displaySummaryLevel(level) {
    if (!validLevel(level)) throw new Error('The helper returned an unknown summary level. Reload the updated dashboard.');
    summaryLevel = level;
    byId('summary-level').value = level;
    byId('summary-level-description').textContent = levels[level].description;
  }

  function displaySummaryLanguage(language) {
    if (!validLanguage(language) && !['auto', 'english'].includes(language)) {
      throw new Error('The helper returned an unknown summary language. Reload the updated dashboard.');
    }
    summaryLanguage = 'hebrew';
    byId('summary-language').value = 'hebrew';
  }

  function displayEnabledProviders(providers) {
    if (!validProviders(providers)) throw new Error('The helper returned an invalid enabled-provider list. Reload the updated dashboard.');
    enabledProviders = providerOrder.filter(provider => providers.includes(provider));
    for (const provider of providerOrder) {
      const enabled = enabledProviders.includes(provider);
      byId(providerControls[provider].toggle).checked = enabled;
      byId(providerControls[provider].option).hidden = !enabled;
      byId(providerControls[provider].option).disabled = !enabled;
    }
    if (!enabledProviders.includes(firstProvider)) firstProvider = enabledProviders[0];
    byId('first-provider').value = firstProvider;
  }

  function displayKeepIntermediateTabs(value) {
    keepIntermediateTabs = Boolean(value);
    byId('keep-intermediate-tabs').checked = keepIntermediateTabs;
  }

  function status(state, message, error = false) {
    byId('state').textContent = state;
    byId('message').textContent = message;
    byId('message').classList.toggle('error', error);
  }

  async function request(path, method = 'GET', body) {
    const response = await fetch(path, {
      method,
      headers: {'X-YT-Token': token, ...(method === 'POST' ? {'Content-Type': 'application/json'} : {})},
      credentials: 'omit',
      cache: 'no-store',
      ...(body === undefined ? {} : {body: JSON.stringify(body)}),
      signal: AbortSignal.timeout(8000)
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `Local request failed (${response.status}).`);
    return data;
  }

  if (!/^[a-f0-9]{64}$/.test(token || '')) {
    status('Setup required', 'Open the Start YT Summary launcher to get an authorized setup page.', true);
    byId('setup').hidden = true;
    byId('stop').disabled = true;
    byId('add-batch').disabled = true;
    return;
  }
  sessionStorage.setItem('yt-summary-token', token);
  // Also persisted in localStorage (this computer only, matching the launcher's own local-only
  // token file) so reopening the dashboard in a new tab or after closing it still authenticates
  // without needing a fresh authorized link from Start YT Summary.cmd every time.
  localStorage.setItem('yt-summary-token', token);
  byId('summary-level').addEventListener('change', async () => {
    const requested = byId('summary-level').value;
    if (settingsPending || stopped) return;
    if (!validLevel(requested)) {
      byId('summary-level-status').textContent = 'Choose one of the six supported summary levels.';
      return;
    }
    settingsPending = true;
    settingsEpoch++;
    settingsError = false;
    updateSummaryControls();
    byId('summary-level-status').textContent = `Saving ${levels[requested].label}...`;
    try {
      const saved = await request('/api/settings', 'POST', {summaryLevel: requested});
      if (saved.summaryLevel !== requested) throw new Error('The saved level did not match the requested level.');
      displaySummaryLevel(saved.summaryLevel);
      displayEnabledProviders(saved.enabledProviders);
      byId('summary-level-status').textContent = `${levels[summaryLevel].label} saved for new videos. Existing jobs are unchanged.`;
    } catch (error) {
      summaryLevel = null;
      settingsError = true;
      byId('summary-level-status').textContent = 'Unable to confirm the level change: ' + error.message + ' The next status update will show the saved setting.';
    } finally {
      settingsPending = false;
      settingsEpoch++;
      updateSummaryControls();
    }
  });
  for (const provider of providerOrder) {
    byId(providerControls[provider].toggle).addEventListener('change', async () => {
      if (settingsPending || stopped) return;
      const requested = providerOrder.filter(name => byId(providerControls[name].toggle).checked);
      if (!requested.length) {
        byId(providerControls[provider].toggle).checked = true;
        byId('provider-settings-status').textContent = 'At least one provider must remain enabled.';
        return;
      }
      const previous = [...enabledProviders];
      settingsPending = true;
      settingsEpoch++;
      settingsError = false;
      updateSummaryControls();
      byId('provider-settings-status').textContent = 'Saving enabled providers...';
      try {
        const saved = await request('/api/settings', 'POST', {enabledProviders: requested});
        displaySummaryLevel(saved.summaryLevel);
        displayEnabledProviders(saved.enabledProviders);
        byId('provider-settings-status').textContent = `Enabled providers saved: ${enabledProviders.join(', ')}.`;
      } catch (error) {
        displayEnabledProviders(previous);
        settingsError = true;
        byId('provider-settings-status').textContent = 'Unable to save provider settings: ' + error.message;
      } finally {
        settingsPending = false;
        settingsEpoch++;
        updateSummaryControls();
      }
    });
  }
  byId('keep-intermediate-tabs').addEventListener('change', async () => {
    if (settingsPending || stopped) return;
    const requested = byId('keep-intermediate-tabs').checked;
    const previous = keepIntermediateTabs;
    settingsPending = true;
    settingsEpoch++;
    settingsError = false;
    updateSummaryControls();
    byId('keep-intermediate-tabs-status').textContent = 'Saving...';
    try {
      const saved = await request('/api/settings', 'POST', {keepIntermediateTabs: requested});
      displaySummaryLevel(saved.summaryLevel);
      displayEnabledProviders(saved.enabledProviders);
      displayKeepIntermediateTabs(saved.keepIntermediateTabs);
      byId('keep-intermediate-tabs-status').textContent = keepIntermediateTabs
        ? 'Every part and merge-stage tab stays open for review.'
        : 'Intermediate part/merge tabs close automatically; only the final summary tab stays open.';
    } catch (error) {
      displayKeepIntermediateTabs(previous);
      settingsError = true;
      byId('keep-intermediate-tabs-status').textContent = 'Unable to save this setting: ' + error.message;
    } finally {
      settingsPending = false;
      settingsEpoch++;
      updateSummaryControls();
    }
  });
  for (const category of STATUS_CATEGORIES) {
    const checkbox = byId('status-filter-' + category.id);
    checkbox.checked = statusFilters[category.id];
    checkbox.addEventListener('change', () => {
      statusFilters[category.id] = checkbox.checked;
      saveStatusFilters();
      renderJobs(lastRenderedJobs);
    });
  }
  const todayFilter = byId('status-filter-today');
  todayFilter.checked = statusFilters.todayOnly;
  todayFilter.addEventListener('change', () => {
    statusFilters.todayOnly = todayFilter.checked;
    saveStatusFilters();
    renderJobs(lastRenderedJobs);
  });
  const watchLaterFilter = byId('status-filter-watch-later');
  watchLaterFilter.checked = statusFilters.watchLaterOnly;
  watchLaterFilter.addEventListener('change', () => {
    statusFilters.watchLaterOnly = watchLaterFilter.checked;
    saveStatusFilters();
    renderJobs(lastRenderedJobs);
  });
  for (const category of LENGTH_CATEGORIES) {
    const checkbox = byId('length-filter-' + category.id);
    checkbox.checked = lengthFilters[category.id];
    checkbox.addEventListener('change', () => {
      lengthFilters[category.id] = checkbox.checked;
      saveLengthFilters();
      renderJobs(lastRenderedJobs);
    });
  }
  for (const section of ['active', 'history']) {
    const select = byId(section + '-sort');
    select.value = sortPreference[section];
    select.addEventListener('change', () => {
      sortPreference[section] = SORT_MODES.includes(select.value) ? select.value : 'status';
      saveSortPreference();
      renderJobs(lastRenderedJobs);
    });
  }
  const jobSearch = byId('job-search');
  const jobSearchClear = byId('job-search-clear');
  function applyJobSearch(value) {
    const tokens = tokenizeSearch(value);
    const unchanged = tokens.length === searchTokens.length &&
      tokens.every((token, index) => token === searchTokens[index]);
    searchTokens = tokens;
    jobSearchClear.hidden = tokens.length === 0;
    byId('job-search-hint').hidden = tokens.length === 0;
    if (!unchanged) renderJobs(lastRenderedJobs);
  }
  jobSearch.addEventListener('input', () => applyJobSearch(jobSearch.value));
  jobSearch.addEventListener('search', () => applyJobSearch(jobSearch.value));
  jobSearchClear.addEventListener('click', () => {
    jobSearch.value = '';
    applyJobSearch('');
    jobSearch.focus();
  });
  byId('first-provider').addEventListener('change', () => {
    const value = byId('first-provider').value;
    if (enabledProviders.includes(value)) {
      firstProvider = value;
      byId('provider-order').textContent = `This session starts at ${value}; enabled stages rotate ${enabledProviders.join(' → ')} and persist the successful provider cursor.`;
    }
  });
  if (videoId) {
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || !/^[a-f0-9-]{36}$/i.test(requestId || '')) {
      status('Invalid request', 'This bookmark contains an invalid video or request ID.', true);
      return;
    }
    launch = {videoId, requestId};
    const launchTitle = normalizeVideoTitle(titleParam);
    if (launchTitle) launch.title = launchTitle;
    if (validLevel(requestedLevel)) {
      launch.summaryLevel = requestedLevel;
    }
    sessionStorage.setItem('yt-summary-launch', JSON.stringify(launch));
  }

  const base = location.origin + '/';
  function makeBookmarkCode(level) {
    return 'javascript:(()=>{try{' +
      'const u=new URL(location.href),h=u.hostname;' +
      'if(!/(^|\\.)youtube\\.com$/.test(h)&&h!=="youtu.be")return alert("Open a YouTube video first.");' +
      'const v=u.searchParams.get("v")||(h==="youtu.be"?u.pathname.split("/")[1]:u.pathname.match(/^\\/(?:shorts|live|embed)\\/([^/]+)/)?.[1]);' +
      'if(!/^[A-Za-z0-9_-]{11}$/.test(v||""))return alert("YouTube video ID not found.");' +
      'const d=typeof document==="undefined"?null:document,t=(d?.querySelector("h1 yt-formatted-string,h1")?.textContent||d?.title||"").replace(/\\s+-\\s+YouTube$/i,"").replace(/\\s+/g," ").trim().slice(0,300);' +
      'const x=new URL(' + JSON.stringify(base) + ');' +
      'x.hash=new URLSearchParams({token:' + JSON.stringify(token) + ',video:v,title:t,request:crypto.randomUUID()' +
      (level ? ',level:' + JSON.stringify(level) : '') +
      '}).toString();' +
      'window.open(x.href,"_blank","noopener,noreferrer");' +
      '}catch(e){alert("Unable to start YT Summary: "+e.message)}})()';
  }

  function makeBatchBookmarkCode() {
    return 'javascript:(()=>{try{' +
      'const u=new URL(location.href),h=u.hostname;' +
      'if(!/(^|\\.)youtube\\.com$/.test(h)&&h!=="youtu.be")return alert("Open a YouTube page first (home, subscriptions, search results, history or a playlist).");' +
      'const seen=new Map();' +
      '[...document.querySelectorAll(\'a[href*="watch?v="],a[href*="youtu.be/"],a[href*="/shorts/"]\')].forEach(a=>{' +
      'try{const l=new URL(a.href,location.href);' +
      'const id=l.searchParams.get("v")||(l.hostname==="youtu.be"?l.pathname.split("/")[1]:l.pathname.match(/^\\/shorts\\/([^/]+)/)?.[1]);' +
      'const t=(a.getAttribute("title")||a.getAttribute("aria-label")||a.textContent||"").replace(/\\s+/g," ").trim().slice(0,300);' +
      'if(/^[A-Za-z0-9_-]{11}$/.test(id||"")&&(!seen.has(id)||(!seen.get(id)&&t)))seen.set(id,t);' +
      '}catch(e){}' +
      '});' +
      'if(!seen.size)return alert("No YouTube videos were found on this page.");' +
      'const items=[...seen].slice(0,150),ids=items.map(x=>x[0]),titles=items.map(x=>x[1]);' +
      'const x=new URL(' + JSON.stringify(base) + ');' +
      'x.hash=new URLSearchParams({token:' + JSON.stringify(token) + ',videos:ids.join(","),titles:titles.join("\\n"),request:crypto.randomUUID()}).toString();' +
      'window.open(x.href,"_blank","noopener,noreferrer");' +
      '}catch(e){alert("Unable to scan this page: "+e.message)}})()';
  }

  const bookmarkElements = {
    ultra: byId('bookmark'),
    max: byId('bookmark-max'),
    reg: byId('bookmark-reg'),
    min: byId('bookmark-min'),
    micro: byId('bookmark-micro'),
    full: byId('bookmark-full')
  };
  for (const [lvl, el] of Object.entries(bookmarkElements)) {
    if (!el) continue;
    const code = makeBookmarkCode(lvl);
    el.href = code;
    el.addEventListener('click', event => {
      event.preventDefault();
      byId('action-message').textContent = 'Drag this ' + (levels[lvl]?.label || '') + ' bookmark to your bookmarks bar, then use it on a YouTube video.';
    });
  }

  const bookmarkBatchElement = byId('bookmark-batch');
  if (bookmarkBatchElement) {
    bookmarkBatchElement.href = makeBatchBookmarkCode();
    bookmarkBatchElement.addEventListener('click', event => {
      event.preventDefault();
      byId('action-message').textContent = 'Drag this bookmark to your bookmarks bar. Use it on a YouTube home, subscriptions, search or playlist page to queue every video found there at the current default level.';
    });
  }

  function updateBookmarkCode() {
    const copyLevel = byId('copy-level')?.value || 'ultra';
    const code = makeBookmarkCode(validLevel(copyLevel) ? copyLevel : 'ultra');
    const codeArea = byId('bookmark-code');
    if (codeArea) codeArea.value = code;
  }
  const batchCodeArea = byId('bookmark-batch-code');
  if (batchCodeArea) batchCodeArea.value = makeBatchBookmarkCode();
  updateBookmarkCode();
  byId('copy-level')?.addEventListener('change', updateBookmarkCode);

  byId('copy')?.addEventListener('click', async () => {
    const copyLevel = byId('copy-level')?.value || 'ultra';
    const code = makeBookmarkCode(validLevel(copyLevel) ? copyLevel : 'ultra');
    try {
      await navigator.clipboard.writeText(code);
      byId('action-message').textContent = (levels[copyLevel]?.label || 'Bookmark') + ' address copied.';
    } catch {
      const codeArea = byId('bookmark-code');
      if (codeArea) {
        codeArea.focus();
        codeArea.select();
      }
      byId('action-message').textContent = 'Clipboard permission was not available. Press Ctrl+C to copy the selected address.';
    }
  });

  byId('copy-batch')?.addEventListener('click', async () => {
    const code = makeBatchBookmarkCode();
    try {
      await navigator.clipboard.writeText(code);
      byId('action-message').textContent = 'Batch bookmark address copied.';
    } catch {
      const codeArea = byId('bookmark-batch-code');
      if (codeArea) {
        codeArea.focus();
        codeArea.select();
      }
      byId('action-message').textContent = 'Clipboard permission was not available. Press Ctrl+C to copy the selected address.';
    }
  });

  byId('copy-kiwi-pairing')?.addEventListener('click', async () => {
    const value = byId('kiwi-pairing-url').value;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      byId('action-message').textContent = 'Kiwi pairing URL copied. Keep it private.';
    } catch {
      byId('kiwi-pairing-url').focus();
      byId('kiwi-pairing-url').select();
      byId('action-message').textContent = 'Press Ctrl+C to copy the selected Kiwi pairing URL.';
    }
  });

  async function submitLaunch() {
    if (!launch || settingsPending || stopped) return;
    byId('retry').hidden = true;
    launchFailed = false;
    status('Starting', 'Handing this video to the local controller...');
    try {
      const job = await request('/api/jobs', 'POST', launch);
      status(job.State, job.Message, ['error', 'needs-review'].includes(job.State));
      byId('video').textContent = 'Video: ' + job.VideoId;
      selectedJob = job.Id;
      sessionStorage.setItem('yt-summary-selected-job', selectedJob);
      sessionStorage.removeItem('yt-summary-launch');
      launch = null;
      if (['completed', 'submitted'].includes(job.State)) {
        if (job.FinalResult === 'local') {
          await openLocalResult(job.Id);
        } else if (validResultUrl(job.ResultUrl)) {
          location.assign(job.ResultUrl);
        }
      }
    } catch (error) {
      launchFailed = true;
      status('Launch not confirmed', error.message, true);
      byId('retry').hidden = false;
    }
  }
  byId('retry').addEventListener('click', submitLaunch);

  async function openPreviouslyCompleted(job) {
    if (job?.State !== 'completed') return false;
    selectedJob = job.Id;
    sessionStorage.setItem('yt-summary-selected-job', selectedJob);
    if (job.FinalResult === 'local') {
      await openLocalResult(job.Id);
      return true;
    }
    if (validResultUrl(job.ResultUrl)) {
      window.open(job.ResultUrl, '_blank', 'noopener,noreferrer');
      return true;
    }
    return false;
  }

  let restartHold = false;

  function renderAvailability(data) {
    browserReady = data.ready === true;
    dispatchPaused = data.paused === true;
    autoRetryLimit = Number(data.autoRetryLimit) > 0 ? Number(data.autoRetryLimit) : autoRetryLimit;
    byId('browser-unavailable').hidden = data.ready === true;
    byId('browser-recovery-message').textContent = data.browserMessage ||
      'Queued videos will reopen the dedicated browser automatically. Interrupted sends are not replayed.';
    restartHold = data.paused === true && data.pauseKind === 'restart';
    byId('quota-pause').hidden = data.paused !== true;
    byId('pause-reason').textContent = data.pauseReason || 'ChatGPT reported a usage limit.';
    // The banner is the only thing standing between the user and a queue that looks frozen,
    // so it has to name the real reason rather than always blaming a provider quota.
    const queued = Number(data.queued) || 0;
    byId('pause-title').textContent = restartHold
      ? 'Waiting for you to start the queued videos'
      : 'Paused for a ChatGPT usage limit';
    byId('pause-advice').textContent = restartHold
      ? 'Nothing runs on its own after a restart. Use the button below, or just add a video, to start them. No provider limit was reported.'
      : 'Wait until your quota resets, then resume. Existing replies may finish; no new messages or timed retries are started while paused.';
    byId('resume').textContent = restartHold
      ? (queued > 0 ? 'Start ' + queued + ' queued video' + (queued === 1 ? '' : 's') : 'Start queued videos')
      : 'Resume';
    byId('resume').hidden = data.paused !== true;
    byId('resume').disabled = resumePending || stopped;
  }

  byId('resume').addEventListener('click', async () => {
    if (resumePending || stopped) return;
    // A restart hold says nothing about provider quotas, so it must not warn about them.
    const question = restartHold
      ? 'Start the videos that were still queued when the helper restarted?'
      : 'Wait until your ChatGPT usage quota has reset before resuming. Resume allows waiting work to continue; it does not bypass site limits or automatically resend a failed message. Resume now?';
    if (!confirm(question)) return;
    resumePending = true;
    byId('resume').disabled = true;
    try {
      await request('/api/resume', 'POST', {});
      byId('action-message').textContent = restartHold
        ? 'Queued videos are starting now.'
        : 'Dispatch resumed. Failed or uncertain messages are not resubmitted automatically.';
    } catch (error) {
      byId('action-message').textContent = 'Unable to confirm resume: ' + error.message + ' Check the controller status before trying again.';
    } finally {
      resumePending = false;
    }
  });

  function neverSentToProvider(job) {
    // Transcript-stage failures explicitly report that nothing reached a provider, so there
    // is no conversation tab to reconcile or attach, and offering one is pure noise.
    if (Number(job.SuccessfulParts) > 0 || validResultUrl(job.ResultUrl)) return false;
    return /nothing was sent/i.test(job.Message || '');
  }

  function ambiguousSendRecoverable(job) {
    // Mirrors the server rule: any error/needs-review job with no captured result link may have
    // actually finished in its provider conversation, regardless of what the message says.
    if (!['error', 'needs-review'].includes(job.State)) return false;
    if (neverSentToProvider(job)) return false;
    return !validResultUrl(job.ResultUrl);
  }

  function jobDeletable(job) {
    // Mirrors the server rule: a video that has not started (queued) or is no longer being
    // worked on (a terminal state) can be safely removed. Anything else is still owned by a
    // worker and must be stopped first.
    return job.State === 'queued' ||
      ['submitted', 'completed', 'error', 'needs-review', 'reviewed', 'cancelled'].includes(job.State);
  }

  function hasAmbiguousMetadata(job) {
    // Only a stored browser target id or exact prompt hash gives the sweep something safe to
    // match against. Without either, there is nothing left to check, so the automatic
    // "checking" state must never be shown no matter what ReconcileAttempted says.
    return (typeof job.AmbiguousTargetId === 'string' && job.AmbiguousTargetId !== '') ||
      (typeof job.AmbiguousTextSha256 === 'string' && job.AmbiguousTextSha256 !== '');
  }

  function autoReconcilePending(job) {
    // While the helper still has its browser open it sweeps the provider tabs itself, so the
    // manual link prompt stays out of the way until that sweep has run and found nothing.
    return ambiguousSendRecoverable(job) && controllerOnline && browserReady &&
      job.ReconcileAttempted !== true && hasAmbiguousMetadata(job);
  }

  function validResultUrl(value) {
    return typeof value === 'string' &&
      /^https:\/\/(?:chatgpt\.com\/c\/[A-Za-z0-9_-]+|gemini\.google\.com\/app\/[A-Za-z0-9_-]+|claude\.ai\/chat\/[A-Za-z0-9_-]+)$(?![\s\S])/.test(value);
  }

  function parseJobDate(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    const dotNet = typeof value === 'string' && /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(value);
    const date = new Date(dotNet ? Number(dotNet[1]) : value);
    if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 2000) return null;
    return date;
  }

  function isCreatedToday(value) {
    const created = parseJobDate(value);
    if (!created) return false;
    const today = new Date();
    return created.getFullYear() === today.getFullYear() &&
      created.getMonth() === today.getMonth() &&
      created.getDate() === today.getDate();
  }

  function formatJobTimestamp(value) {
    const date = parseJobDate(value);
    return date ? date.toLocaleString() : '';
  }

  function formatElapsed(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
    if (minutes > 0) return `${minutes}m ${totalSeconds % 60}s ago`;
    return `${totalSeconds}s ago`;
  }

  function formatJobTimes(job) {
    const created = formatJobTimestamp(job.CreatedAt);
    const updatedDate = parseJobDate(job.UpdatedAt);
    const updated = updatedDate ? `${updatedDate.toLocaleString()} (${formatElapsed(Date.now() - updatedDate.getTime())})` : '';
    return [created && `Created ${created}`, updated && `Updated ${updated}`].filter(Boolean).join(' · ');
  }

  function formatDuration(seconds) {
    const total = Number(seconds);
    if (!Number.isSafeInteger(total) || total <= 0) return 'unknown';
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remaining = total % 60;
    return hours > 0
      ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remaining).padStart(2, '0')}`
      : `${minutes}:${String(remaining).padStart(2, '0')}`;
  }

  function durationBucket(seconds) {
    const total = Number(seconds);
    if (!Number.isSafeInteger(total) || total <= 0) return null;
    if (total < 1800) return {label: 'Short', className: 'duration-short'};
    if (total < 3600) return {label: 'Medium', className: 'duration-medium'};
    if (total < 21600) return {label: 'Long', className: 'duration-long'};
    return {label: 'Extreme', className: 'duration-extreme'};
  }

  function jobDayPresentation(value) {
    const date = parseJobDate(value);
    if (!date) return {label: 'Date unknown', color: 0, key: 'unknown'};
    const day = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const today = new Date();
    const localToday = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const difference = Math.round((localToday - day) / 86400000);
    // Pinned to en-US regardless of the OS locale: every other dashboard label (Today,
    // Yesterday, Created/Updated, etc.) is English, and leaving this on the system default
    // locale made the weekday name unpredictably render in another language/script.
    const label = difference === 0 ? 'Today' : difference === 1 ? 'Yesterday' :
      day.toLocaleDateString('en-US', {weekday: 'long', year: 'numeric', month: 'short', day: 'numeric'});
    const dayNumber = Math.floor(day.getTime() / 86400000);
    return {label, color: Math.abs(dayNumber) % 6, key: String(dayNumber)};
  }

  async function openLocalResult(jobId) {
    const saved = await request('/api/result', 'POST', {jobId});
    if (typeof saved.finalResult !== 'string' || !saved.finalResult) throw new Error('The saved result was empty.');
    byId('full-result-text').value = saved.finalResult;
    byId('full-result').hidden = false;
    byId('full-result').scrollIntoView?.({behavior: 'smooth', block: 'start'});
  }

  byId('copy-full-result').addEventListener('click', async () => {
    const text = byId('full-result-text').value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      byId('action-message').textContent = 'Full transcript copied.';
    } catch {
      byId('full-result-text').focus();
      byId('full-result-text').select();
      byId('action-message').textContent = 'Clipboard permission was unavailable. Press Ctrl+C to copy the selected transcript.';
    }
  });
  byId('close-full-result').addEventListener('click', () => {
    byId('full-result').hidden = true;
    byId('full-result-text').value = '';
  });

  function setChipCount(id, total) {
    const badge = byId('status-count-' + id);
    badge.textContent = String(total);
    badge.classList.toggle('chip-zero', total === 0);
  }
  function setLengthChipCount(id, total) {
    const badge = byId('length-count-' + id);
    badge.textContent = String(total);
    badge.classList.toggle('chip-zero', total === 0);
  }
  // Each chip shows how many videos it would reveal, counted against the other active
  // filters. Turning a chip on therefore adds exactly the number printed on it, so the
  // counts never promise cards that a different filter is still hiding.
  function updateFilterCounts(jobs) {
    const matching = searchTokens.length ? jobs.filter(matchesSearch) : jobs;
    const passesDay = job => !statusFilters.todayOnly || isCreatedToday(job.CreatedAt);
    const passesWatchLater = job => !statusFilters.watchLaterOnly || !!job.WatchLater;
    const passesCategory = job => statusFilters[categoryForState(job.State)] !== false;
    const passesLength = job => lengthFilters[lengthCategoryForJob(job)] !== false;
    // While a search is running it overrides the chips entirely, so the counts show the raw
    // per-category size of the search result instead of a filter preview that cannot apply.
    const searching = searchTokens.length > 0;
    for (const category of STATUS_CATEGORIES) {
      setChipCount(category.id, matching.filter(job => categoryForState(job.State) === category.id &&
        (searching || (passesDay(job) && passesWatchLater(job) && passesLength(job)))).length);
    }
    setChipCount('today', matching.filter(job => isCreatedToday(job.CreatedAt) &&
      (searching || (passesCategory(job) && passesWatchLater(job) && passesLength(job)))).length);
    setChipCount('watch-later', matching.filter(job => !!job.WatchLater &&
      (searching || (passesCategory(job) && passesDay(job) && passesLength(job)))).length);
    for (const category of LENGTH_CATEGORIES) {
      setLengthChipCount(category.id, matching.filter(job => lengthCategoryForJob(job) === category.id &&
        (searching || (passesCategory(job) && passesDay(job) && passesWatchLater(job)))).length);
    }
  }

  function renderJobs(jobs) {
    lastRenderedJobs = jobs;
    const ids = new Set(jobs.map(job => job.Id));
    for (const [id, row] of rows) {
      if (!ids.has(id)) { row.element.remove(); rows.delete(id); }
    }
    byId('empty-jobs').hidden = jobs.length > 0;
    let activeCount = 0;
    let historyCount = 0;
    let rawActiveCount = 0;
    let rawHistoryCount = 0;
    const lastDayKey = {active: null, history: null};
    // Each section (Active / History) is sorted independently per its own saved preference.
    // "Status" reproduces the original grouped behavior: reverse to newest-first, then a
    // stable sort by category so the existing relative order survives inside each group.
    // The other modes sort directly on a real field, with a VideoId tie-break for determinism.
    function sortSection(section) {
      const sectionJobs = jobs.filter(job => classifyState(job.State).section === section);
      const mode = sortPreference[section] || 'status';
      if (mode === 'status') {
        const ordered = [...sectionJobs].reverse();
        ordered.sort((left, right) =>
          (CATEGORY_RANK.get(categoryForState(left.State)) ?? 0) -
          (CATEGORY_RANK.get(categoryForState(right.State)) ?? 0));
        return ordered;
      }
      return [...sectionJobs].sort(SORT_COMPARATORS[mode] || SORT_COMPARATORS.updated);
    }
    const orderedJobs = [...sortSection('active'), ...sortSection('history')];
    const hiddenByFilter = job => {
      // An active search is a global find: it spans every status and day so a video is never
      // missing just because an unrelated status chip happens to be off.
      if (searchTokens.length) return !matchesSearch(job);
      // A completed video surfaced by an explicit request is always shown, even when the
      // Completed filter is off, because the user just asked to see that one.
      if (job.Id === selectedJob && job.State === 'completed') return false;
      return statusFilters[categoryForState(job.State)] === false ||
        (statusFilters.todayOnly && !isCreatedToday(job.CreatedAt)) ||
        (statusFilters.watchLaterOnly && !job.WatchLater) ||
        lengthFilters[lengthCategoryForJob(job)] === false;
    };
    const groupTotals = new Map();
    for (const job of orderedJobs) {
      if (hiddenByFilter(job)) continue;
      const key = classifyState(job.State).section + ':' + categoryForState(job.State);
      groupTotals.set(key, (groupTotals.get(key) || 0) + 1);
    }
    updateFilterCounts(jobs);
    const lastCategory = {active: null, history: null};
    for (const job of orderedJobs) {
      let row = rows.get(job.Id);
      if (!row) {
        const element = document.createElement('article');
        element.className = 'job-card';
        const head = document.createElement('div');
        head.className = 'job-card-head';
        const link = document.createElement('a');
        link.textContent = job.VideoId;
        link.href = 'https://www.youtube.com/watch?v=' + encodeURIComponent(job.VideoId);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const state = document.createElement('span');
        state.className = 'badge';
        head.append(link, state);
        const meta = document.createElement('div');
        meta.className = 'job-card-meta';
        const level = document.createElement('span');
        level.className = 'job-level';
        const timestamps = document.createElement('span');
        timestamps.className = 'job-times';
        const day = document.createElement('span');
        day.className = 'job-day';
        const title = document.createElement('span');
        title.className = 'job-title';
        const duration = document.createElement('span');
        duration.className = 'job-duration';
        const durationBadge = document.createElement('span');
        durationBadge.className = 'duration-badge';
        durationBadge.hidden = true;
        const parts = document.createElement('span');
        parts.className = 'job-parts job-parts-emphasis';
        const transcriptSaved = document.createElement('span');
        transcriptSaved.className = 'transcript-saved-badge';
        transcriptSaved.hidden = true;
        meta.append(level, timestamps, day, title, duration, durationBadge, parts, transcriptSaved);
        const message = document.createElement('p');
        message.className = 'job-card-message';
        const actions = document.createElement('div');
        actions.className = 'job-card-actions';
        const result = document.createElement('a');
        result.textContent = 'Open final summary';
        result.target = '_blank';
        result.rel = 'noopener noreferrer';
        result.hidden = true;
        const openAllParts = document.createElement('button');
        openAllParts.hidden = true;
        // A JS window.open() loop only ever opens the first popup: Chrome (and every other
        // modern browser) allows exactly one new window per user gesture and silently blocks
        // the rest, which is exactly why this used to "open just the summary". A revealed list
        // of real <a target="_blank"> links has no such limit, because each one is its own
        // ordinary link click/gesture, the same reason "Open final summary" always worked.
        const partsList = document.createElement('div');
        partsList.className = 'parts-list';
        partsList.hidden = true;
        openAllParts.addEventListener('click', () => {
          partsList.hidden = !partsList.hidden;
        });
        const localResult = document.createElement('button');
        localResult.textContent = 'Open full transcript';
        localResult.hidden = true;
        localResult.addEventListener('click', async () => {
          localResult.disabled = true;
          try {
            await openLocalResult(job.Id);
          } catch (error) {
            byId('action-message').textContent = 'Unable to open the full transcript: ' + error.message;
          } finally {
            localResult.disabled = false;
          }
        });
        const retry = document.createElement('button');
        retry.textContent = 'Retry from checkpoint';
        retry.addEventListener('click', async () => {
          retry.disabled = true;
          try {
            await request('/api/retry', 'POST', {jobId: job.Id});
          } catch (error) {
            byId('action-message').textContent = 'Unable to retry: ' + error.message;
            retry.disabled = false;
          }
        });
        const clear = document.createElement('button');
        clear.textContent = 'Clear local progress';
        clear.addEventListener('click', async () => {
          if (!confirm(`Clear saved transcript and notes for ${job.VideoId}?`)) return;
          clear.disabled = true;
          try { await request('/api/clear', 'POST', {jobId: job.Id}); }
          catch (error) { byId('action-message').textContent = 'Unable to clear progress: ' + error.message; clear.disabled = false; }
        });
        const attach = document.createElement('button');
        attach.textContent = 'Attach final summary link';
        attach.hidden = true;
        attach.addEventListener('click', async () => {
          const entered = prompt(`Paste the final summary conversation link you can see for ${job.VideoId}.`, '');
          if (entered === null) {
            byId('action-message').textContent = 'No link attached; this video was left unchanged.';
            return;
          }
          const resultUrl = entered.trim();
          if (!validResultUrl(resultUrl)) {
            byId('action-message').textContent =
              'That is not a supported ChatGPT, Gemini or Claude conversation link. This video was left unchanged.';
            return;
          }
          attach.disabled = true;
          try {
            await request('/api/attach-result', 'POST', {jobId: job.Id, resultUrl});
            byId('action-message').textContent = 'Final summary link attached; this video is marked completed.';
          } catch (error) {
            byId('action-message').textContent = 'Unable to attach that link: ' + error.message;
          } finally {
            attach.disabled = !controllerOnline || stopped;
          }
        });
        const stop = document.createElement('button');
        stop.textContent = 'Stop this video';
        stop.addEventListener('click', async () => {
          if (!confirm(`Stop ${job.VideoId}? Other queued and active videos keep going.`)) return;
          stop.disabled = true;
          try { await request('/api/stop-job', 'POST', {jobId: job.Id}); }
          catch (error) { byId('action-message').textContent = 'Unable to stop this video: ' + error.message; stop.disabled = false; }
        });
        const pause = document.createElement('button');
        pause.textContent = 'Pause';
        pause.addEventListener('click', async () => {
          if (!confirm(`Pause ${job.VideoId}? It stops where it is; resume anytime from its saved checkpoint. Other queued and active videos keep going.`)) return;
          pause.disabled = true;
          try { await request('/api/pause-job', 'POST', {jobId: job.Id}); }
          catch (error) { byId('action-message').textContent = 'Unable to pause this video: ' + error.message; pause.disabled = false; }
        });
        const watchLater = document.createElement('button');
        watchLater.addEventListener('click', async () => {
          const next = !row.watchLaterValue;
          if (next && !confirm(`Set ${job.VideoId} aside for watch later? ` +
              (row.watchLaterActiveWhenClicked
                ? 'Its current work will be stopped now; other queued and active videos keep going. '
                : '') +
              'It will be skipped by automatic processing until you remove it from Watch later.')) return;
          if (!next && !confirm(`Remove ${job.VideoId} from Watch later? It becomes eligible for normal automatic processing again.`)) return;
          watchLater.disabled = true;
          try {
            await request('/api/watch-later', 'POST', {jobId: job.Id, watchLater: next});
          } catch (error) {
            byId('action-message').textContent = 'Unable to update Watch later for this video: ' + error.message;
          } finally {
            watchLater.disabled = !controllerOnline || stopped;
          }
        });
        const levelSelect = document.createElement('select');
        levelSelect.className = 'job-level-select';
        levelSelect.title = `Summary level for ${job.VideoId}`;
        for (const key of Object.keys(levels)) {
          const option = document.createElement('option');
          option.value = key;
          option.textContent = levels[key].label;
          levelSelect.append(option);
        }
        levelSelect.addEventListener('change', async () => {
          const requested = levelSelect.value;
          const previous = row.levelSelectValue;
          if (row.section === 'history' &&
              !confirm(`Change ${job.VideoId} to ${levels[requested].label}? Its old checkpoint/result will be cleared, but it will stay stopped until you click Retry from checkpoint.`)) {
            levelSelect.value = previous;
            return;
          }
          levelSelect.disabled = true;
          try {
            await request('/api/set-job-level', 'POST', {jobId: job.Id, summaryLevel: requested});
            row.levelSelectValue = requested;
          } catch (error) {
            byId('action-message').textContent = `Unable to change the summary level for ${job.VideoId}: ` + error.message;
            levelSelect.value = previous;
          } finally {
            levelSelect.disabled = !controllerOnline || stopped;
          }
        });
        const removeJob = document.createElement('button');
        removeJob.textContent = 'Remove from list';
        removeJob.addEventListener('click', async () => {
          const label = job.Title ? `${job.VideoId} (${job.Title})` : job.VideoId;
          if (!confirm(`Permanently remove ${label} from the video jobs list? This only deletes the local job record; it does not touch ChatGPT, Gemini, Claude, or your browser history.`)) return;
          removeJob.disabled = true;
          try { await request('/api/delete-job', 'POST', {jobId: job.Id}); }
          catch (error) {
            // A queued video can be picked up by a worker between the moment this card was
            // rendered and this click, so the removal is legitimately refused. A quiet line of
            // text is easy to miss and leaves the user believing it was removed, so say it
            // plainly and re-sync this card to its real current state.
            const reason = `Unable to remove ${job.VideoId}: ` + error.message;
            byId('action-message').textContent = reason;
            alert(reason);
            removeJob.disabled = !controllerOnline || stopped;
            await poll();
          }
        });
        // Every hold that can keep a video out of TakeJob is user-visible on the tile except the
        // restart hold, which lives on the scheduler and is invisible here. "Start now" is the one
        // control that clears all of them at once, so a queued video can never look stuck with no
        // way to run it.
        const startNow = document.createElement('button');
        startNow.textContent = 'Start now';
        startNow.addEventListener('click', async () => {
          startNow.disabled = true;
          try {
            await request('/api/start-job', 'POST', {jobId: job.Id});
            byId('action-message').textContent =
              `${job.VideoId} will start as soon as a provider slot is free.`;
            await poll();
          } catch (error) {
            byId('action-message').textContent = 'Unable to start this video: ' + error.message;
            startNow.disabled = false;
          }
        });
        actions.append(result, openAllParts, localResult, retry, attach, clear, stop, pause, watchLater, levelSelect, removeJob, startNow, partsList);
        element.append(head, meta, message, actions);
        row = {element, state, level, timestamps, day, title, duration, durationBadge, parts, transcriptSaved, message, result, openAllParts, partsList, localResult, retry, attach, clear, stop, pause, watchLater, levelSelect, removeJob, startNow, levelSelectValue: null, watchLaterValue: false, watchLaterActiveWhenClicked: false, partResultUrls: [], section: null};
        rows.set(job.Id, row);
      }
      const meta = classifyState(job.State);
      const hasTranscript = !!(job.TranscriptSaved || job.FinalResult === 'local');
      row.transcriptSaved.hidden = !hasTranscript;
      if (hasTranscript) {
        row.transcriptSaved.textContent = '💾 Transcript saved to disk';
        row.transcriptSaved.title = 'Full transcript is saved locally on disk and will not be re-fetched on retry.';
      }
      row.state.textContent = job.State + (job.WatchLater ? ' · Watch later' : '');
      row.state.className = 'badge ' + meta.badge + (meta.pulse ? ' pulse' : '');
      row.level.textContent = validLevel(job.SummaryLevel) ? levels[job.SummaryLevel].label :
        (!job.SummaryLevel || job.SummaryLevel === 'legacy' ? 'Earlier default' : 'Unknown level');
      row.timestamps.textContent = formatJobTimes(job);
      const day = jobDayPresentation(job.CreatedAt);
      row.day.textContent = day.label;
      row.dayPresentation = day;
      row.title.textContent = job.Title
        ? `Title: ${job.Title}`
        : `Title: YouTube video ${job.VideoId} · looking up title…`;
      row.duration.textContent = `Length: ${formatDuration(job.DurationSeconds)}`;
      const bucket = durationBucket(job.DurationSeconds);
      row.durationBadge.hidden = !bucket;
      if (bucket) {
        row.durationBadge.textContent = bucket.label;
        row.durationBadge.className = 'duration-badge ' + bucket.className;
      }
      row.parts.textContent = job.ChunkCount > 1 && job.SuccessfulParts > 0
        ? `Parts: ${job.SuccessfulParts}/${job.ChunkCount}`
        : job.ChunkCount > 0 ? `Parts: ${job.ChunkCount}` : 'Parts: pending';
      row.message.textContent = job.Message;
      if (autoReconcilePending(job)) {
        row.message.textContent = `${job.Message} Checking the browser for a completed summary…`;
      } else if (ambiguousSendRecoverable(job)) {
        row.message.textContent = `${job.Message} Automatic check could not safely find the completed ` +
          'summary tab. If you can see it in the provider, use Attach final summary link; otherwise retry from checkpoint.';
      }
      const attempts = Number(job.AutoRetryAttempts) || 0;
      // Only a real persisted deadline means the server actually scheduled a repair, so a
      // failure restored without one is never promised a retry it will not get.
      const scheduled = parseJobDate(job.AutoRetryAfterUtc) !== null;
      if (job.State === 'error' && !job.PausedByUser && !job.WatchLater) {
        if (attempts >= autoRetryLimit) {
          row.message.textContent += ` Automatic retries are used up (${attempts}/${autoRetryLimit}); ` +
            'the failure was recorded for investigation.';
        } else if (!scheduled) {
          row.message.textContent += ' No automatic retry is scheduled; use Retry from checkpoint.';
        } else if (dispatchPaused || !browserReady) {
          row.message.textContent += ` Queued for an automatic retry (${attempts}/${autoRetryLimit} used) once dispatch resumes.`;
        } else {
          row.message.textContent += ` Retrying automatically shortly (${attempts}/${autoRetryLimit} automatic attempts used).`;
        }
      } else if (attempts > 0 && !['completed', 'submitted'].includes(job.State)) {
        row.message.textContent += ` Automatic attempt ${attempts} of ${autoRetryLimit}.`;
      }
      // Every reason a video can sit in "queued" without running is named here, because the tile
      // is where the user is looking. The restart hold in particular is invisible on the card and
      // is not cleared by removing Watch later, which is what made these videos look frozen.
      if (!['completed', 'submitted'].includes(job.State)) {
        if (job.WatchLater) {
          row.message.textContent += ' It is set aside for Watch later, so automatic dispatch skips it. ' +
            'Use Start now to run it.';
        } else if (job.State === 'queued' && dispatchPaused) {
          row.message.textContent += ' Dispatch is paused, so nothing starts on its own. Use Start now to run this video.';
        } else if (job.State === 'queued' && !browserReady) {
          row.message.textContent += ' It starts once the dedicated browser is available again.';
        }
      }
      row.message.classList.toggle('error', ['error', 'needs-review', 'cancelled'].includes(job.State));
      // Anything not finished and not already being worked on can be forced to run now.
      // "queued" is rendered in the active section but nothing is working on it yet, so section
      // alone cannot decide this. Only a video that is genuinely mid-flight has nothing to start.
      row.startNow.hidden = !['queued', 'paused', 'error', 'cancelled', 'needs-review', 'reviewed'].includes(job.State);
      row.startNow.disabled = !controllerOnline || stopped;
      row.retry.hidden = !['error', 'cancelled', 'needs-review'].includes(job.State);
      row.attach.hidden = !ambiguousSendRecoverable(job) || autoReconcilePending(job);
      row.attach.disabled = !controllerOnline || stopped;
      row.clear.hidden = ['completed', 'submitted'].includes(job.State) && job.FinalResult !== 'local';
      row.retry.disabled = !controllerOnline || stopped;
      row.clear.disabled = !controllerOnline || stopped;
      row.stop.hidden = meta.section !== 'active';
      row.stop.disabled = !controllerOnline || stopped;
      row.pause.hidden = meta.section !== 'active';
      row.pause.disabled = !controllerOnline || stopped;
      row.watchLaterValue = !!job.WatchLater;
      row.watchLaterActiveWhenClicked = !jobDeletable(job);
      row.watchLater.textContent = job.WatchLater ? 'Remove from Watch later' : 'Watch later';
      row.watchLater.disabled = !controllerOnline || stopped;
      row.removeJob.hidden = !jobDeletable(job);
      row.removeJob.disabled = !controllerOnline || stopped;
      // Active checkpoints remain locked. Historical changes clear the old checkpoint on the
      // server and remain stopped until the user explicitly retries.
      row.levelSelect.hidden = job.State !== 'queued' && meta.section !== 'history';
      row.levelSelect.disabled = !controllerOnline || stopped;
      if (row.levelSelectValue !== job.SummaryLevel && document.activeElement !== row.levelSelect) {
        row.levelSelect.value = validLevel(job.SummaryLevel) ? job.SummaryLevel : 'ultra';
        row.levelSelectValue = job.SummaryLevel;
      }
      row.result.hidden = !['completed', 'submitted'].includes(job.State) || !validResultUrl(job.ResultUrl);
      row.localResult.hidden = job.FinalResult !== 'local';
      row.localResult.disabled = !controllerOnline || stopped;
      if (row.result.hidden) row.result.removeAttribute('href');
      else row.result.href = job.ResultUrl;
      const partResultUrls = Array.isArray(job.PartResultUrls) ? job.PartResultUrls.filter(validResultUrl) : [];
      row.openAllParts.hidden = partResultUrls.length === 0;
      row.openAllParts.textContent = `Open all parts (${partResultUrls.length})`;
      // Rebuild the revealed list only when the actual URLs changed, so an in-progress video
      // that just gained a new part does not lose the user's expand/collapse choice or steal
      // keyboard focus every poll.
      if (JSON.stringify(row.partResultUrls) !== JSON.stringify(partResultUrls)) {
        row.partResultUrls = partResultUrls;
        while (row.partsList.children.length) row.partsList.children[0].remove();
        partResultUrls.forEach((url, index) => {
          const link = document.createElement('a');
          link.textContent = `Part ${index + 1}`;
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          row.partsList.append(link);
        });
      }
      if (partResultUrls.length === 0) row.partsList.hidden = true;
      if (meta.section === 'active') rawActiveCount++; else rawHistoryCount++;
      const filteredOut = hiddenByFilter(job);
      if (filteredOut) {
        if (row.element.parentNode) row.element.remove();
        row.section = null;
        row.element.className = `job-card day-color-${row.dayPresentation.color}` +
          (hasTranscript ? ' has-saved-transcript' : '');
        delete row.element.dataset.dayLabel;
        delete row.element.dataset.groupLabel;
      } else {
        if (meta.section === 'active') activeCount++; else historyCount++;
        const category = categoryForState(job.State);
        // Status grouping (restarting day labels per group, showing a group heading) only
        // makes sense when the section is actually sorted by status; the other sort modes
        // keep the same status-tint background color but sort/label purely by day instead.
        const groupingByStatus = sortPreference[meta.section] === 'status';
        const isGroupStart = groupingByStatus && lastCategory[meta.section] !== category;
        lastCategory[meta.section] = category;
        // A new status group restarts day labelling so the first card of every group carries
        // its own date heading instead of inheriting the previous group's last day.
        if (isGroupStart) lastDayKey[meta.section] = null;
        const day = row.dayPresentation;
        const isDayStart = lastDayKey[meta.section] !== day.key;
        lastDayKey[meta.section] = day.key;
        row.element.className = `job-card day-color-${day.color} group-${category}` +
          (isDayStart ? ' day-start' : '') + (isGroupStart ? ' group-start' : '') +
          (hasTranscript ? ' has-saved-transcript' : '');
        if (isDayStart) row.element.dataset.dayLabel = day.label;
        else delete row.element.dataset.dayLabel;
        if (isGroupStart) {
          const total = groupTotals.get(meta.section + ':' + category) || 0;
          row.element.dataset.groupLabel = `${CATEGORY_LABEL.get(category) || category} · ${total}`;
        } else delete row.element.dataset.groupLabel;
        // Always re-append (moving the node to the end if it is already the container's
        // child), not just when the section changes: with independent per-section sort
        // modes, two jobs can swap places within the same section between renders, and a
        // real appendChild()/this fixture's append() must reflect that new order every time.
        const container = byId(meta.section === 'active' ? 'jobs-active' : 'jobs-history');
        if (row.element.parentNode) row.element.remove();
        container.append(row.element);
        row.section = meta.section;
      }

    }
    byId('jobs-active-block').hidden = activeCount === 0;
    byId('active-count').textContent = String(activeCount);
    byId('active-filtered-empty').hidden = !(rawActiveCount > 0 && activeCount === 0);
    byId('jobs-history-block').hidden = historyCount === 0;
    byId('history-count').textContent = String(historyCount);
    byId('history-filtered-empty').hidden = !(rawHistoryCount > 0 && historyCount === 0);
    byId('active-filtered-empty').textContent = searchTokens.length
      ? 'No active jobs match this search.' : 'No active jobs match the filters.';
    byId('history-filtered-empty').textContent = searchTokens.length
      ? 'No history jobs match this search.' : 'No history jobs match the filters.';
    byId('clear-errors').hidden = !jobs.some(job => job.State === 'error');
    byId('clear-errors').disabled = !controllerOnline || stopped || clearErrorsPending;
    const terminal = new Set(['submitted', 'completed', 'error', 'needs-review', 'reviewed', 'cancelled']);
    const identities = new Set();
    let hasDuplicates = false;
    for (const job of jobs) {
      if (!terminal.has(job.State)) continue;
      const identity = `${job.VideoId}\n${job.SummaryLevel || 'legacy'}\n${job.SummaryLanguage || 'hebrew'}`;
      if (identities.has(identity)) hasDuplicates = true;
      identities.add(identity);
    }
    byId('clear-duplicates').hidden = !hasDuplicates;
    byId('clear-duplicates').disabled = !controllerOnline || stopped || clearDuplicatesPending;
    cancelledJobCount = jobs.filter(job => job.State === 'cancelled' || job.State === 'reviewed').length;
    byId('clear-cancelled').hidden = cancelledJobCount === 0;
    byId('clear-cancelled').disabled = !controllerOnline || stopped || clearCancelledPending;
    retryTodayJobs = jobs.filter(job =>
      ['error', 'cancelled', 'needs-review'].includes(job.State) && isCreatedToday(job.CreatedAt) && !job.WatchLater);
    byId('retry-today').hidden = retryTodayJobs.length === 0;
    byId('retry-today').textContent =
      `Retry all today's jobs (${retryTodayJobs.length})`;
    byId('retry-today').disabled = !controllerOnline || stopped || retryTodayPending;
  }

  byId('clear-errors').addEventListener('click', async () => {
    if (clearErrorsPending || stopped || !controllerOnline) return;
    if (!confirm('Permanently remove all failed/error jobs and their saved local progress? Completed and other jobs are kept.')) return;
    clearErrorsPending = true;
    byId('clear-errors').disabled = true;
    try {
      const result = await request('/api/clear-errors', 'POST', {});
      byId('action-message').textContent =
        `${result.cleared || 0} failed/error job${result.cleared === 1 ? '' : 's'} cleared.`;
    } catch (error) {
      byId('action-message').textContent = 'Unable to clear failed/error jobs: ' + error.message;
    } finally {
      clearErrorsPending = false;
      byId('clear-errors').disabled = !controllerOnline || stopped;
    }
  });

  byId('clear-duplicates').addEventListener('click', async () => {
    if (clearDuplicatesPending || stopped || !controllerOnline) return;
    if (!confirm('Permanently remove duplicate terminal jobs? The best/newest result for each video, level, and language is kept. Active work is never removed.')) return;
    clearDuplicatesPending = true;
    byId('clear-duplicates').disabled = true;
    try {
      const result = await request('/api/clear-duplicates', 'POST', {});
      byId('action-message').textContent =
        `${result.cleared || 0} duplicate job${result.cleared === 1 ? '' : 's'} cleared.`;
    } catch (error) {
      byId('action-message').textContent = 'Unable to clear duplicate jobs: ' + error.message;
    } finally {
      clearDuplicatesPending = false;
      byId('clear-duplicates').disabled = !controllerOnline || stopped;
    }
  });

  byId('clear-cancelled').addEventListener('click', async () => {
    if (clearCancelledPending || stopped || !controllerOnline) return;
    const count = cancelledJobCount;
    if (!confirm(`Permanently remove ${count} cancelled/reviewed job${count === 1 ? '' : 's'} and their saved local progress? Only local job records are deleted; ChatGPT, Gemini and Claude conversations are untouched.`)) return;
    clearCancelledPending = true;
    byId('clear-cancelled').disabled = true;
    try {
      const result = await request('/api/clear-cancelled', 'POST', {});
      byId('action-message').textContent =
        `${result.cleared || 0} cancelled/reviewed job${result.cleared === 1 ? '' : 's'} cleared.`;
    } catch (error) {
      byId('action-message').textContent = 'Unable to clear cancelled/reviewed jobs: ' + error.message;
    } finally {
      clearCancelledPending = false;
      byId('clear-cancelled').disabled = !controllerOnline || stopped;
    }
  });

  byId('retry-today').addEventListener('click', async () => {
    if (retryTodayPending || stopped || !controllerOnline) return;
    const jobs = retryTodayJobs.slice();
    if (jobs.length === 0) return;
    if (!confirm(`Retry ${jobs.length} eligible job${jobs.length === 1 ? '' : 's'} created today from their saved checkpoints?`)) return;
    retryTodayPending = true;
    byId('retry-today').disabled = true;
    let retried = 0;
    let failed = 0;
    try {
      for (const job of jobs) {
        try {
          await request('/api/retry', 'POST', {jobId: job.Id});
          retried++;
        } catch {
          failed++;
        }
      }
      byId('action-message').textContent = failed === 0
        ? `${retried} job${retried === 1 ? '' : 's'} retried.`
        : `${retried} job${retried === 1 ? '' : 's'} retried; ${failed} failed because their state changed or the controller rejected the request.`;
    } finally {
      retryTodayPending = false;
      byId('retry-today').disabled = !controllerOnline || stopped;
    }
  });

  function parseVideo(value) {
    const text = value.trim();
    if (/^[A-Za-z0-9_-]{11}$/.test(text)) return text;
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol) ||
        (!/(^|\.)youtube\.com$/.test(url.hostname) && url.hostname !== 'youtu.be')) {
      throw new Error('Not a YouTube link: ' + text);
    }
    const id = url.searchParams.get('v') ||
      (url.hostname === 'youtu.be' ? url.pathname.split('/')[1] : url.pathname.match(/^\/(?:shorts|live|embed)\/([^/]+)/)?.[1]);
    if (!/^[A-Za-z0-9_-]{11}$/.test(id || '')) throw new Error('Video ID not found: ' + text);
    return id;
  }

  const savedBatch = sessionStorage.getItem('yt-summary-batch');
  if (savedBatch) {
    try {
      pendingBatch = JSON.parse(savedBatch);
      if (!Array.isArray(pendingBatch) || pendingBatch.some(item =>
        !/^[A-Za-z0-9_-]{11}$/.test(item.videoId) || !/^[a-f0-9-]{36}$/i.test(item.requestId) ||
        (item.summaryLevel !== undefined && !validLevel(item.summaryLevel)) ||
        (item.title !== undefined && normalizeVideoTitle(item.title) !== item.title))) throw new Error('Invalid saved batch.');
      pendingBatch.forEach(item => { if (item.title) pendingTitles.set(item.videoId, item.title); });
      byId('batch').value = pendingBatch.map(item => item.videoId).join('\n');
    } catch (error) {
      pendingBatch = [];
      sessionStorage.removeItem('yt-summary-batch');
      byId('batch-result').textContent = error.message;
    }
  }
  if (importedVideoIds.length) {
    const existingLines = byId('batch').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    byId('batch').value = [...new Set([...existingLines, ...importedVideoIds])].join('\n');
    byId('batch-result').textContent = `${importedVideoIds.length} video link(s) found on that YouTube page. Review the list below, then click Add videos.`;
    byId('batch').scrollIntoView?.({behavior: 'smooth', block: 'center'});
  } else if (!videoId && videosParam) {
    byId('batch-result').textContent = 'That page did not contain any recognizable YouTube video links.';
  }

  async function submitBatch() {
    if (settingsPending || batchPending || stopped || !summaryLevel) {
      byId('batch-result').textContent = 'Wait until the saved summary level is available before adding videos.';
      return;
    }
    let ids;
    try {
      ids = [...new Set(byId('batch').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(parseVideo))];
      if (!ids.length) throw new Error('Paste at least one YouTube link.');
      if (ids.length > 200) throw new Error('Use at most 200 videos in one batch.');
    } catch (error) {
      byId('batch-result').textContent = error.message;
      return;
    }
    if (ids.join('\n') !== pendingBatch.map(item => item.videoId).join('\n')) {
      pendingBatch = ids.map(id => {
        const item = {videoId: id, requestId: crypto.randomUUID(), summaryLevel};
        const title = pendingTitles.get(id);
        if (title) item.title = title;
        return item;
      });
    }
    sessionStorage.setItem('yt-summary-batch', JSON.stringify(pendingBatch));
    batchPending = true;
    updateSummaryControls();
    byId('batch').disabled = true;
    let accepted = 0;
    const failures = [];
    try {
      for (const item of [...pendingBatch]) {
        try {
          const job = await request('/api/jobs', 'POST', item);
          await openPreviouslyCompleted(job);
          accepted++;
          pendingBatch = pendingBatch.filter(pending => pending.requestId !== item.requestId);
          sessionStorage.setItem('yt-summary-batch', JSON.stringify(pendingBatch));
        } catch (error) {
          failures.push(item.videoId + ': ' + error.message);
        }
      }
      byId('batch').value = pendingBatch.map(item => item.videoId).join('\n');
      byId('batch-result').textContent = `${accepted} request(s) accepted.\n` +
        (failures.length ? failures.join('\n') + '\nClick Add videos to retry the remaining requests with the same IDs and original levels.' : 'Follow each video below.');
    } finally {
      batchPending = false;
      updateSummaryControls();
      byId('batch').disabled = false;
    }
  }
  byId('add-batch').addEventListener('click', submitBatch);

  function extractLinksFromDrop(dataTransfer) {
    const raw = dataTransfer.getData('text/uri-list') || dataTransfer.getData('text/plain') ||
      dataTransfer.getData('text/html') || '';
    return raw.split(/\r?\n/).map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const match = /href="([^"]+)"/.exec(line);
        return match ? match[1] : line;
      });
  }
  function extractTitleFromDrop(dataTransfer) {
    const html = dataTransfer.getData('text/html') || '';
    const attribute = /(?:title|aria-label|alt)="([^"]+)"/i.exec(html);
    if (attribute) return normalizeVideoTitle(attribute[1]);
    return normalizeVideoTitle(html.replace(/<[^>]+>/g, ' '));
  }
  const dropZone = byId('batch-dropzone');
  if (dropZone) {
    dropZone.addEventListener('dragover', event => {
      event.preventDefault();
      dropZone.classList.toggle('drag-over', true);
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.toggle('drag-over', false));
    dropZone.addEventListener('drop', async event => {
      event.preventDefault();
      dropZone.classList.toggle('drag-over', false);
      if (settingsPending || batchPending || stopped || !summaryLevel) {
        byId('batch-result').textContent = 'Wait until the saved summary level is available before adding videos.';
        return;
      }
      const ids = [];
      for (const candidate of extractLinksFromDrop(event.dataTransfer)) {
        try { ids.push(parseVideo(candidate)); } catch { /* not a recognizable YouTube link; skip it */ }
      }
      if (!ids.length) {
        byId('batch-result').textContent = 'That drop did not contain a recognizable YouTube link.';
        return;
      }
      const droppedTitle = ids.length === 1 ? extractTitleFromDrop(event.dataTransfer) : '';
      if (droppedTitle) pendingTitles.set(ids[0], droppedTitle);
      const existingLines = byId('batch').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      byId('batch').value = [...new Set([...existingLines, ...ids])].join('\n');
      await submitBatch();
    });
  }

  for (const lvl of Object.keys(levels)) {
    const zone = byId('level-dropzone-' + lvl);
    if (!zone) continue;
    zone.addEventListener('dragover', event => {
      event.preventDefault();
      zone.classList.toggle('drag-over', true);
    });
    zone.addEventListener('dragleave', () => zone.classList.toggle('drag-over', false));
    zone.addEventListener('drop', async event => {
      event.preventDefault();
      zone.classList.toggle('drag-over', false);
      if (stopped) {
        byId('batch-result').textContent = 'The helper is stopped; start it before adding videos.';
        return;
      }
      const ids = [];
      for (const candidate of extractLinksFromDrop(event.dataTransfer)) {
        try { ids.push(parseVideo(candidate)); } catch { /* not a recognizable YouTube link; skip it */ }
      }
      const uniqueIds = [...new Set(ids)];
      if (!uniqueIds.length) {
        byId('batch-result').textContent = 'That drop did not contain a recognizable YouTube link.';
        return;
      }
      const droppedTitle = uniqueIds.length === 1 ? extractTitleFromDrop(event.dataTransfer) : '';
      let accepted = 0;
      const failures = [];
      for (const id of uniqueIds) {
        try {
          const item = {videoId: id, requestId: crypto.randomUUID(), summaryLevel: lvl};
          if (droppedTitle) item.title = droppedTitle;
          const job = await request('/api/jobs', 'POST', item);
          await openPreviouslyCompleted(job);
          accepted++;
        } catch (error) {
          failures.push(id + ': ' + error.message);
        }
      }
      byId('batch-result').textContent = `${accepted} request(s) accepted at ${levels[lvl].label} level.` +
        (failures.length ? '\n' + failures.join('\n') : '');
    });
  }

  const laterZone = byId('level-dropzone-later');
  if (laterZone) {
    laterZone.addEventListener('dragover', event => {
      event.preventDefault();
      laterZone.classList.toggle('drag-over', true);
    });
    laterZone.addEventListener('dragleave', () => laterZone.classList.toggle('drag-over', false));
    laterZone.addEventListener('drop', async event => {
      event.preventDefault();
      laterZone.classList.toggle('drag-over', false);
      if (stopped) {
        byId('batch-result').textContent = 'The helper is stopped; start it before adding videos.';
        return;
      }
      const ids = [];
      for (const candidate of extractLinksFromDrop(event.dataTransfer)) {
        try { ids.push(parseVideo(candidate)); } catch { /* not a recognizable YouTube link; skip it */ }
      }
      const uniqueIds = [...new Set(ids)];
      if (!uniqueIds.length) {
        byId('batch-result').textContent = 'That drop did not contain a recognizable YouTube link.';
        return;
      }
      const droppedTitle = uniqueIds.length === 1 ? extractTitleFromDrop(event.dataTransfer) : '';
      let accepted = 0;
      const failures = [];
      for (const id of uniqueIds) {
        try {
          const item = {videoId: id, requestId: crypto.randomUUID(), summaryLevel: 'reg', watchLater: true};
          if (droppedTitle) item.title = droppedTitle;
          await request('/api/jobs', 'POST', item);
          accepted++;
        } catch (error) {
          failures.push(id + ': ' + error.message);
        }
      }
      byId('batch-result').textContent =
        `${accepted} request(s) accepted at Reg level and marked Watch later.` +
        (failures.length ? '\n' + failures.join('\n') : '');
    });
  }

  function renderStatusData(data, updateSettings = true) {
    if (updateSettings) {
      displaySummaryLevel(data.summaryLevel);
      displaySummaryLanguage(data.summaryLanguage);
      displayEnabledProviders(data.enabledProviders);
      displayKeepIntermediateTabs(data.keepIntermediateTabs);
      if (!settingsError) byId('summary-level-status').textContent = `${levels[summaryLevel].label} / ${languages[summaryLanguage].label} saved for new videos.`;
      if (!settingsError) byId('provider-settings-status').textContent = `Enabled providers: ${enabledProviders.join(', ')}.`;
      if (!settingsError) byId('keep-intermediate-tabs-status').textContent = keepIntermediateTabs
        ? 'Every part and merge-stage tab stays open for review.'
        : 'Intermediate part/merge tabs close automatically; only the final summary tab stays open.';
    }
    renderAvailability(data);
    renderJobs(data.jobs || []);
    const mobileOrigin = typeof data.mobileOrigin === 'string' &&
      /^http:\/\/(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}):\d+$/.test(data.mobileOrigin)
      ? data.mobileOrigin : '';
    byId('kiwi-setup').hidden = !mobileOrigin;
    byId('kiwi-pairing-url').value = mobileOrigin ? `${mobileOrigin}/#token=${token}` : '';
    byId('capacity').textContent = `${data.active} active / ${data.maxConcurrent} slots - ${data.queued} queued - ` +
      `${data.startIntervalMilliseconds / 1000}s between starts`;
    if (Array.isArray(data.providerOrder) && validProviders(data.enabledProviders)) {
      byId('provider-order').textContent = `Rotation order: ${data.providerOrder.filter(provider => data.enabledProviders.includes(provider)).join(' → ')}. Each completed stage advances the saved cursor.`;
    }
    if (!launchFailed && !launch) {
      const focused = (data.jobs || []).find(job => job.Id === selectedJob);
      byId('video').textContent = focused ? 'Video: ' + focused.VideoId : '';
      if (data.paused) {
        if (data.pauseKind === 'restart') {
          status('Waiting for you to start', data.pauseReason ||
            'The helper restarted with already-queued videos. Choose Resume, or add a video, to start them.', true);
        } else {
          status('Paused for usage limit', 'Wait until your provider quota resets, then choose Resume. Queued videos are retained; no timed retries run.', true);
        }
      } else if (!data.ready) {
        status('Waiting for browser', data.browserMessage || 'The dedicated browser will reopen automatically for queued videos. Existing requests are retained.', true);
      } else if (focused) {
        status(focused.State, focused.Message, ['error', 'needs-review', 'cancelled'].includes(focused.State));
      } else {
        status('Ready', 'Use your bookmark on several videos or add a batch below. Each video has its own job.');
      }
    }
    updateSummaryControls();
    updateJobActionAvailability();
  }

  async function poll() {
    if (stopped || pollInFlight) return;
    pollInFlight = true;
    const epoch = settingsEpoch;
    try {
      const data = await request('/api/status');
      setControllerAvailability(true);
      saveStatusSnapshot(data);
      renderStatusData(data, !settingsPending && epoch === settingsEpoch);
    } catch (error) {
      setControllerAvailability(false,
        'Showing the last known jobs and history. The helper is not running, so active work is no longer progressing and actions are disabled until restart.');
      byId('resume').disabled = true;
      status('Helper offline', 'Open Start YT Summary.cmd to resume the controller. ' + error.message, true);
    } finally {
      pollInFlight = false;
      if (!stopped) pollTimer = setTimeout(poll, 1500);
    }
  }
  byId('stop').addEventListener('click', async () => {
    if (!confirm('Stop active workers and close the dedicated browser? Unstarted jobs stay queued for the next launch. Your regular browser stays open.')) return;
    byId('stop').disabled = true;
    try {
      await request('/api/stop', 'POST', {});
      stopped = true;
      setControllerAvailability(false, 'The helper was stopped from this dashboard. The last known jobs and history remain visible.');
      byId('resume').hidden = true;
      clearTimeout(pollTimer);
      status('Stopped', 'Start the launcher again when you need the bookmark.');
    } catch (error) {
      byId('stop').disabled = false;
      byId('action-message').textContent = 'Unable to stop the helper: ' + error.message;
    }
  });
  updateSummaryControls();
  const savedStatus = loadStatusSnapshot();
  if (savedStatus) {
    renderStatusData(savedStatus);
    setControllerAvailability(false, 'Showing the saved status snapshot while reconnecting to the local helper.');
  }
  window.addEventListener('focus', () => { if (!stopped) poll(); });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && !stopped) poll();
  });
  if (launch) {
    submitLaunch().then(poll);
  } else {
    const saved = sessionStorage.getItem('yt-summary-launch');
    if (saved) {
      try {
        launch = JSON.parse(saved);
        launchFailed = true;
        byId('retry').hidden = false;
        status('Interrupted launch', 'Use Retry to check the same request without creating a duplicate.');
      } catch {
        sessionStorage.removeItem('yt-summary-launch');
        status('Invalid saved launch', 'The saved launch request is invalid. Start again from your YouTube bookmark.', true);
        launchFailed = true;
      }
    }
    poll();
  }
})();
